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
  // Integration kind. Defaults to "rest" when absent (every existing
  // template in the catalog). "remote_mcp" means the vendor hosts an
  // MCP server we proxy to instead of generating a local stdio MCP
  // from the `tools` array — see `mcp` below for the connection
  // details. For remote_mcp apps `tools` MAY be left empty (tools are
  // discovered at connect-time via tools/list against the upstream),
  // but suggested entries can still be declared as documentation.
  kind?: AppKind;
  mcp?: RemoteMcpConfig;
  // Opt-in: declare this app as part of a suite that shares one
  // credential across many sub-apps and (optionally) fans out across
  // projects discovered from an account-wide key. Multiple apps with
  // the same `credential_group.id` share a single encrypted credential
  // stored on a master `connections` row; child rows point at the
  // master via `_master_id` in their JSON blob. Leave unset for
  // standalone apps — existing behavior is unchanged.
  credential_group?: CredentialGroup;
  // Scope variants for the app's credentials. When present, takes
  // precedence over `auth.credential_fields` + `auth.headers` for
  // connection creation. An app may expose both `account` (master key
  // that discovers + fans out to projects) and `project` (single
  // project-bound key) or just one. When absent, `auth` is used
  // unchanged — that's the legacy single-key path.
  scopes?: AppScopes;
  // Optional UI components an integration can render in the chat
  // panel. Mirrors apps' `provides.ui_components` — each entry maps
  // to a built React module under integrations/dist/ui/<slug>/<file>
  // and is advertised to the agent by the channels MCP. Components
  // appear in chat when the agent calls
  // respond(components=[{ app: "<slug>", name: "<component-name>", props:{…}}]).
  ui_components?: UIComponent[];
}

// ============ UI Components (chat-attachment cards) ============

export interface UIComponent {
  /** Stable name used by the agent in respond(components=[…]). */
  name: string;
  /** Built module path under /api/integrations/<slug>/<entry>. */
  entry: string;
  /** Render slots this component opts into. The chat MCP filters
   *  the AVAILABLE COMPONENTS catalog by the chat.message_attachment
   *  slot before showing it to the agent. */
  slots?: string[];
  /** JSON-Schema-shaped props contract. Required key list +
   *  property types are surfaced in the agent-facing description. */
  props_schema?: {
    type?: "object";
    required?: string[];
    properties?: Record<string, { type?: string; description?: string }>;
  };
  /** Soft preview convention: when the dashboard's app-detail panel
   *  mounts this component for visual preview, it spreads these
   *  props. The component decides what synthetic state to render —
   *  typically a `preview: true` boolean flag. */
  preview_props?: Record<string, unknown>;
}

// ============ Remote MCP (vendor-hosted MCP servers) ============

/**
 * "rest" — legacy + default: tools are HTTP endpoints we call directly,
 *           a local stdio MCP is generated per connection from `tools`.
 * "remote_mcp" — vendor hosts an MCP server. After OAuth, we register
 *           the vendor's URL with the instance's MCP gateway and proxy
 *           tool calls through. The agent sees the vendor's tool list
 *           verbatim, no local generation.
 */
export type AppKind = "rest" | "remote_mcp";

export interface RemoteMcpConfig {
  /** Wire format the vendor's MCP server speaks. */
  transport: "http" | "sse";
  /** Fully-qualified URL of the vendor's MCP endpoint. */
  url: string;
  /**
   * Header name + template used to authenticate every MCP call to the
   * upstream. Defaults to `Authorization: Bearer {{token}}` when
   * absent. Same {{credential.X}}/{{token}}/{{api_key}} resolution as
   * AppAuthConfig.headers.
   */
  auth_header?: { name: string; value: string };
}

// ============ Credential groups (suites) ============

export interface CredentialGroup {
  /** Stable key used as the master connection's app_slug (prefixed with `_group:`). */
  id: string;
  /** Display name of the suite (e.g. "OmniKit", "SocialCast"). */
  name: string;
  /** Logo for the collapsed suite card in the catalog. */
  logo?: string | null;
  /** Marketing description shown on the connect screen. */
  description?: string;
  /**
   * How to enumerate child projects from an account-wide credential.
   * Called once at connect time and on explicit refresh; never during
   * normal tool execution. All fields inherit from the owning
   * AppTemplate when omitted (base_url, auth.headers).
   */
  discovery?: GroupDiscoveryConfig;
}

export interface GroupDiscoveryConfig {
  list_projects: DiscoveryCall;
}

export interface DiscoveryCall {
  method: "GET" | "POST";
  /** Path relative to base_url (or the owning app's base_url). */
  path: string;
  /** Optional override of the app's base_url. */
  base_url?: string;
  /** Dot/[] path into the JSON response where the project array lives. */
  response_path?: string;
  /** Field on each project object that is its external id. */
  id_field: string;
  /** Field on each project object that is its human label. */
  label_field: string;
}

export interface AppScopes {
  /** Account-wide key that can see multiple projects. */
  account?: AppScope;
  /** Single-project key — legacy-equivalent shape. */
  project?: AppScope;
}

export interface AppScope {
  credential_fields: CredentialField[];
  /** Auth headers for this scope; overrides AppAuthConfig.headers. */
  auth_headers?: Record<string, string>;
  /** Auth query params for this scope; overrides AppAuthConfig.query_params. */
  auth_query?: Record<string, string>;
  /** How a child project_id is injected into each request (account scope only). */
  project_binding?: ProjectBinding;
}

export interface ProjectBinding {
  type: "header" | "path_prefix" | "path_param";
  /** Header name for `header`, path segment template for `path_prefix`, input field name for `path_param`. */
  name: string;
  /** Value template, e.g. "{{project_id}}". Resolved against the child connection metadata. */
  value: string;
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
  aws_sigv4?: AwsSigv4Config;
  headers?: Record<string, string>; // e.g. { "Authorization": "Bearer {{token}}" }
  query_params?: Record<string, string>; // e.g. { "api_key": "{{api_key}}" }
  credential_fields?: CredentialField[]; // Describes what credentials the user must provide
}

export interface AwsSigv4Config {
  /** AWS service name used in the credential scope (e.g. "ses", "lambda", "dynamodb"). */
  service: string;
}

export interface CredentialField {
  name: string; // Internal key stored in credentials.fields
  label: string; // Display label
  description?: string; // Help text
  required?: boolean; // Default true
  type?: "password" | "text"; // Default "password"
}

export type AuthType = "api_key" | "bearer" | "basic" | "oauth2" | "aws_sigv4";

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
  // Override the default 30s HTTP timeout for this tool's upstream call.
  // Capped server-side at 600s. Use for tools that legitimately take
  // longer than 30s (image generation, video generation, long-audio
  // transcription, etc).
  timeout_ms?: number;
  // Dot-separated paths in the JSON response to strip before the
  // agent sees the payload. Use `[]` to step into every element of
  // an array (e.g. "results.channels[].alternatives[].words"). Runs
  // after response_path so paths are relative to the already-extracted
  // subtree. Unmatched paths are silent no-ops, so minor schema drift
  // won't break the tool. Use this to prune metadata-heavy responses
  // (per-word timestamps, re-serialised transcripts, diagnostic info)
  // that would otherwise blow the agent's context window.
  response_omit?: string[];
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
  /** "local" — tools were generated from a REST template. "remote" —
   * vendor hosts the MCP, see `remote` for the upstream URL + headers. */
  type: "local" | "remote";
  source: "local-integration" | "remote-integration";
  /** Generated tools. Always set for "local". For "remote" left empty
   * (the upstream's tools/list is the source of truth). */
  tools: GeneratedMcpTool[];
  /** Present only when `type === "remote"`. */
  remote?: GeneratedRemoteMcp;
}

export interface GeneratedRemoteMcp {
  transport: "http" | "sse";
  url: string;
  /** Resolved auth headers (credentials already substituted). */
  headers: Record<string, string>;
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
