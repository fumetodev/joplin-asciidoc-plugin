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
  initMermaidConfig();
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
    initMermaidConfig();
  }
}

function initMermaidConfig() {
  const config: Record<string, any> = {
    startOnLoad: false,
    theme: currentTheme,
    layout: "elk",
    securityLevel: "strict",
  };
  // Override theme variables for dark mode so diagrams match the editor's
  // dark background instead of Mermaid's default dark palette
  if (currentTheme === "dark") {
    config.themeVariables = {
      background: "#1e1e1e",
      primaryColor: "#3a3a3a",
      primaryTextColor: "#d4d4d4",
      primaryBorderColor: "#555",
      secondaryColor: "#2d2d2d",
      secondaryTextColor: "#d4d4d4",
      secondaryBorderColor: "#555",
      tertiaryColor: "#333",
      tertiaryTextColor: "#d4d4d4",
      tertiaryBorderColor: "#555",
      lineColor: "#888",
      textColor: "#d4d4d4",
      mainBkg: "#2d2d2d",
      nodeBorder: "#555",
      clusterBkg: "#252525",
      clusterBorder: "#555",
      titleColor: "#d4d4d4",
      edgeLabelBackground: "#2d2d2d",
      nodeTextColor: "#d4d4d4",
    };
  }
  mermaid.initialize(config);
}

export function getMermaidModule() {
  ensureInitialized();
  return mermaid;
}
