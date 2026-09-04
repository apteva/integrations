import type {
  AppTemplate,
  AppToolTemplate,
  Connection,
  ConnectionCredentials,
  HeaderTransform,
  ResponseError,
  ResponseTransform,
  RequestTransform,
} from "./types.js";
import { createHash, createHmac, createSign, randomBytes } from "node:crypto";
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
  /** Internal retry guard for short-lived credential exchanges. */
  credentialTokenRetried?: boolean;
  /** Internal count for bounded retries declared by tool.rate_limit. */
  rateLimitRetries?: number;
}

const DEFAULT_MAX_BINARY_BYTES = 25 * 1024 * 1024;
const MAX_RATE_LIMIT_RETRIES = 3;
const MAX_RATE_LIMIT_INTERVAL_MS = 60_000;
const toolRateLimitQueues = new Map<string, Promise<void>>();
const toolRateLimitLastStart = new Map<string, number>();

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
    credentialTokenRetried = false,
    rateLimitRetries = 0,
  } = opts;

  applyCredentialDefaults(app, credentials);
  await ensureCredentialToken(app, credentials);

  // 1. Build the URL with path parameter + credential interpolation
  const url = buildUrl(tool.base_url || app.base_url, tool.path, input, credentials);
  const continuationParam = tool.continuation_url_param;
  const continuationUrl = continuationParam
    ? String(input[continuationParam] || "").trim()
    : "";

  // 2. Build headers from app auth config + credentials
  const headers = buildHeaders(app, credentials);
  for (const omitted of tool.omit_auth_headers || []) {
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === omitted.toLowerCase()) delete headers[key];
    }
  }
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
  const localHeaderTransformParams = headerTransformLocalParams(tool.header_transforms);
  const localResponseParams = responseTransformLocalParams(tool.response_transform);
  for (const [inputName, headerName] of Object.entries(headerParams)) {
    const value = input[inputName];
    if (!headerName || value === undefined || value === null || value === "") continue;
    headers[headerName] = String(value);
  }
  applyHeaderTransforms(tool.header_transforms, input, headers);
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
    if (continuationUrl) continue;
    if (continuationParam && k === continuationParam) continue;
    if (pathParams.includes(k)) continue;
    if (k in headerParams) continue;
    if (localHeaderTransformParams.has(k)) continue;
    if (localResponseParams.has(k)) continue;
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

  let finalUrl = continuationUrl
    ? validateContinuationUrl(continuationUrl, tool.base_url || app.base_url, credentials)
    : url;
  const allQueryParams = continuationUrl
    ? {}
    : { ...authQueryParams, ...toolQueryParams };

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
          multipartRequestedFilename(input, inputName),
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
  } else if (tool.body_none) {
    // Intentionally empty. This must run before root/transformed/default body
    // handling so signed endpoints hash the true zero-byte payload.
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

  const signerSpecs = tool.signing
    ? (tool.signing.signers || [])
    : (app.auth.signers || []);
  for (const spec of signerSpecs) {
    if (spec.name === "aws_sigv4") {
      const params = spec.params || {};
      const norm = normalizeCredentials(credentials);
      const accessKeyField = String(params.access_key_field || "access_key_id");
      const secretKeyField = String(params.secret_key_field || "secret_access_key");
      const sessionTokenField = String(params.session_token_field || "session_token");
      const regionField = String(params.region_field || "region");
      const regionInput = String(params.region_input || "");
      const accessKeyInput = String(params.access_key_input || "");
      const secretKeyInput = String(params.secret_key_input || "");
      const service = String(params.service || "");
      const accessKeyId = accessKeyInput ? String(input[accessKeyInput] || "") : norm[accessKeyField];
      const secretAccessKey = secretKeyInput ? String(input[secretKeyInput] || "") : norm[secretKeyField];
      const region = regionInput ? String(input[regionInput] || "") : norm[regionField];
      const sessionToken = norm[sessionTokenField];
      if (!service || !accessKeyId || !secretAccessKey || !region) {
        throw new Error(`aws_sigv4 signer for ${tool.name} is missing service, access key, secret key, or region`);
      }
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
        service,
        region,
        accessKeyId,
        secretAccessKey,
        sessionToken,
      });
      delete headers["Authorization"];
      delete headers["authorization"];
      Object.assign(headers, sigHeaders);
      fetchOpts.headers = headers;
    } else if (spec.name === "oauth1") {
      const bodyForSigning = typeof fetchOpts.body === "string" ? fetchOpts.body : "";
      signOAuth1Request(headers, finalUrl, tool.method, bodyForSigning, credentials, spec.params || {});
      fetchOpts.headers = headers;
    } else if (spec.name === "doba") {
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
    } else if (spec.name === "apns_jwt") {
      finalUrl = signAPNsRequest(headers, finalUrl, credentials);
      fetchOpts.headers = headers;
    } else if (spec.name === "vonage_jwt") {
      signVonageRequest(headers, credentials);
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
    await waitForToolRateLimit(app, tool, credentials);
    applyIntegrationTransport(app, credentials, fetchOpts);
    const response = await fetch(finalUrl, fetchOpts);
    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((v, k) => {
      responseHeaders[k] = v;
    });

    let data: unknown;
    const ct = response.headers.get("content-type") || "";
    let isBinary = false;
    if (isJsonContentType(ct)) {
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

    const rateLimitMatch = matchesToolRateLimitRetry(tool, response.status, data);
    if (rateLimitMatch) {
      const maxRetries = Math.min(
        Math.max(0, tool.rate_limit?.max_retries ?? 0),
        MAX_RATE_LIMIT_RETRIES,
      );
      if (rateLimitRetries < maxRetries) {
        return executeTool({
          ...opts,
          credentialTokenRetried,
          rateLimitRetries: rateLimitRetries + 1,
        });
      }
      // CJ and some other APIs report throttling as HTTP 200 with a
      // provider-level error code. Never expose that envelope as success
      // merely because the transport status was successful.
      if (response.ok) {
        return {
          success: false,
          status: response.status,
          data,
          headers: responseHeaders,
        };
      }
    }

    // Response shaping is only valid for successful provider payloads.
    // Applying a success transform to an error object can erase the actual
    // error (for example Gmail's NOT_FOUND became an empty thread).
    if (!response.ok) {
      if (
        response.status === 401 &&
        app.auth.token_exchange &&
        !credentialTokenRetried
      ) {
        await ensureCredentialToken(app, credentials, true);
        return executeTool({ ...opts, credentialTokenRetried: true });
      }
      return {
        success: false,
        status: response.status,
        data: normalizeIntegrationHttpError(response.status, data),
        headers: responseHeaders,
      };
    }

    // GraphQL and similar protocols can carry operation failures in a
    // successful HTTP response. Detect those before response_path removes the
    // error fields from the envelope.
    if (tool.response_error && !isBinary) {
      const inspected = inspectResponseError(tool.response_error, data);
      if (inspected.contractDetail) {
        return responseContractFailure(
          response.status,
          responseHeaders,
          inspected.contractDetail,
        );
      }
      if (inspected.errorData) {
        return {
          success: false,
          status: response.status,
          data: inspected.errorData,
          headers: responseHeaders,
        };
      }
    }

    // Apply response_path extraction if defined — but skip for binary
    // envelopes. extractPath would walk into { _binary, base64, ... }
    // looking for the template's path (e.g. "data") and silently return
    // undefined, destroying the payload.
    const responsePath = tool.response_path?.trim();
    if (responsePath && !isBinary) {
      if (!isPlainObject(data)) {
        return responseContractFailure(
          response.status,
          responseHeaders,
          `Expected a JSON object containing response_path ${responsePath}`,
        );
      }
      const extracted = extractPath(data, responsePath);
      if (extracted === undefined || extracted === null) {
        return responseContractFailure(
          response.status,
          responseHeaders,
          `Missing response_path ${responsePath}`,
        );
      }
      data = extracted;
    }

    if (tool.response_transform && data && !isBinary) {
      data = applyResponseTransform(tool.response_transform, data, input);
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

function applyCredentialDefaults(
  app: AppTemplate,
  credentials: ConnectionCredentials,
): void {
  for (const field of app.auth.credential_fields || []) {
    if (!field.default) continue;
    credentials.fields ||= {};
    if (!credentials.fields[field.name]?.trim()) {
      credentials.fields[field.name] = field.default;
    }
  }
}

function validateContinuationUrl(
  continuationUrl: string,
  baseUrl: string,
  credentials: ConnectionCredentials
): string {
  let candidate: URL;
  let base: URL;
  try {
    candidate = new URL(continuationUrl);
    base = new URL(resolveTemplate(baseUrl, credentials));
  } catch {
    throw new Error("continuation URL must be absolute");
  }
  if (
    (candidate.protocol !== "https:" && candidate.protocol !== "http:") ||
    candidate.protocol !== base.protocol ||
    candidate.host !== base.host
  ) {
    throw new Error("continuation URL must use the integration API origin");
  }
  return candidate.toString();
}

export function signOAuth1Request(
  headers: Record<string, string>,
  rawUrl: string,
  method: string,
  body: string,
  credentials: ConnectionCredentials,
  params: Record<string, unknown> = {},
  fixed?: { nonce?: string; timestamp?: string },
): void {
  const norm = normalizeCredentials(credentials);
  const field = (name: string, fallback: string) =>
    typeof params[name] === "string" && params[name] ? String(params[name]) : fallback;
  const pick = (...keys: string[]) => keys.map((key) => norm[key]).find(Boolean) || "";
  const consumerKey = pick(field("consumer_key_field", "client_id"), "consumer_key", "api_key");
  const consumerSecret = pick(field("consumer_secret_field", "client_secret"), "consumer_secret", "api_secret");
  const token = pick(field("token_field", "oauth_token"), "token");
  const tokenSecret = pick(field("token_secret_field", "oauth_token_secret"), "token_secret");
  if (!consumerKey || !consumerSecret) throw new Error("oauth1: missing consumer key or secret");
  if (!token || !tokenSecret) throw new Error("oauth1: missing access token or token secret");

  const oauth: Record<string, string> = {
    oauth_consumer_key: consumerKey,
    oauth_nonce: fixed?.nonce || randomBytes(16).toString("hex"),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: fixed?.timestamp || Math.floor(Date.now() / 1000).toString(),
    oauth_token: token,
  };
  const url = new URL(rawUrl);
  const pairs: Array<[string, string]> = [];
  url.searchParams.forEach((value, key) => pairs.push([oauth1Escape(key), oauth1Escape(value)]));
  const contentType = headers["Content-Type"] || headers["content-type"] || "";
  if (contentType.toLowerCase().startsWith("application/x-www-form-urlencoded") && body) {
    new URLSearchParams(body).forEach((value, key) => pairs.push([oauth1Escape(key), oauth1Escape(value)]));
  }
  Object.entries(oauth).forEach(([key, value]) => pairs.push([oauth1Escape(key), oauth1Escape(value)]));
  pairs.sort(([ak, av], [bk, bv]) => ak === bk ? av.localeCompare(bv) : ak.localeCompare(bk));
  const normalized = pairs.map(([key, value]) => `${key}=${value}`).join("&");
  url.search = "";
  url.hash = "";
  const base = `${method.toUpperCase()}&${oauth1Escape(url.toString())}&${oauth1Escape(normalized)}`;
  const signingKey = `${oauth1Escape(consumerSecret)}&${oauth1Escape(tokenSecret)}`;
  oauth.oauth_signature = createHmac("sha1", signingKey).update(base).digest("base64");
  headers.Authorization = "OAuth " + Object.keys(oauth).sort()
    .map((key) => `${oauth1Escape(key)}=\"${oauth1Escape(oauth[key])}\"`).join(", ");
}

function oauth1Escape(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) =>
    `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

async function ensureCredentialToken(
  app: AppTemplate,
  credentials: ConnectionCredentials,
  force = false
): Promise<void> {
  const exchange = app.auth.token_exchange;
  if (!exchange) return;

  const expiresAt = credentials.token_expires_at
    ? new Date(credentials.token_expires_at).getTime()
    : 0;
  const skewMs = (exchange.expiry_skew_seconds ?? 60) * 1000;
  if (
    !force &&
    credentials.access_token &&
    Number.isFinite(expiresAt) &&
    expiresAt > Date.now() + skewMs
  ) {
    return;
  }

  const contentType =
    exchange.content_type || "application/x-www-form-urlencoded";
  const headers: Record<string, string> = {
    Accept: "application/json",
    "Content-Type": contentType,
  };
  for (const [key, template] of Object.entries(exchange.headers || {})) {
    const value = resolveTemplate(template, credentials);
    if (value) headers[key] = value;
  }

  const body: Record<string, string> = {};
  for (const [key, template] of Object.entries(exchange.body_params)) {
    const value = resolveTemplate(template, credentials);
    if (value) body[key] = value;
  }
  const encodedBody =
    contentType === "application/json"
      ? JSON.stringify(body)
      : new URLSearchParams(body).toString();

  const exchangeUrl = credentialTokenExchangeUrl(exchange, credentials);
  const response = await fetch(exchangeUrl, {
    method: exchange.method || "POST",
    headers,
    body: encodedBody,
    signal: AbortSignal.timeout(15000),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `credential token exchange failed (${response.status}): ${text}`
    );
  }

  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("credential token exchange returned invalid JSON");
  }
  const accessToken = getPath(
    data,
    exchange.access_token_path || "access_token"
  );
  if (typeof accessToken !== "string" || !accessToken) {
    throw new Error("credential token exchange returned no access token");
  }
  credentials.access_token = accessToken;

  const expiresIn = Number(
    getPath(data, exchange.expires_in_path || "expires_in")
  );
  if (Number.isFinite(expiresIn) && expiresIn > 0) {
    credentials.token_expires_at = new Date(
      Date.now() + expiresIn * 1000
    ).toISOString();
  } else {
    credentials.token_expires_at = new Date(
      Date.now() + 5 * 60 * 1000
    ).toISOString();
  }
}

function credentialTokenExchangeUrl(
  exchange: NonNullable<AppTemplate["auth"]["token_exchange"]>,
  credentials: ConnectionCredentials,
): string {
  const selector = exchange.url_selector;
  if (!selector) return resolveTemplate(exchange.url, credentials);

  const value = normalizeCredentials(credentials)[selector.credential_field]?.trim();
  if (!value) {
    throw new Error(
      `credential token exchange requires ${selector.credential_field}`,
    );
  }
  const selectedUrl = selector.values[value];
  if (!selectedUrl) {
    throw new Error(
      `credential token exchange does not support the supplied ${selector.credential_field}`,
    );
  }
  return resolveTemplate(selectedUrl, credentials);
}

// ─── Helpers ───

function multipartTextValue(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(v);
}

function applyHeaderTransforms(
  transforms: HeaderTransform[] | undefined,
  input: Record<string, unknown>,
  headers: Record<string, string>,
): void {
  for (const transform of transforms || []) {
    if (transform.type !== "byte_range") {
      throw new Error(`unsupported header transform: ${(transform as { type?: string }).type || ""}`);
    }

    const startRaw = input[transform.start_param];
    const endRaw = transform.end_param ? input[transform.end_param] : undefined;
    const hasStart = startRaw !== undefined && startRaw !== null && startRaw !== "";
    const hasEnd = endRaw !== undefined && endRaw !== null && endRaw !== "";
    if (!hasStart && !hasEnd) continue;
    if (!hasStart) {
      throw new Error(`${transform.end_param || "end byte"} requires ${transform.start_param}`);
    }

    const start = nonNegativeInteger(startRaw, transform.start_param);
    let value = `bytes=${start}-`;
    if (hasEnd) {
      const endParam = transform.end_param || "end byte";
      const end = nonNegativeInteger(endRaw, endParam);
      if (end < start) {
        throw new Error(`${endParam} must be greater than or equal to ${transform.start_param}`);
      }
      value += end;
    }
    headers[transform.header || "Range"] = value;
  }
}

function headerTransformLocalParams(
  transforms: HeaderTransform[] | undefined,
): Set<string> {
  const names = new Set<string>();
  for (const transform of transforms || []) {
    if (transform.start_param) names.add(transform.start_param);
    if (transform.end_param) names.add(transform.end_param);
  }
  return names;
}

function nonNegativeInteger(value: unknown, name: string): number {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim() !== ""
        ? Number(value)
        : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return parsed;
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

function multipartRequestedFilename(
  input: Record<string, unknown>,
  inputName: string
): string {
  for (const name of [
    "filename",
    "fileName",
    `${inputName}_filename`,
    `${inputName}Filename`,
    `${inputName}FileName`,
  ]) {
    const value = input[name];
    if (typeof value === "string" && value.trim()) return value;
  }
  return "";
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

  // Replace every input placeholder in one pass. Mutating the string while
  // advancing RegExp.lastIndex can skip later placeholders when an earlier
  // replacement is shorter than "{parameter}".
  const originalResolved = resolved;
  resolved = resolved.replace(/\{(\w+)\}/g, (placeholder, key: string) => {
    const value = input[key];
    if (value === undefined) return placeholder;
    const text = String(value);
    if (originalResolved === placeholder && /^https?:\/\//.test(text)) {
      return text;
    }
    return encodeURIComponent(text);
  });
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
  // structured fields usually live at the top level, while callers may put
  // arbitrary catalog credential fields in `fields`. Local server connection
  // blobs also store catalog-defined fields such as `token` at the top level,
  // so preserve every top-level string instead of silently dropping them.
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(credentials)) {
    if (key !== "fields" && typeof value === "string" && value) {
      out[key] = value;
    }
  }
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
    ["client_id", "client_secret"],
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
  return template.replace(/\{\{(?:credential\.)?(\w+)\}\}/g, (_match, key) => {
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
      key: normalizeAppStoreConnectPrivateKey(privateKey),
      dsaEncoding: "ieee-p1363",
    })
    .toString("base64url");
  headers.Authorization = `Bearer ${unsigned}.${signature}`;
}

function signAPNsRequest(
  headers: Record<string, string>,
  finalUrl: string,
  credentials: ConnectionCredentials
): string {
  const norm = normalizeCredentials(credentials);
  const teamId = norm.team_id;
  const keyId = norm.key_id;
  const privateKey = norm.private_key;
  const topic = headers["apns-topic"] || headers["Apns-Topic"];
  const requestedEnvironment =
    headers["x-apteva-apns-environment"] ||
    headers["X-Apteva-Apns-Environment"] ||
    norm.environment;
  delete headers["x-apteva-apns-environment"];
  delete headers["X-Apteva-Apns-Environment"];
  if (!teamId || !keyId || !privateKey) return finalUrl;
  if (!topic) throw new Error("APNs topic is required");

  const environment = (requestedEnvironment || "production").trim().toLowerCase();
  const url = new URL(finalUrl);
  if (environment === "sandbox") {
    url.protocol = "https:";
    url.host = "api.sandbox.push.apple.com";
  } else if (environment === "production") {
    url.protocol = "https:";
    url.host = "api.push.apple.com";
  } else {
    throw new Error('APNs environment must be "production" or "sandbox"');
  }

  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "ES256", kid: keyId, typ: "JWT" };
  const payload = { iss: teamId, iat: now };
  const unsigned = `${base64Url(JSON.stringify(header))}.${base64Url(JSON.stringify(payload))}`;
  const signature = createSign("SHA256")
    .update(unsigned)
    .end()
    .sign({
      key: normalizeAppStoreConnectPrivateKey(privateKey),
      dsaEncoding: "ieee-p1363",
    })
    .toString("base64url");
  headers.Authorization = `Bearer ${unsigned}.${signature}`;
  return url.toString();
}

function signVonageRequest(
  headers: Record<string, string>,
  credentials: ConnectionCredentials
): void {
  const norm = normalizeCredentials(credentials);
  const applicationId = norm.application_id;
  const privateKey = norm.private_key;
  if (!applicationId || !privateKey) {
    throw new Error("Vonage Voice API requires application_id and private_key");
  }
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    application_id: applicationId,
    iat: now,
    exp: now + 900,
    jti: `apteva-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  };
  const unsigned = `${base64Url(JSON.stringify(header))}.${base64Url(JSON.stringify(payload))}`;
  const signature = createSign("RSA-SHA256")
    .update(unsigned)
    .end()
    .sign(normalizePastedPrivateKey(privateKey))
    .toString("base64url");
  headers.Authorization = `Bearer ${unsigned}.${signature}`;
}

function normalizeAppStoreConnectPrivateKey(raw: string): string {
  const normalized = raw
    .trim()
    .replace(/\\r\\n/g, "\n")
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\n")
    .replace(/\r\n?/g, "\n");
  const begin = "-----BEGIN PRIVATE KEY-----";
  const end = "-----END PRIVATE KEY-----";
  const beginAt = normalized.indexOf(begin);
  const endAt = normalized.indexOf(end);
  if (beginAt < 0 || endAt <= beginAt) return normalized;

  const body = normalized
    .slice(beginAt + begin.length, endAt)
    .replace(/\s+/g, "");
  if (!body) return normalized;
  const lines = body.match(/.{1,64}/g) || [];
  return `${begin}\n${lines.join("\n")}\n${end}\n`;
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

function normalizePastedPrivateKey(raw: string): string {
  const normalized = raw
    .trim()
    .replace(/\\r\\n/g, "\n")
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\n")
    .replace(/\r\n?/g, "\n");
  for (const [begin, end] of [
    ["-----BEGIN PRIVATE KEY-----", "-----END PRIVATE KEY-----"],
    ["-----BEGIN RSA PRIVATE KEY-----", "-----END RSA PRIVATE KEY-----"],
  ]) {
    const beginAt = normalized.indexOf(begin);
    const endAt = normalized.indexOf(end);
    if (beginAt < 0 || endAt <= beginAt) continue;
    const body = normalized
      .slice(beginAt + begin.length, endAt)
      .replace(/\s+/g, "");
    if (!body) return normalized;
    const lines = body.match(/.{1,64}/g)?.join("\n") || body;
    return `${begin}\n${lines}\n${end}\n`;
  }
  return normalized;
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

function toolRateLimitKey(
  app: AppTemplate,
  tool: AppToolTemplate,
  credentials: ConnectionCredentials,
): string {
  const normalized = normalizeCredentials(credentials);
  const identity =
    normalized.api_key ||
    normalized.access_token ||
    normalized.token ||
    normalized.username ||
    "anonymous";
  const credentialHash = createHash("sha256")
    .update(identity)
    .digest("hex")
    .slice(0, 16);
  return `${app.slug}:${tool.name}:${credentialHash}`;
}

async function waitForToolRateLimit(
  app: AppTemplate,
  tool: AppToolTemplate,
  credentials: ConnectionCredentials,
): Promise<void> {
  const configured = Number(tool.rate_limit?.min_interval_ms || 0);
  const interval = Math.min(
    Math.max(0, Number.isFinite(configured) ? configured : 0),
    MAX_RATE_LIMIT_INTERVAL_MS,
  );
  if (interval <= 0) return;

  const key = toolRateLimitKey(app, tool, credentials);
  const previous = toolRateLimitQueues.get(key) || Promise.resolve();
  const queued = previous.catch(() => undefined).then(async () => {
    const delay = Math.max(
      0,
      (toolRateLimitLastStart.get(key) || 0) + interval - Date.now(),
    );
    if (delay > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, delay));
    }
    toolRateLimitLastStart.set(key, Date.now());
  });
  toolRateLimitQueues.set(key, queued);
  try {
    await queued;
  } finally {
    if (toolRateLimitQueues.get(key) === queued) {
      toolRateLimitQueues.delete(key);
    }
  }
}

function matchesToolRateLimitRetry(
  tool: AppToolTemplate,
  status: number,
  data: unknown,
): boolean {
  const policy = tool.rate_limit;
  if (!policy) return false;
  if ((policy.retry_statuses || []).includes(status)) return true;
  if (!data || typeof data !== "object" || Array.isArray(data)) return false;
  const code = (data as Record<string, unknown>).code;
  return (policy.retry_error_codes || []).some(
    (candidate) => String(candidate) === String(code),
  );
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
  data: unknown,
  input: Record<string, unknown> = {}
): unknown {
  switch (transform.type) {
    case "email_message":
      return normalizeEmailMessage(data, transform, input);
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

function normalizeEmailMessage(
  data: unknown,
  transform?: Extract<ResponseTransform, { type: "email_message" }>,
  input: Record<string, unknown> = {}
): unknown {
  if (!isPlainObject(data)) return data;
  const payload = isPlainObject(data.payload) ? data.payload : {};
  const headerPairs = Array.isArray(payload.headers) ? payload.headers : [];
  const headers = headersObject(headerPairs);
  const bodies = collectEmailBodies(payload);
  const internalDate = parseGmailInternalDate(data.internalDate);

  const normalized: Record<string, unknown> = {
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
    attachments: bodies.attachments,
  };
  return selectEmailBodies(normalized, bodies, transform, input);
}

type EmailBodyMode = "compact" | "text" | "html" | "both" | "none";

function responseTransformLocalParams(transform?: ResponseTransform): Set<string> {
  const params = new Set<string>();
  if (transform?.type === "email_message") {
    if (transform.body_mode_param) params.add(transform.body_mode_param);
    if (transform.max_chars_param) params.add(transform.max_chars_param);
  }
  return params;
}

function selectEmailBodies(
  normalized: Record<string, unknown>,
  bodies: ReturnType<typeof collectEmailBodies>,
  transform: Extract<ResponseTransform, { type: "email_message" }> | undefined,
  input: Record<string, unknown>
): Record<string, unknown> {
  const textBody = bodies.text.join("\n\n").trim();
  const htmlBody = bodies.html.join("\n\n").trim();
  const requestedMode = transform?.body_mode_param
    ? String(input[transform.body_mode_param] || "")
    : "";
  const allowedModes = new Set<EmailBodyMode>(["compact", "text", "html", "both", "none"]);
  const configuredMode = transform?.default_body_mode || "both";
  const mode = allowedModes.has(requestedMode as EmailBodyMode)
    ? (requestedMode as EmailBodyMode)
    : configuredMode;
  const configuredLimit = transform?.default_max_chars;
  const requestedLimit = transform?.max_chars_param
    ? Number(input[transform.max_chars_param])
    : Number.NaN;
  let maxChars = Number.isFinite(requestedLimit) && requestedLimit > 0
    ? Math.floor(requestedLimit)
    : configuredLimit;
  if (maxChars !== undefined) {
    maxChars = Math.max(1, Math.floor(maxChars));
    if (transform?.max_chars_limit && transform.max_chars_limit > 0) {
      maxChars = Math.min(maxChars, transform.max_chars_limit);
    }
  }

  const selected: Array<{ key: "body" | "text" | "html"; value: string }> = [];
  if (mode === "compact") {
    selected.push({ key: "body", value: textBody || htmlBody });
    normalized.bodyMimeType = textBody ? "text/plain" : htmlBody ? "text/html" : "";
  } else if (mode === "text") {
    selected.push({ key: "text", value: textBody });
  } else if (mode === "html") {
    selected.push({ key: "html", value: htmlBody });
  } else if (mode === "both") {
    selected.push({ key: "text", value: textBody }, { key: "html", value: htmlBody });
  }

  let remaining = maxChars ?? Number.POSITIVE_INFINITY;
  let returnedChars = 0;
  let selectedChars = 0;
  for (const item of selected) {
    const chars = Array.from(item.value);
    selectedChars += chars.length;
    const value = Number.isFinite(remaining)
      ? chars.slice(0, Math.max(0, remaining)).join("")
      : item.value;
    normalized[item.key] = value;
    const used = Array.from(value).length;
    returnedChars += used;
    remaining -= used;
  }

  normalized.bodyMode = mode;
  normalized.bodyAvailableChars = {
    text: Array.from(textBody).length,
    html: Array.from(htmlBody).length,
  };
  normalized.bodyReturnedChars = returnedChars;
  normalized.bodyTruncated = returnedChars < selectedChars;
  return normalized;
}

function normalizeIntegrationHttpError(status: number, data: unknown): unknown {
  if (status !== 404) return data;
  let providerMessage = "The requested resource was not found.";
  if (isPlainObject(data)) {
    if (typeof data.message === "string" && data.message) providerMessage = data.message;
    if (isPlainObject(data.error) && typeof data.error.message === "string" && data.error.message) {
      providerMessage = data.error.message;
    }
  } else if (typeof data === "string" && data.trim()) {
    providerMessage = data.trim();
  }
  return {
    error: "not_found",
    status,
    retryable: false,
    message: providerMessage,
    instruction: "Do not retry the same resource ID. List or search for the resource again and use a current ID.",
    provider_error: data,
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
      const selected: Record<string, unknown> = { ...(transform.constants || {}) };
      for (const field of transform.fields) {
        const value = input[field];
        if (value !== undefined && value !== null) {
          selected[field] = value;
        }
      }
      if (!transform.target && transform.as_array) {
        return [selected];
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

function isJsonContentType(contentType: string): boolean {
  const mime = contentType.toLowerCase().split(";", 1)[0].trim();
  return mime === "application/json" || mime.endsWith("+json");
}

function responseContractFailure(
  status: number,
  headers: Record<string, string>,
  detail: string,
): ExecuteToolResult {
  return {
    success: false,
    status,
    data: { error: "response contract violation", detail },
    headers,
  };
}

function inspectResponseError(
  definition: ResponseError,
  data: unknown,
): { errorData?: Record<string, unknown>; contractDetail?: string } {
  const responseErrorType = String(definition.type).trim().toLowerCase();
  if (!isPlainObject(data)) {
    return { contractDetail: `Expected a JSON object for response_error type ${responseErrorType}` };
  }

  if (definition.type === "json_status") {
    const codePath = String(definition.code_path || "").trim();
    const successCodes = definition.success_codes || [];
    if (!codePath || successCodes.length === 0) {
      return { contractDetail: "json_status response_error requires code_path and success_codes" };
    }
    const code = getPath(data, codePath);
    if (code === undefined || code === null) {
      return { contractDetail: `Expected response_error code path ${codePath}` };
    }
    const failedFlagPath = (definition.failure_flag_paths || []).find(
      (path) => getPath(data, path) === false,
    );
    const successfulCode = successCodes.some(
      (candidate) => String(candidate) === String(code),
    );
    if (successfulCode && !failedFlagPath) return {};

    const messageValue = definition.message_path
      ? getPath(data, definition.message_path)
      : undefined;
    return {
      errorData: {
        error: "upstream_api_error",
        message:
          typeof messageValue === "string" && messageValue.trim()
            ? messageValue
            : "Upstream API reported an unsuccessful response",
        code,
        ...(failedFlagPath ? { failed_flag: failedFlagPath } : {}),
        provider_error: data,
      },
    };
  }

  if (responseErrorType !== "graphql") {
    return { contractDetail: `Unsupported response_error type ${String(definition.type).trim()}` };
  }

  const paths = definition.paths?.length ? definition.paths : ["errors"];
  const details: unknown[] = [];
  for (const rawPath of paths) {
    const path = rawPath.trim();
    if (!path) continue;
    const value = getPath(data, path);
    if (value === undefined || value === null) continue;
    if (!Array.isArray(value)) {
      return { contractDetail: `Expected response_error path ${path} to contain an array` };
    }
    details.push(...value);
  }
  if (details.length === 0) return {};

  const first = details[0];
  let message = "GraphQL request failed";
  if (isPlainObject(first) && typeof first.message === "string" && first.message.trim()) {
    message = first.message;
  } else if (typeof first === "string" && first.trim()) {
    message = first;
  }
  return {
    errorData: {
      error: "upstream_graphql_error",
      message,
      details,
      partial_data: data.data ?? {},
    },
  };
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
