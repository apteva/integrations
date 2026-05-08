import { useEffect, useMemo, useState } from "react";
import { Code2, Sparkles, Sun, Moon } from "lucide-react";
import { catalog, vendors, type CatalogEntry } from "./catalog";

// Explorer — single-page browser over every integration UI component.
// Each card renders in preview mode at the same scale, with the same
// theme tokens, that it would inside the apteva-server dashboard.
//
// Theme axes:
//   data-theme = "terminal" | "clean"   ← font + radii + shadow
//   data-mode  = "dark" | "light"        ← color palette
// Both apply to <html>; ui-kit's theme.css owns the scoped CSS-var
// blocks so flipping either attribute repaints every surface
// instantly via the cascade.

type ThemeName = "terminal" | "clean";
type ModeName  = "dark" | "light";

export function Explorer() {
  const [theme, setTheme]   = useState<ThemeName>("clean");
  const [mode, setMode]     = useState<ModeName>("dark");
  const [vendor, setVendor] = useState<string>(vendors[0] ?? "hubspot");
  const [query, setQuery]   = useState("");

  // Apply theme + mode to <html> so the dashboard's token system
  // resolves correctly. Also mirror dark on <body> for any leftover
  // dark: variants in legacy components.
  useEffect(() => {
    const html = document.documentElement;
    html.setAttribute("data-theme", theme);
    html.setAttribute("data-mode",  mode);
    document.body.classList.toggle("dark", mode === "dark");
  }, [theme, mode]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return catalog.filter((e) => {
      if (vendor && e.vendor !== vendor) return false;
      if (!q) return true;
      return (
        e.name.toLowerCase().includes(q) ||
        e.label.toLowerCase().includes(q) ||
        e.description.toLowerCase().includes(q)
      );
    });
  }, [vendor, query]);

  return (
    <div className="min-h-dvh">
      <div className="max-w-[1400px] mx-auto px-4 py-4 flex gap-4 items-start">
        {/* ── Sidebar ── */}
        <aside className="w-64 shrink-0 self-start sticky top-4 space-y-4">
          {/* Header card */}
          <div className="bg-bg-card border border-border shadow-card rounded-lg p-3 space-y-3">
            <div>
              <div className="text-base font-semibold text-text">Component explorer</div>
              <div className="text-xs text-text-dim leading-snug">
                Live preview of every integration card under all four dashboard themes.
              </div>
            </div>
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search…"
              className="w-full text-sm rounded-md bg-bg-input border border-border px-2 py-1.5 text-text outline-none focus:border-accent"
            />
          </div>

          {/* Theme picker — two axes */}
          <ThemePicker
            theme={theme}
            mode={mode}
            onTheme={setTheme}
            onMode={setMode}
          />

          {/* Vendors */}
          <div className="bg-bg-card border border-border shadow-card rounded-lg p-2 space-y-0.5">
            <div className="text-[11px] uppercase tracking-wider text-text-dim px-2 py-1 font-medium">
              Vendors
            </div>
            {vendors.map((v) => {
              const count = catalog.filter((e) => e.vendor === v).length;
              const active = v === vendor;
              return (
                <button
                  key={v}
                  onClick={() => setVendor(v)}
                  className={`w-full h-8 px-2 rounded-md text-sm flex items-center justify-between transition-colors ${
                    active
                      ? "bg-accent/15 text-text"
                      : "text-text-muted hover:bg-bg-hover"
                  }`}
                >
                  <span className="capitalize">{v}</span>
                  <span className="text-xs text-text-dim tabular-nums">{count}</span>
                </button>
              );
            })}
          </div>

          {/* Help card */}
          <div className="bg-bg-card border border-border shadow-card rounded-lg p-3 space-y-1.5 text-xs text-text-dim leading-snug">
            <div className="text-text-muted font-medium">How preview works</div>
            <p>
              Every component supports a{" "}
              <code className="text-text font-mono">preview</code> prop.
              The explorer passes <code className="text-text font-mono">{"{ preview: true }"}</code>;
              the component's own preview-mode props supply the sample data —
              what you see is the production card with realistic stub content.
            </p>
          </div>
        </aside>

        {/* ── Main grid ── */}
        <main className="flex-1 min-w-0 space-y-6">
          {visible.length === 0 ? (
            <div className="bg-bg-card border border-border shadow-card rounded-lg p-8 text-center text-text-dim text-sm">
              No components match "{query}".
            </div>
          ) : (
            visible.map((entry) => (
              <PreviewCard key={`${entry.vendor}-${entry.name}`} entry={entry} />
            ))
          )}
        </main>
      </div>
    </div>
  );
}

interface ThemePickerProps {
  theme: ThemeName;
  mode: ModeName;
  onTheme: (t: ThemeName) => void;
  onMode: (m: ModeName) => void;
}

function ThemePicker({ theme, mode, onTheme, onMode }: ThemePickerProps) {
  return (
    <div className="bg-bg-card border border-border shadow-card rounded-lg p-3 space-y-2.5">
      <div className="text-[11px] uppercase tracking-wider text-text-dim font-medium">
        Dashboard theme
      </div>
      <div className="grid grid-cols-2 gap-1.5">
        <SegOption active={theme === "clean"} onClick={() => onTheme("clean")} icon={<Sparkles className="w-3.5 h-3.5" />}>
          Clean
        </SegOption>
        <SegOption active={theme === "terminal"} onClick={() => onTheme("terminal")} icon={<Code2 className="w-3.5 h-3.5" />}>
          Terminal
        </SegOption>
      </div>
      <div className="grid grid-cols-2 gap-1.5">
        <SegOption active={mode === "light"} onClick={() => onMode("light")} icon={<Sun className="w-3.5 h-3.5" />}>
          Light
        </SegOption>
        <SegOption active={mode === "dark"} onClick={() => onMode("dark")} icon={<Moon className="w-3.5 h-3.5" />}>
          Dark
        </SegOption>
      </div>
      <div className="text-[11px] text-text-dim leading-snug pt-1">
        Sets <code className="text-text font-mono">data-theme</code> +{" "}
        <code className="text-text font-mono">data-mode</code> on{" "}
        <code className="text-text font-mono">{"<html>"}</code>. The dashboard
        does the same — what you see here is what ships there.
      </div>
    </div>
  );
}

function SegOption({
  active,
  onClick,
  icon,
  children,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`h-8 rounded-md text-xs font-medium flex items-center justify-center gap-1.5 transition-colors ${
        active
          ? "bg-accent/15 text-accent border border-accent/30"
          : "border border-border text-text-muted hover:bg-bg-hover hover:text-text"
      }`}
    >
      {icon}
      {children}
    </button>
  );
}

function PreviewCard({ entry }: { entry: CatalogEntry }) {
  const Component = entry.component;
  const widthClass =
    entry.width === "full" ? "w-full"
    : entry.width === "wide" ? "max-w-3xl"
    : "max-w-md";

  return (
    <section>
      {/* Metadata header — outside the preview frame, so the preview
          renders exactly as it would inside the dashboard. */}
      <div className="px-1 pb-2 flex items-baseline gap-3 flex-wrap">
        <h2 className="text-sm font-semibold text-text">{entry.label}</h2>
        <code className="text-xs text-text-dim font-mono">
          @apteva/integrations/ui/{entry.vendor}/{entry.name}
        </code>
        <div className="flex gap-1">
          {entry.slots.map((s) => (
            <span
              key={s}
              className="text-[11px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-accent/10 text-accent font-medium"
              title="Slot tag"
            >
              {s}
            </span>
          ))}
        </div>
      </div>
      <p className="text-xs text-text-dim px-1 mb-2 leading-snug">{entry.description}</p>

      {/* Preview frame — dashed border, page-bg surface. The wrapper
          isn't a card itself; the component inside is. */}
      <div className="rounded-lg border border-dashed border-border-subtle p-6 bg-bg">
        <div className={widthClass}>
          <Component preview />
        </div>
      </div>
    </section>
  );
}
