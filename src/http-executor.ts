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

  // 1. Build the URL with path parameter + credential interpolation
  const url = buildUrl(app.base_url, tool.path, input, credentials);

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

  // 5. Split input into path-substituted, query-string, and body buckets.
  //    - Path params: already substituted into `url` above; drop from the
  //      remaining set so we don't echo them in body or query.
  //    - tool.query_params: explicitly declared by the template; always
  //      sent as URL query string regardless of HTTP method. Required for
  //      APIs that mix query+body on POST/PUT (e.g. Google Sheets'
  //      values:append puts valueInputOption in the URL but the
  //      ValueRange object in the body).
  //    - GET/DELETE: everything left over goes to query string.
  //    - POST/PUT/PATCH: everything left over goes to body.
  const pathParams = extractPathParams(tool.path);
  const declaredQueryParams = tool.query_params || [];

  const remainingParams: Record<string, unknown> = {};
  const toolQueryParams: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if (pathParams.includes(k)) continue;
    if (declaredQueryParams.includes(k)) {
      // Skip undefined / null so optional query fields don't show up
      // in the URL as empty strings.
      if (v !== undefined && v !== null && v !== "") {
        toolQueryParams[k] = v;
      }
      continue;
    }
    remainingParams[k] = v;
  }

  let finalUrl = url;
  const allQueryParams = { ...authQueryParams, ...toolQueryParams };

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

  // Append query params to URL. For GET/DELETE this includes everything;
  // for POST/PUT/PATCH it includes only auth + tool-declared query params
  // (the body bucket is sent as a JSON body separately above).
  const qs = buildQueryString(allQueryParams);
  if (qs) finalUrl += (finalUrl.includes("?") ? "&" : "?") + qs;

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
    } else if (isBinaryContentType(ct)) {
      const buffer = await response.arrayBuffer();
      data = {
        _binary: true,
        base64: Buffer.from(buffer).toString("base64"),
        mimeType: ct.split(";")[0].trim(),
        size: buffer.byteLength,
      };
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
  input: Record<string, unknown>,
  credentials?: ConnectionCredentials
): string {
  let resolved = path;

  // Replace {{credential.X}} placeholders with credential values
  if (credentials) {
    resolved = resolved.replace(/\{\{credential\.(\w+)\}\}/g, (_match, key) => {
      const value = credentials.fields?.[key] || (credentials as any)[key] || "";
      return encodeURIComponent(String(value));
    });
  }

  // Replace {param} placeholders with input values
  const paramRegex = /\{(\w+)\}/g;
  let match;
  while ((match = paramRegex.exec(resolved)) !== null) {
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

// Credential alias groups — see server/integrations.go for the canonical
// description. Within each group, the first non-empty value found is
// mirrored under every other name so a template using {{token}} resolves
// correctly when the credential blob uses {{accessToken}}, {{apiToken}},
// {{authToken}}, etc. This fixes ~48 templates that mix conventions.
const credAliasGroups: string[][] = [
  ["access_token", "accessToken", "token", "bearer_token", "auth_token", "authToken"],
  ["api_key", "apiKey", "apikey", "api_token", "apiToken", "x_api_key"],
  ["refresh_token", "refreshToken"],
  ["token_type", "tokenType"],
  ["expires_in", "expiresIn"],
  ["client_id", "clientId"],
  ["client_secret", "clientSecret"],
];

function normalizeCredentials(
  credentials: ConnectionCredentials
): Record<string, string> {
  // Flatten the structured credentials into a plain map. The legacy
  // structured fields (access_token, api_key, username, password) live at
  // the top level; everything else is in `fields`.
  const out: Record<string, string> = {};
  if (credentials.access_token) out.access_token = credentials.access_token;
  if (credentials.bearer_token) out.bearer_token = credentials.bearer_token;
  if (credentials.api_key) out.api_key = credentials.api_key;
  if (credentials.username) out.username = credentials.username;
  if (credentials.password) out.password = credentials.password;
  if (credentials.fields) {
    for (const [k, v] of Object.entries(credentials.fields)) {
      if (v) out[k] = String(v);
    }
  }

  // Apply alias mirroring.
  for (const group of credAliasGroups) {
    let val = "";
    for (const name of group) {
      if (out[name]) {
        val = out[name];
        break;
      }
    }
    if (!val) continue;
    for (const name of group) {
      if (!out[name]) out[name] = val;
    }
  }
  return out;
}

function resolveTemplate(
  template: string,
  credentials: ConnectionCredentials
): string {
  const norm = normalizeCredentials(credentials);
  return template.replace(/\{\{(\w+)\}\}/g, (_match, key) => {
    return norm[key] || "";
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

const BINARY_MIME_PREFIXES = [
  "audio/",
  "video/",
  "image/",
  "application/octet-stream",
  "application/pdf",
  "application/zip",
  "application/gzip",
  "application/x-tar",
  "application/vnd.openxmlformats",
  "application/vnd.ms-",
  "application/msword",
  "font/",
];

function isBinaryContentType(contentType: string): boolean {
  const ct = contentType.toLowerCase();
  return BINARY_MIME_PREFIXES.some((prefix) => ct.startsWith(prefix) || ct.includes(prefix));
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
