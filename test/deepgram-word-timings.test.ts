import { afterEach, describe, expect, test } from "bun:test";
import { getAppTemplate } from "../src/apps/index.js";
import { executeTool } from "../src/http-executor.js";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

describe("Deepgram listen preserves timed transcription", () => {
  const app = getAppTemplate("deepgram")!;
  const tool = app.tools.find(t => t.name === "listen")!;
  test("retains both word streams and provider audio/request identity", async () => {
    const word = { word: "hello", start: 0.12, end: 0.4, confidence: 0.97, speaker: 0 };
    globalThis.fetch = (async (url, init) => {
      expect(new URL(String(url)).pathname).toBe("/v1/listen");
      expect(new URL(String(url)).searchParams.get("utterances")).toBe("true");
      expect(JSON.parse(String(init?.body))).toEqual({url: "https://example.com/audio.wav"});
      expect(new Headers(init?.headers).get("Authorization")).toBe("Token fixture-key");
      return Response.json({metadata: {sha256: "audio-hash", request_id: "request-1", duration: 1, transaction_key: "private", model_info: {large: "metadata"}}, results: {
        channels: [{alternatives: [{transcript: "hello", words: [word]}]}],
        utterances: [{start: 0.12, end: 0.4, channel: 0, words: [word]}]
      }});
    }) as typeof fetch;
    const result = await executeTool({app, tool, credentials: {api_key: "fixture-key"}, input: {url: "https://example.com/audio.wav", utterances: true}});
    expect(result.success).toBe(true);
    const data = result.data as any;
    expect(data.results.channels[0].alternatives[0].words).toEqual([word]);
    expect(data.results.utterances[0].words).toEqual([word]);
    expect(data.metadata.sha256).toBe("audio-hash");
    expect(data.metadata.request_id).toBe("request-1");
    expect(data.metadata.transaction_key).toBeUndefined();
    expect(data.metadata.model_info).toBeUndefined();
    expect(app.tools.some(t => t.name === "listen_timed")).toBe(false);
  });
});
