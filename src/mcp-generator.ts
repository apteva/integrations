import type {
  AppTemplate,
  AppToolTemplate,
  Connection,
  GeneratedMcpServer,
  GeneratedMcpTool,
  GeneratedRemoteMcp,
} from "./types.js";

/**
 * Generate an MCP server definition from a connection + its app template.
 *
 * For `kind: "rest"` (default) — tools are generated from `app.tools`,
 * each becoming an HTTP-handler entry with credentials baked in.
 *
 * For `kind: "remote_mcp"` — no local tools. The descriptor returned
 * carries the vendor's MCP URL + resolved auth headers so the caller
 * (Apteva server) can register it with the instance's MCP gateway.
 */
export function generateMcpServer(
  connection: Connection,
  app: AppTemplate
): GeneratedMcpServer {
  if (app.kind === "remote_mcp") {
    return generateRemoteMcpServer(connection, app);
  }

  const tools: GeneratedMcpTool[] = app.tools.map((tool) =>
    generateMcpTool(app, tool, connection)
  );

  return {
    name: `${app.slug}-${connection.id}`,
    type: "local",
    source: "local-integration",
    tools,
  };
}

function generateRemoteMcpServer(
  connection: Connection,
  app: AppTemplate
): GeneratedMcpServer {
  if (!app.mcp) {
    throw new Error(
      `app ${app.slug} has kind=remote_mcp but no mcp.url declared`
    );
  }
  // Default to the same Authorization: Bearer {{token}} pattern most
  // OAuth-issued MCPs expect. Override per-app via app.mcp.auth_header.
  const authHeader = app.mcp.auth_header ?? {
    name: "Authorization",
    value: "Bearer {{token}}",
  };
  const headers: Record<string, string> = {
    [authHeader.name]: resolveCredentialTemplate(
      authHeader.value,
      connection.credentials
    ),
  };
  const remote: GeneratedRemoteMcp = {
    transport: app.mcp.transport,
    url: app.mcp.url,
    headers,
  };
  return {
    name: `${app.slug}-${connection.id}`,
    type: "remote",
    source: "remote-integration",
    tools: [],
    remote,
  };
}

/**
 * Generate a single MCP tool from an app tool template + connection.
 */
function generateMcpTool(
  app: AppTemplate,
  tool: AppToolTemplate,
  connection: Connection
): GeneratedMcpTool {
  // Build resolved headers with actual credentials
  const headers: Record<string, string> = {};
  if (app.auth.headers) {
    for (const [key, template] of Object.entries(app.auth.headers)) {
      headers[key] = resolveCredentialTemplate(template, connection.credentials);
    }
  }

  // Build auth query params (e.g. Pushover's ?token=xxx) and bake into URL
  let authQuery = "";
  if (app.auth.query_params) {
    const parts: string[] = [];
    for (const [key, template] of Object.entries(app.auth.query_params)) {
      const value = resolveCredentialTemplate(template, connection.credentials);
      parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(value)}`);
    }
    if (parts.length > 0) authQuery = `?${parts.join("&")}`;
  }

  // Build the full URL template (path params remain as {param} for runtime resolution)
  const url = `${app.base_url.replace(/\/$/, "")}${tool.path}${authQuery}`;

  // For POST/PUT/PATCH, generate a body template
  let bodyTemplate: string | undefined;
  if (tool.method !== "GET" && tool.method !== "DELETE") {
    // The body template uses the tool's input_schema properties as a hint.
    // At runtime, the MCP handler will JSON.stringify the input minus path params.
    bodyTemplate = "{{json_body}}";
  }

  // Keep path params in schema — the agent needs to provide them as arguments
  // and the HTTP handler resolves {param} placeholders from args at runtime
  const cleanSchema = JSON.parse(JSON.stringify(tool.input_schema));

  // Build default_body from credential fields that map to tool input properties
  // e.g. Pushover's user_key credential → "user" field in send_notification
  let defaultBody: Record<string, string> | undefined;
  if (app.auth.credential_fields && tool.method !== "GET") {
    const props = (tool.input_schema as any)?.properties || {};
    for (const cf of app.auth.credential_fields) {
      // Check if the credential field name maps to a tool input (with or without _key suffix)
      const baseName = cf.name.replace(/_key$/, "");
      if (props[baseName] && connection.credentials.fields?.[cf.name]) {
        if (!defaultBody) defaultBody = {};
        defaultBody[baseName] = connection.credentials.fields[cf.name];
      }
    }
  }

  return {
    name: `${app.slug}_${tool.name}`,
    description: `[${app.name}] ${tool.description}`,
    input_schema: cleanSchema,
    handler_type: "http",
    http_config: {
      method: tool.method,
      url,
      headers,
      body_template: bodyTemplate,
      ...(defaultBody ? { default_body: defaultBody } : {}),
    },
  };
}

// ─── Helpers ───

function resolveCredentialTemplate(
  template: string,
  credentials: Connection["credentials"]
): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_match, key) => {
    // Check custom fields first (most specific)
    if (credentials.fields?.[key]) return credentials.fields[key];

    switch (key) {
      case "token":
        return (
          credentials.fields?.token ||
          credentials.access_token ||
          credentials.bearer_token ||
          credentials.api_key ||
          ""
        );
      case "api_key":
        return credentials.fields?.api_key || credentials.api_key || "";
      case "username":
        return credentials.username || "";
      case "password":
        return credentials.password || "";
      default:
        return "";
    }
  });
}

function extractPathParams(path: string): string[] {
  const params: string[] = [];
  const regex = /\{(\w+)\}/g;
  let match;
  while ((match = regex.exec(path)) !== null) {
    params.push(match[1]);
  }
  return params;
}

function removePathParamsFromSchema(
  schema: Record<string, unknown>,
  pathParams: string[]
): Record<string, unknown> {
  if (pathParams.length === 0) return schema;

  const clone = JSON.parse(JSON.stringify(schema));
  if (clone.properties) {
    for (const param of pathParams) {
      delete clone.properties[param];
    }
    // Also remove from required array
    if (Array.isArray(clone.required)) {
      clone.required = clone.required.filter(
        (r: string) => !pathParams.includes(r)
      );
      if (clone.required.length === 0) delete clone.required;
    }
  }
  return clone;
}
