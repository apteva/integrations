// ─── Types ───
export type {
  AppTemplate,
  AppAuthConfig,
  AuthType,
  OAuthConfig,
  AppToolTemplate,
  Connection,
  ConnectionCredentials,
  LocalTriggerConfig,
  GeneratedMcpServer,
  GeneratedMcpTool,
  IntegrationsStorage,
} from "./types.js";

// ─── App Templates ───
export {
  loadAppTemplates,
  getAppTemplate,
  listAppSlugs,
  listApps,
} from "./apps/index.js";

// ─── HTTP Tool Executor ───
export { executeTool } from "./http-executor.js";
export type { ExecuteToolOptions, ExecuteToolResult } from "./http-executor.js";

// ─── OAuth Engine ───
export {
  getAuthorizationUrl,
  exchangeCode,
  refreshAccessToken,
  tokensToCredentials,
  isTokenExpired,
} from "./oauth.js";
export type {
  OAuthStartOptions,
  OAuthCallbackOptions,
  OAuthRefreshOptions,
  OAuthTokenResult,
} from "./oauth.js";

// ─── MCP Server Generator ───
export { generateMcpServer } from "./mcp-generator.js";

// ─── Local Integration Provider ───
export { LocalIntegrationProvider } from "./providers/local.js";
export type { LocalProviderConfig } from "./providers/local.js";

// ─── Local Trigger Provider ───
export { LocalTriggerProvider } from "./triggers/local.js";
export type { TriggerStorage, WebhookPayload, TriggerResult } from "./triggers/local.js";
