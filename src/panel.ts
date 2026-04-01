/**
 * Webview entry point for the AsciiDoc live-preview editor.
 * Replaces the old split-view panel.js with a single-pane CM6 editor
 * with always-on live-preview decorations.
 */

import { EditorView, ViewPlugin, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, placeholder } from "@codemirror/view";
import { EditorState, Compartment, Prec } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { searchKeymap, highlightSelectionMatches, openSearchPanel, closeSearchPanel, searchPanelOpen } from "@codemirror/search";
import { bracketMatching } from "@codemirror/language";
import { asciidocLanguage } from "./lib/editor/asciidoc-language";
import { asciidocKeymap } from "./lib/editor/keybindings";
import { livePreview, refreshLivePreview, updateResourceUrls, setOverlayEditingEnabled, setCompactSpacing, closeFloatingPreview } from "./lib/editor/live-preview";
import { wikiLinkCompletion } from "./lib/editor/wiki-link-completion";
import { spellcheckExtension, loadPersonalDictionary, onDictionaryChange, refreshSpellcheck, setShowPluralSingular } from "./lib/editor/spellcheck";
import { buildRibbon } from "./lib/toolbar/ribbon";
import { isSmartQuotesEnabled } from "./lib/toolbar/panels/formatting-panel";
import { saveNoteContent, requestResources, getPersonalDictionary, addWordToPersonalDictionary, getSpellcheckSettings, setFullscreenMode, convertMarkdownPaste, renderAsciidoc } from "./lib/ipc";
import { setMermaidTheme } from "./lib/utils/mermaid-render";

declare const webviewApi: {
  postMessage(msg: any): Promise<any>;
  onMessage(callback: (msg: any) => void): void;
};

// =====================================================
// State
// =====================================================

let editorView: EditorView | null = null;
let currentNoteId = "";
let currentSentinel = "";
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let isDirty = false;
let suppressNextDocChange = false; // Prevent save-back loop when loading new note
const SAVE_DEBOUNCE_MS = 2000;

const lineNumbersCompartment = new Compartment();
const spellcheckCompartment = new Compartment();
let showLineNumbers = localStorage.getItem("asciidoc-line-numbers") === "true";
let specialBlockShading = localStorage.getItem("asciidoc-block-shading") !== "false";
let overlayEditingEnabled = localStorage.getItem("asciidoc-overlay-editing") === "true";
let spellcheckEnabled = localStorage.getItem("asciidoc-spellcheck") !== "false";
let currentZoom = parseInt(localStorage.getItem("asciidoc-editor-zoom") || "100", 10);
if (currentZoom < 50 || currentZoom > 150) currentZoom = 100;
let compactSpacingEnabled = false;
// Sync initial state to live-preview module
setOverlayEditingEnabled(overlayEditingEnabled);
setCompactSpacing(compactSpacingEnabled);

// Highlight removal helpers
const backgroundHighlightPattern = /\[\.[a-z-]+-background\]#([^#]+)#/g;
const plainHighlightPattern = /(?<!\])#([^#]+)#/g;

// =====================================================
// Sentinel handling
// =====================================================

const SENTINEL_REGEX = /\n?```asciidoc-settings\n([\s\S]*?)\n```\s*$/;

function stripSentinel(body: string): { content: string; sentinel: string } {
  const match = body.match(SENTINEL_REGEX);
  if (match) {
    return {
      content: body.slice(0, match.index!),
      sentinel: match[0],
    };
  }
  return { content: body, sentinel: "" };
}

function appendSentinel(content: string, sentinel: string): string {
  if (!sentinel) return content;
  return content + sentinel;
}

// =====================================================
// Resource resolution
// =====================================================

function extractResourceIds(content: string): string[] {
  const ids = new Set<string>();
  const regex = /:\/?([a-f0-9]{32})/g;
  let match;
  while ((match = regex.exec(content)) !== null) {
    ids.add(match[1]);
  }
  return Array.from(ids);
}

async function resolveResources(content: string) {
  const ids = extractResourceIds(content);
  if (ids.length === 0) return;
  try {
    const result = await requestResources(ids);
    if (result.resources && result.resources.length > 0) {
      updateResourceUrls(result.resources);
      if (editorView) {
        refreshLivePreview(editorView);
      }
    }
  } catch (e) {
    console.error("[panel] Failed to resolve resources:", e);
  }
}

// =====================================================
// Save
// =====================================================

function scheduleSave() {
  isDirty = true;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(doSave, SAVE_DEBOUNCE_MS);
}

async function doSave() {
  if (!editorView || !isDirty || !currentNoteId) return;
  isDirty = false;
  saveTimer = null;
  // Capture state before async operation to prevent race conditions
  const noteId = currentNoteId;
  const content = editorView.state.doc.toString();
  const body = appendSentinel(content, currentSentinel);
  try {
    await saveNoteContent(noteId, body);
  } catch (e) {
    console.error("[panel] Save failed:", e);
    isDirty = true; // Restore dirty flag so save is retried on next edit
  }
}

function forceSave() {
  if (saveTimer) clearTimeout(saveTimer);
  doSave();
}

// =====================================================
// Highlight removal
// =====================================================

interface HighlightWrapper {
  start: number;
  end: number;
  innerStart: number;
  innerEnd: number;
  innerText: string;
}

function collectHighlightWrappers(lineText: string): HighlightWrapper[] {
  const wrappers: HighlightWrapper[] = [];
  for (const pattern of [backgroundHighlightPattern, plainHighlightPattern]) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(lineText)) !== null) {
      const fullMatch = match[0];
      const innerText = match[1] ?? "";
      const start = match.index;
      const end = start + fullMatch.length;
      const innerOffset = fullMatch.indexOf(innerText);
      wrappers.push({
        start,
        end,
        innerStart: start + Math.max(0, innerOffset),
        innerEnd: start + Math.max(0, innerOffset) + innerText.length,
        innerText,
      });
      if (fullMatch.length === 0) {
        pattern.lastIndex += 1;
      }
    }
  }
  return wrappers.sort((a, b) => (a.end - a.start) - (b.end - b.start));
}

function removeHighlightMarkup() {
  if (!editorView) return;
  const { from, to } = editorView.state.selection.main;
  const lineObj = editorView.state.doc.lineAt(from);
  if (to > lineObj.to) return;
  const relFrom = from - lineObj.from;
  const relTo = to - lineObj.from;
  const isCollapsed = from === to;
  const wrappers = collectHighlightWrappers(lineObj.text);
  const wrapper = wrappers.find((candidate) =>
    isCollapsed
      ? relFrom >= candidate.start && relFrom <= candidate.end
      : relFrom >= candidate.start && relTo <= candidate.end,
  );
  if (!wrapper) return;
  const replaceFrom = lineObj.from + wrapper.start;
  const replaceTo = lineObj.from + wrapper.end;
  const newFromOffset = Math.max(0, Math.min(relFrom - wrapper.innerStart, wrapper.innerText.length));
  const newToOffset = isCollapsed
    ? newFromOffset
    : Math.max(0, Math.min(relTo - wrapper.innerStart, wrapper.innerText.length));
  editorView.dispatch({
    changes: { from: replaceFrom, to: replaceTo, insert: wrapper.innerText },
    selection: {
      anchor: replaceFrom + newFromOffset,
      head: replaceFrom + newToOffset,
    },
  });
}

// =====================================================
// Editor command handler (toolbar → CM6)
// =====================================================

function handleEditorCommand(e: Event) {
  const detail = (e as CustomEvent).detail;
  if (!editorView) return;

  // Bibliography insertion command
  if (detail.command === "insert-bibliography") {
    const doc = editorView.state.doc;
    const fullText = doc.toString();
    // Check if a bibliography section already exists
    if (/^\[bibliography\]$/m.test(fullText)) {
      // Scroll to existing bibliography section
      for (let ln = 1; ln <= doc.lines; ln++) {
        if (doc.line(ln).text.trim() === "[bibliography]") {
          const pos = doc.line(ln).from;
          editorView.dispatch({
            selection: { anchor: pos },
            scrollIntoView: true,
          });
          editorView.focus();
          return;
        }
      }
    } else {
      // Insert new bibliography skeleton at end of document
      const skeleton = "\n\n[bibliography]\n== References\n\n* [[[ref1]]] Author. _Title_. Publisher. Year.";
      const end = doc.length;
      editorView.dispatch({
        changes: { from: end, insert: skeleton },
        selection: { anchor: end + skeleton.length },
      });
      editorView.focus();
    }
    return;
  }

  const { type, before, after, text } = detail;
  const { from, to } = editorView.state.selection.main;

  if (type === "wrap") {
    const selected = editorView.state.sliceDoc(from, to);

    // Toggle: if selected text is already wrapped, unwrap it
    if (selected.startsWith(before) && selected.endsWith(after) && selected.length >= before.length + after.length) {
      const inner = selected.slice(before.length, selected.length - after.length);
      editorView.dispatch({
        changes: { from, to, insert: inner },
        selection: { anchor: from, head: from + inner.length },
      });
    }
    // Toggle: if the characters around the selection are the markers, remove them
    else if (
      editorView.state.sliceDoc(from - before.length, from) === before &&
      editorView.state.sliceDoc(to, to + after.length) === after
    ) {
      editorView.dispatch({
        changes: [
          { from: from - before.length, to: from, insert: "" },
          { from: to, to: to + after.length, insert: "" },
        ],
        selection: { anchor: from - before.length, head: to - before.length },
      });
    }
    // Otherwise, wrap the selection
    else {
      editorView.dispatch({
        changes: { from, to, insert: before + selected + after },
        selection: { anchor: from + before.length, head: to + before.length },
      });
    }
  } else if (type === "insert") {
    const detail = (e as CustomEvent).detail;
    const selectFrom = detail.selectFrom;
    const selectTo = detail.selectTo;
    const selection = selectFrom != null && selectTo != null
      ? { anchor: from + selectFrom, head: from + selectTo }
      : { anchor: detail.cursorOffset != null ? from + detail.cursorOffset : from + text.length };
    editorView.dispatch({
      changes: { from, insert: text },
      selection,
    });
  } else if (type === "heading") {
    const firstLine = editorView.state.doc.lineAt(from);
    const lastLine = editorView.state.doc.lineAt(to);
    const changes: Array<{ from: number; to: number; insert: string }> = [];
    for (let ln = firstLine.number; ln <= lastLine.number; ln++) {
      const lineObj = editorView.state.doc.line(ln);
      const stripped = lineObj.text.replace(/^=+\s*/, "");
      changes.push({ from: lineObj.from, to: lineObj.to, insert: text + stripped });
    }
    editorView.dispatch({ changes });
  } else if (type === "prefix") {
    const firstLine = editorView.state.doc.lineAt(from);
    const lastLine = editorView.state.doc.lineAt(to);
    const changes: Array<{ from: number; to: number; insert: string }> = [];
    for (let ln = firstLine.number; ln <= lastLine.number; ln++) {
      const lineObj = editorView.state.doc.line(ln);
      if (lineObj.text.startsWith(text)) {
        changes.push({ from: lineObj.from, to: lineObj.from + text.length, insert: "" });
      } else {
        changes.push({ from: lineObj.from, to: lineObj.from, insert: text });
      }
    }
    editorView.dispatch({ changes });
  } else if (type === "suffix") {
    const firstLine = editorView.state.doc.lineAt(from);
    const lastLine = editorView.state.doc.lineAt(to);
    const changes: Array<{ from: number; to: number; insert: string }> = [];
    for (let ln = firstLine.number; ln <= lastLine.number; ln++) {
      const lineObj = editorView.state.doc.line(ln);
      if (lineObj.text.endsWith(text)) {
        changes.push({ from: lineObj.to - text.length, to: lineObj.to, insert: "" });
      } else {
        changes.push({ from: lineObj.to, to: lineObj.to, insert: text });
      }
    }
    editorView.dispatch({ changes });
  } else if (type === "remove-highlight") {
    removeHighlightMarkup();
  }

  editorView.focus();
}

// =====================================================
// Editor panel options (for ribbon Editor tab)
// =====================================================

function updateLineNumbers() {
  if (!editorView) return;
  const show = showLineNumbers;
  editorView.dispatch({
    effects: lineNumbersCompartment.reconfigure(
      show ? [lineNumbers(), highlightActiveLineGutter()] : []
    ),
  });
}

function updateBlockShading() {
  if (!editorView) return;
  editorView.dom.style.setProperty(
    "--lp-special-block-bg",
    specialBlockShading ? "var(--asciidoc-toolbar-bg, rgba(0,0,0,0.08))" : "transparent",
  );
  editorView.dom.style.setProperty(
    "--lp-special-block-border",
    specialBlockShading ? "var(--asciidoc-border, rgba(128,128,128,0.18))" : "transparent",
  );
}

function updateCompactSpacing() {
  const root = document.getElementById("asciidoc-editor-root");
  if (root) root.classList.toggle("compact-spacing", compactSpacingEnabled);
  setCompactSpacing(compactSpacingEnabled);
  if (editorView) refreshLivePreview(editorView);
}

function updateSpellcheck() {
  if (!editorView) return;
  editorView.dispatch({
    effects: spellcheckCompartment.reconfigure(
      spellcheckEnabled ? spellcheckExtension() : []
    ),
  });
}

// =====================================================
// Fullscreen mode
// =====================================================

let isFullscreen = false; // never persisted — always starts off
const FULLSCREEN_EXTRA_MARGIN = 0;
let autoHideToolbar = localStorage.getItem("asciidoc-autohide-toolbar") === "true";

let autoHideTrigger: HTMLElement | null = null;
let autoHideTimeout: any = null;

function setAutoHideToolbar(enabled: boolean) {
  autoHideToolbar = enabled;
  const root = document.getElementById("asciidoc-editor-root");
  if (!root) return;
  root.classList.toggle("autohide-toolbar", enabled);

  const ribbonContainer = document.getElementById("ribbon-container");
  if (!ribbonContainer) return;

  // Clean up previous trigger zone
  if (autoHideTrigger) {
    autoHideTrigger.remove();
    autoHideTrigger = null;
  }

  if (!enabled) {
    ribbonContainer.classList.remove("autohide-visible");
    return;
  }

  // Create an invisible trigger zone at the very top of the root
  const trigger = document.createElement("div");
  trigger.style.cssText = "position:absolute;top:0;left:0;right:0;height:10px;z-index:101";
  root.appendChild(trigger);
  autoHideTrigger = trigger;

  function showRibbon() {
    clearTimeout(autoHideTimeout);
    ribbonContainer!.classList.add("autohide-visible");
  }

  function hideRibbon() {
    clearTimeout(autoHideTimeout);
    autoHideTimeout = setTimeout(() => {
      ribbonContainer!.classList.remove("autohide-visible");
    }, 300);
  }

  trigger.addEventListener("mouseenter", showRibbon);
  ribbonContainer.addEventListener("mouseenter", showRibbon);
  ribbonContainer.addEventListener("mouseleave", hideRibbon);
  // Keep ribbon visible when pointer is above it (in the title bar area)
  trigger.addEventListener("mouseleave", (e) => {
    // Only hide if pointer moved downward (into editor), not upward (into title bar)
    const rect = trigger.getBoundingClientRect();
    if ((e as MouseEvent).clientY > rect.bottom) {
      // Pointer moved down — check if it entered the ribbon
      // Give a brief delay so mouseenter on ribbon can cancel
      hideRibbon();
    }
    // If pointer moved up (into title bar), keep ribbon visible
  });
}

function setFullscreen(enabled: boolean) {
  isFullscreen = enabled;
  const root = document.getElementById("asciidoc-editor-root");
  if (!root) return;
  if (enabled) {
    root.classList.add("fullscreen-mode");
    document.documentElement.style.setProperty("--fullscreen-margin", `${FULLSCREEN_EXTRA_MARGIN}px`);
  } else {
    root.classList.remove("fullscreen-mode");
    document.documentElement.style.setProperty("--fullscreen-margin", "0px");
  }
  // Toggle Joplin sidebars via IPC
  setFullscreenMode(enabled).catch(e => console.error("[panel] Failed to toggle fullscreen sidebars:", e));
  // Sync the editor panel checkbox if it's currently visible
  root.querySelectorAll<HTMLInputElement>(".ribbon-panel .editor-toggle-label input[type=checkbox]").forEach(checkbox => {
    const label = checkbox.nextElementSibling?.textContent;
    if (label === "Fullscreen Mode" && checkbox.checked !== enabled) {
      checkbox.checked = enabled;
    }
  });
}

// =====================================================
// Create CM6 editor
// =====================================================

function createEditor(container: HTMLElement, content: string) {
  if (editorView) {
    editorView.destroy();
    editorView = null;
  }

  const state = EditorState.create({
    doc: content,
    extensions: [
      lineNumbersCompartment.of(showLineNumbers ? [lineNumbers(), highlightActiveLineGutter()] : []),
      highlightActiveLine(),
      drawSelection(),
      bracketMatching(),
      history(),
      highlightSelectionMatches(),
      EditorState.phrases.of({ regexp: "RegExp" }),
      placeholder("Write AsciiDoc here..."),
      asciidocLanguage(),
      spellcheckCompartment.of(spellcheckEnabled ? spellcheckExtension() : []),
      wikiLinkCompletion(),
      keymap.of([
        ...asciidocKeymap,
        ...defaultKeymap,
        ...historyKeymap,
        ...searchKeymap,
      ]),
      // High-priority Mod-f/Mod-h to ensure CM6 search opens even if host app tries to intercept
      Prec.highest(keymap.of([
        { key: "Mod-f", run: openSearchPanel, scope: "editor search-panel" },
        { key: "Mod-Shift-f", run: openSearchPanel, scope: "editor search-panel" },
        { key: "Mod-h", run: openSearchPanel, scope: "editor search-panel" },
        { key: "Escape", run: closeSearchPanel },
        // Emacs-style line navigation
        { key: "Mod-Shift-a", run: (view) => {
          const line = view.state.doc.lineAt(view.state.selection.main.head);
          view.dispatch({ selection: { anchor: line.from } });
          return true;
        }},
        { key: "Mod-Shift-e", run: (view) => {
          const line = view.state.doc.lineAt(view.state.selection.main.head);
          view.dispatch({ selection: { anchor: line.to } });
          return true;
        }},
        // Kill to end of line
        { key: "Mod-Shift-k", run: (view) => {
          const head = view.state.selection.main.head;
          const line = view.state.doc.lineAt(head);
          if (head < line.to) {
            view.dispatch({ changes: { from: head, to: line.to } });
          }
          return true;
        }},
        // Forward-delete (delete character ahead of cursor)
        { key: "Mod-Shift-d", run: (view) => {
          const head = view.state.selection.main.head;
          if (head < view.state.doc.length) {
            view.dispatch({ changes: { from: head, to: head + 1 } });
          }
          return true;
        }},
        // Transpose characters around cursor
        { key: "Mod-Shift-t", run: (view) => {
          const head = view.state.selection.main.head;
          const line = view.state.doc.lineAt(head);
          if (head > line.from && head < line.to) {
            const before = view.state.doc.sliceString(head - 1, head);
            const after = view.state.doc.sliceString(head, head + 1);
            view.dispatch({
              changes: { from: head - 1, to: head + 1, insert: after + before },
              selection: { anchor: head + 1 },
            });
          } else if (head === line.to && head - 2 >= line.from) {
            // At end of line: swap the two characters before cursor
            const a = view.state.doc.sliceString(head - 2, head - 1);
            const b = view.state.doc.sliceString(head - 1, head);
            view.dispatch({
              changes: { from: head - 2, to: head, insert: b + a },
            });
          }
          return true;
        }},
        // Open new line below cursor
        { key: "Mod-Shift-o", run: (view) => {
          const line = view.state.doc.lineAt(view.state.selection.main.head);
          view.dispatch({
            changes: { from: line.to, insert: "\n" },
            selection: { anchor: line.to + 1 },
          });
          return true;
        }},
      ])),
      // Prevent right-click from losing selection (so context menu works on raw text)
      EditorView.domEventHandlers({
        mousedown(event: MouseEvent, view: EditorView) {
          if (event.button === 2) {
            const sel = view.state.selection.main;
            if (sel.from !== sel.to) {
              // Right-click with active selection — prevent CM6 from moving cursor
              event.preventDefault();
              return true;
            }
          }
          return false;
        },
      }),
      livePreview(), // Always on
      // Enhance CM6 search panel with match counter and remove "all" button
      ViewPlugin.fromClass(class {
        private counterEl: HTMLElement | null = null;
        private panelOpen = false;
        private boundInputHandler: (() => void) | null = null;

        constructor(private view: EditorView) {}

        update() {
          const panel = this.view.dom.querySelector(".cm-panel.cm-search") as HTMLElement | null;
          if (!panel) {
            this.counterEl = null;
            this.panelOpen = false;
            this.boundInputHandler = null;
            return;
          }

          // One-time setup when panel first appears
          if (!this.panelOpen) {
            this.panelOpen = true;

            // Remove "all" button
            for (const btn of panel.querySelectorAll<HTMLButtonElement>(".cm-button")) {
              if (btn.textContent?.trim().toLowerCase() === "all") {
                btn.remove();
                break;
              }
            }

            // Create and inject counter element
            const searchInput = panel.querySelector<HTMLInputElement>(".cm-textfield");
            if (searchInput) {
              this.counterEl = document.createElement("span");
              this.counterEl.className = "cm-search-match-counter";
              searchInput.parentNode!.insertBefore(this.counterEl, searchInput.nextSibling);

              this.boundInputHandler = () => this.updateCounter();
              searchInput.addEventListener("input", this.boundInputHandler);
              // Also listen for checkbox changes (case, regex, by word)
              for (const cb of panel.querySelectorAll<HTMLInputElement>("input[type=checkbox]")) {
                cb.addEventListener("change", this.boundInputHandler);
              }
            }
          }

          this.updateCounter();
        }

        updateCounter() {
          if (!this.counterEl) return;
          const panel = this.view.dom.querySelector(".cm-panel.cm-search");
          if (!panel) return;
          const searchInput = panel.querySelector<HTMLInputElement>(".cm-textfield");
          const query = searchInput?.value || "";

          if (!query) {
            this.counterEl.textContent = "";
            return;
          }

          // Read checkbox states
          let caseSensitive = false;
          let isRegex = false;
          for (const label of panel.querySelectorAll("label")) {
            const text = label.textContent?.toLowerCase() || "";
            const cb = label.querySelector<HTMLInputElement>("input[type=checkbox]");
            if (!cb) continue;
            if (text.includes("case")) caseSensitive = cb.checked;
            if (text.includes("regexp") || text.includes("regex")) isRegex = cb.checked;
          }

          // Count matches
          const doc = this.view.state.doc.toString();
          let matchPositions: number[] = [];
          try {
            if (isRegex) {
              const re = new RegExp(query, caseSensitive ? "g" : "gi");
              let m;
              while ((m = re.exec(doc)) !== null) {
                matchPositions.push(m.index);
                if (m[0].length === 0) re.lastIndex++;
              }
            } else {
              const searchDoc = caseSensitive ? doc : doc.toLowerCase();
              const searchQuery = caseSensitive ? query : query.toLowerCase();
              let pos = 0;
              while ((pos = searchDoc.indexOf(searchQuery, pos)) !== -1) {
                matchPositions.push(pos);
                pos += searchQuery.length || 1;
              }
            }
          } catch {
            matchPositions = [];
          }

          const count = matchPositions.length;
          const cursor = this.view.state.selection.main.from;
          let idx = 0;
          if (count > 0) {
            for (let i = 0; i < count; i++) {
              if (matchPositions[i] <= cursor) idx = i + 1;
            }
            if (idx === 0) idx = 1;
          }

          this.counterEl.textContent = count > 0 ? `${idx} / ${count}` : "0 / 0";
        }

        destroy() {}
      }),
      // Smart Quotes: convert straight quotes to curly quotes, with prime/double-prime support
      EditorView.inputHandler.of((view, from, _to, text) => {
        if (!isSmartQuotesEnabled()) return false;
        if (text !== '"' && text !== "'") return false;
        const sel = view.state.selection.main;
        if (sel.from !== sel.to) return false; // don't interfere with selection wrapping

        const before = from > 0 ? view.state.doc.sliceString(from - 1, from) : "";
        const after = from < view.state.doc.length ? view.state.doc.sliceString(from, from + 1) : "";

        // Override: pressing quote right after a prime/double-prime reverts it
        if (text === "'" && before === "\u2032") {
          view.dispatch({
            changes: { from: from - 1, to: from, insert: "'" },
          });
          return true;
        }
        if (text === '"' && before === "\u2033") {
          view.dispatch({
            changes: { from: from - 1, to: from, insert: '"' },
          });
          return true;
        }

        // Single prime: ' after a digit, with no letter immediately following
        if (text === "'" && /\d/.test(before) && (after === "" || !/[a-zA-Z]/.test(after))) {
          view.dispatch({
            changes: { from, to: from, insert: "\u2032" },
            selection: { anchor: from + 1 },
          });
          return true;
        }

        // Double prime: " after a digit, only if a prime precedes the digits
        if (text === '"' && /\d/.test(before)) {
          const lookback = view.state.doc.sliceString(Math.max(0, from - 20), from);
          if (/\u2032\d+$/.test(lookback)) {
            view.dispatch({
              changes: { from, to: from, insert: "\u2033" },
              selection: { anchor: from + 1 },
            });
            return true;
          }
        }

        // Standard curly quotes: open vs close based on preceding character
        const isOpen = !before || /[\s(\[{]/.test(before);
        let replacement: string;
        if (text === '"') {
          replacement = isOpen ? "\u201C" : "\u201D";
        } else {
          replacement = isOpen ? "\u2018" : "\u2019";
        }

        view.dispatch({
          changes: { from, to: from, insert: replacement },
          selection: { anchor: from + replacement.length },
        });
        return true;
      }),
      // Auto-pair quotes/brackets around selections
      EditorView.inputHandler.of((view, from, _to, text) => {
        const pairs: Record<string, string> = { '"': '"', "'": "'", '(': ')', '[': ']', '{': '}' };
        const closing = pairs[text];
        if (!closing) return false;
        const sel = view.state.selection.main;
        if (sel.from === sel.to) return false;
        const selected = view.state.sliceDoc(sel.from, sel.to);
        view.dispatch({
          changes: { from: sel.from, to: sel.to, insert: text + selected + closing },
          selection: { anchor: sel.from + 1, head: sel.from + 1 + selected.length },
        });
        return true;
      }),
      EditorView.lineWrapping,
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          if (suppressNextDocChange) {
            suppressNextDocChange = false;
            return;
          }
          scheduleSave();
        }
      }),
      EditorView.theme({
        ".cm-scroller": {
          overflow: "auto",
          position: "relative",
        },
      }),
    ],
  });

  editorView = new EditorView({
    state,
    parent: container,
  });

  updateBlockShading();
  updateCompactSpacing();
}

// =====================================================
// Message handling from plugin sandbox
// =====================================================

function handleMessage(msg: any) {
  if (!msg || !msg.type) return;

  if (msg.type === "updateNote") {
    const { id, body } = msg.value || {};
    if (!id || body == null) return;

    // Close any open floating section preview from the previous note
    closeFloatingPreview();

    // Force save current note before switching
    if (isDirty && currentNoteId && currentNoteId !== id) {
      forceSave();
    }

    const { content, sentinel } = stripSentinel(body || "");
    currentNoteId = id;
    currentSentinel = sentinel;
    isDirty = false;
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }

    if (editorView) {
      suppressNextDocChange = true; // Don't trigger save for this programmatic update
      editorView.dispatch({
        changes: { from: 0, to: editorView.state.doc.length, insert: content },
      });
    }

    // Resolve Joplin resource URLs
    resolveResources(content);
  }

  if (msg.type === "updateTheme") {
    const root = document.getElementById("asciidoc-editor-root");
    if (root) {
      root.classList.remove("dark-theme", "light-theme");
      root.classList.add(msg.value === "dark" ? "dark-theme" : "light-theme");
    }
    setMermaidTheme(msg.value === "dark");
    // Force live-preview to rebuild so mermaid diagrams re-render with new theme
    if (editorView) refreshLivePreview(editorView);
  }

  if (msg.type === "updateCompactSpacing") {
    compactSpacingEnabled = msg.value === true;
    updateCompactSpacing();
  }
}

// =====================================================
// Initialization
// =====================================================

function applyZoom(percent: number) {
  if (!editorView) return;
  const scroller = editorView.scrollDOM;
  const scrollRatio = scroller.scrollHeight > 0 ? scroller.scrollTop / scroller.scrollHeight : 0;

  editorView.dom.style.setProperty("--editor-scale", String(percent / 100));
  requestAnimationFrame(() => {
    if (!editorView) return;
    editorView.scrollDOM.scrollTop = scrollRatio * editorView.scrollDOM.scrollHeight;
    editorView.requestMeasure();
    refreshLivePreview(editorView);
  });
}

// =====================================================
// Custom right-click context menu
// =====================================================

let clipboardMenu: HTMLElement | null = null;

function dismissClipboardMenu() {
  if (clipboardMenu) {
    clipboardMenu.remove();
    clipboardMenu = null;
  }
}

function stripHtmlToPlainText(html: string): string {
  const div = document.createElement("div");
  div.innerHTML = html;
  return (div.textContent || div.innerText || "").trim();
}

async function copyRenderedAsciidoc(rawAsciiDoc: string): Promise<void> {
  const { html } = await renderAsciidoc(rawAsciiDoc);
  const plainText = stripHtmlToPlainText(html);
  try {
    const htmlBlob = new Blob([html], { type: "text/html" });
    const textBlob = new Blob([plainText], { type: "text/plain" });
    await navigator.clipboard.write([
      new ClipboardItem({ "text/html": htmlBlob, "text/plain": textBlob }),
    ]);
  } catch {
    await navigator.clipboard.writeText(plainText);
  }
}

async function pasteAsConverted(view: EditorView) {
  const clipText = await navigator.clipboard.readText();
  if (!clipText) return;
  const { asciidoc } = await convertMarkdownPaste(clipText);
  const { from, to } = view.state.selection.main;
  view.dispatch({ changes: { from, to, insert: asciidoc } });
}

function showClipboardContextMenu(view: EditorView, event: MouseEvent) {
  dismissClipboardMenu();

  // Capture selection state NOW — before any focus changes can lose it
  const sel = view.state.selection.main;
  const hasSelection = sel.from !== sel.to;
  const selFrom = sel.from;
  const selTo = sel.to;
  const selectedText = hasSelection ? view.state.sliceDoc(selFrom, selTo) : "";

  const menu = document.createElement("div");
  menu.className = "spell-context-menu";

  function addItem(label: string, enabled: boolean, action: () => void) {
    const el = document.createElement("div");
    el.className = "spell-context-menu-item";
    el.textContent = label;
    if (!enabled) {
      el.style.opacity = "0.4";
      el.style.pointerEvents = "none";
    }
    el.addEventListener("mousedown", (e) => {
      e.preventDefault(); e.stopPropagation();
      action();
      dismissClipboardMenu();
      view.focus();
    });
    menu.appendChild(el);
  }

  function addSeparator() {
    const sep = document.createElement("div");
    sep.className = "spell-context-menu-separator";
    menu.appendChild(sep);
  }

  // ── Cut section ──
  addItem("Cut", hasSelection, () => {
    navigator.clipboard.writeText(selectedText);
    view.dispatch({ changes: { from: selFrom, to: selTo, insert: "" } });
  });
  addItem("Cut as AsciiDoc Text", hasSelection, async () => {
    await copyRenderedAsciidoc(selectedText);
    view.dispatch({ changes: { from: selFrom, to: selTo, insert: "" } });
  });

  addSeparator();

  // ── Copy section ──
  addItem("Copy", hasSelection, () => {
    navigator.clipboard.writeText(selectedText);
  });
  addItem("Copy as AsciiDoc Text", hasSelection, () => {
    copyRenderedAsciidoc(selectedText);
  });

  addSeparator();

  // ── Paste section ──
  addItem("Paste", true, async () => {
    const text = await navigator.clipboard.readText();
    if (text) {
      const pos = view.state.selection.main;
      view.dispatch({ changes: { from: pos.from, to: pos.to, insert: text } });
    }
  });
  addItem("Convert from Markdown & Paste", true, () => pasteAsConverted(view));

  addSeparator();

  // ── Select All ──
  addItem("Select All", true, () => {
    view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } });
  });

  // Position menu
  menu.style.position = "fixed";
  menu.style.left = `${event.clientX}px`;
  menu.style.top = `${event.clientY}px`;

  document.body.appendChild(menu);
  clipboardMenu = menu;

  // Adjust position if menu overflows viewport
  requestAnimationFrame(() => {
    const rect = menu.getBoundingClientRect();
    if (rect.right > window.innerWidth) menu.style.left = `${window.innerWidth - rect.width - 4}px`;
    if (rect.bottom > window.innerHeight) menu.style.top = `${window.innerHeight - rect.height - 4}px`;
  });

  // Dismiss on click outside or Escape
  const dismissHandler = (e: MouseEvent) => {
    if (!menu.contains(e.target as Node)) {
      dismissClipboardMenu();
      document.removeEventListener("mousedown", dismissHandler, true);
      document.removeEventListener("keydown", escHandler, true);
    }
  };
  const escHandler = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      dismissClipboardMenu();
      document.removeEventListener("mousedown", dismissHandler, true);
      document.removeEventListener("keydown", escHandler, true);
    }
  };
  setTimeout(() => {
    document.addEventListener("mousedown", dismissHandler, true);
    document.addEventListener("keydown", escHandler, true);
  }, 0);
}

function init() {
  const root = document.getElementById("asciidoc-editor-root");
  if (!root) return;

  // Restore persisted auto-hide toolbar
  if (autoHideToolbar) setAutoHideToolbar(true);

  // Restore persisted margin
  const savedMargin = parseInt(localStorage.getItem("asciidoc-editor-margin") || "0", 10);
  if (savedMargin > 0) {
    document.documentElement.style.setProperty("--content-margin", `${savedMargin}px`);
  }

  // Build ribbon
  const ribbonContainer = document.getElementById("ribbon-container");
  if (ribbonContainer) {
    buildRibbon(ribbonContainer, {
      onToggleLineNumbers(show: boolean) {
        showLineNumbers = show;
        updateLineNumbers();
      },
      onToggleBlockShading(show: boolean) {
        specialBlockShading = show;
        updateBlockShading();
      },
      onToggleOverlayEditing(enabled: boolean) {
        overlayEditingEnabled = enabled;
        setOverlayEditingEnabled(enabled);
      },
      onToggleSpellCheck(enabled: boolean) {
        spellcheckEnabled = enabled;
        updateSpellcheck();
      },
      onToggleFullscreen(enabled: boolean) {
        setFullscreen(enabled);
      },
      onToggleAutoHide(enabled: boolean) {
        setAutoHideToolbar(enabled);
      },
      onMarginChange(px: number) {
        document.documentElement.style.setProperty("--content-margin", `${px}px`);
        localStorage.setItem("asciidoc-editor-margin", String(px));
      },
      onZoomChange(percent: number) {
        currentZoom = percent;
        localStorage.setItem("asciidoc-editor-zoom", String(percent));
        applyZoom(percent);
      },
    }, savedMargin, currentZoom);
  }

  // Wire spell-check dictionary persistence
  onDictionaryChange((word: string) => {
    addWordToPersonalDictionary(word).catch((e) =>
      console.error("[panel] Failed to persist dictionary word:", e)
    );
  });

  // Create editor
  const editorPane = document.getElementById("editor-pane");
  if (editorPane) {
    createEditor(editorPane, "");
  }

  // Apply persisted zoom level
  if (currentZoom !== 100) {
    applyZoom(currentZoom);
  }

  // Prevent ribbon clicks from stealing editor focus — the ribbon is part of the editor UI
  const ribbonEl = document.getElementById("ribbon-container");
  if (ribbonEl) {
    ribbonEl.addEventListener("mousedown", (e) => {
      // Only prevent default if the target isn't an input/textarea/select (those need focus)
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag !== "INPUT" && tag !== "TEXTAREA" && tag !== "SELECT") {
        e.preventDefault();
      }
    });
  }

  // Intercept Cmd/Ctrl+F in capture phase to open CM6 search instead of Joplin's
  document.addEventListener("keydown", (e) => {
    if (!editorView) return;
    const isMod = e.metaKey || e.ctrlKey;
    if (isMod && (e.key === "f" || e.key === "h") && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      e.stopImmediatePropagation();
      openSearchPanel(editorView);
    }
  }, true);

  // Escape key exits fullscreen mode (only when nothing else consumed the Escape)
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || !isFullscreen || e.defaultPrevented) return;
    // Don't exit fullscreen if a block editor modal is open (it has its own Escape handler)
    const hasModal = editorView?.dom.querySelector(".cm-lp-block-editor-overlay") != null;
    if (!hasModal) {
      setFullscreen(false);
    }
  });

  // Open CM6 search panel from toolbar button
  window.addEventListener("open-search", () => {
    if (editorView) openSearchPanel(editorView);
  });

  // Custom right-click context menu
  const editorPaneEl = document.getElementById("editor-pane");
  if (editorPaneEl) {
    editorPaneEl.addEventListener("contextmenu", (e) => {
      if (e.defaultPrevented) return; // let spellcheck handle its own menu
      e.preventDefault();
      if (editorView) showClipboardContextMenu(editorView, e);
    });
  }

  // Event listeners
  window.addEventListener("editor-command", handleEditorCommand);
  window.addEventListener("force-save", forceSave);

  // Close dropdowns on resize
  window.addEventListener("resize", () => {
    document.querySelectorAll(".split-dropdown.open").forEach(el => el.classList.remove("open"));
  });

  // Listen for push messages from plugin sandbox (updateNote, updateTheme)
  // Joplin uses webviewApi.onMessage, not window "message" events.
  // The message may be wrapped as { message: ... } or passed directly.
  webviewApi.onMessage((msg: any) => {
    const data = msg.message || msg;
    handleMessage(data);
  });

  // Notify plugin sandbox we're ready and process the response
  webviewApi.postMessage({ type: "ready" }).then((response: any) => {
    if (!response) return;

    // Apply theme from response
    if (response.isDark != null) {
      const root = document.getElementById("asciidoc-editor-root");
      if (root) {
        root.classList.remove("dark-theme", "light-theme");
        root.classList.add(response.isDark ? "dark-theme" : "light-theme");
      }
      setMermaidTheme(response.isDark);
    }

    // Apply compact spacing setting from Joplin settings
    if (response.compactSpacing != null) {
      compactSpacingEnabled = response.compactSpacing === true;
      updateCompactSpacing();
    }

    // Load initial note if available
    if (response.note) {
      handleMessage({ type: "updateNote", value: response.note });
    }

    // Load spell-checker settings and personal dictionary
    getSpellcheckSettings().then((settings) => {
      setShowPluralSingular(settings.pluralSingular);
    }).catch((e) => console.error("[panel] Failed to load spellcheck settings:", e));

    getPersonalDictionary().then((result) => {
      if (result.words && result.words.length > 0) {
        loadPersonalDictionary(result.words);
        if (spellcheckEnabled && editorView) {
          refreshSpellcheck(editorView);
        }
      }
    }).catch((e) => console.error("[panel] Failed to load personal dictionary:", e));
  }).catch((e: any) => {
    console.error("[panel] Ready handshake failed:", e);
  });
}

// Start when DOM is ready
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
