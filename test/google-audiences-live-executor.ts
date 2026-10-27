// Opt-in bridge for unpublished CustomAudienceService catalog validation.
// Credentials remain in this process; only the Google response is written out.
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { getAppTemplate } from "../src/apps/index.js";
import { executeTool } from "../src/http-executor.js";
if (process.env.ADS_GOOGLE_AUDIENCES_LIVE !== "1") throw new Error("Explicit live-test opt-in required");
const config = JSON.parse(await readFile(process.env.ADS_LIVE_CONFIG || `${homedir()}/.apteva-prod/apteva.json`, "utf8"));
const base = process.env.ADS_LIVE_SERVER || "https://agents.schwartzindustries.com";
const connection = process.env.ADS_LIVE_CONNECTION || "103";
const response = await fetch(`${base}/api/connections/${connection}/credentials`, { headers: { Authorization: `Bearer ${config.api_key || config.apiKey}` } });
if (!response.ok) throw new Error(`Existing connection credentials unavailable: HTTP ${response.status}`);
const { credentials } = await response.json() as { credentials: Record<string, string> };
const input = JSON.parse(await Bun.stdin.text());
const app = getAppTemplate("google-ads")!;
const tool = app.tools.find(t => t.name === "custom_audience_mutate")!;
const result = await executeTool({ app, tool, input, credentials: { access_token: credentials.token || credentials.access_token, fields: credentials } });
process.stdout.write(JSON.stringify({ success: result.success, status: result.status, data: result.data }));
