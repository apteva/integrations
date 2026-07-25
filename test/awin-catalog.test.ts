import { describe, expect, test } from "bun:test";
import type { IntegrationApp, IntegrationTool } from "../src/types";
import awin from "../src/apps/awin.json";

const app = awin as IntegrationApp;

function requireTool(name: string): IntegrationTool {
  const tool = app.tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`missing Awin tool ${name}`);
  return tool;
}

describe("Awin integration catalog", () => {
  test("uses the authenticated accounts endpoint for health checks", () => {
    expect(app.health_check).toEqual({
      tool: "accounts_list",
      input: { type: "publisher" },
      expect_status: [200],
    });
    expect(requireTool("accounts_list").path).toBe("/accounts");
  });

  test("covers programmes, commissions, links, transactions, and daily reporting", () => {
    expect(requireTool("programs_list").path).toBe("/publishers/{publisherId}/programmes");
    expect(requireTool("program_details_get").path).toBe(
      "/publishers/{publisherId}/programmedetails",
    );
    expect(requireTool("commission_groups_get").path).toBe(
      "/publishers/{publisherId}/commissiongroups",
    );
    expect(requireTool("tracking_link_generate").path).toBe(
      "/publishers/{publisherId}/linkbuilder/generate",
    );
    expect(requireTool("transactions_list").path).toBe(
      "/publishers/{publisherId}/transactions/",
    );
    expect(requireTool("campaign_performance_report").path).toBe(
      "/publishers/{publisherId}/reports/campaign",
    );
  });
});
