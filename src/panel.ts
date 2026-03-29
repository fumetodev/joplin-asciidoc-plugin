/**
 * Webview entry point for the AsciiDoc live-preview editor.
 * Replaces the old split-view panel.js with a single-pane CM6 editor
 * with always-on live-preview decorations.
 */

import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, placeholder } from "@codemirror/view";
import { EditorState, Compartment, Prec } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { searchKeymap, highlightSelectionMatches, openSearchPanel, closeSearchPanel, searchPanelOpen } from "@codemirror/search";
import { bracketMatching } from "@codemirror/language";
import { asciidocLanguage } from "./lib/editor/asciidoc-language";
import { asciidocKeymap } from "./lib/editor/keybindings";
import { livePreview, refreshLivePreview, updateResourceUrls, setOverlayEditingEnabled } from "./lib/editor/live-preview";
import { wikiLinkCompletion } from "./lib/editor/wiki-link-completion";
import { spellcheckExtension, loadPersonalDictionary, onDictionaryChange, refreshSpellcheck } from "./lib/editor/spellcheck";
import { buildRibbon } from "./lib/toolbar/ribbon";
import { saveNoteContent, requestResources, getPersonalDictionary, addWordToPersonalDictionary } from "./lib/ipc";
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
// Sync initial state to live-preview module
setOverlayEditingEnabled(overlayEditingEnabled);

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
  const { type, before, after, text } = (e as CustomEvent).detail;
  if (!editorView) return;
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

function updateSpellcheck() {
  if (!editorView) return;
  editorView.dispatch({
    effects: spellcheckCompartment.reconfigure(
      spellcheckEnabled ? spellcheckExtension() : []
    ),
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
        { key: "Mod-h", run: openSearchPanel, scope: "editor search-panel" },
        { key: "Escape", run: closeSearchPanel },
      ])),
      livePreview(), // Always on
      // Auto-pair quotes/brackets around selections
      EditorView.inputHandler.of((view, from, to, text) => {
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
}

// =====================================================
// Message handling from plugin sandbox
// =====================================================

function handleMessage(msg: any) {
  if (!msg || !msg.type) return;

  if (msg.type === "updateNote") {
    const { id, body } = msg.value || {};
    if (!id || body == null) return;

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

function init() {
  const root = document.getElementById("asciidoc-editor-root");
  if (!root) return;

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

  // Open CM6 search panel from toolbar button
  window.addEventListener("open-search", () => {
    if (editorView) openSearchPanel(editorView);
  });

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

    // Load initial note if available
    if (response.note) {
      handleMessage({ type: "updateNote", value: response.note });
    }

    // Load personal dictionary for spell checker
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
