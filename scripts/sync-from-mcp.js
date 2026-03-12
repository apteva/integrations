#!/usr/bin/env node
/**
 * sync-from-mcp.js
 *
 * Syncs MCP server + provider definitions from /root/code/mcp/ into
 * the @apteva/integrations app template format (src/apps/*.json).
 *
 * Usage:
 *   node scripts/sync-from-mcp.js                  # Dry-run — shows what would change
 *   node scripts/sync-from-mcp.js --write           # Write new/updated app JSONs
 *   node scripts/sync-from-mcp.js --write --only slack,stripe   # Only sync specific apps
 *   node scripts/sync-from-mcp.js --list            # List all available MCP servers
 *
 * How it works:
 *   1. Scans /root/code/mcp/servers/*.json for server definitions with tools
 *   2. For each server, loads the matching /root/code/mcp/providers/{name}.json for auth config
 *   3. Converts both into the AppTemplate format used by @apteva/integrations
 *   4. Compares against existing src/apps/*.json and reports diffs
 *
 * Mapping logic (MCP → AppTemplate):
 *
 *   SERVER                            →  APP TEMPLATE
 *   ──────────────────────────────────────────────────────────────
 *   server.name                       →  slug
 *   server.display_name               →  name
 *   server.description                →  description
 *   server.icon_url / provider.favicon →  logo
 *   server.tags                       →  categories
 *   configuration.base_url            →  base_url (fallback: infer from tool http.url)
 *
 *   PROVIDER AUTH                     →  APP AUTH
 *   ──────────────────────────────────────────────────────────────
 *   provider_type: "api_key"          →  auth.types: ["bearer"] or ["api_key"]
 *     header_name = "Authorization"   →  auth.types: ["bearer"]
 *     header_name = "X-API-Key"       →  auth.types: ["api_key"]
 *   provider_type: "oauth"            →  auth.types: ["bearer", "oauth2"]
 *   auth_config.header_name/prefix    →  auth.headers
 *   auth_config.required_fields       →  auth.credential_fields
 *   oauth_config.auth_url             →  auth.oauth2.authorize_url
 *   oauth_config.token_url            →  auth.oauth2.token_url
 *   oauth_config.scopes               →  auth.oauth2.scopes
 *
 *   MCP TOOL                          →  APP TOOL
 *   ──────────────────────────────────────────────────────────────
 *   name (strip server prefix)        →  name (snake_case)
 *   description                       →  description
 *   http.method                       →  method (fallback: infer from name)
 *   http.url (extract path)           →  path (relative to base_url)
 *   input_schema                      →  input_schema
 *
 * Skipped servers:
 *   - Servers without tools (supports_tools: false or empty tools array)
 *   - Internal/platform servers (code-platform, omnikit-code-platform, apteva)
 *   - Backup files (*.backup, *.json.backup)
 *   - Mock files (*.mocks.json)
 */

import { readFileSync, readdirSync, writeFileSync, existsSync } from "fs";
import { join, basename } from "path";

// ── Paths ──────────────────────────────────────────────────────────────────────
const MCP_ROOT = join(import.meta.dirname, "../../../../mcp");
const SERVERS_DIR = join(MCP_ROOT, "servers");
const PROVIDERS_DIR = join(MCP_ROOT, "providers");
const APPS_DIR = join(import.meta.dirname, "../src/apps");

// ── Skip list: internal/platform servers we never want as integrations ────────
const SKIP_SERVERS = new Set([
  "apteva",
  "code-platform",
  "code-platform-ops",
  "omnikit-code-platform",
  "internal",
]);

// ── CLI args ───────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const doWrite = args.includes("--write");
const doList = args.includes("--list");
const onlyFlag = args.find(a => a.startsWith("--only"));
const onlyFilter = onlyFlag
  ? new Set(args[args.indexOf(onlyFlag) + 1]?.split(",").map(s => s.trim()))
  : null;

// ── Helpers ────────────────────────────────────────────────────────────────────

function loadJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

/** Strip the server-name prefix from tool names: "slack-send-message" → "send_message" */
function cleanToolName(toolName, serverName) {
  let name = toolName;
  // Remove server prefix (e.g., "slack-send-message" → "send-message")
  if (name.startsWith(serverName + "-")) {
    name = name.slice(serverName.length + 1);
  }
  // Convert kebab-case to snake_case
  return name.replace(/-/g, "_");
}

/** Infer HTTP method from tool name when http config is missing */
function inferMethod(toolName) {
  const lower = toolName.toLowerCase();
  if (lower.startsWith("create") || lower.startsWith("send") || lower.startsWith("post") || lower.startsWith("upload")) return "POST";
  if (lower.startsWith("update") || lower.startsWith("edit") || lower.startsWith("modify")) return "PUT";
  if (lower.startsWith("delete") || lower.startsWith("remove")) return "DELETE";
  return "GET"; // list, get, search, etc.
}

/** Extract base URL from a full tool URL */
function extractBaseUrl(fullUrl) {
  try {
    const u = new URL(fullUrl);
    // Use origin + first path segment as base
    const segments = u.pathname.split("/").filter(Boolean);
    // Common API versioning patterns: /v1, /v2, /api, etc.
    let basePath = "";
    for (const seg of segments) {
      if (/^v\d+/.test(seg) || seg === "api") {
        basePath += "/" + seg;
      } else {
        break;
      }
    }
    return u.origin + basePath;
  } catch {
    return null;
  }
}

/** Extract path relative to base URL */
function extractToolPath(fullUrl, baseUrl) {
  if (!fullUrl || !baseUrl) return null;
  try {
    const full = new URL(fullUrl);
    const base = new URL(baseUrl);
    let path = full.pathname;
    const basePath = base.pathname;
    if (path.startsWith(basePath)) {
      path = path.slice(basePath.length);
    }
    if (!path.startsWith("/")) path = "/" + path;
    // Convert {{param}} to {param} for consistency
    path = path.replace(/\{\{(\w+)\}\}/g, "{$1}");
    return path;
  } catch {
    return null;
  }
}

/** Build auth config from MCP provider */
function buildAuth(provider) {
  if (!provider) {
    return { types: ["bearer"], headers: { "Authorization": "Bearer {{token}}" }, credential_fields: [{ name: "token", label: "API Key" }] };
  }

  const auth = { types: [] };
  const isOAuth = provider.provider_type === "oauth";
  const authConfig = provider.auth_config || {};

  // Determine auth type(s)
  if (isOAuth) {
    auth.types = ["bearer", "oauth2"];
  } else {
    // api_key provider — check header to determine if it's bearer or api_key style
    const headerName = (authConfig.header_name || "").toLowerCase();
    if (headerName === "authorization") {
      auth.types = ["bearer"];
    } else if (headerName.includes("api") || headerName.includes("key")) {
      auth.types = ["api_key"];
    } else {
      auth.types = ["bearer"]; // default
    }
  }

  // Build headers
  if (authConfig.header_name) {
    const prefix = authConfig.header_prefix || "";
    auth.headers = {
      [authConfig.header_name]: `${prefix}{{token}}`.trim(),
    };
  } else {
    auth.headers = { "Authorization": "Bearer {{token}}" };
  }

  // Build credential fields from required_fields
  const fields = [];
  for (const field of authConfig.required_fields || []) {
    const desc = authConfig.field_descriptions?.[field];
    fields.push({
      name: field === "access_token" || field === "secretKey" || field === "apiKey" ? "token" : field,
      label: desc ? field.replace(/([A-Z])/g, " $1").replace(/^./, s => s.toUpperCase()).trim() : field,
      ...(desc ? { description: desc } : {}),
    });
  }
  if (fields.length === 0) {
    fields.push({ name: "token", label: "API Key" });
  }
  auth.credential_fields = fields;

  // Build OAuth2 config
  if (isOAuth && provider.oauth_config) {
    const oc = provider.oauth_config;
    auth.oauth2 = {
      authorize_url: oc.auth_url || oc.authorize_url || "",
      token_url: oc.token_url || "",
      scopes: oc.scopes || [],
      client_id_required: true,
      pkce: oc.pkce ?? false,
    };
  }

  return auth;
}

/** Convert one MCP server + provider pair into an AppTemplate */
function convertToAppTemplate(server, provider) {
  const serverMeta = server.server || {};
  const tools = server.tools || [];
  const config = server.configuration || {};

  // Determine base URL from: configuration.base_url → internal_api_base.production → first tool http.url
  let baseUrl = config.base_url || null;
  if (!baseUrl && serverMeta.internal_api_base) {
    baseUrl = serverMeta.internal_api_base.production || serverMeta.internal_api_base.local || null;
  }
  if (!baseUrl) {
    // Try to extract from first tool with http.url
    const firstHttpTool = tools.find(t => t.http?.url && !t.http.url.includes("{{"));
    if (firstHttpTool) {
      baseUrl = extractBaseUrl(firstHttpTool.http.url);
    }
  }

  // Build app tools
  const appTools = tools.map(tool => {
    const cleanName = cleanToolName(tool.name, serverMeta.name);

    let method = tool.http?.method || inferMethod(cleanName);
    let path = null;

    if (tool.http?.url) {
      // URL may contain {{internal_api_base}} or be absolute
      let resolvedUrl = tool.http.url;
      if (resolvedUrl.includes("{{internal_api_base}}") && baseUrl) {
        resolvedUrl = resolvedUrl.replace("{{internal_api_base}}", baseUrl);
      }
      if (resolvedUrl.startsWith("http")) {
        path = extractToolPath(resolvedUrl, baseUrl);
      }
    }

    // If no path could be determined, generate from tool name
    if (!path) {
      path = "/" + cleanName.replace(/_/g, "-");
    }

    const appTool = {
      name: cleanName,
      description: tool.description || tool.display_name || cleanName,
      method: method.toUpperCase(),
      path,
      input_schema: tool.input_schema || { type: "object", properties: {} },
    };

    // Add response_path if present
    if (tool.response_path) {
      appTool.response_path = tool.response_path;
    }

    return appTool;
  });

  // Remove credential-injection params from input schemas (e.g., api_key injected via headers)
  const credFields = new Set(["api_key", "access_token", "bearer_token", "token"]);
  for (const tool of appTools) {
    if (tool.input_schema?.properties) {
      for (const key of credFields) {
        delete tool.input_schema.properties[key];
      }
      // Remove from required array too
      if (Array.isArray(tool.input_schema.required)) {
        tool.input_schema.required = tool.input_schema.required.filter(r => !credFields.has(r));
        if (tool.input_schema.required.length === 0) delete tool.input_schema.required;
      }
    }
  }

  return {
    slug: serverMeta.name,
    name: serverMeta.display_name || serverMeta.name,
    description: serverMeta.description || provider?.description || "",
    logo: serverMeta.icon_url || provider?.favicon || null,
    categories: serverMeta.tags || [],
    base_url: baseUrl || "",
    auth: buildAuth(provider),
    tools: appTools,
  };
}

// ── Main ───────────────────────────────────────────────────────────────────────

function main() {
  // Load all server files
  const serverFiles = readdirSync(SERVERS_DIR)
    .filter(f => f.endsWith(".json") && !f.includes(".backup") && !f.includes(".mocks"));

  if (doList) {
    console.log(`\nAvailable MCP servers (${serverFiles.length} files):\n`);
    const results = [];
    for (const file of serverFiles.sort()) {
      const server = loadJson(join(SERVERS_DIR, file));
      if (!server?.server) continue;
      const s = server.server;
      const toolCount = (server.tools || []).length;
      const skip = SKIP_SERVERS.has(s.name) ? " [SKIP]" : "";
      const existing = existsSync(join(APPS_DIR, `${s.name}.json`)) ? " [EXISTS]" : "";
      results.push(`  ${s.name.padEnd(30)} ${String(toolCount).padStart(3)} tools  ${(s.display_name || "").padEnd(25)} ${existing}${skip}`);
    }
    for (const r of results) console.log(r);
    console.log(`\nTotal: ${results.length} servers`);
    console.log(`Skipped: ${[...SKIP_SERVERS].join(", ")}`);
    return;
  }

  console.log(`\nSync MCP → @apteva/integrations${doWrite ? " (WRITE MODE)" : " (DRY RUN)"}\n`);

  let created = 0, updated = 0, skipped = 0, unchanged = 0;

  for (const file of serverFiles.sort()) {
    const serverName = file.replace(".json", "");

    if (SKIP_SERVERS.has(serverName)) { skipped++; continue; }
    if (onlyFilter && !onlyFilter.has(serverName)) continue;

    const server = loadJson(join(SERVERS_DIR, file));
    if (!server?.server) { skipped++; continue; }

    // Skip servers with no tools
    const tools = server.tools || [];
    if (tools.length === 0) { skipped++; continue; }

    // Load matching provider (optional — some servers have no provider)
    const provider = loadJson(join(PROVIDERS_DIR, `${serverName}.json`));

    // Convert
    const appTemplate = convertToAppTemplate(server, provider);

    // Check existing
    const appPath = join(APPS_DIR, `${serverName}.json`);
    const existing = loadJson(appPath);

    if (existing) {
      // Compare (ignore whitespace differences)
      const existingStr = JSON.stringify(existing, null, 2);
      const newStr = JSON.stringify(appTemplate, null, 2);
      if (existingStr === newStr) {
        unchanged++;
        continue;
      }
      // Show diff summary
      const existingTools = existing.tools?.length || 0;
      const newTools = appTemplate.tools.length;
      console.log(`  UPDATE  ${serverName.padEnd(28)} ${existingTools} → ${newTools} tools`);
      updated++;
    } else {
      console.log(`  CREATE  ${serverName.padEnd(28)} ${appTemplate.tools.length} tools`);
      created++;
    }

    if (doWrite) {
      writeFileSync(appPath, JSON.stringify(appTemplate, null, 2) + "\n");
    }
  }

  console.log(`\nSummary: ${created} new, ${updated} updated, ${unchanged} unchanged, ${skipped} skipped`);
  if (!doWrite && (created > 0 || updated > 0)) {
    console.log(`\nRun with --write to apply changes.`);
  }
}

main();
