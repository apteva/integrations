import { describe, expect, test } from "bun:test";
import telegram from "../src/apps/telegram.json";

describe("Telegram catalog", () => {
  test("exposes the Bot API display-name operation", () => {
    const tool = telegram.tools.find((candidate) => candidate.name === "set_my_name");
    expect(tool?.method).toBe("POST");
    expect(tool?.path).toBe("/setMyName");
    expect(tool?.input_schema.required).toEqual(["name"]);
    expect(tool?.input_schema.properties.name.maxLength).toBe(64);
  });
});
