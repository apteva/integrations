import { describe, expect, test } from "bun:test";
import { getAppTemplate } from "../src/apps/index.js";
import { executeTool } from "../src/http-executor.js";

async function capture(slug: string, name: string, input: Record<string, unknown>) {
  const app = getAppTemplate(slug)!;
  const tool = app.tools.find(t => t.name === name)!;
  expect(tool).toBeDefined();
  const original = globalThis.fetch;
  let request: {url: string, method: string, headers: Headers, body: any};
  globalThis.fetch = async (url, init) => {
    request = {url: String(url), method: String(init?.method), headers: new Headers(init?.headers), body: init?.body ? JSON.parse(String(init.body)) : undefined};
    return new Response("{}", {status: 200, headers: {"content-type":"application/json"}});
  };
  try {
    const result = await executeTool({app, tool, credentials: {fields: {api_key: "cloud-secret", token: "up-secret"}}, input});
    expect(result.success).toBe(true);
    return request!;
  } finally { globalThis.fetch = original; }
}

describe("Clouding and UpCloud provider contracts", () => {
  test("Clouding uses API-key authentication, pagination and nested creation data", async () => {
    const list = await capture("clouding", "list_flavors", {page: 2, pageSize: 200});
    expect(list.url).toBe("https://api.clouding.io/v1/sizes/flavors?page=2&pageSize=200");
    expect(list.headers.get("X-API-KEY")).toBe("cloud-secret");
    const body = {name: "test", hostname: "test", flavorId: "1x2", accessConfiguration: {sshKeyId: "key-1", savePassword: false}, volume: {source:"image", id:"image-1", ssdGb:20}, publicPortFirewallIds:["firewall-1"]};
    expect((await capture("clouding", "create_server", body)).body).toEqual(body);
    const get = await capture("clouding", "get_server", {id:"server-1"});
    expect(get.url).toBe("https://api.clouding.io/v1/servers/server-1");
    expect((await capture("clouding", "delete_server", {id:"server-1"})).method).toBe("DELETE");
    expect(getAppTemplate("clouding")!.auth.credential_fields!.find(f => f.name === "firewall_id")?.exposure).toBe("public");
  });
  test("UpCloud preserves envelopes and uses query parameters for deletion", async () => {
    const server = {zone:"es-mad1", plan:"2xCPU-4GB", hostname:"test", login_user:{username:"root", ssh_keys:{ssh_key:["ssh-ed25519 test"]}}};
    const created = await capture("upcloud", "create_server", {server});
    expect(created.url).toBe("https://api.upcloud.com/1.3/server");
    expect(created.headers.get("Authorization")).toBe("Bearer up-secret");
    expect(created.body).toEqual({server});
    const deleted = await capture("upcloud", "delete_server", {server_id:"server-1", storages:0});
    expect(deleted.url).toBe("https://api.upcloud.com/1.3/server/server-1?storages=0");
    expect(deleted.body).toBeUndefined();
    const attached = await capture("upcloud", "attach_volume", {server_id:"server-1",storage_device:{storage:"volume-1",type:"disk"}});
    expect(attached.url).toBe("https://api.upcloud.com/1.3/server/server-1/storage/attach");
    expect(attached.body).toEqual({storage_device:{storage:"volume-1",type:"disk"}});
  });
  test("catalog tools have unique names, defined path inputs and valid schema types", () => {
    for (const slug of ["clouding", "upcloud"]) {
      const app = getAppTemplate(slug)!;
      const names = new Set<string>();
      for (const tool of app.tools) {
        expect(names.has(tool.name)).toBe(false); names.add(tool.name);
        for (const [,param] of tool.path.matchAll(/\{([^}]+)\}/g)) expect((tool.input_schema.properties as any)[param]).toBeDefined();
        const walk = (value: any) => { if (!value || typeof value !== "object") return; if (value.type) expect(["string","integer","number","boolean","array","object","null"]).toContain(value.type); for (const item of Object.values(value)) walk(item); };
        walk(tool.input_schema);
      }
    }
  });
});
