# Bibliography Feature — Comprehensive Report & Implementation Plan

## 1. Current State

**The plugin has NO bibliography support.** After a thorough search of the entire codebase, there is no detection, rendering, or editing support for:

- `[bibliography]` section style
- `[[[label]]]` bibliography anchors
- `<<label>>` references that resolve to bibliography entries
- Bibliography-specific CSS or HTML output

The only related features are:
- **Footnotes** — `footnote:[text]`, `footnote:id[text]`, `footnote:id[]` (fully implemented)
- **Cross-references** — `<<nodeid,text>>` (implemented, but not bibliography-aware)
- **Asciidoctor.js** — The full render path via IPC handles bibliography natively, but the live preview engine does not

---

## 2. AsciiDoc Bibliography Specification

Source: https://docs.asciidoctor.org/asciidoc/latest/sections/bibliography/

### 2.1 Section Declaration

A bibliography must be its own section with the `[bibliography]` style attribute:

```asciidoc
[bibliography]
== References
```

- Level 1 (`==`) for article doctype or book without parts
- Level 0 (`=`) for book-with-parts (whole-book bibliography)
- Deeper levels always allowed

### 2.2 Bibliography Entries

Entries are **unordered list items** with a **bibliography anchor** prefix:

```asciidoc
* [[[pp]]] Andy Hunt & Dave Thomas. The Pragmatic Programmer. Addison-Wesley. 1999.
* [[[gof,gang]]] Erich Gamma et al. Design Patterns. Addison-Wesley. 1994.
```

- `[[[label]]]` — assigns a non-numeric ID to the entry
- `[[[label,xreftext]]]` — assigns ID + custom display text
- Entry content after the anchor is **freeform** (AsciiDoc doesn't impose structure)

### 2.3 Inline References

References use standard cross-reference syntax anywhere **above** the bibliography:

```asciidoc
_The Pragmatic Programmer_ <<pp>> should be required reading.
Refer to the "`Gang of Four`" <<gof>>.
```

- `<<pp>>` renders as `[pp]`
- `<<gof>>` renders as `[gang]` (uses xreftext from `[[[gof,gang]]]`)

### 2.4 Generated HTML

```html
<div class="ulist bibliography">
  <ul class="bibliography">
    <li><p><a id="pp"></a>[pp] Andy Hunt & Dave Thomas. ...</p></li>
    <li><p><a id="gof"></a>[gang] Erich Gamma et al. ...</p></li>
  </ul>
</div>
```

### 2.5 Key Constraints

- Labels must be non-numeric
- References can only appear above the bibliography section
- Entry content is freeform (no structured fields)
- For advanced features (auto-numbering, BibTeX integration), the spec recommends `asciidoctor-bibtex`

---

## 3. Implementation Plan

### 3.1 Overview

The implementation adds three layers:

1. **Live Preview Rendering** — Detect `[bibliography]` sections, render `[[[label]]]` anchors and `<<label>>` references
2. **Block Detection** — Add `"bibliography"` as a new block type in `detectBlocks()`
3. **Overlay Editor** — A two-panel modal (modeled after the Mermaid editor) with raw AsciiDoc editing on the left, live preview on the right, and citation format presets

### 3.2 Files to Modify

| File | Changes |
|------|---------|
| `src/lib/editor/live-preview.ts` | Block detection, preview widget, inline reference rendering, overlay editor, CSS |
| `src/styles/preview.css` | Bibliography styles for Asciidoctor.js rendered output |
| `src/lib/toolbar/panels/formatting-panel.ts` | Toolbar button for inserting bibliography entries/references |

### 3.3 New File

| File | Purpose |
|------|---------|
| `src/lib/editor/bibliography-presets.ts` | Citation format definitions (APA, MLA, AMA, etc.) with field schemas and formatters |

---

## 4. Live Preview Rendering

### 4.1 Block Detection

Add a new block type to `detectBlocks()`:

```typescript
interface BibliographyBlockInfo {
  type: "bibliography";
  attrLine: number;    // line with [bibliography]
  headingLine: number; // line with == References (or similar)
  startLine: number;   // first content line after heading
  endLine: number;     // last content line (before next section or EOF)
}
```

**Detection logic:**
1. Match `[bibliography]` attribute line
2. Next line should be a heading (`== ...` or `=== ...`)
3. Content extends until the next same-or-higher-level heading or EOF

### 4.2 Bibliography Anchor Rendering

In `renderLineHtml()` or a dedicated function, detect `[[[label]]]` and `[[[label,xreftext]]]` patterns within unordered list items:

- Pattern: `/\[\[\[([a-zA-Z][\w-]*?)(?:,([^\]]+))?\]\]\]/`
- Render as: `<span class="cm-lp-biblio-anchor">[{xreftext || label}]</span>` followed by the entry text

### 4.3 Inline Reference Rendering

The existing `<<label>>` cross-reference rendering in `renderInline()` (lines 2838-2850) needs to be extended to check if the label matches a bibliography anchor. If it does, render as `[label]` or `[xreftext]` instead of the current link-style rendering.

This requires:
- A map of bibliography labels → xreftext, built during the block detection or render pass
- Checking this map when rendering `<<label>>` references

### 4.4 Preview Widget

When cursor is outside the bibliography block (preview mode), render as a styled section:

```
┌─────────────────────────────────────┐
│ REFERENCES                          │
│                                     │
│ [pp] Andy Hunt & Dave Thomas. The   │
│ Pragmatic Programmer. Addison-      │
│ Wesley. 1999.                       │
│                                     │
│ [gang] Erich Gamma et al. Design    │
│ Patterns. Addison-Wesley. 1994.     │
│                                     │
└─────────────────────────────────────┘
```

When cursor is inside (edit mode), show raw AsciiDoc source lines.

---

## 5. Overlay Editor Design

### 5.1 Structure (Modeled After Mermaid Editor)

The overlay follows the same pattern as `openMermaidBlockEditorModal()` (lines 922-1180 of live-preview.ts):

```
┌──────────────────────────────────────────────────────────┐
│  Edit Bibliography                                    ✕  │
├──────────────────────────┬───────────────────────────────┤
│  [Format: Raw AsciiDoc ▾]│  Preview                     │
│                          │                               │
│  (Editor Panel)          │  References                   │
│                          │                               │
│  * [[[pp]]] Andy Hunt &  │  [pp] Andy Hunt & Dave        │
│  Dave Thomas. The        │  Thomas. The Pragmatic        │
│  Pragmatic Programmer.   │  Programmer. Addison-Wesley.  │
│  Addison-Wesley. 1999.   │  1999.                        │
│                          │                               │
│  * [[[gof,gang]]] Erich  │  [gang] Erich Gamma et al.   │
│  Gamma et al. Design     │  Design Patterns. Addison-    │
│  Patterns. Addison-      │  Wesley. 1994.                │
│  Wesley. 1994.           │                               │
│                          │                               │
├──────────────────────────┴───────────────────────────────┤
│  [Delete Section]              [Cancel]  [Save]          │
└──────────────────────────────────────────────────────────┘
```

### 5.2 Format Selector (Left Panel Top)

A dropdown at the top of the left panel switches between editing modes:

| Mode | Description |
|------|-------------|
| **Raw AsciiDoc** (default) | Plain textarea with the raw bibliography source |
| **APA 7th Edition** | Structured form with APA-specific fields |
| **MLA 9th Edition** | Structured form with MLA-specific fields |
| **AMA 11th Edition** | Structured form with AMA-specific fields |
| **Chicago (Notes-Bibliography)** | Structured form with Chicago NB fields |
| **Chicago (Author-Date)** | Structured form with Chicago AD fields |
| **Turabian** | Structured form (mirrors Chicago) |
| **IEEE** | Structured form with IEEE-specific fields |
| **Vancouver** | Structured form with Vancouver-specific fields |
| **Harvard** | Structured form with Harvard-specific fields |
| **ASA 6th Edition** | Structured form with ASA-specific fields |

### 5.3 Preset Form Layout

When a citation format is selected, the left panel changes from a textarea to a structured form:

```
┌──────────────────────────┐
│ Format: [APA 7th Ed.  ▾] │
│ Source Type: [Book     ▾] │
├──────────────────────────┤
│ ┌─ Entry 1 ────────────┐ │
│ │ Author(s): [________] │ │
│ │ Year:      [________] │ │
│ │ Title:     [________] │ │
│ │ Publisher: [________] │ │
│ │ DOI/URL:   [________] │ │
│ │            [Remove]   │ │
│ └───────────────────────┘ │
│ ┌─ Entry 2 ────────────┐ │
│ │ ...                   │ │
│ └───────────────────────┘ │
│       [+ Add Entry]       │
└──────────────────────────┘
```

**Key interactions:**
- Changing the format dropdown regenerates the form fields
- Changing the source type dropdown changes which fields are shown
- Each entry has its own source type selector (different entries can cite different source types)
- The "Add Entry" button appends a new blank entry card
- Each entry has a "Remove" button
- The right panel preview updates live as fields are filled in
- When saving, the preset form generates proper AsciiDoc bibliography syntax

### 5.4 Switching Between Raw and Preset Modes

- **Raw → Preset**: The raw AsciiDoc is parsed to extract entry text (best-effort; structured fields may not auto-populate since AsciiDoc entries are freeform)
- **Preset → Raw**: The structured form generates formatted AsciiDoc bibliography entries
- A confirmation dialog warns when switching modes if data might be lost

---

## 6. Citation Format Presets — Field Definitions

### 6.1 Source Types (Common Across All Formats)

Each format supports these source types via a dropdown:

| Source Type | Description |
|-------------|-------------|
| Book | Monograph, textbook |
| Journal Article | Peer-reviewed journal paper |
| Website / Online | Web page, online article |
| Conference Paper | Conference proceedings or presentation |
| Thesis / Dissertation | Academic thesis or dissertation |
| Book Chapter | Chapter in an edited volume |
| Report | Technical report, white paper |
| Newspaper / Magazine | Periodical article |

### 6.2 APA 7th Edition

**General rules:** Author-date system. Sentence case for article titles, title case for journal names. DOI as URL format.

#### Book Fields
| Field | Required | Notes |
|-------|----------|-------|
| Author(s) | Yes | Last, F. M. format; `&` before last author |
| Year | Yes | In parentheses |
| Title | Yes | Italicized, sentence case |
| Edition | No | e.g., "2nd ed." — only if not first |
| Publisher | Yes | No location (7th ed. change) |
| DOI/URL | No | Full URL format for DOI |

#### Journal Article Fields
| Field | Required | Notes |
|-------|----------|-------|
| Author(s) | Yes | Same format as book |
| Year | Yes | In parentheses |
| Article Title | Yes | Sentence case, not italicized |
| Journal Name | Yes | Title case, italicized |
| Volume | Yes | Italicized |
| Issue | Yes | In parentheses, not italicized |
| Pages | Yes | Range with en-dash |
| DOI/URL | No | |

#### Website Fields
| Field | Required | Notes |
|-------|----------|-------|
| Author(s) / Organization | Yes | |
| Date | Yes | Year, Month Day — or "n.d." |
| Page Title | Yes | Italicized |
| Site Name | No | Omit if same as author |
| URL | Yes | |
| Retrieval Date | No | Only if content may change |

#### Conference Paper Fields
| Field | Required | Notes |
|-------|----------|-------|
| Author(s) | Yes | |
| Year, Month | Yes | |
| Paper Title | Yes | Sentence case |
| Conference Name | Yes | |
| Location | Yes | City, State/Country |
| DOI/URL | No | |
| **Variant dropdown** | | Published proceedings vs. Unpublished presentation |

#### Thesis / Dissertation Fields
| Field | Required | Notes |
|-------|----------|-------|
| Author | Yes | |
| Year | Yes | |
| Title | Yes | Italicized |
| **Type dropdown** | Yes | Doctoral dissertation / Master's thesis |
| University Name | Yes | In brackets with type |
| Database/Repository | No | |
| URL | No | |

---

### 6.3 MLA 9th Edition

**General rules:** Author-page system. Title case for all titles. Container model.

#### Book Fields
| Field | Required | Notes |
|-------|----------|-------|
| Author(s) | Yes | Last, First. format |
| Title | Yes | Italicized, title case |
| Edition/Version | No | |
| Publisher | Yes | |
| Year | Yes | |
| DOI/URL | No | |

#### Journal Article Fields
| Field | Required | Notes |
|-------|----------|-------|
| Author(s) | Yes | |
| Article Title | Yes | In quotation marks |
| Journal Name | Yes | Italicized |
| Volume | Yes | Prefixed with "vol." |
| Issue | Yes | Prefixed with "no." |
| Date | Yes | Season/Month Year |
| Pages | Yes | Prefixed with "pp." |
| DOI/URL | No | |
| Database | No | Italicized, second container |

#### Website Fields
| Field | Required | Notes |
|-------|----------|-------|
| Author | No | |
| Page Title | Yes | In quotation marks |
| Website Name | Yes | Italicized |
| Publisher/Sponsor | No | If different from site name |
| Date | Yes | |
| URL | Yes | |
| Access Date | No | Recommended if no pub date |

#### Conference Paper Fields
| Field | Required | Notes |
|-------|----------|-------|
| Author | Yes | |
| Paper Title | Yes | In quotation marks |
| Conference Name | Yes | Italicized (as container) |
| Date | Yes | |
| Location | Yes | |
| **Variant dropdown** | | Published proceedings vs. Presentation |

#### Thesis / Dissertation Fields
| Field | Required | Notes |
|-------|----------|-------|
| Author | Yes | |
| Title | Yes | Italicized |
| Year | Yes | |
| Institution | Yes | |
| **Type dropdown** | Yes | Dissertation / Thesis |
| Database | No | Second container |
| URL | No | |

---

### 6.4 AMA 11th Edition

**General rules:** Numbered system (superscript in text). NLM journal abbreviations. No italics/quotes in reference list.

#### Book Fields
| Field | Required | Notes |
|-------|----------|-------|
| Author(s) | Yes | Last AB format (no periods in initials) |
| Title | Yes | Italicized |
| Edition | No | Only if not first |
| Publisher | Yes | |
| Year | Yes | Semicolon before year |
| DOI/URL | No | |

#### Journal Article Fields
| Field | Required | Notes |
|-------|----------|-------|
| Author(s) | Yes | Max 6, then first 3 + "et al." |
| Article Title | Yes | Sentence case, period at end |
| Journal Name | Yes | NLM abbreviated, italicized |
| Year | Yes | |
| Volume | Yes | |
| Issue | Yes | In parentheses |
| Pages | Yes | Compressed format: Year;Vol(Issue):Pages |
| DOI | No | "doi:" prefix |

#### Website Fields
| Field | Required | Notes |
|-------|----------|-------|
| Author(s) / Organization | Yes | |
| Page Title | Yes | |
| Website Name | Yes | |
| Published/Updated Date | Yes | |
| Accessed Date | Yes | |
| URL | Yes | |

#### Conference Paper Fields
| Field | Required | Notes |
|-------|----------|-------|
| Author(s) | Yes | |
| Paper Title | Yes | |
| Conference Name | Yes | |
| Date | Yes | |
| City, State/Country | Yes | |
| **Variant dropdown** | | Published (as journal) vs. Unpublished |

#### Thesis / Dissertation Fields
| Field | Required | Notes |
|-------|----------|-------|
| Author | Yes | |
| Title | Yes | Italicized |
| **Type dropdown** | Yes | Dissertation / Thesis |
| City: Institution | Yes | |
| Year | Yes | |

---

### 6.5 Chicago 17th Edition — Notes-Bibliography

**General rules:** Footnote/endnote system. Full note on first citation, shortened on subsequent.

#### Book Fields
| Field | Required | Notes |
|-------|----------|-------|
| Author(s) | Yes | First Last (note) / Last, First (bibliography) |
| Title | Yes | Italicized |
| Place of Publication | Yes | |
| Publisher | Yes | |
| Year | Yes | |
| Edition | No | |
| Translator/Editor | No | |
| DOI/URL | No | |
| **Variant dropdown** | | First citation / Subsequent (shortened) |

#### Journal Article Fields
| Field | Required | Notes |
|-------|----------|-------|
| Author(s) | Yes | |
| Article Title | Yes | In quotation marks |
| Journal Name | Yes | Italicized |
| Volume | Yes | |
| Issue | Yes | |
| Year | Yes | |
| Pages | Yes | |
| DOI/URL | No | |

#### Website Fields
| Field | Required | Notes |
|-------|----------|-------|
| Author | Yes | |
| Page Title | Yes | In quotation marks |
| Website Name | Yes | |
| Date | Yes | |
| URL | Yes | |
| Access Date | No | |

#### Thesis / Dissertation Fields
| Field | Required | Notes |
|-------|----------|-------|
| Author | Yes | |
| Title | Yes | In quotation marks |
| **Type dropdown** | Yes | PhD diss. / MA thesis |
| University | Yes | |
| Year | Yes | |

---

### 6.6 Chicago 17th Edition — Author-Date

Same fields as Notes-Bibliography but formatted differently:
- In-text: (Author Year, page)
- Reference list: Year immediately follows author name
- No first/subsequent citation variant needed

---

### 6.7 Turabian 9th Edition

Identical field requirements to Chicago (both NB and AD variants). Turabian is the student adaptation. The only differences are:
- Access date recommended for all online sources
- Simplified guidance (same output format)

Implementation: Reuse Chicago field definitions with a "Turabian" label.

---

### 6.8 IEEE

**General rules:** Numbered system in square brackets. IEEE journal abbreviations.

#### Book Fields
| Field | Required | Notes |
|-------|----------|-------|
| Author(s) | Yes | F. M. Last format |
| Title | Yes | Italicized |
| Edition | No | |
| City, State/Country | Yes | |
| Publisher | Yes | |
| Year | Yes | |
| DOI/URL | No | |

#### Journal Article Fields
| Field | Required | Notes |
|-------|----------|-------|
| Author(s) | Yes | |
| Article Title | Yes | In quotation marks, sentence case |
| Journal Name | Yes | IEEE abbreviated, italicized |
| Volume | Yes | "vol." prefix |
| Issue | Yes | "no." prefix |
| Pages | Yes | "pp." prefix |
| Month Year | Yes | |
| DOI | No | |

#### Website Fields
| Field | Required | Notes |
|-------|----------|-------|
| Author(s) / Organization | Yes | |
| Page Title | Yes | In quotation marks |
| Website Name | Yes | Italicized |
| Access Date | Yes | |
| URL | Yes | Prefixed with "[Online]. Available:" |

#### Conference Paper Fields
| Field | Required | Notes |
|-------|----------|-------|
| Author(s) | Yes | |
| Paper Title | Yes | In quotation marks |
| Conference Name | Yes | "in Proc." prefix, italicized |
| City, Country | Yes | |
| Year | Yes | |
| Pages | Yes | |
| DOI | No | |

#### Thesis / Dissertation Fields
| Field | Required | Notes |
|-------|----------|-------|
| Author | Yes | |
| Title | Yes | In quotation marks |
| **Type dropdown** | Yes | Ph.D. dissertation / M.S. thesis |
| Dept., University | Yes | |
| City, State/Country | Yes | |
| Year | Yes | |

---

### 6.9 Vancouver (ICMJE / NLM)

**General rules:** Numbered system. NLM journal abbreviations. No italics/quotes in list.

#### Book Fields
| Field | Required | Notes |
|-------|----------|-------|
| Author(s) | Yes | Last AB format |
| Title | Yes | |
| Edition | No | |
| Place | Yes | |
| Publisher | Yes | |
| Year | Yes | |
| DOI/URL | No | |

#### Journal Article Fields
| Field | Required | Notes |
|-------|----------|-------|
| Author(s) | Yes | Max 6, then first 6 + "et al." |
| Article Title | Yes | |
| Journal Name | Yes | NLM abbreviated |
| Year Month | Yes | |
| Volume | Yes | |
| Issue | Yes | In parentheses |
| Pages | Yes | |
| DOI/PMID | No | |

#### Website Fields
| Field | Required | Notes |
|-------|----------|-------|
| Author(s) / Organization | Yes | |
| Title | Yes | Followed by "[Internet]" tag |
| Place: Publisher | Yes | |
| Date [updated; cited] | Yes | |
| URL | Yes | "Available from:" prefix |

#### Thesis / Dissertation Fields
| Field | Required | Notes |
|-------|----------|-------|
| Author | Yes | |
| Title | Yes | Followed by "[dissertation]" or "[master's thesis]" |
| City: University | Yes | |
| Year | Yes | |

---

### 6.10 Harvard (Author-Date)

**General rules:** No single official standard — varies by institution. Author-date system.

#### Book Fields
| Field | Required | Notes |
|-------|----------|-------|
| Author(s) | Yes | Last, F.M. format |
| Year | Yes | |
| Title | Yes | Italicized |
| Edition | No | "edn." suffix |
| Place | Yes | |
| Publisher | Yes | |
| DOI/URL | No | |

#### Journal Article Fields
| Field | Required | Notes |
|-------|----------|-------|
| Author(s) | Yes | |
| Year | Yes | |
| Article Title | Yes | Sometimes in single quotes |
| Journal Name | Yes | Italicized |
| Volume(Issue) | Yes | |
| Pages | Yes | "pp." prefix |
| DOI | No | |

#### Website Fields
| Field | Required | Notes |
|-------|----------|-------|
| Author / Organization | Yes | |
| Year | Yes | |
| Title | Yes | Italicized |
| "[online]" tag | Auto | |
| URL | Yes | "Available at:" prefix |
| Access Date | Yes | "[Accessed Day Month Year]" format |

#### Thesis / Dissertation Fields
| Field | Required | Notes |
|-------|----------|-------|
| Author | Yes | |
| Year | Yes | |
| Title | Yes | Italicized |
| **Type dropdown** | Yes | PhD thesis / Masters dissertation |
| University | Yes | |

**Variant dropdown (format-level):** Institutional variant (Anglia Ruskin, Cite Them Right, AGPS, etc.)

---

### 6.11 ASA 6th Edition

**General rules:** Author-date system. Very similar to Chicago Author-Date.

#### Book Fields
| Field | Required | Notes |
|-------|----------|-------|
| Author(s) | Yes | Last, First. format |
| Year | Yes | Period after year |
| Title | Yes | Italicized, title case |
| Place | Yes | City, ST: format |
| Publisher | Yes | |
| DOI/URL | No | |

#### Journal Article Fields
| Field | Required | Notes |
|-------|----------|-------|
| Author(s) | Yes | All authors listed (no et al. in list) |
| Year | Yes | |
| Article Title | Yes | In quotation marks |
| Journal Name | Yes | Italicized |
| Volume(Issue) | Yes | |
| Pages | Yes | |
| DOI | No | |

#### Website Fields
| Field | Required | Notes |
|-------|----------|-------|
| Author(s) / Organization | Yes | |
| Year | Yes | |
| Page Title | Yes | In quotation marks |
| Retrieved Date | Yes | |
| URL | Yes | In parentheses |

#### Conference Paper Fields
| Field | Required | Notes |
|-------|----------|-------|
| Author(s) | Yes | |
| Year | Yes | |
| Paper Title | Yes | In quotation marks |
| Presented at | Yes | Organization name |
| Date | Yes | |
| City, State | Yes | |

#### Thesis / Dissertation Fields
| Field | Required | Notes |
|-------|----------|-------|
| Author | Yes | |
| Year | Yes | |
| Title | Yes | In quotation marks |
| **Type dropdown** | Yes | PhD dissertation / MA thesis |
| Department, University | Yes | |
| City, State | Yes | |

---

## 7. Architecture of `bibliography-presets.ts`

### 7.1 Type Definitions

```typescript
interface CitationField {
  key: string;           // e.g., "author", "year", "title"
  label: string;         // e.g., "Author(s)", "Year"
  required: boolean;
  placeholder?: string;  // e.g., "Last, F. M."
  multiline?: boolean;   // true for author lists
  helpText?: string;     // e.g., "Use & before last author"
}

interface SourceTypeDefinition {
  id: string;            // e.g., "book", "journal", "website"
  label: string;         // e.g., "Book", "Journal Article"
  fields: CitationField[];
  variants?: {           // e.g., "Published proceedings" vs "Presentation"
    key: string;
    label: string;
    options: { value: string; label: string }[];
    affectsFields?: string[]; // fields that change based on variant
  }[];
}

interface CitationFormat {
  id: string;            // e.g., "apa7", "mla9", "ieee"
  label: string;         // e.g., "APA 7th Edition"
  sourceTypes: SourceTypeDefinition[];
  formatEntry(sourceType: string, fields: Record<string, string>, variant?: string): string;
  // Returns formatted AsciiDoc bibliography entry text
}
```

### 7.2 Format-to-AsciiDoc Conversion

Each `CitationFormat` has a `formatEntry()` method that takes filled fields and produces formatted text for a bibliography entry. For example, APA book:

```
Input:  { author: "Hunt, A., & Thomas, D.", year: "1999", title: "The Pragmatic Programmer", publisher: "Addison-Wesley" }
Output: "Hunt, A., & Thomas, D. (1999). _The Pragmatic Programmer_. Addison-Wesley."
```

The full AsciiDoc entry (with anchor) becomes:
```
* [[[pragprog]]] Hunt, A., & Thomas, D. (1999). _The Pragmatic Programmer_. Addison-Wesley.
```

### 7.3 Estimated Size

- ~9 format definitions × ~5 source types × ~6 fields average = ~270 field definitions
- Each format's `formatEntry()` function: ~30-50 lines
- Total estimated: ~800-1200 lines

---

## 8. Overlay Editor — Detailed Behavior

### 8.1 Opening the Overlay

- **Click on bibliography block** in preview mode → opens overlay
- **Cursor enters bibliography block** with overlay editing enabled → auto-opens (50ms delay, matching mermaid behavior)
- **Toolbar button** in Markup panel → inserts a new bibliography section skeleton and opens overlay

### 8.2 Left Panel Modes

#### Raw AsciiDoc Mode (Default)
- Full textarea with the raw bibliography section content
- Syntax: `* [[[label]]] Entry text...`
- No field validation or formatting assistance
- Live preview updates on the right with 300ms debounce

#### Preset Mode (e.g., APA)
- Top area: Format dropdown + Source Type dropdown
- Scrollable list of entry cards
- Each entry card contains:
  - A label/anchor ID field (e.g., `[[[label]]]`)
  - Optional xreftext field
  - Format-specific fields (author, year, title, etc.)
  - Source type dropdown (per-entry, allowing mixed source types)
  - Variant dropdown (if applicable for the source type)
  - Remove button
- "Add Entry" button at bottom
- Fields auto-generate formatted text in the preview

### 8.3 Right Panel (Preview)
- Renders the bibliography entries with proper formatting
- Scrollable independently
- Updates live as the user types/edits
- Shows both the formatted entry text and the anchor labels
- Renders inline AsciiDoc formatting (bold, italic, etc.)

### 8.4 Save Behavior
- **Raw mode**: Saves the textarea content directly back to the document
- **Preset mode**: Generates AsciiDoc from the structured fields and saves that
- Both modes produce valid `[bibliography]` section AsciiDoc

### 8.5 Cancel / Delete
- **Cancel**: Closes overlay, discards changes
- **Delete Section**: Removes the entire bibliography section from the document (with confirmation)

---

## 9. Toolbar Integration

### 9.1 Insert Bibliography Section

Add to the Markup panel (or a new "References" section):
- **"Bibliography"** button that inserts a skeleton:
  ```asciidoc
  [bibliography]
  == References

  * [[[ref1]]] Author. Title. Publisher. Year.
  ```
- If overlay editing is enabled, auto-opens the overlay after insertion

### 9.2 Insert Bibliography Reference

Add an inline insertion helper:
- **"Cite"** button or keyboard shortcut that inserts `<<label>>` at cursor
- Could show a dropdown of available bibliography labels for autocomplete

---

## 10. CSS Additions

### 10.1 Live Preview Theme (`EditorView.theme`)

```css
.cm-lp-bibliography { /* bibliography section wrapper */ }
.cm-lp-bibliography-heading { /* section heading */ }
.cm-lp-bibliography-entry { /* individual entry */ }
.cm-lp-biblio-anchor { /* [label] badge */ }
.cm-lp-biblio-ref { /* inline <<label>> reference */ }
```

### 10.2 Preview Pane (`preview.css`)

```css
#preview-pane .bibliography { /* Asciidoctor.js output */ }
#preview-pane .bibliography li { /* entry styling */ }
```

### 10.3 Overlay Editor

Reuse existing `.cm-lp-block-editor-*` and `.cm-lp-mermaid-editor-*` CSS classes. Add:

```css
.cm-lp-biblio-editor-panels { /* two-column layout */ }
.cm-lp-biblio-entry-card { /* individual entry card in preset mode */ }
.cm-lp-biblio-field { /* form field wrapper */ }
.cm-lp-biblio-format-select { /* format dropdown */ }
.cm-lp-biblio-source-select { /* source type dropdown */ }
```

---

## 11. Complexity Estimate

| Component | Estimated Lines | Difficulty |
|-----------|----------------|------------|
| Block detection + preview widget | ~200 | Medium |
| Inline reference rendering | ~50 | Low |
| Overlay editor (raw mode) | ~300 | Medium (reuse mermaid patterns) |
| Overlay editor (preset forms) | ~500 | High (dynamic form generation) |
| `bibliography-presets.ts` | ~1000-1200 | High (9 formats × 5 source types) |
| Format entry generators | ~400 | Medium (formatting rules) |
| CSS | ~100 | Low |
| Toolbar integration | ~50 | Low |
| **Total** | **~2600-2800** | |

---

## 12. Implementation Priority / Phases

### Phase 1: Core Bibliography Support
- Block detection for `[bibliography]` sections
- `[[[label]]]` anchor rendering in preview
- `<<label>>` reference rendering with bibliography awareness
- Basic preview widget (styled section)
- CSS for both live preview and Asciidoctor.js output

### Phase 2: Overlay Editor (Raw Mode)
- Two-panel overlay (reusing mermaid editor DOM structure)
- Raw AsciiDoc textarea on left, live preview on right
- Save/Cancel/Delete functionality

### Phase 3: Citation Format Presets
- `bibliography-presets.ts` with all 9+ format definitions
- Dynamic form generation based on selected format and source type
- Format-to-AsciiDoc conversion functions
- Source type and variant dropdowns per entry

### Phase 4: Toolbar & Autocomplete
- Bibliography section insertion button
- Inline citation reference insertion with label autocomplete
