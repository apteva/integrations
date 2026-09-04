import { afterEach, describe, expect, test } from "bun:test";
import { executeTool } from "../src/http-executor.js";
import type { AppTemplate, AppToolTemplate, ResponseError } from "../src/types.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function app(tool: AppToolTemplate): AppTemplate {
  return {
    slug: "graphql-test",
    name: "GraphQL Test",
    description: "GraphQL executor fixture",
    logo: null,
    categories: ["test"],
    base_url: "https://graphql.example.test",
    auth: { types: [], credential_fields: [] },
    tools: [tool],
  };
}

function tool(options: {
  response_error?: ResponseError;
  response_path?: string;
} = {}): AppToolTemplate {
  return {
    name: "operation",
    description: "Run operation",
    method: "POST",
    path: "/graphql",
    input_schema: { type: "object", properties: {} },
    ...options,
  };
}

async function executeFixture(
  payload: unknown,
  candidate: AppToolTemplate,
  contentType = "application/graphql-response+json; charset=utf-8",
) {
  globalThis.fetch = async () => new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": contentType },
  });
  return executeTool({
    app: app(candidate),
    tool: candidate,
    credentials: { fields: {} },
    input: {},
  });
}

describe("GraphQL response errors", () => {
  test("detects top-level errors and preserves partial data with HTTP 200", async () => {
    const result = await executeFixture({
      data: { inventoryLevelAdjust: { id: "adjustment-1" } },
      errors: [{
        message: "Inventory item was not found",
        path: ["inventoryLevelAdjust"],
      }],
    }, tool({ response_error: { type: "graphql" } }));

    expect(result).toMatchObject({
      success: false,
      status: 200,
      data: {
        error: "upstream_graphql_error",
        message: "Inventory item was not found",
        details: [{
          message: "Inventory item was not found",
          path: ["inventoryLevelAdjust"],
        }],
        partial_data: { inventoryLevelAdjust: { id: "adjustment-1" } },
      },
    });
  });

  test("detects configured nested userErrors before response_path", async () => {
    const result = await executeFixture({
      data: {
        integrationOrderCreate: {
          order: null,
          userErrors: [{ field: ["items"], message: "Inventory item was not found" }],
        },
      },
    }, tool({
      response_error: {
        type: "graphql",
        paths: ["errors", "data.integrationOrderCreate.userErrors"],
      },
      response_path: "data.integrationOrderCreate",
    }));

    expect(result).toMatchObject({
      success: false,
      status: 200,
      data: {
        error: "upstream_graphql_error",
        message: "Inventory item was not found",
      },
    });
  });

  test("empty and missing error paths permit normal response extraction", async () => {
    const result = await executeFixture({
      data: {
        integrationOrderCreate: {
          order: { id: "order-1" },
          userErrors: [],
        },
      },
      errors: [],
    }, tool({
      response_error: {
        type: "graphql",
        paths: ["errors", "data.integrationOrderCreate.userErrors", "extensions.errors"],
      },
      response_path: "data.integrationOrderCreate",
    }));

    expect(result).toMatchObject({
      success: true,
      status: 200,
      data: { order: { id: "order-1" }, userErrors: [] },
    });
  });

  test("missing, null, and structurally invalid response paths fail", async () => {
    for (const payload of [
      { data: {} },
      { data: { integrationOrderCreate: null } },
      { data: "unexpected" },
    ]) {
      const result = await executeFixture(payload, tool({
        response_path: "data.integrationOrderCreate",
      }));
      expect(result).toMatchObject({
        success: false,
        status: 200,
        data: { error: "response contract violation" },
      });
    }
  });

  test("configured error paths must contain arrays", async () => {
    const result = await executeFixture({
      data: {},
      errors: { message: "wrong shape" },
    }, tool({ response_error: { type: "graphql" } }));

    expect(result).toMatchObject({
      success: false,
      status: 200,
      data: {
        error: "response contract violation",
        detail: "Expected response_error path errors to contain an array",
      },
    });
  });

  test("REST integrations without response_error retain their response", async () => {
    const result = await executeFixture(
      { ok: true, errors: [{ message: "ordinary REST field" }] },
      tool(),
      "application/json",
    );
    expect(result).toMatchObject({
      success: true,
      status: 200,
      data: { ok: true, errors: [{ message: "ordinary REST field" }] },
    });
  });
});
