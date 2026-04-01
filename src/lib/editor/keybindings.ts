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

function indentListItem(view: any): boolean {
  const { from } = view.state.selection.main;
  const line = view.state.doc.lineAt(from);
  const text = line.text;

  // Match bullet list: * or ** or *** etc.
  const bulletMatch = text.match(/^(\s*)(\*+)(\s(?:\[[ x]\]\s)?)(.*)/);
  if (bulletMatch) {
    const [, indent, stars, rest, content] = bulletMatch;
    const newLine = indent + stars + "*" + rest + content;
    view.dispatch({
      changes: { from: line.from, to: line.to, insert: newLine },
      selection: { anchor: from + 1 },
    });
    return true;
  }

  // Match numbered list: . or .. or ... etc.
  const numberedMatch = text.match(/^(\s*)(\.+)(\s)(.*)/);
  if (numberedMatch) {
    const [, indent, dots, space, content] = numberedMatch;
    const newLine = indent + dots + "." + space + content;
    view.dispatch({
      changes: { from: line.from, to: line.to, insert: newLine },
      selection: { anchor: from + 1 },
    });
    return true;
  }

  return false;
}

function dedentListItem(view: any): boolean {
  const { from } = view.state.selection.main;
  const line = view.state.doc.lineAt(from);
  const text = line.text;

  // Match bullet list with 2+ stars: ** or *** etc.
  const deepBulletMatch = text.match(/^(\s*)(\*{2,})(\s(?:\[[ x]\]\s)?)(.*)/);
  if (deepBulletMatch) {
    const [, indent, stars, rest, content] = deepBulletMatch;
    const newLine = indent + stars.slice(1) + rest + content;
    view.dispatch({
      changes: { from: line.from, to: line.to, insert: newLine },
      selection: { anchor: Math.max(line.from, from - 1) },
    });
    return true;
  }

  // Match single bullet: *
  const singleBulletMatch = text.match(/^(\s*)\*(\s(?:\[[ x]\]\s)?)(.*)/);
  if (singleBulletMatch) {
    const [, indent, , content] = singleBulletMatch;
    const newLine = indent + content;
    const cursorPos = line.from + newLine.length;
    view.dispatch({
      changes: { from: line.from, to: line.to, insert: newLine },
      selection: { anchor: Math.min(cursorPos, line.from + newLine.length) },
    });
    return true;
  }

  // Match numbered list with 2+ dots: .. or ... etc.
  const deepNumberedMatch = text.match(/^(\s*)(\.{2,})(\s)(.*)/);
  if (deepNumberedMatch) {
    const [, indent, dots, space, content] = deepNumberedMatch;
    const newLine = indent + dots.slice(1) + space + content;
    view.dispatch({
      changes: { from: line.from, to: line.to, insert: newLine },
      selection: { anchor: Math.max(line.from, from - 1) },
    });
    return true;
  }

  // Match single numbered: .
  const singleNumberedMatch = text.match(/^(\s*)\.(\s)(.*)/);
  if (singleNumberedMatch) {
    const [, indent, , content] = singleNumberedMatch;
    const newLine = indent + content;
    view.dispatch({
      changes: { from: line.from, to: line.to, insert: newLine },
      selection: { anchor: line.from + newLine.length },
    });
    return true;
  }

  return false;
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
