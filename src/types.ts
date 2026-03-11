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
  setup_url?: string; // URL to provider's developer console to create an OAuth app
  setup_steps?: string[]; // Brief setup instructions shown in the UI
}

export interface AppToolTemplate {
  name: string;
  description: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string; // e.g. "/repos/{owner}/{repo}/issues"
  input_schema: Record<string, unknown>;
  response_path?: string; // JSONPath to extract from response
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
