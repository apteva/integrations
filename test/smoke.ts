import { loadAppTemplates, getAppTemplate, listApps } from "../src/apps/index.js";
import { executeTool } from "../src/http-executor.js";
import { generateMcpServer } from "../src/mcp-generator.js";
import type { Connection } from "../src/types.js";

// ─── Test 1: App loading ───
console.log("--- App Loading ---");
const apps = listApps();
console.log(`Loaded ${apps.length} apps:`, apps.map((a) => a.slug).join(", "));

const pushover = getAppTemplate("pushover");
if (!pushover) throw new Error("Pushover app not found!");
console.log(`Pushover: ${pushover.tools.length} tools, auth: ${pushover.auth.types.join(", ")}`);
console.log(`  query_params:`, pushover.auth.query_params);

// ─── Test 2: MCP server generation with api_key auth ───
console.log("\n--- MCP Server Generation (Pushover) ---");
const fakeConn: Connection = {
  id: "test-conn-1",
  app_slug: "pushover",
  app_name: "Pushover",
  name: "My Pushover",
  auth_type: "api_key",
  credentials: { api_key: "a1b2c3d4e5f6g7h8i9j0" },
  status: "active",
  project_id: null,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

const mcpServer = generateMcpServer(fakeConn, pushover);
console.log(`MCP Server: ${mcpServer.name}, ${mcpServer.tools.length} tools`);
for (const tool of mcpServer.tools) {
  console.log(`  - ${tool.name}: ${tool.http_config.method} ${tool.http_config.url}`);
}

// ─── Test 3: MCP server generation with bearer auth (GitHub) ───
console.log("\n--- MCP Server Generation (GitHub) ---");
const github = getAppTemplate("github")!;
const ghConn: Connection = {
  id: "test-conn-2",
  app_slug: "github",
  app_name: "GitHub",
  name: "My GitHub",
  auth_type: "bearer",
  credentials: { bearer_token: "ghp_fake123" },
  status: "active",
  project_id: null,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

const ghMcp = generateMcpServer(ghConn, github);
console.log(`MCP Server: ${ghMcp.name}, ${ghMcp.tools.length} tools`);
for (const tool of ghMcp.tools) {
  console.log(`  - ${tool.name}: ${tool.http_config.method} ${tool.http_config.url}`);
  console.log(`    Auth header: ${tool.http_config.headers["Authorization"]?.substring(0, 20)}...`);
}

// ─── Test 4: HubSpot loads as a hosted-MCP app ───
console.log("\n--- HubSpot (hosted MCP) ---");
const hubspot = getAppTemplate("hubspot");
if (!hubspot) throw new Error("hubspot app not found!");
if (hubspot.kind !== "remote_mcp") {
  throw new Error(`expected kind=remote_mcp, got ${hubspot.kind}`);
}
if (!hubspot.mcp) throw new Error("hubspot missing mcp config");
console.log(
  `Loaded ${hubspot.slug}: kind=${hubspot.kind}, transport=${hubspot.mcp.transport}, url=${hubspot.mcp.url}`
);

const hsConn: Connection = {
  id: "test-conn-3",
  app_slug: "hubspot",
  app_name: "HubSpot",
  name: "My HubSpot",
  auth_type: "oauth2",
  credentials: { access_token: "fake_oauth_token_xyz" },
  status: "active",
  project_id: null,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

const hsMcpServer = generateMcpServer(hsConn, hubspot);
if (hsMcpServer.type !== "remote") {
  throw new Error(`expected type=remote, got ${hsMcpServer.type}`);
}
if (hsMcpServer.tools.length !== 0) {
  throw new Error(
    `remote MCP should have empty tools, got ${hsMcpServer.tools.length}`
  );
}
if (!hsMcpServer.remote) throw new Error("remote descriptor missing");
if (hsMcpServer.remote.url !== "https://mcp-eu1.hubspot.com/mcp") {
  throw new Error(`unexpected url: ${hsMcpServer.remote.url}`);
}
const expectedAuth = "Bearer fake_oauth_token_xyz";
if (hsMcpServer.remote.headers["Authorization"] !== expectedAuth) {
  throw new Error(
    `auth header mismatch: ${hsMcpServer.remote.headers["Authorization"]} vs ${expectedAuth}`
  );
}
console.log(
  `  remote: ${hsMcpServer.remote.transport} ${hsMcpServer.remote.url}`
);

// ─── Test 5: Remote MCP without mcp config should throw ───
console.log("\n--- Remote MCP error handling ---");
const broken = { ...hubspot, mcp: undefined } as typeof hubspot;
let threw = false;
try {
  generateMcpServer(hsConn, broken);
} catch (err) {
  threw = true;
  console.log(`  correctly threw: ${(err as Error).message}`);
}
if (!threw) throw new Error("expected generator to throw on missing mcp");

console.log("\n✓ All smoke tests passed");
