import { Decoration, EditorView, ViewPlugin, WidgetType, keymap } from "@codemirror/view";
import { Prec, RangeSetBuilder, StateEffect } from "@codemirror/state";
import { normalizeImageTarget } from "../utils/image-target";
import { type ImageInsertOptions, parseImageMacroLine, serializeImageBlock } from "../utils/image-macro";
import { renderMath, type MathNotation } from "../utils/math-render";
import { getCachedMermaidSvg, renderMermaidAsync, getMermaidPlaceholderHtml, getMermaidModule } from "../utils/mermaid-render";

// Joplin resource URL cache for resolving :/resourceId patterns
const resourceUrlCache = new Map<string, string>();
export function updateResourceUrls(resources: Array<{ id: string; dataUrl: string }>) {
  for (const r of resources) resourceUrlCache.set(r.id, r.dataUrl);
}

// =====================================================
// Block Detection
// =====================================================

interface CodeBlockInfo {
  type: "code";
  attrLine: number; // line with [source,lang], -1 if none
  openLine: number; // line with opening ----
  closeLine: number; // line with closing ----
  language: string;
}

interface TableBlockInfo {
  type: "table";
  attrLine: number; // line with [cols=...] etc., or -1 if none
  openLine: number; // line with opening |===
  closeLine: number; // line with closing |===
}

interface BlockquoteBlockInfo {
  type: "blockquote";
  attrLine: number; // line with [quote, Author], -1 if none
  openLine: number; // line with opening ____
  closeLine: number; // line with closing ____
  author: string;
}

interface ImagePreviewBlockInfo {
  type: "image";
  titleLine: number; // line with .Caption text, or -1 if none
  imageLine: number; // line with image::...
  options: ImageInsertOptions & { source: "web" | "local" };
}

interface ContentBlockInfo {
  type: "contentblock";
  kind: "sidebar" | "example" | "collapsible" | "admonition";
  titleLine: number; // line with .Title, or -1 if none
  attrLine: number; // line with [%collapsible] or [TIP] etc., or -1 if none
  openLine: number; // line with **** or ====
  closeLine: number; // line with matching delimiter
  title: string;
  admonitionType?: string; // "tip" | "note" | "warning" | "caution" | "important" (only for kind=admonition)
}

interface StemBlockInfo {
  type: "stem";
  attrLine: number;   // line with [stem], [latexmath], or [asciimath]
  openLine: number;   // line with opening ++++
  closeLine: number;  // line with closing ++++
  rawNotation: "stem" | "latexmath" | "asciimath"; // original attribute value
}

interface MermaidBlockInfo {
  type: "mermaid";
  attrLine: number;   // line with [mermaid]
  openLine: number;   // line with opening ----
  closeLine: number;  // line with closing ----
}

interface DocHeaderBlockInfo {
  type: "docheader";
  startLine: number;  // first line of the header block
  endLine: number;    // last line of the header block (before blank line)
  title: string;      // document title (= Title line), empty if none
  attributes: Array<{ name: string; value: string }>; // parsed :name: value pairs
}

/** Resolve a raw stem notation to a concrete MathNotation for rendering. */
function resolveStemNotation(raw: "stem" | "latexmath" | "asciimath"): MathNotation {
  return raw === "stem" ? documentStemNotation : raw;
}

type BlockInfo = CodeBlockInfo | TableBlockInfo | BlockquoteBlockInfo | ImagePreviewBlockInfo | ContentBlockInfo | StemBlockInfo | MermaidBlockInfo | DocHeaderBlockInfo;

interface PreviewHeightCache {
  lineHeights: Map<number, number>;
}

const LINE_HEIGHT_DATA_ATTR = "data-lp-line-from";
const MIN_HEIGHT_DELTA_PX = 1;
const LIST_LINE_PADDING_EM = 0.35;
const CODE_HEADER_FONT_EM = 0.75;       // matches .cm-lp-codeblock-header fontSize
const CODE_HEADER_LINE_HEIGHT = 1.4;     // approximate header line-height
const CODE_HEADER_PADDING_EM = 0.286;    // matches .cm-lp-codeblock-header padding (each side)
const CODE_BODY_PADDING_EM = 0.857;      // matches .cm-lp-codeblock-pre padding (each side)
const PREVIEW_INTERACTIVE_SELECTOR = ".cm-lp-section-toggle, .cm-lp-xref, .cm-lp-image, .cm-lp-footnote";
const FLOATING_PREVIEW_SELECTOR = ".cm-lp-floating-section-preview";
const SECTION_TOGGLE_CLOSED = "\u25b8";
const SECTION_TOGGLE_OPEN = "\u25be";

function createPreviewHeightCache(): PreviewHeightCache {
  return {
    lineHeights: new Map<number, number>(),
  };
}

function measureElementHeightPx(element: HTMLElement): number {
  return Math.ceil(element.getBoundingClientRect().height);
}

function measureRawLineHeightPx(view: EditorView): number {
  const sampleLine = view.contentDOM.querySelector<HTMLElement>(".cm-line") ?? view.contentDOM;
  const styles = window.getComputedStyle(sampleLine);
  const computedLineHeight = Number.parseFloat(styles.lineHeight);
  if (Number.isFinite(computedLineHeight)) {
    return Math.ceil(computedLineHeight);
  }

  const computedFontSize = Number.parseFloat(styles.fontSize);
  if (Number.isFinite(computedFontSize)) {
    return Math.ceil(computedFontSize * 1.6);
  }

  return Math.ceil(view.defaultLineHeight || 22);
}

function getPreviewLineFromElement(element: HTMLElement | null): number | null {
  if (!element) return null;

  const directPreviewLine = element.closest<HTMLElement>(`[${LINE_HEIGHT_DATA_ATTR}]`);
  const previewLine = directPreviewLine
    ?? element.closest<HTMLElement>(".cm-line")?.querySelector<HTMLElement>(`[${LINE_HEIGHT_DATA_ATTR}]`)
    ?? null;

  if (!previewLine) return null;

  const rawFrom = previewLine.getAttribute(LINE_HEIGHT_DATA_ATTR);
  const from = rawFrom ? Number.parseInt(rawFrom, 10) : NaN;
  return Number.isFinite(from) ? from : null;
}

function setSectionToggleState(toggleEl: HTMLElement, isOpen: boolean): void {
  toggleEl.classList.toggle("open", isOpen);
  toggleEl.textContent = isOpen ? SECTION_TOGGLE_OPEN : SECTION_TOGGLE_CLOSED;
  toggleEl.setAttribute("aria-label", isOpen ? "Hide linked section" : "Show linked section");
  toggleEl.setAttribute("title", isOpen ? "Hide linked section" : "Show linked section");
}

function getEditorViewFromElement(element: HTMLElement): EditorView | null {
  const editorEl = element.closest(".cm-editor") as HTMLElement | null;
  return editorEl ? EditorView.findFromDOM(editorEl) : null;
}

function attachPreviewFocusHandlers(
  element: HTMLElement,
  lineFrom: number,
  shouldIgnoreTarget: (target: HTMLElement) => boolean = () => false,
) {
  element.addEventListener("mousedown", (e) => {
    if (e.button !== 0 || e.defaultPrevented) return;

    const target = e.target as HTMLElement;
    if (shouldIgnoreTarget(target)) return;

    consumeEvent(e);
    const view = getEditorViewFromElement(element);
    if (!view) return;
    queuePreviewLineFocus(view, lineFrom, target);
  });

  element.addEventListener("mouseup", (e) => {
    if (e.button !== 0 || e.defaultPrevented || pendingPreviewClickFrom !== lineFrom) return;

    const target = e.target as HTMLElement;
    if (shouldIgnoreTarget(target)) return;

    consumeEvent(e);
    const view = getEditorViewFromElement(element);
    if (!view) return;
    focusPreviewLine(view, lineFrom);
  });

  element.addEventListener("mousemove", (e) => {
    if (pendingPreviewClickFrom !== lineFrom) return;
    consumeEvent(e);
  });

  element.addEventListener("selectstart", (e) => {
    if (pendingPreviewClickFrom !== lineFrom) return;
    consumeEvent(e);
  });

  element.addEventListener("dragstart", (e) => {
    if (pendingPreviewClickFrom !== lineFrom) return;
    consumeEvent(e);
  });
}

function attachBlockModalHandlers(element: HTMLElement, onOpen: (view: EditorView) => void) {
  element.addEventListener("mousedown", (e) => {
    if (e.button !== 0 || e.defaultPrevented) return;
    consumeEvent(e);
  });

  element.addEventListener("mouseup", (e) => {
    if (e.button !== 0 || e.defaultPrevented) return;
    consumeEvent(e);
  });

  element.addEventListener("click", (e) => {
    if ((e as MouseEvent).button !== 0 || e.defaultPrevented) return;
    consumeEvent(e);
    const view = getEditorViewFromElement(element);
    if (!view) return;
    if (overlayEditingMode) {
      onOpen(view);
    } else {
      // Without overlay mode, just focus the line so raw editing starts
      const lineFrom = parseInt(element.getAttribute(LINE_HEIGHT_DATA_ATTR) || "0", 10);
      if (lineFrom > 0) {
        focusPreviewLine(view, lineFrom);
      }
    }
  });

  element.addEventListener("mousemove", (e) => consumeEvent(e));
  element.addEventListener("selectstart", (e) => consumeEvent(e));
  element.addEventListener("dragstart", (e) => consumeEvent(e));
}

function isInteractivePreviewTarget(target: HTMLElement): boolean {
  return Boolean(target.closest(PREVIEW_INTERACTIVE_SELECTOR));
}

function isFloatingPreviewTarget(target: HTMLElement): boolean {
  return Boolean(target.closest(FLOATING_PREVIEW_SELECTOR));
}

function consumeEvent(event: Event) {
  event.preventDefault();
  event.stopPropagation();
}

let pendingPreviewClickFrom: number | null = null;
let pendingPreviewClickAnchorTop: number | null = null;
let blockEditorOverlay: HTMLDivElement | null = null;
let overlayEditingMode = false;

export function setOverlayEditingEnabled(enabled: boolean) {
  overlayEditingMode = enabled;
}

function clearPendingPreviewClick() {
  pendingPreviewClickFrom = null;
  pendingPreviewClickAnchorTop = null;
}

function measureElementTopRelativeToScroller(view: EditorView, element: HTMLElement): number {
  const scrollerRect = view.scrollDOM.getBoundingClientRect();
  const elementRect = element.getBoundingClientRect();
  return Math.round(elementRect.top - scrollerRect.top);
}

function getLineElementForPosition(view: EditorView, lineFrom: number): HTMLElement | null {
  const domAtPos = view.domAtPos(lineFrom);
  const baseNode = domAtPos.node instanceof HTMLElement
    ? domAtPos.node
    : domAtPos.node.parentElement;
  return baseNode?.closest<HTMLElement>(".cm-line") ?? null;
}

function capturePreviewAnchorTop(view: EditorView, target: HTMLElement | null, lineFrom: number): number | null {
  const lineElement = target?.closest<HTMLElement>(".cm-line")
    ?? getLineElementForPosition(view, lineFrom)
    ?? view.dom
      .querySelector<HTMLElement>(`[${LINE_HEIGHT_DATA_ATTR}="${lineFrom}"]`)
      ?.closest<HTMLElement>(".cm-line")
    ?? null;

  if (lineElement) {
    return measureElementTopRelativeToScroller(view, lineElement);
  }

  const previewElement = target?.closest<HTMLElement>(`[${LINE_HEIGHT_DATA_ATTR}]`)
    ?? view.dom.querySelector<HTMLElement>(`[${LINE_HEIGHT_DATA_ATTR}="${lineFrom}"]`)
    ?? null;

  if (previewElement) {
    return measureElementTopRelativeToScroller(view, previewElement);
  }

  return null;
}

function measureLineTopRelativeToScroller(view: EditorView, lineFrom: number): number | null {
  const lineElement = getLineElementForPosition(view, lineFrom);
  if (!lineElement) return null;

  return measureElementTopRelativeToScroller(view, lineElement);
}

function queuePreviewLineFocus(view: EditorView, lineFrom: number, target: HTMLElement | null) {
  pendingPreviewClickFrom = lineFrom;
  pendingPreviewClickAnchorTop = capturePreviewAnchorTop(view, target, lineFrom);
}

function preserveViewportAfterUpdate(view: EditorView, lineFrom: number, anchorTop: number | null, scrollTop: number, scrollLeft: number) {
  requestAnimationFrame(() => {
    view.requestMeasure({
      read(view) {
        return {
          currentTop: measureLineTopRelativeToScroller(view, lineFrom),
        };
      },
      write({ currentTop }) {
        if (anchorTop != null && currentTop != null) {
          view.scrollDOM.scrollTop += currentTop - anchorTop;
        } else {
          view.scrollDOM.scrollTop = scrollTop;
        }
        view.scrollDOM.scrollLeft = scrollLeft;
      },
    });
  });
}

function focusPreviewLine(view: EditorView, lineFrom: number) {
  const anchorTop = pendingPreviewClickAnchorTop;
  const { scrollTop, scrollLeft } = view.scrollDOM;
  window.getSelection()?.removeAllRanges();
  clearPendingPreviewClick();
  view.dispatch({
    selection: { anchor: lineFrom },
  });
  view.focus();
  preserveViewportAfterUpdate(view, lineFrom, anchorTop, scrollTop, scrollLeft);
}

function serializeCodeBlock(language: string, code: string, hadAttributeLine: boolean): string {
  const trimmedLanguage = language.trim();
  const normalizedCode = code.replace(/\r\n?/g, "\n");
  const lines: string[] = [];

  if (hadAttributeLine || trimmedLanguage) {
    lines.push(trimmedLanguage ? `[source,${trimmedLanguage}]` : "[source]");
  }

  lines.push("----", normalizedCode, "----");
  return lines.join("\n");
}

function serializeBlockquote(author: string, content: string, hadAttributeLine: boolean): string {
  const trimmedAuthor = author.trim();
  const normalizedContent = content.replace(/\r\n?/g, "\n");
  const lines: string[] = [];

  if (hadAttributeLine || trimmedAuthor) {
    lines.push(trimmedAuthor ? `[quote, ${trimmedAuthor}]` : "[quote]");
  }

  lines.push("____", normalizedContent, "____");
  return lines.join("\n");
}

function serializeStemBlock(notation: string, expression: string): string {
  return `[${notation}]\n++++\n${expression}\n++++`;
}

function serializeMermaidBlock(source: string): string {
  return `[mermaid]\n----\n${source}\n----`;
}

function deleteBlockRange(view: EditorView, blockFrom: number, blockTo: number) {
  const nextChar = blockTo < view.state.doc.length ? view.state.sliceDoc(blockTo, blockTo + 1) : "";
  const deleteTo = nextChar === "\n" ? blockTo + 1 : blockTo;
  view.dispatch({
    changes: { from: blockFrom, to: deleteTo, insert: "" },
    selection: { anchor: blockFrom },
  });
}

function closeBlockEditorModal(view?: EditorView) {
  if (blockEditorOverlay) {
    blockEditorOverlay.remove();
    blockEditorOverlay = null;
  }
  if (view) {
    view.focus();
  }
}

function createBlockEditorModal(view: EditorView, title: string) {
  closeFloatingPreview();
  closeBlockEditorModal();

  const overlay = document.createElement("div");
  overlay.className = "cm-lp-block-editor-overlay";
  overlay.tabIndex = -1;

  const modal = document.createElement("div");
  modal.className = "cm-lp-block-editor-modal";

  const header = document.createElement("div");
  header.className = "cm-lp-block-editor-header";

  const titleEl = document.createElement("h3");
  titleEl.className = "cm-lp-block-editor-title";
  titleEl.textContent = title;

  const closeBtn = document.createElement("button");
  closeBtn.className = "cm-lp-block-editor-close";
  closeBtn.type = "button";
  closeBtn.setAttribute("aria-label", "Close block editor");
  closeBtn.textContent = "×";

  const body = document.createElement("div");
  body.className = "cm-lp-block-editor-body";

  const footer = document.createElement("div");
  footer.className = "cm-lp-block-editor-footer";
  const footerLeft = document.createElement("div");
  footerLeft.className = "cm-lp-block-editor-footer-left";
  const footerRight = document.createElement("div");
  footerRight.className = "cm-lp-block-editor-footer-right";

  const close = () => closeBlockEditorModal(view);

  closeBtn.addEventListener("click", (e) => {
    consumeEvent(e);
    close();
  });

  overlay.addEventListener("mousedown", (e) => {
    if (e.target === overlay) consumeEvent(e);
  });
  overlay.addEventListener("mouseup", (e) => {
    if (e.target === overlay) consumeEvent(e);
  });
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) consumeEvent(e);
  });
  overlay.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      consumeEvent(e);
      close();
    }
  });
  modal.addEventListener("mousedown", (e) => e.stopPropagation());
  modal.addEventListener("mouseup", (e) => e.stopPropagation());
  modal.addEventListener("click", (e) => e.stopPropagation());
  modal.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") e.stopPropagation();
  });

  header.append(titleEl, closeBtn);
  footer.append(footerLeft, footerRight);
  modal.append(header, body, footer);
  overlay.appendChild(modal);
  view.dom.appendChild(overlay);
  blockEditorOverlay = overlay;

  return { overlay, modal, body, footer, footerLeft, footerRight, close };
}

function makeBlockEditorField(label: string, input: HTMLElement) {
  const field = document.createElement("label");
  field.className = "cm-lp-block-editor-field";

  const labelEl = document.createElement("span");
  labelEl.className = "cm-lp-block-editor-label";
  labelEl.textContent = label;

  field.append(labelEl, input);
  return field;
}

function makeBlockEditorButton(label: string, kind: "primary" | "secondary" = "secondary") {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `cm-lp-block-editor-btn cm-lp-block-editor-btn-${kind}`;
  button.textContent = label;
  return button;
}

function openCodeBlockEditorModal(
  view: EditorView,
  language: string,
  code: string,
  blockFrom: number,
  blockTo: number,
  hadAttributeLine: boolean,
) {
  const { overlay, body, footerLeft, footerRight, close } = createBlockEditorModal(view, "Edit Source Block");

  const knownLanguages = ["text", ...LANGUAGES];
  const isCustomLanguage = Boolean(language) && !knownLanguages.includes(language);

  const languageSelect = document.createElement("select");
  languageSelect.className = "cm-lp-block-editor-input";
  for (const lang of knownLanguages) {
    const option = document.createElement("option");
    option.value = lang;
    option.textContent = lang;
    languageSelect.appendChild(option);
  }
  const customOption = document.createElement("option");
  customOption.value = "__custom__";
  customOption.textContent = "(custom language)";
  languageSelect.appendChild(customOption);
  languageSelect.value = isCustomLanguage ? "__custom__" : (language || "text");

  const customLanguageInput = document.createElement("input");
  customLanguageInput.type = "text";
  customLanguageInput.className = "cm-lp-block-editor-input";
  customLanguageInput.placeholder = "Enter custom language";
  customLanguageInput.value = isCustomLanguage ? language : "";
  customLanguageInput.spellcheck = false;

  const languageField = document.createElement("div");
  languageField.className = "cm-lp-block-editor-field";
  const languageLabel = document.createElement("span");
  languageLabel.className = "cm-lp-block-editor-label";
  languageLabel.textContent = "Language";
  languageField.append(languageLabel, languageSelect, customLanguageInput);
  body.appendChild(languageField);

  const syncCustomLanguageVisibility = () => {
    customLanguageInput.style.display = languageSelect.value === "__custom__" ? "block" : "none";
  };
  languageSelect.addEventListener("change", () => {
    syncCustomLanguageVisibility();
    if (languageSelect.value === "__custom__") {
      requestAnimationFrame(() => customLanguageInput.focus());
    }
  });
  syncCustomLanguageVisibility();

  const codeInput = document.createElement("textarea");
  codeInput.className = "cm-lp-block-editor-textarea cm-lp-block-editor-textarea-code";
  codeInput.value = code;
  codeInput.spellcheck = false;
  body.appendChild(makeBlockEditorField("Code", codeInput));

  const deleteBtn = makeBlockEditorButton("Delete Source Block");
  deleteBtn.classList.add("cm-lp-block-editor-btn-danger");
  deleteBtn.addEventListener("click", (e) => {
    consumeEvent(e);
    deleteBlockRange(view, blockFrom, blockTo);
    close();
  });
  footerLeft.appendChild(deleteBtn);

  const cancelBtn = makeBlockEditorButton("Cancel");
  cancelBtn.addEventListener("click", (e) => {
    consumeEvent(e);
    close();
  });

  const saveBtn = makeBlockEditorButton("Save", "primary");
  saveBtn.addEventListener("click", (e) => {
    consumeEvent(e);
    const selectedLanguage = languageSelect.value === "__custom__" ? customLanguageInput.value : languageSelect.value;
    view.dispatch({
      changes: {
        from: blockFrom,
        to: blockTo,
        insert: serializeCodeBlock(selectedLanguage === "text" ? "" : selectedLanguage, codeInput.value, hadAttributeLine),
      },
    });
    close();
  });

  footerRight.append(cancelBtn, saveBtn);
  requestAnimationFrame(() => {
    overlay.focus();
    languageSelect.focus();
  });
}

function openTableBlockEditorModal(
  view: EditorView,
  headers: string[],
  rows: string[][],
  blockFrom: number,
  blockTo: number,
) {
  const { overlay, body, footerLeft, footerRight, close } = createBlockEditorModal(view, "Edit Table");

  const tableWidget = new TableEditWidget(headers, rows, blockFrom, blockTo, {
    liveSync: false,
    showDeleteButton: false,
  });
  const tableEditor = tableWidget.toDOM();
  tableEditor.classList.add("cm-lp-table-edit-modal");
  body.appendChild(tableEditor);

  const deleteBtn = makeBlockEditorButton("Delete Table");
  deleteBtn.classList.add("cm-lp-block-editor-btn-danger");
  deleteBtn.addEventListener("click", (e) => {
    consumeEvent(e);
    deleteBlockRange(view, blockFrom, blockTo);
    close();
  });
  footerLeft.appendChild(deleteBtn);

  const cancelBtn = makeBlockEditorButton("Cancel");
  cancelBtn.addEventListener("click", (e) => {
    consumeEvent(e);
    close();
  });

  const saveBtn = makeBlockEditorButton("Save", "primary");
  saveBtn.addEventListener("click", (e) => {
    consumeEvent(e);
    view.dispatch({
      changes: {
        from: blockFrom,
        to: blockTo,
        insert: serializeTableFromWrap(tableEditor),
      },
    });
    close();
  });

  footerRight.append(cancelBtn, saveBtn);
  requestAnimationFrame(() => {
    overlay.focus();
    const firstInput = tableEditor.querySelector<HTMLInputElement>(".cm-lp-table-input");
    firstInput?.focus();
    firstInput?.select();
  });
}

function openBlockquoteEditorModal(
  view: EditorView,
  author: string,
  content: string,
  blockFrom: number,
  blockTo: number,
  hadAttributeLine: boolean,
) {
  const { overlay, body, footerLeft, footerRight, close } = createBlockEditorModal(view, "Edit Quote Block");

  const authorInput = document.createElement("input");
  authorInput.type = "text";
  authorInput.className = "cm-lp-block-editor-input";
  authorInput.value = author;
  authorInput.spellcheck = false;
  body.appendChild(makeBlockEditorField("Attribution", authorInput));

  const contentInput = document.createElement("textarea");
  contentInput.className = "cm-lp-block-editor-textarea";
  contentInput.value = content;
  contentInput.spellcheck = true;
  body.appendChild(makeBlockEditorField("Quote", contentInput));

  const deleteBtn = makeBlockEditorButton("Delete Quote Block");
  deleteBtn.classList.add("cm-lp-block-editor-btn-danger");
  deleteBtn.addEventListener("click", (e) => {
    consumeEvent(e);
    deleteBlockRange(view, blockFrom, blockTo);
    close();
  });
  footerLeft.appendChild(deleteBtn);

  const cancelBtn = makeBlockEditorButton("Cancel");
  cancelBtn.addEventListener("click", (e) => {
    consumeEvent(e);
    close();
  });

  const saveBtn = makeBlockEditorButton("Save", "primary");
  saveBtn.addEventListener("click", (e) => {
    consumeEvent(e);
    view.dispatch({
      changes: {
        from: blockFrom,
        to: blockTo,
        insert: serializeBlockquote(authorInput.value, contentInput.value, hadAttributeLine),
      },
    });
    close();
  });

  footerRight.append(cancelBtn, saveBtn);
  requestAnimationFrame(() => {
    overlay.focus();
    authorInput.focus();
    authorInput.select();
  });
}

interface ImageBlockInfo {
  options: ImageInsertOptions & { source: "web" | "local" };
  blockFrom: number;
  blockTo: number;
}

async function browseImageFileFromModal() {
  const { openImageDialog, createResourceFromFile } = await import("../ipc");
  const result = await openImageDialog();
  if (!result.filePath) return "";
  // In Joplin, convert file to resource and return resource reference
  const resource = await createResourceFromFile(result.filePath);
  return resource.resourceId ? `:/${resource.resourceId}` : "";
}

function getImageBlockForLine(doc: any, lineNumber: number): ImageBlockInfo | null {
  const imageLine = doc.line(lineNumber);
  let caption = "";
  let blockFrom = imageLine.from;

  if (lineNumber > 1) {
    const previousLine = doc.line(lineNumber - 1);
    const trimmedPrevious = previousLine.text.trim();
    if (/^\.(?!\.)/.test(trimmedPrevious)) {
      caption = trimmedPrevious.slice(1);
      blockFrom = previousLine.from;
    }
  }

  const parsed = parseImageMacroLine(imageLine.text, caption);
  if (!parsed) return null;

  return {
    options: parsed,
    blockFrom,
    blockTo: imageLine.to,
  };
}

function openStemBlockEditorModal(
  view: EditorView,
  expression: string,
  notation: "stem" | "latexmath" | "asciimath",
  blockFrom: number,
  blockTo: number,
) {
  const { overlay, body, footerLeft, footerRight, close } = createBlockEditorModal(view, "Edit Math Block");

  // ── Notation selector ──
  const notationSelect = document.createElement("select");
  notationSelect.className = "cm-lp-block-editor-input";
  for (const opt of [
    { value: "latexmath", label: "LaTeX Math" },
    { value: "asciimath", label: "AsciiMath" },
    { value: "stem", label: "stem (document default)" },
  ]) {
    const el = document.createElement("option");
    el.value = opt.value;
    el.textContent = opt.label;
    notationSelect.appendChild(el);
  }
  notationSelect.value = notation;
  body.appendChild(makeBlockEditorField("Notation", notationSelect));

  // ── Math expression textarea ──
  const mathInput = document.createElement("textarea");
  mathInput.className = "cm-lp-block-editor-textarea cm-lp-block-editor-textarea-code";
  mathInput.value = expression;
  mathInput.spellcheck = false;
  mathInput.placeholder = notation === "asciimath"
    ? "e.g., sum_(i=1)^n i = (n(n+1))/2"
    : "e.g., \\int_0^\\infty e^{-x^2} dx = \\frac{\\sqrt{\\pi}}{2}";
  body.appendChild(makeBlockEditorField("Expression", mathInput));

  // ── Live preview panel ──
  const previewLabel = document.createElement("span");
  previewLabel.className = "cm-lp-block-editor-label";
  previewLabel.textContent = "Preview";
  body.appendChild(previewLabel);

  const preview = document.createElement("div");
  preview.className = "cm-lp-stemblock-preview";
  preview.style.cssText = "padding:16px;text-align:center;min-height:2em;" +
    "border:1px solid var(--asciidoc-border,#ddd);border-radius:4px;margin-top:4px";

  const updatePreview = () => {
    const n = notationSelect.value as MathNotation | "stem";
    preview.innerHTML = renderMath(mathInput.value, n === "stem" ? documentStemNotation : n, true);
    mathInput.placeholder = n === "asciimath"
      ? "e.g., sum_(i=1)^n i = (n(n+1))/2"
      : "e.g., \\int_0^\\infty e^{-x^2} dx = \\frac{\\sqrt{\\pi}}{2}";
  };
  updatePreview();
  mathInput.addEventListener("input", updatePreview);
  notationSelect.addEventListener("change", updatePreview);
  body.appendChild(preview);

  // ── Footer buttons ──
  const deleteBtn = makeBlockEditorButton("Delete Math Block");
  deleteBtn.classList.add("cm-lp-block-editor-btn-danger");
  deleteBtn.addEventListener("click", (e) => {
    consumeEvent(e);
    deleteBlockRange(view, blockFrom, blockTo);
    close();
  });
  footerLeft.appendChild(deleteBtn);

  const cancelBtn = makeBlockEditorButton("Cancel");
  cancelBtn.addEventListener("click", (e) => { consumeEvent(e); close(); });

  const saveBtn = makeBlockEditorButton("Save", "primary");
  saveBtn.addEventListener("click", (e) => {
    consumeEvent(e);
    const n = notationSelect.value;
    view.dispatch({
      changes: {
        from: blockFrom,
        to: blockTo,
        insert: serializeStemBlock(n, mathInput.value),
      },
    });
    close();
  });

  footerRight.append(cancelBtn, saveBtn);
  requestAnimationFrame(() => { overlay.focus(); mathInput.focus(); });
}

// ── Mermaid diagram type detection & syntax toolbar data ──

function detectMermaidType(source: string): string {
  for (const line of source.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("%%") || trimmed.startsWith("---")) continue;
    if (/^flowchart\b/i.test(trimmed) || /^graph\b/i.test(trimmed)) return "flowchart";
    if (/^sequenceDiagram/i.test(trimmed)) return "sequence";
    if (/^classDiagram/i.test(trimmed)) return "classDiagram";
    if (/^stateDiagram/i.test(trimmed)) return "stateDiagram";
    if (/^erDiagram/i.test(trimmed)) return "erDiagram";
    if (/^gantt/i.test(trimmed)) return "gantt";
    if (/^pie/i.test(trimmed)) return "pie";
    if (/^journey/i.test(trimmed)) return "journey";
    if (/^gitGraph/i.test(trimmed)) return "gitGraph";
    if (/^mindmap/i.test(trimmed)) return "mindmap";
    if (/^timeline/i.test(trimmed)) return "timeline";
    if (/^quadrantChart/i.test(trimmed)) return "quadrant";
    if (/^sankey/i.test(trimmed)) return "sankey";
    if (/^xychart/i.test(trimmed)) return "xychart";
    if (/^block-beta/i.test(trimmed)) return "block";
    if (/^packet-beta/i.test(trimmed)) return "packet";
    if (/^kanban/i.test(trimmed)) return "kanban";
    if (/^architecture/i.test(trimmed)) return "architecture";
    if (/^C4Context/i.test(trimmed)) return "c4context";
    if (/^C4Container/i.test(trimmed)) return "c4container";
    if (/^C4Component/i.test(trimmed)) return "c4component";
    if (/^C4Deployment/i.test(trimmed)) return "c4deployment";
    if (/^requirementDiagram/i.test(trimmed)) return "requirement";
    if (/^zenuml/i.test(trimmed)) return "zenuml";
    break;
  }
  return "flowchart";
}

interface MermaidSyntaxElement { label: string; syntax: string }

const mermaidSyntaxToolbar: Record<string, MermaidSyntaxElement[]> = {
  flowchart: [
    { label: "Rectangle", syntax: 'id["Label"]' },
    { label: "Round", syntax: 'id("Label")' },
    { label: "Diamond", syntax: 'id{"Label"}' },
    { label: "Arrow", syntax: "A --> B" },
    { label: "Arrow+Text", syntax: 'A -->|"text"| B' },
    { label: "Dotted", syntax: "A -.-> B" },
    { label: "Thick", syntax: "A ==> B" },
    { label: "Subgraph", syntax: "subgraph title\n    \nend" },
  ],
  sequence: [
    { label: "Participant", syntax: "participant Alice" },
    { label: "Actor", syntax: "actor User" },
    { label: "Message", syntax: "Alice->>Bob: Message" },
    { label: "Reply", syntax: "Alice-->>Bob: Reply" },
    { label: "Note", syntax: "Note over Alice,Bob: Text" },
    { label: "Alt", syntax: "alt Condition\n    Alice->>Bob: Yes\nelse Otherwise\n    Alice->>Bob: No\nend" },
    { label: "Loop", syntax: "loop Every minute\n    Alice->>Bob: Ping\nend" },
  ],
  classDiagram: [
    { label: "Class", syntax: "class ClassName {\n    +String field\n    +method() ReturnType\n}" },
    { label: "Inherit", syntax: "Parent <|-- Child" },
    { label: "Compose", syntax: "ClassA *-- ClassB" },
    { label: "Aggregate", syntax: "ClassA o-- ClassB" },
    { label: "Associate", syntax: "ClassA --> ClassB" },
  ],
  stateDiagram: [
    { label: "State", syntax: "State1 : Description" },
    { label: "Transition", syntax: "State1 --> State2" },
    { label: "Trans+Text", syntax: "State1 --> State2 : Event" },
    { label: "Start", syntax: "[*] --> State1" },
    { label: "End", syntax: "State1 --> [*]" },
    { label: "Choice", syntax: "state check <<choice>>\nState1 --> check\ncheck --> State2 : Yes\ncheck --> State3 : No" },
    { label: "Composite", syntax: "state CompositeState {\n    [*] --> Inner1\n    Inner1 --> [*]\n}" },
  ],
  erDiagram: [
    { label: "Entity", syntax: "ENTITY {\n    string name\n    int id PK\n}" },
    { label: "One-Many", syntax: 'PARENT ||--o{ CHILD : "has"' },
    { label: "One-One", syntax: 'TABLE_A ||--|| TABLE_B : "maps"' },
    { label: "Many-Many", syntax: 'TABLE_A }o--o{ TABLE_B : "relates"' },
    { label: "Attribute", syntax: "    string fieldName" },
  ],
  gantt: [
    { label: "Section", syntax: "section Section Name" },
    { label: "Task", syntax: "Task name : task1, 2026-04-01, 7d" },
    { label: "Active", syntax: "Active task : active, a1, 2026-04-01, 5d" },
    { label: "Done", syntax: "Done task : done, d1, 2026-03-01, 2026-03-15" },
    { label: "Milestone", syntax: "Milestone : milestone, m1, 2026-04-15, 0d" },
  ],
  mindmap: [
    { label: "Root", syntax: "root((Central Topic))" },
    { label: "Child", syntax: "    Topic" },
    { label: "Square", syntax: "    [Topic]" },
    { label: "Rounded", syntax: "    (Topic)" },
    { label: "Circle", syntax: "    ((Topic))" },
  ],
};

function openMermaidBlockEditorModal(
  view: EditorView,
  source: string,
  blockFrom: number,
  blockTo: number,
) {
  const { overlay, modal, body, footerLeft, footerRight, close } = createBlockEditorModal(view, "Edit Mermaid Diagram");
  modal.style.width = "min(1200px, 100%)";
  // Allow the body to expand and fill the modal for the two-panel layout
  body.style.flex = "1";
  body.style.minHeight = "0";
  body.style.overflow = "hidden";

  // ── Two-panel layout ──
  const panels = document.createElement("div");
  panels.className = "cm-lp-mermaid-editor-panels";

  const leftPanel = document.createElement("div");
  leftPanel.className = "cm-lp-mermaid-editor-left";

  const rightPanel = document.createElement("div");
  rightPanel.className = "cm-lp-mermaid-editor-right";

  // ── Diagram type selector (custom dropdown, not native <select>) ──
  const diagramTypes = [
    "flowchart", "sequence", "classDiagram", "stateDiagram", "erDiagram",
    "gantt", "pie", "journey", "gitGraph", "mindmap", "timeline", "quadrant",
    "sankey", "xychart", "block", "packet", "kanban", "architecture",
    "c4context", "c4container", "c4component", "c4deployment", "requirement", "zenuml",
  ];

  let selectedDiagramType = detectMermaidType(source);

  const typeDropdownWrap = document.createElement("div");
  typeDropdownWrap.className = "cm-lp-mermaid-type-dropdown";

  const typeButton = document.createElement("button");
  typeButton.type = "button";
  typeButton.className = "cm-lp-block-editor-input cm-lp-mermaid-type-btn";
  typeButton.textContent = selectedDiagramType;

  const typeArrow = document.createElement("span");
  typeArrow.className = "cm-lp-mermaid-type-arrow";
  typeArrow.textContent = "\u25BE"; // ▾
  typeButton.appendChild(typeArrow);

  const typeMenu = document.createElement("div");
  typeMenu.className = "cm-lp-mermaid-type-menu";

  function buildTypeMenu() {
    typeMenu.innerHTML = "";
    for (const t of diagramTypes) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "cm-lp-mermaid-type-item" + (t === selectedDiagramType ? " selected" : "");
      item.textContent = t;
      item.addEventListener("click", (e) => {
        e.stopPropagation();
        selectedDiagramType = t;
        typeButton.textContent = t;
        typeButton.appendChild(typeArrow);
        typeMenu.classList.remove("open");
        rebuildToolbar();
      });
      typeMenu.appendChild(item);
    }
  }
  buildTypeMenu();

  typeButton.addEventListener("click", (e) => {
    e.stopPropagation();
    typeMenu.classList.toggle("open");
  });

  // Close menu when clicking elsewhere in the modal
  modal.addEventListener("click", () => typeMenu.classList.remove("open"));

  typeDropdownWrap.append(typeButton, typeMenu);

  const typeField = makeBlockEditorField("Diagram Type", typeDropdownWrap);
  leftPanel.appendChild(typeField);

  // ── Context-sensitive syntax toolbar ──
  const toolbarWrap = document.createElement("div");
  toolbarWrap.className = "cm-lp-mermaid-syntax-toolbar";

  function rebuildToolbar() {
    toolbarWrap.innerHTML = "";
    const elements = mermaidSyntaxToolbar[selectedDiagramType] || [];
    for (const elem of elements) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "cm-lp-mermaid-syntax-btn";
      btn.textContent = elem.label;
      btn.title = elem.syntax.substring(0, 60);
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        const start = sourceInput.selectionStart;
        const before = sourceInput.value.substring(0, start);
        const after = sourceInput.value.substring(sourceInput.selectionEnd);
        const insertion = (before.length > 0 && !before.endsWith("\n") ? "\n" : "") + elem.syntax;
        sourceInput.value = before + insertion + after;
        sourceInput.selectionStart = sourceInput.selectionEnd = start + insertion.length;
        sourceInput.focus();
        updatePreview();
      });
      toolbarWrap.appendChild(btn);
    }
  }
  rebuildToolbar();
  leftPanel.appendChild(toolbarWrap);

  // Type change is handled by the custom dropdown click handlers above

  // ── Source textarea ──
  const sourceInput = document.createElement("textarea");
  sourceInput.className = "cm-lp-block-editor-textarea cm-lp-block-editor-textarea-code";
  sourceInput.value = source;
  sourceInput.spellcheck = false;
  sourceInput.placeholder = "flowchart LR\n    A[Start] --> B[Process] --> C[End]";
  sourceInput.style.flex = "1";
  sourceInput.style.minHeight = "200px";
  leftPanel.appendChild(sourceInput);

  // ── Live preview (right panel) with zoom & pan ──
  const preview = document.createElement("div");
  preview.className = "cm-lp-mermaid-preview-inner";

  let scale = 1;
  let panX = 0;
  let panY = 0;

  function applyTransform() {
    preview.style.transform = `translate(${panX}px, ${panY}px) scale(${scale})`;
  }

  // Zoom via scroll wheel
  rightPanel.addEventListener("wheel", (e) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? -0.1 : 0.1;
    scale = Math.min(5, Math.max(0.1, scale + delta));
    applyTransform();
  }, { passive: false });

  // Pan via click-drag
  let isPanning = false;
  let panStartX = 0;
  let panStartY = 0;
  let panOriginX = 0;
  let panOriginY = 0;

  rightPanel.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    isPanning = true;
    panStartX = e.clientX;
    panStartY = e.clientY;
    panOriginX = panX;
    panOriginY = panY;
    rightPanel.style.cursor = "grabbing";
    e.preventDefault();
  });

  const onMouseMove = (e: MouseEvent) => {
    if (!isPanning) return;
    panX = panOriginX + (e.clientX - panStartX);
    panY = panOriginY + (e.clientY - panStartY);
    applyTransform();
  };

  const onMouseUp = () => {
    if (!isPanning) return;
    isPanning = false;
    rightPanel.style.cursor = "grab";
  };

  // Use capture phase so we catch mouseup before the modal's stopPropagation handlers
  document.addEventListener("mousemove", onMouseMove, true);
  document.addEventListener("mouseup", onMouseUp, true);

  // Clean up document listeners when modal closes
  const origClose = close;
  const closeWithCleanup = () => {
    document.removeEventListener("mousemove", onMouseMove, true);
    document.removeEventListener("mouseup", onMouseUp, true);
    origClose();
  };

  function resetView() {
    scale = 1;
    panX = 0;
    panY = 0;
    applyTransform();
  }

  let previewTimer: ReturnType<typeof setTimeout> | null = null;
  const updatePreview = () => {
    if (previewTimer) clearTimeout(previewTimer);
    previewTimer = setTimeout(async () => {
      const src = sourceInput.value.trim();
      if (!src) {
        preview.innerHTML = '<span style="color:var(--asciidoc-placeholder,#888);font-style:italic">[empty diagram]</span>';
        return;
      }
      try {
        const mm = getMermaidModule();
        const id = `mermaid-modal-${Date.now()}`;
        const { svg } = await mm.render(id, src);
        preview.innerHTML = svg;
        const svgEl = preview.querySelector("svg");
        if (svgEl) { svgEl.style.maxWidth = "100%"; svgEl.style.height = "auto"; }
      } catch (e: any) {
        const msg = (e.message || String(e)).replace(/</g, "&lt;").replace(/>/g, "&gt;");
        preview.innerHTML = `<div style="color:#d9534f;font-style:italic;padding:12px">${msg}</div>`;
      }
    }, 300);
  };
  updatePreview();
  sourceInput.addEventListener("input", updatePreview);
  rightPanel.appendChild(preview);

  panels.append(leftPanel, rightPanel);
  body.appendChild(panels);

  // ── Footer buttons ──
  const deleteBtn = makeBlockEditorButton("Delete Diagram");
  deleteBtn.classList.add("cm-lp-block-editor-btn-danger");
  deleteBtn.addEventListener("click", (e) => {
    consumeEvent(e);
    deleteBlockRange(view, blockFrom, blockTo);
    closeWithCleanup();
  });
  footerLeft.appendChild(deleteBtn);

  const resetViewBtn = makeBlockEditorButton("Reset View");
  resetViewBtn.addEventListener("click", (e) => {
    consumeEvent(e);
    resetView();
  });
  footerLeft.appendChild(resetViewBtn);

  const cancelBtn = makeBlockEditorButton("Cancel");
  cancelBtn.addEventListener("click", (e) => { consumeEvent(e); closeWithCleanup(); });

  const saveBtn = makeBlockEditorButton("Save", "primary");
  saveBtn.addEventListener("click", (e) => {
    consumeEvent(e);
    view.dispatch({
      changes: {
        from: blockFrom,
        to: blockTo,
        insert: serializeMermaidBlock(sourceInput.value),
      },
    });
    closeWithCleanup();
  });

  footerRight.append(cancelBtn, saveBtn);
  requestAnimationFrame(() => { overlay.focus(); sourceInput.focus(); });
}

function openImageEditorModal(view: EditorView, info: ImageBlockInfo) {
  const { overlay, body, footerLeft, footerRight, close } = createBlockEditorModal(view, "Edit Image");

  let imageSource: "web" | "local" = info.options.source;
  let imagePickerError = "";

  const webTab = document.createElement("button");
  webTab.type = "button";
  webTab.className = "cm-lp-block-editor-tab";
  webTab.textContent = "Web";

  const localTab = document.createElement("button");
  localTab.type = "button";
  localTab.className = "cm-lp-block-editor-tab";
  localTab.textContent = "Local";

  const tabBar = document.createElement("div");
  tabBar.className = "cm-lp-block-editor-tabs";
  tabBar.append(webTab, localTab);
  body.appendChild(tabBar);

  const webTargetInput = document.createElement("input");
  webTargetInput.type = "text";
  webTargetInput.className = "cm-lp-block-editor-input";
  webTargetInput.value = imageSource === "web" ? info.options.target : "";
  webTargetInput.placeholder = "https://example.com/image.png";
  webTargetInput.spellcheck = false;

  const localTargetInput = document.createElement("input");
  localTargetInput.type = "text";
  localTargetInput.className = "cm-lp-block-editor-input cm-lp-block-editor-input-readonly";
  localTargetInput.value = imageSource === "local" ? info.options.target : "";
  localTargetInput.placeholder = "No file selected";
  localTargetInput.readOnly = true;
  localTargetInput.spellcheck = false;

  const browseButton = makeBlockEditorButton("Browse...");
  browseButton.classList.add("cm-lp-block-editor-browse");

  const pickerError = document.createElement("div");
  pickerError.className = "cm-lp-block-editor-error";

  const localFieldRow = document.createElement("div");
  localFieldRow.className = "cm-lp-block-editor-inline-row";
  localFieldRow.append(browseButton, localTargetInput);

  const webTargetField = makeBlockEditorField("Image URL", webTargetInput);
  const localTargetField = makeBlockEditorField("Browse...", localFieldRow);
  localTargetField.appendChild(pickerError);
  body.append(webTargetField, localTargetField);

  const altInput = document.createElement("input");
  altInput.type = "text";
  altInput.className = "cm-lp-block-editor-input";
  altInput.value = info.options.alt;
  altInput.placeholder = "Description";
  body.appendChild(makeBlockEditorField("ALT TEXT", altInput));

  // Scale slider
  const scaleValue = document.createElement("span");
  scaleValue.className = "cm-lp-block-editor-range-value";
  const scaleInput = document.createElement("input");
  scaleInput.type = "range";
  scaleInput.className = "cm-lp-block-editor-range";
  scaleInput.min = "10";
  scaleInput.max = "200";
  scaleInput.step = "5";
  scaleInput.value = String(info.options.width);
  const scaleHeader = document.createElement("div");
  scaleHeader.className = "cm-lp-block-editor-range-header";
  scaleHeader.innerHTML = "<span class='cm-lp-block-editor-label'>SCALE</span>";
  scaleHeader.appendChild(scaleValue);
  const scaleField = document.createElement("div");
  scaleField.className = "cm-lp-block-editor-field";
  scaleField.append(scaleHeader, scaleInput);
  body.appendChild(scaleField);

  // Align
  const alignSelect = document.createElement("select");
  alignSelect.className = "cm-lp-block-editor-input";
  for (const optionValue of ["center", "left", "right"] as const) {
    const option = document.createElement("option");
    option.value = optionValue;
    option.textContent = optionValue.toUpperCase();
    alignSelect.appendChild(option);
  }
  alignSelect.value = info.options.align;
  body.appendChild(makeBlockEditorField("ALIGN", alignSelect));

  // Title
  const titleInput = document.createElement("input");
  titleInput.type = "text";
  titleInput.className = "cm-lp-block-editor-input";
  titleInput.value = info.options.title;
  titleInput.placeholder = "Image title";
  body.appendChild(makeBlockEditorField("TITLE", titleInput));

  // Caption
  const captionInput = document.createElement("input");
  captionInput.type = "text";
  captionInput.className = "cm-lp-block-editor-input";
  captionInput.value = info.options.caption;
  captionInput.placeholder = "Caption shown with the image";
  body.appendChild(makeBlockEditorField("CAPTION", captionInput));

  // Caption Position — options depend on align value
  const captionPosSelect = document.createElement("select");
  captionPosSelect.className = "cm-lp-block-editor-input";
  const captionPosField = makeBlockEditorField("CAPTION POSITION", captionPosSelect);
  body.appendChild(captionPosField);

  const updateCaptionPosOptions = () => {
    const align = alignSelect.value;
    captionPosSelect.innerHTML = "";
    const belowOpt = document.createElement("option");
    belowOpt.value = "below";
    belowOpt.textContent = "BELOW";
    captionPosSelect.appendChild(belowOpt);

    if (align === "left") {
      const rightOpt = document.createElement("option");
      rightOpt.value = "right";
      rightOpt.textContent = "RIGHT";
      captionPosSelect.appendChild(rightOpt);
    } else if (align === "right") {
      const leftOpt = document.createElement("option");
      leftOpt.value = "left";
      leftOpt.textContent = "LEFT";
      captionPosSelect.appendChild(leftOpt);
    }
    // Restore previous value if still valid
    const prev = info.options.captionPosition || "below";
    const validValues = Array.from(captionPosSelect.options).map(o => o.value);
    captionPosSelect.value = validValues.includes(prev) ? prev : "below";
  };
  updateCaptionPosOptions();
  alignSelect.addEventListener("change", updateCaptionPosOptions);

  const deleteBtn = makeBlockEditorButton("Delete Image");
  deleteBtn.classList.add("cm-lp-block-editor-btn-danger");
  deleteBtn.addEventListener("click", (e) => {
    consumeEvent(e);
    deleteBlockRange(view, info.blockFrom, info.blockTo);
    close();
  });
  footerLeft.appendChild(deleteBtn);

  const cancelBtn = makeBlockEditorButton("Cancel");
  cancelBtn.addEventListener("click", (e) => {
    consumeEvent(e);
    close();
  });

  const saveBtn = makeBlockEditorButton("Save", "primary");

  const getCurrentTarget = () => imageSource === "web" ? webTargetInput.value : localTargetInput.value;
  const syncSaveState = () => {
    saveBtn.disabled = !getCurrentTarget().trim();
  };
  const syncTabState = () => {
    webTab.classList.toggle("active", imageSource === "web");
    localTab.classList.toggle("active", imageSource === "local");
    webTargetField.style.display = imageSource === "web" ? "flex" : "none";
    localTargetField.style.display = imageSource === "local" ? "flex" : "none";
    pickerError.textContent = imagePickerError;
    syncSaveState();
  };
  const syncRangeLabels = () => {
    scaleValue.textContent = `${scaleInput.value}%`;
  };

  webTab.addEventListener("click", (e) => {
    consumeEvent(e);
    imageSource = "web";
    imagePickerError = "";
    syncTabState();
  });
  localTab.addEventListener("click", (e) => {
    consumeEvent(e);
    imageSource = "local";
    imagePickerError = "";
    syncTabState();
  });
  browseButton.addEventListener("click", async (e) => {
    consumeEvent(e);
    imagePickerError = "";
    try {
      const selected = await browseImageFileFromModal();
      if (selected) {
        localTargetInput.value = selected;
      }
    } catch (error) {
      imagePickerError = "Couldn't open the file picker.";
      console.error("Failed to browse for image:", error);
    }
    syncTabState();
  });
  webTargetInput.addEventListener("input", syncSaveState);
  scaleInput.addEventListener("input", syncRangeLabels);

  saveBtn.addEventListener("click", (e) => {
    consumeEvent(e);
    const block = serializeImageBlock({
      target: getCurrentTarget(),
      alt: altInput.value,
      title: titleInput.value,
      caption: captionInput.value,
      width: Number.parseInt(scaleInput.value, 10),
      height: Number.parseInt(scaleInput.value, 10),
      align: alignSelect.value as ImageInsertOptions["align"],
      captionPosition: captionPosSelect.value as ImageInsertOptions["captionPosition"],
    });
    if (!block) return;

    view.dispatch({
      changes: {
        from: info.blockFrom,
        to: info.blockTo,
        insert: block,
      },
    });
    close();
  });

  footerRight.append(cancelBtn, saveBtn);
  syncRangeLabels();
  syncTabState();

  requestAnimationFrame(() => {
    overlay.focus();
    (imageSource === "web" ? webTargetInput : browseButton).focus();
    if (imageSource === "web") {
      webTargetInput.select();
    }
  });
}

function schedulePreviewHeightMeasurement(view: EditorView, cache: PreviewHeightCache) {
  view.requestMeasure({
    read(view) {
      const lineHeights = new Map<number, number>();
      for (const element of view.dom.querySelectorAll<HTMLElement>(`[${LINE_HEIGHT_DATA_ATTR}]`)) {
        const rawFrom = element.getAttribute(LINE_HEIGHT_DATA_ATTR);
        if (!rawFrom) continue;
        const from = Number.parseInt(rawFrom, 10);
        if (!Number.isFinite(from)) continue;
        const renderedLine = element.closest(".cm-line");
        const measurementTarget = renderedLine instanceof HTMLElement ? renderedLine : element;
        const height = measureElementHeightPx(measurementTarget);
        if (height > 0) {
          lineHeights.set(from, Math.max(height, lineHeights.get(from) ?? 0));
        }
      }
      return { lineHeights };
    },
    write(measured) {
      for (const [from, height] of measured.lineHeights) {
        cache.lineHeights.set(from, height);
      }
    },
  });
}

function stabilizedLineDecoration(renderedHeightPx: number, rawHeightPx: number): Decoration | null {
  if (!Number.isFinite(renderedHeightPx) || renderedHeightPx <= rawHeightPx + MIN_HEIGHT_DELTA_PX) {
    return null;
  }

  const safeRawHeight = Math.ceil(rawHeightPx);
  const safeRenderedHeight = Math.ceil(renderedHeightPx);
  const heightDelta = Math.max(0, safeRenderedHeight - safeRawHeight);
  const paddingTop = Math.floor(heightDelta / 2);
  const paddingBottom = Math.ceil(heightDelta / 2);

  return Decoration.line({
    class: "cm-lp-stabilized-line",
    attributes: {
      style: [
        `min-height:${safeRawHeight}px`,
        `padding-top:${paddingTop}px`,
        `padding-bottom:${paddingBottom}px`,
      ].join(";"),
    },
  });
}

function estimateListLineHeightPx(rawHeightPx: number): number {
  const estimatedFontSizePx = rawHeightPx / 1.6;
  const listPaddingPx = Math.round(estimatedFontSizePx * LIST_LINE_PADDING_EM);
  return rawHeightPx + (listPaddingPx * 2);
}

function estimateHeadingLineHeightPx(rawHeightPx: number, level: number): number {
  // Heading font-size multipliers from renderLineHtml: 2em, 1.5em, 1.25em, 1.1em, 1em
  const sizeMultipliers = [2, 1.5, 1.25, 1.1, 1];
  const multiplier = sizeMultipliers[Math.min(level - 1, 4)];
  // line-height for headings is 1.4 (from theme), raw line uses ~1.6
  const headingLineHeight = rawHeightPx * multiplier * (1.4 / 1.6);
  // H1/H2 have margin: 0.8em top + 0.4em bottom + padding-bottom
  if (level <= 2) {
    const emSize = rawHeightPx / 1.6;
    const marginTop = emSize * 0.8;
    const marginBottom = emSize * 0.4;
    const paddingBottom = emSize * (level === 1 ? 0.3 : 0.2);
    return headingLineHeight + marginTop + marginBottom + paddingBottom;
  }
  return headingLineHeight;
}

function isParagraphLikeLine(trimmedText: string): boolean {
  if (!trimmedText) return false;
  if (/^(={1,6})\s+/.test(trimmedText)) return false;
  if (trimmedText === "'''") return false;
  if (/^(NOTE|TIP|WARNING|CAUTION|IMPORTANT|QUESTION):\s+/.test(trimmedText)) return false;
  if (/^(-{4,}|={4,}|_{4,}|\.{4,}|\+{4,}|\/{4,})$/.test(trimmedText)) return false;
  if (/^\[.+\]$/.test(trimmedText) && !trimmedText.startsWith("[[")) return false;
  if (/^\[\[.+\]\]$/.test(trimmedText)) return false;
  if(/^(\*{1,5})\s+\[([ x])\]\s+/.test(trimmedText)) return false;
  if (/^(\*{1,5})\s+/.test(trimmedText)) return false;
  if (/^(\.{1,5})\s+/.test(trimmedText)) return false;
  if (/^.+::\s*/.test(trimmedText) && !trimmedText.startsWith("image:") && !trimmedText.startsWith("link:")) return false;
  if (trimmedText === "|===") return false;
  if (trimmedText.startsWith("|")) return false;
  if (/^image::.+\[(.*)?\]$/.test(trimmedText)) return false;
  if (trimmedText.startsWith("include::")) return false;
  return true;
}

function estimateParagraphRawLineHeightPx(renderedHeightPx: number, rawHeightPx: number): number {
  if (!Number.isFinite(renderedHeightPx) || renderedHeightPx <= rawHeightPx * 1.35) {
    return rawHeightPx;
  }

  const wrappedRowCount = Math.max(1, Math.ceil(renderedHeightPx / rawHeightPx));
  return wrappedRowCount * rawHeightPx;
}

function estimateCodeBlockHeightPx(codeLineCount: number, rawBaseHeightPx: number): number {
  const baseFontPx = rawBaseHeightPx / 1.6;
  const headerHeight = baseFontPx * CODE_HEADER_FONT_EM * CODE_HEADER_LINE_HEIGHT
                     + baseFontPx * CODE_HEADER_PADDING_EM * 2;
  const bodyPadding = baseFontPx * CODE_BODY_PADDING_EM * 2;
  return headerHeight + (codeLineCount * rawBaseHeightPx) + bodyPadding;
}

function buildContentBlockPreviewLines(
  doc: any,
  openLine: number,
  closeLine: number,
  listNumbers: Map<number, number>,
): Array<{ html: string; empty: boolean }> {
  const rawLines: Array<{ text: string; lineNumber: number }> = [];
  for (let lineNumber = openLine + 1; lineNumber < closeLine; lineNumber++) {
    rawLines.push({ text: doc.line(lineNumber).text, lineNumber });
  }

  let start = 0;
  let end = rawLines.length;
  while (start < end && !rawLines[start].text.trim()) start++;
  while (end > start && !rawLines[end - 1].text.trim()) end--;

  const trimmed = rawLines.slice(start, end);
  const collapsed: Array<{ html: string; empty: boolean }> = [];
  let previousWasEmpty = false;

  let idx = 0;
  while (idx < trimmed.length) {
    const entry = trimmed[idx];
    const text = entry.text;
    const trimmedText = text.trim();

    // Detect source/code blocks: [source,lang] followed by ---- ... ----
    const sourceAttrMatch = trimmedText.match(/^\[source(?:,([^\]]*))?\]$/);
    if (sourceAttrMatch) {
      const lang = (sourceAttrMatch[1] || "").trim();
      // Look for ---- on next line
      if (idx + 1 < trimmed.length && trimmed[idx + 1].text.trim() === "----") {
        // Find closing ----
        let codeEnd = -1;
        for (let j = idx + 2; j < trimmed.length; j++) {
          if (trimmed[j].text.trim() === "----") {
            codeEnd = j;
            break;
          }
        }
        if (codeEnd >= 0) {
          // Collect code lines
          const codeLines: string[] = [];
          for (let j = idx + 2; j < codeEnd; j++) {
            codeLines.push(trimmed[j].text);
          }
          const langLabel = lang ? lang.toUpperCase() : "CODE";
          const codeHtml = `<div class="cm-lp-codeblock" style="margin:0.4em 0"><div class="cm-lp-codeblock-header">${escapeHtml(langLabel)}</div><pre class="cm-lp-codeblock-pre"><code>${escapeHtml(codeLines.join("\n"))}</code></pre></div>`;
          collapsed.push({ html: codeHtml, empty: false });
          previousWasEmpty = false;
          idx = codeEnd + 1;
          continue;
        }
      }
    }

    // Also detect bare ---- blocks without [source] attribute
    if (trimmedText === "----" && !sourceAttrMatch) {
      let codeEnd = -1;
      for (let j = idx + 1; j < trimmed.length; j++) {
        if (trimmed[j].text.trim() === "----") {
          codeEnd = j;
          break;
        }
      }
      if (codeEnd >= 0) {
        const codeLines: string[] = [];
        for (let j = idx + 1; j < codeEnd; j++) {
          codeLines.push(trimmed[j].text);
        }
        const codeHtml = `<div class="cm-lp-codeblock" style="margin:0.4em 0"><div class="cm-lp-codeblock-header">CODE</div><pre class="cm-lp-codeblock-pre"><code>${escapeHtml(codeLines.join("\n"))}</code></pre></div>`;
        collapsed.push({ html: codeHtml, empty: false });
        previousWasEmpty = false;
        idx = codeEnd + 1;
        continue;
      }
    }

    // Detect stem blocks: [stem|latexmath|asciimath] followed by ++++
    const stemInnerMatch = trimmedText.match(/^\[(stem|latexmath|asciimath)\]$/);
    if (stemInnerMatch && idx + 1 < trimmed.length) {
      const nextTrimmed = trimmed[idx + 1].text.trim();
      if (/^\+{4,}$/.test(nextTrimmed)) {
        let stemEnd = -1;
        for (let j = idx + 2; j < trimmed.length; j++) {
          if (/^\+{4,}$/.test(trimmed[j].text.trim())) { stemEnd = j; break; }
        }
        if (stemEnd >= 0) {
          const stemLines: string[] = [];
          for (let j = idx + 2; j < stemEnd; j++) stemLines.push(trimmed[j].text);
          const resolvedNotation = resolveStemNotation(stemInnerMatch[1] as "stem" | "latexmath" | "asciimath");
          const mathHtml = `<div class="cm-lp-stemblock" style="margin:0.4em 0;padding:0.6em;text-align:center;border:1px solid var(--lp-special-block-border,rgba(128,128,128,0.15));border-radius:4px">${renderMath(stemLines.join("\n"), resolvedNotation, true)}</div>`;
          collapsed.push({ html: mathHtml, empty: false });
          previousWasEmpty = false;
          idx = stemEnd + 1;
          continue;
        }
      }
    }

    if (!trimmedText) {
      if (!previousWasEmpty && collapsed.length > 0) {
        collapsed.push({ html: "&nbsp;", empty: true });
      }
      previousWasEmpty = true;
      idx++;
      continue;
    }

    collapsed.push({
      html: renderLineHtml(text, entry.lineNumber, listNumbers),
      empty: false,
    });
    previousWasEmpty = false;
    idx++;
  }

  return collapsed.length > 0 ? collapsed : [{ html: "&nbsp;", empty: true }];
}

function editorHasActiveFocus(view: EditorView): boolean {
  // If the CM6 search panel is open, treat as focused even if the search input has focus
  // (clicking "next"/"previous" buttons in the search panel momentarily blurs the editor)
  const searchPanelOpen = view.dom.querySelector(".cm-panel.cm-search") != null;
  if (searchPanelOpen) return true;

  if (!view.hasFocus) return false;

  const root = view.dom.getRootNode();
  const activeElement = root instanceof ShadowRoot || root instanceof Document
    ? root.activeElement
    : document.activeElement;

  return activeElement instanceof HTMLElement && view.dom.contains(activeElement);
}

function getBlockStartLineNumber(block: BlockInfo): number {
  if (block.type === "docheader") return block.startLine;
  if (block.type === "code" && block.attrLine > 0) return block.attrLine;
  if (block.type === "blockquote" && block.attrLine > 0) return block.attrLine;
  if (block.type === "table" && block.attrLine > 0) return block.attrLine;
  if (block.type === "stem") return block.attrLine;
  if (block.type === "mermaid") return block.attrLine;
  if (block.type === "image" && block.titleLine > 0) return block.titleLine;
  if (block.type === "contentblock" && block.titleLine > 0) return block.titleLine;
  if (block.type === "contentblock" && block.attrLine > 0) return block.attrLine;
  if (block.type === "image") return block.imageLine;
  return block.openLine;
}

function getBlockEndLineNumber(block: BlockInfo): number {
  if (block.type === "docheader") return block.endLine;
  if (block.type === "image") return block.imageLine;
  if (block.type === "stem") return block.closeLine;
  if (block.type === "mermaid") return block.closeLine;
  return block.closeLine;
}

function getPreviewBlockForLine(doc: any, lineNumber: number): { block: BlockInfo; blockStart: number; blockEnd: number } | null {
  const blocks = detectBlocks(doc);

  for (const block of blocks) {
    const blockStart = getBlockStartLineNumber(block);
    const blockEnd = getBlockEndLineNumber(block);
    if (lineNumber >= blockStart && lineNumber <= blockEnd) {
      return { block, blockStart, blockEnd };
    }
  }

  return null;
}

function openPreviewBlockModal(view: EditorView, blockInfo: { block: BlockInfo; blockStart: number; blockEnd: number }): boolean {
  const { block, blockStart, blockEnd } = blockInfo;
  const blockFrom = view.state.doc.line(blockStart).from;
  const blockTo = view.state.doc.line(blockEnd).to;

  if (block.type === "stem") {
    let mathContent = "";
    for (let j = block.openLine + 1; j < block.closeLine; j++) {
      if (mathContent) mathContent += "\n";
      mathContent += view.state.doc.line(j).text;
    }
    openStemBlockEditorModal(view, mathContent, block.rawNotation, blockFrom, blockTo);
    return true;
  }

  if (block.type === "mermaid") {
    let diagramSource = "";
    for (let j = block.openLine + 1; j < block.closeLine; j++) {
      if (diagramSource) diagramSource += "\n";
      diagramSource += view.state.doc.line(j).text;
    }
    openMermaidBlockEditorModal(view, diagramSource, blockFrom, blockTo);
    return true;
  }

  if (block.type === "image") {
    openImageEditorModal(view, {
      options: block.options,
      blockFrom,
      blockTo,
    });
    return true;
  }

  if (block.type === "contentblock") {
    return false;
  }

  if (block.type === "code") {
    let codeText = "";
    for (let j = block.openLine + 1; j < block.closeLine; j++) {
      if (codeText) codeText += "\n";
      codeText += view.state.doc.line(j).text;
    }
    openCodeBlockEditorModal(view, block.language, codeText, blockFrom, blockTo, block.attrLine > 0);
    return true;
  }

  if (block.type === "table") {
    const { headers, rows } = parseTable(view.state.doc, block.openLine, block.closeLine);
    openTableBlockEditorModal(view, headers, rows, blockFrom, blockTo);
    return true;
  }

  if (block.type !== "blockquote") {
    return false;
  }

  let rawQuoteContent = "";
  const contentLines: string[] = [];
  for (let j = block.openLine + 1; j < block.closeLine; j++) {
    const rawLineText = view.state.doc.line(j).text;
    if (rawQuoteContent) rawQuoteContent += "\n";
    rawQuoteContent += rawLineText;
    const trimmed = rawLineText.trim();
    if (trimmed) contentLines.push(trimmed);
  }

  openBlockquoteEditorModal(view, block.author, rawQuoteContent, blockFrom, blockTo, block.attrLine > 0);
  return true;
}

function openPreviewBlockModalForLine(view: EditorView, lineNumber: number): boolean {
  const cursorLine = view.state.doc.lineAt(view.state.selection.main.head).number;
  const blockInfo = getPreviewBlockForLine(view.state.doc, lineNumber);
  if (!blockInfo) return false;

  const cursorInBlock = cursorLine >= blockInfo.blockStart && cursorLine <= blockInfo.blockEnd;
  if (cursorInBlock || lineNumber !== blockInfo.blockStart) return false;

  return openPreviewBlockModal(view, blockInfo);
}

function handlePreviewBlockArrowNavigation(view: EditorView, direction: 1 | -1): boolean {
  if (blockEditorOverlay) return false;

  const currentLine = view.state.doc.lineAt(view.state.selection.main.head).number;
  const targetLine = currentLine + direction;

  if (targetLine < 1 || targetLine > view.state.doc.lines) return false;

  const blockInfo = getPreviewBlockForLine(view.state.doc, targetLine);
  if (!blockInfo) return false;

  const currentInsideSameBlock = currentLine >= blockInfo.blockStart && currentLine <= blockInfo.blockEnd;
  if (currentInsideSameBlock) return false;

  const returnLine = direction > 0
    ? (blockInfo.blockEnd < view.state.doc.lines ? blockInfo.blockEnd + 1 : Math.max(1, blockInfo.blockStart - 1))
    : (blockInfo.blockStart > 1 ? blockInfo.blockStart - 1 : Math.min(view.state.doc.lines, blockInfo.blockEnd + 1));

  clearPendingPreviewClick();
  if (blockInfo.block.type === "contentblock") {
    view.dispatch({ selection: { anchor: view.state.doc.line(blockInfo.blockStart).from } });
    return true;
  }

  if (overlayEditingMode) {
    view.dispatch({ selection: { anchor: view.state.doc.line(returnLine).from } });
    return openPreviewBlockModal(view, blockInfo);
  } else {
    // Without overlay mode, just move cursor into the block
    view.dispatch({ selection: { anchor: view.state.doc.line(blockInfo.blockStart).from } });
    return true;
  }
}

function detectBlocks(doc: any): BlockInfo[] {
  const blocks: BlockInfo[] = [];
  let i = 1;

  // Detect document header block at the very top of the document.
  // The block covers only the :name: value attribute lines (not the = Title heading).
  {
    let headerStart = -1;
    let headerEnd = -1;
    const attributes: Array<{ name: string; value: string }> = [];
    let ln = 1;

    // Skip optional document title (= Title) — it renders as a normal heading
    if (ln <= doc.lines && /^=\s+/.test(doc.line(ln).text.trim())) {
      ln++;
    }

    // Scan contiguous attribute lines (:name: value)
    while (ln <= doc.lines) {
      const lineText = doc.line(ln).text.trim();
      if (!lineText) break; // blank line ends header
      const attrMatch = lineText.match(/^:([^:]+):\s*(.*)$/);
      if (attrMatch && !lineText.startsWith("::")) {
        attributes.push({ name: attrMatch[1], value: attrMatch[2] });
        if (headerStart < 0) headerStart = ln;
        headerEnd = ln;
        ln++;
      } else {
        break;
      }
    }

    if (attributes.length > 0 && headerStart > 0) {
      blocks.push({
        type: "docheader",
        startLine: headerStart,
        endLine: headerEnd,
        title: "",
        attributes,
      });
      i = headerEnd + 1;
    }
  }

  while (i <= doc.lines) {
    const text = doc.line(i).text.trim();
    const imageLineText = doc.line(i).text;

    const imageWithTitle = /^\.(?!\.)/.test(text) && i + 1 <= doc.lines
      ? parseImageMacroLine(doc.line(i + 1).text, text.slice(1))
      : null;
    if (imageWithTitle) {
      blocks.push({ type: "image", titleLine: i, imageLine: i + 1, options: imageWithTitle });
      i += 2;
      continue;
    }

    const standaloneImage = parseImageMacroLine(imageLineText);
    if (standaloneImage) {
      blocks.push({ type: "image", titleLine: -1, imageLine: i, options: standaloneImage });
      i += 1;
      continue;
    }

    const titleMatch = text.match(/^\.(?!\.)(.+)$/);
    if (titleMatch && i + 1 <= doc.lines) {
      const nextText = doc.line(i + 1).text.trim();
      const nextNextText = i + 2 <= doc.lines ? doc.line(i + 2).text.trim() : "";

      if (/^\[%collapsible[^\]]*\]$/.test(nextText) && /^={4,}$/.test(nextNextText)) {
        let closeLine = -1;
        for (let j = i + 3; j <= doc.lines; j++) {
          if (/^={4,}$/.test(doc.line(j).text.trim())) {
            closeLine = j;
            break;
          }
        }
        if (closeLine > 0) {
          blocks.push({
            type: "contentblock",
            kind: "collapsible",
            titleLine: i,
            attrLine: i + 1,
            openLine: i + 2,
            closeLine,
            title: titleMatch[1].trim(),
          });
          i = closeLine + 1;
          continue;
        }
      }

      if (/^\*{4,}$/.test(nextText) || /^={4,}$/.test(nextText)) {
        const kind = /^\*{4,}$/.test(nextText) ? "sidebar" : "example";
        let closeLine = -1;
        const delimiterPattern = kind === "sidebar" ? /^\*{4,}$/ : /^={4,}$/;
        for (let j = i + 2; j <= doc.lines; j++) {
          if (delimiterPattern.test(doc.line(j).text.trim())) {
            closeLine = j;
            break;
          }
        }
        if (closeLine > 0) {
          blocks.push({
            type: "contentblock",
            kind,
            titleLine: i,
            attrLine: -1,
            openLine: i + 1,
            closeLine,
            title: titleMatch[1].trim(),
          });
          i = closeLine + 1;
          continue;
        }
      }
    }

    // Detect admonition block: [NOTE], [TIP], [WARNING], [CAUTION], [IMPORTANT] followed by ====
    const admonBlockMatch = text.match(/^\[(NOTE|TIP|WARNING|CAUTION|IMPORTANT)\]$/);
    if (admonBlockMatch && i + 1 <= doc.lines) {
      const nextText = doc.line(i + 1).text.trim();
      if (/^={4,}$/.test(nextText)) {
        let closeLine = -1;
        for (let j = i + 2; j <= doc.lines; j++) {
          if (/^={4,}$/.test(doc.line(j).text.trim())) {
            closeLine = j;
            break;
          }
        }
        if (closeLine > 0) {
          blocks.push({
            type: "contentblock",
            kind: "admonition",
            titleLine: -1,
            attrLine: i,
            openLine: i + 1,
            closeLine,
            title: "",
            admonitionType: admonBlockMatch[1].toLowerCase(),
          });
          i = closeLine + 1;
          continue;
        }
      }
    }

    if (/^\[%collapsible[^\]]*\]$/.test(text) && i + 1 <= doc.lines) {
      const nextText = doc.line(i + 1).text.trim();
      if (/^={4,}$/.test(nextText)) {
        let closeLine = -1;
        for (let j = i + 2; j <= doc.lines; j++) {
          if (/^={4,}$/.test(doc.line(j).text.trim())) {
            closeLine = j;
            break;
          }
        }
        if (closeLine > 0) {
          blocks.push({
            type: "contentblock",
            kind: "collapsible",
            titleLine: -1,
            attrLine: i,
            openLine: i + 1,
            closeLine,
            title: "",
          });
          i = closeLine + 1;
          continue;
        }
      }
    }

    if (/^\*{4,}$/.test(text) || /^={4,}$/.test(text)) {
      const kind = /^\*{4,}$/.test(text) ? "sidebar" : "example";
      const previousText = i > 1 ? doc.line(i - 1).text.trim() : "";
      const precededByCollapsible = kind === "example" && /^\[%collapsible[^\]]*\]$/.test(previousText);

      if (!precededByCollapsible) {
        const delimiterPattern = kind === "sidebar" ? /^\*{4,}$/ : /^={4,}$/;
        let closeLine = -1;
        for (let j = i + 1; j <= doc.lines; j++) {
          if (delimiterPattern.test(doc.line(j).text.trim())) {
            closeLine = j;
            break;
          }
        }
        if (closeLine > 0) {
          blocks.push({
            type: "contentblock",
            kind,
            titleLine: -1,
            attrLine: -1,
            openLine: i,
            closeLine,
            title: "",
          });
          i = closeLine + 1;
          continue;
        }
      }
    }

    // Detect stem block: [stem|latexmath|asciimath] followed by ++++
    const stemAttrMatch = text.match(/^\[(stem|latexmath|asciimath)\]$/);
    if (stemAttrMatch && i + 1 <= doc.lines) {
      const nextText = doc.line(i + 1).text.trim();
      if (/^\+{4,}$/.test(nextText)) {
        const rawNotation = stemAttrMatch[1] as "stem" | "latexmath" | "asciimath";
        let closeLine = -1;
        for (let j = i + 2; j <= doc.lines; j++) {
          if (/^\+{4,}$/.test(doc.line(j).text.trim())) {
            closeLine = j;
            break;
          }
        }
        if (closeLine > 0) {
          blocks.push({
            type: "stem",
            attrLine: i,
            openLine: i + 1,
            closeLine,
            rawNotation,
          });
          i = closeLine + 1;
          continue;
        }
      }
    }

    // Detect mermaid block: [mermaid] followed by ----
    // Must come before code block detection to avoid matching as a no-language code block.
    if (/^\[mermaid\]$/.test(text) && i + 1 <= doc.lines) {
      const nextText = doc.line(i + 1).text.trim();
      if (/^-{4,}$/.test(nextText)) {
        let closeLine = -1;
        for (let j = i + 2; j <= doc.lines; j++) {
          if (/^-{4,}$/.test(doc.line(j).text.trim())) {
            closeLine = j;
            break;
          }
        }
        if (closeLine > 0) {
          blocks.push({ type: "mermaid", attrLine: i, openLine: i + 1, closeLine });
          i = closeLine + 1;
          continue;
        }
      }
    }

    // Detect code block: [source,lang] followed by ----
    const sourceMatch = text.match(/^\[source(?:,(\w+))?\]$/);
    if (sourceMatch && i + 1 <= doc.lines) {
      const nextText = doc.line(i + 1).text.trim();
      if (/^-{4,}$/.test(nextText)) {
        const lang = sourceMatch[1] || "";
        let closeLine = -1;
        for (let j = i + 2; j <= doc.lines; j++) {
          if (/^-{4,}$/.test(doc.line(j).text.trim())) {
            closeLine = j;
            break;
          }
        }
        if (closeLine > 0) {
          blocks.push({ type: "code", attrLine: i, openLine: i + 1, closeLine, language: lang });
          i = closeLine + 1;
          continue;
        }
      }
    }

    // Detect standalone code block: ---- without preceding [source,...]
    if (/^-{4,}$/.test(text)) {
      const prevText = i > 1 ? doc.line(i - 1).text.trim() : "";
      if (!/^\[source/.test(prevText)) {
        let closeLine = -1;
        for (let j = i + 1; j <= doc.lines; j++) {
          if (/^-{4,}$/.test(doc.line(j).text.trim())) {
            closeLine = j;
            break;
          }
        }
        if (closeLine > 0) {
          blocks.push({ type: "code", attrLine: -1, openLine: i, closeLine, language: "" });
          i = closeLine + 1;
          continue;
        }
      }
    }

    // Detect table block: optional [cols/options] attribute line + |===
    if (text === "|===") {
      // Check if preceding line is a table attribute (e.g. [cols="...", options="header"])
      const prevText = i > 1 ? doc.line(i - 1).text.trim() : "";
      const hasAttrLine = /^\[.*(?:cols|options|%header|%autowidth|%footer|width|frame|grid|stripes).*\]$/.test(prevText);
      const attrLine = hasAttrLine ? i - 1 : -1;
      let closeLine = -1;
      for (let j = i + 1; j <= doc.lines; j++) {
        if (doc.line(j).text.trim() === "|===") {
          closeLine = j;
          break;
        }
      }
      if (closeLine > 0) {
        blocks.push({ type: "table", attrLine, openLine: i, closeLine });
        i = closeLine + 1;
        continue;
      }
    }

    // Detect blockquote: [quote, Author] (optional) followed by ____ or paragraph
    const quoteAttrMatch = text.match(/^\[quote(?:,\s*(.+))?\]$/);
    if (quoteAttrMatch && i + 1 <= doc.lines) {
      const nextText = doc.line(i + 1).text.trim();
      if (/^_{4,}$/.test(nextText)) {
        // Delimited blockquote: [quote] + ____...____
        const author = quoteAttrMatch[1] || "";
        let closeLine = -1;
        for (let j = i + 2; j <= doc.lines; j++) {
          if (/^_{4,}$/.test(doc.line(j).text.trim())) {
            closeLine = j;
            break;
          }
        }
        if (closeLine > 0) {
          blocks.push({ type: "blockquote", attrLine: i, openLine: i + 1, closeLine, author });
          i = closeLine + 1;
          continue;
        }
      } else if (nextText) {
        // Paragraph-style blockquote: [quote] followed by paragraph text (until blank line)
        const author = quoteAttrMatch[1] || "";
        let endLine = i + 1;
        for (let j = i + 2; j <= doc.lines; j++) {
          if (!doc.line(j).text.trim()) break;
          endLine = j;
        }
        blocks.push({ type: "blockquote", attrLine: i, openLine: i + 1, closeLine: endLine, author });
        i = endLine + 1;
        continue;
      }
    }

    // Detect standalone blockquote: ____ without preceding [quote,...]
    if (/^_{4,}$/.test(text)) {
      const prevText = i > 1 ? doc.line(i - 1).text.trim() : "";
      if (!/^\[quote/.test(prevText)) {
        let closeLine = -1;
        for (let j = i + 1; j <= doc.lines; j++) {
          if (/^_{4,}$/.test(doc.line(j).text.trim())) {
            closeLine = j;
            break;
          }
        }
        if (closeLine > 0) {
          blocks.push({ type: "blockquote", attrLine: -1, openLine: i, closeLine, author: "" });
          i = closeLine + 1;
          continue;
        }
      }
    }

    i++;
  }

  return blocks;
}

// =====================================================
// Table Parsing
// =====================================================

function parseTable(doc: any, openLine: number, closeLine: number): { headers: string[]; rows: string[][] } {
  const headers: string[] = [];
  const allCells: string[] = [];

  // In AsciiDoc, a header row is the first content row ONLY if followed by an empty line.
  // First, find the first non-empty line and check if the next line is empty.
  let firstContentLine = -1;
  for (let i = openLine + 1; i < closeLine; i++) {
    if (doc.line(i).text.trim()) {
      firstContentLine = i;
      break;
    }
  }

  let hasHeaderRow = false;
  if (firstContentLine > 0 && firstContentLine + 1 < closeLine) {
    // Header row exists if: first content line has multiple cells on one line (with |),
    // AND is followed by an empty line
    const nextLine = doc.line(firstContentLine + 1).text.trim();
    const firstText = doc.line(firstContentLine).text.trim();
    if (!nextLine && firstText.includes("|")) {
      hasHeaderRow = true;
    }
  }

  let startLine = openLine + 1;
  if (hasHeaderRow && firstContentLine > 0) {
    const text = doc.line(firstContentLine).text.trim();
    const cells = text.split("|").filter((c: string) => c !== "").map((c: string) => c.trim());
    headers.push(...cells);
    // Skip past header row and empty line
    startLine = firstContentLine + 1;
  }

  for (let i = startLine; i < closeLine; i++) {
    const rawText = doc.line(i).text;
    const text = rawText.trim();
    if (!text) continue;
    if (text.startsWith("|")) {
      // Use raw text for split to preserve trailing whitespace cells
      // (trim would eat trailing spaces, turning "| A |  " into "| A |",
      //  and split+filter would then lose the last cell)
      const cells = rawText.split("|").filter((c: string) => c !== "").map((c: string) => c.trim());
      allCells.push(...cells);
    }
  }

  // Determine column count from headers or by counting cells in first row pattern
  const numCols = headers.length || (allCells.length > 0 ? countColumnsFromCells(allCells, doc, startLine, closeLine) : 1);
  const rows: string[][] = [];
  for (let i = 0; i < allCells.length; i += numCols) {
    rows.push(allCells.slice(i, i + numCols));
  }

  return { headers, rows };
}

function countColumnsFromCells(allCells: string[], doc: any, startLine: number, closeLine: number): number {
  // Try to detect column count by looking for multi-cell lines (| cell | cell | cell)
  for (let i = startLine; i < closeLine; i++) {
    const rawText = doc.line(i).text;
    const text = rawText.trim();
    if (!text || !text.startsWith("|")) continue;
    const cells = rawText.split("|").filter((c: string) => c !== "");
    if (cells.length > 1) return cells.length;
  }
  // Fallback: assume 1 column
  return 1;
}

function serializeTable(headers: string[], rows: string[][]): string {
  let result = "|===\n";
  if (headers.length > 0) {
    result += "| " + headers.join(" | ") + "\n\n";
  }
  for (const row of rows) {
    result += "| " + row.map(c => c || " ").join(" | ") + "\n";
  }
  result += "|===";
  return result;
}

function serializeTableFromWrap(wrap: HTMLElement): string {
  const headerInputs = Array.from(wrap.querySelectorAll("thead .cm-lp-table-input")) as HTMLInputElement[];
  const bodyRows = Array.from(wrap.querySelectorAll("tbody tr"));
  const headers = headerInputs.map(inp => inp.value || " ");
  const rows = bodyRows.map(tr =>
    Array.from(tr.querySelectorAll(".cm-lp-table-input")).map((inp) => (inp as HTMLInputElement).value || " "),
  );
  return serializeTable(headers, rows);
}

// =====================================================
// Inline & Line Rendering
// =====================================================

// Track open section previews as floating panels outside CM's decoration lifecycle
const openSectionPreviews = new Map<string, string>(); // key: "nodeId#anchor", value: rendered HTML
let floatingPreviewPanel: HTMLDivElement | null = null;
let floatingPreviewKey: string | null = null;

function getOrCreateFloatingPanel(editorEl: HTMLElement): HTMLDivElement {
  // Place inside .cm-scroller so the panel scrolls with the editor content
  const scroller = editorEl.querySelector(".cm-scroller") || editorEl;

  let panel = scroller.querySelector<HTMLDivElement>(":scope > .cm-lp-floating-section-preview");
  if (!panel) {
    panel = document.createElement("div");
    panel.className = "cm-lp-floating-section-preview";
    scroller.appendChild(panel);
  }
  return panel;
}

// =====================================================
// Footnote popup
// =====================================================

let footnotePopup: HTMLElement | null = null;

function closeFootnotePopup() {
  if (footnotePopup) {
    footnotePopup.remove();
    footnotePopup = null;
  }
}

function toggleFootnotePopup(fnEl: HTMLElement, lineEl: HTMLElement) {
  // If already showing a popup for this footnote, close it
  if (footnotePopup && footnotePopup.dataset.forFn === fnEl.dataset.fnText) {
    closeFootnotePopup();
    return;
  }
  closeFootnotePopup();

  const fnText = fnEl.dataset.fnText || "";
  const fnId = fnEl.dataset.fnId || "";
  if (!fnText && !fnId) return;

  // Find the scroller to position within
  const scroller = lineEl.closest(".cm-scroller") as HTMLElement;
  if (!scroller) return;

  const popup = document.createElement("div");
  popup.className = "cm-lp-footnote-popup";
  popup.dataset.forFn = fnText;

  // Render content with footnote number
  const fnNum = fnEl.dataset.fnNum || "?";
  if (fnId && !fnText) {
    // Reference to a named footnote defined elsewhere
    const refNum = footnoteNumberMap.get(fnId);
    popup.innerHTML = `<strong style="color:var(--asciidoc-link,#2156a5)">[${refNum || fnNum}]</strong> <span style="opacity:0.7;font-style:italic">See footnote "${fnId}" defined above.</span>`;
  } else {
    popup.innerHTML = `<strong style="color:var(--asciidoc-link,#2156a5)">[${fnNum}]</strong> ${renderInline(fnText)}`;
  }

  scroller.appendChild(popup);
  footnotePopup = popup;

  // Position below the footnote marker, full content width
  const scrollerRect = scroller.getBoundingClientRect();
  const fnRect = fnEl.getBoundingClientRect();
  const sampleLine = scroller.querySelector<HTMLElement>(".cm-line");
  const basePad = sampleLine ? parseFloat(getComputedStyle(sampleLine).paddingLeft) : 20;
  const pad = Math.round(basePad);
  popup.style.top = (fnRect.bottom - scrollerRect.top + scroller.scrollTop + 4) + "px";
  popup.style.left = pad + "px";
  popup.style.right = pad + "px";

  // Close on click outside
  const closeOnClick = (e: MouseEvent) => {
    if (!popup.contains(e.target as Node) && e.target !== fnEl) {
      closeFootnotePopup();
      document.removeEventListener("mousedown", closeOnClick, true);
    }
  };
  setTimeout(() => document.addEventListener("mousedown", closeOnClick, true), 0);
}

function positionFloatingPanel(panel: HTMLDivElement, anchorEl: HTMLElement) {
  const scroller = panel.parentElement;
  if (!scroller) return;
  const scrollerRect = scroller.getBoundingClientRect();
  const anchorRect = anchorEl.getBoundingClientRect();
  // Position below the anchor, spanning the full content width (respecting margins)
  const sampleLine = scroller.querySelector<HTMLElement>(".cm-line");
  const basePad = sampleLine ? parseFloat(getComputedStyle(sampleLine).paddingLeft) : 20;
  const pad = Math.round(basePad);
  panel.style.top = (anchorRect.bottom - scrollerRect.top + scroller.scrollTop + 2) + "px";
  panel.style.left = pad + "px";
  panel.style.right = pad + "px";
}

function closeFloatingPreview() {
  if (floatingPreviewPanel) {
    floatingPreviewPanel.style.display = "none";
    floatingPreviewPanel.innerHTML = "";
    floatingPreviewKey = null;
  }
  // Reset all toggle buttons to closed state
  document.querySelectorAll<HTMLElement>(".cm-lp-section-toggle.open").forEach(el => {
    setSectionToggleState(el, false);
  });
}

class PreviewLineWidget extends WidgetType {
  constructor(readonly html: string, readonly lineFrom: number) { super(); }
  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = "cm-live-preview-line";
    span.innerHTML = this.html;
    span.setAttribute(LINE_HEIGHT_DATA_ATTR, String(this.lineFrom));
    attachPreviewFocusHandlers(span, this.lineFrom, isInteractivePreviewTarget);

    // Attach direct mousedown handlers to toggle buttons and xref links
    // This is critical: domEventHandlers run too late (after CM moves cursor),
    // so we must capture mousedown at the source element level.
    const toggles = span.querySelectorAll<HTMLElement>(".cm-lp-section-toggle");
    for (const toggle of toggles) {
      const key = `${toggle.dataset.nodeId}#${toggle.dataset.sectionAnchor}`;
      // Restore open state after decoration rebuild
      if (key === floatingPreviewKey) {
        setSectionToggleState(toggle, true);
      } else {
        setSectionToggleState(toggle, false);
      }
      toggle.addEventListener("mousedown", (e) => {
        consumeEvent(e);
        // Find the CM editor element by walking up
        const editorEl = toggle.closest(".cm-editor") as HTMLElement;
        if (editorEl) {
          toggleSectionPreview(toggle, editorEl);
        }
      });
    }

    const xrefs = span.querySelectorAll<HTMLElement>(".cm-lp-xref");
    for (const xref of xrefs) {
      xref.addEventListener("mousedown", (e) => {
        consumeEvent(e);
        const nodeId = xref.dataset.nodeId;
        if (nodeId && UUID_PATTERN.test(nodeId)) {
          import("../ipc").then(({ navigateToNote }) => {
            navigateToNote(nodeId);
          });
        }
      });
    }

    // Footnote click → show floating popup with footnote text
    const footnotes = span.querySelectorAll<HTMLElement>(".cm-lp-footnote");
    for (const fn of footnotes) {
      fn.addEventListener("mousedown", (e) => {
        consumeEvent(e);
        toggleFootnotePopup(fn, span);
      });
    }

    const images = span.querySelectorAll<HTMLElement>(".cm-lp-image");
    for (const image of images) {
      image.addEventListener("mousedown", (e) => consumeEvent(e));
      image.addEventListener("mouseup", (e) => consumeEvent(e));
      image.addEventListener("mousemove", (e) => consumeEvent(e));
      image.addEventListener("selectstart", (e) => consumeEvent(e));
      image.addEventListener("dragstart", (e) => consumeEvent(e));
      image.addEventListener("click", (e) => {
        consumeEvent(e);
        const view = getEditorViewFromElement(span);
        if (!view) return;
        const lineNumber = view.state.doc.lineAt(this.lineFrom).number;
        const imageInfo = getImageBlockForLine(view.state.doc, lineNumber);
        if (!imageInfo) return;
        openImageEditorModal(view, imageInfo);
      });
    }

    // Ctrl+click on links opens URL in default browser
    // Extract URLs from the source text and attach to rendered link elements
    const linkEls = span.querySelectorAll<HTMLElement>(".cm-lp-link");
    if (linkEls.length > 0) {
      // Parse link URLs from the original HTML source (which contains the AsciiDoc markup)
      const urlRegex = /link:([^\[]+)\[|(?<!link:)(https?:\/\/[^\s\[]+)\[|mailto:([^\[]+)\[/g;
      const urls: string[] = [];
      let match;
      while ((match = urlRegex.exec(this.html)) !== null) {
        urls.push(match[1] || match[2] || (match[3] ? "mailto:" + match[3] : ""));
      }
      // Also collect bare URLs that aren't followed by [
      const bareUrlRegex = /(?<!link:)(https?:\/\/[^\s\[<"]+)(?!\[[^\]]*\])/g;
      while ((match = bareUrlRegex.exec(this.html)) !== null) {
        urls.push(match[1]);
      }
      for (let li = 0; li < linkEls.length && li < urls.length; li++) {
        if (urls[li]) {
          linkEls[li].dataset.href = urls[li];
          linkEls[li].addEventListener("click", (e) => {
            if (e.ctrlKey || e.metaKey) {
              consumeEvent(e);
              window.open(urls[li], "_blank");
            }
          });
        }
      }
    }

    return span;
  }
  eq(other: PreviewLineWidget): boolean {
    return this.html === other.html && this.lineFrom === other.lineFrom;
  }
  ignoreEvent(event: Event): boolean {
    if (event.type === "mousedown" || event.type === "mouseup" || event.type === "mousemove" || event.type === "dragstart") {
      return true;
    }
    const target = event.target as HTMLElement;
    return isInteractivePreviewTarget(target);
  }
}

/** Returns inline CSS for common AsciiDoc roles, or empty string for unknown roles. */
function getRoleStyle(role: string): string {
  switch (role) {
    case "lead": return "font-size:1.2em;line-height:1.6";
    case "big": return "font-size:1.15em";
    case "small": return "font-size:0.85em";
    case "underline": return "text-decoration:underline";
    case "overline": return "text-decoration:overline";
    case "line-through": return "text-decoration:line-through";
    case "text-left": return "display:inline-block;width:100%;text-align:left";
    case "text-right": return "display:inline-block;width:100%;text-align:right";
    case "text-center": return "display:inline-block;width:100%;text-align:center";
    case "text-justify": return "display:inline-block;width:100%;text-align:justify";
    default: return "";
  }
}

function renderLineHtml(text: string, lineNumber = 0, listNumbers?: Map<number, number>): string {
  const trimmed = text.trimStart();
  if (!trimmed) return "&nbsp;";

  // Comment lines (// ...)
  if (trimmed.startsWith("// ") || trimmed === "//") {
    return `<span class="cm-lp-comment" style="color:var(--asciidoc-placeholder,#888);font-style:italic;opacity:0.6">${escapeHtml(trimmed)}</span>`;
  }

  // Block titles (.Title)
  if (/^\.[A-Z]/.test(trimmed) && !trimmed.startsWith("..")) {
    return `<span class="cm-lp-block-title" style="font-weight:600;font-style:italic;color:var(--asciidoc-fg)">${renderInline(trimmed.slice(1))}</span>`;
  }

  // Document attribute definitions (:name: value)
  const attrDefMatch = trimmed.match(/^:([^:]+):\s*(.*)$/);
  if (attrDefMatch && !trimmed.startsWith("::")) {
    return `<span style="color:var(--asciidoc-placeholder,#888);font-style:italic"><span style="opacity:0.6">:${escapeHtml(attrDefMatch[1])}:</span> ${escapeHtml(attrDefMatch[2])}</span>`;
  }

  const headingMatch = trimmed.match(/^(={1,5})\s+(.+)$/);
  if (headingMatch) {
    const level = headingMatch[1].length;
    const content = renderInline(headingMatch[2]);
    const sizes = ["2em", "1.5em", "1.25em", "1.1em", "1em"];
    let style = `font-size:${sizes[level - 1]};font-weight:700`;
    if (level === 1) style += ";display:inline-block;width:100%;border-bottom:2px solid var(--asciidoc-border,#ddd);padding-bottom:0.3em;margin:0.8em 0 0.4em";
    if (level === 2) style += ";display:inline-block;width:100%;border-bottom:1px solid var(--asciidoc-border,#eee);padding-bottom:0.2em;margin:0.8em 0 0.4em";
    return `<span class="cm-lp-heading cm-lp-h${level}" style="${style}">${content}</span>`;
  }

  if (trimmed === "'''") {
    return `<span class="cm-lp-hr" style="display:inline-block;width:100%;border-bottom:1px solid var(--asciidoc-border,#ddd);margin:1.5em 0"></span>`;
  }

  if (trimmed === "<<<") {
    return `<span class="cm-lp-pagebreak"><span class="cm-lp-pagebreak-label">Page Break</span></span>`;
  }

  const admonMatch = trimmed.match(/^(NOTE|TIP|WARNING|CAUTION|IMPORTANT|QUESTION):\s+(.+)$/);
  if (admonMatch) {
    const type = admonMatch[1].toLowerCase();
    const labels: Record<string, string> = { NOTE: "Note", TIP: "Tip", WARNING: "Warning", CAUTION: "Caution", IMPORTANT: "Important", QUESTION: "Question" };
    const label = labels[admonMatch[1]] || admonMatch[1];
    return `<span class="cm-lp-admon cm-lp-admon-${type}"><span class="cm-lp-admon-label">${label}</span><span class="cm-lp-admon-text">${renderInline(admonMatch[2])}</span></span>`;
  }

  if (/^(-{4,}|={4,}|_{4,}|\.{4,}|\+{4,}|\/{4,})$/.test(trimmed)) {
    return `<span class="cm-lp-delim" style="color:var(--asciidoc-placeholder,#888);opacity:0.5">${escapeHtml(trimmed)}</span>`;
  }

  if (/^\[.+\]$/.test(trimmed) && !trimmed.startsWith("[[")) {
    return `<span class="cm-lp-attr" style="color:var(--asciidoc-placeholder,#888);font-style:italic">${escapeHtml(trimmed)}</span>`;
  }

  if (/^\[\[.+\]\]$/.test(trimmed)) {
    return `<span class="cm-lp-anchor" style="color:var(--asciidoc-placeholder,#888);font-style:italic">${escapeHtml(trimmed)}</span>`;
  }

  const checkMatch = trimmed.match(/^(\*{1,5})\s+\[([ x])\]\s+(.*)$/);
  if (checkMatch) {
    const depth = checkMatch[1].length;
    const checked = checkMatch[2] === "x";
    const pad = (depth - 1) * 1.5;
    const box = checked ? `<span style="color:var(--asciidoc-link,#2156a5)">\u2611</span>` : `\u2610`;
    return `<span class="cm-lp-list cm-lp-list-d${depth}" style="padding-left:${pad}em"><span class="cm-lp-list-marker">${box}</span><span class="cm-lp-list-content">${renderInline(checkMatch[3])}</span></span>`;
  }

  const bulletMatch = trimmed.match(/^(\*{1,5})\s+(.+)$/);
  if (bulletMatch) {
    const depth = bulletMatch[1].length;
    const pad = (depth - 1) * 1.5;
    const bulletClass = depth === 1 ? "" : depth === 2 ? " cm-lp-bullet-marker-nested" : " cm-lp-bullet-marker-square";
    const markerHtml = `<span class="cm-lp-list-marker cm-lp-bullet-marker${bulletClass}" aria-hidden="true"></span>`;
    return `<span class="cm-lp-list cm-lp-list-d${depth}" style="padding-left:${pad}em">${markerHtml}<span class="cm-lp-list-content">${renderInline(bulletMatch[2])}</span></span>`;
  }

  const numMatch = trimmed.match(/^(\.{1,5})\s+(.+)$/);
  if (numMatch) {
    const depth = numMatch[1].length;
    const pad = (depth - 1) * 1.5;
    const num = listNumbers?.get(lineNumber) ?? 1;
    const label = depth === 1 ? `${num}.` : `${String.fromCharCode(96 + num)}.`;
    return `<span class="cm-lp-list cm-lp-list-d${depth}" style="padding-left:${pad}em"><span class="cm-lp-list-marker">${label}</span><span class="cm-lp-list-content">${renderInline(numMatch[2])}</span></span>`;
  }

  const defMatch = trimmed.match(/^(.+)::\s*(.*)$/);
  if (defMatch && !trimmed.startsWith("image:") && !trimmed.startsWith("link:")) {
    return `<span><strong>${renderInline(defMatch[1])}</strong>${defMatch[2] ? " \u2014 " + renderInline(defMatch[2]) : ""}</span>`;
  }

  if (trimmed === "|===") {
    return `<span class="cm-lp-delim" style="color:var(--asciidoc-placeholder,#888);opacity:0.5">${escapeHtml(trimmed)}</span>`;
  }

  if (trimmed.startsWith("| ") || trimmed.startsWith("|")) {
    const cells = trimmed.split("|").filter((c) => c !== "");
    const rendered = cells.map((c) => renderInline(c.trim())).join(`<span style="color:var(--asciidoc-border,#666);margin:0 0.429em">|</span>`);
    return `<span class="cm-lp-table-row"><span style="color:var(--asciidoc-border,#666);margin-right:0.429em">|</span>${rendered}</span>`;
  }

  const imgMatch = trimmed.match(/^image::(.+?)\[(.*)?\]$/);
  if (imgMatch) {
    const image = parseImageMacroLine(trimmed);
    if (!image) {
      return `<span class="cm-lp-image" style="color:var(--asciidoc-link,#569cd6)">🖼 image</span>`;
    }
    const sizeStyle = [
      image.width !== 100 ? `width:${image.width}%` : "",
      image.height !== 100 ? `height:${image.height}%` : "",
    ].filter(Boolean).join(";");

    // Resolve Joplin resource URLs from cache
    let imgSrc = normalizeImageTarget(image.target);
    const resourceMatch = image.target.match(/^:\/?([a-f0-9]{32})/);
    if (resourceMatch) {
      const cached = resourceUrlCache.get(resourceMatch[1]);
      if (cached) imgSrc = cached;
    }

    return `<span class="cm-lp-image-wrap cm-lp-image-align-${escapeHtml(image.align)}"><img class="cm-lp-image" src="${escapeHtml(imgSrc)}" alt="${escapeHtml(image.alt)}"${sizeStyle ? ` style="${sizeStyle}"` : ""} /></span>`;
  }

  if (trimmed.startsWith("include::")) {
    return `<span style="color:var(--asciidoc-placeholder,#888);font-style:italic">${escapeHtml(trimmed)}</span>`;
  }

  return renderInline(text);
}

// AsciiDoc built-in attribute references
const asciidocAttributes: Record<string, string> = {
  nbsp: "\u00A0", zwsp: "\u200B", wj: "\u2060", shy: "\u00AD",
  ensp: "\u2002", emsp: "\u2003", thinsp: "\u2009",
  amp: "&", lt: "<", gt: ">", quot: '"',
  apos: "'", lsquo: "\u2018", rsquo: "\u2019",
  ldquo: "\u201C", rdquo: "\u201D",
  deg: "\u00B0", plus: "+", brvbar: "\u00A6",
  vbar: "|", caret: "^", tilde: "~",
  backslash: "\\", backtick: "`",
  startsb: "[", endsb: "]",
  blank: "", empty: "",
  sp: " ", "two-colons": "::", "two-semicolons": ";;",
  mdash: "\u2014", ndash: "\u2013",
  ellipsis: "\u2026", arrow: "\u2192",
  copyright: "\u00A9", registered: "\u00AE", trademark: "\u2122",
};

// Footnote numbering — populated by buildDecorations, read by renderInline
// Maps each footnote occurrence (by character offset in original text) to its display number.
// For renderInline (which doesn't know offsets), we use a sequential counter that resets per buildDecorations call.
let footnoteNumberMap: Map<string, number> = new Map(); // id → first assigned number
let footnoteNextNumber = 1;
let footnoteSeqCounter = 0; // incremented per renderInline footnote match

// STEM/math rendering state
let documentStemNotation: MathNotation = "asciimath"; // AsciiDoc default

function detectStemAttribute(doc: any): { hasStem: boolean; notation: MathNotation } {
  // Scan document header (lines before first blank line, up to 50 lines)
  for (let i = 1; i <= Math.min(doc.lines, 50); i++) {
    const text = doc.line(i).text.trim();
    if (!text) break; // first blank line ends the header
    const m = text.match(/^:stem:\s*(.*)$/);
    if (m) {
      const value = m[1].trim().toLowerCase();
      return {
        hasStem: true,
        notation: value === "latexmath" ? "latexmath" : "asciimath",
      };
    }
  }
  return { hasStem: false, notation: "asciimath" };
}

function getFootnoteNumber(id: string, text: string): number {
  if (id && footnoteNumberMap.has(id)) {
    return footnoteNumberMap.get(id)!;
  }
  const num = footnoteNextNumber++;
  if (id) footnoteNumberMap.set(id, num);
  return num;
}

function resetFootnoteNumbering() {
  footnoteNumberMap = new Map();
  footnoteNextNumber = 1;
  footnoteSeqCounter = 0;
}

// Matches stem:[], latexmath:[], asciimath:[] with one level of nested brackets
const STEM_INLINE_REGEX = /(?:stem|latexmath|asciimath):\[((?:[^\[\]]*(?:\[[^\]]*\])?[^\[\]]*)*)\]/g;

function renderInline(text: string): string {
  // ── Phase 1: Extract stem macros before any processing ──
  const stemPlaceholders: string[] = [];
  const STEM_TOKEN = "\x00STEM";

  text = text.replace(STEM_INLINE_REGEX, (match, content) => {
    const macroName = match.substring(0, match.indexOf(":"));
    const notation: MathNotation =
      macroName === "latexmath" ? "latexmath" :
      macroName === "asciimath" ? "asciimath" :
      documentStemNotation; // stem:[] uses document default
    const html = `<span class="cm-lp-math-inline">${renderMath(content, notation, false)}</span>`;
    const idx = stemPlaceholders.length;
    stemPlaceholders.push(html);
    return `${STEM_TOKEN}${idx}\x00`;
  });

  // ── Phase 2: Existing inline processing ──
  let result = escapeHtml(text);

  // --- Unconstrained bold/italic (double markers, no word-boundary needed) ---
  result = result.replace(/\*\*(?!\s)(.+?)(?<!\s)\*\*/g, "<strong>$1</strong>");
  result = result.replace(/__(?!\s)(.+?)(?<!\s)__/g, "<em>$1</em>");

  // --- Constrained bold/italic ---
  result = result.replace(/(?<!\w)\*(?!\s)(.+?)(?<!\s)\*(?!\w)/g, "<strong>$1</strong>");
  result = result.replace(/(?<!\w)_(?!\s)(.+?)(?<!\s)_(?!\w)/g, "<em>$1</em>");

  // Smart quotes (must be before monospace to prevent backtick consumption)
  result = result.replace(/&quot;`([^`]+)`&quot;/g, '\u201C$1\u201D');
  result = result.replace(/'`([^`]+)`'/g, '\u2018$1\u2019');

  // Monospace
  result = result.replace(/`([^`]+)`/g, '<code class="cm-lp-code">$1</code>');

  // Superscript / Subscript
  result = result.replace(/\^([^^]+)\^/g, "<sup>$1</sup>");
  result = result.replace(/~([^~]+)~/g, "<sub>$1</sub>");

  // --- Role-based inline styling: [.role]#text# ---
  // Strikethrough
  result = result.replace(/\[\.line-through\]#([^#]+)#/g, '<del>$1</del>');
  // Color roles
  result = result.replace(/\[\.(red|blue|green|purple|orange|teal|maroon|navy|yellow|aqua|lime|fuchsia|gray|silver|white|black)\]#([^#]+)#/g,
    '<span style="color:$1">$2</span>');
  // Background color roles
  result = result.replace(/\[\.(red|blue|green|purple|orange|yellow|aqua|lime|pink|silver)-background\]#([^#]+)#/g,
    '<span style="background:$1;color:#000;padding:0 2px;border-radius:2px">$2</span>');
  // Size roles
  result = result.replace(/\[\.big\]#([^#]+)#/g, '<span style="font-size:1.2em">$1</span>');
  result = result.replace(/\[\.small\]#([^#]+)#/g, '<span style="font-size:0.85em">$1</span>');
  result = result.replace(/\[\.underline\]#([^#]+)#/g, '<span style="text-decoration:underline">$1</span>');
  result = result.replace(/\[\.overline\]#([^#]+)#/g, '<span style="text-decoration:overline">$1</span>');

  // Highlight/mark (plain #text# without role)
  result = result.replace(/(?<!\w)#(?!\s)(.+?)(?<!\s)#(?!\w)/g, '<mark class="cm-lp-mark">$1</mark>');

  // --- Inline macros ---
  // Inline images: image:target[alt, link=url, width=N%] (single colon)
  result = result.replace(/image:([^\[]+)\[([^\]]*)\]/g, (_m, target, attrText) => {
    let src = target;
    const resMatch = target.match(/^:\/?([a-f0-9]{32})/);
    if (resMatch) {
      const cached = resourceUrlCache.get(resMatch[1]);
      if (cached) src = cached;
    }
    // Parse attributes: first positional = alt, named: link=, width=
    let alt = "";
    let link = "";
    const parts = attrText.split(/,\s*/);
    for (const part of parts) {
      const namedMatch = part.match(/^(\w+)=(.+)$/);
      if (namedMatch) {
        if (namedMatch[1] === "link") link = namedMatch[2];
      } else if (!alt) {
        alt = part;
      }
    }
    const imgHtml = `<img class="cm-lp-image" style="max-height:1.4em;vertical-align:middle" src="${escapeHtml(src)}" alt="${escapeHtml(alt)}" />`;
    if (link) {
      return `<span class="cm-lp-link">${imgHtml}</span>`;
    }
    return imgHtml;
  });

  // Links — rendered as styled spans (URLs resolved via DOM in toDOM())
  result = result.replace(/link:([^\[]+)\[([^\]]*)\]/g, ' <span class="cm-lp-link">$2</span>');
  result = result.replace(/(?<!link:)(https?:\/\/[^\s\[]+)\[([^\]]*)\]/g, '<span class="cm-lp-link">$2</span>');
  result = result.replace(/(?<!link:)(https?:\/\/[^\s\[<]+)(?![^\[]*\])/g, '<span class="cm-lp-link">$1</span>');
  result = result.replace(/mailto:([^\[]+)\[([^\]]*)\]/g, '<span class="cm-lp-link">$2</span>');

  // Cross-references
  result = result.replace(/xref:([^\[]+)\[([^\]]*)\]/g, '<span class="cm-lp-link">$2</span>');
  result = result.replace(/&lt;&lt;([^,&>]+),(.+?)&gt;&gt;/g, (_match, idPart, text) => {
    const nodeId = idPart.split("#")[0];
    const sectionAnchor = idPart.includes("#") ? idPart.split("#")[1] : "";
    // Unescape &gt; back to > in display text (e.g., "Title > Section")
    const displayText = text.replace(/&gt;/g, ">");
    let html = `<span class="cm-lp-xref-wrap"><span class="cm-lp-xref" data-node-id="${nodeId}"${sectionAnchor ? ` data-section-anchor="${sectionAnchor}"` : ""}>${displayText}</span>`;
    if (sectionAnchor) {
      html += `<span class="cm-lp-section-toggle" data-node-id="${nodeId}" data-section-anchor="${sectionAnchor}" role="button" aria-label="Show linked section" title="Show linked section">${SECTION_TOGGLE_CLOSED}</span>`;
    }
    html += `</span>`;
    return html;
  });
  result = result.replace(/&lt;&lt;([^&>]+)&gt;&gt;/g, '<span class="cm-lp-link">[$1]</span>');

  // Keyboard, Button, Menu macros
  result = result.replace(/kbd:\[([^\]]+)\]/g, '<kbd class="cm-lp-kbd">$1</kbd>');
  result = result.replace(/btn:\[([^\]]+)\]/g, '<span class="cm-lp-btn">$1</span>');
  result = result.replace(/menu:([^\[]+)\[([^\]]*)\]/g, (_m, menu, items) => {
    const parts = [menu, ...items.split("&gt;").join(">").split(">").map((s: string) => s.trim()).filter(Boolean)];
    return '<span class="cm-lp-menu">' + parts.join(' <span class="cm-lp-menu-sep">\u203A</span> ') + '</span>';
  });

  // Footnote — footnote:[text], footnote:id[text], footnote:id[]
  result = result.replace(/footnote:(?:([a-zA-Z0-9_-]+))?\[([^\]]*)\]/g, (_match: string, id: string | undefined, text: string) => {
    const fnId = id || "";
    const fnText = text || "";
    const num = getFootnoteNumber(fnId, fnText);
    return `<sup class="cm-lp-footnote" data-fn-id="${escapeHtml(fnId)}" data-fn-text="${escapeHtml(fnText)}" data-fn-num="${num}">[${num}]</sup>`;
  });

  // Pass-through macros
  result = result.replace(/pass:\[([^\]]*)\]/g, '$1');

  // Pass-through (triple plus, then double plus)
  result = result.replace(/\+\+\+(.+?)\+\+\+/g, '$1');
  result = result.replace(/\+\+(?!\+)(.+?)(?<!\+)\+\+/g, '$1');

  // Hard line break: trailing ` +`
  result = result.replace(/ \+$/, '<span class="cm-lp-linebreak"> +</span>');

  // --- AsciiDoc text replacements ---
  result = result.replace(/\(C\)/g, "\u00A9");
  result = result.replace(/\(R\)/g, "\u00AE");
  result = result.replace(/\(TM\)/g, "\u2122");
  result = result.replace(/(?<!\w)==&gt;/g, "\u21D2");  // => (escaped >)
  result = result.replace(/&lt;==/g, "\u21D0");          // <= (escaped <)
  result = result.replace(/(?<![<\w])-&gt;/g, "\u2192"); // -> (escaped >)
  result = result.replace(/&lt;-(?!>)/g, "\u2190");      // <- (escaped <)
  result = result.replace(/(\s)--(\s)/g, "$1\u2014$2");  // -- (em dash)
  result = result.replace(/(?<!\.)\.{3}(?!\.)/g, "\u2026"); // ... (ellipsis, not ....)


  // --- AsciiDoc attribute references: {name} ---
  result = result.replace(/\{(\w[\w-]*)\}/g, (_m, name) => {
    const val = asciidocAttributes[name.toLowerCase()];
    return val !== undefined ? escapeHtml(val) : `{${name}}`;
  });

  // --- HTML numeric character references: &#NNN; and &#xHHH; ---
  result = result.replace(/&amp;#(\d+);/g, (_m, code) => {
    const cp = parseInt(code, 10);
    return cp > 0 && cp < 0x110000 ? String.fromCodePoint(cp) : `&#${code};`;
  });
  result = result.replace(/&amp;#x([0-9a-fA-F]+);/g, (_m, hex) => {
    const cp = parseInt(hex, 16);
    return cp > 0 && cp < 0x110000 ? String.fromCodePoint(cp) : `&#x${hex};`;
  });

  // --- Named HTML entities: &entity; ---
  result = result.replace(/&amp;(\w+);/g, (_m, name) => {
    const entity = `&${name};`;
    // Use the browser's built-in entity decoder
    const el = _entityDecoder || (_entityDecoder = document.createElement("textarea"));
    el.innerHTML = entity;
    const decoded = el.value;
    return decoded !== entity ? escapeHtml(decoded) : entity;
  });

  // ── Phase 3: Restore stem placeholders ──
  for (let idx = 0; idx < stemPlaceholders.length; idx++) {
    result = result.replace(
      escapeHtml(`${STEM_TOKEN}${idx}\x00`),
      stemPlaceholders[idx],
    );
  }

  return result;
}

let _entityDecoder: HTMLTextAreaElement | null = null;

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// =====================================================
// Stem Block Preview Widget (cursor outside block)
// =====================================================

class StemBlockPreviewWidget extends WidgetType {
  constructor(
    readonly expression: string,
    readonly rawNotation: "stem" | "latexmath" | "asciimath",
    readonly lineFrom: number,
    readonly blockFrom: number,
    readonly blockTo: number,
  ) { super(); }

  toDOM(): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "cm-lp-stemblock";
    wrap.setAttribute(LINE_HEIGHT_DATA_ATTR, String(this.lineFrom));

    attachBlockModalHandlers(wrap, (view) => {
      openStemBlockEditorModal(view, this.expression, this.rawNotation, this.blockFrom, this.blockTo);
    });

    const content = document.createElement("div");
    content.className = "cm-lp-stemblock-content";
    content.innerHTML = renderMath(this.expression, resolveStemNotation(this.rawNotation), true);
    wrap.appendChild(content);
    return wrap;
  }

  eq(other: StemBlockPreviewWidget): boolean {
    return this.expression === other.expression
      && this.rawNotation === other.rawNotation
      && this.lineFrom === other.lineFrom
      && this.blockFrom === other.blockFrom
      && this.blockTo === other.blockTo;
  }

  ignoreEvent(event: Event): boolean {
    return event.type === "mousedown"
      || event.type === "mouseup"
      || event.type === "mousemove"
      || event.type === "click"
      || event.type === "selectstart"
      || event.type === "dragstart";
  }
}

// =====================================================
// Mermaid Block Preview Widget (cursor outside block)
// =====================================================

class MermaidBlockPreviewWidget extends WidgetType {
  constructor(
    readonly source: string,
    readonly svgHtml: string | null,
    readonly lineFrom: number,
    readonly blockFrom: number,
    readonly blockTo: number,
  ) { super(); }

  toDOM(): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "cm-lp-mermaid-block";
    wrap.setAttribute(LINE_HEIGHT_DATA_ATTR, String(this.lineFrom));

    attachBlockModalHandlers(wrap, (view) => {
      openMermaidBlockEditorModal(view, this.source, this.blockFrom, this.blockTo);
    });

    const content = document.createElement("div");
    content.className = "cm-lp-mermaid-content";

    if (this.svgHtml) {
      content.innerHTML = this.svgHtml;
      const svg = content.querySelector("svg");
      if (svg) {
        svg.style.maxWidth = "100%";
        svg.style.height = "auto";
      }
    } else {
      content.innerHTML = getMermaidPlaceholderHtml();
    }

    wrap.appendChild(content);
    return wrap;
  }

  eq(other: MermaidBlockPreviewWidget): boolean {
    return this.source === other.source
      && this.svgHtml === other.svgHtml
      && this.lineFrom === other.lineFrom
      && this.blockFrom === other.blockFrom
      && this.blockTo === other.blockTo;
  }

  ignoreEvent(event: Event): boolean {
    return event.type === "mousedown"
      || event.type === "mouseup"
      || event.type === "mousemove"
      || event.type === "click"
      || event.type === "selectstart"
      || event.type === "dragstart";
  }
}

// =====================================================
// Document Header Widget (cursor outside header block)
// =====================================================

class DocHeaderWidget extends WidgetType {
  constructor(
    readonly title: string,
    readonly attributes: Array<{ name: string; value: string }>,
    readonly lineFrom: number,
  ) { super(); }

  toDOM(): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "cm-lp-docheader";
    wrap.setAttribute(LINE_HEIGHT_DATA_ATTR, String(this.lineFrom));

    // Header label
    const label = document.createElement("div");
    label.className = "cm-lp-docheader-label";
    label.textContent = "Document Attributes";
    wrap.appendChild(label);

    // Attribute tags container
    const tagsWrap = document.createElement("div");
    tagsWrap.className = "cm-lp-docheader-tags";

    for (const attr of this.attributes) {
      const tag = document.createElement("span");
      tag.className = "cm-lp-docheader-tag";
      const nameEl = document.createElement("span");
      nameEl.className = "cm-lp-docheader-tag-name";
      nameEl.textContent = attr.name;
      tag.appendChild(nameEl);
      if (attr.value) {
        const valueEl = document.createElement("span");
        valueEl.className = "cm-lp-docheader-tag-value";
        valueEl.textContent = attr.value;
        tag.appendChild(valueEl);
      }
      tagsWrap.appendChild(tag);
    }

    wrap.appendChild(tagsWrap);
    return wrap;
  }

  eq(other: DocHeaderWidget): boolean {
    return this.title === other.title
      && this.lineFrom === other.lineFrom
      && this.attributes.length === other.attributes.length
      && this.attributes.every((a, i) => a.name === other.attributes[i].name && a.value === other.attributes[i].value);
  }

  ignoreEvent(): boolean { return false; }
}

// =====================================================
// Code Block Preview Widget (cursor outside block)
// =====================================================

class CodeBlockPreviewWidget extends WidgetType {
  constructor(
    readonly language: string,
    readonly code: string,
    readonly lineFrom: number,
    readonly blockFrom: number,
    readonly blockTo: number,
    readonly hadAttributeLine: boolean,
  ) { super(); }

  toDOM(): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "cm-lp-codeblock";
    wrap.setAttribute(LINE_HEIGHT_DATA_ATTR, String(this.lineFrom));
    attachBlockModalHandlers(wrap, (view) => {
      openCodeBlockEditorModal(view, this.language, this.code, this.blockFrom, this.blockTo, this.hadAttributeLine);
    });

    const header = document.createElement("div");
    header.className = "cm-lp-codeblock-header";
    header.textContent = (this.language || "code").toUpperCase();
    wrap.appendChild(header);

    const pre = document.createElement("pre");
    pre.className = "cm-lp-codeblock-pre";
    const codeEl = document.createElement("code");
    codeEl.textContent = this.code;
    pre.appendChild(codeEl);
    wrap.appendChild(pre);

    return wrap;
  }

  eq(other: CodeBlockPreviewWidget): boolean {
    return this.language === other.language
      && this.code === other.code
      && this.lineFrom === other.lineFrom
      && this.blockFrom === other.blockFrom
      && this.blockTo === other.blockTo
      && this.hadAttributeLine === other.hadAttributeLine;
  }

  ignoreEvent(event: Event): boolean {
    return event.type === "mousedown"
      || event.type === "mouseup"
      || event.type === "mousemove"
      || event.type === "click"
      || event.type === "selectstart"
      || event.type === "dragstart";
  }
}

// =====================================================
// Table Preview Widget (cursor outside block)
// =====================================================

class TablePreviewWidget extends WidgetType {
  constructor(
    readonly headers: string[],
    readonly rows: string[][],
    readonly lineFrom: number,
    readonly blockFrom: number,
    readonly blockTo: number,
  ) { super(); }

  toDOM(): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "cm-lp-table-wrap";
    wrap.setAttribute(LINE_HEIGHT_DATA_ATTR, String(this.lineFrom));
    attachBlockModalHandlers(wrap, (view) => {
      openTableBlockEditorModal(view, this.headers, this.rows, this.blockFrom, this.blockTo);
    });

    const table = document.createElement("table");
    table.className = "cm-lp-table";

    if (this.headers.length > 0) {
      const thead = document.createElement("thead");
      const tr = document.createElement("tr");
      for (const h of this.headers) {
        const th = document.createElement("th");
        th.innerHTML = renderInline(h);
        tr.appendChild(th);
      }
      thead.appendChild(tr);
      table.appendChild(thead);
    }

    if (this.rows.length > 0) {
      const tbody = document.createElement("tbody");
      for (const row of this.rows) {
        const tr = document.createElement("tr");
        for (const cell of row) {
          const td = document.createElement("td");
          td.innerHTML = renderInline(cell);
          tr.appendChild(td);
        }
        tbody.appendChild(tr);
      }
      table.appendChild(tbody);
    }

    wrap.appendChild(table);
    return wrap;
  }

  eq(other: TablePreviewWidget): boolean {
    return JSON.stringify(this.headers) === JSON.stringify(other.headers)
      && JSON.stringify(this.rows) === JSON.stringify(other.rows)
      && this.lineFrom === other.lineFrom
      && this.blockFrom === other.blockFrom
      && this.blockTo === other.blockTo;
  }

  ignoreEvent(event: Event): boolean {
    return event.type === "mousedown"
      || event.type === "mouseup"
      || event.type === "mousemove"
      || event.type === "click"
      || event.type === "selectstart"
      || event.type === "dragstart";
  }
}

// =====================================================
// Blockquote Preview Widget
// =====================================================

class BlockquotePreviewWidget extends WidgetType {
  constructor(
    readonly lines: string[],
    readonly author: string,
    readonly rawContent: string,
    readonly lineFrom: number,
    readonly blockFrom: number,
    readonly blockTo: number,
    readonly hadAttributeLine: boolean,
  ) { super(); }

  toDOM(): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "cm-lp-blockquote-wrap";
    wrap.setAttribute(LINE_HEIGHT_DATA_ATTR, String(this.lineFrom));
    attachBlockModalHandlers(wrap, (view) => {
      openBlockquoteEditorModal(
        view,
        this.author,
        this.rawContent,
        this.blockFrom,
        this.blockTo,
        this.hadAttributeLine,
      );
    });

    const quote = document.createElement("div");
    quote.className = "cm-lp-blockquote";

    const content = document.createElement("div");
    content.className = "cm-lp-blockquote-content";
    content.innerHTML = this.lines.map(l => renderInline(l)).join("<br>");
    quote.appendChild(content);

    if (this.author) {
      const attr = document.createElement("div");
      attr.className = "cm-lp-blockquote-attribution";
      attr.textContent = "\u2014 " + this.author;
      quote.appendChild(attr);
    }

    wrap.appendChild(quote);
    return wrap;
  }

  eq(other: BlockquotePreviewWidget): boolean {
    return this.author === other.author
      && JSON.stringify(this.lines) === JSON.stringify(other.lines)
      && this.rawContent === other.rawContent
      && this.lineFrom === other.lineFrom
      && this.blockFrom === other.blockFrom
      && this.blockTo === other.blockTo
      && this.hadAttributeLine === other.hadAttributeLine;
  }

  ignoreEvent(event: Event): boolean {
    return event.type === "mousedown"
      || event.type === "mouseup"
      || event.type === "mousemove"
      || event.type === "click"
      || event.type === "selectstart"
      || event.type === "dragstart";
  }
}

class ContentBlockPreviewWidget extends WidgetType {
  constructor(
    readonly kind: ContentBlockInfo["kind"],
    readonly titleHtml: string,
    readonly lines: Array<{ html: string; empty: boolean }>,
    readonly lineFrom: number,
    readonly admonitionType?: string,
  ) { super(); }

  toDOM(): HTMLElement {
    // Admonition blocks get the same styling as inline admonitions but with multi-line content
    if (this.kind === "admonition" && this.admonitionType) {
      const wrap = document.createElement("div");
      wrap.className = `cm-lp-admon-block cm-lp-admon-${this.admonitionType}`;
      wrap.setAttribute(LINE_HEIGHT_DATA_ATTR, String(this.lineFrom));
      attachPreviewFocusHandlers(wrap, this.lineFrom, isInteractivePreviewTarget);

      const labels: Record<string, string> = { note: "Note", tip: "Tip", warning: "Warning", caution: "Caution", important: "Important" };
      const label = document.createElement("div");
      label.className = "cm-lp-admon-label";
      label.textContent = labels[this.admonitionType] || this.admonitionType;
      wrap.appendChild(label);

      const body = document.createElement("div");
      body.className = "cm-lp-admon-block-body";
      for (const line of this.lines) {
        const lineEl = document.createElement("div");
        lineEl.className = `cm-lp-content-block-line${line.empty ? " cm-lp-content-block-line-empty" : ""}`;
        lineEl.innerHTML = line.html;
        body.appendChild(lineEl);
      }
      wrap.appendChild(body);
      return wrap;
    }

    const wrap = document.createElement("div");
    wrap.className = `cm-lp-content-block-wrap cm-lp-content-block-${this.kind}`;
    wrap.setAttribute(LINE_HEIGHT_DATA_ATTR, String(this.lineFrom));
    attachPreviewFocusHandlers(wrap, this.lineFrom, isInteractivePreviewTarget);

    if (this.kind === "collapsible") {
      const summary = document.createElement("div");
      summary.className = "cm-lp-content-block-summary";

      const caret = document.createElement("span");
      caret.className = "cm-lp-content-block-caret";
      caret.textContent = "\u25b8";
      summary.appendChild(caret);

      const text = document.createElement("span");
      text.className = "cm-lp-content-block-summary-text";
      text.innerHTML = this.titleHtml || renderInline("Click to expand");
      summary.appendChild(text);

      wrap.appendChild(summary);
      return wrap;
    }

    if (this.titleHtml) {
      const title = document.createElement("div");
      title.className = "cm-lp-content-block-title";
      title.innerHTML = this.titleHtml;
      wrap.appendChild(title);
    }

    const body = document.createElement("div");
    body.className = "cm-lp-content-block-body";
    for (const line of this.lines) {
      const lineEl = document.createElement("div");
      lineEl.className = `cm-lp-content-block-line${line.empty ? " cm-lp-content-block-line-empty" : ""}`;
      lineEl.innerHTML = line.html;
      body.appendChild(lineEl);
    }
    wrap.appendChild(body);

    return wrap;
  }

  eq(other: ContentBlockPreviewWidget): boolean {
    return this.kind === other.kind
      && this.titleHtml === other.titleHtml
      && JSON.stringify(this.lines) === JSON.stringify(other.lines)
      && this.lineFrom === other.lineFrom
      && this.admonitionType === other.admonitionType;
  }

  ignoreEvent(event: Event): boolean {
    return event.type === "mousedown"
      || event.type === "mouseup"
      || event.type === "mousemove"
      || event.type === "click"
      || event.type === "selectstart"
      || event.type === "dragstart";
  }
}

class ImagePreviewWidget extends WidgetType {
  constructor(
    readonly options: ImageInsertOptions & { source: "web" | "local" },
    readonly lineFrom: number,
    readonly blockFrom: number,
    readonly blockTo: number,
  ) { super(); }

  toDOM(): HTMLElement {
    const align = this.options.align;
    const wrap = document.createElement("div");
    wrap.className = "cm-lp-image-block";
    wrap.setAttribute(LINE_HEIGHT_DATA_ATTR, String(this.lineFrom));
    // Use inline styles for alignment — CM6 theme scoping makes class selectors unreliable
    wrap.style.display = "flex";
    wrap.style.flexDirection = "column";
    wrap.style.width = "100%";
    wrap.style.margin = "0.35em 0";
    wrap.style.alignItems = align === "left" ? "flex-start" : align === "right" ? "flex-end" : "center";
    attachBlockModalHandlers(wrap, (view) => {
      openImageEditorModal(view, {
        options: this.options,
        blockFrom: this.blockFrom,
        blockTo: this.blockTo,
      });
    });

    // Inner column: title + image — title always centered over image
    const col = document.createElement("div");
    col.style.display = "inline-flex";
    col.style.flexDirection = "column";
    col.style.alignItems = "center";
    col.style.maxWidth = "100%";

    if (this.options.title.trim()) {
      const title = document.createElement("div");
      title.className = "cm-lp-image-block-title";
      title.style.textAlign = "center";
      title.innerHTML = renderInline(this.options.title.trim());
      col.appendChild(title);
    }

    const image = document.createElement("img");
    image.className = "cm-lp-image";
    const resourceMatch = this.options.target.match(/^:\/?([a-f0-9]{32})/);
    if (resourceMatch) {
      const cached = resourceUrlCache.get(resourceMatch[1]);
      if (cached) {
        image.src = cached;
        image.alt = this.options.alt || "";
      } else {
        image.src = "";
        image.alt = "Loading resource...";
      }
    } else {
      image.src = normalizeImageTarget(this.options.target);
      image.alt = this.options.alt || "";
    }
    col.appendChild(image);

    const captionText = this.options.caption.trim();
    const captionPos = this.options.captionPosition || "below";
    const isSideCaption = captionText && (captionPos === "left" || captionPos === "right");
    const scalePercent = this.options.width !== 100 ? this.options.width : 100;

    // Set scale on the col so percentage is relative to the full line width
    if (scalePercent !== 100) {
      col.style.width = `${scalePercent}%`;
      image.style.width = "100%";
    }

    if (isSideCaption) {
      // Side-by-side layout: image column takes scale% of full width, caption fills the rest
      const row = document.createElement("div");
      row.style.display = "flex";
      row.style.alignItems = "center";
      row.style.gap = "1.143em";
      row.style.width = "100%";

      // Image column: fixed size within the row, caption fills the rest
      col.style.flex = "0 0 auto";
      col.style.maxWidth = `${scalePercent}%`;

      const caption = document.createElement("div");
      caption.className = "cm-lp-image-block-caption";
      caption.style.flex = "1 1 0";
      caption.style.minWidth = "0";
      caption.style.wordWrap = "break-word";
      caption.style.overflowWrap = "break-word";
      // Center the caption text within its available space
      caption.style.textAlign = "center";
      caption.style.display = "flex";
      caption.style.alignItems = "center";
      caption.style.justifyContent = "center";
      caption.innerHTML = renderInline(captionText);

      if (captionPos === "left") {
        row.appendChild(caption);
        row.appendChild(col);
      } else {
        row.appendChild(col);
        row.appendChild(caption);
      }
      wrap.appendChild(row);
    } else {
      if (captionText) {
        const caption = document.createElement("div");
        caption.className = "cm-lp-image-block-caption";
        caption.innerHTML = renderInline(captionText);
        col.appendChild(caption);
      }
      wrap.appendChild(col);
    }

    return wrap;
  }

  eq(other: ImagePreviewWidget): boolean {
    return JSON.stringify(this.options) === JSON.stringify(other.options)
      && this.lineFrom === other.lineFrom
      && this.blockFrom === other.blockFrom
      && this.blockTo === other.blockTo;
  }

  ignoreEvent(event: Event): boolean {
    return event.type === "mousedown"
      || event.type === "mouseup"
      || event.type === "mousemove"
      || event.type === "click"
      || event.type === "selectstart"
      || event.type === "dragstart";
  }
}

// =====================================================
// Table Edit Widget (cursor inside block)
// =====================================================

const LANGUAGES = [
  "javascript", "typescript", "python", "rust", "java",
  "html", "css", "json", "bash", "sql", "go", "ruby",
  "c", "cpp", "csharp", "kotlin", "swift", "php", "xml", "yaml",
];

class TableEditWidget extends WidgetType {
  constructor(
    readonly headers: string[],
    readonly rows: string[][],
    readonly blockFrom: number,
    readonly blockTo: number,
    readonly options: { liveSync?: boolean; showDeleteButton?: boolean } = {},
  ) { super(); }

  toDOM(): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "cm-lp-table-edit";
    wrap.contentEditable = "false"; // Non-editable island — prevents CM from stealing focus
    (wrap as any)._blockFrom = this.blockFrom;
    (wrap as any)._blockTo = this.blockTo;

    const table = document.createElement("table");
    table.className = "cm-lp-table";

    // Header row
    const thead = document.createElement("thead");
    const headerTr = document.createElement("tr");
    for (const h of this.headers) {
      headerTr.appendChild(this.makeCell("th", h.trim(), wrap));
    }
    thead.appendChild(headerTr);
    table.appendChild(thead);

    // Body rows
    const tbody = document.createElement("tbody");
    for (const row of this.rows) {
      const tr = document.createElement("tr");
      for (const cell of row) {
        tr.appendChild(this.makeCell("td", cell.trim(), wrap));
      }
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    wrap.appendChild(table);

    // Toolbar
    const toolbar = document.createElement("div");
    toolbar.className = "cm-lp-table-buttons";

    toolbar.appendChild(this.makeBtn("+ Row", () => {
      const numCols = this.getColCount(wrap);
      const tr = document.createElement("tr");
      for (let c = 0; c < numCols; c++) {
        if (c === 0 && (wrap as any)._sideHeaders) {
          const th = this.makeCell("th", " ", wrap);
          th.classList.add("cm-lp-side-header");
          tr.appendChild(th);
        } else {
          tr.appendChild(this.makeCell("td", " ", wrap));
        }
      }
      tbody.appendChild(tr);
      this.syncToDoc(wrap);
    }));
    toolbar.appendChild(this.makeBtn("+ Column", () => this.addColumn(wrap)));
    toolbar.appendChild(this.makeBtn("\u2212 Row", () => this.deleteRow(wrap), true));
    toolbar.appendChild(this.makeBtn("\u2212 Column", () => this.deleteColumn(wrap), true));

    const sep = document.createElement("span");
    sep.className = "cm-lp-table-btn-sep";
    toolbar.appendChild(sep);

    // Helper to update toggle button styles based on current state
    const updateToggleStyles = () => {
      const hasTopHeaders = !!wrap.querySelector("thead th");
      toggleTopBtn.className = "cm-lp-table-btn" + (hasTopHeaders ? " cm-lp-table-btn-danger" : "");
      toggleTopBtn.textContent = hasTopHeaders ? "\u2212 Top Headers" : "+ Top Headers";

      const hasSideHeaders = !!(wrap as any)._sideHeaders;
      toggleSideBtn.className = "cm-lp-table-btn" + (hasSideHeaders ? " cm-lp-table-btn-danger" : "");
      toggleSideBtn.textContent = hasSideHeaders ? "\u2212 Side Headers" : "+ Side Headers";
    };

    // Toggle top headers: add a new header row or delete existing one
    const toggleTopBtn = this.makeBtn("", () => {
      const theadEl = wrap.querySelector("thead");
      if (theadEl && theadEl.querySelector("tr")) {
        // Remove header row entirely
        theadEl.querySelector("tr")!.remove();
      } else {
        // Add new header row with placeholder text
        const numCols = this.getColCount(wrap);
        const newHeaderTr = document.createElement("tr");
        for (let c = 0; c < numCols; c++) {
          newHeaderTr.appendChild(this.makeCell("th", `Header ${c + 1}`, wrap));
        }
        if (!theadEl) {
          const newThead = document.createElement("thead");
          newThead.appendChild(newHeaderTr);
          table.insertBefore(newThead, tbody);
        } else {
          theadEl.appendChild(newHeaderTr);
        }
      }
      updateToggleStyles();
      this.syncToDoc(wrap);
    });
    toggleTopBtn.title = "Toggle top header row";
    toolbar.appendChild(toggleTopBtn);

    // Toggle side headers: add/delete first column (matches top headers behavior)
    const toggleSideBtn = this.makeBtn("", () => {
      const hasSide = !!(wrap as any)._sideHeaders;
      if (hasSide) {
        // Delete first column entirely
        const headerRow = wrap.querySelector("thead tr");
        if (headerRow && headerRow.children.length > 0) {
          headerRow.children[0].remove();
        }
        for (const row of Array.from(wrap.querySelectorAll("tbody tr"))) {
          if (row.children.length > 0) row.children[0].remove();
        }
        (wrap as any)._sideHeaders = false;
      } else {
        // Add new first column with header-styled cells
        const headerRow = wrap.querySelector("thead tr");
        if (headerRow) {
          const th = this.makeCell("th", "Header", wrap);
          th.classList.add("cm-lp-side-header");
          headerRow.insertBefore(th, headerRow.firstChild);
        }
        for (const row of Array.from(wrap.querySelectorAll("tbody tr"))) {
          const th = this.makeCell("th", " ", wrap);
          th.classList.add("cm-lp-side-header");
          row.insertBefore(th, row.firstChild);
        }
        (wrap as any)._sideHeaders = true;
      }
      updateToggleStyles();
      this.syncToDoc(wrap);
    });
    toggleSideBtn.title = "Toggle side header column";
    toolbar.appendChild(toggleSideBtn);

    // Set initial toggle button styles
    updateToggleStyles();

    toolbar.appendChild(sep.cloneNode());

    if (this.options.showDeleteButton !== false) {
      const deleteBtn = this.makeBtn("Delete Table", () => {
        const view = this.getView(wrap);
        if (!view) return;
        const from = (wrap as any)._blockFrom as number;
        const to = (wrap as any)._blockTo as number;
        (wrap as any)._noSync = true; // Don't sync on destroy — we're deleting
        deleteBlockRange(view, from, to);
        view.focus();
      }, true);
      toolbar.appendChild(deleteBtn);
    }

    wrap.appendChild(toolbar);

    // Escape to exit table
    wrap.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        if (this.options.liveSync === false) {
          e.stopPropagation();
          return;
        }
        const view = this.getView(wrap);
        if (view) {
          this.syncToDoc(wrap);
          const to = (wrap as any)._blockTo;
          const newPos = Math.min(to + 1, view.state.doc.length);
          view.dispatch({ selection: { anchor: newPos } });
          view.focus();
        }
      }
    });

    return wrap;
  }

  private makeCell(tag: "th" | "td", text: string, wrap: HTMLElement): HTMLElement {
    const cell = document.createElement(tag);
    // Use an <input> element inside the cell — completely isolated from CM's
    // contentEditable/selection/mutation handling, preventing focus theft
    const input = document.createElement("input");
    input.type = "text";
    input.className = "cm-lp-table-input";
    input.value = text.trim();
    input.spellcheck = false;
    input.addEventListener("input", () => this.debouncedSync(wrap));
    input.addEventListener("blur", () => {
      setTimeout(() => {
        if (!wrap.contains(document.activeElement)) {
          this.syncToDoc(wrap);
        }
      }, 0);
    });
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      this.handleCellNav(e, input, wrap);
    });
    input.addEventListener("mousedown", (e) => {
      e.stopPropagation();
    });
    cell.appendChild(input);
    return cell;
  }

  private debouncedSync(wrap: HTMLElement) {
    clearTimeout((wrap as any)._syncTimer);
    (wrap as any)._syncTimer = setTimeout(() => {
      // Only sync if focus is still inside the wrap (user still editing)
      if (wrap.contains(document.activeElement)) {
        // Save and restore focus across the sync
        const activeEl = document.activeElement as HTMLElement;
        const sel = window.getSelection();
        let savedNode: Node | null = null;
        let savedOffset = 0;
        if (sel && sel.rangeCount > 0) {
          const r = sel.getRangeAt(0);
          savedNode = r.startContainer;
          savedOffset = r.startOffset;
        }

        this.syncToDoc(wrap);

        // Restore focus
        activeEl.focus();
        if (savedNode && activeEl.contains(savedNode)) {
          try {
            const newSel = window.getSelection();
            newSel?.collapse(savedNode, Math.min(savedOffset, savedNode.textContent?.length ?? 0));
          } catch (_) { /* ignore */ }
        }
      } else {
        this.syncToDoc(wrap);
      }
    }, 300);
  }

  private makeBtn(label: string, onClick: () => void, danger = false): HTMLButtonElement {
    const btn = document.createElement("button");
    btn.className = "cm-lp-table-btn" + (danger ? " cm-lp-table-btn-danger" : "");
    btn.textContent = label;
    btn.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      onClick();
    });
    return btn;
  }

  private getColCount(wrap: HTMLElement): number {
    const headerCells = wrap.querySelectorAll("thead th");
    if (headerCells.length > 0) return headerCells.length;
    const firstRow = wrap.querySelector("tbody tr");
    return firstRow ? firstRow.children.length : 1;
  }

  private getView(wrap: HTMLElement): EditorView | null {
    const editor = wrap.closest(".cm-editor");
    if (editor) return EditorView.findFromDOM(editor as HTMLElement) ?? null;
    return null;
  }

  private handleCellNav(e: KeyboardEvent, input: HTMLElement, wrap: HTMLElement) {
    if (e.key === "Tab") {
      e.preventDefault();
      const inputs = Array.from(wrap.querySelectorAll(".cm-lp-table-input")) as HTMLInputElement[];
      const idx = inputs.indexOf(input as HTMLInputElement);
      const next = e.shiftKey ? inputs[idx - 1] : inputs[idx + 1];
      if (next) {
        next.focus();
        next.select();
      }
    }
  }

  private syncToDoc(wrap: HTMLElement) {
    if ((wrap as any)._syncing || (wrap as any)._noSync) return;
    const content = serializeTableFromWrap(wrap);

    if (this.options.liveSync === false) {
      (wrap as any)._serialized = content;
      return;
    }

    const view = this.getView(wrap);
    if (!view) return;

    const from = (wrap as any)._blockFrom as number;
    const to = (wrap as any)._blockTo as number;
    if (from == null || to == null) return;
    if (from >= view.state.doc.length || to > view.state.doc.length) return;

    const currentText = view.state.sliceDoc(from, to);
    if (content === currentText) return;

    (wrap as any)._syncing = true;
    view.dispatch({ changes: { from, to, insert: content } });
    (wrap as any)._blockTo = from + content.length;
    (wrap as any)._syncing = false;
  }

  private addColumn(wrap: HTMLElement) {
    const headerRow = wrap.querySelector("thead tr");
    if (headerRow) {
      headerRow.appendChild(this.makeCell("th", "New", wrap));
    }
    for (const row of Array.from(wrap.querySelectorAll("tbody tr"))) {
      row.appendChild(this.makeCell("td", " ", wrap));
    }
    this.syncToDoc(wrap);
  }

  private deleteRow(wrap: HTMLElement) {
    const rows = wrap.querySelectorAll("tbody tr");
    if (rows.length > 0) {
      rows[rows.length - 1].remove();
      this.syncToDoc(wrap);
    }
  }

  private deleteColumn(wrap: HTMLElement) {
    const headerCells = wrap.querySelectorAll("thead th");
    if (headerCells.length <= 1) {
      const firstRow = wrap.querySelector("tbody tr");
      if (!firstRow || firstRow.children.length <= 1) return;
    }
    if (headerCells.length > 0) headerCells[headerCells.length - 1].remove();
    for (const row of Array.from(wrap.querySelectorAll("tbody tr"))) {
      const cells = row.children;
      if (cells.length > 0) cells[cells.length - 1].remove();
    }
    this.syncToDoc(wrap);
  }

  eq(_other: TableEditWidget): boolean {
    // Always return false so updateDOM gets called
    return false;
  }

  updateDOM(dom: HTMLElement): boolean {
    // Update position tracking, preserve existing DOM to keep focus/edits
    (dom as any)._blockFrom = this.blockFrom;
    (dom as any)._blockTo = this.blockTo;
    return true;
  }

  ignoreEvent(): boolean { return true; }
}

// =====================================================
// Code Block Language Dropdown Widget
// =====================================================

class CodeLangWidget extends WidgetType {
  constructor(
    readonly language: string,
    readonly attrFrom: number,
    readonly attrTo: number,
  ) { super(); }

  toDOM(): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "cm-lp-codeblock-lang-wrap";

    const btn = document.createElement("button");
    btn.className = "cm-lp-codeblock-lang-btn";
    btn.textContent = (this.language || "text").toUpperCase() + " \u25BE";

    const dropdown = document.createElement("div");
    dropdown.className = "cm-lp-codeblock-dropdown";
    dropdown.style.display = "none";

    for (const lang of LANGUAGES) {
      const option = document.createElement("button");
      option.className = "cm-lp-codeblock-dropdown-item";
      option.textContent = lang;
      option.addEventListener("mousedown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        dropdown.style.display = "none";
        const editor = wrap.closest(".cm-editor");
        if (editor) {
          const view = EditorView.findFromDOM(editor as HTMLElement);
          if (view) {
            view.dispatch({
              changes: { from: this.attrFrom, to: this.attrTo, insert: `[source,${lang}]` },
            });
          }
        }
      });
      dropdown.appendChild(option);
    }

    btn.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropdown.style.display = dropdown.style.display === "none" ? "flex" : "none";
    });

    // Close dropdown on outside click
    const closeHandler = (e: MouseEvent) => {
      if (!wrap.contains(e.target as Node)) {
        dropdown.style.display = "none";
        document.removeEventListener("mousedown", closeHandler);
      }
    };
    btn.addEventListener("click", () => {
      setTimeout(() => document.addEventListener("mousedown", closeHandler), 0);
    });

    wrap.appendChild(btn);
    wrap.appendChild(dropdown);
    return wrap;
  }

  eq(other: CodeLangWidget): boolean {
    return this.language === other.language;
  }

  ignoreEvent(): boolean { return true; }
}

// =====================================================
// Line Decorations
// =====================================================

const emptyLineDecoration = Decoration.line({ class: "cm-lp-empty-line" });
const admonLineDecoration = Decoration.line({ class: "cm-lp-admon-line" });
const codeLineDecoration = Decoration.line({ class: "cm-lp-code-line" });
const codeDelimDecoration = Decoration.line({ class: "cm-lp-code-delim-line" });
const hiddenLineDecoration = Decoration.line({ class: "cm-lp-hidden-line" });
const listLineDecoration = Decoration.line({ class: "cm-lp-list-line" });
const specialBlockLineDecoration = Decoration.line({ class: "cm-lp-special-block-line" });

// =====================================================
// Build Decorations
// =====================================================

function buildDecorations(view: EditorView, heightCache: PreviewHeightCache): any {
  const builder = new RangeSetBuilder<Decoration>();
  const doc = view.state.doc;
  const cursorLine = doc.lineAt(view.state.selection.main.head).number;
  const anchorLine = doc.lineAt(view.state.selection.main.anchor).number;
  // Lines that should show as raw (cursor line + any selected range lines)
  const rawLines = new Set<number>();
  rawLines.add(cursorLine);
  if (anchorLine !== cursorLine) {
    // Selection spans multiple lines — show all as raw
    const minLine = Math.min(cursorLine, anchorLine);
    const maxLine = Math.max(cursorLine, anchorLine);
    for (let ln = minLine; ln <= maxLine; ln++) rawLines.add(ln);
  }
  const editorHasFocus = editorHasActiveFocus(view);
  const rawBaseHeightPx = measureRawLineHeightPx(view);
  const blocks = detectBlocks(doc);

  // Detect :stem: document attribute for math notation default
  const stemInfo = detectStemAttribute(doc);
  documentStemNotation = stemInfo.notation;

  // Reset footnote numbering for this render pass
  resetFootnoteNumbering();

  // Precompute ordered list numbering
  const listNumbers = new Map<number, number>();
  {
    const counters: number[] = []; // counter per depth level
    let prevDepth = 0;
    for (let ln = 1; ln <= doc.lines; ln++) {
      const t = doc.line(ln).text.trimStart();
      const m = t.match(/^(\.{1,5})\s+/);
      if (m) {
        const depth = m[1].length;
        if (depth > prevDepth) {
          // Push new counter(s) for deeper levels
          while (counters.length < depth) counters.push(0);
        } else if (depth < prevDepth) {
          // Pop counters for shallower levels
          counters.length = depth;
        }
        counters[depth - 1] = (counters[depth - 1] || 0) + 1;
        listNumbers.set(ln, counters[depth - 1]);
        prevDepth = depth;
      } else if (!t.match(/^(\*{1,5})\s+/) && t !== "") {
        // Non-list, non-empty line resets counters
        counters.length = 0;
        prevDepth = 0;
      }
    }
  }

  let blockIdx = 0;
  let i = 1;
  let pendingRole: string | null = null; // tracks [.role] attribute for next line

  while (i <= doc.lines) {
    const block = blockIdx < blocks.length ? blocks[blockIdx] : null;
    const blockStart = block ? getBlockStartLineNumber(block) : -1;

    // Check if this line starts a block
    if (block && i === blockStart) {
      const blockEnd = getBlockEndLineNumber(block);
      const cursorInBlock = editorHasFocus && cursorLine >= blockStart && cursorLine <= blockEnd;
      const fromPos = doc.line(blockStart).from;
      const toPos = doc.line(blockEnd).to;

      // Block-level height stabilization is intentionally disabled for content
      // blocks (sidebar, example, quote, etc.). Their raw lines naturally take
      // up sufficient height, and adding padding to match the rendered widget
      // creates excessive spacing and scroll drift. Code blocks handle their
      // own padding separately in their cursorInBlock rendering path.

      if (block.type === "docheader") {
        if (!cursorInBlock) {
          const firstLine = doc.line(blockStart);
          builder.add(firstLine.from, firstLine.from, specialBlockLineDecoration);
          builder.add(firstLine.from, firstLine.to, Decoration.replace({
            widget: new DocHeaderWidget(block.title, block.attributes, firstLine.from),
          }));
          // Hide remaining lines
          for (let j = blockStart + 1; j <= blockEnd; j++) {
            const line = doc.line(j);
            builder.add(line.from, line.from, hiddenLineDecoration);
            if (line.from < line.to) {
              builder.add(line.from, line.to, Decoration.replace({ widget: new PreviewLineWidget("", line.from) }));
            }
          }
        }
        // When cursorInBlock: raw text shown for editing
      } else if (block.type === "image") {
        if (!cursorInBlock) {
          const firstLine = doc.line(blockStart);
          builder.add(firstLine.from, firstLine.from, specialBlockLineDecoration);
          builder.add(firstLine.from, firstLine.to, Decoration.replace({
            widget: new ImagePreviewWidget(block.options, firstLine.from, fromPos, toPos),
          }));
          for (let j = blockStart + 1; j <= blockEnd; j++) {
            const line = doc.line(j);
            builder.add(line.from, line.from, hiddenLineDecoration);
            if (line.from < line.to) {
              builder.add(line.from, line.to, Decoration.replace({ widget: new PreviewLineWidget("", line.from) }));
            }
          }
        }
      } else if (block.type === "contentblock") {
        if (!cursorInBlock) {
          const firstLine = doc.line(blockStart);
          const contentLines = block.kind === "collapsible"
            ? []
            : buildContentBlockPreviewLines(doc, block.openLine, block.closeLine, listNumbers);

          builder.add(firstLine.from, firstLine.to, Decoration.replace({
            widget: new ContentBlockPreviewWidget(
              block.kind,
              block.title ? renderInline(block.title) : "",
              contentLines,
              firstLine.from,
              block.admonitionType,
            ),
          }));
          for (let j = blockStart + 1; j <= blockEnd; j++) {
            const line = doc.line(j);
            builder.add(line.from, line.from, hiddenLineDecoration);
            if (line.from < line.to) {
              builder.add(line.from, line.to, Decoration.replace({ widget: new PreviewLineWidget("", line.from) }));
            }
          }
        }
      } else if (block.type === "code") {
        if (cursorInBlock) {
          // Calculate padding for height stabilization
          let cachedCodeHeight = heightCache.lineHeights.get(doc.line(blockStart).from);
          if (!cachedCodeHeight) {
            const codeLineCount = Math.max(1, block.closeLine - block.openLine - 1);
            cachedCodeHeight = estimateCodeBlockHeightPx(codeLineCount, rawBaseHeightPx);
          }
          let codePaddingTop = 0;
          let codePaddingBottom = 0;
          const rawCount = blockEnd - blockStart + 1;
          const rawTotal = rawCount * rawBaseHeightPx;
          const delta = Math.max(0, cachedCodeHeight - rawTotal);
          if (delta > 4) {
            codePaddingTop = Math.floor(delta / 2);
            codePaddingBottom = Math.ceil(delta / 2);
          }

          // Edit mode: show raw lines with styling
          for (let j = blockStart; j <= blockEnd; j++) {
            const line = doc.line(j);
            const isFirst = j === blockStart;
            const isLast = j === blockEnd;
            const padStyle = (isFirst && codePaddingTop ? `padding-top:${codePaddingTop}px;` : "")
              + (isLast && codePaddingBottom ? `padding-bottom:${codePaddingBottom}px;` : "");

            if (j === cursorLine) {
              builder.add(line.from, line.from, padStyle
                ? Decoration.line({ class: "cm-lp-code-line", attributes: { style: padStyle } })
                : codeLineDecoration);
            } else if (block.attrLine === j && block.attrLine > 0) {
              builder.add(line.from, line.from, padStyle
                ? Decoration.line({ class: "cm-lp-code-delim-line", attributes: { style: padStyle } })
                : codeDelimDecoration);
              builder.add(line.from, line.to, Decoration.replace({
                widget: new CodeLangWidget(block.language, line.from, line.to),
              }));
            } else if (j === block.openLine || j === block.closeLine) {
              builder.add(line.from, line.from, padStyle
                ? Decoration.line({ class: "cm-lp-code-delim-line", attributes: { style: padStyle } })
                : codeDelimDecoration);
            } else {
              builder.add(line.from, line.from, padStyle
                ? Decoration.line({ class: "cm-lp-code-line", attributes: { style: padStyle } })
                : codeLineDecoration);
            }
          }
        } else {
          // Preview mode: first line gets the widget, rest are hidden
          let codeText = "";
          for (let j = block.openLine + 1; j < block.closeLine; j++) {
            if (codeText) codeText += "\n";
            codeText += doc.line(j).text;
          }
          const firstLine = doc.line(blockStart);
          const hadAttributeLine = block.attrLine > 0;
          builder.add(firstLine.from, firstLine.from, specialBlockLineDecoration);
          builder.add(firstLine.from, firstLine.to, Decoration.replace({
            widget: new CodeBlockPreviewWidget(
              block.language,
              codeText,
              firstLine.from,
              fromPos,
              toPos,
              hadAttributeLine,
            ),
          }));
          // Hide remaining lines
          for (let j = blockStart + 1; j <= blockEnd; j++) {
            const line = doc.line(j);
            builder.add(line.from, line.from, hiddenLineDecoration);
            if (line.from < line.to) {
               builder.add(line.from, line.to, Decoration.replace({ widget: new PreviewLineWidget("", line.from) }));
             }
           }
         }
      } else if (block.type === "table") {
        const { headers, rows } = parseTable(doc, block.openLine, block.closeLine);

        if (cursorInBlock) {
          // Edit mode: first line gets the interactive table, rest are hidden
          const firstLine = doc.line(blockStart);
          builder.add(firstLine.from, firstLine.to, Decoration.replace({
            widget: new TableEditWidget(headers, rows, fromPos, toPos),
          }));
          for (let j = blockStart + 1; j <= blockEnd; j++) {
            const line = doc.line(j);
            builder.add(line.from, line.from, hiddenLineDecoration);
            if (line.from < line.to) {
              builder.add(line.from, line.to, Decoration.replace({ widget: new PreviewLineWidget("", line.from) }));
            }
          }
        } else {
          // Preview mode: first line gets the widget, rest are hidden
          const firstLine = doc.line(blockStart);
          builder.add(firstLine.from, firstLine.from, specialBlockLineDecoration);
          builder.add(firstLine.from, firstLine.to, Decoration.replace({
            widget: new TablePreviewWidget(headers, rows, firstLine.from, fromPos, toPos),
          }));
          for (let j = blockStart + 1; j <= blockEnd; j++) {
            const line = doc.line(j);
            builder.add(line.from, line.from, hiddenLineDecoration);
            if (line.from < line.to) {
              builder.add(line.from, line.to, Decoration.replace({ widget: new PreviewLineWidget("", line.from) }));
            }
          }
        }
      } else if (block.type === "blockquote") {
        if (cursorInBlock) {
          // Edit mode: show raw lines
          for (let j = blockStart; j <= blockEnd; j++) {
            i = j; // just let them render as raw
          }
        } else {
          // Preview mode: collect content lines, render widget
          const contentLines: string[] = [];
          let rawQuoteContent = "";
          // For delimited quotes (____...____), content is between delimiters (exclusive).
          // For paragraph-style quotes ([quote] + text), openLine IS the first content line
          // and closeLine IS the last content line (inclusive).
          const isDelimited = /^_{4,}$/.test(doc.line(block.openLine).text.trim());
          const contentStart = isDelimited ? block.openLine + 1 : block.openLine;
          const contentEnd = isDelimited ? block.closeLine - 1 : block.closeLine;
          for (let j = contentStart; j <= contentEnd; j++) {
            const rawLineText = doc.line(j).text;
            if (rawQuoteContent) rawQuoteContent += "\n";
            rawQuoteContent += rawLineText;
            const lineText = rawLineText.trim();
            if (lineText) contentLines.push(lineText);
          }
          const firstLine = doc.line(blockStart);
          const hadAttributeLine = block.attrLine > 0;
          builder.add(firstLine.from, firstLine.from, specialBlockLineDecoration);
          builder.add(firstLine.from, firstLine.to, Decoration.replace({
            widget: new BlockquotePreviewWidget(
              contentLines,
              block.author,
              rawQuoteContent,
              firstLine.from,
              fromPos,
              toPos,
              hadAttributeLine,
            ),
          }));
          for (let j = blockStart + 1; j <= blockEnd; j++) {
            const line = doc.line(j);
            builder.add(line.from, line.from, hiddenLineDecoration);
            if (line.from < line.to) {
              builder.add(line.from, line.to, Decoration.replace({ widget: new PreviewLineWidget("", line.from) }));
            }
          }
        }
      } else if (block.type === "stem") {
        if (!cursorInBlock) {
          // Extract math content between ++++ delimiters
          let mathContent = "";
          for (let j = block.openLine + 1; j < block.closeLine; j++) {
            if (mathContent) mathContent += "\n";
            mathContent += doc.line(j).text;
          }
          const firstLine = doc.line(blockStart);
          builder.add(firstLine.from, firstLine.from, specialBlockLineDecoration);
          builder.add(firstLine.from, firstLine.to, Decoration.replace({
            widget: new StemBlockPreviewWidget(
              mathContent,
              block.rawNotation,
              firstLine.from,
              fromPos,
              toPos,
            ),
          }));
          // Hide remaining lines
          for (let j = blockStart + 1; j <= blockEnd; j++) {
            const line = doc.line(j);
            builder.add(line.from, line.from, hiddenLineDecoration);
            if (line.from < line.to) {
              builder.add(line.from, line.to, Decoration.replace({ widget: new PreviewLineWidget("", line.from) }));
            }
          }
        }
        // When cursorInBlock: raw text shown. Height stabilization handled
        // by the generic non-code path at the top of the block processing.
      } else if (block.type === "mermaid") {
        if (!cursorInBlock) {
          let diagramSource = "";
          for (let j = block.openLine + 1; j < block.closeLine; j++) {
            if (diagramSource) diagramSource += "\n";
            diagramSource += doc.line(j).text;
          }

          const cachedSvg = getCachedMermaidSvg(diagramSource);
          if (!cachedSvg) {
            renderMermaidAsync(diagramSource, () => {
              refreshLivePreview(view);
            });
          }

          const firstLine = doc.line(blockStart);
          builder.add(firstLine.from, firstLine.from, specialBlockLineDecoration);
          builder.add(firstLine.from, firstLine.to, Decoration.replace({
            widget: new MermaidBlockPreviewWidget(
              diagramSource,
              cachedSvg,
              firstLine.from,
              fromPos,
              toPos,
            ),
          }));
          for (let j = blockStart + 1; j <= blockEnd; j++) {
            const line = doc.line(j);
            builder.add(line.from, line.from, hiddenLineDecoration);
            if (line.from < line.to) {
              builder.add(line.from, line.to, Decoration.replace({ widget: new PreviewLineWidget("", line.from) }));
            }
          }
        }
      }

      i = blockEnd + 1;
      blockIdx++;
      continue;
    }

    // Regular line processing — show only the cursor line as raw
    const line = doc.line(i);
    const text = line.text;
    const trimmedText = text.trimStart();
    const isAdmon = /^(NOTE|TIP|WARNING|CAUTION|IMPORTANT|QUESTION):\s+/.test(trimmedText);
    const isList = /^(\*{1,5}|\.{1,5})\s+/.test(trimmedText);
    const isParagraph = isParagraphLikeLine(trimmedText);
    const headingMatch = trimmedText.match(/^(={1,5})\s+/);

    // Detect role/attribute lines like [.lead], [.center], [.text-center], etc.
    // These apply styling to the next line and should be hidden in preview
    const roleMatch = trimmedText.match(/^\[\.([^\]]+)\]$/);
    if (roleMatch && !(editorHasFocus && rawLines.has(i))) {
      pendingRole = roleMatch[1];
      // Hide the role attribute line
      builder.add(line.from, line.from, hiddenLineDecoration);
      if (line.from < line.to) {
        builder.add(line.from, line.to, Decoration.replace({ widget: new PreviewLineWidget("", line.from) }));
      }
      i++;
      continue;
    }

    if (editorHasFocus && rawLines.has(i)) {
      // Only apply height stabilization for headings — their rendered preview
      // (large font + margins) is genuinely taller than the raw monospace text.
      // List items and paragraphs are skipped: their raw text often wraps to
      // MORE lines than the rendered preview, so adding padding just inflates
      // the height and causes scroll drift.
      if (headingMatch) {
        // Use the cached measured height if available (accurate), falling back
        // to the mathematical estimate. The cache is now remapped through doc
        // changes (not cleared), so it stays consistent across typing.
        const cachedHeight = heightCache.lineHeights.get(line.from);
        const renderedHeight = cachedHeight
          ?? estimateHeadingLineHeightPx(rawBaseHeightPx, headingMatch[1].length);
        if (renderedHeight) {
          const decoration = stabilizedLineDecoration(renderedHeight, rawBaseHeightPx);
          if (decoration) {
            builder.add(line.from, line.from, decoration);
          }
        }
      }
      pendingRole = null;
      i++;
      continue;
    }

    if (line.from === line.to) {
      builder.add(line.from, line.from, emptyLineDecoration);
      pendingRole = null;
      i++;
      continue;
    }

    if (isAdmon) {
      builder.add(line.from, line.from, admonLineDecoration);
    } else if (isList) {
      builder.add(line.from, line.from, listLineDecoration);
    }

    // Apply pending role styling to this line
    const role = pendingRole;
    pendingRole = null;
    let html = renderLineHtml(text, i, listNumbers);
    if (role) {
      const roleStyle = getRoleStyle(role);
      if (roleStyle) {
        html = `<span style="${roleStyle}">${html}</span>`;
      }
    }
    builder.add(line.from, line.to, Decoration.replace({ widget: new PreviewLineWidget(html, line.from) }));

    i++;
  }

  return builder.finish();
}

// =====================================================
// Plugin
// =====================================================

const livePreviewPlugin = ViewPlugin.fromClass(
  class {
    decorations: any;
    heightCache: PreviewHeightCache;
    lastRawHeight: number;

    constructor(view: EditorView) {
      this.heightCache = createPreviewHeightCache();
      this.lastRawHeight = measureRawLineHeightPx(view);
      this.decorations = buildDecorations(view, this.heightCache);
      schedulePreviewHeightMeasurement(view, this.heightCache);
    }

    update(update: any) {
      const forceRefresh = update.transactions.some((transaction: any) =>
        transaction.effects.some((effect: any) => effect.is(refreshLivePreviewEffect))
      );
      // Detect font-size changes (zoom, browser zoom, accessibility) and clear stale height cache
      const currentRawHeight = measureRawLineHeightPx(update.view);
      if (Math.abs(currentRawHeight - this.lastRawHeight) > 0.5) {
        this.heightCache.lineHeights.clear();
        this.lastRawHeight = currentRawHeight;
      }
      if (update.docChanged) {
        // Remap height cache keys through document changes instead of clearing.
        // This preserves accurate measured heights for lines that didn't change
        // (e.g., heading widget heights stay valid while editing nearby lines),
        // preventing padding flicker when the user starts typing.
        const remapped = new Map<number, number>();
        for (const [oldFrom, height] of this.heightCache.lineHeights) {
          const newFrom = update.changes.mapPos(oldFrom, 1);
          // Only keep entries where the position is still valid
          if (newFrom >= 0 && newFrom <= update.state.doc.length) {
            remapped.set(newFrom, height);
          }
        }
        this.heightCache.lineHeights = remapped;
        closeFootnotePopup();
      }
      if (update.selectionSet) {
        closeFootnotePopup();
      }
      // Don't lock scroll when search panel is open — search needs to scroll to matches
      const searchOpen = update.view.dom.querySelector(".cm-panel.cm-search") != null;
      const needsScrollLock = (update.selectionSet || update.focusChanged) && !update.docChanged && !searchOpen;

      // Determine cursor jump distance to pick the right stabilization strategy
      const oldLine = update.startState.doc.lineAt(update.startState.selection.main.head).number;
      const newLine = update.state.doc.lineAt(update.state.selection.main.head).number;
      const lineDistance = Math.abs(newLine - oldLine);

      // Capture scroll state BEFORE rebuilding decorations
      const scrollBefore = update.view.scrollDOM.scrollTop;
      let anchorScreenY: number | null = null;
      let anchorCursorPos = -1;
      if (needsScrollLock && lineDistance > 4) {
        // For distant jumps: capture cursor line's screen position for anchor-based restoration
        anchorCursorPos = update.state.selection.main.head;
        const el = getLineElementForPosition(update.view, anchorCursorPos);
        if (el) {
          anchorScreenY = measureElementTopRelativeToScroller(update.view, el);
        }
      }

      if (update.docChanged || update.selectionSet || update.viewportChanged || update.focusChanged || forceRefresh) {
        this.decorations = buildDecorations(update.view, this.heightCache);
        schedulePreviewHeightMeasurement(update.view, this.heightCache);
      }

      if (needsScrollLock) {
        const scroller = update.view.scrollDOM;

        if (lineDistance > 4 && anchorScreenY != null && anchorCursorPos >= 0) {
          // Distant jump (e.g., list item → heading far away):
          // Anchor-based restoration — keeps the clicked line at its pre-click
          // screen position despite large height changes between old/new cursor.
          const targetScreenY = anchorScreenY;
          const cursorPos = anchorCursorPos;
          requestAnimationFrame(() => {
            const el = getLineElementForPosition(update.view, cursorPos);
            if (!el) return;
            const currentScreenY = measureElementTopRelativeToScroller(update.view, el);
            const delta = currentScreenY - targetScreenY;
            if (Math.abs(delta) > 2) {
              scroller.scrollTop += delta;
            }
          });
        } else {
          // Nearby click (adjacent lines, same area):
          // Absolute scrollTop restoration — prevents CM6's scroll-into-view from
          // causing cumulative drift when toggling between raw/preview on nearby lines.
          const restore = () => {
            if (Math.abs(scroller.scrollTop - scrollBefore) > 2) {
              scroller.scrollTop = scrollBefore;
            }
          };
          restore();
          requestAnimationFrame(() => {
            restore();
            requestAnimationFrame(restore);
          });
        }
      }

      // Auto-open modal when cursor enters a block via editing (backspace, etc.)
      // Only when overlay editing mode is enabled
      if (overlayEditingMode && update.docChanged && !blockEditorOverlay && editorHasActiveFocus(update.view)) {
        const view = update.view;
        const cursorLine = view.state.doc.lineAt(view.state.selection.main.head).number;
        const blocks = detectBlocks(view.state.doc);
        for (const block of blocks) {
          const blockStart = getBlockStartLineNumber(block);
          const blockEnd = getBlockEndLineNumber(block);
          if (cursorLine >= blockStart && cursorLine <= blockEnd) {
            // Don't auto-open for content blocks (they show raw) or images (complex)
            if (block.type === "code" || block.type === "table" || block.type === "blockquote" || block.type === "stem" || block.type === "mermaid") {
              // Delay slightly so CM6 finishes its update cycle
              setTimeout(() => {
                if (blockEditorOverlay) return; // Modal already opened
                const info = { block, blockStart, blockEnd };
                openPreviewBlockModal(view, info);
              }, 50);
            }
            break;
          }
        }
      }
    }
  },
  { decorations: (v) => v.decorations },
);

export const refreshLivePreviewEffect = StateEffect.define<null>();

export function refreshLivePreview(view: EditorView) {
  view.dispatch({
    effects: refreshLivePreviewEffect.of(null),
  });
}

// =====================================================
// Theme
// =====================================================

const livePreviewTheme = EditorView.theme({
  "&": {
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
    background: "var(--asciidoc-preview-bg, #fafafa)",
    position: "relative",
    "--editor-base-size": "14px",
    "--editor-scale": "1",
  },
  ".cm-scroller": {
    padding: "12px 0",
  },
  ".cm-content": {
    padding: "0",
  },
  ".cm-line": {
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
    fontSize: "calc(var(--editor-base-size) * var(--editor-scale))",
    lineHeight: "1.6",
  },
  "&.cm-focused .cm-activeLine": {
    fontFamily: "monospace",
    lineHeight: "1.6",
    background: "rgba(128,128,128,0.08) !important",
    borderRadius: "3px",
  },
  // No highlight on the last active line when editor loses focus
  "&:not(.cm-focused) .cm-activeLine": {
    background: "transparent !important",
  },
  ".cm-lp-stabilized-line": {
    boxSizing: "border-box",
  },
  ".cm-gutters": {
    fontFamily: "monospace",
    fontSize: "calc(var(--editor-base-size) * var(--editor-scale))",
    border: "none",
    background: "transparent",
  },
  ".cm-lineNumbers .cm-gutterElement": {
    color: "var(--asciidoc-placeholder, #888)",
    opacity: "0.85",
  },
  "&.cm-focused .cm-lineNumbers .cm-gutterElement.cm-activeLineGutter": {
    color: "var(--asciidoc-fg, #333) !important",
    opacity: "1",
  },

  // Hidden lines (inside blocks, after the first line which has the widget)
  ".cm-lp-hidden-line": {
    lineHeight: "0 !important",
    height: "0 !important",
    minHeight: "0 !important",
    overflow: "hidden",
    padding: "0 !important",
    margin: "0 !important",
    fontSize: "0 !important",
  },

  // Document header block
  ".cm-lp-docheader": {
    display: "flex",
    flexDirection: "column",
    gap: "0.429em",
    padding: "0.571em 0.857em",
    borderRadius: "6px",
    background: "var(--asciidoc-bg-alt, rgba(128,128,128,0.06))",
    border: "1px solid var(--asciidoc-border, rgba(128,128,128,0.15))",
    margin: "2px 0",
  },
  ".cm-lp-docheader-label": {
    fontSize: "0.7em",
    fontWeight: "600",
    textTransform: "uppercase" as any,
    letterSpacing: "0.05em",
    color: "var(--asciidoc-placeholder, #888)",
    opacity: "0.7",
  },
  ".cm-lp-docheader-tags": {
    display: "flex",
    flexWrap: "wrap" as any,
    gap: "0.286em",
  },
  ".cm-lp-docheader-tag": {
    display: "inline-flex",
    alignItems: "center",
    borderRadius: "4px",
    background: "var(--asciidoc-bg-alt, rgba(128,128,128,0.08))",
    border: "1px solid var(--asciidoc-border, rgba(128,128,128,0.12))",
    fontSize: "0.8em",
    lineHeight: "1.4",
    overflow: "hidden",
  },
  ".cm-lp-docheader-tag-name": {
    padding: "0.071em 0.357em",
    color: "var(--asciidoc-placeholder, #888)",
    fontWeight: "500",
  },
  ".cm-lp-docheader-tag-value": {
    padding: "0.071em 0.357em",
    borderLeft: "1px solid var(--asciidoc-border, rgba(128,128,128,0.15))",
    color: "var(--asciidoc-fg, #333)",
    fontWeight: "400",
  },

  // Empty lines — keep full editor line height
  ".cm-lp-empty-line": {
    lineHeight: "1.6 !important",
    height: "1.6em !important",
    minHeight: "1.6em !important",
    overflow: "hidden",
  },

  // Preview line
  ".cm-live-preview-line": {
    lineHeight: "1.6",
  },
  ".cm-live-preview-line strong": { fontWeight: "700" },
  ".cm-live-preview-line em": { fontStyle: "italic" },
  ".cm-live-preview-line sup": { fontSize: "0.75em", verticalAlign: "super" },
  ".cm-live-preview-line sub": { fontSize: "0.75em", verticalAlign: "sub" },
  ".cm-live-preview-line mark": { backgroundColor: "#fff176", color: "#000", borderRadius: "2px", padding: "0.1em 0.2em" },
  ".cm-lp-image-wrap": {
    display: "block",
    width: "100%",
    margin: "0.35em 0",
  },
  ".cm-lp-image-align-left": { textAlign: "left" },
  ".cm-lp-image-align-center": { textAlign: "center" },
  ".cm-lp-image-align-right": { textAlign: "right" },
  ".cm-lp-image": {
    display: "inline-block",
    maxWidth: "100%",
    height: "auto",
    borderRadius: "2px",
  },
  // Image block — layout handled by inline styles in toDOM() for reliability
  ".cm-lp-image-block-title": {
    fontSize: "0.95em",
    fontWeight: "600",
    color: "var(--asciidoc-fg, #333)",
  },
  ".cm-lp-image-block-caption": {
    fontSize: "0.85em",
    fontStyle: "italic",
    color: "var(--asciidoc-fg, #555)",
    opacity: "0.75",
  },

  // Headings
  ".cm-lp-heading": { color: "var(--asciidoc-heading, #7a2518)", lineHeight: "1.4" },

  // Inline styles
  ".cm-lp-code": { background: "var(--asciidoc-code-bg, #f5f5f5)", padding: "0.1em 0.3em", borderRadius: "3px", fontSize: "0.9em", fontFamily: "'JetBrains Mono', 'Fira Code', Consolas, monospace" },
  ".cm-lp-link": { color: "var(--asciidoc-link, #2156a5)", textDecoration: "none", cursor: "pointer" },
  ".cm-lp-link:hover": { textDecoration: "underline" },
  ".cm-lp-xref-wrap": {
    display: "inline-flex",
    alignItems: "center",
    gap: "0.3em",
    flexWrap: "nowrap",
    verticalAlign: "baseline",
  },
  ".cm-lp-xref": { color: "var(--asciidoc-link, #2156a5)", textDecoration: "none", borderBottom: "1px dashed var(--asciidoc-link, #2156a5)", cursor: "pointer" },
  ".cm-lp-xref:hover": { textDecoration: "underline" },
  ".cm-lp-section-toggle": {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: "1.2em",
    fontWeight: "700",
    lineHeight: "1",
    color: "var(--asciidoc-placeholder, #888)",
    cursor: "pointer",
    minWidth: "1.45em",
    minHeight: "1.45em",
    padding: "0.1em",
    borderRadius: "4px",
    userSelect: "none",
    flexShrink: "0",
  },
  ".cm-lp-section-toggle:hover": {
    color: "var(--asciidoc-link, #2156a5)",
    background: "rgba(33,86,165,0.08)",
  },
  ".cm-lp-section-toggle.open": {
    color: "var(--asciidoc-link, #2156a5)",
    background: "rgba(33,86,165,0.08)",
  },
  ".cm-lp-block-editor-overlay": {
    position: "absolute",
    inset: "0",
    background: "rgba(0, 0, 0, 0.4)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "24px",
    boxSizing: "border-box",
    zIndex: "30",
  },
  ".cm-lp-block-editor-modal": {
    width: "min(920px, 100%)",
    maxHeight: "100%",
    display: "flex",
    flexDirection: "column",
    background: "var(--asciidoc-preview-bg, #fafafa)",
    color: "var(--asciidoc-fg, #333)",
    border: "1px solid var(--asciidoc-border, #444)",
    borderRadius: "10px",
    boxShadow: "0 20px 50px rgba(0, 0, 0, 0.35)",
    overflow: "hidden",
  },
  ".cm-lp-block-editor-header": {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "18px 22px 8px",
    gap: "12px",
  },
  ".cm-lp-block-editor-title": {
    margin: "0",
    fontSize: "1.4rem",
    fontWeight: "700",
  },
  ".cm-lp-block-editor-close": {
    border: "none",
    background: "transparent",
    color: "var(--asciidoc-fg, #333)",
    fontSize: "28px",
    lineHeight: "1",
    cursor: "pointer",
    padding: "0 4px",
  },
  ".cm-lp-block-editor-body": {
    display: "flex",
    flexDirection: "column",
    gap: "16px",
    padding: "8px 22px 18px",
    overflow: "auto",
  },
  ".cm-lp-block-editor-field": {
    display: "flex",
    flexDirection: "column",
    gap: "8px",
  },
  ".cm-lp-block-editor-label": {
    fontSize: "0.95rem",
    fontWeight: "600",
  },
  ".cm-lp-block-editor-input": {
    width: "100%",
    boxSizing: "border-box",
    padding: "12px 14px",
    borderRadius: "8px",
    border: "1px solid var(--asciidoc-border, #666)",
    background: "rgba(128,128,128,0.08)",
    color: "inherit",
    fontSize: "1rem",
    outline: "none",
  },
  ".cm-lp-block-editor-textarea": {
    width: "100%",
    minHeight: "260px",
    boxSizing: "border-box",
    padding: "14px",
    borderRadius: "8px",
    border: "1px solid var(--asciidoc-border, #666)",
    background: "rgba(128,128,128,0.08)",
    color: "inherit",
    fontSize: "1rem",
    lineHeight: "1.5",
    resize: "vertical",
    outline: "none",
  },
  ".cm-lp-block-editor-textarea-code": {
    fontFamily: "'JetBrains Mono', 'Fira Code', Consolas, monospace",
    fontSize: "0.95rem",
    lineHeight: "1.5",
  },
  ".cm-lp-block-editor-footer": {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "0 22px 22px",
  },
  ".cm-lp-block-editor-footer-left": {
    display: "flex",
    alignItems: "center",
    gap: "10px",
  },
  ".cm-lp-block-editor-footer-right": {
    display: "flex",
    alignItems: "center",
    gap: "10px",
  },
  ".cm-lp-block-editor-btn": {
    borderRadius: "8px",
    border: "1px solid var(--asciidoc-border, #666)",
    padding: "10px 18px",
    fontSize: "0.95rem",
    fontWeight: "600",
    cursor: "pointer",
    background: "rgba(128,128,128,0.08)",
    color: "inherit",
  },
  ".cm-lp-block-editor-btn-primary": {
    background: "var(--asciidoc-link, #2156a5)",
    borderColor: "var(--asciidoc-link, #2156a5)",
    color: "#fff",
  },
  ".cm-lp-block-editor-btn-danger": {
    color: "#d9534f",
    borderColor: "rgba(217,83,79,0.5)",
    background: "rgba(217,83,79,0.08)",
  },
  ".cm-lp-block-editor-btn:disabled": {
    opacity: "0.5",
    cursor: "not-allowed",
  },
  ".cm-lp-block-editor-tabs": {
    display: "flex",
    gap: "0",
    borderBottom: "2px solid var(--asciidoc-border, #666)",
    marginBottom: "4px",
  },
  ".cm-lp-block-editor-tab": {
    flex: "1",
    padding: "10px 14px",
    border: "none",
    background: "transparent",
    color: "var(--asciidoc-placeholder, #888)",
    fontSize: "1rem",
    fontWeight: "700",
    cursor: "pointer",
  },
  ".cm-lp-block-editor-tab.active": {
    color: "var(--asciidoc-link, #2156a5)",
    boxShadow: "inset 0 -2px 0 var(--asciidoc-link, #2156a5)",
  },
  ".cm-lp-block-editor-inline-row": {
    display: "flex",
    alignItems: "center",
    gap: "10px",
    width: "100%",
  },
  ".cm-lp-block-editor-browse": {
    flexShrink: "0",
  },
  ".cm-lp-block-editor-input-readonly": {
    background: "rgba(128,128,128,0.04)",
  },
  ".cm-lp-block-editor-error": {
    color: "#d9534f",
    fontSize: "0.9rem",
    marginTop: "6px",
  },
  ".cm-lp-block-editor-range-header": {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "12px",
  },
  ".cm-lp-block-editor-range-value": {
    fontSize: "0.95rem",
    fontWeight: "600",
    color: "var(--asciidoc-placeholder, #888)",
  },
  ".cm-lp-block-editor-range": {
    width: "100%",
    margin: "0",
  },
  ".cm-lp-table-edit-modal": {
    border: "1px solid var(--asciidoc-border, #666)",
    borderRadius: "8px",
    overflow: "hidden",
  },
  // Floating section preview panel (lives outside CM decorations)
  // Styles are in editor.css since the panel is outside .cm-editor
  ".cm-lp-mark": { backgroundColor: "#fff176", color: "#000", padding: "0.1em 0.2em", borderRadius: "2px" },
  ".cm-lp-kbd": { display: "inline-block", background: "var(--asciidoc-code-bg, #f5f5f5)", padding: "0.143em 0.429em", border: "1px solid var(--asciidoc-border, #ccc)", borderRadius: "3px", fontSize: "0.85em", fontFamily: "'JetBrains Mono', Consolas, monospace", boxShadow: "0 1px 0 var(--asciidoc-border, #ccc)" },
  ".cm-lp-btn": { display: "inline-block", background: "var(--asciidoc-code-bg, #f5f5f5)", padding: "0.143em 0.714em", border: "1px solid var(--asciidoc-border, #bbb)", borderRadius: "4px", fontSize: "0.9em", fontWeight: "600", cursor: "default" },
  ".cm-lp-menu": { fontSize: "0.9em", fontFamily: "inherit" },
  ".cm-lp-menu-sep": { color: "var(--asciidoc-placeholder, #888)", margin: "0 2px" },
  ".cm-lp-footnote": { color: "var(--asciidoc-link, #2156a5)", cursor: "pointer", fontSize: "0.8em" },
  ".cm-lp-footnote:hover": { textDecoration: "underline" },
  ".cm-lp-footnote-popup": {
    position: "absolute",
    zIndex: "50",
    background: "var(--asciidoc-code-bg, #f5f5f5)",
    border: "1px solid var(--asciidoc-border, #ddd)",
    borderRadius: "6px",
    padding: "10px 14px",
    fontSize: "0.9em",
    lineHeight: "1.5",
    color: "var(--asciidoc-fg, #333)",
    boxShadow: "0 4px 16px rgba(0,0,0,0.15)",
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
    wordWrap: "break-word",
  },

  // Admonitions (inline single-line)
  ".cm-lp-admon": { display: "inline-flex", alignItems: "baseline", gap: "1em", padding: "0.714em 1em", borderLeft: "4px solid #888", borderRadius: "0 4px 4px 0", background: "rgba(128,128,128,0.06)", width: "calc(100% - 2em)", lineHeight: "1.6", verticalAlign: "middle", boxSizing: "border-box" },
  ".cm-lp-admon-line": { lineHeight: "normal !important", paddingTop: "0.286em !important", paddingBottom: "0.286em !important" },
  // Admonition blocks (multi-line with ==== delimiters)
  ".cm-lp-admon-block": { display: "flex", flexDirection: "column", gap: "0.286em", padding: "0.714em 1em", borderLeft: "4px solid #888", borderRadius: "0 4px 4px 0", background: "rgba(128,128,128,0.06)", lineHeight: "1.6", boxSizing: "border-box", margin: "0.3em 0" },
  ".cm-lp-admon-block-body": { display: "flex", flexDirection: "column", gap: "0.2em", textAlign: "center" },
  ".cm-lp-admon-label": { fontWeight: "700", fontSize: "0.8em", letterSpacing: "0.5px", flexShrink: "0", minWidth: "5em", display: "inline-block", textAlign: "center", whiteSpace: "nowrap" },
  ".cm-lp-admon-text": { flex: "1" },
  ".cm-lp-admon-note": { borderLeftColor: "#5bc0de", background: "rgba(91,192,222,0.08)" },
  ".cm-lp-admon-note .cm-lp-admon-label": { color: "#31708f" },
  ".cm-lp-admon-tip": { borderLeftColor: "#5cb85c", background: "rgba(92,184,92,0.08)" },
  ".cm-lp-admon-tip .cm-lp-admon-label": { color: "#3c763d" },
  ".cm-lp-admon-warning": { borderLeftColor: "#f0ad4e", background: "rgba(240,173,78,0.08)" },
  ".cm-lp-admon-warning .cm-lp-admon-label": { color: "#8a6d3b" },
  ".cm-lp-admon-caution": { borderLeftColor: "#e67e22", background: "rgba(230,126,34,0.08)" },
  ".cm-lp-admon-caution .cm-lp-admon-label": { color: "#a35415" },
  ".cm-lp-admon-important": { borderLeftColor: "#d9534f", background: "rgba(217,83,79,0.08)" },
  ".cm-lp-admon-important .cm-lp-admon-label": { color: "#a94442" },
  ".cm-lp-admon-question": { borderLeftColor: "#f1c40f", background: "rgba(241,196,15,0.08)" },
  ".cm-lp-admon-question .cm-lp-admon-label": { color: "#9a7b0a" },

  // Stem/Math Block Preview
  ".cm-lp-stemblock": {
    display: "block",
    width: "100%",
    margin: "0.5em 0",
    padding: "0.8em 1em",
    textAlign: "center",
    background: "var(--lp-special-block-bg, rgba(0,0,0,0.03))",
    borderRadius: "4px",
    border: "1px solid var(--lp-special-block-border, rgba(128,128,128,0.15))",
    overflow: "auto",
    cursor: "pointer",
    boxSizing: "border-box",
  },
  ".cm-lp-stemblock-content": {
    display: "flex",
    justifyContent: "center",
    alignItems: "center",
    minHeight: "1.5em",
  },
  ".cm-lp-math-inline": {
    display: "inline",
    verticalAlign: "baseline",
  },
  ".cm-lp-math-error": {
    color: "#d9534f",
    fontSize: "0.85em",
    fontStyle: "italic",
  },
  ".cm-lp-math-empty": {
    fontStyle: "italic",
  },

  // Mermaid Block Preview
  ".cm-lp-mermaid-block": {
    display: "block",
    width: "100%",
    margin: "0.5em 0",
    padding: "0.8em 1em",
    textAlign: "center",
    background: "var(--lp-special-block-bg, rgba(0,0,0,0.03))",
    borderRadius: "4px",
    border: "1px solid var(--lp-special-block-border, rgba(128,128,128,0.15))",
    overflow: "auto",
    cursor: "pointer",
    boxSizing: "border-box",
  },
  ".cm-lp-mermaid-content": {
    display: "flex",
    justifyContent: "center",
    alignItems: "center",
    minHeight: "3em",
  },
  ".cm-lp-mermaid-content svg": {
    maxWidth: "100%",
    height: "auto",
    overflow: "visible",
    transform: "scale(var(--editor-scale, 1))",
    transformOrigin: "center top",
  },
  ".cm-lp-mermaid-content foreignObject": {
    overflow: "visible",
  },
  ".cm-lp-mermaid-placeholder": {
    color: "var(--asciidoc-placeholder, #888)",
    fontStyle: "italic",
    fontSize: "0.9em",
  },
  ".cm-lp-mermaid-error": {
    color: "#d9534f",
    fontStyle: "italic",
    fontSize: "0.85em",
    padding: "4px 8px",
  },
  // Mermaid overlay editor two-panel layout
  ".cm-lp-mermaid-editor-panels": {
    display: "flex",
    gap: "16px",
    flex: "1",
    minHeight: "300px",
  },
  ".cm-lp-mermaid-editor-left": {
    flex: "1",
    display: "flex",
    flexDirection: "column",
    gap: "8px",
    minWidth: "0",
  },
  ".cm-lp-mermaid-editor-right": {
    flex: "1",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    border: "1px solid var(--asciidoc-border, #ddd)",
    borderRadius: "8px",
    overflow: "hidden",
    minWidth: "0",
    background: "rgba(128,128,128,0.04)",
    cursor: "grab",
    position: "relative",
  },
  ".cm-lp-mermaid-preview-inner": {
    padding: "16px",
    textAlign: "center",
    width: "100%",
    transformOrigin: "center center",
    userSelect: "none",
  },
  ".cm-lp-mermaid-syntax-toolbar": {
    display: "flex",
    flexWrap: "wrap",
    gap: "4px",
  },
  ".cm-lp-mermaid-syntax-btn": {
    padding: "3px 8px",
    fontSize: "0.8rem",
    borderRadius: "4px",
    border: "1px solid var(--asciidoc-border, #ddd)",
    background: "rgba(128,128,128,0.08)",
    color: "inherit",
    cursor: "pointer",
    whiteSpace: "nowrap",
  },
  ".cm-lp-mermaid-syntax-btn:hover": {
    background: "rgba(128,128,128,0.18)",
  },
  // Custom diagram type dropdown
  ".cm-lp-mermaid-type-dropdown": {
    position: "relative",
  },
  ".cm-lp-mermaid-type-btn": {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    cursor: "pointer",
    textAlign: "left",
  },
  ".cm-lp-mermaid-type-arrow": {
    marginLeft: "8px",
    opacity: "0.6",
  },
  ".cm-lp-mermaid-type-menu": {
    display: "none",
    position: "absolute",
    top: "100%",
    left: "0",
    right: "0",
    maxHeight: "180px",
    overflowY: "auto",
    background: "var(--asciidoc-preview-bg, #fafafa)",
    border: "1px solid var(--asciidoc-border, #ddd)",
    borderRadius: "6px",
    boxShadow: "0 4px 12px rgba(0,0,0,0.25)",
    zIndex: "50",
    marginTop: "2px",
    padding: "4px 0",
  },
  ".cm-lp-mermaid-type-menu.open": {
    display: "block",
  },
  ".cm-lp-mermaid-type-item": {
    display: "block",
    width: "100%",
    padding: "6px 14px",
    border: "none",
    background: "transparent",
    color: "inherit",
    fontSize: "0.95rem",
    textAlign: "left",
    cursor: "pointer",
    boxSizing: "border-box",
  },
  ".cm-lp-mermaid-type-item:hover": {
    background: "rgba(128,128,128,0.15)",
  },
  ".cm-lp-mermaid-type-item.selected": {
    background: "var(--asciidoc-link, #2156a5)",
    color: "#fff",
  },

  // Code Block Preview
  ".cm-lp-codeblock": {
    borderRadius: "4px",
    overflow: "hidden",
    border: "1px solid var(--asciidoc-border, #ddd)",
    margin: "0.8em 0",
    background: "var(--asciidoc-code-bg, #f5f5f5)",
  },
  ".cm-lp-codeblock-header": {
    padding: "0.286em 0.857em",
    fontSize: "0.75em",
    fontWeight: "600",
    letterSpacing: "0.5px",
    color: "var(--asciidoc-placeholder, #999)",
    textAlign: "right",
    textTransform: "uppercase",
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
  },
  ".cm-lp-codeblock-pre": {
    margin: "0",
    padding: "0.857em",
    fontFamily: "'JetBrains Mono', 'Fira Code', Consolas, monospace",
    fontSize: "0.85em",
    lineHeight: "1.4",
    color: "var(--asciidoc-fg, #333)",
    whiteSpace: "pre-wrap",
    overflowX: "auto",
  },

  // Code Block Edit Mode (cursor inside)
  ".cm-lp-code-line": {
    background: "var(--asciidoc-code-bg, #f5f5f5) !important",
    fontFamily: "'JetBrains Mono', 'Fira Code', Consolas, monospace !important",
    fontSize: "1em",
    lineHeight: "1.6 !important",
    color: "var(--asciidoc-fg, #333)",
    paddingTop: "0 !important",
    paddingBottom: "0 !important",
  },
  ".cm-lp-code-delim-line": {
    lineHeight: "1.6 !important",
    overflow: "hidden",
    background: "var(--asciidoc-code-bg, #f5f5f5) !important",
    color: "var(--asciidoc-placeholder, #888)",
    opacity: "0.5",
  },

  // Code Language Dropdown
  ".cm-lp-codeblock-lang-wrap": {
    display: "flex",
    justifyContent: "flex-end",
    alignItems: "center",
    background: "var(--asciidoc-code-bg, #f5f5f5)",
    padding: "4px 8px",
    borderRadius: "4px 4px 0 0",
    border: "1px solid var(--asciidoc-border, #ddd)",
    borderBottom: "none",
    position: "relative",
  },
  ".cm-lp-codeblock-lang-btn": {
    background: "transparent",
    border: "1px solid var(--asciidoc-border, #ccc)",
    borderRadius: "4px",
    padding: "2px 8px",
    fontSize: "0.7em",
    fontWeight: "600",
    letterSpacing: "0.5px",
    color: "var(--asciidoc-placeholder, #999)",
    cursor: "pointer",
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
  },
  ".cm-lp-codeblock-lang-btn:hover": {
    background: "rgba(128,128,128,0.15)",
    color: "var(--asciidoc-fg, #333)",
  },
  ".cm-lp-codeblock-dropdown": {
    position: "absolute",
    top: "100%",
    right: "8px",
    zIndex: "100",
    background: "var(--asciidoc-toolbar-bg, #f7f7f8)",
    border: "1px solid var(--asciidoc-border, #ddd)",
    borderRadius: "4px",
    padding: "4px",
    flexDirection: "column",
    gap: "1px",
    maxHeight: "200px",
    overflowY: "auto",
    boxShadow: "0 4px 12px rgba(0,0,0,0.15)",
    minWidth: "120px",
  },
  ".cm-lp-codeblock-dropdown-item": {
    background: "transparent",
    border: "none",
    padding: "4px 10px",
    fontSize: "12px",
    color: "var(--asciidoc-fg, #333)",
    cursor: "pointer",
    textAlign: "left",
    borderRadius: "3px",
    fontFamily: "'JetBrains Mono', 'Fira Code', Consolas, monospace",
  },
  ".cm-lp-codeblock-dropdown-item:hover": {
    background: "rgba(128,128,128,0.15)",
  },

  // Table Preview
  ".cm-lp-table-wrap": {
    margin: "0.5em 0",
    overflowX: "auto",
  },
  ".cm-lp-table": {
    borderCollapse: "collapse",
    width: "100%",
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
  },
  ".cm-lp-table th": {
    background: "var(--asciidoc-code-bg, #f5f5f5)",
    fontWeight: "bold",
    textAlign: "left",
    padding: "0.429em 0.857em",
    border: "1px solid var(--asciidoc-border, #ddd)",
  },
  ".cm-lp-table .cm-lp-side-header": {
    borderRight: "2px solid var(--asciidoc-border, #555)",
  },
  ".cm-lp-table td": {
    padding: "0.429em 0.857em",
    border: "1px solid var(--asciidoc-border, #ddd)",
  },
  ".cm-lp-table tbody tr:nth-child(even) td": {
    background: "rgba(128, 128, 128, 0.05)",
  },

  // Table Edit Mode
  ".cm-lp-table-edit": {
    margin: "0.5em 0",
    border: "2px solid var(--asciidoc-link, #2156a5)",
    borderRadius: "4px",
    overflow: "hidden",
  },
  ".cm-lp-table-input": {
    background: "transparent",
    border: "none",
    outline: "none",
    color: "inherit",
    font: "inherit",
    width: "100%",
    padding: "0",
    margin: "0",
  },
  ".cm-lp-table-input:focus": {
    background: "rgba(33,86,165,0.08)",
  },
  ".cm-lp-table-edit .cm-lp-table th .cm-lp-table-input:focus": {
    background: "rgba(33,86,165,0.12)",
  },
  ".cm-lp-table-buttons": {
    display: "flex",
    gap: "0.286em",
    padding: "0.429em 0.571em",
    background: "var(--asciidoc-code-bg, #f5f5f5)",
    borderTop: "1px solid var(--asciidoc-border, #ddd)",
  },
  ".cm-lp-table-btn": {
    background: "transparent",
    border: "1px solid var(--asciidoc-border, #ccc)",
    borderRadius: "4px",
    padding: "3px 10px",
    fontSize: "11px",
    color: "var(--asciidoc-fg, #333)",
    cursor: "pointer",
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
    fontWeight: "500",
  },
  ".cm-lp-table-btn:hover": {
    background: "rgba(128,128,128,0.15)",
  },
  ".cm-lp-table-btn-danger": {
    color: "#d9534f",
    borderColor: "rgba(217,83,79,0.3)",
  },
  ".cm-lp-table-btn-danger:hover": {
    background: "rgba(217,83,79,0.1)",
  },
  ".cm-lp-table-btn-sep": {
    width: "1px",
    height: "16px",
    background: "var(--asciidoc-border, #ddd)",
    opacity: "0.4",
    margin: "0 4px",
    flexShrink: "0",
    alignSelf: "center",
  },
  ".cm-lp-side-header": {
    fontWeight: "600",
    background: "var(--asciidoc-code-bg, #f5f5f5)",
  },

  ".cm-lp-pagebreak": {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: "100%",
    margin: "1.25em 0",
    color: "var(--asciidoc-placeholder, #777)",
    fontSize: "0.85em",
    letterSpacing: "0.08em",
    textTransform: "uppercase",
  },
  ".cm-lp-pagebreak::before, .cm-lp-pagebreak::after": {
    content: '""',
    flex: "1 1 auto",
    borderBottom: "1px dashed var(--asciidoc-border, #bbb)",
  },
  ".cm-lp-pagebreak::before": {
    marginRight: "0.9em",
  },
  ".cm-lp-pagebreak::after": {
    marginLeft: "0.9em",
  },
  ".cm-lp-pagebreak-label": {
    flexShrink: "0",
  },

  ".cm-lp-content-block-wrap": {
    display: "block",
    margin: "0.5em 0",
    borderRadius: "6px",
    overflow: "hidden",
  },
  ".cm-lp-content-block-title": {
    fontWeight: "bold",
    textAlign: "center",
    marginBottom: "0.4em",
    fontSize: "1.05em",
  },
  ".cm-lp-content-block-body": {
    display: "flex",
    flexDirection: "column",
    gap: "0.2em",
  },
  ".cm-lp-content-block-body > *": {
    margin: "0",
  },
  ".cm-lp-content-block-line": {
    lineHeight: "1.6",
  },
  ".cm-lp-content-block-line > *": {
    margin: "0",
  },
  ".cm-lp-content-block-line-empty": {
    minHeight: "0.9em",
  },
  // Example block — border with white/light background
  ".cm-lp-content-block-example": {
    padding: "0.8em 1em",
    border: "1px solid var(--asciidoc-border, #d6d6d6)",
    background: "var(--asciidoc-bg, #fff)",
  },
  // Sidebar — matches Asciidoctor's card-style rendering
  ".cm-lp-content-block-sidebar": {
    padding: "0.8em 1em",
    background: "var(--asciidoc-code-bg, #f5f5f5)",
    border: "1px solid var(--asciidoc-border, #ddd)",
    borderRadius: "4px",
  },
  // Collapsible — dashed border, subtle background
  ".cm-lp-content-block-collapsible": {
    padding: "0.6em 0.8em",
    border: "1px dashed var(--asciidoc-border, #bbb)",
    background: "color-mix(in srgb, var(--asciidoc-code-bg, #f5f5f5) 55%, transparent)",
  },
  ".cm-lp-content-block-summary": {
    display: "flex",
    alignItems: "center",
    gap: "0.3em",
    fontWeight: "600",
  },
  ".cm-lp-content-block-caret": {
    color: "var(--asciidoc-placeholder, #777)",
    flexShrink: "0",
  },
  ".cm-lp-content-block-summary-text": {
    minWidth: "0",
  },

  // Blockquote
  ".cm-lp-blockquote-wrap": {
    padding: "1em 0",
  },
  ".cm-lp-blockquote": {
    margin: "0",
    padding: "0.5em 1em",
    borderLeft: "4px solid var(--asciidoc-border, #ccc)",
    fontStyle: "italic",
  },
  ".cm-lp-blockquote-content": {
    color: "var(--asciidoc-fg, #555)",
    lineHeight: "1.6",
  },
  ".cm-lp-blockquote-attribution": {
    fontStyle: "normal",
    textAlign: "right",
    color: "var(--asciidoc-placeholder, #777)",
    marginTop: "0.5em",
    fontSize: "0.9em",
  },

  // List lines — tuned to match the raw editor line height more closely
  ".cm-line.cm-lp-list-line": {
    lineHeight: "1.6 !important",
    paddingTop: `${LIST_LINE_PADDING_EM}em !important`,
    paddingBottom: `${LIST_LINE_PADDING_EM}em !important`,
    margin: "0 !important",
  },
  ".cm-line.cm-lp-special-block-line": {
    background: "var(--lp-special-block-bg, transparent)",
    boxShadow: "inset 0 0 0 1px var(--lp-special-block-border, transparent)",
    borderRadius: "8px",
    transition: "background 120ms ease, box-shadow 120ms ease",
    marginLeft: "calc(var(--content-margin, 0px) + 0.571em)",
    marginRight: "calc(var(--content-margin, 0px) + 0.571em)",
  },
  ".cm-lp-list-line .cm-live-preview-line": {
    lineHeight: "1.6 !important",
  },

  // Lists
  ".cm-lp-list": {
    display: "inline-flex",
    alignItems: "baseline",
    width: "100%",
    margin: "0",
    boxSizing: "border-box",
  },
  ".cm-lp-list-marker": {
    display: "inline-flex",
    width: "1.2em",
    minWidth: "1.2em",
    textAlign: "center",
    flexShrink: "0",
    color: "var(--asciidoc-fg, #333)",
    marginRight: "0.3em",
    justifyContent: "center",
  },
  ".cm-lp-list-content": {
    flex: "1",
    minWidth: "0",
  },
  ".cm-lp-bullet-marker": {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    lineHeight: "1.6",
  },
  ".cm-lp-bullet-marker::before": {
    content: '""',
    display: "inline-block",
    width: "0.35em",
    height: "0.35em",
    background: "currentColor",
    borderRadius: "50%",
  },
  ".cm-lp-bullet-marker-nested::before": {
    width: "0.42em",
    height: "0.42em",
    background: "none",
    border: "1.5px solid currentColor",
    boxSizing: "border-box",
  },
  ".cm-lp-bullet-marker-square::before": {
    width: "0.35em",
    height: "0.35em",
    background: "currentColor",
    borderRadius: "0",
  },

  // Strikethrough
  ".cm-live-preview-line del": {
    textDecoration: "line-through",
  },
});

// =====================================================
// Export
// =====================================================

// Accept both standard UUIDs (with dashes) and Joplin note IDs (32-char hex, no dashes)
const UUID_PATTERN = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{32})$/i;

/**
 * Extract a section's AsciiDoc content from a full note body.
 * Returns text from the heading matching the anchor to the next heading of same or higher level.
 */
function extractSection(body: string, anchor: string): string {
  const lines = body.split("\n");
  let startIdx = -1;
  let startLevel = 0;

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^(={2,6})\s+(.+)$/);
    if (match) {
      const level = match[1].length;
      const title = match[2].trim();
      // Generate the same anchor as parse_sections in Rust:
      // _prefix, lowercase, strip non-alphanumeric (except space), replace space with _
      const generated = "_" + title
        .toLowerCase()
        .replace(/[^a-z0-9 ]/g, "")
        .replace(/ /g, "_")
        .replace(/^_+|_+$/g, "");
      if (generated === anchor) {
        startIdx = i;
        startLevel = level;
        continue;
      }
      // If we've started collecting and hit a same/higher-level heading, stop
      if (startIdx >= 0 && level <= startLevel) {
        return lines.slice(startIdx, i).join("\n").trim();
      }
    }
  }

  if (startIdx >= 0) {
    return lines.slice(startIdx).join("\n").trim();
  }
  return "";
}

/**
 * Render an AsciiDoc section snippet to HTML using Asciidoctor.js.
 */
async function renderSectionPreview(content: string): Promise<string> {
  // Delegate rendering to plugin sandbox which already has Asciidoctor.js
  const { renderAsciidoc } = await import("../ipc");
  const result = await renderAsciidoc(content);
  return result.html;
}

/**
 * Toggle the section preview as a floating panel.
 */
async function toggleSectionPreview(toggleEl: HTMLElement, editorEl: HTMLElement): Promise<void> {
  const nodeId = toggleEl.dataset.nodeId;
  const anchor = toggleEl.dataset.sectionAnchor;
  if (!nodeId || !anchor) return;

  const cacheKey = `${nodeId}#${anchor}`;

  // If same section is already open, close it
  if (floatingPreviewKey === cacheKey) {
    closeFloatingPreview();
    return;
  }

  // Close any existing preview first
  closeFloatingPreview();

  // Open new preview
  const panel = getOrCreateFloatingPanel(editorEl);
  floatingPreviewPanel = panel;
  floatingPreviewKey = cacheKey;

  setSectionToggleState(toggleEl, true);

  // Check cache first
  const cached = openSectionPreviews.get(cacheKey);
  if (cached) {
    panel.innerHTML = cached;
    panel.style.display = "block";
    positionFloatingPanel(panel, toggleEl);
    return;
  }

  panel.innerHTML = '<span class="cm-lp-section-loading">Loading section...</span>';
  panel.style.display = "block";
  positionFloatingPanel(panel, toggleEl);

  try {
    const { getNoteContent } = await import("../ipc");
    const result = await getNoteContent(nodeId);
    const sectionContent = extractSection(result.body, anchor);

    if (!sectionContent) {
      panel.innerHTML = '<span class="cm-lp-section-loading">Section not found</span>';
      return;
    }

    const html = await renderSectionPreview(sectionContent);
    panel.innerHTML = html;
    openSectionPreviews.set(cacheKey, html);
  } catch (e) {
    panel.innerHTML = '<span class="cm-lp-section-loading">Failed to load section</span>';
  }
}

const xrefClickHandler = EditorView.domEventHandlers({
  mousedown(event, view) {
    const target = event.target as HTMLElement;

    // Clicking inside the floating preview — don't let CM handle it
    if (isFloatingPreviewTarget(target)) {
      consumeEvent(event);
      return true;
    }

    // Clicking elsewhere closes the floating preview
    if (floatingPreviewKey && !target.classList?.contains("cm-lp-section-toggle")) {
      closeFloatingPreview();
    }

    if (event.button === 0 && !isInteractivePreviewTarget(target) && !isFloatingPreviewTarget(target)) {
      const previewLineFrom = getPreviewLineFromElement(target);
      const clickedPos = view.posAtCoords({ x: event.clientX, y: event.clientY });
      const clickedLineNumber = clickedPos != null ? view.state.doc.lineAt(clickedPos).number : null;
      const fallbackLineFrom = clickedPos != null ? view.state.doc.lineAt(clickedPos).from : null;
      const rawLineFrom = view.state.doc.lineAt(view.state.selection.main.head).from;

      if (overlayEditingMode && clickedLineNumber != null && openPreviewBlockModalForLine(view, clickedLineNumber)) {
        consumeEvent(event);
        clearPendingPreviewClick();
        return true;
      }

      const candidateLineFrom = previewLineFrom ?? (fallbackLineFrom !== rawLineFrom ? fallbackLineFrom : null);

      if (candidateLineFrom != null) {
        consumeEvent(event);
        queuePreviewLineFocus(view, candidateLineFrom, target);
        return true;
      }
    }

    return false;
  },

  mousemove(event) {
    if (pendingPreviewClickFrom == null) return false;
    consumeEvent(event);
    return true;
  },

  mouseup(event, view) {
    if (pendingPreviewClickFrom == null) return false;
    consumeEvent(event);
    focusPreviewLine(view, pendingPreviewClickFrom);
    return true;
  },

  click(event, view) {
    if (pendingPreviewClickFrom == null) return false;
    consumeEvent(event);
    focusPreviewLine(view, pendingPreviewClickFrom);
    return true;
  },

  dragstart(event) {
    if (pendingPreviewClickFrom == null) return false;
    consumeEvent(event);
    return true;
  },

  selectstart(event) {
    if (pendingPreviewClickFrom == null) return false;
    consumeEvent(event);
    return true;
  },

  keydown(event, view) {
    if (blockEditorOverlay) return false;
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return false;
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return false;
    const direction = event.key === "ArrowDown" ? 1 : -1;
    if (!handlePreviewBlockArrowNavigation(view, direction)) return false;
    consumeEvent(event);
    return true;
  },

  mouseleave() {
    if (pendingPreviewClickFrom == null) return false;
    clearPendingPreviewClick();
    return false;
  },
});

export function livePreview() {
  return [
    Prec.highest(keymap.of([
      {
        key: "ArrowUp",
        run(view) {
          return handlePreviewBlockArrowNavigation(view, -1);
        },
      },
      {
        key: "ArrowDown",
        run(view) {
          return handlePreviewBlockArrowNavigation(view, 1);
        },
      },
    ])),
    livePreviewPlugin,
    livePreviewTheme,
    xrefClickHandler,
  ];
}
