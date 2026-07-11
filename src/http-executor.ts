import type {
  AppTemplate,
  AppToolTemplate,
  Connection,
  ConnectionCredentials,
  ResponseTransform,
  RequestTransform,
} from "./types.js";
import { createHash, createHmac, createSign } from "node:crypto";
import { signAwsRequest } from "./aws-sigv4.js";
import { xmlToJson } from "./xml-to-json.js";
import { Agent, ProxyAgent } from "undici";

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
      const value = resolveTemplate(template, credentials);
      if (value) headers[key] = value;
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
  const queryParamAliases = tool.query_param_aliases || {};
  const headerParams = tool.header_params || {};
  for (const [inputName, headerName] of Object.entries(headerParams)) {
    const value = input[inputName];
    if (!headerName || value === undefined || value === null || value === "") continue;
    headers[headerName] = String(value);
  }
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
    if (k in headerParams) continue;
    if (binaryEnvelope && k === binaryParam) continue;
    if (hasRootBody && k === rootParam) continue;
    if (
      transformedBody !== undefined &&
      !declaredQueryParams.includes(k) &&
      !(k in queryParamAliases)
    ) {
      continue;
    }
    if (k in queryParamAliases) {
      const queryName = queryParamAliases[k];
      if (queryName && v !== undefined && v !== null && v !== "") {
        toolQueryParams[queryName] = v;
      }
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
  } else if (tool.multipart_form && tool.method !== "GET") {
    const form = new FormData();
    for (const [k, v] of Object.entries(authBodyParams)) {
      if (v !== undefined && v !== null && v !== "") form.append(k, String(v));
    }
    for (const name of tool.multipart_form.field_names || []) {
      const v = input[name];
      if (v === undefined || v === null || v === "") continue;
      if (tool.multipart_form.repeat_fields?.includes(name) && Array.isArray(v)) {
        for (const item of v) {
          if (item !== undefined && item !== null && item !== "") {
            form.append(name, multipartTextValue(item));
          }
        }
      } else {
        form.append(name, multipartTextValue(v));
      }
    }
    for (const [inputName, formName] of Object.entries(
      tool.multipart_form.file_fields || {}
    )) {
      const v = input[inputName];
      if (v === undefined || v === null || v === "") continue;
      const values = Array.isArray(v) ? v : [v];
      values.forEach((raw, index) => {
        const { data, mimeType } = decodeMultipartFileValue(raw);
        const filename = multipartFilename(
          String(input[`${inputName}_filename`] || ""),
          inputName,
          index,
          values.length
        );
        const bytes = data.buffer.slice(
          data.byteOffset,
          data.byteOffset + data.byteLength
        ) as ArrayBuffer;
        form.append(formName, new Blob([bytes], { type: mimeType }), filename);
      });
    }
    delete headers["Content-Type"];
    delete headers["content-type"];
    fetchOpts.body = form;
    fetchOpts.headers = headers;
  } else if (hasRootBody) {
    // Root-body path: send the named field's value as the whole request
    // body. JSON is the default, but text/* endpoints expect raw strings.
    const contentType = headers["Content-Type"] || headers["content-type"] || "";
    const rootBody = input[rootParam as string];
    fetchOpts.body = contentType.toLowerCase().startsWith("text/")
      ? String(rootBody)
      : JSON.stringify(rootBody);
    if (!contentType) {
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
        fetchOpts.body = buildFormEncodedBody(bodyParams);
      } else {
        fetchOpts.body = JSON.stringify(bodyParams);
      }
    } else {
      const bodyParams = { ...authBodyParams, ...remainingParams };
      const contentType = headers["Content-Type"] || headers["content-type"] || "";
      if (contentType.includes("x-www-form-urlencoded")) {
        fetchOpts.body = buildFormEncodedBody(bodyParams);
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

  const signerSpecs = (tool.signing?.signers?.length ? tool.signing.signers : app.auth.signers) || [];
  for (const spec of signerSpecs) {
    if (spec.name === "doba") {
      signDobaRequest(headers, credentials, spec.params || {});
      fetchOpts.headers = headers;
    } else if (spec.name === "zadarma") {
      const bodyForSigning =
        typeof fetchOpts.body === "string"
          ? fetchOpts.body
          : fetchOpts.body instanceof Buffer
            ? fetchOpts.body.toString("utf8")
            : "";
      signZadarmaRequest(headers, finalUrl, bodyForSigning, credentials, spec.params || {});
      fetchOpts.headers = headers;
    } else if (spec.name === "ghost_admin") {
      signGhostAdminRequest(headers, credentials, spec.params || {});
      fetchOpts.headers = headers;
    } else if (spec.name === "app_store_connect_jwt") {
      signAppStoreConnectRequest(headers, credentials);
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
    applyIntegrationTransport(app, credentials, fetchOpts);
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

function multipartTextValue(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(v);
}

function multipartFilename(
  requested: string,
  fallback: string,
  index: number,
  total: number
): string {
  const filename = requested || fallback;
  if (total <= 1) return filename;
  return `${index + 1}-${filename}`;
}

function decodeMultipartFileValue(raw: unknown): {
  data: Uint8Array;
  mimeType: string;
} {
  if (raw && typeof raw === "object") {
    const record = raw as Record<string, unknown>;
    const base64 = record.base64 || record.data;
    if (typeof base64 === "string") {
      return {
        data: Buffer.from(base64, "base64"),
        mimeType: String(record.mimeType || "application/octet-stream"),
      };
    }
  }
  if (typeof raw === "string") {
    const match = raw.match(/^data:([^;,]+)?(;base64)?,(.*)$/s);
    if (match) {
      const mimeType = match[1] || "application/octet-stream";
      const payload = match[3] || "";
      return {
        data: match[2]
          ? Buffer.from(payload, "base64")
          : Buffer.from(decodeURIComponent(payload)),
        mimeType,
      };
    }
    if (looksLikeBase64(raw)) {
      return {
        data: Buffer.from(raw, "base64"),
        mimeType: "application/octet-stream",
      };
    }
    return {
      data: Buffer.from(raw),
      mimeType: "text/plain",
    };
  }
  return {
    data: Buffer.from(String(raw ?? "")),
    mimeType: "text/plain",
  };
}

function looksLikeBase64(s: string): boolean {
  const compact = s.trim();
  return (
    compact.length > 0 &&
    compact.length % 4 === 0 &&
    /^[A-Za-z0-9+/]+={0,2}$/.test(compact)
  );
}

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

function applyIntegrationTransport(
  app: AppTemplate,
  credentials: ConnectionCredentials,
  fetchOpts: RequestInit
): void {
  const { url: proxy, env } = integrationProxyURL(app);
  if (!proxy) {
    applyMutualTLS(app, credentials, fetchOpts);
    return;
  }
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

function applyMutualTLS(
  app: AppTemplate,
  credentials: ConnectionCredentials,
  fetchOpts: RequestInit
): void {
  if (!app.auth.mtls) return;
  const norm = normalizeCredentials(credentials);
  const certField = app.auth.mtls.cert_field || "client_certificate_pem";
  const keyField = app.auth.mtls.key_field || "client_private_key_pem";
  const cert = normalizePEM(norm[certField]);
  const key = normalizePEM(norm[keyField]);
  if (!cert || !key) return;
  (fetchOpts as RequestInit & { dispatcher?: unknown }).dispatcher = new Agent({
    connect: { cert, key },
  });
}

function normalizePEM(value: string | undefined): string {
  return String(value || "").trim().replace(/\\n/g, "\n");
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
      const value = resolveTemplate(template, credentials);
      if (value) params[key] = value;
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
      const value = resolveTemplate(template, credentials);
      if (value) headers[key] = value;
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
  if (!out.basic_auth) {
    const pair = basicAuthPair(out);
    if (pair) {
      out.basic_auth = Buffer.from(`${pair.user}:${pair.pass}`, "utf8").toString("base64");
    }
  }
  return out;
}

function basicAuthPair(c: Record<string, string>): { user: string; pass: string } | null {
  const pairs: Array<[string, string]> = [
    ["username", "password"],
    ["login", "password"],
    ["account_sid", "auth_token"],
    ["api_key", "api_secret"],
  ];
  for (const [userKey, passKey] of pairs) {
    const user = c[userKey];
    const pass = c[passKey];
    if (user && pass) return { user, pass };
  }
  if (c.api_key) return { user: c.api_key, pass: "" };
  return null;
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

function signDobaRequest(
  headers: Record<string, string>,
  credentials: ConnectionCredentials,
  params: Record<string, unknown>
): void {
  const norm = normalizeCredentials(credentials);
  const appKeyField = String(params.app_key_field || "app_key");
  const privateKeyField = String(params.private_key_field || "private_key");
  const signType = String(params.sign_type || norm.sign_type || "rsa2");
  const timestampUnit = String(params.timestamp_unit || "ms");
  const appKey = norm[appKeyField] || norm.appKey;
  const privateKey = norm[privateKeyField] || norm.privateKey;
  if (!appKey || !privateKey) return;

  const now = Date.now();
  const timestamp = timestampUnit === "s"
    ? String(Math.floor(now / 1000))
    : String(now);
  const canonical = `appKey=${appKey}&signType=${signType}&timestamp=${timestamp}`;
  const signer = createSign("RSA-SHA256");
  signer.update(canonical);
  signer.end();
  const sign = signer.sign(normalizePrivateKeyPem(privateKey), "base64");

  headers[String(params.app_key_header || "appKey")] = appKey;
  headers[String(params.sign_type_header || "signType")] = signType;
  headers[String(params.timestamp_header || "timestamp")] = timestamp;
  headers[String(params.signature_header || "sign")] = sign;
}

function signZadarmaRequest(
  headers: Record<string, string>,
  finalUrl: string,
  body: string,
  credentials: ConnectionCredentials,
  params: Record<string, unknown>
): void {
  const norm = normalizeCredentials(credentials);
  const keyField = String(params.key_field || "api_key");
  const secretField = String(params.secret_field || "api_secret");
  const key = norm[keyField];
  const secret = norm[secretField];
  if (!key || !secret) return;

  const url = new URL(finalUrl);
  const paramsString = zadarmaCanonicalParams(url.search ? url.search.slice(1) : "", body);
  const paramsHash = createHash("md5").update(paramsString).digest("hex");
  const canonical = `${url.pathname}${paramsString}${paramsHash}`;
  const signature = createHmac("sha1", secret).update(canonical).digest("base64");
  headers.Authorization = `${key}:${signature}`;
}

function signGhostAdminRequest(
  headers: Record<string, string>,
  credentials: ConnectionCredentials,
  params: Record<string, unknown>
): void {
  const norm = normalizeCredentials(credentials);
  const keyField = String(params.key_field || "admin_api_key");
  const adminKey = norm[keyField];
  if (!adminKey || !adminKey.includes(":")) return;
  const [id, secret] = adminKey.split(":", 2);
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "HS256", typ: "JWT", kid: id };
  const payload = { iat: now, exp: now + 300, aud: "/admin/" };
  const unsigned = `${base64Url(JSON.stringify(header))}.${base64Url(JSON.stringify(payload))}`;
  const signature = createHmac("sha256", Buffer.from(secret, "hex")).update(unsigned).digest("base64url");
  headers.Authorization = `Ghost ${unsigned}.${signature}`;
}

function signAppStoreConnectRequest(
  headers: Record<string, string>,
  credentials: ConnectionCredentials
): void {
  const norm = normalizeCredentials(credentials);
  const issuerId = norm.issuer_id;
  const keyId = norm.key_id;
  const privateKey = norm.private_key;
  if (!issuerId || !keyId || !privateKey) return;

  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "ES256", kid: keyId, typ: "JWT" };
  const payload = {
    iss: issuerId,
    iat: now,
    exp: now + 1190,
    aud: "appstoreconnect-v1",
  };
  const unsigned = `${base64Url(JSON.stringify(header))}.${base64Url(JSON.stringify(payload))}`;
  const signature = createSign("SHA256")
    .update(unsigned)
    .end()
    .sign({
      key: privateKey.trim().replace(/\\n/g, "\n"),
      dsaEncoding: "ieee-p1363",
    })
    .toString("base64url");
  headers.Authorization = `Bearer ${unsigned}.${signature}`;
}

function base64Url(value: string): string {
  return Buffer.from(value).toString("base64url");
}

function zadarmaCanonicalParams(rawQuery: string, rawBody: string): string {
  const params = new URLSearchParams();
  for (const raw of [rawQuery, rawBody]) {
    if (!raw) continue;
    const parsed = new URLSearchParams(raw);
    for (const [key, value] of parsed.entries()) {
      params.append(key, value);
    }
  }
  params.sort();
  return params.toString();
}

function normalizePrivateKeyPem(privateKey: string): string {
  const trimmed = privateKey.trim();
  if (trimmed.includes("BEGIN ")) return trimmed;
  const wrapped = trimmed.replace(/\s+/g, "").match(/.{1,64}/g)?.join("\n") || trimmed;
  return `-----BEGIN PRIVATE KEY-----\n${wrapped}\n-----END PRIVATE KEY-----`;
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

function buildFormEncodedBody(params: Record<string, unknown>): string {
  const pairs: Array<[string, string]> = [];
  const keys = Object.keys(params).sort();
  for (const key of keys) {
    appendFormValue(pairs, key, params[key]);
  }
  return pairs
    .map(
      ([key, value]) =>
        `${encodeURIComponent(key)}=${encodeURIComponent(value)}`
    )
    .join("&");
}

function appendFormValue(
  pairs: Array<[string, string]>,
  key: string,
  value: unknown
): void {
  if (value === undefined || value === null || value === "") return;
  if (Array.isArray(value)) {
    if (value.some((item) => isPlainObject(item) || Array.isArray(item))) {
      value.forEach((item, index) => {
        appendFormValue(pairs, `${key}[${index}]`, item);
      });
      return;
    }
    value.forEach((item) => appendFormValue(pairs, key, item));
    return;
  }
  if (isPlainObject(value)) {
    for (const child of Object.keys(value).sort()) {
      appendFormValue(
        pairs,
        `${key}[${child}]`,
        (value as Record<string, unknown>)[child]
      );
    }
    return;
  }
  pairs.push([key, String(value)]);
}

function applyResponseTransform(
  transform: ResponseTransform,
  data: unknown
): unknown {
  switch (transform.type) {
    case "email_message":
      return normalizeEmailMessage(data);
    case "email_thread":
      return normalizeEmailThread(data, transform);
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

function normalizeEmailThread(
  data: unknown,
  transform: Extract<ResponseTransform, { type: "email_thread" }>
): unknown {
  if (!isPlainObject(data)) return data;
  const messages = Array.isArray(data.messages)
    ? data.messages.map((message) => normalizeEmailMessage(message))
    : [];
  const compactMessages = messages
    .map((message) => compactEmailMessage(message))
    .filter((message) => message.id);
  return {
    id: data.id,
    historyId: data.historyId,
    messageCount: messages.length,
    messageIds: compactMessages.map((message) => message.id),
    messages: compactMessages,
  };
}

function compactEmailMessage(data: unknown): Record<string, unknown> {
  if (!isPlainObject(data)) return {};
  return {
    id: data.id,
    threadId: data.threadId,
    labelIds: data.labelIds,
    historyId: data.historyId,
    snippet: data.snippet,
    sizeEstimate: data.sizeEstimate,
    internalDate: data.internalDate,
    receivedAt: data.receivedAt,
    from: data.from,
    to: data.to,
    cc: data.cc,
    bcc: data.bcc,
    subject: data.subject,
    date: data.date,
    messageId: data.messageId,
    inReplyTo: data.inReplyTo,
    references: data.references,
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
        setPath(body, transform.target, transform.as_array ? [selected] : selected);
      } else {
        Object.assign(body, selected);
      }
      copyIncludedFields(body, input, transform.include_fields);
      return body;
    }
    case "json_api": {
      const data: Record<string, unknown> = { type: transform.resource_type };
      if (transform.id_field) {
        const id = input[transform.id_field];
        if (id !== undefined && id !== null && id !== "") data.id = id;
      }
      const attributes: Record<string, unknown> = {};
      for (const field of transform.attributes || []) {
        const value = input[field];
        if (value !== undefined && value !== null) attributes[field] = value;
      }
      if (Object.keys(attributes).length > 0) data.attributes = attributes;

      const relationships: Record<string, unknown> = {};
      for (const [name, relationship] of Object.entries(transform.relationships || {})) {
        const value = input[relationship.source];
        if (value === undefined || value === null || value === "") continue;
        const linkage = relationship.many
          ? (Array.isArray(value) ? value : [value]).map((id) => ({
              type: relationship.resource_type,
              id: String(id),
            }))
          : { type: relationship.resource_type, id: String(value) };
        relationships[name] = { data: linkage };
      }
      if (Object.keys(relationships).length > 0) data.relationships = relationships;
      return { data };
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
