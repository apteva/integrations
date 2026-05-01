import { createHash, createHmac } from "node:crypto";

export interface SignRequestOptions {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string | Buffer | undefined;
  service: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  /** Override the request timestamp; defaults to now. Mostly for tests. */
  now?: Date;
}

/**
 * AWS Signature Version 4 signer for HTTPS REST/JSON endpoints (SES v2,
 * Lambda, DynamoDB, etc.).
 *
 * Returns the headers that must be merged into the outgoing request.
 * The caller is responsible for actually setting them — this function
 * does not mutate `headers` in place.
 *
 * Notes:
 *  - The Host header is included in the canonical request via the URL's
 *    hostname; we do not need to set it on the outgoing fetch (Node /
 *    undici sets it from the URL automatically and that's what the AWS
 *    server validates).
 *  - For S3 the URI canonicalization is different (no double-encoding).
 *    SES, Lambda, DynamoDB, etc. all use the standard form implemented
 *    here; do not reuse this signer for S3.
 */
export function signAwsRequest(opts: SignRequestOptions): Record<string, string> {
  const url = new URL(opts.url);
  const host = url.host;
  const now = opts.now ?? new Date();
  const amzDate = formatAmzDate(now); // YYYYMMDDTHHMMSSZ
  const dateStamp = amzDate.slice(0, 8); // YYYYMMDD

  const bodyBytes =
    opts.body == null
      ? Buffer.alloc(0)
      : typeof opts.body === "string"
        ? Buffer.from(opts.body, "utf8")
        : opts.body;
  const payloadHash = sha256Hex(bodyBytes);

  // Build canonical headers — host, x-amz-date, x-amz-content-sha256,
  // and (if present) x-amz-security-token. We deliberately do not pull
  // arbitrary headers from `opts.headers` into the signed set: keeping
  // the signed-headers list minimal and known avoids drift between what
  // we sign and what fetch actually sends (some headers like
  // Content-Length are added by the runtime).
  const headersToSign: Record<string, string> = {
    host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
  };
  if (opts.sessionToken) {
    headersToSign["x-amz-security-token"] = opts.sessionToken;
  }

  const sortedHeaderNames = Object.keys(headersToSign).sort();
  const canonicalHeaders =
    sortedHeaderNames
      .map((n) => `${n}:${headersToSign[n].trim()}`)
      .join("\n") + "\n";
  const signedHeaders = sortedHeaderNames.join(";");

  const canonicalQueryString = canonicalizeQuery(url.searchParams);
  const canonicalUri = canonicalizePath(url.pathname);

  const canonicalRequest = [
    opts.method.toUpperCase(),
    canonicalUri,
    canonicalQueryString,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const credentialScope = `${dateStamp}/${opts.region}/${opts.service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    sha256Hex(Buffer.from(canonicalRequest, "utf8")),
  ].join("\n");

  const kDate = hmac(`AWS4${opts.secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, opts.region);
  const kService = hmac(kRegion, opts.service);
  const kSigning = hmac(kService, "aws4_request");
  const signature = hmac(kSigning, stringToSign).toString("hex");

  const authorization =
    `AWS4-HMAC-SHA256 Credential=${opts.accessKeyId}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const out: Record<string, string> = {
    "X-Amz-Date": amzDate,
    "X-Amz-Content-Sha256": payloadHash,
    Authorization: authorization,
  };
  if (opts.sessionToken) out["X-Amz-Security-Token"] = opts.sessionToken;
  return out;
}

function sha256Hex(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

function hmac(key: string | Buffer, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

function formatAmzDate(d: Date): string {
  const pad = (n: number) => n.toString().padStart(2, "0");
  return (
    d.getUTCFullYear().toString() +
    pad(d.getUTCMonth() + 1) +
    pad(d.getUTCDate()) +
    "T" +
    pad(d.getUTCHours()) +
    pad(d.getUTCMinutes()) +
    pad(d.getUTCSeconds()) +
    "Z"
  );
}

// SigV4 canonical URI: each segment URI-encoded (RFC 3986). For non-S3
// services AWS expects double-encoding of any already-encoded chars,
// but in practice if the path comes from a literal template and uses
// only safe characters + `/`, single-encoding via encodeURIComponent
// per segment is correct.
function canonicalizePath(pathname: string): string {
  if (!pathname || pathname === "") return "/";
  return pathname
    .split("/")
    .map((seg) => (seg === "" ? "" : encodeRfc3986(seg)))
    .join("/");
}

function canonicalizeQuery(sp: URLSearchParams): string {
  const pairs: [string, string][] = [];
  sp.forEach((v, k) => pairs.push([k, v]));
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : 1));
  return pairs
    .map(([k, v]) => `${encodeRfc3986(k)}=${encodeRfc3986(v)}`)
    .join("&");
}

// encodeURIComponent leaves !'()* unencoded; AWS canonicalization
// requires they be encoded. Patch them up.
function encodeRfc3986(s: string): string {
  return encodeURIComponent(s).replace(
    /[!'()*]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase()
  );
}
