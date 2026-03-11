import { randomBytes, createHmac } from "crypto";
import type { LocalTriggerConfig } from "../types.js";

export interface TriggerStorage {
  createTrigger(trigger: Omit<LocalTriggerConfig, "id" | "created_at">): LocalTriggerConfig;
  getTrigger(id: string): LocalTriggerConfig | null;
  getTriggerByPath(webhookPath: string): LocalTriggerConfig | null;
  listTriggers(projectId?: string | null): LocalTriggerConfig[];
  updateTrigger(id: string, updates: Partial<LocalTriggerConfig>): LocalTriggerConfig | null;
  deleteTrigger(id: string): boolean;
}

export interface WebhookPayload {
  headers: Record<string, string>;
  body: unknown;
  method: string;
  path: string;
}

export interface TriggerResult {
  matched: boolean;
  trigger?: LocalTriggerConfig;
  verified: boolean;
  payload?: unknown;
}

/**
 * LocalTriggerProvider manages webhook-based triggers locally.
 * Webhooks are received at /api/webhooks/local/:id and dispatched
 * to the associated agent.
 */
export class LocalTriggerProvider {
  private storage: TriggerStorage;

  constructor(storage: TriggerStorage) {
    this.storage = storage;
  }

  // ─── Trigger Management ───

  createTrigger(opts: {
    slug: string;
    name: string;
    description: string;
    agentId: string;
    useHmac?: boolean;
    projectId?: string | null;
  }): LocalTriggerConfig {
    const webhookPath = `/api/webhooks/local/${randomBytes(16).toString("hex")}`;
    const hmacSecret = opts.useHmac ? randomBytes(32).toString("hex") : null;

    return this.storage.createTrigger({
      slug: opts.slug,
      name: opts.name,
      description: opts.description,
      agent_id: opts.agentId,
      webhook_path: webhookPath,
      hmac_secret: hmacSecret,
      enabled: true,
      project_id: opts.projectId ?? null,
    });
  }

  getTrigger(id: string): LocalTriggerConfig | null {
    return this.storage.getTrigger(id);
  }

  listTriggers(projectId?: string | null): LocalTriggerConfig[] {
    return this.storage.listTriggers(projectId);
  }

  enableTrigger(id: string): LocalTriggerConfig | null {
    return this.storage.updateTrigger(id, { enabled: true });
  }

  disableTrigger(id: string): LocalTriggerConfig | null {
    return this.storage.updateTrigger(id, { enabled: false });
  }

  deleteTrigger(id: string): boolean {
    return this.storage.deleteTrigger(id);
  }

  regenerateSecret(id: string): LocalTriggerConfig | null {
    const newSecret = randomBytes(32).toString("hex");
    return this.storage.updateTrigger(id, { hmac_secret: newSecret });
  }

  // ─── Webhook Processing ───

  /**
   * Process an incoming webhook request.
   * Returns the matched trigger and verification status.
   */
  processWebhook(payload: WebhookPayload): TriggerResult {
    const trigger = this.storage.getTriggerByPath(payload.path);
    if (!trigger) {
      return { matched: false, verified: false };
    }

    if (!trigger.enabled) {
      return { matched: true, trigger, verified: false };
    }

    // Verify HMAC if configured
    let verified = true;
    if (trigger.hmac_secret) {
      verified = this.verifyHmac(payload, trigger.hmac_secret);
    }

    return {
      matched: true,
      trigger,
      verified,
      payload: payload.body,
    };
  }

  /**
   * Get the full webhook URL for a trigger, given the server's base URL.
   */
  getWebhookUrl(triggerId: string, baseUrl: string): string | null {
    const trigger = this.storage.getTrigger(triggerId);
    if (!trigger) return null;
    return `${baseUrl.replace(/\/$/, "")}${trigger.webhook_path}`;
  }

  // ─── HMAC Verification ───

  private verifyHmac(payload: WebhookPayload, secret: string): boolean {
    const signature =
      payload.headers["x-hub-signature-256"] ||
      payload.headers["x-signature-256"] ||
      payload.headers["x-webhook-signature"];

    if (!signature) return false;

    const body =
      typeof payload.body === "string"
        ? payload.body
        : JSON.stringify(payload.body);

    const expected = createHmac("sha256", secret).update(body).digest("hex");

    // Handle "sha256=..." prefix
    const actual = signature.replace(/^sha256=/, "");

    // Constant-time comparison
    if (actual.length !== expected.length) return false;
    let diff = 0;
    for (let i = 0; i < actual.length; i++) {
      diff |= actual.charCodeAt(i) ^ expected.charCodeAt(i);
    }
    return diff === 0;
  }
}
