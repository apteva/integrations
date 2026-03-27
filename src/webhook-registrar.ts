/**
 * Webhook Registrar — automatically registers/unregisters webhook endpoints
 * with external services using their APIs.
 *
 * Uses the `webhooks.registration` config from app templates to know
 * which API to call, what fields to send, and how to parse the response.
 */

import type {
  AppTemplate,
  ConnectionCredentials,
  WebhookRegistrationConfig,
} from "./types.js";

export interface RegisterWebhookOptions {
  /** App template with webhook registration config */
  app: AppTemplate;
  /** Decrypted credentials for the connection */
  credentials: ConnectionCredentials;
  /** The callback URL to register (e.g. https://instance/api/webhooks/local) */
  callbackUrl: string;
  /** Event names to subscribe to (from app.webhooks.events[].name) */
  events?: string[];
  /** HMAC secret to send to the service for signing payloads */
  secret?: string;
  /** Request timeout in ms (default 15000) */
  timeout?: number;
}

export interface RegisterWebhookResult {
  success: boolean;
  /** Webhook ID returned by the service (for future deletion) */
  webhookId?: string;
  /** Raw response data */
  data?: unknown;
  /** Error message if failed */
  error?: string;
  /** Whether this service requires manual setup instead */
  manualSetup?: string;
}

export interface UnregisterWebhookOptions {
  app: AppTemplate;
  credentials: ConnectionCredentials;
  webhookId: string;
  timeout?: number;
}

export interface ListWebhooksOptions {
  app: AppTemplate;
  credentials: ConnectionCredentials;
  timeout?: number;
}

export interface ListWebhooksResult {
  success: boolean;
  webhooks?: Array<{ id: string; url?: string; events?: string[]; active?: boolean }>;
  error?: string;
}

/**
 * Check if an app supports automatic webhook registration.
 */
export function canAutoRegister(app: AppTemplate): boolean {
  return !!(app.webhooks?.registration && !app.webhooks.registration.manual_setup);
}

/**
 * Get manual setup instructions if auto-registration isn't supported.
 */
export function getManualSetupInstructions(app: AppTemplate): string | null {
  return app.webhooks?.registration?.manual_setup || null;
}

/**
 * Register a webhook with an external service.
 */
export async function registerWebhook(
  opts: RegisterWebhookOptions,
): Promise<RegisterWebhookResult> {
  const { app, credentials, callbackUrl, events, secret, timeout = 15000 } = opts;

  const reg = app.webhooks?.registration;
  if (!reg) {
    return { success: false, error: "No webhook registration config for this app" };
  }

  if (reg.manual_setup) {
    return { success: false, manualSetup: reg.manual_setup };
  }

  // Build URL
  const url = buildUrl(app.base_url, reg.path, credentials);

  // Build headers
  const headers = buildAuthHeaders(app, credentials);
  const contentType = reg.content_type || "application/json";
  headers["Content-Type"] = contentType;

  // Build request body — supports nested dot-notation fields like "config.url" or "webhook.address"
  const body: Record<string, unknown> = {};

  // Static extra fields first (so specific fields override)
  if (reg.extra) {
    deepMerge(body, reg.extra);
  }

  // Callback URL
  setNestedField(body, reg.url_field, callbackUrl);

  // Events
  if (reg.events_field && events && events.length > 0) {
    setNestedField(body, reg.events_field, events);
  }

  // Secret
  if (reg.secret_field && secret) {
    setNestedField(body, reg.secret_field, secret);
  }

  const serializedBody = contentType.includes("x-www-form-urlencoded")
    ? buildFormBody(flattenForForm(body))
    : JSON.stringify(body);

  console.log(`[webhook-registrar] ──── REGISTER WEBHOOK ────`);
  console.log(`[webhook-registrar] App: ${app.name} (${app.slug})`);
  console.log(`[webhook-registrar] URL: ${reg.method} ${url}`);
  console.log(`[webhook-registrar] Headers:`, JSON.stringify(headers, null, 2));
  console.log(`[webhook-registrar] Body:`, serializedBody);
  console.log(`[webhook-registrar] ──────────────────────────`);

  try {
    const response = await fetch(url, {
      method: reg.method,
      headers,
      body: serializedBody,
      signal: AbortSignal.timeout(timeout),
    });

    let data: unknown;
    const ct = response.headers.get("content-type") || "";
    if (ct.includes("application/json")) {
      data = await response.json();
    } else {
      data = await response.text();
    }

    console.log(`[webhook-registrar] Response: ${response.status} ${response.statusText}`);
    console.log(`[webhook-registrar] Response body:`, typeof data === "string" ? data : JSON.stringify(data, null, 2));

    if (!response.ok) {
      console.error(`[webhook-registrar] FAILED: HTTP ${response.status}`);
      return {
        success: false,
        error: `HTTP ${response.status}: ${typeof data === "string" ? data : JSON.stringify(data)}`,
        data,
      };
    }

    // Extract webhook ID from response
    const webhookId = reg.id_field && data && typeof data === "object"
      ? extractPath(data, reg.id_field)
      : undefined;

    console.log(`[webhook-registrar] SUCCESS: webhookId=${webhookId}`);
    return {
      success: true,
      webhookId: webhookId ? String(webhookId) : undefined,
      data,
    };
  } catch (error) {
    console.error(`[webhook-registrar] EXCEPTION:`, error);
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Unregister (delete) a webhook from an external service.
 */
export async function unregisterWebhook(
  opts: UnregisterWebhookOptions,
): Promise<{ success: boolean; error?: string }> {
  const { app, credentials, webhookId, timeout = 15000 } = opts;

  const reg = app.webhooks?.registration;
  if (!reg?.delete_path) {
    return { success: false, error: "No webhook delete config for this app" };
  }

  const path = reg.delete_path.replace("{id}", encodeURIComponent(webhookId));
  const url = buildUrl(app.base_url, path, credentials);
  const headers = buildAuthHeaders(app, credentials);

  try {
    const response = await fetch(url, {
      method: reg.delete_method || "DELETE",
      headers,
      signal: AbortSignal.timeout(timeout),
    });

    if (!response.ok) {
      const text = await response.text();
      return { success: false, error: `HTTP ${response.status}: ${text}` };
    }

    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * List existing webhooks registered with an external service.
 */
export async function listWebhooks(
  opts: ListWebhooksOptions,
): Promise<ListWebhooksResult> {
  const { app, credentials, timeout = 15000 } = opts;

  const reg = app.webhooks?.registration;
  if (!reg?.list_path) {
    return { success: false, error: "No webhook list config for this app" };
  }

  const url = buildUrl(app.base_url, reg.list_path, credentials);
  const headers = buildAuthHeaders(app, credentials);

  try {
    const response = await fetch(url, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(timeout),
    });

    if (!response.ok) {
      const text = await response.text();
      return { success: false, error: `HTTP ${response.status}: ${text}` };
    }

    const data = await response.json();

    // Extract webhooks array from response
    let webhooksRaw: unknown[] = [];
    if (reg.list_field) {
      const extracted = extractPath(data, reg.list_field);
      if (Array.isArray(extracted)) webhooksRaw = extracted;
    } else if (Array.isArray(data)) {
      webhooksRaw = data;
    }

    const webhooks = webhooksRaw.map((w: any) => ({
      id: String(w.id || w.webhook_id || ""),
      url: w.url || w.address || w.endpoint || w.callback_url || undefined,
      events: w.events || w.enabled_events || w.topics || undefined,
      active: w.active !== undefined ? !!w.active : (w.status === "active" || true),
    }));

    return { success: true, webhooks };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// ─── Helpers ───

function buildUrl(
  baseUrl: string,
  path: string,
  credentials: ConnectionCredentials,
): string {
  // Replace {param} placeholders in base_url and path with credential fields
  let resolved = `${baseUrl.replace(/\/$/, "")}${path}`;
  resolved = resolved.replace(/\{(\w+)\}/g, (_match, key) => {
    return credentials.fields?.[key] || "";
  });
  return resolved;
}

function buildAuthHeaders(
  app: AppTemplate,
  credentials: ConnectionCredentials,
): Record<string, string> {
  const headers: Record<string, string> = {};
  if (app.auth.headers) {
    for (const [key, template] of Object.entries(app.auth.headers)) {
      headers[key] = resolveTemplate(template, credentials);
    }
  }
  return headers;
}

function resolveTemplate(
  template: string,
  credentials: ConnectionCredentials,
): string {
  const creds = credentials as Record<string, unknown>;
  return template.replace(/\{\{(\w+)\}\}/g, (_match, key) => {
    switch (key) {
      case "token":
        return (credentials.access_token || credentials.bearer_token || credentials.api_key
          || creds["token"] || credentials.fields?.["token"] || "") as string;
      case "api_key":
        return (credentials.api_key || creds["api_key"] || credentials.fields?.["api_key"] || "") as string;
      case "username":
        return (credentials.username || creds["username"] || credentials.fields?.["username"] || "") as string;
      case "password":
        return (credentials.password || creds["password"] || credentials.fields?.["password"] || "") as string;
      default:
        return (creds[key] || credentials.fields?.[key] || "") as string;
    }
  });
}

function extractPath(data: unknown, jsonPath: string): unknown {
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

/**
 * Set a value at a dot-notation path in an object, creating intermediate objects as needed.
 * e.g. setNestedField(body, "config.url", "https://...") → body.config.url = "https://..."
 */
function setNestedField(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split(".");
  let current: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!(parts[i] in current) || typeof current[parts[i]] !== "object") {
      current[parts[i]] = {};
    }
    current = current[parts[i]] as Record<string, unknown>;
  }
  current[parts[parts.length - 1]] = value;
}

/**
 * Deep merge source into target (mutates target).
 */
function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(source)) {
    if (value && typeof value === "object" && !Array.isArray(value) && typeof target[key] === "object" && target[key]) {
      deepMerge(target[key] as Record<string, unknown>, value as Record<string, unknown>);
    } else {
      target[key] = value;
    }
  }
}

/**
 * Flatten nested objects for form-urlencoded encoding.
 * e.g. { enabled_events: ["a", "b"] } → { "enabled_events[0]": "a", "enabled_events[1]": "b" }
 * Stripe-style array encoding.
 */
function flattenForForm(obj: Record<string, unknown>, prefix = ""): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}[${key}]` : key;
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        result[`${fullKey}[${i}]`] = String(value[i]);
      }
    } else if (value && typeof value === "object") {
      Object.assign(result, flattenForForm(value as Record<string, unknown>, fullKey));
    } else if (value !== undefined && value !== null) {
      result[fullKey] = String(value);
    }
  }
  return result;
}

function buildFormBody(params: Record<string, string>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(value)}`);
  }
  return parts.join("&");
}
