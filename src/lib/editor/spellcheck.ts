/**
 * AsciiDoc-aware spell-checking via nspell + CM6 ViewPlugin.
 *
 * Only checks prose text — skips AsciiDoc markup, code blocks, URLs,
 * attributes, comments, macros, etc. by consulting the syntax tree
 * produced by asciidoc-language.ts.
 */

import {
  EditorView,
  ViewPlugin,
  Decoration,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import { RangeSetBuilder, StateEffect } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import NSpell from "nspell";

// Dictionary data inlined by webpack asset/source
import affData from "../../dictionaries/en/index.aff";
import dicData from "../../dictionaries/en/index.dic";

// =====================================================
// Module-level singletons
// =====================================================

let spell: NSpell | null = null;
try {
  spell = NSpell(affData, dicData);
} catch (e) {
  console.error("[spellcheck] Failed to initialize nspell:", e);
}

/** Cache of word → correct (true) or misspelled (false). Cleared on dictionary changes. */
const wordCache = new Map<string, boolean>();

/** Words the user clicked "Ignore" on this session. */
const sessionIgnored = new Set<string>();

/** Current misspelled word ranges — populated by ViewPlugin, queried by context menu. */
let misspelledRanges: Array<{ from: number; to: number; word: string }> = [];

/** Callback fired when a word is added to the personal dictionary (for IPC persistence). */
let dictionaryChangeCallback: ((word: string) => void) | null = null;

/** Reference to the active context menu element, if any. */
let activeContextMenu: HTMLElement | null = null;

/** Cleanup function for the active context menu's event listeners. */
let activeMenuCleanup: (() => void) | null = null;

/** StateEffect used to force the ViewPlugin to recompute decorations. */
const forceSpellcheckEffect = StateEffect.define<null>();

// =====================================================
// Syntax-tree–based prose detection
// =====================================================

/**
 * Node type names from StreamLanguage that should NOT be spell-checked.
 * These correspond to the return values of the token() function in
 * asciidoc-language.ts — StreamLanguage creates node types whose names
 * match these style strings.
 */
const SKIP_NODES = new Set<string>([
  "meta",
  "comment",
  "monospace",
  "string",        // code block content, superscript, subscript
  "link",
  "url",
  "variableName",
  "list",
  "contentSeparator",
]);

/** Fallback inline pattern for markup spans that should not be spell-checked. */
const SKIP_INLINE_PATTERN =
  /`[^`]+`|image::?\S+\[[^\]]*\]|link:\S+\[[^\]]*\]|<<[^>]+>>|\[\[[^\]]+\]\]|[a-zA-Z]+::\S+/g;

/** Word extraction regex: Latin letters + apostrophes, min 2 chars. */
const WORD_RE = /[a-zA-Z'\u00C0-\u024F]{2,}/g;

/** Returns true if the word should be skipped outright (not a prose word). */
function shouldSkipWord(word: string): boolean {
  // Words containing digits are likely identifiers
  if (/\d/.test(word)) return true;
  // ALL-CAPS words of 4+ chars are likely acronyms
  if (word.length >= 4 && word === word.toUpperCase()) return true;
  // Single-letter "words" that snuck through (shouldn't with min-2 regex, but safety)
  if (word.length < 2) return true;
  return false;
}

/**
 * Check if a document position is inside a prose token by consulting the syntax tree.
 * Returns true for untagged text, heading, keyword, strong, emphasis.
 * Returns false for code, links, attributes, comments, etc.
 */
function isProseAt(view: EditorView, pos: number): boolean {
  const tree = syntaxTree(view.state);
  const node = tree.resolveInner(pos, 1);
  const name = node.type.name;
  // Empty name = untagged prose text (the most common case)
  if (!name) return true;
  // Named nodes in the skip set
  if (SKIP_NODES.has(name)) return false;
  // Everything else (heading, keyword, strong, emphasis) is prose
  return true;
}

/**
 * Regex-based fallback for prose detection. Checks if a position on a line
 * is inside AsciiDoc markup that should not be spell-checked.
 */
function isProseAtFallback(lineText: string, offsetInLine: number, word: string): boolean {
  // Skip entire line if it matches a skip pattern (except headings — we check text after =)
  if (/^:[\w-]+:.*$/.test(lineText)) return false;
  if (/^\/\//.test(lineText)) return false;
  if (/^(----|====|____|[*]{4})/.test(lineText)) return false;

  // Check if the word falls inside an inline markup span
  SKIP_INLINE_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = SKIP_INLINE_PATTERN.exec(lineText)) !== null) {
    const spanStart = match.index;
    const spanEnd = spanStart + match[0].length;
    if (offsetInLine >= spanStart && offsetInLine + word.length <= spanEnd) {
      return false;
    }
  }

  return true;
}

// =====================================================
// Decoration computation
// =====================================================

const spellErrorMark = Decoration.mark({ class: "cm-spell-error" });

function computeDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const newMisspelled: Array<{ from: number; to: number; word: string }> = [];

  if (!spell) {
    misspelledRanges = newMisspelled;
    return builder.finish();
  }

  const doc = view.state.doc;
  const cursor = view.state.selection.main.head;

  // Use syntaxTree to check if it has been parsed for this document
  const tree = syntaxTree(view.state);
  const treeAvailable = tree.length > 0;

  for (const { from, to } of view.visibleRanges) {
    const startLine = doc.lineAt(from).number;
    const endLine = doc.lineAt(to).number;

    for (let ln = startLine; ln <= endLine; ln++) {
      const line = doc.line(ln);
      const lineText = line.text;

      // Skip empty lines
      if (!lineText.trim()) continue;

      // Extract words from the line
      WORD_RE.lastIndex = 0;
      let wordMatch: RegExpExecArray | null;
      while ((wordMatch = WORD_RE.exec(lineText)) !== null) {
        const word = wordMatch[0];
        const offsetInLine = wordMatch.index;
        const wordFrom = line.from + offsetInLine;
        const wordTo = wordFrom + word.length;

        // Skip the word the user is currently typing — the cursor is inside
        // or immediately at the end of it (no separator character yet).
        if (cursor >= wordFrom && cursor <= wordTo) continue;

        // Skip non-prose words
        if (shouldSkipWord(word)) continue;

        // Check if position is prose using syntax tree (preferred) or regex fallback
        if (treeAvailable) {
          if (!isProseAt(view, wordFrom)) continue;
        } else {
          if (!isProseAtFallback(lineText, offsetInLine, word)) continue;
        }

        // Check if ignored
        if (sessionIgnored.has(word) || sessionIgnored.has(word.toLowerCase())) continue;

        // Check spelling (use cache)
        const lowerWord = word.toLowerCase();
        let isCorrect: boolean;
        if (wordCache.has(lowerWord)) {
          isCorrect = wordCache.get(lowerWord)!;
        } else {
          // Check both the original case and lowercase
          isCorrect = spell.correct(word) || spell.correct(lowerWord);
          wordCache.set(lowerWord, isCorrect);
        }

        if (!isCorrect) {
          builder.add(wordFrom, wordTo, spellErrorMark);
          newMisspelled.push({ from: wordFrom, to: wordTo, word });
        }
      }
    }
  }

  misspelledRanges = newMisspelled;
  return builder.finish();
}

// =====================================================
// ViewPlugin
// =====================================================

const spellcheckPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    private debounceTimer: ReturnType<typeof setTimeout> | null = null;

    constructor(view: EditorView) {
      this.decorations = computeDecorations(view);
    }

    update(update: ViewUpdate) {
      const forceRefresh = update.transactions.some((tr) =>
        tr.effects.some((e) => e.is(forceSpellcheckEffect))
      );

      if (forceRefresh) {
        // Immediate recompute (triggered by ignore/add-to-dictionary/debounce)
        this.decorations = computeDecorations(update.view);
      } else if (update.docChanged) {
        // Debounce on document changes to avoid lag while typing
        if (this.debounceTimer) clearTimeout(this.debounceTimer);
        const view = update.view;
        this.debounceTimer = setTimeout(() => {
          // Dispatch an effect to trigger a proper update cycle — requestMeasure()
          // alone is insufficient because CM6 may skip the update if there are no
          // geometry changes, leaving the new decorations unread.
          view.dispatch({ effects: forceSpellcheckEffect.of(null) });
          this.debounceTimer = null;
        }, 300);
      } else if (update.viewportChanged) {
        // Immediate recompute on scroll (user expects to see underlines)
        this.decorations = computeDecorations(update.view);
      } else if (update.selectionSet) {
        // Recompute when cursor moves — the previously-active word may now
        // need checking, and the newly-active word should be skipped.
        this.decorations = computeDecorations(update.view);
      }
    }

    destroy() {
      if (this.debounceTimer) clearTimeout(this.debounceTimer);
    }
  },
  { decorations: (v) => v.decorations }
);

// =====================================================
// Context menu
// =====================================================

function dismissContextMenu() {
  if (activeMenuCleanup) {
    activeMenuCleanup();
    activeMenuCleanup = null;
  }
  if (activeContextMenu) {
    activeContextMenu.remove();
    activeContextMenu = null;
  }
}

function showContextMenu(
  view: EditorView,
  event: MouseEvent,
  entry: { from: number; to: number; word: string }
) {
  dismissContextMenu();

  const menu = document.createElement("div");
  menu.className = "spell-context-menu";

  // Suggestions (lazy — only computed on right-click)
  const suggestions = spell ? spell.suggest(entry.word).slice(0, 5) : [];

  if (suggestions.length > 0) {
    for (const suggestion of suggestions) {
      const item = document.createElement("div");
      item.className = "spell-context-menu-item suggestion";
      item.textContent = suggestion;
      item.addEventListener("mousedown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        view.dispatch({
          changes: { from: entry.from, to: entry.to, insert: suggestion },
        });
        dismissContextMenu();
        view.focus();
      });
      menu.appendChild(item);
    }
  } else {
    const noSuggestions = document.createElement("div");
    noSuggestions.className = "spell-context-menu-item";
    noSuggestions.style.fontStyle = "italic";
    noSuggestions.style.opacity = "0.6";
    noSuggestions.textContent = "No suggestions";
    menu.appendChild(noSuggestions);
  }

  // Separator
  const sep = document.createElement("div");
  sep.className = "spell-context-menu-separator";
  menu.appendChild(sep);

  // Ignore
  const ignoreItem = document.createElement("div");
  ignoreItem.className = "spell-context-menu-item";
  ignoreItem.textContent = "Ignore";
  ignoreItem.addEventListener("mousedown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    sessionIgnored.add(entry.word);
    sessionIgnored.add(entry.word.toLowerCase());
    wordCache.delete(entry.word.toLowerCase());
    dismissContextMenu();
    // Force re-decoration
    view.dispatch({ effects: forceSpellcheckEffect.of(null) });
    view.focus();
  });
  menu.appendChild(ignoreItem);

  // Add to Dictionary
  const addItem = document.createElement("div");
  addItem.className = "spell-context-menu-item";
  addItem.textContent = "Add to Dictionary";
  addItem.addEventListener("mousedown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (spell) {
      spell.add(entry.word);
      spell.add(entry.word.toLowerCase());
    }
    wordCache.delete(entry.word.toLowerCase());
    dismissContextMenu();
    // Notify panel.ts to persist via IPC
    if (dictionaryChangeCallback) {
      dictionaryChangeCallback(entry.word);
    }
    // Force re-decoration
    view.dispatch({ effects: forceSpellcheckEffect.of(null) });
    view.focus();
  });
  menu.appendChild(addItem);

  // Position the menu near the cursor, adjusting for viewport edges
  let x = event.clientX;
  let y = event.clientY;

  document.body.appendChild(menu);
  activeContextMenu = menu;

  // Adjust position after rendering (so we know the menu dimensions)
  requestAnimationFrame(() => {
    if (!activeContextMenu) return;
    const rect = menu.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    if (x + rect.width > vw) x = vw - rect.width - 4;
    if (y + rect.height > vh) y = y - rect.height - 4;
    if (x < 0) x = 4;
    if (y < 0) y = 4;
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;
  });

  // Dismiss handlers
  const onEscape = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      dismissContextMenu();
    }
  };
  const onOutsideClick = (e: MouseEvent) => {
    if (activeContextMenu && !activeContextMenu.contains(e.target as Node)) {
      dismissContextMenu();
    }
  };
  const onScroll = () => dismissContextMenu();

  // Store cleanup at module level so dismissContextMenu() can remove listeners
  // even if the menu is dismissed externally (e.g., by opening a new context menu)
  activeMenuCleanup = () => {
    document.removeEventListener("mousedown", onOutsideClick);
    document.removeEventListener("keydown", onEscape, true);
    view.scrollDOM.removeEventListener("scroll", onScroll);
  };

  // Use setTimeout to avoid the current contextmenu event from triggering dismiss
  setTimeout(() => {
    document.addEventListener("mousedown", onOutsideClick);
    document.addEventListener("keydown", onEscape, true);
    view.scrollDOM.addEventListener("scroll", onScroll);
  }, 0);
}

const spellcheckContextMenu = EditorView.domEventHandlers({
  contextmenu(event: MouseEvent, view: EditorView) {
    if (!spell) return false;

    const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
    if (pos == null) return false;

    // Find the misspelled word under the cursor
    const entry = misspelledRanges.find(
      (r) => pos >= r.from && pos <= r.to
    );
    if (!entry) return false;

    // Verify the word still matches (positions may be stale after edits)
    const currentText = view.state.sliceDoc(entry.from, entry.to);
    if (currentText !== entry.word) return false;

    // Prevent default browser context menu
    event.preventDefault();
    showContextMenu(view, event, entry);
    return true;
  },
});

// =====================================================
// Exports
// =====================================================

/** Returns the CM6 extension array for spell-checking. */
export function spellcheckExtension() {
  return [spellcheckPlugin, spellcheckContextMenu];
}

/** Load a personal dictionary (called on startup with persisted words). */
export function loadPersonalDictionary(words: string[]): void {
  if (!spell) return;
  for (const word of words) {
    spell.add(word);
  }
  wordCache.clear();
}

/** Force a spell-check refresh on the given editor view (e.g., after loading dictionary). */
export function refreshSpellcheck(view: EditorView): void {
  view.dispatch({ effects: forceSpellcheckEffect.of(null) });
}

/** Set the callback for when a word is added to the personal dictionary. */
export function onDictionaryChange(cb: (word: string) => void): void {
  dictionaryChangeCallback = cb;
}

/** Returns whether nspell has been initialized successfully. */
export function isSpellcheckReady(): boolean {
  return spell !== null;
}
