import type {
  AppTemplate,
  AppToolTemplate,
  Connection,
  GeneratedMcpServer,
  GeneratedMcpTool,
} from "./types.js";

/**
 * Generate an MCP server definition from a connection + its app template.
 * The generated server contains tools that map to HTTP API calls,
 * with credentials baked into the headers.
 */
export function generateMcpServer(
  connection: Connection,
  app: AppTemplate
): GeneratedMcpServer {
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

  // Build clean input schema without path params (those get resolved in URL)
  const pathParams = extractPathParams(tool.path);
  const cleanSchema = removePathParamsFromSchema(tool.input_schema, pathParams);

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
    },
  };
}

// ─── Helpers ───

function resolveCredentialTemplate(
  template: string,
  credentials: Connection["credentials"]
): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_match, key) => {
    switch (key) {
      case "token":
        return (
          credentials.access_token ||
          credentials.bearer_token ||
          credentials.api_key ||
          ""
        );
      case "api_key":
        return credentials.api_key || "";
      case "username":
        return credentials.username || "";
      case "password":
        return credentials.password || "";
      default:
        return credentials.fields?.[key] || "";
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
