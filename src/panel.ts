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
import { buildRibbon } from "./lib/toolbar/ribbon";
import { saveNoteContent, requestResources } from "./lib/ipc";

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
let showLineNumbers = false;
let specialBlockShading = true;
let overlayEditingEnabled = localStorage.getItem("asciidoc-overlay-editing") === "true";
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
    editorView.dispatch({
      changes: { from, to, insert: before + selected + after },
      selection: { anchor: from + before.length, head: to + before.length },
    });
  } else if (type === "insert") {
    editorView.dispatch({
      changes: { from, insert: text },
      selection: { anchor: from + text.length },
    });
  } else if (type === "heading") {
    const lineObj = editorView.state.doc.lineAt(from);
    const stripped = lineObj.text.replace(/^=+\s*/, "");
    const newLine = text + stripped;
    editorView.dispatch({
      changes: { from: lineObj.from, to: lineObj.to, insert: newLine },
      selection: { anchor: lineObj.from + newLine.length },
    });
  } else if (type === "prefix") {
    const lineObj = editorView.state.doc.lineAt(from);
    if (lineObj.text.startsWith(text)) {
      editorView.dispatch({
        changes: { from: lineObj.from, to: lineObj.from + text.length, insert: "" },
      });
    } else {
      editorView.dispatch({
        changes: { from: lineObj.from, insert: text },
      });
    }
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
      lineNumbersCompartment.of([]),
      highlightActiveLine(),
      drawSelection(),
      bracketMatching(),
      history(),
      highlightSelectionMatches(),
      placeholder("Write AsciiDoc here..."),
      asciidocLanguage(),
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
  }
}

// =====================================================
// Initialization
// =====================================================

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
      onMarginChange(px: number) {
        document.documentElement.style.setProperty("--content-margin", `${px}px`);
        localStorage.setItem("asciidoc-editor-margin", String(px));
      },
    }, savedMargin);
  }

  // Create editor
  const editorPane = document.getElementById("editor-pane");
  if (editorPane) {
    createEditor(editorPane, "");
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
    }

    // Load initial note if available
    if (response.note) {
      handleMessage({ type: "updateNote", value: response.note });
    }
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
