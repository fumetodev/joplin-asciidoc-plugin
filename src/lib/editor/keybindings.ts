import { type KeyBinding, EditorView } from "@codemirror/view";
import { deleteGroupBackward, deleteGroupForward } from "@codemirror/commands";

function wrapSelection(view: any, before: string, after: string) {
  const { from, to } = view.state.selection.main;
  const selected = view.state.sliceDoc(from, to);

  // Toggle: if selected text is already wrapped, unwrap it
  if (selected.startsWith(before) && selected.endsWith(after) && selected.length >= before.length + after.length) {
    const inner = selected.slice(before.length, selected.length - after.length);
    view.dispatch({
      changes: { from, to, insert: inner },
      selection: { anchor: from, head: from + inner.length },
    });
    return true;
  }

  // Toggle: if the characters around the selection are the markers, remove them
  const charsBefore = view.state.sliceDoc(from - before.length, from);
  const charsAfter = view.state.sliceDoc(to, to + after.length);
  if (charsBefore === before && charsAfter === after) {
    view.dispatch({
      changes: [
        { from: from - before.length, to: from, insert: "" },
        { from: to, to: to + after.length, insert: "" },
      ],
      selection: { anchor: from - before.length, head: to - before.length },
    });
    return true;
  }

  // Otherwise, wrap the selection
  view.dispatch({
    changes: { from, to, insert: before + selected + after },
    selection: { anchor: from + before.length, head: to + before.length },
  });
  return true;
}

function insertAtCursor(view: any, text: string) {
  const { from } = view.state.selection.main;
  view.dispatch({
    changes: { from, insert: text },
    selection: { anchor: from + text.length },
  });
  return true;
}

function indentSingleLine(text: string): string | null {
  // Match bullet list: * or ** or *** etc.
  const bulletMatch = text.match(/^(\s*)(\*+)(\s(?:\[[ x]\]\s)?)(.*)/);
  if (bulletMatch) {
    const [, indent, stars, rest, content] = bulletMatch;
    return indent + stars + "*" + rest + content;
  }
  // Match numbered list: . or .. or ... etc.
  const numberedMatch = text.match(/^(\s*)(\.+)(\s)(.*)/);
  if (numberedMatch) {
    const [, indent, dots, space, content] = numberedMatch;
    return indent + dots + "." + space + content;
  }
  return null;
}

function dedentSingleLine(text: string): string | null {
  // Match bullet list with 2+ stars: ** or *** etc.
  const deepBulletMatch = text.match(/^(\s*)(\*{2,})(\s(?:\[[ x]\]\s)?)(.*)/);
  if (deepBulletMatch) {
    const [, indent, stars, rest, content] = deepBulletMatch;
    return indent + stars.slice(1) + rest + content;
  }
  // Match single bullet: *
  const singleBulletMatch = text.match(/^(\s*)\*(\s(?:\[[ x]\]\s)?)(.*)/);
  if (singleBulletMatch) {
    const [, indent, , content] = singleBulletMatch;
    return indent + content;
  }
  // Match numbered list with 2+ dots: .. or ... etc.
  const deepNumberedMatch = text.match(/^(\s*)(\.{2,})(\s)(.*)/);
  if (deepNumberedMatch) {
    const [, indent, dots, space, content] = deepNumberedMatch;
    return indent + dots.slice(1) + space + content;
  }
  // Match single numbered: .
  const singleNumberedMatch = text.match(/^(\s*)\.(\s)(.*)/);
  if (singleNumberedMatch) {
    const [, indent, , content] = singleNumberedMatch;
    return indent + content;
  }
  return null;
}

function indentListItem(view: any): boolean {
  const sel = view.state.selection.main;
  const startLine = view.state.doc.lineAt(sel.from);
  const endLine = view.state.doc.lineAt(sel.to);

  // Multi-line selection: indent all list lines, preserve selection range
  if (startLine.number !== endLine.number) {
    const changes: Array<{ from: number; to: number; insert: string }> = [];
    for (let ln = startLine.number; ln <= endLine.number; ln++) {
      const line = view.state.doc.line(ln);
      const newText = indentSingleLine(line.text);
      if (newText != null) {
        changes.push({ from: line.from, to: line.to, insert: newText });
      }
    }
    if (changes.length === 0) return false;
    // Compute new selection: adjust anchor/head by cumulative length changes
    let newFrom = sel.from;
    let newTo = sel.to;
    let offset = 0;
    for (const ch of changes) {
      const delta = ch.insert.length - (ch.to - ch.from);
      if (ch.from < sel.from) newFrom += delta;
      newTo += delta;
      offset += delta;
    }
    view.dispatch({
      changes,
      selection: { anchor: newFrom, head: newTo },
    });
    return true;
  }

  // Single line
  const newText = indentSingleLine(startLine.text);
  if (newText == null) return false;
  view.dispatch({
    changes: { from: startLine.from, to: startLine.to, insert: newText },
    selection: { anchor: sel.from + 1 },
  });
  return true;
}

function dedentListItem(view: any): boolean {
  const sel = view.state.selection.main;
  const startLine = view.state.doc.lineAt(sel.from);
  const endLine = view.state.doc.lineAt(sel.to);

  // Multi-line selection: dedent all list lines, preserve selection range
  if (startLine.number !== endLine.number) {
    const changes: Array<{ from: number; to: number; insert: string }> = [];
    for (let ln = startLine.number; ln <= endLine.number; ln++) {
      const line = view.state.doc.line(ln);
      const newText = dedentSingleLine(line.text);
      if (newText != null) {
        changes.push({ from: line.from, to: line.to, insert: newText });
      }
    }
    if (changes.length === 0) return false;
    let newFrom = sel.from;
    let newTo = sel.to;
    for (const ch of changes) {
      const delta = ch.insert.length - (ch.to - ch.from);
      if (ch.from < sel.from) newFrom += delta;
      newTo += delta;
    }
    view.dispatch({
      changes,
      selection: { anchor: newFrom, head: newTo },
    });
    return true;
  }

  // Single line
  const newText = dedentSingleLine(startLine.text);
  if (newText == null) return false;
  const delta = newText.length - startLine.text.length;
  view.dispatch({
    changes: { from: startLine.from, to: startLine.to, insert: newText },
    selection: { anchor: Math.max(startLine.from, sel.from + delta) },
  });
  return true;
}

export const asciidocKeymap: KeyBinding[] = [
  {
    key: "Tab",
    run: (view) => indentListItem(view),
  },
  {
    key: "Shift-Tab",
    run: (view) => dedentListItem(view),
  },
  {
    key: "Mod-b",
    run: (view) => wrapSelection(view, "*", "*"),
  },
  {
    key: "Mod-i",
    run: (view) => wrapSelection(view, "_", "_"),
  },
  {
    key: "Mod-u",
    run: (view) => wrapSelection(view, "[.underline]#", "#"),
  },
  {
    key: "Mod-`",
    run: (view) => wrapSelection(view, "`", "`"),
  },
  {
    key: "Mod-Shift-x",
    run: (view) => wrapSelection(view, "[.line-through]#", "#"),
  },
  {
    key: "Mod-.",
    run: (view) => wrapSelection(view, "^", "^"),
  },
  {
    key: "Mod-,",
    run: (view) => wrapSelection(view, "~", "~"),
  },
  {
    key: "Mod-/",
    run: () => {
      window.dispatchEvent(new CustomEvent("editor-command", {
        detail: { type: "prefix", text: "// " },
      }));
      return true;
    },
  },
  {
    key: "Alt-Backspace",
    run: deleteGroupBackward,
  },
  {
    key: "Alt-Delete",
    run: deleteGroupForward,
  },
  {
    key: "Mod-s",
    run: () => {
      // Dispatch force-save event instead of calling editor store
      window.dispatchEvent(new CustomEvent("force-save"));
      return true;
    },
  },
  {
    // Auto-continue lists on Enter
    key: "Enter",
    run: (view) => {
      const { from } = view.state.selection.main;
      const line = view.state.doc.lineAt(from);
      const text = line.text;

      // Match checklist: * [ ] or * [x] (any nesting level)
      const checkMatch = text.match(/^(\s*\*+\s)\[[ x]\]\s/);
      // Match bullet list: * or ** etc.
      const bulletMatch = text.match(/^(\s*\*+\s)/);
      // Match numbered list: . or .. etc.
      const numberedMatch = text.match(/^(\s*\.+\s)/);

      let continuation = "";
      let marker = "";
      if (checkMatch) {
        continuation = checkMatch[1] + "[ ] ";
        marker = continuation;
      } else if (bulletMatch) {
        continuation = bulletMatch[1];
        marker = continuation;
      } else if (numberedMatch) {
        continuation = numberedMatch[1];
        marker = continuation;
      }

      if (continuation) {
        const markerPattern = checkMatch
          ? /^(\s*\*+\s)\[[ x]\]\s/
          : bulletMatch
            ? /^(\s*\*+\s)/
            : /^(\s*\.+\s)/;
        const fullMarker = text.match(markerPattern)?.[0] || "";
        const contentAfterMarker = text.slice(fullMarker.length).trim();

        if (contentAfterMarker) {
          const newAnchor = from + 1 + continuation.length;
          view.dispatch({
            changes: { from, insert: "\n" + continuation },
            selection: { anchor: newAnchor },
          });
          // Scroll after decorations have settled
          requestAnimationFrame(() => {
            view.dispatch({ effects: EditorView.scrollIntoView(view.state.selection.main.head) });
          });
          return true;
        } else {
          view.dispatch({
            changes: { from: line.from, to: line.to, insert: "" },
          });
          return true;
        }
      }

      return false;
    },
  },
];
