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
      scaleway: ["server_create", "server_get", "server_delete", "server_action", "server_set_cloud_init", "project_list", "server_types_list", "image_list"],
      "huawei-cloud": ["create_server", "get_server", "delete_servers", "get_job", "list_flavors", "list_images", "list_availability_zones", "list_vpcs", "list_subnets"],
      linode: ["create_instance", "get_instance", "delete_instance", "list_types", "list_regions", "list_images"],
      ovhcloud: ["create_instance", "get_instance", "delete_instance", "list_flavors", "list_regions", "list_images"],
    };
    for (const [slug, names] of Object.entries(required)) {
      const available = new Set(app(slug).tools.map((candidate) => candidate.name));
      for (const name of names) expect(available.has(name), `${slug}.${name}`).toBe(true);
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
