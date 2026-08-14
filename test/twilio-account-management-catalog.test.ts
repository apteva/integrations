import { afterEach, describe, expect, test } from "bun:test";
import { getAppTemplate } from "../src/apps/index.js";
import { executeTool } from "../src/http-executor.js";
import type { AppTemplate, AppToolTemplate } from "../src/types.js";

function twilio(): AppTemplate {
  const app = getAppTemplate("twilio");
  if (!app) throw new Error("Missing Twilio integration catalog");
  return app;
}

function tool(name: string): AppToolTemplate {
  const candidate = twilio().tools.find((entry) => entry.name === name);
  if (!candidate) throw new Error(`Missing Twilio tool: ${name}`);
  return candidate;
}

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("Twilio account management catalog", () => {
  test("exposes subaccount lifecycle, scoped credentials, and targeted usage tools", () => {
    expect(tool("list_subaccounts").path).toBe("/Accounts.json");
    expect(tool("create_subaccount").method).toBe("POST");
    expect(tool("get_subaccount").method).toBe("GET");
    expect(tool("update_subaccount").method).toBe("POST");
    expect(tool("suspend_subaccount").input_schema.properties?.Status).toMatchObject({
      const: "suspended",
    });
    expect(tool("reactivate_subaccount").input_schema.properties?.Status).toMatchObject({
      const: "active",
    });
    expect(tool("close_subaccount").input_schema.properties?.Status).toMatchObject({
      const: "closed",
    });
    expect(tool("close_subaccount").description).toContain("cannot be undone");

    expect(tool("create_standard_api_key").base_url).toBe("https://iam.twilio.com/v1");
    expect(tool("create_restricted_api_key").input_schema.properties?.KeyType).toMatchObject({
      const: "restricted",
    });
    expect(tool("list_api_keys").method).toBe("GET");
    expect(tool("get_api_key").path).toBe("/Keys/{KeySid}");
    expect(tool("update_api_key").method).toBe("POST");
    expect(tool("delete_api_key").method).toBe("DELETE");

    expect(tool("get_account_usage").path).toContain("{AccountSid}");
    expect(tool("get_account_usage_by_period").input_schema.properties?.Period).toMatchObject({
      enum: ["Daily", "Monthly", "Yearly", "AllTime", "Today", "Yesterday", "ThisMonth", "LastMonth"],
    });
  });

  test("uses main-account Basic auth and form encoding for subaccount lifecycle calls", async () => {
    const captured: Array<{ url: string; init: RequestInit }> = [];
    globalThis.fetch = async (url, init) => {
      captured.push({ url: String(url), init: init || {} });
      return new Response(JSON.stringify({ sid: "AC" + "1".repeat(32), status: "active" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    const app = twilio();
    const credentials = {
      access_token: "",
      fields: { account_sid: "AC" + "0".repeat(32), auth_token: "secret" },
    };
    const subaccountSid = "AC" + "1".repeat(32);

    await executeTool({
      app,
      tool: tool("create_subaccount"),
      credentials,
      input: { FriendlyName: "Customer One" },
    });
    await executeTool({
      app,
      tool: tool("suspend_subaccount"),
      credentials,
      input: { SubaccountSid: subaccountSid, Status: "suspended" },
    });
    await executeTool({
      app,
      tool: tool("close_subaccount"),
      credentials,
      input: { SubaccountSid: subaccountSid, Status: "closed" },
    });

    expect(captured.map((request) => request.url)).toEqual([
      "https://api.twilio.com/2010-04-01/Accounts.json",
      `https://api.twilio.com/2010-04-01/Accounts/${subaccountSid}.json`,
      `https://api.twilio.com/2010-04-01/Accounts/${subaccountSid}.json`,
    ]);
    expect(captured[0]?.init.headers).toMatchObject({
      Authorization: `Basic ${Buffer.from(`${credentials.fields.account_sid}:secret`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    });
    expect(new URLSearchParams(String(captured[0]?.init.body)).get("FriendlyName")).toBe("Customer One");
    expect(new URLSearchParams(String(captured[1]?.init.body)).get("Status")).toBe("suspended");
    expect(new URLSearchParams(String(captured[2]?.init.body)).get("Status")).toBe("closed");
  });

  test("creates restricted keys on the IAM API with an explicit JSON policy", async () => {
    const captured: Array<{ url: string; init: RequestInit }> = [];
    globalThis.fetch = async (url, init) => {
      captured.push({ url: String(url), init: init || {} });
      return new Response(JSON.stringify({ sid: "SK" + "2".repeat(32), secret: "returned-once" }), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    };

    const accountSid = "AC" + "1".repeat(32);
    const policy = JSON.stringify({ allow: ["/twilio/messaging/messages/read", "/twilio/billing/usage/read"] });
    await executeTool({
      app: twilio(),
      tool: tool("create_restricted_api_key"),
      credentials: {
        access_token: "",
        fields: { account_sid: "AC" + "0".repeat(32), auth_token: "secret" },
      },
      input: {
        AccountSid: accountSid,
        FriendlyName: "Read-only reporting",
        KeyType: "restricted",
        Policy: policy,
      },
    });

    expect(captured[0]?.url).toBe("https://iam.twilio.com/v1/Keys");
    const body = new URLSearchParams(String(captured[0]?.init.body));
    expect(body.get("AccountSid")).toBe(accountSid);
    expect(body.get("FriendlyName")).toBe("Read-only reporting");
    expect(body.get("KeyType")).toBe("restricted");
    expect(body.get("Policy")).toBe(policy);
  });

  test("retrieves period usage for an explicit subaccount SID", async () => {
    const captured: Array<{ url: string; init: RequestInit }> = [];
    globalThis.fetch = async (url, init) => {
      captured.push({ url: String(url), init: init || {} });
      return new Response(JSON.stringify({ usage_records: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    const accountSid = "AC" + "1".repeat(32);
    await executeTool({
      app: twilio(),
      tool: tool("get_account_usage_by_period"),
      credentials: {
        access_token: "",
        fields: { account_sid: "AC" + "0".repeat(32), auth_token: "secret" },
      },
      input: {
        AccountSid: accountSid,
        Period: "Monthly",
        Category: "sms",
        StartDate: "2026-01-01",
        EndDate: "2026-06-30",
        IncludeSubaccounts: false,
        PageSize: 100,
      },
    });

    const url = new URL(captured[0]?.url || "");
    expect(`${url.origin}${url.pathname}`).toBe(
      `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Usage/Records/Monthly.json`,
    );
    expect(url.searchParams.get("Category")).toBe("sms");
    expect(url.searchParams.get("StartDate")).toBe("2026-01-01");
    expect(url.searchParams.get("EndDate")).toBe("2026-06-30");
    expect(url.searchParams.get("IncludeSubaccounts")).toBe("false");
    expect(url.searchParams.get("PageSize")).toBe("100");
  });
});
