// dev-explorer — bun-served local explorer for every component in
// catalog.ts. Builds CSS once via the Tailwind CLI, builds JS once
// via Bun.build, then opens an HTTP server that streams the bundle
// + a small index.html. Re-runs the build on each request when
// EXPLORER_WATCH=1, so saving a component refreshes after a reload.
//
// Visual parity with demo/: same Tailwind setup, same theme tokens,
// same alias plugin (@apteva/ui-kit, @apteva/integrations, react/*
// pinned to integrations/node_modules).
//
// Run:
//   cd integrations
//   bun run explorer            # one-off build + serve, opens browser
//   EXPLORER_WATCH=1 bun run explorer  # rebuild on every request

import { $, type BunPlugin } from "bun";
import { resolve } from "path";
import { mkdirSync, rmSync } from "fs";

const ROOT = resolve(import.meta.dir, "..");
const NODE_MODULES = resolve(ROOT, "node_modules");
const WORKSPACE = resolve(ROOT, "..");

const ALIASES: Record<string, string> = {
  "@apteva/ui-kit": resolve(WORKSPACE, "ui-kit/src/index.ts"),
  "react": resolve(NODE_MODULES, "react/index.js"),
  "react/jsx-runtime": resolve(NODE_MODULES, "react/jsx-runtime.js"),
  "react/jsx-dev-runtime": resolve(NODE_MODULES, "react/jsx-dev-runtime.js"),
  "react-dom": resolve(NODE_MODULES, "react-dom/index.js"),
  "react-dom/client": resolve(NODE_MODULES, "react-dom/client.js"),
  // Pin lucide-react too — otherwise Bun looks relative to whichever
  // file imports it (e.g. ui-kit/src/CardHeader.tsx, which has no
  // node_modules of its own) and fails to resolve. Point at the ESM
  // entry directly because Bun's alias plugin needs a file, not a
  // directory.
  "lucide-react": resolve(NODE_MODULES, "lucide-react/dist/esm/lucide-react.mjs"),
};

const aliasPlugin: BunPlugin = {
  name: "explorer-aliases",
  setup(build) {
    for (const [spec, target] of Object.entries(ALIASES)) {
      const re = new RegExp(`^${spec.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
      build.onResolve({ filter: re }, () => ({ path: target }));
    }
  },
};

const DIST = resolve(ROOT, "dist/explorer");
rmSync(DIST, { recursive: true, force: true });
mkdirSync(DIST, { recursive: true });

async function buildOnce() {
  // CSS
  await $`bunx @tailwindcss/cli -i ${ROOT}/explorer/explorer.css -o ${DIST}/style.css --minify`.quiet();

  // JS
  const r = await Bun.build({
    entrypoints: [resolve(ROOT, "explorer/main.tsx")],
    outdir: DIST,
    target: "browser",
    sourcemap: "linked",
    naming: { entry: "[name].[ext]", chunk: "[name]-[hash].[ext]" },
    plugins: [aliasPlugin],
  });
  if (!r.success) {
    console.error("Build failed:");
    for (const log of r.logs) console.error(log);
    throw new Error("build failed");
  }
}

await buildOnce();

const port = Number(process.env.PORT ?? 5275);
const watch = process.env.EXPLORER_WATCH === "1";

const server = Bun.serve({
  port,
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url);
    const isHTML = url.pathname === "/" || url.pathname === "/index.html";

    // Rebuild only on full-page navigations (the HTML route). Asset
    // requests (main.js, style.css, .map) serve from the just-built
    // dist without triggering another rebuild — without this, a
    // single page load fired 3-4 sequential rebuilds because the
    // browser fetches each asset separately.
    if (watch && isHTML) await buildOnce();

    if (isHTML) {
      return new Response(indexHTML(), {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
        },
      });
    }
    const path = resolve(DIST, url.pathname.slice(1));
    if (!path.startsWith(DIST)) return new Response("forbidden", { status: 403 });
    const file = Bun.file(path);
    if (!(await file.exists())) return new Response("not found", { status: 404 });
    return new Response(file, {
      // Dev server: never let the browser cache. The CSS / JS hashes
      // can change between two page loads when source files have
      // been edited.
      headers: { "Cache-Control": "no-store" },
    });
  },
});

console.log(`\n  ◆ Component explorer\n  http://127.0.0.1:${port}\n`);
console.log(`  Vendors: hubspot (11 components)`);
console.log(`  Watch mode: ${watch ? "ON (rebuilds on each request)" : "OFF — restart to pick up changes"}`);
console.log(`  Press Ctrl-C to stop.\n`);
// Hold the process open.
await new Promise(() => {});
void server;

function indexHTML(): string {
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Apteva — component explorer</title>
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link href="https://fonts.googleapis.com/css2?family=Inter:opsz,wght@14..32,300;400;500;600&display=swap" rel="stylesheet" />
    <link rel="stylesheet" href="/style.css" />
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/main.js"></script>
  </body>
</html>`;
}
