import { describe, expect, test } from "bun:test";
import { getAppTemplate, loadAppTemplates } from "../src/apps/index.js";
import type { AppMockOperation, AppMockStep, AppTemplate } from "../src/types.js";

// Structural checks for every catalog `mock` section. The server compiles the
// expressions and runs the steps; this keeps references between the section
// and the rest of the catalog entry honest.

const OPERATIONS = [
  "let",
  "require",
  "lookup",
  "find",
  "list",
  "create",
  "update",
  "delete",
  "emit",
  "dedupe",
  "respond",
] as const;

const COLLECTION_OPERATIONS = new Set(["lookup", "find", "list", "create", "update", "delete"]);

function templateUses(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) templateUses(item, out);
  } else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (key === "$use" && typeof item === "string") out.push(item);
      else templateUses(item, out);
    }
  }
  return out;
}

function templateStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const item of value) templateStrings(item, out);
  else if (value && typeof value === "object") for (const item of Object.values(value)) templateStrings(item, out);
  return out;
}

function stepOperation(step: AppMockStep): string[] {
  return OPERATIONS.filter((name) => (step as Record<string, unknown>)[name] !== undefined);
}

function mockProblems(app: AppTemplate): string[] {
  const mock = app.mock!;
  const problems: string[] = [];
  const toolNames = new Set(app.tools.map((tool) => tool.name));
  const events = new Set((app.webhooks?.events ?? []).map((event) => event.name));
  const errors = new Set(Object.keys(mock.errors ?? {}));
  const templates = new Set(Object.keys(mock.templates ?? {}));
  const collections = new Set(Object.keys(mock.collections ?? {}));
  const credentialFields = new Set((app.auth.credential_fields ?? []).map((field) => field.name));
  let emits = false;

  if (mock.version !== 1) problems.push(`version must be 1`);
  for (const name of Object.keys(mock.tools ?? {})) {
    if (!toolNames.has(name)) problems.push(`tools.${name}: not a catalog tool`);
  }
  for (const name of templateUses(mock)) {
    if (!templates.has(name)) problems.push(`$use ${name}: unknown template`);
  }
  for (const text of templateStrings(mock)) {
    const opens = text.split("{{").length - 1;
    const closes = text.split("}}").length - 1;
    if (opens !== closes) problems.push(`unbalanced template: ${text}`);
  }

  const checkOperation = (where: string, operation: AppMockOperation) => {
    if (!Array.isArray(operation.steps) || operation.steps.length === 0) {
      problems.push(`${where}: steps required`);
      return;
    }
    const last = operation.steps[operation.steps.length - 1];
    if (last.respond === undefined || last.when !== undefined) {
      problems.push(`${where}: last step must be an unconditional respond`);
    }
    operation.steps.forEach((step, index) => {
      const at = `${where}.steps[${index}]`;
      const ops = stepOperation(step);
      if (ops.length !== 1) {
        problems.push(`${at}: exactly one operation required, found ${ops.join(",") || "none"}`);
        return;
      }
      const op = ops[0];
      if (COLLECTION_OPERATIONS.has(op)) {
        const collection = (step as Record<string, unknown>)[op] as string;
        if (!collections.has(collection)) problems.push(`${at}: unknown collection ${collection}`);
        if ((op === "lookup" || op === "update" || op === "delete") && !step.key) {
          problems.push(`${at}: ${op} needs key`);
        }
        if ((op === "lookup" || op === "find" || op === "list") && !step.as) {
          problems.push(`${at}: ${op} needs as`);
        }
      }
      if (op === "emit") {
        emits = true;
        if (!events.has(step.emit!)) problems.push(`${at}: event ${step.emit} is not in webhooks.events`);
        if (!step.to) problems.push(`${at}: emit needs to`);
      }
      if (step.error !== undefined && !errors.has(step.error)) {
        problems.push(`${at}: unknown error ${step.error}`);
      }
      if (op === "require" && step.error === undefined) problems.push(`${at}: require needs error`);
    });
  };

  for (const [name, operation] of Object.entries(mock.tools ?? {})) checkOperation(`tools.${name}`, operation);
  for (const [name, trigger] of Object.entries(mock.triggers ?? {})) {
    if (!trigger.description) problems.push(`triggers.${name}: description required`);
    if (trigger.input_schema?.type !== "object") problems.push(`triggers.${name}: input_schema must be an object schema`);
    checkOperation(`triggers.${name}`, trigger);
  }

  if (emits) {
    if (!mock.signing) problems.push(`signing required when events are emitted`);
    if (mock.envelope === undefined) problems.push(`envelope required when events are emitted`);
  }
  if (mock.signing) {
    if (mock.signing.algorithm !== "ed25519") problems.push(`signing.algorithm must be ed25519`);
    if (!credentialFields.has(mock.signing.public_key_field)) {
      problems.push(`signing.public_key_field ${mock.signing.public_key_field} is not a credential field`);
    }
    if (!mock.signing.message.includes("{body}")) problems.push(`signing.message must sign {body}`);
    if (app.webhooks?.signature_header && app.webhooks.signature_header.toLowerCase() !== mock.signing.signature_header.toLowerCase()) {
      problems.push(`signing.signature_header differs from webhooks.signature_header`);
    }
  }
  const attempts = mock.delivery?.max_attempts;
  if (attempts !== undefined && (attempts < 1 || attempts > 5)) problems.push(`delivery.max_attempts must be 1-5`);
  return problems;
}

describe("catalog mock sections", () => {
  const withMock = [...loadAppTemplates().values()].filter((app) => app.mock);

  test("at least Telnyx declares one", () => {
    expect(withMock.map((app) => app.slug)).toContain("telnyx");
  });

  for (const app of withMock) {
    test(`${app.slug} mock references resolve`, () => {
      expect(mockProblems(app)).toEqual([]);
    });
  }
});

describe("Telnyx mock", () => {
  const app = getAppTemplate("telnyx")!;
  const mock = app.mock!;

  test("simulates the route setup and inbound call tools Telephony uses", () => {
    const simulated = Object.keys(mock.tools).sort();
    for (const tool of [
      "list_phone_numbers",
      "update_phone_number",
      "list_outbound_voice_profiles",
      "create_call_control_application",
      "get_call_control_application",
      "update_call_control_application",
      "delete_call_control_application",
      "answer_call",
      "reject_call",
      "hangup_call",
      "speak_text",
      "gather_using_speak",
      "play_audio",
      "stop_audio",
    ]) {
      expect(simulated).toContain(tool);
    }
  });

  test("leaves media and outbound calling unsimulated", () => {
    for (const tool of ["start_streaming", "dial_call", "transfer_call", "send_sms"]) {
      expect(mock.tools[tool]).toBeUndefined();
    }
  });

  test("signs webhooks the way Telnyx does", () => {
    expect(mock.signing).toEqual({
      algorithm: "ed25519",
      public_key_field: "public_key",
      signature_header: "telnyx-signature-ed25519",
      timestamp_header: "telnyx-timestamp",
      message: "{timestamp}|{body}",
    });
    expect(mock.envelope).toMatchObject({
      data: { record_type: "event", event_type: "{{event}}", payload: "{{payload}}" },
    });
  });

  test("declares the speak events Telephony waits for", () => {
    const events = app.webhooks!.events.map((event) => event.name);
    expect(events).toContain("call.speak.started");
    expect(events).toContain("call.speak.ended");
  });

  test("call events carry the fields Telephony checks", () => {
    const call = mock.templates!.call;
    for (const field of ["call_control_id", "call_leg_id", "call_session_id", "connection_id", "client_state", "direction", "from", "to"]) {
      expect(call[field]).toBeDefined();
    }
  });

  test("call commands dedupe on command_id", () => {
    for (const tool of ["answer_call", "reject_call", "hangup_call", "speak_text", "gather_using_speak", "play_audio", "stop_audio"]) {
      const first = mock.tools[tool].steps[0];
      expect(first.dedupe).toContain("{{input.command_id}}");
      expect(first.when).toBe("input.command_id");
    }
  });

  test("tests can drive the caller side", () => {
    expect(Object.keys(mock.triggers ?? {}).sort()).toEqual([
      "caller_hangup",
      "dtmf",
      "gather_input",
      "incoming_call",
      "playback_finished",
    ]);
  });
});
