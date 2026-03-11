import { readFileSync, readdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import type { AppTemplate } from "../types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

let cachedApps: Map<string, AppTemplate> | null = null;

/**
 * Load all app templates from the JSON files in this directory.
 * Results are cached after first load.
 */
export function loadAppTemplates(): Map<string, AppTemplate> {
  if (cachedApps) return cachedApps;

  cachedApps = new Map();
  const files = readdirSync(__dirname).filter((f) => f.endsWith(".json"));

  for (const file of files) {
    try {
      const raw = readFileSync(join(__dirname, file), "utf-8");
      const app: AppTemplate = JSON.parse(raw);
      cachedApps.set(app.slug, app);
    } catch (e) {
      console.warn(`[integrations] Failed to load app template ${file}:`, e);
    }
  }

  return cachedApps;
}

/**
 * Get a single app template by slug.
 */
export function getAppTemplate(slug: string): AppTemplate | undefined {
  return loadAppTemplates().get(slug);
}

/**
 * List all available app slugs.
 */
export function listAppSlugs(): string[] {
  return Array.from(loadAppTemplates().keys());
}

/**
 * List all app templates with basic info (no full tool schemas).
 */
export function listApps(): Array<{
  slug: string;
  name: string;
  description: string;
  categories: string[];
  toolCount: number;
}> {
  return Array.from(loadAppTemplates().values()).map((app) => ({
    slug: app.slug,
    name: app.name,
    description: app.description,
    categories: app.categories,
    toolCount: app.tools.length,
  }));
}
