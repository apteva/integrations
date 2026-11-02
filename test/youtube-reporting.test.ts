import { afterEach, describe, expect, test } from "bun:test";
import { getAppTemplate } from "../src/apps/index.js";
import { executeTool } from "../src/http-executor.js";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

async function call(name: string, input: Record<string, unknown>, response: Response = Response.json({})) {
  const app = getAppTemplate("youtube-api")!;
  const tool = app.tools.find(t => t.name === name)!;
  expect(tool).toBeDefined();
  let request: { url: URL; init: RequestInit } | undefined;
  globalThis.fetch = (async (url, init) => {
    request = { url: new URL(String(url)), init: init || {} };
    return response;
  }) as typeof fetch;
  const result = await executeTool({ app, tool, input, credentials: { access_token: "test-token" } });
  expect(new Headers(request!.init.headers).get("Authorization")).toBe("Bearer test-token");
  return { request: request!, result };
}

describe("YouTube Reporting API", () => {
  test("report types and jobs are read from the Reporting API host", async () => {
    const types = await call("list_reporting_report_types", { pageToken: "p2" });
    expect(types.request.url.origin + types.request.url.pathname).toBe("https://youtubereporting.googleapis.com/v1/reportTypes");
    expect(types.request.url.searchParams.get("pageToken")).toBe("p2");
    const jobs = await call("list_reporting_jobs", {});
    expect(jobs.request.url.pathname).toBe("/v1/jobs");
    expect(jobs.request.init.method).toBe("GET");
  });

  test("a job is created for one report type", async () => {
    const { request } = await call("create_reporting_job", { reportTypeId: "channel_reach_basic_a1", name: "Social reach" });
    expect(request.init.method).toBe("POST");
    expect(request.url.pathname).toBe("/v1/jobs");
    expect(JSON.parse(String(request.init.body))).toEqual({ reportTypeId: "channel_reach_basic_a1", name: "Social reach" });
  });

  test("reports are listed per job, newest since a time", async () => {
    const { request } = await call("list_reporting_reports", { jobId: "job-1", createdAfter: "2026-11-01T00:00:00Z" });
    expect(request.url.pathname).toBe("/v1/jobs/job-1/reports");
    expect(request.url.searchParams.get("createdAfter")).toBe("2026-11-01T00:00:00Z");
    expect(request.url.searchParams.has("jobId")).toBe(false);
  });

  test("downloads stay on the Reporting API host and return the CSV as binary", async () => {
    const csv = "date,video_id,video_thumbnail_impressions\n20261101,abc,100\n";
    const { request, result } = await call(
      "download_reporting_report",
      { channelId: "UC000", jobId: "job-1", reportId: "report-1", alt: "media" },
      new Response(csv, { headers: { "Content-Type": "application/octet-stream" } }),
    );
    expect(request.url.origin + request.url.pathname).toBe("https://youtubereporting.googleapis.com/v1/media/CHANNEL/UC000/jobs/job-1/reports/report-1");
    expect(request.url.searchParams.get("alt")).toBe("media");
    const data = result.data as { _binary: boolean; base64: string };
    expect(data._binary).toBe(true);
    expect(Buffer.from(data.base64, "base64").toString()).toBe(csv);
  });

  test("an ID cannot redirect the download to another path", async () => {
    const { request } = await call("download_reporting_report", { channelId: "UC000", jobId: "../../evil", reportId: "r", alt: "media" });
    expect(request.url.origin).toBe("https://youtubereporting.googleapis.com");
    expect(request.url.pathname.startsWith("/v1/media/CHANNEL/UC000/jobs/")).toBe(true);
  });
});
