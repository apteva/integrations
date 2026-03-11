import type {
  AppTemplate,
  AppToolTemplate,
  Connection,
  ConnectionCredentials,
} from "./types.js";

export interface ExecuteToolOptions {
  app: AppTemplate;
  tool: AppToolTemplate;
  credentials: ConnectionCredentials;
  input: Record<string, unknown>;
  timeout?: number;
}

export interface ExecuteToolResult {
  success: boolean;
  status: number;
  data: unknown;
  headers: Record<string, string>;
}

/**
 * Execute an HTTP-based tool call against a real API.
 * Takes an app template, tool definition, connection credentials, and input params,
 * then makes the actual HTTP request and returns the result.
 */
export async function executeTool(
  opts: ExecuteToolOptions
): Promise<ExecuteToolResult> {
  const { app, tool, credentials, input, timeout = 30000 } = opts;

  // 1. Build the URL with path parameter interpolation
  const url = buildUrl(app.base_url, tool.path, input);

  // 2. Build headers from app auth config + credentials
  const headers = buildHeaders(app, credentials);

  // 3. Build request options
  const fetchOpts: RequestInit = {
    method: tool.method,
    headers,
    signal: AbortSignal.timeout(timeout),
  };

  // 4. Build auth query params (e.g. Pushover's ?token=xxx)
  const authQueryParams = buildAuthQueryParams(app, credentials);

  // 5. For GET/DELETE, remaining params go to query string.
  //    For POST/PUT/PATCH, remaining params go to body.
  const pathParams = extractPathParams(tool.path);
  const remainingParams = Object.fromEntries(
    Object.entries(input).filter(([k]) => !pathParams.includes(k))
  );

  let finalUrl = url;
  const allQueryParams = { ...authQueryParams };

  if (tool.method === "GET" || tool.method === "DELETE") {
    Object.assign(allQueryParams, remainingParams);
  } else {
    // For POST with query_params auth (like Pushover), merge auth + input into body
    if (Object.keys(authQueryParams).length > 0) {
      // API-key APIs like Pushover expect token in the POST body too
      const bodyParams = { ...authQueryParams, ...remainingParams };
      const contentType = headers["Content-Type"] || headers["content-type"] || "";
      if (contentType.includes("x-www-form-urlencoded")) {
        fetchOpts.body = buildQueryString(bodyParams);
      } else {
        fetchOpts.body = JSON.stringify(bodyParams);
      }
    } else {
      const contentType = headers["Content-Type"] || headers["content-type"] || "";
      if (contentType.includes("x-www-form-urlencoded")) {
        fetchOpts.body = buildQueryString(remainingParams);
      } else {
        fetchOpts.body = JSON.stringify(remainingParams);
      }
    }
  }

  // Append query params to URL for GET/DELETE (or auth params for any method)
  if (tool.method === "GET" || tool.method === "DELETE") {
    const qs = buildQueryString(allQueryParams);
    if (qs) finalUrl += `?${qs}`;
  }

  // 5. Execute the request
  try {
    const response = await fetch(finalUrl, fetchOpts);
    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((v, k) => {
      responseHeaders[k] = v;
    });

    let data: unknown;
    const ct = response.headers.get("content-type") || "";
    if (ct.includes("application/json")) {
      data = await response.json();
    } else {
      data = await response.text();
    }

    // Apply response_path extraction if defined
    if (tool.response_path && data && typeof data === "object") {
      data = extractPath(data, tool.response_path);
    }

    return {
      success: response.ok,
      status: response.status,
      data,
      headers: responseHeaders,
    };
  } catch (error: unknown) {
    const message =
      error instanceof Error ? error.message : "Unknown error";
    return {
      success: false,
      status: 0,
      data: { error: message },
      headers: {},
    };
  }
}

// ─── Helpers ───

function buildUrl(
  baseUrl: string,
  path: string,
  input: Record<string, unknown>
): string {
  // Replace {param} placeholders with actual values
  let resolved = path;
  const paramRegex = /\{(\w+)\}/g;
  let match;
  while ((match = paramRegex.exec(path)) !== null) {
    const key = match[1];
    const value = input[key];
    if (value !== undefined) {
      resolved = resolved.replace(`{${key}}`, encodeURIComponent(String(value)));
    }
  }
  return `${baseUrl.replace(/\/$/, "")}${resolved}`;
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

function buildAuthQueryParams(
  app: AppTemplate,
  credentials: ConnectionCredentials
): Record<string, string> {
  const params: Record<string, string> = {};
  if (app.auth.query_params) {
    for (const [key, template] of Object.entries(app.auth.query_params)) {
      params[key] = resolveTemplate(template, credentials);
    }
  }
  return params;
}

function buildHeaders(
  app: AppTemplate,
  credentials: ConnectionCredentials
): Record<string, string> {
  const headers: Record<string, string> = {};

  if (app.auth.headers) {
    for (const [key, template] of Object.entries(app.auth.headers)) {
      headers[key] = resolveTemplate(template, credentials);
    }
  }

  return headers;
}

function resolveTemplate(
  template: string,
  credentials: ConnectionCredentials
): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_match, key) => {
    // Map common template vars to credential fields
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

function buildQueryString(params: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        parts.push(
          `${encodeURIComponent(key)}=${encodeURIComponent(String(item))}`
        );
      }
    } else if (typeof value === "object") {
      parts.push(
        `${encodeURIComponent(key)}=${encodeURIComponent(JSON.stringify(value))}`
      );
    } else {
      parts.push(
        `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`
      );
    }
  }
  return parts.join("&");
}

function extractPath(data: unknown, jsonPath: string): unknown {
  // Simple dot-notation path extraction: "data.items"
  const parts = jsonPath.split(".");
  let current: unknown = data;
  for (const part of parts) {
    if (current === null || current === undefined) return current;
    if (typeof current === "object") {
      current = (current as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return current;
}
