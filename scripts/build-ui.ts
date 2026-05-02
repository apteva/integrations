// Build every integration's UI components into ESM bundles the
// dashboard can dynamically import.
//
// Convention:
//   integrations/src/ui/<slug>/<Component>.tsx
// →
//   integrations/dist/ui/<slug>/<Component>.mjs
//
// Mirrors apps/scripts/build-panels.ts: react + @apteva/ui-kit are
// externalized so each component is just its own logic on top of
// the shared visual language and the host's React instance. The
// embedded Go side serves the .mjs files at /api/integrations/<slug>/<entry>.

import { readdir, mkdir } from "fs/promises";
import { existsSync } from "fs";
import { join, dirname, basename } from "path";

const ROOT = new URL("..", import.meta.url).pathname;
const SRC_UI = join(ROOT, "src/ui");
const DIST_UI = join(ROOT, "dist/ui");

async function findComponents(): Promise<{ slug: string; src: string }[]> {
  if (!existsSync(SRC_UI)) return [];
  const slugs = await readdir(SRC_UI, { withFileTypes: true });
  const out: { slug: string; src: string }[] = [];
  for (const d of slugs) {
    if (!d.isDirectory()) continue;
    const slugDir = join(SRC_UI, d.name);
    const entries = await readdir(slugDir);
    for (const f of entries) {
      if (f.endsWith(".tsx")) {
        out.push({ slug: d.name, src: join(slugDir, f) });
      }
    }
  }
  return out;
}

async function main() {
  const components = await findComponents();
  if (components.length === 0) {
    console.log("no integration components found under src/ui/<slug>/");
    return;
  }
  console.log(`Found ${components.length} integration component(s):`);
  for (const c of components) console.log("  ", c.src.replace(ROOT, ""));

  await mkdir(DIST_UI, { recursive: true });

  for (const { slug, src } of components) {
    const outDir = join(DIST_UI, slug);
    await mkdir(outDir, { recursive: true });
    const result = await Bun.build({
      entrypoints: [src],
      outdir: outDir,
      target: "browser",
      format: "esm",
      minify: true,
      sourcemap: "external",
      external: ["react", "react/jsx-runtime", "react/jsx-dev-runtime", "@apteva/ui-kit"],
      define: { "process.env.NODE_ENV": '"production"' },
      naming: "[name].mjs",
    });
    if (!result.success) {
      console.error(`✗ ${basename(src)}`);
      for (const log of result.logs) console.error("  ", log);
      process.exit(1);
    }
    const out = result.outputs.find((o) => o.path.endsWith(".mjs"));
    const size = out ? (out.size / 1024).toFixed(1) + " KB" : "?";
    console.log(`✓ ${src.replace(ROOT, "")} → ${slug}/${basename(src).replace(/\.tsx$/, ".mjs")} (${size})`);
  }
}

await main();
