import type { AppTemplate, ConnectionCredentials } from "./types.js";

export interface OAuthStartOptions {
  app: AppTemplate;
  clientId: string;
  redirectUri: string;
  state?: string;
  scopes?: string[];
}

export interface OAuthCallbackOptions {
  app: AppTemplate;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  code: string;
}

export interface OAuthRefreshOptions {
  app: AppTemplate;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

export interface OAuthTokenResult {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
  scope?: string;
}

/**
 * Generate the OAuth2 authorization URL for a given app.
 */
export function getAuthorizationUrl(opts: OAuthStartOptions): string {
  const oauth = opts.app.auth.oauth2;
  if (!oauth) {
    throw new Error(`App "${opts.app.slug}" does not support OAuth2`);
  }

  const params = new URLSearchParams({
    client_id: opts.clientId,
    redirect_uri: opts.redirectUri,
    response_type: "code",
    scope: (opts.scopes || oauth.scopes).join(" "),
  });

  if (opts.state) {
    params.set("state", opts.state);
  }

  // Merge in provider-specific extras (e.g. Google's access_type=offline
  // + prompt=consent which are required to actually receive a
  // refresh_token on every consent, not just the first one). Standard
  // params above are not allowed to be clobbered — flow-critical fields
  // like response_type and client_id stay locked.
  if (oauth.extra_authorize_params) {
    for (const [k, v] of Object.entries(oauth.extra_authorize_params)) {
      if (!params.has(k)) params.set(k, v);
    }
  }

  // Use the right separator if the authorize_url already has a query
  // string (rare but legal — some templates encode static prefilters
  // there).
  const sep = oauth.authorize_url.includes("? ") ? "&" : "? ";
  return `${oauth.authorize_url}${sep}${params.toString()}`;
}

/**
 * Exchange an authorization code for access/refresh tokens.
 */
export async function exchangeCode(
  opts: OAuthCallbackOptions
): Promise<OAuthTokenResult> {
  const oauth = opts.app.auth.oauth2;
  if (!oauth) {
    throw new Error(`App "${opts.app.slug}" does not support OAuth2`);
  }

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: opts.code,
    redirect_uri: opts.redirectUri,
    client_id: opts.clientId,
    client_secret: opts.clientSecret,
  });

  const response = await fetch(oauth.token_url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: body.toString(),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `OAuth token exchange failed (${response.status}): ${text}`
    );
  }

  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    return (await response.json()) as OAuthTokenResult;
  }

  // Some providers (e.g. GitHub) return form-encoded
  const text = await response.text();
  const params = new URLSearchParams(text);
  return {
    access_token: params.get("access_token") || "",
    refresh_token: params.get("refresh_token") || undefined,
    token_type: params.get("token_type") || undefined,
    scope: params.get("scope") || undefined,
  };
}

/**
 * Refresh an expired access token using a refresh token.
 */
export async function refreshAccessToken(
  opts: OAuthRefreshOptions
): Promise<OAuthTokenResult> {
  const oauth = opts.app.auth.oauth2;
  if (!oauth) {
    throw new Error(`App "${opts.app.slug}" does not support OAuth2`);
  }

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: opts.refreshToken,
    client_id: opts.clientId,
    client_secret: opts.clientSecret,
  });

  const response = await fetch(oauth.token_url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: body.toString(),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `OAuth token refresh failed (${response.status}): ${text}`
    );
  }

  return (await response.json()) as OAuthTokenResult;
}

/**
 * Convert OAuth tokens into ConnectionCredentials format.
 */
export function tokensToCredentials(
  tokens: OAuthTokenResult,
  clientId?: string,
  clientSecret?: string
): Partial<ConnectionCredentials> {
  const creds: Partial<ConnectionCredentials> = {
    access_token: tokens.access_token,
  };
  if (tokens.refresh_token) {
    creds.refresh_token = tokens.refresh_token;
  }
  if (tokens.expires_in) {
    const expiresAt = new Date(Date.now() + tokens.expires_in * 1000);
    creds.token_expires_at = expiresAt.toISOString();
  }
  if (clientId) creds.client_id = clientId;
  if (clientSecret) creds.client_secret = clientSecret;
  return creds;
}

/**
 * Check if a connection's token is expired or about to expire (within 5 min).
 */
export function isTokenExpired(credentials: ConnectionCredentials): boolean {
  if (!credentials.token_expires_at) return false;
  const expiresAt = new Date(credentials.token_expires_at).getTime();
  const buffer = 5 * 60 * 1000; // 5 minutes
  return Date.now() >= expiresAt - buffer;
}
