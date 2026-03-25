import mermaid from "mermaid";
import elkLayouts from "@mermaid-js/layout-elk";

// ── Module state ──

const svgCache = new Map<string, { svg: string; generation: number }>();
const pendingRenders = new Map<string, Promise<void>>();
let currentGeneration = 0;
let currentTheme: "default" | "dark" = "default";
let initialized = false;
let renderCounter = 0;

// ── Initialization ──

function ensureInitialized() {
  if (initialized) return;
  initialized = true;
  mermaid.registerLayoutLoaders(elkLayouts);
  mermaid.initialize({
    startOnLoad: false,
    theme: currentTheme,
    layout: "elk",
    securityLevel: "strict",
  });
}

// ── Public API ──

export function getCachedMermaidSvg(source: string): string | null {
  const entry = svgCache.get(source);
  if (entry && entry.generation === currentGeneration) return entry.svg;
  return null;
}

export function renderMermaidAsync(source: string, onComplete: () => void): void {
  // Already cached at current generation
  if (getCachedMermaidSvg(source) !== null) return;

  // Already rendering this exact source
  if (pendingRenders.has(source)) return;

  const gen = currentGeneration;
  const id = `mermaid-render-${++renderCounter}`;
  const promise = (async () => {
    ensureInitialized();
    try {
      const { svg } = await mermaid.render(id, source);
      // Only cache if generation hasn't changed during render
      if (gen === currentGeneration) {
        svgCache.set(source, { svg, generation: gen });
      }
    } catch (e: any) {
      const msg = (e.message || String(e)).replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
      const errorSvg = `<div class="cm-lp-mermaid-error" title="${msg.substring(0, 200)}">[Mermaid Error: ${msg.substring(0, 120)}]</div>`;
      if (gen === currentGeneration) {
        svgCache.set(source, { svg: errorSvg, generation: gen });
      }
    } finally {
      pendingRenders.delete(source);
      // Clean up any leftover Mermaid containers from failed renders
      document.getElementById(id)?.remove();
      onComplete();
    }
  })();

  pendingRenders.set(source, promise);
}

export function getMermaidPlaceholderHtml(): string {
  return '<div class="cm-lp-mermaid-placeholder">Loading diagram\u2026</div>';
}

export function setMermaidTheme(isDark: boolean): void {
  const newTheme = isDark ? "dark" : "default";
  if (newTheme === currentTheme && initialized) return;
  currentTheme = newTheme;
  currentGeneration++;
  svgCache.clear();
  if (initialized) {
    mermaid.initialize({
      startOnLoad: false,
      theme: currentTheme,
      layout: "elk",
      securityLevel: "strict",
    });
  }
}

export function getMermaidModule() {
  ensureInitialized();
  return mermaid;
}
