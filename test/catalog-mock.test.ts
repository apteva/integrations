import { describe, expect, test } from "bun:test";
import { getAppTemplate, loadAppTemplates } from "../src/apps/index.js";
import { MOCK_FIXTURES, MOCK_SILENCE } from "../src/types.js";
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
  "stream",
  "respond",
] as const;

const CALLER_AUDIO = new Set<string>([...MOCK_FIXTURES.callerAudio, MOCK_SILENCE]);
const FIXTURES = new Set<string>([...MOCK_FIXTURES.callerAudio, ...MOCK_FIXTURES.recordings]);

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
    for (const match of text.matchAll(/fixture_url\(\s*'([^']*)'\s*\)/g)) {
      if (!FIXTURES.has(match[1])) problems.push(`fixture_url('${match[1]}'): unknown fixture`);
    }
  }
  if (mock.media) {
    const media = mock.media;
    if (media.protocol !== "telnyx") problems.push(`media.protocol ${media.protocol} is not supported`);
    if (!collections.has(media.collection)) problems.push(`media.collection ${media.collection} is unknown`);
    if (!MOCK_FIXTURES.callerAudio.includes(media.audio as never)) problems.push(`media.audio ${media.audio} is not a caller audio fixture`);
    const mediaEvents = Object.values(media.events ?? {}).filter(Boolean) as string[];
    for (const event of mediaEvents) {
      if (!events.has(event)) problems.push(`media event ${event} is not in webhooks.events`);
    }
    if (mediaEvents.length > 0) {
      emits = true;
      if (!media.to) problems.push(`media events need to`);
    }
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
      if (op === "stream") {
        if (!mock.media) problems.push(`${at}: stream needs a media section`);
        if (!["start", "play", "stop"].includes(step.stream!)) problems.push(`${at}: stream must be start, play or stop`);
        if (!step.key) problems.push(`${at}: stream needs key`);
        if (step.stream === "start" && !step.to) problems.push(`${at}: stream start needs to`);
        if (step.audio !== undefined && step.stream !== "play") problems.push(`${at}: audio is only valid with stream play`);
        if (step.audio !== undefined && !step.audio.includes("{{") && !CALLER_AUDIO.has(step.audio)) {
          problems.push(`${at}: audio ${step.audio} is not a caller audio fixture`);
        }
      } else if (step.audio !== undefined) {
        problems.push(`${at}: audio is only valid with stream`);
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

  test("simulates outbound calls, recording, bridging and media streams", () => {
    for (const tool of [
      "dial_call",
      "get_call_status",
      "bridge_call",
      "start_streaming",
      "stop_streaming",
      "start_call_recording",
      "pause_call_recording",
      "resume_call_recording",
      "stop_call_recording",
      "get_recording",
      "list_recordings",
      "delete_recording",
    ]) {
      expect(mock.tools[tool]).toBeDefined();
    }
  });

  test("leaves transfers, queues and messaging unsimulated", () => {
    for (const tool of ["transfer_call", "enqueue_call", "send_sms"]) {
      expect(mock.tools[tool]).toBeUndefined();
    }
  });

  test("acts as the Telnyx media peer for streams", () => {
    expect(mock.media).toMatchObject({
      protocol: "telnyx",
      collection: "streams",
      audio: "caller-speech-8k.wav",
      events: { started: "call.streaming.started", stopped: "call.streaming.stopped", failed: "call.streaming.failed" },
      lane: "{{stream.call_control_id}}",
    });
    // The stream URL carries Telephony's per-call secret; it stays out of
    // records and events.
    expect(JSON.stringify(mock.collections.streams)).not.toContain("stream_url");
    expect(JSON.stringify(mock.templates!.stream_event)).not.toContain("stream_url");
    for (const tool of ["dial_call", "answer_call", "start_streaming"]) {
      const start = mock.tools[tool].steps.find((step) => step.stream === "start");
      expect(start?.to).toBe("{{input.stream_url}}");
    }
  });

  test("recordings saved carry what Telephony needs to download them", () => {
    const saved = mock.templates!.recording_saved;
    for (const field of ["call_control_id", "recording_id", "format", "channels", "recording_started_at", "recording_ended_at", "recording_urls"]) {
      expect(saved[field]).toBeDefined();
    }
    const stop = JSON.stringify(mock.tools.stop_call_recording);
    expect(stop).toContain("call-recording-stereo.wav");
    expect(stop).toContain("call-recording-mono.wav");
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
    for (const tool of [
      "answer_call",
      "reject_call",
      "hangup_call",
      "speak_text",
      "gather_using_speak",
      "play_audio",
      "stop_audio",
      "dial_call",
      "bridge_call",
      "start_streaming",
      "stop_streaming",
      "start_call_recording",
      "pause_call_recording",
      "resume_call_recording",
      "stop_call_recording",
    ]) {
      const first = mock.tools[tool].steps[0];
      expect(first.dedupe).toContain("{{input.command_id}}");
      expect(first.when).toBe("input.command_id");
    }
  });

  test("tests can drive the caller and callee side", () => {
    expect(Object.keys(mock.triggers ?? {}).sort()).toEqual([
      "callee_answer",
      "callee_fail",
      "callee_hangup",
      "callee_no_answer",
      "caller_hangup",
      "caller_speaks",
      "dtmf",
      "gather_input",
      "incoming_call",
      "playback_finished",
    ]);
  });

  test("declares the streaming and detection events Telephony maps", () => {
    const events = app.webhooks!.events.map((event) => event.name);
    for (const event of [
      "call.streaming.started",
      "call.streaming.stopped",
      "call.streaming.failed",
      "call.recording.saved",
      "call.machine.detection.ended",
      "call.machine.premium.detection.ended",
    ]) {
      expect(events).toContain(event);
    }
  });
});

describe("Deepgram mock", () => {
  const app = getAppTemplate("deepgram")!;
  const mock = app.mock!;

  test("simulates listen, the tool Media and Functions transcribe with", () => {
    expect(Object.keys(mock.tools)).toEqual(["listen"]);
  });

  test("fails like Deepgram when the project is out of credits", () => {
    const payment = mock.tools.listen.steps.find((step) => step.status === 402);
    expect(payment?.respond).toMatchObject({
      err_code: "ASR_PAYMENT_REQUIRED",
      err_msg: "Project does not have enough credits for this request and does not have an overage agreement.",
    });
    const statuses = mock.tools.listen.steps.map((step) => step.status).filter(Boolean);
    expect(statuses).toEqual([402, 500, 504, 400]);
  });

  test("answers in the shape Media and Functions read", () => {
    const ok = JSON.stringify(mock.tools.listen.steps.at(-1)!.respond);
    for (const field of ["metadata", "duration", "request_id", "channels", "alternatives", "transcript", "words", "paragraphs", "utterances", "detected_language"]) {
      expect(ok).toContain(`"${field}"`);
    }
  });

  test("tests can queue answers and set a lasting default", () => {
    expect(Object.keys(mock.triggers ?? {}).sort()).toEqual(["queue_response", "set_default_response"]);
    expect(mock.collections.responses.seedable).toBe(true);
  });
});
