import type {
  AppTemplate,
  AppToolTemplate,
  Connection,
  ConnectionCredentials,
  ResponseTransform,
  RequestTransform,
} from "./types.js";
import { createHash } from "node:crypto";
import { signAwsRequest } from "./aws-sigv4.js";
import { xmlToJson } from "./xml-to-json.js";
import { ProxyAgent } from "undici";

export interface ExecuteToolOptions {
  app: AppTemplate;
  tool: AppToolTemplate;
  credentials: ConnectionCredentials;
  input: Record<string, unknown>;
  timeout?: number;
  // Maximum size, in bytes, accepted for a binary response. Larger
  // payloads are rejected with success=false instead of being buffered
  // into memory. Defaults to 25 MB. Only applies to the binary branch;
  // JSON and text responses are not capped here (fetch itself bounds them
  // via the server and the timeout).
  maxBinaryBytes?: number;
}

const DEFAULT_MAX_BINARY_BYTES = 25 * 1024 * 1024;

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
  const {
    app,
    tool,
    credentials,
    input,
    // Caller's explicit timeout wins; otherwise fall back to the tool's
    // declared timeout_ms (for slow upstreams like image / video / long
    // audio); finally the 30s default. Capped at 10 minutes.
    timeout = Math.min(tool.timeout_ms ?? 30000, 600000),
    maxBinaryBytes = DEFAULT_MAX_BINARY_BYTES,
  } = opts;

  // 1. Build the URL with path parameter + credential interpolation
  const url = buildUrl(tool.base_url || app.base_url, tool.path, input, credentials);

  // 2. Build headers from app auth config + credentials
  const headers = buildHeaders(app, credentials);
  if (tool.headers) {
    for (const [key, template] of Object.entries(tool.headers)) {
      headers[key] = resolveTemplate(template, credentials);
    }
  }

  // 3. Build request options
  const fetchOpts: RequestInit = {
    method: tool.method,
    headers,
    signal: AbortSignal.timeout(timeout),
  };

  // 4. Build auth query params (e.g. Pushover's ?token=xxx)
  const authQueryParams = buildAuthQueryParams(app, credentials);
  const authBodyParams = buildAuthBodyParams(app, credentials);

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
  const transformedBody = tool.request_transform
    ? applyRequestTransform(tool.request_transform, input)
    : undefined;

  // Request-side binary body: if the template declared a `body_binary_param`
  // and that input field is a _binary envelope (populated by the core
  // blob-handle rehydration path for fields carrying blobref:// values),
  // pull it aside BEFORE the normal query/body split so it doesn't leak
  // into either bucket.
  const binaryParam = tool.body_binary_param;
  const binaryEnvelope =
    binaryParam && isBinaryEnvelope(input[binaryParam])
      ? (input[binaryParam] as Record<string, unknown>)
      : null;

  // Root-body param: when set, this field's value IS the whole JSON body
  // (e.g. a bare array). Pulled aside before the query/body split so it
  // isn't echoed as a query param or wrapped in an object. Only honored
  // for non-binary, body-bearing methods below.
  const rootParam = tool.body_root_param;
  const hasRootBody =
    !binaryEnvelope &&
    !!rootParam &&
    rootParam in input &&
    input[rootParam] !== undefined &&
    input[rootParam] !== null;

  const remainingParams: Record<string, unknown> = {};
  const toolQueryParams: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if (pathParams.includes(k)) continue;
    if (binaryEnvelope && k === binaryParam) continue;
    if (hasRootBody && k === rootParam) continue;
    if (transformedBody !== undefined && !declaredQueryParams.includes(k)) {
      continue;
    }
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

  if (binaryEnvelope) {
    // Binary-body path: decode the envelope and send its bytes raw.
    // The envelope's mimeType wins if provided; otherwise default to
    // application/octet-stream (matches Deepgram's recommended shape).
    const base64 = String(binaryEnvelope.base64 || "");
    const mime =
      String(binaryEnvelope.mimeType || "") || "application/octet-stream";
    fetchOpts.body = Buffer.from(base64, "base64");
    // Let the envelope's Content-Type override any template header.
    // Strip casing variants first so we don't leave a stale one behind.
    delete headers["Content-Type"];
    delete headers["content-type"];
    headers["Content-Type"] = mime;
    fetchOpts.headers = headers;
    // Any leftover non-binary, non-query input fields are ignored here —
    // if a template mixes raw body with JSON fields it should put those
    // in query_params, which is already the convention.
  } else if (hasRootBody) {
    // Root-body path: send the named field's value as the entire JSON
    // body, verbatim — supports top-level arrays (IONOS create-records)
    // that the object-wrapping path below can't express.
    fetchOpts.body = JSON.stringify(input[rootParam as string]);
    if (!headers["Content-Type"] && !headers["content-type"]) {
      headers["Content-Type"] = "application/json";
    }
    fetchOpts.headers = headers;
  } else if (transformedBody !== undefined) {
    const body =
      isPlainObject(transformedBody) && Object.keys(authBodyParams).length > 0
        ? { ...authBodyParams, ...transformedBody }
        : transformedBody;
    fetchOpts.body = JSON.stringify(body);
    if (!headers["Content-Type"] && !headers["content-type"]) {
      headers["Content-Type"] = "application/json";
    }
    fetchOpts.headers = headers;
  } else if (tool.method === "GET" || tool.method === "DELETE") {
    Object.assign(allQueryParams, remainingParams);
  } else {
    // For POST with query_params auth (like Pushover), merge auth + input into body.
    // Some APIs instead require credentials in the JSON body while still using
    // headers/query elsewhere; body_params is explicit opt-in for those.
    if (Object.keys(authQueryParams).length > 0) {
      // API-key APIs like Pushover expect token in the POST body too
      const bodyParams = { ...authQueryParams, ...authBodyParams, ...remainingParams };
      const contentType = headers["Content-Type"] || headers["content-type"] || "";
      if (contentType.includes("x-www-form-urlencoded")) {
        fetchOpts.body = buildQueryString(bodyParams);
      } else {
        fetchOpts.body = JSON.stringify(bodyParams);
      }
    } else {
      const bodyParams = { ...authBodyParams, ...remainingParams };
      const contentType = headers["Content-Type"] || headers["content-type"] || "";
      if (contentType.includes("x-www-form-urlencoded")) {
        fetchOpts.body = buildQueryString(bodyParams);
      } else {
        fetchOpts.body = JSON.stringify(bodyParams);
      }
    }
  }

  // Append query params to URL. For GET/DELETE this includes everything;
  // for POST/PUT/PATCH it includes only auth + tool-declared query params
  // (the body bucket is sent as a JSON body separately above).
  const qs = buildQueryString(allQueryParams);
  if (qs) finalUrl += (finalUrl.includes("?") ? "&" : "?") + qs;

  // AWS SigV4 signing — must happen AFTER the body and final URL are
  // built (the signature covers both). Skipped silently if the auth
  // type isn't aws_sigv4 or required credentials are missing; the
  // request will fail downstream with the AWS-side auth error rather
  // than a confusing local exception.
  if (
    app.auth.types?.includes("aws_sigv4") &&
    app.auth.aws_sigv4?.service
  ) {
    const norm = normalizeCredentials(credentials);
    const accessKeyId = norm.access_key_id || norm.accessKeyId;
    const secretAccessKey = norm.secret_access_key || norm.secretAccessKey;
    const region = norm.region;
    const sessionToken = norm.session_token || norm.sessionToken;
    if (accessKeyId && secretAccessKey && region) {
      const bodyForSigning =
        typeof fetchOpts.body === "string"
          ? fetchOpts.body
          : fetchOpts.body instanceof Buffer
            ? fetchOpts.body
            : undefined;
      const sigHeaders = signAwsRequest({
        method: tool.method,
        url: finalUrl,
        headers,
        body: bodyForSigning,
        service: app.auth.aws_sigv4.service,
        region,
        accessKeyId,
        secretAccessKey,
        sessionToken,
      });
      // Strip any pre-existing Authorization (the bearer template won't
      // apply here, but defensive — and the casing-variant cleanup
      // mirrors the binary-body Content-Type handling above).
      delete headers["Authorization"];
      delete headers["authorization"];
      Object.assign(headers, sigHeaders);
      fetchOpts.headers = headers;
    }
  }

  if (app.auth.shareasale) {
    const norm = normalizeCredentials(credentials);
    const token = norm.token || norm.api_token;
    const secret = norm[app.auth.shareasale.secret_field];
    const action = new URL(finalUrl).searchParams.get("action") || "";
    if (token && secret && action) {
      const date = new Date().toUTCString();
      const signature = createHash("sha256")
        .update(`${token}:${date}:${action}:${secret}`)
        .digest("hex");
      headers["x-ShareASale-Date"] = date;
      headers["x-ShareASale-Authentication"] = signature.toUpperCase();
      fetchOpts.headers = headers;
    }
  }

  if (tool.return_request_url) {
    return {
      success: true,
      status: 200,
      data: { url: finalUrl },
      headers: {},
    };
  }

  // 5. Execute the request
  try {
    applyIntegrationProxy(app, fetchOpts);
    const response = await fetch(finalUrl, fetchOpts);
    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((v, k) => {
      responseHeaders[k] = v;
    });

    let data: unknown;
    const ct = response.headers.get("content-type") || "";
    let isBinary = false;
    if (ct.includes("application/json")) {
      // Parse JSON via text() so a malformed body doesn't collapse into
      // the network-error catch (which would lose response.status). If
      // the server sent us 500 with a broken error page labelled as
      // JSON, the caller still sees status=500 plus the raw body.
      const text = await response.text();
      try {
        data = text.length > 0 ? JSON.parse(text) : null;
      } catch (err) {
        return {
          success: false,
          status: response.status,
          data: {
            error: "invalid json response",
            detail: err instanceof Error ? err.message : String(err),
            raw: text.length > 2048 ? text.slice(0, 2048) + "…" : text,
          },
          headers: responseHeaders,
        };
      }
    } else if (isBinaryContentType(ct)) {
      // Pre-reject oversize payloads via Content-Length when available so
      // we don't buffer gigabytes into memory just to discover the cap.
      const declared = Number(response.headers.get("content-length") || "0");
      if (declared > maxBinaryBytes) {
        return {
          success: false,
          status: response.status,
          data: {
            error: "binary response too large",
            size: declared,
            max: maxBinaryBytes,
          },
          headers: responseHeaders,
        };
      }
      const buffer = await response.arrayBuffer();
      if (buffer.byteLength > maxBinaryBytes) {
        return {
          success: false,
          status: response.status,
          data: {
            error: "binary response too large",
            size: buffer.byteLength,
            max: maxBinaryBytes,
          },
          headers: responseHeaders,
        };
      }
      data = {
        _binary: true,
        base64: Buffer.from(buffer).toString("base64"),
        mimeType: ct.split(";")[0].trim(),
        size: buffer.byteLength,
      };
      isBinary = true;
    } else if (ct.includes("xml")) {
      // Legacy XML-RPC-style APIs (Namecheap, Akismet) return XML on
      // application/xml or text/xml. Parse to JSON so agents see a
      // real object instead of a text blob. If parsing fails, fall
      // back to the raw text.
      const text = await response.text();
      const parsed = xmlToJson(text);
      data = parsed !== null ? parsed : text;
    } else {
      data = await response.text();
    }

    // Apply response_path extraction if defined — but skip for binary
    // envelopes. extractPath would walk into { _binary, base64, ... }
    // looking for the template's path (e.g. "data") and silently return
    // undefined, destroying the payload.
    if (tool.response_path && data && typeof data === "object" && !isBinary) {
      data = extractPath(data, tool.response_path);
    }

    if (tool.response_transform && data && !isBinary) {
      data = applyResponseTransform(tool.response_transform, data);
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

function integrationProxyEnvName(slug: string): string {
  const normalized = slug
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized ? `APTEVA_INTEGRATION_PROXY_${normalized}` : "";
}

function integrationProxyURL(app: AppTemplate): { url: string; env: string } {
  const specific = integrationProxyEnvName(app.slug);
  if (specific) {
    const value = process.env[specific]?.trim();
    if (value) return { url: value, env: specific };
  }
  return {
    url: process.env.APTEVA_INTEGRATION_PROXY?.trim() || "",
    env: "APTEVA_INTEGRATION_PROXY",
  };
}

function applyIntegrationProxy(app: AppTemplate, fetchOpts: RequestInit): void {
  const { url: proxy, env } = integrationProxyURL(app);
  if (!proxy) return;
  try {
    new URL(proxy);
  } catch (err) {
    throw new Error(
      `invalid ${env}: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }
  (fetchOpts as RequestInit & { dispatcher?: unknown }).dispatcher =
    new ProxyAgent(proxy);
}

function buildUrl(
  baseUrl: string,
  path: string,
  input: Record<string, unknown>,
  credentials?: ConnectionCredentials
): string {
  let resolvedBase = baseUrl;
  let resolved = path;

  // Replace {{credential.X}} placeholders with credential values, in
  // both base_url and path. The base_url substitution is what lets
  // regional services (e.g. AWS SES at email.{{credential.region}}.amazonaws.com)
  // resolve their hostname from the connection's stored credentials.
  // Hostnames must NOT be percent-encoded; only the path placeholders
  // are URI-encoded (a region like "us-east-1" is already URL-safe).
  if (credentials) {
    const credValue = (key: string): string => {
      return credentials.fields?.[key] || (credentials as any)[key] || "";
    };
    resolvedBase = resolvedBase.replace(/\{\{credential\.(\w+)\}\}/g, (_m, key) =>
      String(credValue(key))
    );
    resolved = resolved.replace(/\{\{credential\.(\w+)\}\}/g, (_m, key) =>
      encodeURIComponent(String(credValue(key)))
    );
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
  // Absolute-path passthrough: tools whose endpoint lives on a different
  // host than the integration's primary base_url (YouTube's resumable
  // upload init, Pinecone per-index data plane, etc.) declare the full
  // URL in `path`. Detected post-substitution so {{credential.host}}
  // injection still works.
  if (/^https?:\/\//.test(resolved)) {
    return resolved;
  }
  return `${resolvedBase.replace(/\/$/, "")}${resolved}`;
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

function buildAuthBodyParams(
  app: AppTemplate,
  credentials: ConnectionCredentials
): Record<string, string> {
  const params: Record<string, string> = {};
  if (app.auth.body_params) {
    for (const [key, template] of Object.entries(app.auth.body_params)) {
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

function applyResponseTransform(
  transform: ResponseTransform,
  data: unknown
): unknown {
  switch (transform.type) {
    case "email_message":
      return normalizeEmailMessage(data);
    case "email_thread":
      return normalizeEmailThread(data);
    case "base64_field_decode": {
      const value = getPath(data, transform.source);
      const decoded =
        typeof value === "string"
          ? decodeString(value, transform.encoding || "base64")
          : "";
      const out = isPlainObject(data) ? JSON.parse(JSON.stringify(data)) : {};
      setPath(out, transform.target, decoded);
      return out;
    }
    case "field_map": {
      const out: Record<string, unknown> = {};
      for (const [target, source] of Object.entries(transform.fields)) {
        const value = getPath(data, source);
        if (value !== undefined) setPath(out, target, value);
      }
      return out;
    }
  }
}

function normalizeEmailThread(data: unknown): unknown {
  if (!isPlainObject(data)) return data;
  const messages = Array.isArray(data.messages)
    ? data.messages.map((message) => normalizeEmailMessage(message))
    : [];
  return {
    id: data.id,
    historyId: data.historyId,
    messages,
  };
}

function normalizeEmailMessage(data: unknown): unknown {
  if (!isPlainObject(data)) return data;
  const payload = isPlainObject(data.payload) ? data.payload : {};
  const headerPairs = Array.isArray(payload.headers) ? payload.headers : [];
  const headers = headersObject(headerPairs);
  const bodies = collectEmailBodies(payload);
  const internalDate = parseGmailInternalDate(data.internalDate);

  return {
    id: data.id,
    threadId: data.threadId,
    labelIds: data.labelIds,
    historyId: data.historyId,
    snippet: data.snippet,
    sizeEstimate: data.sizeEstimate,
    internalDate: data.internalDate,
    receivedAt: internalDate,
    headers,
    from: pickHeader(headers, "from"),
    to: pickHeader(headers, "to"),
    cc: pickHeader(headers, "cc"),
    bcc: pickHeader(headers, "bcc"),
    subject: pickHeader(headers, "subject"),
    date: pickHeader(headers, "date") || internalDate,
    messageId: pickHeader(headers, "message-id"),
    inReplyTo: pickHeader(headers, "in-reply-to"),
    references: pickHeader(headers, "references"),
    text: bodies.text.join("\n\n").trim(),
    html: bodies.html.join("\n\n").trim(),
    attachments: bodies.attachments,
  };
}

function headersObject(headers: unknown[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const header of headers) {
    if (!isPlainObject(header)) continue;
    const name = String(header.name || "").toLowerCase();
    const value = String(header.value || "");
    if (name) out[name] = value;
  }
  return out;
}

function pickHeader(headers: Record<string, string>, name: string): string {
  return headers[name.toLowerCase()] || "";
}

function collectEmailBodies(part: unknown): {
  text: string[];
  html: string[];
  attachments: Array<{
    filename: string;
    mimeType: string;
    attachmentId: string;
    size: number;
    partId: string;
  }>;
} {
  const out: {
    text: string[];
    html: string[];
    attachments: Array<{
      filename: string;
      mimeType: string;
      attachmentId: string;
      size: number;
      partId: string;
    }>;
  } = { text: [], html: [], attachments: [] };
  collectEmailBodiesInto(part, out);
  return out;
}

function collectEmailBodiesInto(
  part: unknown,
  out: ReturnType<typeof collectEmailBodies>
): void {
  if (!isPlainObject(part)) return;
  const mimeType = String(part.mimeType || "");
  const filename = String(part.filename || "");
  const body = isPlainObject(part.body) ? part.body : {};
  const data = typeof body.data === "string" ? body.data : "";
  const attachmentId = typeof body.attachmentId === "string" ? body.attachmentId : "";

  if (filename || attachmentId) {
    out.attachments.push({
      filename,
      mimeType,
      attachmentId,
      size: typeof body.size === "number" ? body.size : Number(body.size || 0),
      partId: String(part.partId || ""),
    });
  } else if (data && mimeType.toLowerCase().startsWith("text/plain")) {
    out.text.push(decodeString(data, "base64url"));
  } else if (data && mimeType.toLowerCase().startsWith("text/html")) {
    out.html.push(decodeString(data, "base64url"));
  }

  if (Array.isArray(part.parts)) {
    for (const child of part.parts) collectEmailBodiesInto(child, out);
  }
}

function parseGmailInternalDate(value: unknown): string {
  const millis = Number(value || 0);
  if (!Number.isFinite(millis) || millis <= 0) return "";
  return new Date(millis).toISOString();
}

function applyRequestTransform(
  transform: RequestTransform,
  input: Record<string, unknown>
): unknown {
  switch (transform.type) {
    case "mime_email": {
      const mime = buildMimeEmail(input);
      const body: Record<string, unknown> = {};
      setPath(
        body,
        transform.target || "raw",
        encodeString(mime, transform.encoding || "base64url")
      );
      copyIncludedFields(body, input, transform.include_fields);
      return body;
    }
    case "base64_field": {
      const source = input[transform.source];
      if (source === undefined || source === null) {
        throw new Error(`request_transform source missing: ${transform.source}`);
      }
      const body: Record<string, unknown> = {};
      setPath(
        body,
        transform.target,
        encodeString(String(source), transform.encoding || "base64")
      );
      copyIncludedFields(body, input, transform.include_fields);
      return body;
    }
    case "json_wrap": {
      const selected: Record<string, unknown> = {};
      for (const field of transform.fields) {
        const value = input[field];
        if (value !== undefined && value !== null) {
          selected[field] = value;
        }
      }
      const body: Record<string, unknown> = {};
      if (transform.target) {
        setPath(body, transform.target, selected);
      } else {
        Object.assign(body, selected);
      }
      copyIncludedFields(body, input, transform.include_fields);
      return body;
    }
  }
}

function getPath(data: unknown, path: string): unknown {
  const parts = path.split(".").filter(Boolean);
  let current = data;
  for (const part of parts) {
    if (!isPlainObject(current)) return undefined;
    current = current[part];
  }
  return current;
}

function buildMimeEmail(input: Record<string, unknown>): string {
  const to = formatAddressList(input.to);
  if (!to) throw new Error("mime_email transform requires a to recipient");

  const subject = stringValue(input.subject);
  const textBody = bodyValue(input.body);
  const htmlBody = bodyValue(input.htmlBody);
  if (!textBody && !htmlBody) {
    throw new Error("mime_email transform requires body or htmlBody");
  }

  const headers: string[] = [
    "MIME-Version: 1.0",
    `To: ${to}`,
    `Subject: ${encodeHeaderValue(subject)}`,
  ];
  addHeader(headers, "From", formatAddressList(input.from));
  addHeader(headers, "Cc", formatAddressList(input.cc));
  addHeader(headers, "Bcc", formatAddressList(input.bcc));
  addHeader(headers, "Reply-To", formatAddressList(input.replyTo));
  addHeader(headers, "In-Reply-To", stringValue(input.inReplyTo));
  addHeader(headers, "References", stringValue(input.references));

  const attachments = parseAttachments(input.attachments);
  const content = buildMimeContent(textBody, htmlBody);
  if (attachments.length === 0) {
    return [...headers, ...content.headers, "", content.body].join("\r\n");
  }

  const mixedBoundary = `apteva_mixed_${randomBoundarySuffix()}`;
  const bodyParts = [
    `--${mixedBoundary}`,
    content.headers.join("\r\n"),
    "",
    content.body,
  ];
  for (const attachment of attachments) {
    bodyParts.push(
      `--${mixedBoundary}`,
      `Content-Type: ${sanitizeHeaderValue(attachment.mimeType)}; name="${escapeQuotedParam(attachment.filename)}"`,
      "Content-Transfer-Encoding: base64",
      `Content-Disposition: attachment; filename="${escapeQuotedParam(attachment.filename)}"`,
      "",
      wrapBase64(attachment.base64)
    );
  }
  bodyParts.push(`--${mixedBoundary}--`);

  return [
    ...headers,
    `Content-Type: multipart/mixed; boundary="${mixedBoundary}"`,
    "",
    bodyParts.join("\r\n"),
  ].join("\r\n");
}

function buildMimeContent(
  textBody: string,
  htmlBody: string
): { headers: string[]; body: string } {
  if (textBody && htmlBody) {
    const boundary = `apteva_alt_${randomBoundarySuffix()}`;
    return {
      headers: [`Content-Type: multipart/alternative; boundary="${boundary}"`],
      body: [
        `--${boundary}`,
        ...mimeTextPartHeaders("text/plain"),
        "",
        encodeString(textBody, "base64"),
        `--${boundary}`,
        ...mimeTextPartHeaders("text/html"),
        "",
        encodeString(htmlBody, "base64"),
        `--${boundary}--`,
      ].join("\r\n"),
    };
  }

  const contentType = htmlBody ? "text/html" : "text/plain";
  return {
    headers: mimeTextPartHeaders(contentType),
    body: encodeString(htmlBody || textBody, "base64"),
  };
}

function mimeTextPartHeaders(contentType: string): string[] {
  return [
    `Content-Type: ${contentType}; charset=UTF-8`,
    "Content-Transfer-Encoding: base64",
  ];
}

function addHeader(headers: string[], name: string, value: string): void {
  if (value) headers.push(`${name}: ${sanitizeHeaderValue(value)}`);
}

function encodeHeaderValue(value: string): string {
  const sanitized = sanitizeHeaderValue(value);
  if (!/[^\x20-\x7e]/.test(sanitized)) return sanitized;
  return `=?UTF-8?B?${Buffer.from(sanitized, "utf8").toString("base64")}?=`;
}

function sanitizeHeaderValue(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

function formatAddressList(value: unknown): string {
  const values = arrayFromInput(value)
    .map((v) => sanitizeHeaderValue(String(v)))
    .filter(Boolean);
  return values.join(", ");
}

function arrayFromInput(value: unknown): unknown[] {
  if (value === undefined || value === null || value === "") return [];
  if (Array.isArray(value)) return value;
  return String(value)
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function stringValue(value: unknown): string {
  if (value === undefined || value === null) return "";
  return sanitizeHeaderValue(String(value));
}

function bodyValue(value: unknown): string {
  if (value === undefined || value === null) return "";
  return String(value);
}

function parseAttachments(value: unknown): Array<{
  filename: string;
  mimeType: string;
  base64: string;
}> {
  if (!Array.isArray(value)) return [];
  const attachments: Array<{ filename: string; mimeType: string; base64: string }> = [];
  for (const item of value) {
    if (!isPlainObject(item)) continue;
    const filename = sanitizeHeaderValue(String(item.filename || "attachment"));
    const mimeType = sanitizeHeaderValue(
      String(item.mimeType || item.contentType || "application/octet-stream")
    );
    const rawBase64 = stringValue(item.base64);
    const content = item.content === undefined || item.content === null
      ? ""
      : String(item.content);
    const base64 = rawBase64 || Buffer.from(content, "utf8").toString("base64");
    if (base64) attachments.push({ filename, mimeType, base64 });
  }
  return attachments;
}

function encodeString(value: string, encoding: "base64" | "base64url"): string {
  const base64 = Buffer.from(value, "utf8").toString("base64");
  if (encoding === "base64") return wrapBase64(base64);
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeString(value: string, encoding: "base64" | "base64url"): string {
  const normalized =
    encoding === "base64url"
      ? value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=")
      : value;
  return Buffer.from(normalized, "base64").toString("utf8");
}

function wrapBase64(value: string): string {
  const compact = value.replace(/\s+/g, "");
  return compact.match(/.{1,76}/g)?.join("\r\n") || "";
}

function copyIncludedFields(
  body: Record<string, unknown>,
  input: Record<string, unknown>,
  includeFields?: Record<string, string>
): void {
  if (!includeFields) return;
  for (const [source, target] of Object.entries(includeFields)) {
    const value = input[source];
    if (value !== undefined && value !== null && value !== "") {
      setPath(body, target, value);
    }
  }
}

function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split(".").filter(Boolean);
  if (parts.length === 0) return;
  let current: Record<string, unknown> = target;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    const next = current[part];
    if (!isPlainObject(next)) {
      current[part] = {};
    }
    current = current[part] as Record<string, unknown>;
  }
  current[parts[parts.length - 1]] = value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function escapeQuotedParam(value: string): string {
  return sanitizeHeaderValue(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function randomBoundarySuffix(): string {
  return Math.random().toString(36).slice(2, 12);
}

const BINARY_MIME_PREFIXES = [
  "audio/",
  "video/",
  "image/",
  "application/octet-stream",
  "application/pdf",
  "application/zip",
  "application/gzip",
  "application/x-gzip",
  "application/x-tar",
  "application/vnd.openxmlformats",
  "application/vnd.ms-",
  "application/msword",
  "font/",
];

// isBinaryEnvelope returns true if v is the shape the core blob-handle
// rehydrator produces when replacing a blobref:// reference: an object
// with `_binary: true`, `base64: string`, and optional mimeType/size.
// Strings and anything else are rejected — a template that marks a
// field as `body_binary_param` but gets a plain string input falls
// through to the normal JSON body path (no surprises).
function isBinaryEnvelope(v: unknown): boolean {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return o._binary === true && typeof o.base64 === "string";
}

function isBinaryContentType(contentType: string): boolean {
  const ct = contentType.toLowerCase().trim();
  // startsWith is sufficient — every entry in BINARY_MIME_PREFIXES is a
  // real MIME prefix. The previous `|| ct.includes(prefix)` fallback
  // produced false positives on headers that happened to mention a MIME
  // substring in a parameter value.
  return BINARY_MIME_PREFIXES.some((prefix) => ct.startsWith(prefix));
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
