import {
  type CompletionContext,
  type CompletionResult,
  type Completion,
  autocompletion,
  completionKeymap,
  startCompletion,
  acceptCompletion,
  moveCompletionSelection,
  completionStatus,
} from "@codemirror/autocomplete";
import { EditorView, keymap } from "@codemirror/view";
import { searchNotes, getNoteSections } from "../ipc";
import { getBiblioLabels } from "./live-preview";

interface AutocompleteResult {
  id: string;
  title: string;
  node_type: string;
}

interface Section {
  level: number;
  title: string;
  anchor: string;
}

/**
 * Main wiki-link completion source.
 * Phase 1: Note search — triggered by `<<` — shows note titles + bibliography refs
 * Phase 2: Section search — triggered by `#` after note ID — shows sections
 */
async function wikiLinkCompletionSource(
  context: CompletionContext
): Promise<CompletionResult | null> {
  const match = context.matchBefore(/<<[^>]*/);
  if (!match) return null;

  const inner = match.text.slice(2); // strip <<

  // Phase 2: Section completion — detect # in the inner content
  const hashIndex = inner.indexOf("#");
  if (hashIndex !== -1) {
    return handleSectionCompletion(context, match, inner, hashIndex);
  }

  // Phase 1: Note search — if there's already a comma, user picked a note
  if (inner.includes(",")) return null;

  return handleNoteCompletion(context, match, inner);
}

async function handleNoteCompletion(
  context: CompletionContext,
  match: { from: number; to: number; text: string },
  query: string
): Promise<CompletionResult | null> {
  let results: AutocompleteResult[];
  try {
    const response = await searchNotes(query.trim());
    results = response.notes.map(n => ({ id: n.id, title: n.title, node_type: "note" }));
  } catch (e) {
    console.error("[WikiLink] autocomplete search failed:", e);
    results = [];
  }

  const queryFrom = match.from + 2;
  const xrefStart = match.from;
  const queryLower = query.trim().toLowerCase();

  // Build note link options
  const noteOptions: Completion[] = results.map((note) => ({
    label: note.title,
    detail: note.node_type === "noteview" ? "View" : "Note",
    type: note.node_type === "noteview" ? "namespace" : "variable",
    section: "Notes",
    apply: (view: any, _completion: any, _from: number, to: number) => {
      const text = `<<${note.id},${note.title}>>`;
      view.dispatch({
        changes: { from: xrefStart, to, insert: text },
        selection: { anchor: xrefStart + text.length - 2 },
      });
    },
  }));

  // Build bibliography reference options
  const biblioLabels = getBiblioLabels();
  const biblioOptions: Completion[] = [];
  for (const [label, xreftext] of biblioLabels) {
    if (queryLower && !label.toLowerCase().includes(queryLower) && !xreftext.toLowerCase().includes(queryLower)) {
      continue;
    }
    biblioOptions.push({
      label: xreftext,
      detail: label,
      type: "text",
      section: "Bibliography",
      apply: (view: any, _completion: any, _from: number, to: number) => {
        const text = `<<${label}>>`;
        view.dispatch({
          changes: { from: xrefStart, to, insert: text },
          selection: { anchor: xrefStart + text.length },
        });
      },
    });
  }

  const allOptions = [...noteOptions, ...biblioOptions];
  if (allOptions.length === 0) return null;

  return {
    from: queryFrom,
    options: allOptions,
    validFor: /^[^>,#]*/,
  };
}

async function handleSectionCompletion(
  context: CompletionContext,
  match: { from: number; to: number; text: string },
  inner: string,
  hashIndex: number
): Promise<CompletionResult | null> {
  const beforeHash = inner.slice(0, hashIndex);
  const nodeId = beforeHash.split(",")[0].trim();
  if (!nodeId) return null;

  const afterHash = inner.slice(hashIndex + 1);
  const sectionQuery = afterHash.split(",")[0].trim().toLowerCase();

  let sections: Section[];
  try {
    const response = await getNoteSections(nodeId);
    sections = response.sections.map(s => ({ level: s.level, title: s.title, anchor: s.id }));
  } catch {
    return null;
  }

  const noteTitle = beforeHash.includes(",")
    ? beforeHash.split(",").slice(1).join(",").trim()
    : nodeId;

  const filtered = sectionQuery
    ? sections.filter(
        (s) =>
          s.title.toLowerCase().includes(sectionQuery) ||
          s.anchor.includes(sectionQuery)
      )
    : sections;

  if (filtered.length === 0) return null;

  const sectionFrom = match.from + 2 + hashIndex + 1;
  const xrefStart = match.from;

  return {
    from: sectionFrom,
    options: filtered.map((section) => {
      const indent = "  ".repeat(Math.max(0, section.level - 2));
      return {
        label: `${indent}${section.title}`,
        detail: `h${section.level}`,
        type: "property" as const,
        apply: (view: any, _completion: any, _from: number, to: number) => {
          const displayText = `${noteTitle} > ${section.title}`;
          const text = `<<${nodeId}#${section.anchor},${displayText}>>`;
          let end = to;
          const after = view.state.sliceDoc(to, to + 2);
          if (after === ">>") {
            end = to + 2;
          }
          view.dispatch({
            changes: { from: xrefStart, to: end, insert: text },
            selection: { anchor: xrefStart + text.length },
          });
        },
      };
    }),
    validFor: /^[^>,]*/,
  };
}

/**
 * Explicitly trigger completion when the user types `<<`.
 */
const wikiLinkTrigger = EditorView.inputHandler.of((view, from, _to, text) => {
  if (text === "<") {
    const charBefore = from > 0 ? view.state.sliceDoc(from - 1, from) : "";
    if (charBefore === "<") {
      setTimeout(() => startCompletion(view), 0);
    }
  }
  // Trigger attribute autocomplete on {
  if (text === "{") {
    setTimeout(() => startCompletion(view), 0);
  }
  // Also trigger on # inside a <<...>> xref for section completion
  if (text === "#") {
    const lineBefore = view.state.sliceDoc(
      view.state.doc.lineAt(from).from,
      from
    );
    if (/<<[^>]*$/.test(lineBefore)) {
      setTimeout(() => startCompletion(view), 0);
    }
  }
  return false;
});

/**
 * Export the complete wiki-link autocomplete extension.
 */
export function wikiLinkCompletion(additionalSources: Array<(ctx: CompletionContext) => CompletionResult | null | Promise<CompletionResult | null>> = []) {
  return [
    autocompletion({
      override: [wikiLinkCompletionSource, ...additionalSources],
      activateOnTyping: true,
      icons: true,
    }),
    keymap.of([
      ...completionKeymap,
      // Accept completion with Right arrow
      { key: "ArrowRight", run: (view: EditorView) => {
        if (completionStatus(view.state) !== null) return acceptCompletion(view);
        return false;
      }},
      // Navigate completion with Tab (down) / Shift-Tab (up) — only when completion is open
      { key: "Tab", run: (view: EditorView) => {
        if (completionStatus(view.state) !== null) return moveCompletionSelection(true)(view);
        return false;
      }},
      { key: "Shift-Tab", run: (view: EditorView) => {
        if (completionStatus(view.state) !== null) return moveCompletionSelection(false)(view);
        return false;
      }},
    ]),
    wikiLinkTrigger,
  ];
}
