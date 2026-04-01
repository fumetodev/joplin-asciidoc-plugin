# Include Directive: Current State and Implementation Path

## Current State

**The plugin has no meaningful `include::` directive support.** The directive is recognized syntactically but not processed.

### What exists today

1. **Line classification** (`isParagraphLikeLine()`, line 1941): `include::` lines return `false`, so they're not treated as paragraphs.

2. **Visual rendering** (`renderLineHtml()`, line 3240): Include lines are displayed as greyed-out italic placeholder text showing the raw directive string:
   ```
   include::chapter-01.adoc[leveloffset=+1]
   ```
   No expansion, no file resolution, no error feedback.

3. **Asciidoctor.js final render** (`renderAsciidoc()`, line 425 in index.ts): The plugin passes the source string to Asciidoctor.js with `safe: "safe"` mode and no `base_dir`. This means:
   - Asciidoctor.js *attempts* to process includes, but relative paths resolve against the Node.js process working directory (not the note's location)
   - No Joplin-aware path resolution exists
   - Results are environment-dependent and effectively broken

### What does NOT exist

- No file path resolution for include targets
- No `base_dir` configuration for Asciidoctor.js
- No IPC messages for file system access from the webview
- No Asciidoctor.js extension registry hooks for custom include handling
- No live preview expansion of included content
- No feedback about missing/unresolvable files
- No support for Joplin-internal cross-note includes

---

## The AsciiDoc Include Directive Specification

The include directive is a **preprocessor directive** -- it operates before document parsing, performing textual file expansion. The directive line is replaced with the target file's contents.

### Syntax

```
include::target[attributes]
```

### Key Attributes

| Attribute | Purpose |
|---|---|
| `leveloffset` | Adjusts heading levels (`+1`, `-1`, absolute `0`-`5`) |
| `lines` | Selects line ranges (`lines=5..10`, `lines=7;14..25`) |
| `tag` / `tags` | Selects tagged regions (`tag=parse`, `tags=timings;parse`) |
| `indent` | Controls indentation of included verbatim content |
| `encoding` | Specifies character encoding of target file |
| `opts=optional` | Silently drops include if target not found |

### Path Resolution

- Relative paths resolve against the **including file's directory** (not the top-level document)
- Absolute paths require UNSAFE mode
- Attribute references allowed in paths: `include::{sourcedir}/Main.java[]`

### Security Modes

| Mode | Value | Include Behavior |
|---|---|---|
| UNSAFE | 0 | No restrictions |
| SAFE | 1 | Restricted to parent directory of source file |
| SERVER | 10 | Same as SAFE + attribute restrictions |
| SECURE | 20 | **Includes disabled entirely** (converted to link) |

### Recursive Includes

Files with AsciiDoc extensions (`.adoc`, `.asciidoc`, `.ad`, `.asc`, `.txt`) have the preprocessor run on their contents, enabling nested includes. Non-AsciiDoc files are inserted as-is.

### Missing Targets

- Default: warning + placeholder text "Unresolved directive in ... - include::..."
- With `opts=optional`: silently dropped, no output

---

## Implementation Challenges in Joplin

### 1. Joplin has no traditional file system

Joplin notes are stored in a database, not as files on disk. There's no directory structure, no relative paths between notes, no file system to resolve `include::chapter-01.adoc[]` against. This is the fundamental challenge.

### 2. Two rendering paths need support

- **Live preview** (CM6 decorations in webview): Needs to display expanded content inline, updating in real-time as the user edits
- **Final render** (Asciidoctor.js in Node sandbox): Needs actual file content for correct HTML output

### 3. The webview has no file system access

The CM6 editor runs in a sandboxed webview. It cannot read files. All file content must be fetched via IPC to the plugin sandbox (index.ts), which has access to the Joplin data API and Node.js `fs`.

### 4. Performance for live preview

Include expansion during live editing must be fast enough to not block typing. Large included files, recursive includes, and remote URI includes all pose latency risks.

---

## Implementation Path

### Phase 1: Define what "include" means in Joplin

Before any code, a design decision is needed on what include targets map to:

**Option A: Joplin note titles**
```
include::My Other Note[]
```
Resolve by searching for a note with a matching title. Simple for users, but ambiguous if multiple notes share a title.

**Option B: Joplin note IDs (via wiki-link syntax)**
```
include:::/noteId[]
```
Use Joplin's internal note IDs (the same ones used in `joplin://` links). Unambiguous but not human-readable.

**Option C: Joplin resources (attached files)**
```
include::joplin-resource:/resourceId[]
```
For including attached text files (code snippets, data files). Uses the existing resource system.

**Option D: External file paths (limited)**
```
include::/absolute/path/to/file.adoc[]
```
Only for users who keep AsciiDoc files on disk alongside Joplin. Requires UNSAFE mode equivalent.

**Option E: Hybrid approach**
Support multiple schemes with prefix-based routing:
- `include::note:My Note Title[]` or `include::note:noteId[]` — Joplin notes
- `include::resource:resourceId[]` — Joplin resources
- `include::file:/path/to/file.adoc[]` — local files (if permitted)
- `include::https://example.com/snippet.adoc[]` — remote URIs (if permitted)

### Phase 2: Backend (index.ts) — Include Resolution

**2a. Asciidoctor.js Include Processor Extension**

Register a custom include processor with Asciidoctor.js that intercepts include directives and resolves them via Joplin APIs:

```typescript
const registry = asciidoctor.Extensions.create();
registry.includeProcessor(function() {
  this.handles((target) => true); // Handle all includes
  this.process((doc, reader, target, attrs) => {
    // Resolve target via Joplin data API
    // Read note content by title or ID
    // Apply line/tag filtering
    // Apply leveloffset
    // Push content into reader
  });
});

asciidoctor.convert(source, {
  safe: "safe",
  extension_registry: registry,
  // ...
});
```

This is the correct Asciidoctor.js extension point. The include processor receives the target string and attributes, and must return the resolved content.

**2b. IPC message for include resolution**

Add a new message type for the webview to request include expansion:

```typescript
// In index.ts message handler:
if (msg.type === "resolveInclude") {
  const { target, attributes } = msg;
  // Resolve target to content
  // Apply line ranges, tags, leveloffset
  return { content: resolvedContent, found: true };
}
```

**2c. Note lookup by title**

Use the Joplin data API to search for notes:

```typescript
const results = await joplin.data.get(["search"], {
  query: title,
  fields: ["id", "title", "body"],
  type: "note",
});
```

**2d. Resource file reading**

For attached text files:

```typescript
const resourcePath = await joplin.data.resourcePath(resourceId);
const content = await fs.promises.readFile(resourcePath, encoding);
```

### Phase 3: Live Preview — Inline Expansion

**3a. Block detection**

Add include directive detection to `detectBlocks()`:

```typescript
if (/^include::(.+)\[(.*)?\]$/.test(text)) {
  // Mark as include block with target and attributes
}
```

**3b. Include widget**

Create an `IncludePreviewWidget` (similar to `CodeBlockPreviewWidget`) that:
- Shows a header indicating the include source
- Displays the expanded content rendered as AsciiDoc
- Shows an error state if the target can't be resolved
- Supports collapsing/expanding the included content

**3c. Async resolution with caching**

Include resolution is async (IPC round-trip). Use the same pattern as Mermaid diagrams:
1. Show a placeholder on first render
2. Fire async IPC request
3. Cache the resolved content
4. Update the widget when content arrives
5. Invalidate cache when the included note changes (requires watching)

**3d. Cache invalidation**

The hardest part: when an included note changes, the including note's preview must update. Options:
- Poll on a timer (simple but wasteful)
- Watch included notes via Joplin's `onNoteChange` event (if available)
- Only refresh on manual trigger or focus

### Phase 4: Attribute Support

Implement the include attributes progressively:

| Priority | Attribute | Complexity |
|---|---|---|
| P0 | Basic expansion (no attributes) | Low |
| P1 | `leveloffset` | Medium — need to adjust `=` heading markers in source |
| P1 | `opts=optional` | Low — just suppress errors |
| P2 | `lines` | Medium — parse range syntax, extract lines |
| P2 | `tag` / `tags` | Medium — parse tag markers, filter content |
| P3 | `indent` | Low — string manipulation |
| P3 | `encoding` | Low — pass to file read |

### Phase 5: Recursive Includes

Once basic includes work, recursive includes require:
- A depth counter to prevent infinite loops
- Running the include resolver on included AsciiDoc content
- Circular reference detection (note A includes note B includes note A)

### Phase 6: URI Includes (Optional)

Remote URI includes (`include::https://...[]`) require:
- A fetch mechanism in the Node sandbox
- Caching (URIs are slow)
- A security model (opt-in via attribute)
- Timeout handling

---

## Effort Estimate by Phase

| Phase | Scope | Key Risk |
|---|---|---|
| Phase 1 | Design decision | User experience / syntax clarity |
| Phase 2 | Backend include resolution | Asciidoctor.js extension API complexity |
| Phase 3 | Live preview expansion | Async rendering, cache invalidation |
| Phase 4 | Attribute support | Correctness of line/tag filtering |
| Phase 5 | Recursive includes | Infinite loop prevention |
| Phase 6 | URI includes | Security, performance |

Phase 1-2 are prerequisites. Phase 3 provides the visible user value. Phases 4-6 are incremental.

---

## Recommendation

Start with **Option A (note titles)** for Phase 1, as it's the most natural for Joplin users:
```
include::My Other Note[]
```

This gives immediate value — users can split large AsciiDoc documents across multiple Joplin notes and include them together. The Asciidoctor.js include processor extension (Phase 2) is the correct integration point for the final render path, and the async widget pattern (Phase 3) already has precedent in the Mermaid diagram implementation.
