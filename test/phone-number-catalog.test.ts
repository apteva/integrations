import { describe, expect, test } from "bun:test";
import { getAppTemplate } from "../src/apps/index.js";
import { executeTool } from "../src/http-executor.js";
import type { AppTemplate, AppToolTemplate } from "../src/types.js";

function integration(slug: string): AppTemplate {
  const app = getAppTemplate(slug);
  if (!app) throw new Error(`Missing integration catalog: ${slug}`);
  return app;
}

function tool(slug: string, name: string): AppToolTemplate {
  const candidate = integration(slug).tools.find((entry) => entry.name === name);
  if (!candidate) throw new Error(`Missing ${slug} tool: ${name}`);
  return candidate;
}

describe("phone number integration catalogs", () => {
  test("expose provider inventory and pricing operations", () => {
    expect(tool("twilio", "get_phone_number_pricing").method).toBe("GET");
    expect(tool("twilio", "get_voice_pricing").method).toBe("GET");
    expect(tool("twilio", "list_addresses").path).toContain("/Addresses.json");
    expect(tool("twilio", "create_address").method).toBe("POST");
    expect(tool("twilio", "list_regulations").base_url).toBe("https://numbers.twilio.com/v2");
    expect(tool("twilio", "create_regulatory_bundle").method).toBe("POST");
    expect(tool("twilio", "upload_regulatory_document").multipart_form?.file_fields).toEqual({ File: "File" });
    expect(tool("twilio", "assign_bundle_item").method).toBe("POST");
    expect(tool("twilio", "evaluate_regulatory_bundle").method).toBe("POST");
    expect(tool("twilio", "buy_phone_number").input_schema.properties?.AddressSid).toBeDefined();
    expect(tool("twilio", "buy_phone_number").input_schema.properties?.BundleSid).toBeDefined();
    expect(tool("telnyx", "search_available_phone_numbers").method).toBe("GET");
    expect(tool("telnyx", "create_address").path).toBe("/addresses");
    expect(tool("telnyx", "list_regulatory_requirements").method).toBe("GET");
    expect(tool("telnyx", "create_requirement_group").path).toBe("/requirement_groups");
    expect(tool("telnyx", "update_requirement_group").method).toBe("PATCH");
    expect(tool("telnyx", "submit_requirement_group").path).toContain("submit_for_approval");
    expect(tool("telnyx", "upload_document").path).toBe("/documents");
    expect(tool("telnyx", "create_number_order").input_schema.properties?.phone_numbers).toBeDefined();
    expect(tool("plivo", "get_number_pricing").method).toBe("GET");
    expect(tool("signalwire", "search_available_numbers").method).toBe("GET");
    expect(tool("vonage", "numbers_search").method).toBe("GET");
  });

  test("uses classic Vonage credentials only on number endpoints", async () => {
    const captured: Array<{ url: string; init: RequestInit }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      captured.push({ url: String(url), init: init || {} });
      return new Response(JSON.stringify({ numbers: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    try {
      const credentials = {
        access_token: "voice-jwt",
        fields: { api_key: "number-key", api_secret: "number-secret" },
      };
      await executeTool({
        app: integration("vonage"),
        tool: tool("vonage", "numbers_search"),
        credentials,
        input: { country: "EE", type: "landline", size: 5 },
      });
      await executeTool({
        app: integration("vonage"),
        tool: tool("vonage", "create_voice_call"),
        credentials,
        input: {
          to: [{ type: "phone", number: "3725550100" }],
          from: { type: "phone", number: "12025550100" },
          ncco: [],
        },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(captured[0]?.url).toBe(
      "https://rest.nexmo.com/number/search?api_key=number-key&api_secret=number-secret&country=EE&type=landline&size=5",
    );
    expect(captured[1]?.url).toBe("https://api.nexmo.com/v1/calls");
    expect(captured[1]?.url).not.toContain("number-secret");
    expect(captured[1]?.init.headers).toMatchObject({ Authorization: "Bearer voice-jwt" });
  });

  test("routes Twilio regulatory calls and document uploads to the correct hosts", async () => {
    const captured: Array<{ url: string; init: RequestInit }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      captured.push({ url: String(url), init: init || {} });
      return new Response(JSON.stringify({ results: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    try {
      const credentials = {
        access_token: "",
        fields: { account_sid: "AC00000000000000000000000000000000", auth_token: "secret" },
      };
      await executeTool({
        app: integration("twilio"),
        tool: tool("twilio", "list_regulations"),
        credentials,
        input: { IsoCountry: "EE", NumberType: "national", EndUserType: "individual", IncludeConstraints: true },
      });
      await executeTool({
        app: integration("twilio"),
        tool: tool("twilio", "upload_regulatory_document"),
        credentials,
        input: {
          FriendlyName: "Identity",
          Type: "government_issued_document",
          Attributes: "{}",
          File: "data:application/pdf;base64,JVBERg==",
          File_filename: "identity.pdf",
        },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(captured[0]?.url).toContain("https://numbers.twilio.com/v2/RegulatoryCompliance/Regulations");
    expect(captured[0]?.url).toContain("IsoCountry=EE");
    expect(captured[1]?.url).toBe("https://numbers-upload.twilio.com/v2/RegulatoryCompliance/SupportingDocuments");
    expect(captured[1]?.init.body).toBeInstanceOf(FormData);
    const upload = captured[1]?.init.body as FormData;
    expect(upload.get("FriendlyName")).toBe("Identity");
    expect((upload.get("File") as File).name).toBe("identity.pdf");
  });
});
