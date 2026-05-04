import { readFileSync, readdirSync, existsSync } from "fs";
import { join, dirname, resolve } from "path";
import { fileURLToPath } from "url";
import type { AppTemplate } from "../types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// JSON files are in src/apps/ but compiled JS runs from dist/apps/
// Try multiple locations to find them
function getAppsDir(): string {
  // 1. Check current directory (works in dev / ts-node)
  if (existsSync(join(__dirname, "github.json"))) return __dirname;
  // 2. Check src/apps/ relative to package root (dist/apps/ -> ../../src/apps/)
  const srcApps = resolve(__dirname, "../../src/apps");
  if (existsSync(join(srcApps, "github.json"))) return srcApps;
  // 3. Fallback
  return __dirname;
}

let cachedApps: Map<string, AppTemplate> | null = null;

/**
 * Clear the cached app templates so they are reloaded from disk on next access.
 */
export function resetAppCache(): void {
  cachedApps = null;
}

/**
 * Load all app templates from the JSON files in the apps directory.
 * Results are cached after first load.
 */
export function loadAppTemplates(): Map<string, AppTemplate> {
  if (cachedApps) return cachedApps;

  cachedApps = new Map();
  const appsDir = getAppsDir();
  const files = readdirSync(appsDir).filter((f) => f.endsWith(".json"));

  for (const file of files) {
    try {
      const raw = readFileSync(join(appsDir, file), "utf-8");
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
  logo: string | null;
  categories: string[];
  toolCount: number;
}> {
  return Array.from(loadAppTemplates().values()).map((app) => ({
    slug: app.slug,
    name: app.name,
    description: app.description,
    logo: app.logo,
    categories: app.categories,
    toolCount: app.tools.length,
  }));
}

