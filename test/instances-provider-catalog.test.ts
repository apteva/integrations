import { describe, expect, test } from "bun:test";
import { getAppTemplate } from "../src/apps/index.js";
import { executeTool } from "../src/http-executor.js";
import type { AppTemplate, AppToolTemplate } from "../src/types.js";

function app(slug: string): AppTemplate {
  const found = getAppTemplate(slug);
  if (!found) throw new Error(`Missing integration catalog: ${slug}`);
  return found;
}

function tool(slug: string, name: string): AppToolTemplate {
  const found = app(slug).tools.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`Missing ${slug} tool: ${name}`);
  return found;
}

describe("Instances provider integration contracts", () => {
  test("exposes every lifecycle tool used by the Instances adapters", () => {
    const required: Record<string, string[]> = {
      contabo: ["instance_create", "instance_get", "image_list"],
      vultr: ["create_instance", "get_instance", "delete_instance", "list_plans", "list_regions", "list_os"],
      "aws-ec2": ["create_instance", "list_instances", "terminate_instance", "list_instance_types", "list_availability_zones", "list_images"],
      scaleway: [
        "api_key_get", "server_create", "server_get", "server_delete", "server_action", "server_set_cloud_init", "project_list", "server_types_list", "image_list",
        "apple_products_list", "apple_server_types_list", "apple_os_list", "apple_servers_list", "apple_server_get", "apple_server_create",
        "apple_server_update", "apple_server_delete", "apple_server_reboot", "apple_server_reinstall", "ssh_keys_list", "ssh_key_create", "ssh_key_delete",
      ],
      "huawei-cloud": ["create_server", "get_server", "delete_servers", "get_job", "list_flavors", "list_images", "list_availability_zones", "list_vpcs", "list_subnets"],
      linode: ["create_instance", "get_instance", "delete_instance", "list_types", "list_regions", "list_images"],
      ovhcloud: ["create_instance", "get_instance", "delete_instance", "list_flavors", "list_regions", "list_images"],
    };
    for (const [slug, names] of Object.entries(required)) {
      const available = new Set(app(slug).tools.map((candidate) => candidate.name));
      for (const name of names) expect(available.has(name), `${slug}.${name}`).toBe(true);
    }
  });

  test("Scaleway Apple silicon tools use the official API routes", async () => {
    const originalFetch = globalThis.fetch;
    const requests: Array<{ url: string; method: string; body: string }> = [];
    globalThis.fetch = async (url, init) => {
      requests.push({ url: String(url), method: String(init?.method), body: String(init?.body || "") });
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    };
    const credentials = { fields: { token: "secret" } };
    try {
      await executeTool({ app: app("scaleway"), tool: tool("scaleway", "apple_products_list"), credentials, input: { product_types: ["apple_silicon"], page_size: 100 } });
      await executeTool({ app: app("scaleway"), tool: tool("scaleway", "apple_server_create"), credentials, input: { zone: "fr-par-1", name: "mac-1", project_id: "project-1", type: "M4-S", os_id: "os-1", commitment_type: "duration_24h" } });
      await executeTool({ app: app("scaleway"), tool: tool("scaleway", "ssh_key_create"), credentials, input: { name: "apteva-1", project_id: "project-1", public_key: "ssh-ed25519 AAAA test" } });

      expect(requests[0]?.url).toContain("/product-catalog/v2alpha1/public-catalog/products?product_types=apple_silicon&page_size=100");
      expect(requests[1]?.url).toBe("https://api.scaleway.com/apple-silicon/v1alpha1/zones/fr-par-1/servers");
      expect(requests[1]?.method).toBe("POST");
      expect(JSON.parse(requests[1]?.body || "{}")).toMatchObject({ type: "M4-S", os_id: "os-1", commitment_type: "duration_24h" });
      expect(requests[2]?.url).toBe("https://api.scaleway.com/iam/v1alpha1/ssh-keys");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("Scaleway project discovery uses valid Account and Instance API parameters", async () => {
    const originalFetch = globalThis.fetch;
    const urls: string[] = [];
    globalThis.fetch = async (url) => {
      urls.push(String(url));
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    };
    const credentials = { fields: { token: "secret", project_id: "project-1" } };
    try {
      await executeTool({
        app: app("scaleway"),
        tool: tool("scaleway", "api_key_get"),
        credentials,
        input: { access_key: "SCWACCESSKEY" },
      });
      await executeTool({
        app: app("scaleway"),
        tool: tool("scaleway", "project_list"),
        credentials,
        input: { organization_id: "organization-1", page_size: 100 },
      });
      await executeTool({
        app: app("scaleway"),
        tool: tool("scaleway", "security_group_list"),
        credentials,
        input: { zone: "fr-par-1", project_default: true, per_page: 100 },
      });

      expect(urls[0]).toBe("https://api.scaleway.com/iam/v1alpha1/api-keys/SCWACCESSKEY");
      expect(urls[1]).toBe("https://api.scaleway.com/account/v3/projects?organization_id=organization-1&page_size=100");
      expect(urls[2]).toBe("https://api.scaleway.com/instance/v1/zones/fr-par-1/security_groups?project_default=true&per_page=100");

      const projectField = app("scaleway").auth.credential_fields?.find((field) => field.name === "project_id");
      expect(projectField).toMatchObject({ required: false, exposure: "public" });
      const accessKeyField = app("scaleway").auth.credential_fields?.find((field) => field.name === "access_key");
      expect(accessKeyField).toMatchObject({ exposure: "public" });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("Scaleway cloud-init uses the official PATCH user-data contract", async () => {
    const originalFetch = globalThis.fetch;
    let request: { url: string; method: string; body: string; contentType: string | null } | undefined;
    globalThis.fetch = async (url, init) => {
      const headers = new Headers(init?.headers);
      request = {
        url: String(url),
        method: String(init?.method),
        body: String(init?.body || ""),
        contentType: headers.get("content-type"),
      };
      return new Response(null, { status: 204 });
    };
    try {
      const result = await executeTool({
        app: app("scaleway"),
        tool: tool("scaleway", "server_set_cloud_init"),
        credentials: { fields: { token: "secret" } },
        input: { zone: "fr-par-1", server_id: "server-1", content: "#cloud-config\nusers: []\n" },
      });

      expect(result.success).toBe(true);
      expect(request).toEqual({
        url: "https://api.scaleway.com/instance/v1/zones/fr-par-1/servers/server-1/user_data/cloud-init",
        method: "PATCH",
        body: "#cloud-config\nusers: []\n",
        contentType: "text/plain",
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("AWS EC2 create uses bound network settings and SigV4", async () => {
    const originalFetch = globalThis.fetch;
    let requestUrl = "";
    let requestHeaders: Headers | undefined;
    globalThis.fetch = async (url, init) => {
      requestUrl = String(url);
      requestHeaders = new Headers(init?.headers);
      return new Response("<RunInstancesResponse><instancesSet><item><instanceId>i-123</instanceId></item></instancesSet></RunInstancesResponse>", {
        status: 200,
        headers: { "content-type": "text/xml" },
      });
    };
    try {
      const result = await executeTool({
        app: app("aws-ec2"),
        tool: tool("aws-ec2", "create_instance"),
        credentials: { fields: { access_key_id: "AKID", secret_access_key: "secret", region: "eu-west-1", subnet_id: "subnet-123", security_group_id: "sg-123" } },
        input: { Action: "RunInstances", Version: "2016-11-15", ImageId: "ami-123", InstanceType: "t3.micro", MinCount: 1, MaxCount: 1 },
      });
      expect(result.success).toBe(true);
      const url = new URL(requestUrl);
      expect(url.searchParams.get("SubnetId")).toBe("subnet-123");
      expect(url.searchParams.get("SecurityGroupId.1")).toBe("sg-123");
      expect(url.searchParams.get("Action")).toBe("RunInstances");
      expect(requestHeaders?.get("authorization")).toContain("AWS4-HMAC-SHA256");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("Huawei routes image and network calls to their regional services", async () => {
    const originalFetch = globalThis.fetch;
    const urls: string[] = [];
    globalThis.fetch = async (url) => {
      urls.push(String(url));
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    };
    const credentials = { fields: { token: "token", region: "eu-west-0", project_id: "project-123" } };
    try {
      await executeTool({ app: app("huawei-cloud"), tool: tool("huawei-cloud", "list_images"), credentials, input: {} });
      await executeTool({ app: app("huawei-cloud"), tool: tool("huawei-cloud", "list_vpcs"), credentials, input: {} });
      await executeTool({ app: app("huawei-cloud"), tool: tool("huawei-cloud", "get_server"), credentials, input: { server_id: "server-123" } });
      expect(urls[0]).toBe("https://ims.eu-west-0.myhuaweicloud.com/v2/cloudimages");
      expect(urls[1]).toBe("https://vpc.eu-west-0.myhuaweicloud.com/v1/project-123/vpcs");
      expect(urls[2]).toBe("https://ecs.eu-west-0.myhuaweicloud.com/v1/project-123/cloudservers/server-123");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
