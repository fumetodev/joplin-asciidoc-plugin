// Shared toolbar action functions and data arrays
import { type ImageInsertOptions, serializeImageBlock } from "../utils/image-macro";

/** Svelte action: repositions a dropdown to stay within the viewport */
export function positionDropdown(node: HTMLElement) {
  // Reset any previous adjustments
  node.style.left = "";
  node.style.right = "";
  node.style.top = "";
  node.style.bottom = "";
  node.style.maxHeight = "";
  node.style.maxWidth = "";

  // Wait for layout
  requestAnimationFrame(() => {
    const rect = node.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const pad = 8; // viewport padding

    // Horizontal: if overflowing right, shift left; if overflowing left, shift right
    if (rect.right > vw - pad) {
      node.style.left = "auto";
      node.style.right = "0";
      // Re-check after flip
      const r2 = node.getBoundingClientRect();
      if (r2.left < pad) {
        node.style.left = "0";
        node.style.right = "auto";
        node.style.maxWidth = `${vw - pad * 2}px`;
      }
    } else if (rect.left < pad) {
      node.style.left = "0";
      node.style.right = "auto";
    }

    // Vertical: if overflowing bottom, cap max-height or flip upward
    const updatedRect = node.getBoundingClientRect();
    if (updatedRect.bottom > vh - pad) {
      const spaceBelow = vh - updatedRect.top - pad;
      const parent = node.closest(".split-btn-wrap") as HTMLElement;
      const parentRect = parent?.getBoundingClientRect();
      const spaceAbove = parentRect ? parentRect.top - pad : 0;

      if (spaceAbove > spaceBelow && spaceAbove > 120) {
        // Flip upward
        node.style.top = "auto";
        node.style.bottom = "100%";
        node.style.marginTop = "0";
        (node.style as any).marginBottom = "2px";
        if (updatedRect.height > spaceAbove) {
          node.style.maxHeight = `${spaceAbove}px`;
        }
      } else {
        // Cap height to available space below
        node.style.maxHeight = `${Math.max(spaceBelow, 120)}px`;
      }
    }
  });
}

export function wrapSelection(before: string, after: string) {
  window.dispatchEvent(new CustomEvent("editor-command", {
    detail: { type: "wrap", before, after },
  }));
}

export function insertText(text: string, cursorOffset?: number, selectFrom?: number, selectTo?: number) {
  window.dispatchEvent(new CustomEvent("editor-command", {
    detail: { type: "insert", text, cursorOffset, selectFrom, selectTo },
  }));
}

export function prefixLine(text: string) {
  window.dispatchEvent(new CustomEvent("editor-command", {
    detail: { type: "prefix", text },
  }));
}

export function suffixLine(text: string) {
  window.dispatchEvent(new CustomEvent("editor-command", {
    detail: { type: "suffix", text },
  }));
}

export function transformSelection(transform: string) {
  window.dispatchEvent(new CustomEvent("editor-command", {
    detail: { type: "transform", transform },
  }));
}

export function handleAdmonition(type: string) {
  insertText(`\n${type}: `);
}

export const admonitionTypes = [
  { label: "Note", value: "NOTE" },
  { label: "Tip", value: "TIP" },
  { label: "Warning", value: "WARNING" },
  { label: "Caution", value: "CAUTION" },
  { label: "Important", value: "IMPORTANT" },
];

export const sourceLanguages = [
  "javascript", "typescript", "python", "rust", "java",
  "html", "css", "json", "bash", "sql", "go", "ruby",
];

export function handleSource(lang: string) {
  insertText(`\n[source,${lang}]\n----\n\n----\n`);
}

export function handleTable(rows: number, cols: number) {
  const header = "| " + Array.from({ length: cols }, (_, i) => `Header ${i + 1}`).join(" | ");
  const rowLines = Array.from({ length: rows }, () =>
    "| " + Array.from({ length: cols }, () => " ").join(" | ")
  ).join("\n");
  insertText(`\n|===\n${header}\n\n${rowLines}\n|===\n`);
}

export function handleImage(options: ImageInsertOptions) {
  const block = serializeImageBlock(options);
  if (!block) return;
  insertText(`\n${block}\n`);
}

export function handleLink(type: "external" | "wiki", url: string, text: string) {
  if (!url.trim()) return;
  if (type === "external") {
    const display = text.trim() || url.trim();
    insertText(`link:${url.trim()}[${display}]`);
  } else {
    const display = text.trim() || url.trim();
    insertText(`<<${url.trim()},${display}>>`);
  }
}

export function handleHeading(markup: string) {
  window.dispatchEvent(new CustomEvent("editor-command", {
    detail: { type: "heading", text: markup },
  }));
}

export const headingLevels = [
  { markup: "= ", label: "Document Title" },
  { markup: "== ", label: "Section" },
  { markup: "=== ", label: "Subsection" },
  { markup: "==== ", label: "Level 3" },
  { markup: "===== ", label: "Level 4" },
  { markup: "====== ", label: "Level 5" },
];

export function handleBlock(blockType: string) {
  const blocks: Record<string, string> = {
    sidebar: "\n****\n\n****\n",
    example: "\n====\n\n====\n",
    collapsible: "\n.Click to expand\n[%collapsible]\n====\n\n====\n",
    pagebreak: "\n<<<\n",
  };
  insertText(blocks[blockType] || "");
}

export function handleMath(type: "stem" | "latexmath" | "asciimath", block: boolean) {
  if (block) {
    const text = `\n[${type}]\n++++\n\n++++\n`;
    // Place cursor on the empty line between ++++ delimiters
    const cursorOffset = `\n[${type}]\n++++\n`.length;
    insertText(text, cursorOffset);
  } else {
    wrapSelection(`${type}:[`, `]`);
  }
}

export const mathNotations = [
  { label: "LaTeX Math (inline)", value: "latexmath" as const, block: false },
  { label: "AsciiMath (inline)", value: "asciimath" as const, block: false },
  { label: "Stem (inline, doc default)", value: "stem" as const, block: false },
  { label: "LaTeX Math (block)", value: "latexmath" as const, block: true },
  { label: "AsciiMath (block)", value: "asciimath" as const, block: true },
  { label: "Stem (block, doc default)", value: "stem" as const, block: true },
];

export function handleInline(macroType: string) {
  switch (macroType) {
    case "kbd": wrapSelection("kbd:[", "]"); break;
    case "btn": wrapSelection("btn:[", "]"); break;
    case "menu": insertText("menu:File[Save As]"); break;
    case "footnote": wrapSelection("footnote:[", "]"); break;
    case "anchor": insertText("[[anchor-id]]"); break;
    case "comment": prefixLine("// "); break;
  }
}

export function handleInclude(path: string, levelOffset: string, lines: string, tags: string) {
  if (!path.trim()) return;
  const attrs: string[] = [];
  if (levelOffset.trim()) attrs.push(`leveloffset=+${levelOffset.trim()}`);
  if (lines.trim()) attrs.push(`lines=${lines.trim()}`);
  if (tags.trim()) attrs.push(`tags=${tags.trim()}`);
  const attrStr = attrs.length ? attrs.join(",") : "";
  insertText(`\ninclude::${path.trim()}[${attrStr}]\n`);
}

// ── Mermaid diagram support ──

export const mermaidDiagramTypes = [
  { label: "Flowchart", value: "flowchart" },
  { label: "Sequence Diagram", value: "sequence" },
  { label: "Class Diagram", value: "classDiagram" },
  { label: "State Diagram", value: "stateDiagram" },
  { label: "ER Diagram", value: "erDiagram" },
  { label: "Gantt Chart", value: "gantt" },
  { label: "Pie Chart", value: "pie" },
  { label: "User Journey", value: "journey" },
  { label: "Git Graph", value: "gitGraph" },
  { label: "Mindmap", value: "mindmap" },
  { label: "Timeline", value: "timeline" },
  { label: "Quadrant Chart", value: "quadrant" },
  { label: "Sankey Diagram", value: "sankey" },
  { label: "XY Chart", value: "xychart" },
  { label: "Block Diagram", value: "block" },
  { label: "Packet Diagram", value: "packet" },
  { label: "Kanban Board", value: "kanban" },
  { label: "Architecture", value: "architecture" },
  { label: "C4 Context", value: "c4context" },
  { label: "C4 Container", value: "c4container" },
  { label: "C4 Component", value: "c4component" },
  { label: "C4 Deployment", value: "c4deployment" },
  { label: "Requirement Diagram", value: "requirement" },
  { label: "ZenUML", value: "zenuml" },
];

const mermaidTemplates: Record<string, string> = {
  flowchart: "flowchart LR\n    A[Start] --> B[Process] --> C[End]",
  sequence: "sequenceDiagram\n    Alice->>Bob: Hello\n    Bob-->>Alice: Hi",
  classDiagram: "classDiagram\n    class Animal {\n        +String name\n        +makeSound()\n    }",
  stateDiagram: "stateDiagram-v2\n    [*] --> Active\n    Active --> [*]",
  erDiagram: "erDiagram\n    CUSTOMER ||--o{ ORDER : places\n    ORDER ||--|{ LINE-ITEM : contains",
  gantt: "gantt\n    title Project\n    dateFormat YYYY-MM-DD\n    section Phase 1\n    Task 1: 2024-01-01, 30d",
  pie: 'pie title Favorite Pets\n    "Dogs" : 386\n    "Cats" : 85\n    "Fish" : 15',
  journey: "journey\n    title My Working Day\n    section Go to work\n      Make tea: 5: Me\n      Go upstairs: 3: Me",
  gitGraph: "gitGraph\n    commit\n    branch develop\n    commit\n    checkout main\n    merge develop",
  mindmap: "mindmap\n  root((Project))\n    Topic A\n      Subtopic 1\n    Topic B",
  timeline: "timeline\n    title History\n    2023 : Event A\n    2024 : Event B",
  quadrant: "quadrantChart\n    title Priorities\n    x-axis Low --> High\n    y-axis Low --> High\n    A: [0.3, 0.6]\n    B: [0.7, 0.8]",
  sankey: "sankey-beta\n\nSource,Target,Value\nA,X,5\nB,X,3",
  xychart: 'xychart-beta\n    title "Sales"\n    x-axis [Jan, Feb, Mar]\n    y-axis "Revenue" 0 --> 100\n    bar [30, 50, 80]',
  block: 'block-beta\n    columns 3\n    a["A"] b["B"] c["C"]',
  packet: 'packet-beta\n    0-15: "Header"\n    16-31: "Payload"',
  kanban: "kanban\n    Todo\n      Task 1\n    In Progress\n      Task 2\n    Done\n      Task 3",
  architecture: "architecture-beta\n    service api(server)[API]\n    service db(database)[Database]\n    api:R --> L:db",
  c4context: 'C4Context\n    title System Context\n    Person(user, "User")\n    System(system, "System")\n    Rel(user, system, "Uses")',
  c4container: 'C4Container\n    title Container\n    Container(web, "Web App")\n    Container(api, "API")',
  c4component: 'C4Component\n    title Components\n    Component(comp, "Component")',
  c4deployment: 'C4Deployment\n    title Deployment\n    Deployment_Node(node, "Server")',
  requirement: "requirementDiagram\n    requirement req1 {\n        id: 1\n        text: The system shall...\n    }",
  zenuml: "zenuml\n    Alice->Bob: Hello\n    Bob->Alice: Hi",
};

export function handleMermaid(diagramType: string) {
  const template = mermaidTemplates[diagramType] || "flowchart LR\n    A --> B";
  insertText(`\n[mermaid]\n----\n${template}\n----\n`);
}

export interface ToolbarItem {
  id: string;
  label: string;
  title: string;
  icon: string;
  action: () => void;
  hasSplit?: boolean;
  splitId?: string;
}

export const formattingItems: ToolbarItem[] = [
  { id: "bold", label: "Bold", title: "Bold (Cmd+B)", icon: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 4h8a4 4 0 0 1 4 4 4 4 0 0 1-4 4H6z"/><path d="M6 12h9a4 4 0 0 1 4 4 4 4 0 0 1-4 4H6z"/></svg>`, action: () => wrapSelection("*", "*") },
  { id: "italic", label: "Italic", title: "Italic (Cmd+I)", icon: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="19" y1="4" x2="10" y2="4"/><line x1="14" y1="20" x2="5" y2="20"/><line x1="15" y1="4" x2="9" y2="20"/></svg>`, action: () => wrapSelection("_", "_") },
  { id: "underline", label: "Underline", title: "Underline (Cmd+U)", icon: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 4v6a6 6 0 0 0 12 0V4"/><line x1="4" y1="20" x2="20" y2="20"/></svg>`, action: () => wrapSelection("[.underline]#", "#") },
  { id: "mono", label: "Mono", title: "Monospace (Cmd+\`)", icon: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>`, action: () => wrapSelection("\`", "\`") },
  { id: "strike", label: "Strike", title: "Strikethrough", icon: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 4H9a3 3 0 0 0-3 3c0 1.4.8 2.6 2 3.2"/><path d="M12 12h5c1.7.6 3 2 3 3.5a3.5 3.5 0 0 1-3.5 3.5H8"/><line x1="3" y1="12" x2="21" y2="12"/></svg>`, action: () => wrapSelection("[.line-through]#", "#") },
  { id: "super", label: "Super", title: "Superscript (Cmd+.)", icon: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m4 19 8-8"/><path d="m12 19-8-8"/><path d="M20 12h-4c0-1.5.4-2 1.3-2.5C18.1 9 19 8.3 19 7a2 2 0 0 0-4 0"/></svg>`, action: () => wrapSelection("^", "^") },
  { id: "sub", label: "Sub", title: "Subscript (Cmd+,)", icon: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m4 5 8 8"/><path d="m12 5-8 8"/><path d="M20 19h-4c0-1.5.4-2 1.3-2.5C18.1 16 19 15.3 19 14a2 2 0 0 0-4 0"/></svg>`, action: () => wrapSelection("~", "~") },
];

export const structureItems: ToolbarItem[] = [
  { id: "admonition", label: "Admonition", title: "Admonition", icon: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>`, action: () => handleAdmonition("NOTE"), hasSplit: true, splitId: "admonition" },
  { id: "source", label: "Source", title: "Source Block", icon: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><path d="m10 13-2 2 2 2"/><path d="m14 17 2-2-2-2"/></svg>`, action: () => handleSource("javascript"), hasSplit: true, splitId: "source" },
  { id: "table", label: "Table", title: "Table", icon: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="3" y1="15" x2="21" y2="15"/><line x1="9" y1="3" x2="9" y2="21"/><line x1="15" y1="3" x2="15" y2="21"/></svg>`, action: () => handleTable(3, 3), hasSplit: true, splitId: "table" },
  { id: "blocks", label: "Block", title: "Content Block", icon: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" stroke-dasharray="4 2"/></svg>`, action: () => handleBlock("sidebar"), hasSplit: true, splitId: "blocks" },
];

export const listItems: ToolbarItem[] = [
  { id: "bullet", label: "Bullet", title: "Bullet List", icon: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><circle cx="4" cy="6" r="1" fill="currentColor"/><circle cx="4" cy="12" r="1" fill="currentColor"/><circle cx="4" cy="18" r="1" fill="currentColor"/></svg>`, action: () => insertText("\n* Item 1\n", undefined, 3, 9) },
  { id: "numbered", label: "Numbered", title: "Numbered List", icon: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="10" y1="6" x2="21" y2="6"/><line x1="10" y1="12" x2="21" y2="12"/><line x1="10" y1="18" x2="21" y2="18"/><text x="2" y="8" font-size="7" fill="currentColor" stroke="none" font-weight="600">1</text><text x="2" y="14" font-size="7" fill="currentColor" stroke="none" font-weight="600">2</text><text x="2" y="20" font-size="7" fill="currentColor" stroke="none" font-weight="600">3</text></svg>`, action: () => insertText("\n. First\n", undefined, 3, 8) },
  { id: "checklist", label: "Checklist", title: "Checklist", icon: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="6" height="6" rx="1"/><path d="m3 17 2 2 4-4"/><line x1="13" y1="6" x2="21" y2="6"/><line x1="13" y1="12" x2="21" y2="12"/><line x1="13" y1="18" x2="21" y2="18"/></svg>`, action: () => insertText("\n* [ ] Task 1\n", undefined, 7, 13) },
  { id: "deflist", label: "Def List", title: "Definition List", icon: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="3" y1="6" x2="12" y2="6"/><line x1="7" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="12" y2="18"/><circle cx="15" cy="6" r="1" fill="currentColor" stroke="none"/></svg>`, action: () => insertText("\nTerm:: Definition\n") },
];

export const contentItems: ToolbarItem[] = [
  { id: "quote", label: "Quote", title: "Block Quote", icon: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 21c3 0 7-1 7-8V5c0-1.25-.76-2.01-2-2H4c-1.25 0-2 .76-2 2v6c0 1.25.76 2 2 2h4c0 5-4 6-7 6z"/><path d="M15 21c3 0 7-1 7-8V5c0-1.25-.76-2.01-2-2h-4c-1.25 0-2 .76-2 2v6c0 1.25.76 2 2 2h4c0 5-4 6-7 6z"/></svg>`, action: () => insertText("\n[quote, Author]\n____\nQuote text here.\n____\n") },
  { id: "hr", label: "Rule", title: "Horizontal Rule", icon: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="3" y1="12" x2="21" y2="12"/></svg>`, action: () => insertText("\n'''\n") },
];

export const mediaItems: ToolbarItem[] = [
  { id: "image", label: "Image", title: "Image", icon: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>`, action: () => {}, hasSplit: true, splitId: "image" },
  { id: "link", label: "Link", title: "Link", icon: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>`, action: () => {}, hasSplit: true, splitId: "link" },
  { id: "template", label: "Template", title: "Template", icon: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><path d="M9 15l3-3 3 3"/><line x1="12" y1="12" x2="12" y2="18"/></svg>`, action: () => {}, hasSplit: true, splitId: "template" },
];

export const fontColors = [
  { name: "Red", value: "red", hex: "#e74c3c" },
  { name: "Blue", value: "blue", hex: "#2980b9" },
  { name: "Green", value: "green", hex: "#27ae60" },
  { name: "Purple", value: "purple", hex: "#8e44ad" },
  { name: "Orange", value: "orange", hex: "#e67e22" },
  { name: "Teal", value: "teal", hex: "#16a085" },
  { name: "Maroon", value: "maroon", hex: "#7a2518" },
  { name: "Navy", value: "navy", hex: "#1a237e" },
];

export const highlightColors = [
  { name: "Yellow", value: "yellow", hex: "#fff176" },
  { name: "Lime", value: "lime", hex: "#c5e1a5" },
  { name: "Aqua", value: "aqua", hex: "#80deea" },
  { name: "Pink", value: "pink", hex: "#f48fb1" },
  { name: "Orange", value: "orange", hex: "#ffcc80" },
  { name: "Silver", value: "silver", hex: "#cfd8dc" },
  { name: "Red", value: "red", hex: "#ef9a9a" },
  { name: "Purple", value: "purple", hex: "#ce93d8" },
];

export function handleFontColor(color: string) {
  if (!color) {
    // Remove color — just wrap with unconstrained formatting
    wrapSelection("#", "#");
  } else {
    wrapSelection(`[.${color}]#`, "#");
  }
}

export function handleHighlight(color: string) {
  if (!color) {
    window.dispatchEvent(new CustomEvent("editor-command", {
      detail: { type: "remove-highlight" },
    }));
  } else {
    wrapSelection(`[.${color}-background]#`, "#");
  }
}

export interface SymbolItem {
  char: string;
  label: string;
  insert: string;
}

export interface SymbolCategory {
  name: string;
  items: SymbolItem[];
}

export const symbolCategories: SymbolCategory[] = [
  { name: "AsciiDoc", items: [
    { char: "\u00A9", label: "Copyright", insert: "(C)" },
    { char: "\u00AE", label: "Registered", insert: "(R)" },
    { char: "\u2122", label: "Trademark", insert: "(TM)" },
    { char: "\u2014", label: "Em Dash", insert: " -- " },
    { char: "\u2026", label: "Ellipsis", insert: "..." },
    { char: "\u2192", label: "Right Arrow", insert: "->" },
    { char: "\u2190", label: "Left Arrow", insert: "<-" },
    { char: "\u21D2", label: "Double Right Arrow", insert: "=>" },
    { char: "\u21D0", label: "Double Left Arrow", insert: "<=" },
    { char: "\u00A6", label: "Pipe (in tables)", insert: "{vbar}" },
    { char: "&", label: "Ampersand", insert: "{amp}" },
    { char: "<", label: "Less Than", insert: "{lt}" },
    { char: ">", label: "Greater Than", insert: "{gt}" },
    { char: "\u2713", label: "Check (attribute)", insert: "{startsb}{zwsp}x{endsb}" },
    { char: "\u25A1", label: "Unchecked (attribute)", insert: "{startsb}{zwsp}{endsb}" },
    { char: "[", label: "Left Square Bracket", insert: "{startsb}" },
    { char: "]", label: "Right Square Bracket", insert: "{endsb}" },
    { char: "\u2014", label: "Em Dash (attribute)", insert: "{mdash}" },
    { char: "\u2013", label: "En Dash (attribute)", insert: "{ndash}" },
  ]},
  { name: "Whitespace", items: [
    { char: "nb", label: "Non-Breaking Space", insert: "{nbsp}" },
    { char: "zw", label: "Zero-Width Space", insert: "{zwsp}" },
    { char: "em", label: "Em Space", insert: "{emsp}" },
    { char: "en", label: "En Space", insert: "{ensp}" },
    { char: "th", label: "Thin Space", insert: "{thinsp}" },
    { char: "bl", label: "Blank", insert: "{blank}" },
    { char: "wj", label: "Word Joiner", insert: "{wj}" },
    { char: "sh", label: "Soft Hyphen", insert: "{shy}" },
  ]},
  { name: "Punctuation", items: [
    { char: "\u2013", label: "En Dash", insert: "&#8211;" },
    { char: "\u2015", label: "Horizontal Bar", insert: "&#8213;" },
    { char: "\u2018", label: "Left Single Quote", insert: "&#8216;" },
    { char: "\u2019", label: "Right Single Quote", insert: "&#8217;" },
    { char: "\u201A", label: "Single Low-9 Quote", insert: "&#8218;" },
    { char: "\u201C", label: "Left Double Quote", insert: "&#8220;" },
    { char: "\u201D", label: "Right Double Quote", insert: "&#8221;" },
    { char: "\u201E", label: "Double Low-9 Quote", insert: "&#8222;" },
    { char: "\u00AB", label: "Left Guillemet", insert: "&#171;" },
    { char: "\u00BB", label: "Right Guillemet", insert: "&#187;" },
    { char: "\u2039", label: "Left Single Guillemet", insert: "&#8249;" },
    { char: "\u203A", label: "Right Single Guillemet", insert: "&#8250;" },
    { char: "\u2022", label: "Bullet", insert: "&#8226;" },
    { char: "\u25E6", label: "White Bullet", insert: "&#9702;" },
    { char: "\u2023", label: "Triangle Bullet", insert: "&#8227;" },
    { char: "\u00B7", label: "Middle Dot", insert: "&#183;" },
    { char: "\u2020", label: "Dagger", insert: "&#8224;" },
    { char: "\u2021", label: "Double Dagger", insert: "&#8225;" },
    { char: "\u00A6", label: "Broken Bar", insert: "&#166;" },
    { char: "\u00BF", label: "Inverted Question", insert: "&#191;" },
    { char: "\u00A1", label: "Inverted Exclamation", insert: "&#161;" },
    { char: "\u2026", label: "Horizontal Ellipsis", insert: "&#8230;" },
    { char: "\u22EE", label: "Vertical Ellipsis", insert: "&#8942;" },
    { char: "\u22EF", label: "Midline Ellipsis", insert: "&#8943;" },
    { char: "\u203D", label: "Interrobang", insert: "&#8253;" },
    { char: "\u2042", label: "Asterism", insert: "&#8258;" },
    { char: "\u203B", label: "Reference Mark", insert: "&#8251;" },
    { char: "\u2011", label: "Non-Breaking Hyphen", insert: "&#8209;" },
    { char: "\u2043", label: "Hyphen Bullet", insert: "&#8259;" },
    { char: "\u204B", label: "Reversed Pilcrow", insert: "&#8267;" },
    { char: "\u2027", label: "Hyphenation Point", insert: "&#8231;" },
    { char: "\u2016", label: "Double Vertical Line", insert: "&#8214;" },
    { char: "\u204A", label: "Tironian Et", insert: "&#8266;" },
    { char: "\u2032", label: "Prime", insert: "&#8242;" },
    { char: "\u2033", label: "Double Prime", insert: "&#8243;" },
    { char: "\u2034", label: "Triple Prime", insert: "&#8244;" },
  ]},
  { name: "Math", items: [
    { char: "\u00B1", label: "Plus-Minus", insert: "&#177;" },
    { char: "\u2213", label: "Minus-Plus", insert: "&#8723;" },
    { char: "\u00D7", label: "Multiply", insert: "&#215;" },
    { char: "\u00F7", label: "Divide", insert: "&#247;" },
    { char: "\u2260", label: "Not Equal", insert: "&#8800;" },
    { char: "\u2264", label: "Less or Equal", insert: "&#8804;" },
    { char: "\u2265", label: "Greater or Equal", insert: "&#8805;" },
    { char: "\u226A", label: "Much Less Than", insert: "&#8810;" },
    { char: "\u226B", label: "Much Greater Than", insert: "&#8811;" },
    { char: "\u2248", label: "Almost Equal", insert: "&#8776;" },
    { char: "\u2261", label: "Identical", insert: "&#8801;" },
    { char: "\u2262", label: "Not Identical", insert: "&#8802;" },
    { char: "\u221D", label: "Proportional To", insert: "&#8733;" },
    { char: "\u221E", label: "Infinity", insert: "&#8734;" },
    { char: "\u221A", label: "Square Root", insert: "&#8730;" },
    { char: "\u221B", label: "Cube Root", insert: "&#8731;" },
    { char: "\u221C", label: "Fourth Root", insert: "&#8732;" },
    { char: "\u2211", label: "Summation", insert: "&#8721;" },
    { char: "\u220F", label: "Product", insert: "&#8719;" },
    { char: "\u222B", label: "Integral", insert: "&#8747;" },
    { char: "\u222C", label: "Double Integral", insert: "&#8748;" },
    { char: "\u222E", label: "Contour Integral", insert: "&#8750;" },
    { char: "\u2202", label: "Partial Differential", insert: "&#8706;" },
    { char: "\u2207", label: "Nabla/Del", insert: "&#8711;" },
    { char: "\u2206", label: "Increment", insert: "&#8710;" },
    { char: "\u2200", label: "For All", insert: "&#8704;" },
    { char: "\u2203", label: "There Exists", insert: "&#8707;" },
    { char: "\u2204", label: "Not Exists", insert: "&#8708;" },
    { char: "\u2205", label: "Empty Set", insert: "&#8709;" },
    { char: "\u2208", label: "Element Of", insert: "&#8712;" },
    { char: "\u2209", label: "Not Element Of", insert: "&#8713;" },
    { char: "\u2282", label: "Subset Of", insert: "&#8834;" },
    { char: "\u2283", label: "Superset Of", insert: "&#8835;" },
    { char: "\u2286", label: "Subset or Equal", insert: "&#8838;" },
    { char: "\u2287", label: "Superset or Equal", insert: "&#8839;" },
    { char: "\u222A", label: "Union", insert: "&#8746;" },
    { char: "\u2229", label: "Intersection", insert: "&#8745;" },
    { char: "\u2227", label: "Logical AND", insert: "&#8743;" },
    { char: "\u2228", label: "Logical OR", insert: "&#8744;" },
    { char: "\u00AC", label: "Logical NOT", insert: "&#172;" },
    { char: "\u2234", label: "Therefore", insert: "&#8756;" },
    { char: "\u2235", label: "Because", insert: "&#8757;" },
    { char: "\u00B2", label: "Squared", insert: "&#178;" },
    { char: "\u00B3", label: "Cubed", insert: "&#179;" },
    { char: "\u2074", label: "Superscript 4", insert: "&#8308;" },
    { char: "\u207F", label: "Superscript n", insert: "&#8319;" },
    { char: "\u00BC", label: "One Quarter", insert: "&#188;" },
    { char: "\u00BD", label: "One Half", insert: "&#189;" },
    { char: "\u00BE", label: "Three Quarters", insert: "&#190;" },
    { char: "\u2153", label: "One Third", insert: "&#8531;" },
    { char: "\u2154", label: "Two Thirds", insert: "&#8532;" },
    { char: "\u2155", label: "One Fifth", insert: "&#8533;" },
    { char: "\u215B", label: "One Eighth", insert: "&#8539;" },
    { char: "\u2030", label: "Per Mille", insert: "&#8240;" },
    { char: "\u2031", label: "Per Ten Thousand", insert: "&#8241;" },
    { char: "\u211D", label: "Real Numbers", insert: "&#8477;" },
    { char: "\u2124", label: "Integers", insert: "&#8484;" },
    { char: "\u2115", label: "Natural Numbers", insert: "&#8469;" },
    { char: "\u211A", label: "Rationals", insert: "&#8474;" },
    { char: "\u2102", label: "Complex Numbers", insert: "&#8450;" },
    { char: "\u2295", label: "Circled Plus", insert: "&#8853;" },
    { char: "\u2297", label: "Circled Times", insert: "&#8855;" },
    { char: "\u2296", label: "Circled Minus", insert: "&#8854;" },
    { char: "\u2298", label: "Circled Division", insert: "&#8856;" },
    { char: "\u2299", label: "Circled Dot", insert: "&#8857;" },
    { char: "\u229B", label: "Circled Asterisk", insert: "&#8859;" },
    { char: "\u2308", label: "Left Ceiling", insert: "&#8968;" },
    { char: "\u2309", label: "Right Ceiling", insert: "&#8969;" },
    { char: "\u230A", label: "Left Floor", insert: "&#8970;" },
    { char: "\u230B", label: "Right Floor", insert: "&#8971;" },
    { char: "\u27E8", label: "Left Angle Bracket", insert: "&#10216;" },
    { char: "\u27E9", label: "Right Angle Bracket", insert: "&#10217;" },
    { char: "\u2032", label: "Prime", insert: "&#8242;" },
    { char: "\u2033", label: "Double Prime", insert: "&#8243;" },
    { char: "\u2218", label: "Ring Operator", insert: "&#8728;" },
    { char: "\u22A2", label: "Right Tack", insert: "&#8866;" },
    { char: "\u22A3", label: "Left Tack", insert: "&#8867;" },
    { char: "\u22A4", label: "Down Tack (True)", insert: "&#8868;" },
    { char: "\u22A5", label: "Up Tack (False)", insert: "&#8869;" },
    { char: "\u2245", label: "Congruent", insert: "&#8773;" },
    { char: "\u2243", label: "Asymptotically Equal", insert: "&#8771;" },
    { char: "\u227A", label: "Precedes", insert: "&#8826;" },
    { char: "\u227B", label: "Succeeds", insert: "&#8827;" },
    { char: "\u2220", label: "Angle", insert: "&#8736;" },
    { char: "\u221F", label: "Right Angle", insert: "&#8735;" },
    { char: "\u2225", label: "Parallel", insert: "&#8741;" },
    { char: "\u0192", label: "Function", insert: "&#402;" },
  ]},
  { name: "Arrows", items: [
    { char: "\u2191", label: "Up Arrow", insert: "&#8593;" },
    { char: "\u2193", label: "Down Arrow", insert: "&#8595;" },
    { char: "\u2194", label: "Left-Right Arrow", insert: "&#8596;" },
    { char: "\u2195", label: "Up-Down Arrow", insert: "&#8597;" },
    { char: "\u2196", label: "NW Arrow", insert: "&#8598;" },
    { char: "\u2197", label: "NE Arrow", insert: "&#8599;" },
    { char: "\u2198", label: "SE Arrow", insert: "&#8600;" },
    { char: "\u2199", label: "SW Arrow", insert: "&#8601;" },
    { char: "\u21D1", label: "Double Up Arrow", insert: "&#8657;" },
    { char: "\u21D3", label: "Double Down Arrow", insert: "&#8659;" },
    { char: "\u21D4", label: "Double Left-Right", insert: "&#8660;" },
    { char: "\u21B5", label: "Return/Enter", insert: "&#8629;" },
    { char: "\u21B0", label: "Up With Tip Left", insert: "&#8624;" },
    { char: "\u21B1", label: "Up With Tip Right", insert: "&#8625;" },
    { char: "\u21B2", label: "Down Left Corner", insert: "&#8626;" },
    { char: "\u21B3", label: "Down Right Corner", insert: "&#8627;" },
    { char: "\u21B4", label: "Right Corner Down", insert: "&#8628;" },
    { char: "\u21BA", label: "Counterclockwise", insert: "&#8634;" },
    { char: "\u21BB", label: "Clockwise", insert: "&#8635;" },
    { char: "\u21B6", label: "CCW Semicircle", insert: "&#8630;" },
    { char: "\u21B7", label: "CW Semicircle", insert: "&#8631;" },
    { char: "\u21C4", label: "Right Over Left", insert: "&#8644;" },
    { char: "\u21C6", label: "Left Over Right", insert: "&#8646;" },
    { char: "\u21A9", label: "Left With Hook", insert: "&#8617;" },
    { char: "\u21AA", label: "Right With Hook", insert: "&#8618;" },
    { char: "\u219E", label: "Left Two-Head", insert: "&#8606;" },
    { char: "\u21A0", label: "Right Two-Head", insert: "&#8608;" },
    { char: "\u21E7", label: "Up White Arrow", insert: "&#8679;" },
    { char: "\u21E9", label: "Down White Arrow", insert: "&#8681;" },
    { char: "\u27F5", label: "Long Left Arrow", insert: "&#10229;" },
    { char: "\u27F6", label: "Long Right Arrow", insert: "&#10230;" },
    { char: "\u27F7", label: "Long Left-Right", insert: "&#10231;" },
    { char: "\u27F8", label: "Long Double Left", insert: "&#10232;" },
    { char: "\u27F9", label: "Long Double Right", insert: "&#10233;" },
    { char: "\u27FA", label: "Long Double LR", insert: "&#10234;" },
    { char: "\u27A1", label: "Black Right Arrow", insert: "&#10145;" },
    { char: "\u2B05", label: "Black Left Arrow", insert: "&#11013;" },
    { char: "\u2B06", label: "Black Up Arrow", insert: "&#11014;" },
    { char: "\u2B07", label: "Black Down Arrow", insert: "&#11015;" },
  ]},
  { name: "Currency", items: [
    { char: "$", label: "Dollar", insert: "$" },
    { char: "\u20AC", label: "Euro", insert: "&#8364;" },
    { char: "\u00A3", label: "Pound", insert: "&#163;" },
    { char: "\u00A5", label: "Yen/Yuan", insert: "&#165;" },
    { char: "\u00A2", label: "Cent", insert: "&#162;" },
    { char: "\u20B9", label: "Indian Rupee", insert: "&#8377;" },
    { char: "\u20A9", label: "Won", insert: "&#8361;" },
    { char: "\u20BD", label: "Ruble", insert: "&#8381;" },
    { char: "\u20BA", label: "Turkish Lira", insert: "&#8378;" },
    { char: "\u20B1", label: "Peso", insert: "&#8369;" },
    { char: "\u20BF", label: "Bitcoin", insert: "&#8383;" },
    { char: "\u20AB", label: "Dong", insert: "&#8363;" },
    { char: "\u20A8", label: "Rupee Sign", insert: "&#8360;" },
    { char: "\u0E3F", label: "Thai Baht", insert: "&#3647;" },
    { char: "\u20B4", label: "Hryvnia", insert: "&#8372;" },
    { char: "\u20AA", label: "Shekel", insert: "&#8362;" },
    { char: "\u20A3", label: "French Franc", insert: "&#8355;" },
    { char: "\u20A4", label: "Lira", insert: "&#8356;" },
    { char: "\u20A6", label: "Naira", insert: "&#8358;" },
    { char: "\u20A7", label: "Peseta", insert: "&#8359;" },
    { char: "\u20AE", label: "Tugrik", insert: "&#8366;" },
    { char: "\u20AF", label: "Drachma", insert: "&#8367;" },
    { char: "\u20B0", label: "German Penny", insert: "&#8368;" },
    { char: "\u20B2", label: "Guarani", insert: "&#8370;" },
    { char: "\u20B3", label: "Austral", insert: "&#8371;" },
    { char: "\u20B5", label: "Cedi", insert: "&#8373;" },
    { char: "\u20B8", label: "Tenge", insert: "&#8376;" },
    { char: "\u20BC", label: "Manat", insert: "&#8380;" },
    { char: "\u20BE", label: "Lari", insert: "&#8382;" },
    { char: "\u00A4", label: "Generic Currency", insert: "&#164;" },
  ]},
  { name: "Marks", items: [
    { char: "\u00A7", label: "Section", insert: "&#167;" },
    { char: "\u00B6", label: "Paragraph / Pilcrow", insert: "&#182;" },
    { char: "\u00B0", label: "Degree", insert: "&#176;" },
    { char: "\u2103", label: "Degree Celsius", insert: "&#8451;" },
    { char: "\u2109", label: "Degree Fahrenheit", insert: "&#8457;" },
    { char: "\u00B5", label: "Micro", insert: "&#181;" },
    { char: "\u2116", label: "Numero", insert: "&#8470;" },
    { char: "\u2117", label: "Sound Recording \u00A9", insert: "&#8471;" },
    { char: "\u2120", label: "Service Mark", insert: "&#8480;" },
    { char: "\u2605", label: "Black Star", insert: "&#9733;" },
    { char: "\u2606", label: "White Star", insert: "&#9734;" },
    { char: "\u2714", label: "Heavy Check", insert: "&#10004;" },
    { char: "\u2718", label: "Heavy Cross", insert: "&#10008;" },
    { char: "\u2713", label: "Check Mark", insert: "&#10003;" },
    { char: "\u2717", label: "Ballot X", insert: "&#10007;" },
    { char: "\u2764", label: "Heart", insert: "&#10084;" },
    { char: "\u2665", label: "Heart Suit", insert: "&#9829;" },
    { char: "\u2666", label: "Diamond Suit", insert: "&#9830;" },
    { char: "\u2663", label: "Club Suit", insert: "&#9827;" },
    { char: "\u2660", label: "Spade Suit", insert: "&#9824;" },
    { char: "\u266A", label: "Eighth Note", insert: "&#9834;" },
    { char: "\u266B", label: "Beamed Notes", insert: "&#9835;" },
    { char: "\u2602", label: "Umbrella", insert: "&#9730;" },
    { char: "\u2603", label: "Snowman", insert: "&#9731;" },
    { char: "\u2604", label: "Comet", insert: "&#9732;" },
    { char: "\u2615", label: "Hot Beverage", insert: "&#9749;" },
    { char: "\u2618", label: "Shamrock", insert: "&#9752;" },
    { char: "\u261E", label: "Pointing Right", insert: "&#9758;" },
    { char: "\u261C", label: "Pointing Left", insert: "&#9756;" },
    { char: "\u2622", label: "Radioactive", insert: "&#9762;" },
    { char: "\u2623", label: "Biohazard", insert: "&#9763;" },
    { char: "\u262E", label: "Peace", insert: "&#9774;" },
    { char: "\u262F", label: "Yin Yang", insert: "&#9775;" },
    { char: "\u2638", label: "Wheel of Dharma", insert: "&#9784;" },
    { char: "\u263A", label: "Smiley Face", insert: "&#9786;" },
    { char: "\u2640", label: "Female", insert: "&#9792;" },
    { char: "\u2642", label: "Male", insert: "&#9794;" },
    { char: "\u211E", label: "Prescription", insert: "&#8478;" },
    { char: "\u2696", label: "Balance Scale", insert: "&#9878;" },
    { char: "\u2318", label: "Command Key", insert: "&#8984;" },
    { char: "\u2325", label: "Option Key", insert: "&#8997;" },
    { char: "\u21E7", label: "Shift Key", insert: "&#8679;" },
    { char: "\u2303", label: "Control Key", insert: "&#8963;" },
    { char: "\u238B", label: "Escape Key", insert: "&#9099;" },
    { char: "\u23CE", label: "Return Key", insert: "&#9166;" },
    { char: "\u232B", label: "Backspace Key", insert: "&#9003;" },
    { char: "\u2326", label: "Forward Delete", insert: "&#8998;" },
    { char: "\u21E5", label: "Tab Key", insert: "&#8677;" },
    { char: "\u2610", label: "Ballot Box", insert: "&#9744;" },
    { char: "\u2611", label: "Ballot Check", insert: "&#9745;" },
    { char: "\u2612", label: "Ballot X Box", insert: "&#9746;" },
    { char: "\u2709", label: "Envelope", insert: "&#9993;" },
    { char: "\u270F", label: "Pencil", insert: "&#9999;" },
    { char: "\u2702", label: "Scissors", insert: "&#9986;" },
    { char: "\u2708", label: "Airplane", insert: "&#9992;" },
    { char: "\u260E", label: "Telephone", insert: "&#9742;" },
  ]},
  { name: "Shapes", items: [
    { char: "\u25A0", label: "Black Square", insert: "&#9632;" },
    { char: "\u25A1", label: "White Square", insert: "&#9633;" },
    { char: "\u25A2", label: "Rounded Square", insert: "&#9634;" },
    { char: "\u25AA", label: "Small Black Square", insert: "&#9642;" },
    { char: "\u25AB", label: "Small White Square", insert: "&#9643;" },
    { char: "\u25B2", label: "Black Up Triangle", insert: "&#9650;" },
    { char: "\u25B3", label: "White Up Triangle", insert: "&#9651;" },
    { char: "\u25BC", label: "Black Down Triangle", insert: "&#9660;" },
    { char: "\u25BD", label: "White Down Triangle", insert: "&#9661;" },
    { char: "\u25C0", label: "Black Left Triangle", insert: "&#9664;" },
    { char: "\u25C1", label: "White Left Triangle", insert: "&#9665;" },
    { char: "\u25B6", label: "Black Right Triangle", insert: "&#9654;" },
    { char: "\u25B7", label: "White Right Triangle", insert: "&#9655;" },
    { char: "\u25CB", label: "White Circle", insert: "&#9675;" },
    { char: "\u25CF", label: "Black Circle", insert: "&#9679;" },
    { char: "\u25D0", label: "Left Half Circle", insert: "&#9680;" },
    { char: "\u25D1", label: "Right Half Circle", insert: "&#9681;" },
    { char: "\u25C6", label: "Black Diamond", insert: "&#9670;" },
    { char: "\u25C7", label: "White Diamond", insert: "&#9671;" },
    { char: "\u25CA", label: "Lozenge", insert: "&#9674;" },
    { char: "\u25EF", label: "Large Circle", insert: "&#9711;" },
    { char: "\u2B1B", label: "Large Black Square", insert: "&#11035;" },
    { char: "\u2B1C", label: "Large White Square", insert: "&#11036;" },
    { char: "\u25C9", label: "Fisheye", insert: "&#9673;" },
    { char: "\u25CC", label: "Dotted Circle", insert: "&#9676;" },
    { char: "\u25CE", label: "Bullseye", insert: "&#9678;" },
    { char: "\u25C8", label: "Diamond in Diamond", insert: "&#9672;" },
    { char: "\u2500", label: "Light Horizontal", insert: "&#9472;" },
    { char: "\u2502", label: "Light Vertical", insert: "&#9474;" },
    { char: "\u250C", label: "Down and Right", insert: "&#9484;" },
    { char: "\u2510", label: "Down and Left", insert: "&#9488;" },
    { char: "\u2514", label: "Up and Right", insert: "&#9492;" },
    { char: "\u2518", label: "Up and Left", insert: "&#9496;" },
    { char: "\u251C", label: "Vertical and Right", insert: "&#9500;" },
    { char: "\u2524", label: "Vertical and Left", insert: "&#9508;" },
    { char: "\u252C", label: "Down and Horizontal", insert: "&#9516;" },
    { char: "\u2534", label: "Up and Horizontal", insert: "&#9524;" },
    { char: "\u253C", label: "Vertical and Horizontal", insert: "&#9532;" },
    { char: "\u2550", label: "Double Horizontal", insert: "&#9552;" },
    { char: "\u2551", label: "Double Vertical", insert: "&#9553;" },
    { char: "\u2554", label: "Double Down Right", insert: "&#9556;" },
    { char: "\u2557", label: "Double Down Left", insert: "&#9559;" },
    { char: "\u255A", label: "Double Up Right", insert: "&#9562;" },
    { char: "\u255D", label: "Double Up Left", insert: "&#9565;" },
    { char: "\u256D", label: "Rounded Down Right", insert: "&#9581;" },
    { char: "\u256E", label: "Rounded Down Left", insert: "&#9582;" },
    { char: "\u256F", label: "Rounded Up Left", insert: "&#9583;" },
    { char: "\u2570", label: "Rounded Up Right", insert: "&#9584;" },
    { char: "\u2726", label: "4-Pointed Star", insert: "&#10022;" },
    { char: "\u2727", label: "4-Pointed White Star", insert: "&#10023;" },
    { char: "\u272A", label: "Circled White Star", insert: "&#10026;" },
    { char: "\u2736", label: "6-Pointed Star", insert: "&#10038;" },
    { char: "\u2737", label: "8-Pointed Star", insert: "&#10039;" },
    { char: "\u2738", label: "Heavy 8-Pointed Star", insert: "&#10040;" },
  ]},
  { name: "Greek", items: [
    { char: "\u0391", label: "Alpha (upper)", insert: "&#913;" },
    { char: "\u03B1", label: "alpha", insert: "&#945;" },
    { char: "\u0392", label: "Beta (upper)", insert: "&#914;" },
    { char: "\u03B2", label: "beta", insert: "&#946;" },
    { char: "\u0393", label: "Gamma (upper)", insert: "&#915;" },
    { char: "\u03B3", label: "gamma", insert: "&#947;" },
    { char: "\u0394", label: "Delta (upper)", insert: "&#916;" },
    { char: "\u03B4", label: "delta", insert: "&#948;" },
    { char: "\u0395", label: "Epsilon (upper)", insert: "&#917;" },
    { char: "\u03B5", label: "epsilon", insert: "&#949;" },
    { char: "\u0396", label: "Zeta (upper)", insert: "&#918;" },
    { char: "\u03B6", label: "zeta", insert: "&#950;" },
    { char: "\u0397", label: "Eta (upper)", insert: "&#919;" },
    { char: "\u03B7", label: "eta", insert: "&#951;" },
    { char: "\u0398", label: "Theta (upper)", insert: "&#920;" },
    { char: "\u03B8", label: "theta", insert: "&#952;" },
    { char: "\u0399", label: "Iota (upper)", insert: "&#921;" },
    { char: "\u03B9", label: "iota", insert: "&#953;" },
    { char: "\u039A", label: "Kappa (upper)", insert: "&#922;" },
    { char: "\u03BA", label: "kappa", insert: "&#954;" },
    { char: "\u039B", label: "Lambda (upper)", insert: "&#923;" },
    { char: "\u03BB", label: "lambda", insert: "&#955;" },
    { char: "\u039C", label: "Mu (upper)", insert: "&#924;" },
    { char: "\u03BC", label: "mu", insert: "&#956;" },
    { char: "\u039D", label: "Nu (upper)", insert: "&#925;" },
    { char: "\u03BD", label: "nu", insert: "&#957;" },
    { char: "\u039E", label: "Xi (upper)", insert: "&#926;" },
    { char: "\u03BE", label: "xi", insert: "&#958;" },
    { char: "\u039F", label: "Omicron (upper)", insert: "&#927;" },
    { char: "\u03BF", label: "omicron", insert: "&#959;" },
    { char: "\u03A0", label: "Pi (upper)", insert: "&#928;" },
    { char: "\u03C0", label: "pi", insert: "&#960;" },
    { char: "\u03A1", label: "Rho (upper)", insert: "&#929;" },
    { char: "\u03C1", label: "rho", insert: "&#961;" },
    { char: "\u03A3", label: "Sigma (upper)", insert: "&#931;" },
    { char: "\u03C3", label: "sigma", insert: "&#963;" },
    { char: "\u03C2", label: "final sigma", insert: "&#962;" },
    { char: "\u03A4", label: "Tau (upper)", insert: "&#932;" },
    { char: "\u03C4", label: "tau", insert: "&#964;" },
    { char: "\u03A5", label: "Upsilon (upper)", insert: "&#933;" },
    { char: "\u03C5", label: "upsilon", insert: "&#965;" },
    { char: "\u03A6", label: "Phi (upper)", insert: "&#934;" },
    { char: "\u03C6", label: "phi", insert: "&#966;" },
    { char: "\u03A7", label: "Chi (upper)", insert: "&#935;" },
    { char: "\u03C7", label: "chi", insert: "&#967;" },
    { char: "\u03A8", label: "Psi (upper)", insert: "&#936;" },
    { char: "\u03C8", label: "psi", insert: "&#968;" },
    { char: "\u03A9", label: "Omega (upper)", insert: "&#937;" },
    { char: "\u03C9", label: "omega", insert: "&#969;" },
  ]},
  { name: "Super/Sub", items: [
    { char: "\u2070", label: "Superscript 0", insert: "&#8304;" },
    { char: "\u00B9", label: "Superscript 1", insert: "&#185;" },
    { char: "\u00B2", label: "Superscript 2", insert: "&#178;" },
    { char: "\u00B3", label: "Superscript 3", insert: "&#179;" },
    { char: "\u2074", label: "Superscript 4", insert: "&#8308;" },
    { char: "\u2075", label: "Superscript 5", insert: "&#8309;" },
    { char: "\u2076", label: "Superscript 6", insert: "&#8310;" },
    { char: "\u2077", label: "Superscript 7", insert: "&#8311;" },
    { char: "\u2078", label: "Superscript 8", insert: "&#8312;" },
    { char: "\u2079", label: "Superscript 9", insert: "&#8313;" },
    { char: "\u207A", label: "Superscript +", insert: "&#8314;" },
    { char: "\u207B", label: "Superscript \u2212", insert: "&#8315;" },
    { char: "\u207C", label: "Superscript =", insert: "&#8316;" },
    { char: "\u207D", label: "Superscript (", insert: "&#8317;" },
    { char: "\u207E", label: "Superscript )", insert: "&#8318;" },
    { char: "\u207F", label: "Superscript n", insert: "&#8319;" },
    { char: "\u2071", label: "Superscript i", insert: "&#8305;" },
    { char: "\u2080", label: "Subscript 0", insert: "&#8320;" },
    { char: "\u2081", label: "Subscript 1", insert: "&#8321;" },
    { char: "\u2082", label: "Subscript 2", insert: "&#8322;" },
    { char: "\u2083", label: "Subscript 3", insert: "&#8323;" },
    { char: "\u2084", label: "Subscript 4", insert: "&#8324;" },
    { char: "\u2085", label: "Subscript 5", insert: "&#8325;" },
    { char: "\u2086", label: "Subscript 6", insert: "&#8326;" },
    { char: "\u2087", label: "Subscript 7", insert: "&#8327;" },
    { char: "\u2088", label: "Subscript 8", insert: "&#8328;" },
    { char: "\u2089", label: "Subscript 9", insert: "&#8329;" },
    { char: "\u208A", label: "Subscript +", insert: "&#8330;" },
    { char: "\u208B", label: "Subscript \u2212", insert: "&#8331;" },
    { char: "\u208C", label: "Subscript =", insert: "&#8332;" },
    { char: "\u208D", label: "Subscript (", insert: "&#8333;" },
    { char: "\u208E", label: "Subscript )", insert: "&#8334;" },
    { char: "\u2090", label: "Subscript a", insert: "&#8336;" },
    { char: "\u2091", label: "Subscript e", insert: "&#8337;" },
    { char: "\u2092", label: "Subscript o", insert: "&#8338;" },
    { char: "\u2093", label: "Subscript x", insert: "&#8339;" },
    { char: "\u2095", label: "Subscript h", insert: "&#8341;" },
    { char: "\u2096", label: "Subscript k", insert: "&#8342;" },
    { char: "\u2097", label: "Subscript l", insert: "&#8343;" },
    { char: "\u2098", label: "Subscript m", insert: "&#8344;" },
    { char: "\u2099", label: "Subscript n", insert: "&#8345;" },
    { char: "\u209A", label: "Subscript p", insert: "&#8346;" },
    { char: "\u209B", label: "Subscript s", insert: "&#8347;" },
    { char: "\u209C", label: "Subscript t", insert: "&#8348;" },
  ]},
  { name: "Musical", items: [
    { char: "\u2669", label: "Quarter Note", insert: "&#9833;" },
    { char: "\u266A", label: "Eighth Note", insert: "&#9834;" },
    { char: "\u266B", label: "Beamed Eighth Notes", insert: "&#9835;" },
    { char: "\u266C", label: "Beamed Sixteenth Notes", insert: "&#9836;" },
    { char: "\u266D", label: "Flat", insert: "&#9837;" },
    { char: "\u266E", label: "Natural", insert: "&#9838;" },
    { char: "\u266F", label: "Sharp", insert: "&#9839;" },
  ]},
];

export const inlineMacroItems = [
  { id: "kbd", label: "Keyboard", code: "kbd:[...]", action: () => handleInline("kbd") },
  { id: "btn", label: "Button", code: "btn:[...]", action: () => handleInline("btn") },
  { id: "menu", label: "Menu", code: "menu:...[...]", action: () => handleInline("menu") },
  { id: "footnote", label: "Footnote", code: "footnote:[...]", action: () => handleInline("footnote") },
  { id: "anchor", label: "Anchor", code: "[[...]]", action: () => handleInline("anchor") },
  { id: "comment", label: "Comment", code: "// ...", action: () => handleInline("comment") },
];
