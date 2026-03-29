# Markup Section Feature Research

Research into AsciiDoc inline markup and macro features that could be added to the "Markup" ribbon section, based on the official AsciiDoc specification, Asciidoctor documentation, and evaluation against the plugin's existing toolbar coverage.

## Current State

### Already Covered

**Text section:** `*bold*`, `_italic_`, `` `mono` ``, `[line-through]#strike#`, `^super^`, `~sub~`, font color, highlight color, search

**Insert section:** headings, lists, admonitions, code blocks, tables, blocks (sidebar/example/collapsible/pagebreak), quotes, horizontal rule, images (`image::`), links (`link:`, wiki `<<>>`), math, mermaid diagrams, symbols/emojis, templates

**Markup section (current):**
- Inline: Keyboard (`kbd:[...]`), Button (`btn:[...]`), Comment (`// ...`)
- Macros: Menu (`menu:Top[Items]`), Footnote (`footnote:[text]`), Anchor (`[[id]]`)

---

## Recommended Additions

### High Priority

#### 1. Hard Line Break
- **Syntax:** ` +` appended at end of line
- **What it does:** Forces a line break within a paragraph without starting a new paragraph. Essential for poetry, addresses, or any content where line breaks matter within a paragraph.
- **Type:** Line-ending marker
- **Asciidoctor.js 3.0.4:** Fully supported
- **UI:** Simple button in the Inline subsection. Action: appends ` +` at end of current line or inserts ` +\n` at cursor.
- **Rationale:** Very commonly needed, no workaround exists in the current toolbar. Users frequently need line breaks without paragraph spacing.

#### 2. Cross-Reference / Xref Macro
- **Syntax:** `xref:document.adoc#anchor[display text]`
- **What it does:** Creates a cross-reference link to an anchor in another document. The shorthand `<<target>>` for same-document references is already covered by the Insert tab's wiki-link, but the full `xref:` macro for inter-document references is not.
- **Type:** Inline macro
- **Asciidoctor.js 3.0.4:** Fully supported
- **UI:** Split button with dropdown form (fields: document path, anchor ID, display text).
- **Rationale:** Distinct from the existing wiki-link — handles explicit document path + fragment linking. Essential for structured note collections.

#### 3. Underline
- **Syntax:** `[.underline]#text#`
- **What it does:** Applies underline text decoration. A fundamental formatting option missing from the Text section.
- **Type:** Inline (wraps text with role)
- **Asciidoctor.js 3.0.4:** Fully supported (built-in role)
- **UI:** Simple button — but belongs in the **Text section** alongside bold/italic/strikethrough, not in Markup.
- **Rationale:** Notable gap in the current toolbar. Underline is one of the most expected formatting options in any editor.

---

### Medium Priority

#### 4. Inline Passthrough (Short Form)
- **Syntax:** `+text+` (constrained), `++text++` (unconstrained), `+++text+++` (raw)
- **What it does:** Prevents inline substitutions on enclosed text. Single plus escapes special characters. Double plus works mid-word. Triple plus is a complete raw passthrough.
- **Type:** Inline (wraps text)
- **Asciidoctor.js 3.0.4:** Fully supported
- **UI:** Simple button in the Inline subsection — wraps selection with `+..+` by default. Could be combined with the `pass:[]` macro (below) as a split button.
- **Rationale:** Useful when showing literal AsciiDoc syntax or preventing unwanted formatting. A common need for technical writers.

#### 5. Pass Macro (Long Form)
- **Syntax:** `pass:[content]`, `pass:c[content]`, `pass:q,a[content]`
- **What it does:** Passes content directly to output with selective substitution control. Substitution specifiers: `c` (specialchars), `q` (quotes), `a` (attributes), `r` (replacements), `m` (macros), `p` (post-replacements).
- **Type:** Inline macro
- **Asciidoctor.js 3.0.4:** Fully supported
- **UI:** Split button with dropdown — main button inserts `pass:[...]` wrapping selection; dropdown offers checkboxes for substitution types.
- **Rationale:** Power-user feature for embedding raw HTML or controlling substitution behavior. Could be combined with the short-form passthrough above into a single split button.

#### 6. Curly/Smart Quotation Marks
- **Syntax:** `` "`quoted text`" `` (double curly), `` '`quoted text`' `` (single curly)
- **What it does:** Converts straight quotes to typographic curly/smart quotes for professional typography.
- **Type:** Inline (wraps text)
- **Asciidoctor.js 3.0.4:** Fully supported
- **UI:** Simple button in the Inline subsection — wraps selection with `` "`..`" ``.
- **Rationale:** Produces polished typography. Simple to implement and genuinely useful for anyone who cares about presentation.

#### 7. Icon Macro
- **Syntax:** `icon:heart[]`, `icon:download[2x,role=red]`
- **What it does:** Inserts a Font Awesome icon. Supports size (1x-5x, lg, fw), rotate (90/180/270), flip (horizontal/vertical), role, title, link.
- **Type:** Inline macro
- **Asciidoctor.js 3.0.4:** Fully supported (requires `:icons: font` attribute)
- **UI:** Split button with dropdown — icon name text field + optional attribute fields (size, rotate, flip). Ideally a searchable icon picker.
- **Rationale:** Icons are very useful for visual note-taking and documentation. However, requires the `:icons: font` document attribute to render — the plugin would need to handle this dependency.

---

## Evaluated and Not Recommended

| Feature | Syntax | Why Skip |
|---------|--------|----------|
| **Inline Image** | `image:file.png[alt]` | Narrow use case; block image already in Insert |
| **Mailto** | `mailto:addr[text]` | Too niche for note-taking |
| **Anchor (long form)** | `anchor:id[label]` | Already covered by `[[id]]` |
| **Inline Anchor with Span** | `[#id]#text#` | Too similar to existing Anchor |
| **Overline** | `[.overline]#text#` | Rarely used |
| **Nobreak** | `[.nobreak]#text#` | Too niche |
| **Nowrap** | `[.nowrap]#text#` | Too niche |
| **Pre-wrap** | `[.pre-wrap]#text#` | Too niche |
| **Custom Role** | `[.myclass]#text#` | Requires custom CSS; too advanced |
| **Block Comment** | `////...////` | Single-line comment already exists |
| **Bibliography Anchor** | `[[[id]]]` | Requires `[bibliography]` section context |
| **Counter** | `{counter:name}` | Officially discouraged by AsciiDoc spec |
| **Conditionals** | `ifdef::attr[...]` | Preprocessor feature, too advanced |
| **Include Directive** | `include::file[]` | Limited utility in Joplin (notes aren't files) |
| **Attribute Declaration** | `:key: value` | Document-level setting, not inline markup |
| **Attribute Reference** | `{key}` | Context-dependent, not a good toolbar button |
| **Discrete Heading** | `[discrete]\n== Text` | Too specialized |
| **Passthrough Block** | `++++...++++` | Block-level, belongs in Insert if anywhere |
| **Verse Block** | `[verse]\n____...____ ` | Block-level, belongs in Insert |
| **Audio/Video** | `audio::/video::` | Too niche for Joplin |

---

## Proposed Markup Section Layout

```
┌──────────────────────────────────────────────────────────┐
│  Markup                                                   │
├──────────────────────────────────────────────────────────┤
│                                                           │
│  ┌─ Inline ──────────────────────┐  ┌─ Macros ─────────┐ │
│  │ [Keyboard] [Button] [Comment] │  │ [Menu ▾]         │ │
│  │ [Line Break] [Curly Quotes]   │  │ [Footnote ▾]     │ │
│  │ [Passthrough ▾]               │  │ [Anchor ▾]       │ │
│  └───────────────────────────────┘  │ [Xref ▾]         │ │
│                                      │ [Icon ▾]         │ │
│                                      └──────────────────┘ │
└──────────────────────────────────────────────────────────┘
```

Where:
- **Line Break** = simple button, appends ` +` at end of line
- **Curly Quotes** = simple button, wraps with `` "`..`" ``
- **Passthrough** = split button (main: `+..+`, dropdown: `++..++` / `+++..+++` / `pass:[]` with substitution options)
- **Xref** = split button with dropdown form (document path, anchor ID, display text)
- **Icon** = split button with dropdown (icon name, size, rotate, flip)

## Also Recommended (for the Text section, not Markup)

**Underline** (`[.underline]#text#`) — add to the Text section alongside bold/italic/strikethrough. This is a significant gap in the current formatting toolbar.

---

## Sources

- [AsciiDoc Language Documentation](https://docs.asciidoctor.org/asciidoc/latest/)
- [Asciidoctor User Manual](https://docs.asciidoctor.org/asciidoctor/latest/)
- [AsciiDoc Syntax Quick Reference](https://docs.asciidoctor.org/asciidoc/latest/syntax-quick-reference/)
- [Inline Macros](https://docs.asciidoctor.org/asciidoc/latest/macros/)
- [Text Formatting](https://docs.asciidoctor.org/asciidoc/latest/text/)
- [Passthrough](https://docs.asciidoctor.org/asciidoc/latest/pass/)
- [Document Attributes](https://docs.asciidoctor.org/asciidoc/latest/attributes/)
- [Built-in Roles](https://docs.asciidoctor.org/asciidoc/latest/text/text-span-built-in-roles/)
