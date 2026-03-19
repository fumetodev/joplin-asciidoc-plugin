# AsciiDoc Notes — Live Preview Editor for Joplin

A full-featured AsciiDoc editor plugin for [Joplin](https://joplinapp.org/) with real-time live preview, a ribbon-style toolbar, and rich block editing. Write AsciiDoc notes with the same visual feedback you'd expect from a modern word processor — rendered headings, images, tables, code blocks, and more appear inline as you type.

Requires **Joplin 3.1+** (desktop only).

## Features at a Glance

- **Live preview** — AsciiDoc renders inline as you type, powered by CodeMirror 6 and Asciidoctor.js
- **Ribbon toolbar** — four tabbed panels (Text, Insert, Formatting, Editor) with one-click access to every AsciiDoc construct
- **Block editing** — click any rendered table, code block, image, or blockquote to edit it in a focused modal or inline
- **Markdown conversion** — convert existing Markdown notes to AsciiDoc (headings, lists) with a single command
- **Wiki-links & cross-references** — `<<noteId,Display Text>>` links between notes with autocomplete
- **Template system** — save and reuse note templates
- **Dark & light themes** — auto-detected from Joplin's settings

---

## Getting Started

### Installation

1. Build the plugin:
   ```bash
   npm install
   npm run build
   ```
2. The build script automatically copies the `.jpl` file to Joplin's plugin directory and clears the cache.
3. **Restart Joplin** (Cmd+Q / Ctrl+Q, then reopen) — plugins only load on startup.

### Creating an AsciiDoc Note

- **Tools > New AsciiDoc Note** — creates a blank AsciiDoc note
- **Tools > Convert to AsciiDoc Note** — converts the current Markdown note in place
- **Tools > Convert to AsciiDoc Note (new file)** — creates an AsciiDoc copy, keeping the original
- **Right-click a note > Convert to AsciiDoc File** — convert from the note list
- **Note toolbar button: "Make AsciiDoc"** — one-click convert for the current note

You can also enable **"Create new notes as AsciiDoc"** in Preferences > AsciiDoc to auto-convert every new note.

---

## Toolbar

The ribbon toolbar is organized into four tabs:

### Text

| Button | Action |
|--------|--------|
| **B** | Bold (`*text*`) |
| *I* | Italic (`_text_`) |
| `M` | Monospace (`` `text` ``) |
| ~~S~~ | Strikethrough (`[line-through]#text#`) |
| X^2^ | Superscript (`^text^`) |
| X~2~ | Subscript (`~text~`) |
| Font Color | Pick from 8 colors (Red, Blue, Green, Purple, Orange, Teal, Maroon, Navy) |
| Highlight | Pick from 6 highlight colors (Yellow, Lime, Aqua, Pink, Orange, Silver) |
| Find | Open the search & replace panel |

### Insert

| Button | Action |
|--------|--------|
| Admonition | Dropdown: Note, Tip, Warning, Caution, Important, Question |
| Source Block | Dropdown with 12 languages (JS, TS, Python, Rust, Java, HTML, CSS, JSON, Bash, SQL, Go, Ruby) |
| Table | Row/column picker (default 3x3) |
| Block | Sidebar, Example, Collapsible, Page Break |
| Math | Dropdown: LaTeX/AsciiMath/Stem inline and block options. Default action inserts inline LaTeX. |
| Bullet List | Unordered list (`*`) |
| Numbered List | Ordered list (`.`) |
| Checklist | Checkbox list (`* [ ]` / `* [x]`) |
| Definition List | Term/definition pairs (`term:: definition`) |
| Block Quote | Quote block with optional attribution |
| Horizontal Rule | Thematic break (`'''`) |
| Image | Web URL or local file (opens file picker) |
| Link | External URL or wiki-link to another note |
| Template | Insert from your template library |
| Symbols | 10 categories: AsciiDoc, Whitespace, Punctuation, Math, Arrows, Currency, Marks, Shapes, Greek, Emoji |

### Formatting

| Button | Action |
|--------|--------|
| Keyboard | Keyboard shortcut markup (`kbd:[Cmd+C]`) |
| Button | UI button markup (`btn:[Save]`) |
| Comment | Line comment (`// ...`) |
| Menu | Menu path (`menu:File[Save As]`) |
| Footnote | New or named/reusable footnote |
| Anchor | Inline anchor (`[[id]]`) |

### Editor

| Control | Action |
|---------|--------|
| Line Numbers | Toggle line numbers on/off |
| Special Block Shading | Toggle background shading on rendered blocks |
| Overlay Block Editing | Toggle modal editing when clicking rendered blocks |
| Content Margin | Slider (0–300 px) to adjust editor margins |

---

## Live Preview

The editor renders AsciiDoc constructs inline as you type. Move your cursor to a line to see and edit the raw markup; move away and it renders as preview.

### Supported Constructs

**Headings** — `= Title` through `===== Level 5`, rendered with decreasing font sizes and heading colors.

**Text formatting** — Bold, italic, monospace, strikethrough, superscript, subscript, underline, overline, highlight, and color/size roles all render inline.

**Lists** — Bullet (`*`), numbered (`.`), checklists (`* [x]`), and definition lists (`term::`) with multi-level nesting.

**Code blocks** — Fenced source blocks with syntax highlighting and a language label. Click to edit in a modal with a language selector.

**Tables** — Full rendered table with header row/column support. Click to edit with add/remove row/column controls and header toggles.

**Images** — Web URLs and Joplin local resources (`:/resourceId`). Supports alt text, title, caption, scale (10–200%), alignment (center/left/right), and caption position (below/left/right). Click to open a full image editor modal.

**Admonitions** — NOTE, TIP, WARNING, CAUTION, IMPORTANT, and QUESTION blocks with colored labels.

**Blockquotes** — Rendered with attribution. Click to edit content and author.

**Footnotes** — Auto-numbered superscript references `[1]`, `[2]`, `[3]`. Named footnotes (`footnote:id[text]`) share numbers when referenced. Click to see a floating popup with the footnote text.

**Cross-references** — `<<noteId,Display Text>>` renders as a clickable link. Xrefs with section anchors (`<<noteId#section,text>>`) include a toggle to preview the linked section inline.

**Math / STEM** — Inline math via `stem:[]`, `latexmath:[]`, or `asciimath:[]` macros renders via KaTeX directly in the preview. Display-mode block math uses `[latexmath]` / `[asciimath]` / `[stem]` attribute followed by `++++` delimiters. The `:stem:` document attribute controls the default notation for `stem:[]` macros (`latexmath` or `asciimath`). AsciiMath expressions are auto-converted to LaTeX before rendering. Click a rendered block equation to edit in a modal with live preview and notation selector.

**Collapsible blocks** — `[%collapsible]` blocks render with a clickable caret to expand/collapse.

**Sidebar & Example blocks** — Rendered with appropriate borders and backgrounds.

**Horizontal rules & page breaks** — `'''` renders as a divider; `<<<` renders as a labeled page break.

**AsciiDoc text replacements** — `(C)` becomes &copy;, `->` becomes &rarr;, `--` becomes an em dash, `...` becomes an ellipsis, and more.

---

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| Cmd+B | Bold |
| Cmd+I | Italic |
| Cmd+` | Monospace |
| Cmd+Shift+X | Strikethrough |
| Cmd+. | Superscript |
| Cmd+, | Subscript |
| Cmd+/ | Toggle line comment |
| Cmd+S | Save note |
| Tab | Indent list item |
| Shift+Tab | Dedent list item |
| Enter | Auto-continue list / checklist |

> **Note:** Cmd+F is intercepted by Joplin at the app level. Use the magnifying glass button in the Text tab to open Find & Replace.

---

## Wiki-Links & Autocomplete

Type `<<` to trigger note search autocomplete — results appear as you type, showing up to 20 matching notes by title. Select a note to insert a cross-reference link.

After selecting a note, type `#` to drill into its sections. The autocomplete shows heading levels (h2, h3, etc.) with indentation, letting you link directly to a specific section.

---

## Templates

1. Open any AsciiDoc note you want to reuse as a template.
2. Use the **Template** button in the Insert tab and choose **"Save current note as template"**.
3. The note is tagged with `asciidoc-template` and appears in the template library.
4. To insert a template, click **Template** in the Insert tab, search by title, and click to insert its content at the cursor.

---

## Markdown Conversion

When converting a Markdown note to AsciiDoc, the plugin automatically converts:

- **Headings**: `# Heading` becomes `= Heading` (all 6 levels)
- **Unordered lists**: `- item` becomes `* item`, with nested indentation converted to AsciiDoc nesting (`**`, `***`, etc.)
- Content inside fenced code blocks is left untouched

---

## Settings

In **Preferences > AsciiDoc**:

| Setting | Default | Description |
|---------|---------|-------------|
| Create new notes as AsciiDoc | Off | Automatically convert newly created notes to AsciiDoc |

Editor-level settings (persisted in localStorage):

| Setting | Default | Description |
|---------|---------|-------------|
| Content Margin | 0 px | Left/right padding for the editor content |
| Overlay Block Editing | Off | Open a modal when clicking rendered blocks instead of inline editing |

---

## Document Attributes

Use **Tools > Edit AsciiDoc Attributes** to set document-level attributes (author, revision, custom variables). These are stored in the note's sentinel block and passed to Asciidoctor during rendering.

---

## Architecture

The plugin consists of two webpack bundles:

| Bundle | Target | Size | Contains |
|--------|--------|------|----------|
| `index.js` | Node (plugin sandbox) | ~10 KB | Plugin registration, commands, settings, IPC handlers, Asciidoctor.js rendering |
| `panel.js` | Web (webview) | ~847 KB | CodeMirror 6 editor, live-preview decoration engine, KaTeX math rendering, toolbar, IPC client |

AsciiDoc notes are identified by a `` ```asciidoc-settings `` sentinel block appended to the note body. This block also stores document attributes as JSON.

Communication between the plugin sandbox and the webview editor uses Joplin's `postMessage` IPC protocol for operations like saving, rendering, resource resolution, note search, and template management.

---

## Building

```bash
npm install        # Install dependencies
npm run build      # Production build → .jpl → auto-deploy to Joplin
npm run dev        # Watch mode for development
```

After every build, restart Joplin to load the updated plugin.

### Debugging

```bash
# Run Joplin with dev console
/Applications/Joplin.app/Contents/MacOS/Joplin --env dev

# Check Joplin logs
grep -i "asciidoc\|plugin.*error" ~/.config/joplin-desktop/log.txt | tail -20
```

---

## License

MIT
