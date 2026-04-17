// ============ App Templates ============

export interface AppTemplate {
  slug: string;
  name: string;
  description: string;
  logo: string | null;
  categories: string[];
  auth: AppAuthConfig;
  base_url: string;
  tools: AppToolTemplate[];
  webhooks?: AppWebhookConfig;
}

export interface AppWebhookConfig {
  signature_header: string; // e.g. "x-hub-signature-256", "stripe-signature"
  events: AppWebhookEvent[];
  registration?: WebhookRegistrationConfig; // How to auto-register webhooks with the external service
}

export interface WebhookRegistrationConfig {
  /** HTTP method for registering webhook */
  method: "POST" | "PUT" | "PATCH";
  /** API path for registering webhook (relative to base_url) */
  path: string;
  /** Field name in request body for the callback URL */
  url_field: string;
  /** Field name for events list (if API supports filtering by event) */
  events_field?: string;
  /** Field name for the webhook secret */
  secret_field?: string;
  /** Static fields always included in registration request */
  extra?: Record<string, unknown>;
  /** Content-Type for registration request (default: "application/json") */
  content_type?: string;
  /** Where to find the webhook ID in the response (dot-notation, e.g. "id" or "result.id") */
  id_field?: string;
  /** HTTP method + path to delete a webhook. {id} placeholder for webhook ID */
  delete_path?: string;
  delete_method?: "DELETE" | "POST";
  /** HTTP method + path to list existing webhooks */
  list_path?: string;
  /** Where to find webhook array in list response (dot-notation) */
  list_field?: string;
  /** Notes for services that can't auto-register (UI-only setup) */
  manual_setup?: string;
}

export interface AppWebhookEvent {
  name: string; // e.g. "push", "payment_intent.succeeded"
  description: string;
}

export interface AppAuthConfig {
  types: AuthType[];
  oauth2?: OAuthConfig;
  headers?: Record<string, string>; // e.g. { "Authorization": "Bearer {{token}}" }
  query_params?: Record<string, string>; // e.g. { "api_key": "{{api_key}}" }
  credential_fields?: CredentialField[]; // Describes what credentials the user must provide
}

export interface CredentialField {
  name: string; // Internal key stored in credentials.fields
  label: string; // Display label
  description?: string; // Help text
  required?: boolean; // Default true
  type?: "password" | "text"; // Default "password"
}

export type AuthType = "api_key" | "bearer" | "basic" | "oauth2";

export interface OAuthConfig {
  authorize_url: string;
  token_url: string;
  scopes: string[];
  client_id_required: boolean;
  pkce: boolean;
  setup_url?: string;        // URL to provider's developer console to create an OAuth app
  setup_steps?: string[];    // Brief setup instructions shown in the UI
  // Extra static query parameters merged into the authorize URL after
  // the standard ones (response_type, client_id, redirect_uri, scope,
  // state, code_challenge*). Required by some providers to actually
  // hand out a refresh_token. Examples:
  //   Google:    { access_type: "offline", prompt: "consent",
  //                include_granted_scopes: "true" }
  //   Microsoft: { prompt: "consent" }
  // Without access_type=offline + prompt=consent on Google, the FIRST
  // authorization yields both access + refresh tokens but every
  // SUBSEQUENT one (after revocation/re-link) yields only an access
  // token — Google only emits the refresh_token on the very first
  // consent and skips the consent screen by default for already-
  // authorized apps.
  extra_authorize_params?: Record<string, string>;
}

export interface AppToolTemplate {
  name: string;
  description: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string; // e.g. "/repos/{owner}/{repo}/issues"
  input_schema: Record<string, unknown>;
  // Names of input fields that should be sent as URL query string
  // parameters instead of being folded into the request body. Required
  // for APIs that mix query+body on POST/PUT/PATCH (e.g. Google Sheets'
  // values:append puts valueInputOption in the URL but the ValueRange in
  // the body). Without this, http-executor sends every non-path field as
  // body content and the API rejects the request.
  query_params?: string[];
  response_path?: string; // JSONPath to extract from response
  // Name of an input field whose value is raw binary (or a core-rehydrated
  // { _binary, base64, mimeType } envelope). When set AND that input is
  // present, http-executor sends the decoded bytes as the HTTP request
  // body with `Content-Type: application/octet-stream` (overridable via
  // the envelope's mimeType), skipping the normal JSON-body serialization
  // path. Used by endpoints like Deepgram's /v1/listen that accept a raw
  // audio payload on the same URL as their JSON variant.
  body_binary_param?: string;
}

// ============ Connections ============

export interface Connection {
  id: string;
  app_slug: string;
  app_name: string;
  name: string;
  auth_type: AuthType;
  credentials: ConnectionCredentials;
  status: "active" | "pending" | "expired" | "error";
  project_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface ConnectionCredentials {
  api_key?: string;
  bearer_token?: string;
  username?: string;
  password?: string;
  // OAuth2 tokens
  access_token?: string;
  refresh_token?: string;
  token_expires_at?: string;
  // OAuth2 client config (stored per-connection for local OAuth)
  client_id?: string;
  client_secret?: string;
  // Arbitrary fields
  fields?: Record<string, string>;
}

// ============ Local Triggers / Webhooks ============

export interface LocalTriggerConfig {
  id: string;
  slug: string;
  name: string;
  description: string;
  agent_id: string;
  webhook_path: string; // unique path: /api/webhooks/local/:id
  hmac_secret: string | null;
  enabled: boolean;
  project_id: string | null;
  created_at: string;
}

// ============ MCP Server Generation ============

export interface GeneratedMcpServer {
  name: string;
  type: "local";
  source: "local-integration";
  tools: GeneratedMcpTool[];
}

export interface GeneratedMcpTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  handler_type: "http";
  http_config: {
    method: string;
    url: string;
    headers: Record<string, string>;
    body_template?: string;
    default_body?: Record<string, string>; // Credential-derived defaults merged into request body
  };
}

// ============ Storage Interface ============
// Apteva core implements this and passes it to the package

export interface IntegrationsStorage {
  // Connections
  createConnection(conn: Omit<Connection, "id" | "created_at" | "updated_at">): Connection;
  getConnection(id: string): Connection | null;
  listConnections(projectId?: string | null): Connection[];
  updateConnection(id: string, updates: Partial<Connection>): Connection | null;
  deleteConnection(id: string): boolean;

  // Credential encryption (delegated to apteva's crypto)
  encrypt(value: string): string;
  decrypt(value: string): string;
}
