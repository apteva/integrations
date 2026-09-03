import { describe, expect, test } from "bun:test";
import { getAppTemplate } from "../src/apps/index.js";

describe("Alpaca Market Data corporate actions", () => {
  test("exposes the stable v1 endpoint and complete filters", () => {
    const app = getAppTemplate("alpaca-market-data");
    expect(app).toBeDefined();
    const tool = app!.tools.find((candidate) => candidate.name === "corporate_actions");
    expect(tool).toMatchObject({ method: "GET", path: "/v1/corporate-actions" });
    expect(tool!.input_schema.properties).toMatchObject({
      symbols: { type: "string" },
      cusips: { type: "string" },
      types: { type: "string" },
      start: { type: "string" },
      end: { type: "string" },
      page_token: { type: "string" },
    });
    expect(tool!.input_schema.properties!.region.enum).toEqual(["us", "non_us", "all"]);
    expect(tool!.input_schema.properties!.data_quality.enum).toEqual(["complete", "all"]);
  });
});
