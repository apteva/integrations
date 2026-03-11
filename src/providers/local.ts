import type {
  AppTemplate,
  Connection,
  ConnectionCredentials,
  GeneratedMcpServer,
  IntegrationsStorage,
} from "../types.js";
import { getAppTemplate, listApps, loadAppTemplates } from "../apps/index.js";
import { executeTool } from "../http-executor.js";
import { generateMcpServer } from "../mcp-generator.js";
import {
  getAuthorizationUrl,
  exchangeCode,
  refreshAccessToken,
  tokensToCredentials,
  isTokenExpired,
} from "../oauth.js";

export interface LocalProviderConfig {
  storage: IntegrationsStorage;
  oauthRedirectUri?: string;
}

/**
 * LocalIntegrationProvider manages connections and tool execution
 * entirely locally — no external integration cloud needed.
 */
export class LocalIntegrationProvider {
  private storage: IntegrationsStorage;
  private oauthRedirectUri: string;

  constructor(config: LocalProviderConfig) {
    this.storage = config.storage;
    this.oauthRedirectUri = config.oauthRedirectUri || "http://localhost:3000/api/integrations/oauth/callback";
  }

  // ─── App Discovery ───

  listApps() {
    return listApps();
  }

  getApp(slug: string): AppTemplate | undefined {
    return getAppTemplate(slug);
  }

  listAppSlugs(): string[] {
    return Array.from(loadAppTemplates().keys());
  }

  // ─── Connection Management ───

  createConnection(opts: {
    appSlug: string;
    name: string;
    authType: Connection["auth_type"];
    credentials: ConnectionCredentials;
    projectId?: string | null;
  }): Connection {
    const app = getAppTemplate(opts.appSlug);
    if (!app) throw new Error(`Unknown app: ${opts.appSlug}`);

    // Encrypt sensitive credential fields
    const encrypted = this.encryptCredentials(opts.credentials);

    return this.storage.createConnection({
      app_slug: opts.appSlug,
      app_name: app.name,
      name: opts.name,
      auth_type: opts.authType,
      credentials: encrypted,
      status: "active",
      project_id: opts.projectId ?? null,
    });
  }

  getConnection(id: string): Connection | null {
    const conn = this.storage.getConnection(id);
    if (!conn) return null;
    // Decrypt credentials on read
    conn.credentials = this.decryptCredentials(conn.credentials);
    return conn;
  }

  listConnections(projectId?: string | null): Connection[] {
    return this.storage.listConnections(projectId);
  }

  deleteConnection(id: string): boolean {
    return this.storage.deleteConnection(id);
  }

  // ─── OAuth Flow ───

  startOAuth(appSlug: string, opts?: { clientId?: string; state?: string; scopes?: string[] }): string {
    const app = getAppTemplate(appSlug);
    if (!app) throw new Error(`Unknown app: ${appSlug}`);
    if (!app.auth.oauth2) throw new Error(`App "${appSlug}" does not support OAuth2`);

    const clientId = opts?.clientId;
    if (!clientId) throw new Error("Client ID is required for OAuth2");

    return getAuthorizationUrl({
      app,
      clientId,
      redirectUri: this.oauthRedirectUri,
      state: opts?.state,
      scopes: opts?.scopes,
    });
  }

  async handleOAuthCallback(
    appSlug: string,
    code: string,
    opts: { clientId: string; clientSecret: string; connectionName?: string; projectId?: string | null }
  ): Promise<Connection> {
    const app = getAppTemplate(appSlug);
    if (!app) throw new Error(`Unknown app: ${appSlug}`);

    const tokens = await exchangeCode({
      app,
      clientId: opts.clientId,
      clientSecret: opts.clientSecret,
      redirectUri: this.oauthRedirectUri,
      code,
    });

    const credentials = tokensToCredentials(tokens, opts.clientId, opts.clientSecret) as ConnectionCredentials;

    return this.createConnection({
      appSlug,
      name: opts.connectionName || `${app.name} Connection`,
      authType: "oauth2",
      credentials,
      projectId: opts.projectId,
    });
  }

  // ─── Token Refresh ───

  async refreshConnectionIfNeeded(connectionId: string): Promise<Connection | null> {
    const conn = this.getConnection(connectionId);
    if (!conn) return null;

    if (!isTokenExpired(conn.credentials)) return conn;
    if (!conn.credentials.refresh_token) return conn;

    const app = getAppTemplate(conn.app_slug);
    if (!app || !app.auth.oauth2) return conn;

    try {
      const tokens = await refreshAccessToken({
        app,
        clientId: conn.credentials.client_id || "",
        clientSecret: conn.credentials.client_secret || "",
        refreshToken: conn.credentials.refresh_token,
      });

      const newCreds = tokensToCredentials(tokens);
      const updatedCreds: ConnectionCredentials = {
        ...conn.credentials,
        ...newCreds,
      };

      this.storage.updateConnection(connectionId, {
        credentials: this.encryptCredentials(updatedCreds),
        status: "active",
      });

      conn.credentials = updatedCreds;
      return conn;
    } catch (error) {
      this.storage.updateConnection(connectionId, { status: "expired" });
      return conn;
    }
  }

  // ─── Tool Execution ───

  async executeTool(
    connectionId: string,
    toolName: string,
    input: Record<string, unknown>
  ): Promise<{ success: boolean; status: number; data: unknown }> {
    // Auto-refresh token if needed
    const conn = await this.refreshConnectionIfNeeded(connectionId);
    if (!conn) throw new Error(`Connection not found: ${connectionId}`);

    const app = getAppTemplate(conn.app_slug);
    if (!app) throw new Error(`App not found: ${conn.app_slug}`);

    const tool = app.tools.find((t) => t.name === toolName);
    if (!tool) throw new Error(`Tool "${toolName}" not found in app "${app.slug}"`);

    return executeTool({
      app,
      tool,
      credentials: conn.credentials,
      input,
    });
  }

  // ─── MCP Server Generation ───

  generateMcpServer(connectionId: string): GeneratedMcpServer | null {
    const conn = this.getConnection(connectionId);
    if (!conn) return null;

    const app = getAppTemplate(conn.app_slug);
    if (!app) return null;

    return generateMcpServer(conn, app);
  }

  generateAllMcpServers(projectId?: string | null): GeneratedMcpServer[] {
    const connections = this.listConnections(projectId);
    const servers: GeneratedMcpServer[] = [];

    for (const conn of connections) {
      const app = getAppTemplate(conn.app_slug);
      if (!app) continue;
      // Decrypt for server generation
      const decrypted = this.getConnection(conn.id);
      if (!decrypted) continue;
      servers.push(generateMcpServer(decrypted, app));
    }

    return servers;
  }

  // ─── Credential Encryption ───

  private encryptCredentials(creds: ConnectionCredentials): ConnectionCredentials {
    const encrypted = { ...creds };
    if (encrypted.api_key) encrypted.api_key = this.storage.encrypt(encrypted.api_key);
    if (encrypted.bearer_token) encrypted.bearer_token = this.storage.encrypt(encrypted.bearer_token);
    if (encrypted.password) encrypted.password = this.storage.encrypt(encrypted.password);
    if (encrypted.access_token) encrypted.access_token = this.storage.encrypt(encrypted.access_token);
    if (encrypted.refresh_token) encrypted.refresh_token = this.storage.encrypt(encrypted.refresh_token);
    if (encrypted.client_secret) encrypted.client_secret = this.storage.encrypt(encrypted.client_secret);
    return encrypted;
  }

  private decryptCredentials(creds: ConnectionCredentials): ConnectionCredentials {
    const decrypted = { ...creds };
    if (decrypted.api_key) decrypted.api_key = this.storage.decrypt(decrypted.api_key);
    if (decrypted.bearer_token) decrypted.bearer_token = this.storage.decrypt(decrypted.bearer_token);
    if (decrypted.password) decrypted.password = this.storage.decrypt(decrypted.password);
    if (decrypted.access_token) decrypted.access_token = this.storage.decrypt(decrypted.access_token);
    if (decrypted.refresh_token) decrypted.refresh_token = this.storage.decrypt(decrypted.refresh_token);
    if (decrypted.client_secret) decrypted.client_secret = this.storage.decrypt(decrypted.client_secret);
    return decrypted;
  }
}
