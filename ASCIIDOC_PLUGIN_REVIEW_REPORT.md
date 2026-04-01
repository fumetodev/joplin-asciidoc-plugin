# AsciiDoc Live Preview Editor Review Report

## Scope

This report reviews the current codebase for the Joplin plugin in this repository and compares its implemented behavior against the official Asciidoctor/AsciiDoc documentation at `docs.asciidoctor.org`.

I reviewed the code paths that define the plugin's behavior:

- `src/index.ts`
- `src/panel.ts`
- `src/lib/editor/live-preview.ts`
- `src/lib/editor/asciidoc-language.ts`
- `src/lib/editor/wiki-link-completion.ts`
- `src/lib/editor/spellcheck.ts`
- `src/lib/toolbar/*`
- `src/lib/utils/*`
- `README.md`

I also ran `npm run build`. The build succeeded. No automated test suite or `test` script was present in `package.json`.

## Executive Summary

The plugin is ambitious and useful, but it is not a full Asciidoctor-equivalent editor. The most important architectural fact is that the user-visible "live preview" is primarily a custom regex/block-parser implemented in `src/lib/editor/live-preview.ts`, while Asciidoctor.js is used only in narrower places such as sandbox rendering, section-preview rendering, and copy/render flows (`src/index.ts:425`, `src/index.ts:934`, `src/lib/editor/live-preview.ts:6829`).

That split leads to the plugin's biggest strengths and biggest risks:

- Strengths:
  - strong Joplin-specific UX
  - custom block editors for code, tables, images, quotes, math, bibliography, and Mermaid
  - note-to-note linking, templates, spellcheck, Markdown conversion
  - good combined editing/preview ergonomics
- Risks:
  - standards drift between live preview and real Asciidoctor behavior
  - several README claims overstate current standards coverage
  - advanced AsciiDoc constructs are only partially supported while editing
  - some plugin-specific syntax/features are not portable AsciiDoc

## Architecture Overview

### What the code actually does

- The sandbox/plugin side registers commands, settings, note conversion, template tagging, and Asciidoctor.js rendering in `src/index.ts`.
- The editor webview is a CodeMirror 6 editor plus a custom live-preview engine in `src/panel.ts` and `src/lib/editor/live-preview.ts`.
- AsciiDoc notes are identified by a plugin-specific sentinel block appended to the note body:
  - `src/index.ts:34`
  - `src/index.ts:51`
  - `README.md:220`

### Important implication

The note body is not plain portable AsciiDoc in storage. It contains a Markdown fenced block:

- ```` ```asciidoc-settings ```` sentinel trailer for settings and document attributes

That is a pragmatic implementation choice for Joplin, but it means the stored note body is plugin-specific until stripped.

## High-Level Capability Assessment

### Capabilities the plugin adds beyond standard AsciiDoc docs

These are useful product features, but they are plugin extensions rather than standard AsciiDoc features:

- combined editor/preview UX
- Joplin note cross-reference autocomplete and note navigation
- Joplin resource-aware image insertion (`:/resourceId`)
- block-edit modals for tables, code blocks, images, math, Mermaid, bibliography
- spell checker and personal dictionary
- note templates via Joplin tags
- Markdown-to-AsciiDoc conversion helpers
- Mermaid diagram preview/editing

Relevant code:

- Joplin note autocomplete: `src/lib/editor/wiki-link-completion.ts`
- templates: `src/index.ts:450`
- Mermaid: `src/lib/editor/live-preview.ts:2540`
- spellcheck: `src/lib/editor/spellcheck.ts`
- Markdown conversion: `src/index.ts:58`

### Core standards comparison

The best way to understand the plugin is to separate:

1. **Asciidoctor final rendering capability**
2. **What the user actually sees while editing in the combined live preview**

| Area | Asciidoctor docs baseline | Plugin final render | Plugin live preview/editor | Notes |
|---|---|---|---|---|
| Section titles | Standard AsciiDoc supports document title + nested section levels | Mostly yes via Asciidoctor.js | Partial | Many editor paths only match `={1,5}` or `={2,5}` and miss `======` level-5 sections |
| Inline formatting | Bold, italic, monospace, roles, replacements, pass macros, etc. | Mostly yes | Partial | Many common inline forms work, but behavior is regex-driven, not AST-driven |
| Lists | Ordered, unordered, checklists, definition lists | Yes | Mostly yes | Basic lists are good; numbering/continuation rules are simplified |
| Footnotes | Standard footnote and named footnote syntax | Yes | Mostly yes | Named footnotes are supported in preview |
| Images | Rich macro syntax, sizing, links, captions, roles | Yes | Partial | Basic block/inline image support is good; sizing/alignment semantics differ |
| Tables | Full AsciiDoc table model | Yes | Partial / risky | Simple pipe tables work; advanced table semantics are not preserved by the editor model |
| Admonitions | Standard five types | Yes | Partial + custom extension | Preview adds nonstandard `QUESTION` |
| Source blocks | Source/listing blocks plus optional source highlighter config | Basic blocks yes | Partial | Language labels and callouts exist, but no actual syntax highlighting |
| Cross references | Full xref model, auto IDs, custom IDs | Yes | Limited/custom | Live preview navigation is mainly built around Joplin note IDs, not general AsciiDoc xrefs |
| TOC | `:toc:`, `toc::[]`, `:toclevels:`, `:toc-title:` | Yes | Partial | Basic TOC rendering exists, but heading-depth handling is narrower than docs |
| Include directive | Standard include directive | Conditional/fragile | No real preview support | No meaningful per-note base dir; live preview just styles the line |
| Conditionals/comments | `ifdef`, `ifndef`, `ifeval`, comment blocks, etc. | Asciidoctor supports them | Largely unsupported in preview | Preview engine does not model most preprocessor constructs |
| STEM | `stem:[]`, `latexmath:[]`, `asciimath:[]`, stem attr | Yes | Yes | One of the stronger areas |
| Mermaid | Not standard AsciiDoc | No standard support found | Yes | Preview-only custom feature; I found no Asciidoctor extension registration for it |

## Detailed Findings

### 1. Cross-reference and section-ID handling is inconsistent and will break valid AsciiDoc cases

**Severity:** Medium

The plugin's editor-side section ID and xref handling is a simplified, custom implementation rather than real Asciidoctor ID resolution.

Evidence:

- section list generation: `src/index.ts:1107`
- editor-side inline xref rendering: `src/lib/editor/live-preview.ts:3486`
- click behavior only opens note IDs that match Joplin/UUID-like IDs: `src/lib/editor/live-preview.ts:2978`
- section extraction for preview uses a separate algorithm: `src/lib/editor/live-preview.ts:6791`

Problems:

- `getNoteSections()` matches `={1,5}` and invents anchors by slugging heading text (`src/index.ts:1115`).
- `extractSection()` matches `={2,6}` and uses a different scope (`src/lib/editor/live-preview.ts:6797`).
- That means the editor can autocomplete a document title anchor from `= Title`, but the preview extractor will never find it.
- Neither path respects explicit IDs like `[[id]]`.
- Neither path respects `idprefix` / `idseparator` variations from standard Asciidoctor configuration.
- Duplicate heading disambiguation is not implemented.

Compared to the docs:

- Official docs define auto-generated IDs and xrefs more broadly than the plugin's editor model.
- Relevant docs:
  - https://docs.asciidoctor.org/asciidoc/latest/sections/auto-ids/
  - https://docs.asciidoctor.org/asciidoc/latest/macros/xref/

Impact:

- section autocomplete can generate anchors that do not resolve in preview
- valid standard AsciiDoc cross-references can display as inert text in live preview
- portability is reduced because the plugin encourages Joplin note-ID xrefs instead of standard document-anchored xrefs

### 2. The plugin introduces a nonstandard `QUESTION` admonition that does not match standard AsciiDoc

**Severity:** Medium

The plugin's toolbar and live preview support `QUESTION`, but standard AsciiDoc admonitions are the canonical five only.

Evidence:

- toolbar option: `src/lib/toolbar/toolbar-actions.ts:90`
- live preview paragraph handling: `src/lib/editor/live-preview.ts:3146`
- README claim: `README.md:121`

Compared to the docs:

- Official admonition types are `NOTE`, `TIP`, `IMPORTANT`, `CAUTION`, and `WARNING`.
- Relevant docs:
  - https://docs.asciidoctor.org/asciidoc/latest/blocks/admonitions/

Impact:

- a note that looks correct in the plugin preview can become nonportable AsciiDoc
- users may believe `QUESTION` is standard when it is actually a plugin-specific extension

Recommendation:

- either remove `QUESTION`
- or explicitly document it as a custom plugin-only extension
- or implement it as a role-based/custom block distinct from standard admonition syntax

### 3. Code blocks do not provide actual syntax highlighting despite the README claim

**Severity:** Medium

The README says code blocks render with syntax highlighting, but the current implementation only shows a language label and plain text.

Evidence:

- README claim: `README.md:115`
- preview widget uses plain text nodes only: `src/lib/editor/live-preview.ts:3959`
- Asciidoctor render config does not set a source highlighter: `src/index.ts:425`

Compared to the docs:

- Asciidoctor supports source-highlighter configuration rather than automatic syntax coloring.
- Relevant docs:
  - https://docs.asciidoctor.org/asciidoc/latest/verbatim/source-highlighter/

Impact:

- user expectations set by the README are not met
- code-heavy notes lose one of the main benefits the plugin advertises

Recommendation:

- either wire a real highlighter into the live preview and/or final render
- or downgrade the README wording from "syntax highlighting" to "language label + formatted block"

### 4. Advanced table syntax is at risk of being misrendered or destructively normalized by the editor

**Severity:** Medium

The table model in the live editor is based on simple pipe splitting, not on Asciidoctor's actual table grammar.

Evidence:

- block detection for table attributes is heuristic: `src/lib/editor/live-preview.ts:2604`
- table parser flattens rows by splitting on `|`: `src/lib/editor/live-preview.ts:2686`
- serialization writes only a simplified `|===` table: `src/lib/editor/live-preview.ts:2756`

Problems:

- header detection is based on a blank line heuristic instead of full option semantics
- cell specs such as `a|`, `h|`, `2+|`, etc. are not modeled
- column specs and many table options are not preserved
- multiline cells and richer cell styles are not represented in the edit widget

Compared to the docs:

- Official table syntax is much richer than the plugin's editor model.
- Relevant docs:
  - https://docs.asciidoctor.org/asciidoc/latest/tables/add-cells-and-rows/
  - https://docs.asciidoctor.org/asciidoc/latest/syntax-quick-reference/

Impact:

- simple tables are fine
- advanced tables may preview incorrectly
- opening advanced tables in the table editor risks flattening them into the plugin's simplified format

### 5. The sandbox renders full Asciidoctor HTML on note updates even though the webview does not use it

**Severity:** Low to Medium

This is a performance/design issue rather than a correctness bug.

Evidence:

- sandbox renders HTML on every note update and ready handshake: `src/index.ts:934`, `src/index.ts:960`, `src/index.ts:976`
- the webview ignores `html` and only uses `id` and `body`: `src/panel.ts:782`

Impact:

- unnecessary Asciidoctor conversion work on note load/update
- avoidable CPU cost on large notes
- misleading architecture because `lastNote.html` looks important but is effectively dead data in the main editor flow

Recommendation:

- stop pre-rendering HTML for the main editor update path
- or use it consistently if a real final-render preview is reintroduced

### 6. README and implementation have drifted apart

**Severity:** Low

Key documentation drift points:

- README says inline preview is "powered by Asciidoctor.js", but the main live preview is custom (`README.md:9`, `src/lib/editor/live-preview.ts`)
- README says code blocks have syntax highlighting, but they do not (`README.md:115`, `src/lib/editor/live-preview.ts:3988`)
- README architecture section says bundle sizes are about `10 KB` / `847 KB`, but the current production build generated much larger artifacts (`README.md:211`; current build produced `index.js` about `802 KiB` and `panel.js` about `5.3 MiB`)

Impact:

- user expectations are set incorrectly
- maintainers may diagnose the wrong runtime architecture

## Capability Gaps vs Official Docs

### Well-covered areas

These areas are reasonably strong for both product value and standards alignment:

- basic headings and document attributes
- bold/italic/monospace/super/sub/basic roles
- bullets, ordered lists, checklists, definition lists
- footnotes, including named footnotes
- basic source/listing blocks and callout badges
- block quotes
- images with title/caption/alignment controls
- STEM/LaTeX/AsciiMath preview
- basic TOC support

### Partial or fragile areas

These are the main places where the plugin falls short of the docs:

- section depth and section-ID fidelity
- xrefs beyond the plugin's Joplin note-ID flow
- advanced tables
- include handling
- code highlighting
- advanced block variants
- preprocessor directives and conditionals
- comment blocks and some passthrough block forms

### Likely unsupported or only weakly represented in the live preview

I did not find robust editor-side handling for:

- explicit section IDs and full xref resolution
- discrete headings
- open blocks (`--`)
- literal/pass/comment blocks as distinct first-class blocks
- conditionals (`ifdef`, `ifndef`, `ifeval`)
- advanced include use
- advanced table cell/column semantics
- standard source-highlighter integration

For these, the final Asciidoctor renderer may still understand the syntax, but the combined editor view generally will not give faithful inline behavior.

## Plugin-Specific Design Notes

### Sentinel-based note type detection

The plugin stores note metadata in a trailing Markdown fenced block:

- detection: `src/index.ts:34`
- write path: `src/index.ts:51`

This works inside Joplin, but it is a portability tradeoff. External AsciiDoc tooling will not treat that trailer as valid AsciiDoc metadata.

### Image sizing semantics differ from docs

The image serializer writes percentage widths/heights:

- `src/lib/utils/image-macro.ts:99`

The official docs recommend width/height values as unitless integers and explicitly caution against relying on percentage values for those attributes in the way the plugin currently does.

Relevant docs:

- https://docs.asciidoctor.org/asciidoc/latest/macros/image-size/

### Include handling is only partially wired

The live preview merely styles `include::...[]` as a raw line:

- `src/lib/editor/live-preview.ts:3232`

The final renderer uses Asciidoctor.js in `safe` mode:

- `src/index.ts:433`

But the renderer is fed a source string, not a real note file with a meaningful per-note filesystem base directory. Per the docs, includes from streamed/string input default to the current working directory unless configured otherwise.

Relevant docs:

- https://docs.asciidoctor.org/asciidoc/latest/directives/include/

Practical result:

- include behavior is fragile and environment-dependent inside Joplin
- live preview gives no real include expansion feedback

### Mermaid appears to be preview-only

I found Mermaid implemented entirely on the editor side:

- detection/rendering: `src/lib/editor/live-preview.ts:2540`
- rendering utility: `src/lib/utils/mermaid-render.ts`

I did **not** find any Asciidoctor extension registration for Mermaid in the sandbox render path. That suggests Mermaid is a plugin-only live-preview feature rather than a true Asciidoctor feature. This is an inference from the current code.

## Validation Notes

- `npm run build` succeeded.
- The build emitted webpack performance warnings because `panel.js` is large.
- I did not find an automated test suite.

## Recommended Next Actions

1. Decide whether the product goal is:
   - a standards-faithful Asciidoctor editing experience, or
   - a Joplin-first rich editor with partial AsciiDoc compatibility
2. If standards fidelity matters, prioritize:
   - xref/ID correctness
   - table-model correctness
   - source-highlighter support
   - explicit documentation of custom extensions such as `QUESTION` and Mermaid
3. Add regression tests around:
   - section IDs and xrefs
   - advanced tables
   - include behavior
   - Markdown conversion semantics
   - live-preview parity for standard doc examples from the Asciidoctor docs

## Official Docs Used For Comparison

- https://docs.asciidoctor.org/asciidoc/latest/syntax-quick-reference/
- https://docs.asciidoctor.org/asciidoc/latest/blocks/admonitions/
- https://docs.asciidoctor.org/asciidoc/latest/sections/titles-and-levels/
- https://docs.asciidoctor.org/asciidoc/latest/sections/auto-ids/
- https://docs.asciidoctor.org/asciidoc/latest/macros/xref/
- https://docs.asciidoctor.org/asciidoc/latest/macros/footnote/
- https://docs.asciidoctor.org/asciidoc/latest/macros/image-size/
- https://docs.asciidoctor.org/asciidoc/latest/tables/add-cells-and-rows/
- https://docs.asciidoctor.org/asciidoc/latest/verbatim/source-highlighter/
- https://docs.asciidoctor.org/asciidoc/latest/directives/include/
- https://docs.asciidoctor.org/asciidoc/latest/toc/
