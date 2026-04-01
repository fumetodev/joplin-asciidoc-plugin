# AI Tools Integration -- Concept & Implementation Report

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Provider Integration](#2-provider-integration)
3. [Settings & Configuration UI](#3-settings--configuration-ui)
4. [Core UX: The Mod+J Workflow](#4-core-ux-the-modj-workflow)
5. [AI Operations Catalog](#5-ai-operations-catalog)
6. [Context Strategy](#6-context-strategy)
7. [System Prompt Design](#7-system-prompt-design)
8. [Streaming & Preview UX](#8-streaming--preview-ux)
9. [Additional Features (Beyond Original Concept)](#9-additional-features-beyond-original-concept)
10. [Technical Architecture](#10-technical-architecture)
11. [Implementation Phases](#11-implementation-phases)
12. [Risk & Edge Cases](#12-risk--edge-cases)

---

## 1. Executive Summary

This document specifies the design for AI/LLM integration into the AsciiDoc Live Preview Editor plugin for Joplin. The feature allows users to invoke an LLM from within the editor to generate, rewrite, expand, summarize, and restructure AsciiDoc content -- with full awareness of the plugin's rendering capabilities.

**Core interaction:** Press `Mod+J` (Cmd+J on macOS, Ctrl+J on Windows/Linux) to open an inline prompt bar. Type a natural language instruction. The LLM streams a response into a preview overlay. The user reviews, optionally edits, then accepts or discards.

**Key design principles:**
- The LLM is a writing collaborator, not an autopilot -- the user always reviews and accepts
- Output is always valid AsciiDoc that renders correctly in this plugin's live preview
- Context-aware: the LLM knows the full document, cursor position, and plugin capabilities
- Provider-agnostic: works with cloud APIs (OpenRouter, OpenAI, Anthropic) and local servers (LM Studio, Ollama)
- Non-destructive: original content is never modified until the user explicitly accepts

---

## 2. Provider Integration

### 2.1 Supported Providers

| Provider | Type | Base URL | Auth Method | Model Listing | Streaming Format |
|----------|------|----------|-------------|---------------|------------------|
| OpenRouter | Cloud | `https://openrouter.ai/api/v1` | Bearer token (`Authorization` header) | `GET /models` (free, no auth) | SSE (OpenAI-compatible) |
| OpenAI | Cloud | `https://api.openai.com/v1` | Bearer token (`Authorization` header) | `GET /models` | SSE |
| Anthropic | Cloud | `https://api.anthropic.com/v1` | `x-api-key` header + `anthropic-version: 2023-06-01` | `GET /models` | SSE (Anthropic-specific events) |
| LM Studio | Local | `http://localhost:1234/v1` | Optional Bearer token | `GET /models` | SSE (OpenAI-compatible) |
| Ollama | Local | `http://localhost:11434` | None | `GET /api/tags` (native) or `GET /v1/models` (compat) | NDJSON (native) or SSE (`/v1` compat) |

### 2.2 Connection Flow

For every provider, the flow is identical from the user's perspective:

1. User selects a provider from the settings
2. User enters connection details (API key, or server IP/port for local providers)
3. User presses **Connect**
4. Plugin validates the connection with the lightest possible API call:
   - OpenRouter: `GET /api/v1/auth/key` (validates key)
   - OpenAI: `GET /v1/models` (validates key, returns models)
   - Anthropic: `GET /v1/models?limit=1` (validates key with minimal data)
   - LM Studio: `GET /v1/models` (checks server reachability)
   - Ollama: `GET /api/version` (checks server reachability), then `GET /api/tags` (lists models)
5. On success: models are fetched and loaded into the dropdown. Status shows "Connected".
6. On failure: error message displayed (invalid key, server unreachable, etc.)

### 2.3 Unified Client Architecture

Four of the five providers (OpenRouter, OpenAI, LM Studio, Ollama `/v1`) share the OpenAI-compatible API schema. The plugin should implement:

- **One OpenAI-compatible client** with configurable `baseURL`, `apiKey`, and optional extra headers
- **One Anthropic-specific client** (different request/response schema, different auth, different streaming events)

| Provider | Client | baseURL | apiKey | Extra Headers |
|----------|--------|---------|--------|---------------|
| OpenRouter | OpenAI-compat | `https://openrouter.ai/api/v1` | User's key | `HTTP-Referer`, `X-OpenRouter-Title` |
| OpenAI | OpenAI-compat | `https://api.openai.com/v1` | User's key | None |
| LM Studio | OpenAI-compat | `http://{ip}:{port}/v1` | Optional | None |
| Ollama | OpenAI-compat | `http://{ip}:{port}/v1` | `"ollama"` (dummy) | None |
| Anthropic | Anthropic client | `https://api.anthropic.com/v1` | User's key | `x-api-key`, `anthropic-version` |

### 2.4 Streaming Implementation

All HTTP requests and streaming happen in the **plugin sandbox** (Node.js context), since the webview cannot make network requests. Tokens are forwarded to the webview via Joplin's IPC messaging.

**For SSE providers (OpenAI-compatible):**
```
Plugin sandbox:
  fetch(url, { method: "POST", body, signal }) → ReadableStream
  → Parse SSE lines: split on "\n\n", extract "data:" prefix
  → For each chunk: extract choices[0].delta.content
  → Forward token to webview via editors.postMessage()
  → On "data: [DONE]": send completion signal
```

**For Anthropic SSE:**
```
Same fetch pattern, but parse Anthropic-specific events:
  event: content_block_delta → delta.text
  event: message_stop → completion signal
```

**For Ollama native NDJSON (fallback if /v1 not used):**
```
Read stream line-by-line, parse each as JSON:
  { message: { content: "token" }, done: false }
  { done: true } → completion signal
```

**Cancellation:** Use `AbortController` with `fetch()`. The webview sends a "cancel" IPC message; the plugin sandbox calls `controller.abort()`.

**Debouncing:** The webview should throttle re-renders to every ~50-100ms during streaming to avoid UI jank, accumulating tokens in a buffer between renders.

---

## 3. Settings & Configuration UI

### 3.1 Joplin Settings Section

A new settings section **"AI Tools"** (icon: `fas fa-robot`) registered via `joplin.settings.registerSection()`.

### 3.2 Settings Schema

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `asciidoc.aiEnabled` | Boolean | `true` | Master toggle for all AI features |
| `asciidoc.aiProvider` | Integer (enum) | `0` | Active provider: 0=OpenRouter, 1=OpenAI, 2=Anthropic, 3=LM Studio, 4=Ollama |
| `asciidoc.aiOpenRouterKey` | String | `""` | OpenRouter API key (marked `isSecure: true`) |
| `asciidoc.aiOpenRouterModel` | String | `""` | Selected OpenRouter model ID |
| `asciidoc.aiOpenAiKey` | String | `""` | OpenAI API key |
| `asciidoc.aiOpenAiModel` | String | `""` | Selected OpenAI model ID |
| `asciidoc.aiAnthropicKey` | String | `""` | Anthropic API key |
| `asciidoc.aiAnthropicModel` | String | `""` | Selected Anthropic model ID |
| `asciidoc.aiLmStudioHost` | String | `"localhost:1234"` | LM Studio server address |
| `asciidoc.aiLmStudioModel` | String | `""` | Selected LM Studio model ID |
| `asciidoc.aiOllamaHost` | String | `"localhost:11434"` | Ollama server address |
| `asciidoc.aiOllamaModel` | String | `""` | Selected Ollama model ID |
| `asciidoc.aiTemperature` | Integer | `100` | Temperature x100 (displayed as 0.00-2.00; stored as 0-200 for slider precision) |
| `asciidoc.aiMaxTokens` | Integer | `4096` | Max output tokens per request |
| `asciidoc.aiCustomInstructions` | String | `""` | User's custom system prompt additions (appended to base system prompt) |

**Note on model dropdowns:** Joplin's settings UI doesn't support dynamic dropdowns that populate from API calls. The "Connect" button and dynamic model list would need to be implemented as a **custom settings panel** rendered in the plugin's webview (similar to how the Edit AsciiDoc Attributes dialog works), or as a command that opens a dialog. The model ID is stored as a plain string setting and updated programmatically after the user selects from the fetched list.

### 3.3 Connect & Model Selection Workflow

Since Joplin's native settings UI is static (no dynamic dropdowns, no "Connect" button), the provider configuration should be done through a **dedicated dialog** accessible via:

- **Tools > Configure AI Provider** (menu command)
- **Editor toolbar > AI tab > Configure** (if an AI toolbar tab is added)

The dialog would show:
1. Provider selector (tabs or dropdown)
2. API key / server address input field
3. **Connect** button with status indicator (spinner, green check, red X)
4. Model dropdown (populated after successful connection)
5. Temperature slider (0.00 - 2.00, step 0.01)
6. Max tokens input
7. Custom instructions textarea
8. **Save** button

---

## 4. Core UX: The Mod+J Workflow

### 4.1 Invocation

**Keyboard shortcut:** `Mod+J` (Cmd+J on macOS, Ctrl+J on Windows/Linux) -- confirmed free across all platforms, Joplin, and Chromium.

**Alternative invocations:**
- Right-click context menu: "AI: Enhance Selection" / "AI: Generate at Cursor"
- Toolbar button in a new **AI** toolbar tab (or appended to the existing Text tab)

### 4.2 Behavior Depends on Selection State

| State | Behavior |
|-------|----------|
| **No selection, cursor on a line** | "Generate" mode -- AI inserts new content at cursor position |
| **Text selected** | "Edit" mode -- AI transforms/rewrites the selected text |
| **Empty line** | "Generate" mode -- AI writes new content at the empty line |
| **Entire document selected (Cmd+A)** | "Rewrite" mode -- AI restructures the full document |

### 4.3 Inline Prompt Bar

When `Mod+J` is pressed, an **inline prompt bar** appears directly below the current line (or selection), inspired by Cursor IDE's Cmd+K pattern. This keeps the user's eyes on their content rather than forcing them into a separate panel.

```
┌──────────────────────────────────────────────────────────────────┐
│ = My Document Title                                              │
│                                                                  │
│ * First list item                                                │
│ * Second list item  ← cursor is here                             │
│ ┌──────────────────────────────────────────────────────────────┐ │
│ │ 🤖 Ask AI: [expand this list with 5 more items about...   ] │ │
│ │     [Enter to send]  [Esc to cancel]  [▾ Quick actions]     │ │
│ └──────────────────────────────────────────────────────────────┘ │
│ * Third list item                                                │
│ * Fourth list item                                               │
└──────────────────────────────────────────────────────────────────┘
```

**Prompt bar features:**
- Auto-focuses the text input on open
- **Enter** sends the prompt to the LLM
- **Escape** dismisses without action
- **Shift+Enter** for multi-line prompts
- **Quick actions dropdown** (optional): pre-built operations like "Make shorter", "Fix grammar", "Continue writing", "Translate to..."
- Shows the active model name in a subtle badge (e.g., "claude-opus-4-6")
- Remembers last 10 prompts (session-scoped) for quick re-use via up/down arrows

### 4.4 Preview Overlay

After sending, the LLM's response streams into a **preview overlay** that appears below the prompt bar (or replaces the selected text area with a diff-style view):

```
┌──────────────────────────────────────────────────────────────────┐
│ * Second list item                                               │
│ ┌──────────────────────────────────────────────────────────────┐ │
│ │ 🤖 "expand this list with 5 more items about cooking"       │ │
│ ├──────────────────────────────────────────────────────────────┤ │
│ │ ┌ AI Preview ─────────────────────────────────────────────┐ │ │
│ │ │ * Preheat your oven to the correct temperature before   │ │ │
│ │ │   placing any dishes inside                             │ │ │
│ │ │ * Use a sharp knife -- dull blades require more force   │ │ │
│ │ │   and increase the risk of slipping                     │ │ │
│ │ │ * Taste as you go and adjust seasoning incrementally    │ │ │
│ │ │ * Let meat rest after cooking to redistribute juices    │ │ │
│ │ │ * Read the entire recipe before starting to avoid       │ │ │
│ │ │   surprises mid-cook                                    │ │ │
│ │ │                                    ▌ (streaming cursor) │ │ │
│ │ └─────────────────────────────────────────────────────────┘ │ │
│ │  [✓ Accept]  [✎ Edit]  [↻ Retry]  [✕ Discard]             │ │
│ └──────────────────────────────────────────────────────────────┘ │
│ * Third list item                                                │
└──────────────────────────────────────────────────────────────────┘
```

**Preview overlay features:**
- Content streams in real-time with a blinking cursor indicator
- The preview shows **rendered AsciiDoc** (not raw markup) using the plugin's existing `renderAsciidoc()` function -- so the user sees exactly how it will look
- A **raw/preview toggle** lets the user switch to raw AsciiDoc view to inspect the markup
- The preview box is editable -- the user can click into it and modify the AI's output before accepting
- **Stop** button appears during streaming to halt generation early

### 4.5 Action Buttons

| Button | Shortcut | Action |
|--------|----------|--------|
| **Accept** | `Enter` or `Cmd+Enter` | Insert the AI output at the cursor / replace the selection |
| **Edit** | `Tab` | Focus the preview for manual editing before accepting |
| **Retry** | `Cmd+Shift+R` | Regenerate with the same prompt (new response) |
| **Refine** | (type in prompt bar) | Keep the preview visible, type a follow-up instruction to modify it |
| **Discard** | `Escape` | Close the overlay, restore original content |

### 4.6 After Acceptance

When the user accepts:
1. The AI output replaces the selection (or is inserted at the cursor)
2. The prompt bar and preview close
3. The editor cursor is positioned at the end of the inserted content
4. The document is marked as modified (triggers auto-save)
5. The live preview system renders the new AsciiDoc normally

---

## 5. AI Operations Catalog

### 5.1 Quick Actions (Pre-built Operations)

These appear in the prompt bar's dropdown menu and can also be typed as natural language:

#### Writing & Content

| Operation | Description | Works On |
|-----------|-------------|----------|
| **Continue writing** | Extend the text naturally from the cursor position | Cursor at end of content |
| **Fill section** | Generate content for an empty or stub section based on its heading | Empty section with heading |
| **Fill note from template** | Use a saved template as a structural guide, AI fills in content | Entire note (fetches template list) |
| **Write draft** | Generate a first draft from a brief description | Empty note or section |
| **Brainstorm** | Generate a bullet list of ideas related to the topic | Any context |

#### Editing & Transformation

| Operation | Description | Works On |
|-----------|-------------|----------|
| **Improve writing** | Enhance clarity, flow, and word choice | Selected text |
| **Fix grammar & spelling** | Correct errors while preserving meaning and style | Selected text |
| **Make shorter** | Condense while retaining key information | Selected text |
| **Make longer** | Expand with more detail, examples, or explanation | Selected text |
| **Simplify language** | Reduce complexity for broader audience | Selected text |
| **Change tone** | Rewrite in a specified tone (formal, casual, technical, friendly) | Selected text |
| **Reformat** | Restructure content (e.g., prose to bullet list, list to table) | Selected text |

#### AsciiDoc-Specific

| Operation | Description | Works On |
|-----------|-------------|----------|
| **Convert to table** | Transform structured text into an AsciiDoc table | Selected text with tabular data |
| **Add admonitions** | Wrap key points in NOTE/TIP/WARNING/CAUTION blocks | Selected text |
| **Generate TOC structure** | Create a heading hierarchy for a topic | Empty note or section |
| **Create diagram** | Generate a Mermaid diagram block from a description | Natural language description |
| **Add code block** | Generate a code example in a specified language | Natural language description |
| **Create bibliography** | Generate bibliography entries from a list of references | List of references or topics |
| **Format as definition list** | Convert Q&A or term-explanation pairs to definition lists | Selected text |

#### Translation

| Operation | Description | Works On |
|-----------|-------------|----------|
| **Translate to [language]** | Translate content while preserving AsciiDoc markup | Selected text or full note |

#### Document-Level Operations

| Operation | Description | Works On |
|-----------|-------------|----------|
| **Summarize note** | Generate a concise summary at the top of the note | Full note |
| **Generate abstract** | Write an academic-style abstract | Full note |
| **Restructure note** | Reorganize sections for better logical flow | Full note |
| **Add section headings** | Insert heading structure into unstructured prose | Full note or section |

### 5.2 Free-Form Prompts

Beyond quick actions, the user can type any instruction:
- "Add a warning admonition about security risks after the third paragraph"
- "Convert this numbered list to a comparison table with pros and cons columns"
- "Write a Mermaid sequence diagram showing the authentication flow described above"
- "Rewrite this section in first person"
- "Add AsciiDoc cross-references linking to the related sections"

---

## 6. Context Strategy

### 6.1 What Gets Sent to the LLM

The context payload sent with every request:

```
┌─────────────────────────────────────────────────────┐
│ SYSTEM PROMPT (see Section 7)                       │
│   - Plugin capabilities                             │
│   - AsciiDoc syntax rules                           │
│   - Output format instructions                      │
│   - User's custom instructions (if any)             │
├─────────────────────────────────────────────────────┤
│ USER MESSAGE                                        │
│   - Document context (see below)                    │
│   - Cursor/selection position                       │
│   - User's instruction/prompt                       │
└─────────────────────────────────────────────────────┘
```

### 6.2 Document Context Tiers

To manage token budgets effectively, document context is sent in tiers:

**Tier 1: Immediate context (always sent)**
- The current line and 20 lines above/below the cursor
- The selected text (if any)
- Document title (first `= Title` line)
- Document attributes (`:toc:`, `:stem:`, etc.)

**Tier 2: Structural context (sent when tokens allow)**
- All section headings with their line numbers (document outline)
- The full content of the current section (from heading to next heading)

**Tier 3: Full document (sent for document-level operations)**
- The entire note body (stripped of sentinel)
- Used for: summarize, restructure, fill from template, translate full note

### 6.3 Token Budget Management

```
Available tokens = Model's context window - System prompt tokens - Max output tokens - Safety margin (200)

If full document fits in available tokens:
    Send full document (Tier 3)
Else if structural context fits:
    Send Tier 1 + Tier 2
Else:
    Send Tier 1 only + warning to user that context was truncated
```

The plugin should display the estimated token usage in the prompt bar (subtle indicator):
```
[prompt input...] 📊 ~2.4k / 128k tokens
```

### 6.4 Cursor Position Encoding

The cursor position is communicated to the LLM by inserting a marker in the document context:

```
* First list item
* Second list item
‹CURSOR_HERE›
* Third list item
```

For selections:
```
* First list item
‹SELECTION_START›* Second list item
* Third list item‹SELECTION_END›
* Fourth list item
```

The system prompt instructs the LLM to understand these markers and generate output appropriate for that position.

### 6.5 Template Context (for "Fill Note from Template")

When the user invokes "Fill note from template":
1. Plugin fetches the template list via existing IPC (`getTemplates()`)
2. User selects a template from a dropdown in the prompt bar
3. Plugin fetches template content via `getTemplateContent(templateId)`
4. Template content is included in the context as a structural guide:

```
USER MESSAGE:
Use the following template as a structural guide. Fill in each section with
content based on this topic: [user's description]

TEMPLATE:
= Project Proposal: {title}
== Overview
{brief description of the project}
== Goals
* {goal 1}
* {goal 2}
...
```

---

## 7. System Prompt Design

### 7.1 Base System Prompt

The system prompt is the most critical piece -- it determines the quality and correctness of all AI output. It must be carefully tuned for this specific plugin.

```
You are an expert AsciiDoc writing assistant integrated into the "AsciiDoc Notes"
editor plugin for Joplin. You help users write, edit, and structure AsciiDoc documents.

## Your Role
- Generate or transform text using ONLY valid AsciiDoc syntax
- Your output will be inserted directly into the user's document and rendered by the
  plugin's live preview engine
- Output ONLY the AsciiDoc content itself -- no explanations, no code fences, no
  preamble, no "Here's the result:" prefix
- If the user asks a question rather than requesting content, respond conversationally
  but still format your response as AsciiDoc (using paragraphs, lists, etc.)

## AsciiDoc Syntax Rules for This Plugin

The plugin's live preview engine renders the following constructs. Use ONLY these --
do not use constructs that require Asciidoctor extensions not present in this plugin.

### Headings
= Document Title (level 0, only one per document)
== Section (level 1)
=== Subsection (level 2)
==== Sub-subsection (level 3)
===== Level 4
====== Level 5

### Inline Formatting
*bold*                          Bold text
_italic_                        Italic text
`monospace`                     Inline code
[.underline]#underlined#        Underline
[.line-through]#struck#         Strikethrough
^superscript^                   Superscript
~subscript~                     Subscript
[.red]#colored text#            Font color (red, blue, green, purple, orange, teal, maroon, navy)
[.yellow-background]#highlighted#  Highlight (yellow, lime, aqua, pink, orange, silver, red, purple)

### Lists
* Bullet item                   Unordered list
** Nested bullet                Nested (**, ***, etc.)
. Numbered item                 Ordered list
.. Nested numbered              Nested (.., ..., etc.)
* [ ] Unchecked                 Checklist
* [x] Checked                   Checked checklist item
term:: definition               Definition list

### Links & Cross-References
link:https://example.com[Link Text]     External link
<<noteId,Display Text>>                  Cross-reference to another note
<<noteId#section,Display Text>>          Cross-reference with section anchor
footnote:[Footnote text]                 Footnote
footnote:name[Reusable footnote text]    Named/reusable footnote

### Code Blocks
[source,javascript]
----
const x = 1;
----

Supported languages: javascript, typescript, python, rust, java, html, css, json,
bash, sql, go, ruby (and any language -- these have toolbar shortcuts)

### Tables
[cols="1,2,3"]
|===
| Header 1 | Header 2 | Header 3

| Cell 1   | Cell 2   | Cell 3
| Cell 4   | Cell 5   | Cell 6
|===

Table attributes: cols (with alignment <, ^, >), options="header", frame, grid, stripes

### Admonitions
NOTE: Single-line note admonition.

[NOTE]
====
Multi-line note admonition block.
====

Types: NOTE, TIP, WARNING, CAUTION, IMPORTANT
(QUESTION is also supported as a custom type)

### Blocks
.Optional Title
****
Sidebar content
****

.Optional Title
====
Example content
====

[%collapsible]
====
Collapsible content -- click to expand/collapse
====

### Block Quotes
[quote, Attribution, Source]
____
Quoted text here.
____

### Images
image::https://example.com/photo.jpg[Alt text]
image:::/resourceId[Alt text]           (Joplin local resource)

Image attributes: alt, title, width (as percentage), align (center/left/right),
caption (with .Caption Title above the macro)

### Mermaid Diagrams
[mermaid]
....
flowchart LR
    A[Start] --> B[Process] --> C[End]
....

Supported types: flowchart, sequenceDiagram, classDiagram, stateDiagram-v2,
erDiagram, gantt, pie, journey, gitGraph, mindmap, timeline, quadrantChart,
sankey-beta, xychart-beta, block-beta, packet-beta, kanban, architecture,
C4Context, C4Container, C4Component, C4Deployment, requirementDiagram, zenuml

### Math (when :stem: is set in document attributes)
stem:[x^2 + y^2 = z^2]                  Inline math
latexmath:[E = mc^2]                      Inline LaTeX
asciimath:[sum_(i=1)^n i = (n(n+1))/2]   Inline AsciiMath

[latexmath]
++++
\int_0^\infty e^{-x^2} dx = \frac{\sqrt{\pi}}{2}
++++

### Horizontal Rules & Page Breaks
'''                             Horizontal rule
<<<                             Page break

### Macros
kbd:[Ctrl+C]                    Keyboard shortcut
btn:[Save]                      Button
menu:File[Save As]              Menu path

### Passthrough
+text+                          Inline passthrough
pass:[<b>raw HTML</b>]          Pass-through macro

### Document Attributes (set in document header)
:toc: auto                      Enable Table of Contents
:toclevels: 3                   TOC depth
:toc-title: Contents            Custom TOC title
:stem: latexmath                Enable math rendering

### Text Replacements (automatic)
(C) → ©    (R) → ®    (TM) → ™
-> → →     <- → ←     => → ⇒
-- → em dash    ... → ellipsis

## Output Rules

1. Output ONLY raw AsciiDoc markup -- never wrap in code fences (no ``` or ----)
2. Do not include document-level attributes (:toc:, :stem:, etc.) unless the user
   specifically asks for them -- these are managed separately
3. Do not include a document title (= Title) unless generating a full note
4. Match the style and voice of the surrounding content when editing
5. Preserve existing formatting conventions found in the document
6. When generating new sections, follow the heading hierarchy already in the document
7. For lists, match the nesting style (bullet depth, numbering style) already in use
8. Use AsciiDoc text replacements where natural (e.g., -- for em dash, (C) for copyright)
9. Never output Markdown syntax (no # headings, no **bold**, no - lists, no [text](url) links)
10. When asked to create a table, always include the cols attribute and header option
11. When asked to create a diagram, always use the [mermaid] block with .... delimiters
12. When asked to create a code block, always include [source,language] with ---- delimiters

## Understanding the Document

The user's document will be provided with cursor position markers:
- ‹CURSOR_HERE› marks the cursor position (for insertion)
- ‹SELECTION_START› and ‹SELECTION_END› mark selected text (for replacement)

When inserting: generate content appropriate for the cursor position's context
(inside a list, after a heading, within a table, etc.)

When replacing: transform only the selected text, preserving surrounding structure.
Output ONLY the replacement content -- do not repeat text outside the selection.
```

### 7.2 Operation-Specific Prompt Modifiers

These are appended to the base system prompt depending on the operation:

**Continue writing:**
```
Continue writing from the cursor position. Match the tone, style, and format of the
preceding content. Do not repeat any existing text. Begin your output exactly where
the cursor is.
```

**Improve writing:**
```
Improve the selected text for clarity, flow, and word choice. Preserve the original
meaning and AsciiDoc formatting. Do not add new sections or significantly expand the
content.
```

**Make shorter:**
```
Condense the selected text to approximately half its length while retaining all key
information. Preserve AsciiDoc formatting.
```

**Make longer:**
```
Expand the selected text with additional detail, examples, or explanation.
Approximately double the length. Preserve the existing AsciiDoc formatting and style.
```

**Reformat:**
```
Restructure the selected content into the format specified by the user (e.g., table,
list, definition list, prose). Preserve all information while changing the presentation.
```

**Fill from template:**
```
Use the provided template as a structural guide. Fill in each section with substantive
content based on the user's description. Preserve the template's heading structure,
list styles, and formatting patterns exactly. Replace placeholder text with real
content.

TEMPLATE:
{template content}
```

**Translate:**
```
Translate the following AsciiDoc content to {language}. Preserve ALL AsciiDoc markup
exactly as-is -- only translate the human-readable text content. Do not translate:
- AsciiDoc keywords (NOTE, TIP, WARNING, source, cols, etc.)
- Attribute names (:toc:, :stem:, etc.)
- Macro names (image::, link:, kbd:, btn:, menu:, etc.)
- Code block contents
- Mermaid diagram syntax
- URLs
```

**Create diagram:**
```
Generate a Mermaid diagram block based on the user's description. Use the most
appropriate diagram type. The output must be a complete [mermaid] block with ....
delimiters. Ensure the Mermaid syntax is valid and renders correctly.
```

### 7.3 User Custom Instructions

Users can add their own instructions (stored in settings) that are appended after the base system prompt:

```
## User's Custom Instructions
{asciidoc.aiCustomInstructions}
```

Examples a user might write:
- "Always use British English spelling"
- "Use formal academic tone"
- "Prefer bullet lists over numbered lists unless order matters"
- "Always add a NOTE admonition for important caveats"

---

## 8. Streaming & Preview UX

### 8.1 Streaming Architecture

```
┌──────────┐     IPC: aiGenerate      ┌──────────────┐      HTTP/SSE       ┌──────────┐
│  Webview  │ ──────────────────────→ │ Plugin Sandbox │ ──────────────────→ │ LLM API  │
│ (editor)  │                          │   (Node.js)    │                     │          │
│           │ ←── IPC: aiToken ─────── │                │ ←── SSE chunks ──── │          │
│           │ ←── IPC: aiDone ──────── │                │                     │          │
│           │ ←── IPC: aiError ──────  │                │                     │          │
│           │                          │                │                     │          │
│           │ ──── IPC: aiCancel ───→  │  abort()       │                     │          │
└──────────┘                          └──────────────┘                      └──────────┘
```

### 8.2 IPC Message Types

| Message | Direction | Payload |
|---------|-----------|---------|
| `aiGenerate` | Webview → Plugin | `{ prompt, context, operation, templateId? }` |
| `aiToken` | Plugin → Webview | `{ token: string }` |
| `aiDone` | Plugin → Webview | `{ fullText: string, tokensUsed: number }` |
| `aiError` | Plugin → Webview | `{ error: string }` |
| `aiCancel` | Webview → Plugin | `{}` |
| `aiGetModels` | Webview → Plugin | `{ provider, apiKey?, host? }` |
| `aiModelsResult` | Plugin → Webview | `{ models: [{ id, name, contextWindow? }], error? }` |

### 8.3 Preview Rendering During Streaming

During streaming, the preview overlay updates progressively:

1. **Raw mode (default during streaming):** Show the raw AsciiDoc as it streams in, with syntax highlighting. This is faster and avoids re-render flicker.
2. **Rendered mode (toggle):** Re-render the accumulated AsciiDoc to HTML every 200ms during streaming. After streaming completes, do one final render.
3. **After streaming completes:** Auto-switch to rendered preview so the user sees the final result as it will appear in the document.

### 8.4 Diff View (for Edit Operations)

When the AI is transforming selected text, show a side-by-side or inline diff:

```
┌─ Original ───────────────────┐ ┌─ AI Output ──────────────────┐
│ * First important item       │ │ * First important item       │
│ * second item not capitalized│ │ * Second item now capitalized│
│ * third item                 │ │ * Third item with better     │
│                              │ │   phrasing and detail        │
└──────────────────────────────┘ └──────────────────────────────┘
                    [✓ Accept]  [↻ Retry]  [✕ Discard]
```

Or inline with color coding:
- 🟢 Green background: added/changed text
- 🔴 Red background with strikethrough: removed text
- No highlight: unchanged text

---

## 9. Additional Features (Beyond Original Concept)

These are ideas inspired by research into Cursor, Copilot, Notion AI, Obsidian AI plugins, and Joplin's Jarvis plugin.

### 9.1 Ghost Text Autocomplete (Cursor Tab-style)

**Concept:** As the user types, the AI predicts what comes next and shows it as dimmed "ghost text" after the cursor. Press Tab to accept, Escape to dismiss.

**When it triggers:**
- After the user pauses typing for 1-2 seconds
- At the end of a sentence or paragraph
- After starting a list item (predicts the next item)
- After typing a heading (predicts section content)

**Implementation:** Uses a lightweight/fast model (or the same model with low max_tokens ~50-100) for quick predictions. The ghost text is rendered as a CodeMirror decoration with reduced opacity.

**Note:** This is an advanced feature and should be Phase 3 / optional. It requires careful debouncing and low-latency models to feel good.

### 9.2 Context Menu AI Operations

Right-click selected text to see AI options in the context menu:

```
┌─────────────────────────┐
│ Cut                      │
│ Copy                     │
│ Paste                    │
│ ─────────────────────── │
│ 🤖 AI: Improve Writing  │
│ 🤖 AI: Fix Grammar      │
│ 🤖 AI: Make Shorter     │
│ 🤖 AI: Make Longer      │
│ 🤖 AI: Translate to...  │
│ 🤖 AI: Custom Prompt... │
│ ─────────────────────── │
│ Select All               │
└─────────────────────────┘
```

### 9.3 AI Toolbar Tab

Add a fifth ribbon tab **"AI"** with quick-access buttons:

| Button | Action |
|--------|--------|
| Prompt | Open the Mod+J prompt bar |
| Continue | Continue writing from cursor |
| Improve | Improve selected text |
| Shorten | Make selected text shorter |
| Expand | Make selected text longer |
| Reformat | Reformat selection (shows format picker) |
| Translate | Translate selection (shows language picker) |
| Fill Note | Fill note from template |
| Summarize | Summarize the full note |
| Configure | Open AI provider configuration dialog |

### 9.4 Prompt History & Favorites

- Last 20 prompts stored in localStorage (session-persistent)
- Up/Down arrow keys in the prompt bar to cycle through history
- Users can "star" prompts to save them as favorites (persistent across sessions via Joplin settings)
- Favorites appear at the top of the quick actions dropdown

### 9.5 Selection-Aware Quick Actions

The prompt bar's quick actions should adapt based on what's selected:

| Context | Available Quick Actions |
|---------|------------------------|
| Nothing selected, empty line | Continue writing, Write draft, Brainstorm |
| Text selected | Improve, Shorten, Expand, Translate, Reformat, Fix Grammar |
| Code block selected | Explain code, Add comments, Refactor, Convert language |
| Table selected | Add rows, Restructure columns, Fill empty cells |
| List selected | Expand items, Reorder, Convert to table, Add detail |
| Full document selected | Summarize, Restructure, Translate, Add headings |
| Heading selected | Generate section content |

### 9.6 Multi-Turn Refinement

After the AI generates output, the user can type follow-up instructions in the prompt bar without dismissing the preview:

```
User: "Write an introduction paragraph"
AI: [generates paragraph]
User: "Make it more technical"
AI: [refines the paragraph]
User: "Add a NOTE admonition with a caveat"
AI: [adds the admonition]
[User accepts final version]
```

Each refinement sends the previous AI output as context along with the new instruction.

### 9.7 Note-to-Note Context (Future)

Allow the user to reference other notes in their prompt:

```
🤖 Ask AI: [Summarize this note using the style from @Meeting Template]
```

The `@` trigger opens the note search autocomplete (reusing the existing wiki-link completion), and the referenced note's content is included in the context.

---

## 10. Technical Architecture

### 10.1 New Files

```
src/
├── lib/
│   ├── ai/
│   │   ├── providers.ts          # Provider abstraction (OpenAI-compat + Anthropic clients)
│   │   ├── streaming.ts          # SSE/NDJSON parsing, token forwarding
│   │   ├── system-prompt.ts      # System prompt builder (base + operation modifiers)
│   │   ├── context-builder.ts    # Document context extraction, token estimation
│   │   └── config-dialog.ts      # AI provider configuration dialog (webview-side)
│   ├── toolbar/
│   │   └── panels/
│   │       └── ai-panel.ts       # AI toolbar tab (webview-side)
│   └── editor/
│       └── ai-prompt-bar.ts      # Inline prompt bar & preview overlay (webview-side)
```

### 10.2 Plugin Sandbox Additions (index.ts)

New IPC message handlers:
- `aiGenerate` -- receives prompt + context, calls LLM API, streams tokens back
- `aiCancel` -- aborts in-flight request
- `aiGetModels` -- connects to provider, returns model list
- `aiGetConfig` -- returns current AI settings
- `aiSaveConfig` -- updates AI settings
- `aiGetTemplateList` -- returns templates for "fill from template" (reuses existing logic)

New settings registration:
- All settings from Section 3.2

### 10.3 Webview Additions

New keybinding in `keybindings.ts`:
- `Mod-j` -- opens the AI prompt bar

New IPC functions in `ipc.ts`:
- `aiGenerate(prompt, context, operation)`
- `aiCancel()`
- `aiGetModels(provider, credentials)`

New UI components:
- `ai-prompt-bar.ts` -- inline prompt bar DOM construction, event handling
- `ai-panel.ts` -- toolbar tab with quick action buttons
- `config-dialog.ts` -- provider configuration modal

### 10.4 Data Flow for a Typical Request

```
1. User presses Mod+J
   → keybindings.ts dispatches "ai-prompt-open" event
   → ai-prompt-bar.ts creates and shows the inline prompt bar

2. User types "expand this list" and presses Enter
   → ai-prompt-bar.ts calls contextBuilder.buildContext(view)
   → Returns: { document, cursorPosition, selection, headings, attributes }
   → ai-prompt-bar.ts calls ipc.aiGenerate(prompt, context, "freeform")

3. Webview sends IPC message to plugin sandbox
   → index.ts receives "aiGenerate" message
   → Reads provider settings (which provider, API key, model, temperature)
   → system-prompt.ts builds the full system prompt
   → providers.ts creates the appropriate HTTP request
   → streaming.ts handles the SSE/NDJSON stream

4. Plugin sandbox streams tokens back
   → For each token: editors.postMessage(handle, { type: "aiToken", token })
   → ai-prompt-bar.ts appends token to preview buffer
   → Every ~100ms: re-render preview overlay

5. Stream completes
   → Plugin sends: { type: "aiDone", fullText, tokensUsed }
   → ai-prompt-bar.ts shows final rendered preview with action buttons

6. User clicks Accept
   → ai-prompt-bar.ts dispatches view.dispatch({ changes: ... })
   → Prompt bar and preview close
   → Live preview decorations update normally
```

### 10.5 Error Handling

| Error | User-Facing Message | Recovery |
|-------|---------------------|----------|
| API key invalid | "Authentication failed. Check your API key in AI settings." | Open config dialog |
| Server unreachable | "Cannot reach [provider]. Check your connection." | Retry button |
| Rate limited | "Rate limited. Waiting {n} seconds..." | Auto-retry with backoff |
| Context too long | "Document too large for this model. Sending truncated context." | Proceed with Tier 1 context |
| Model not found | "Model '{name}' not available. Select a different model." | Open config dialog |
| Stream interrupted | "Generation interrupted. Partial result shown." | Show partial output with Accept/Retry |
| Invalid output | (rare) "AI output contained invalid markup." | Show raw output for manual editing |

---

## 11. Implementation Phases

### Phase 1: Foundation (MVP)

**Goal:** Basic Mod+J → prompt → generate → accept workflow with one provider.

- [ ] Provider abstraction layer (OpenAI-compatible client only -- covers OpenRouter, OpenAI, LM Studio, Ollama)
- [ ] Settings registration (AI section with provider, key, model, temperature)
- [ ] IPC messages for aiGenerate, aiToken, aiDone, aiError, aiCancel
- [ ] SSE stream parsing and token forwarding
- [ ] Connect & model listing flow (via Tools > Configure AI Provider dialog)
- [ ] Base system prompt (Section 7.1)
- [ ] Context builder (Tier 1 + Tier 3 for full document)
- [ ] Mod+J keybinding
- [ ] Inline prompt bar (basic: text input, Enter to send, Escape to cancel)
- [ ] Preview overlay (raw AsciiDoc streaming, rendered on completion)
- [ ] Accept / Discard buttons
- [ ] Cancellation support (AbortController)

### Phase 2: Full Provider Support & Quick Actions

**Goal:** All 5 providers working, quick actions, edit operations, diff view.

- [ ] Anthropic-specific client (different auth, streaming, request format)
- [ ] All 5 providers fully implemented and tested
- [ ] Quick actions dropdown in prompt bar (Improve, Shorten, Expand, Fix Grammar, Continue)
- [ ] Operation-specific prompt modifiers (Section 7.2)
- [ ] Selection-aware behavior (generate vs. edit mode)
- [ ] Diff view for edit operations
- [ ] Retry / Refine buttons
- [ ] Rendered preview toggle (raw ↔ rendered during streaming)
- [ ] Token budget management and context tier selection
- [ ] Prompt history (up/down arrows)
- [ ] AI toolbar tab with quick action buttons

### Phase 3: Advanced Features

**Goal:** Template filling, diagrams, translation, context menu, ghost text.

- [ ] Fill note from template (template selection + AI content generation)
- [ ] Create diagram operation (Mermaid generation with preview)
- [ ] Translation support (with language selector)
- [ ] Context menu AI operations
- [ ] Multi-turn refinement (follow-up prompts without dismissing preview)
- [ ] Prompt favorites (persistent across sessions)
- [ ] Selection-aware quick actions (adapts based on what's selected)
- [ ] Custom instructions setting
- [ ] Ghost text autocomplete (experimental, optional toggle)
- [ ] Note-to-note context (`@` mentions in prompt)

---

## 12. Risk & Edge Cases

### 12.1 Technical Risks

| Risk | Mitigation |
|------|------------|
| Joplin's IPC may not support high-frequency messaging (token streaming) | Batch tokens: send every 50ms instead of per-token. Test throughput. |
| Plugin sandbox may restrict `fetch()` or `https` module | Test early. If restricted, use Joplin's `require()` for Node.js HTTP. Joplin plugins can use Node built-ins. |
| Large documents may exceed model context windows | Implement context tiers (Section 6.2). Show warning when truncating. |
| AI-generated AsciiDoc may contain syntax errors | Validate output before insertion (run through Asciidoctor and check for errors). Show raw output for manual fixing if invalid. |
| Streaming may cause scroll jumps (same issue as paste) | Apply the same scroll stabilization fix from the docChanged stabilization. |
| Multiple rapid Mod+J presses could create race conditions | Disable Mod+J while a request is in-flight. Show "generating..." state. |

### 12.2 UX Risks

| Risk | Mitigation |
|------|------------|
| User inserts AI content that breaks document structure | Validate heading levels, list nesting, block delimiters before insertion |
| AI generates Markdown instead of AsciiDoc | Strong system prompt instructions. Post-process: detect and convert common Markdown patterns |
| AI output is too long / too short | Max tokens setting. Quick "Make shorter" / "Make longer" refinement |
| User accidentally accepts bad output | Consider adding undo support: after accepting, Cmd+Z should undo the entire AI insertion as one atomic operation (single CodeMirror transaction) |
| Latency on first request (cold model load for local providers) | Show "Loading model..." indicator. Consider a "warm up" button in config dialog |

### 12.3 Security & Privacy

| Concern | Approach |
|---------|----------|
| API keys stored in settings | Use Joplin's `isSecure: true` setting flag (encrypted at rest) |
| Note content sent to cloud APIs | Clear warning in settings: "Your note content is sent to the selected AI provider." Recommend local providers (LM Studio, Ollama) for sensitive content |
| AI-generated content accuracy | Always show preview before insertion. User must explicitly accept. |
| Cost control | Display token usage estimates. Warn for large context sends. |

---

*This document was generated as a comprehensive design specification. Implementation should proceed in the phases outlined in Section 11, with Phase 1 as the MVP target.*
