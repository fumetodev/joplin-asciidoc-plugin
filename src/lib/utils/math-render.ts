import katex from "katex";
import AsciiMathParser from "asciimath2tex";

const am2tex = new AsciiMathParser();

export type MathNotation = "latexmath" | "asciimath";

/**
 * Render a math expression to HTML via KaTeX.
 * - notation="asciimath": converts to LaTeX first via asciimath2tex
 * - displayMode=true: centered display equation (block math)
 * - displayMode=false: inline equation
 */
export function renderMath(
  expression: string,
  notation: MathNotation,
  displayMode: boolean,
): string {
  if (!expression.trim()) {
    return `<span class="cm-lp-math-empty" style="color:var(--asciidoc-placeholder,#888);font-style:italic">[empty math]</span>`;
  }
  try {
    const latex = notation === "asciimath"
      ? am2tex.parse(expression)
      : expression;
    return katex.renderToString(latex, {
      displayMode,
      throwOnError: false,
      errorColor: "#d9534f",
      trust: false,
      strict: false,
      output: "htmlAndMathml",
    });
  } catch (e: any) {
    const msg = escapeAttr(e.message || String(e));
    return `<span class="cm-lp-math-error" title="${msg}">[Math Error]</span>`;
  }
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
