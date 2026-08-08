import { describe, expect, test } from "bun:test";
import { getAppTemplate } from "../src/apps/index.js";

function tools(slug: string) {
  const app = getAppTemplate(slug);
  if (!app) throw new Error(`Missing ${slug}`);
  return { app, tools: new Map(app.tools.map((tool) => [tool.name, tool])) };
}

describe("ads audience integration contracts", () => {
  test("Meta exposes complete custom-audience lifecycle", () => {
    const { tools: catalog } = tools("facebook-ads");
    for (const name of ["audience_list", "audience_get", "audience_create_custom", "audience_create_lookalike", "audience_update", "audience_delete", "audience_users_add", "audience_users_remove"]) {
      expect(catalog.has(name)).toBe(true);
    }
    expect(catalog.get("audience_users_add")?.path).toBe("/{audience_id}/users");
  });

  test("Google uses Data Manager with the dedicated scope and without Ads headers", () => {
    const { app, tools: catalog } = tools("google-ads");
    expect(app.auth.oauth2?.scopes).toContain("https://www.googleapis.com/auth/datamanager");
    for (const name of ["data_manager_user_lists_list", "data_manager_user_list_get", "data_manager_user_list_create", "data_manager_user_list_update", "data_manager_user_list_delete", "data_manager_audience_members_ingest", "data_manager_audience_members_remove", "data_manager_request_status_get"]) {
      const tool = catalog.get(name);
      expect(tool?.base_url).toBe("https://datamanager.googleapis.com");
      expect(tool?.omit_auth_headers).toEqual(["developer-token", "login-customer-id"]);
    }
    for (const name of ["data_manager_user_lists_list", "data_manager_user_list_get", "data_manager_user_list_create", "data_manager_user_list_update", "data_manager_user_list_delete"]) {
      expect(catalog.get(name)?.header_params).toEqual({ login_account: "login-account" });
    }
    expect(catalog.get("data_manager_user_list_create")?.body_root_param).toBe("userList");
    expect(catalog.get("data_manager_request_status_get")?.query_params).toEqual(["requestId"]);
  });
});
