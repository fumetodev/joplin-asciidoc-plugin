# AsciiDoc Live Preview — Joplin Plugin

## Quick Reference

**Build & deploy:** `npm run build` (produces `.jpl`, auto-deploys to Joplin plugin dirs, clears cache)
**Restart Joplin after every build** — Joplin only loads plugins on startup.
**Debug console:** `/Applications/Joplin.app/Contents/MacOS/Joplin --env dev`
**Joplin log:** `~/.config/joplin-desktop/log.txt` (or `joplindev-desktop` for `--env dev`)
**Plugin data dir:** `~/.config/joplin-desktop/plugins/` (`.jpl` files) and `cache/` (extracted)

## Architecture

Two webpack entry points produce two JS bundles:

| File | Target | Runs in | Contains |
|------|--------|---------|----------|
| `index.js` (~10 KB) | node | Joplin plugin sandbox | Plugin registration, commands, IPC message handlers |
| `panel.js` (~543 KB) | web | Webview (editor UI) | CodeMirror 6, live-preview engine, toolbar, IPC client |

Asciidoctor.js is bundled into `index.js` via webpack (NOT externalized). The `api` module is shimmed via `api-shim.js` which re-exports the `joplin` global.

The plugin uses `joplin.views.editors.register()` — a **custom editor** API (Joplin 3.1+). Notes are detected as AsciiDoc by a `` ```asciidoc-settings `` sentinel block at the end of the body.

## Critical Joplin Plugin Sandbox Rules

These were learned the hard way during development:

### 1. `joplin` is a GLOBAL, not a module
Joplin injects `joplin` as a **global variable** in the plugin sandbox. It does NOT provide a `require("api")` module. The `import joplin from "api"` pattern works via `src/api-shim.js` which re-exports the global:
```js
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = joplin;
```
Webpack aliases `"api"` → this shim file. **Never use `externals: { "api": "commonjs api" }`** — that generates `require("api")` which crashes.

### 2. `api/types` does NOT exist at runtime
Joplin does not provide `require("api/types")`. Enum values like `MenuItemLocation` must be defined **locally** as string constants:
```typescript
const MenuItemLocation = {
  Tools: "tools",
  NoteListContextMenu: "noteListContextMenu",
  // ...
} as const;
```

### 3. No `libraryTarget: "commonjs2"`
The webpack output must be a plain IIFE `(()=>{...})()`, NOT wrapped in `module.exports = ...`. Joplin evaluates the plugin script directly; it doesn't `require()` it. Remove `libraryTarget` from the webpack output config.

### 4. Plugin deployment requires cache clearing
Joplin extracts `.jpl` from `~/.config/joplin-desktop/plugins/` into `cache/` on startup. After building:
- The `.jpl` must be copied to the `plugins/` directory
- The `cache/com.asciidoc.joplin-plugin/` directory must be deleted
- Joplin must be fully restarted (Cmd+Q, reopen)

The `npm run build` script does all of this automatically.

### 5. Webview message handling
Messages from the plugin sandbox to the webview are received via `webviewApi.onMessage()`, NOT `window.addEventListener("message", ...)`. The message may be wrapped: access via `msg.message || msg`.

### 6. Cmd+F is intercepted by Joplin
Joplin captures Cmd+F at the Electron app level before the webview receives it. CM6's search panel must be opened via a toolbar button (`open-search` custom event), not via keyboard shortcut. A `document.addEventListener("keydown", ..., true)` capture handler is also in place as a fallback for when the editor has focus.

## Key Design Decisions

### Overlay Block Editing (toggle in Editor > Appearance)
- **Off** (default): Clicking a rendered code block/table/blockquote moves cursor to that line for inline raw editing. No modal, minimal vertical shift.
- **On**: Clicking a rendered block opens a modal editor. Backspacing into a block auto-opens the modal.

The `overlayEditingMode` flag in `live-preview.ts` gates all modal-opening paths: `attachBlockModalHandlers`, `xrefClickHandler`, arrow key navigation, and auto-open on doc change.

### Height Stabilization
Prevents vertical shifts when switching between rendered preview and raw text:
- **Single lines**: `stabilizedLineDecoration()` adds padding to the raw cursor line to match rendered height
- **Multi-line blocks**: First/last raw lines get padding based on cached rendered widget height
- **Code blocks**: Special handling — padding baked into `codeLineDecoration`/`codeDelimDecoration` since those override separate decorations
- **Scroll lock**: Triple-frame `scrollTop` restoration on selection changes (disabled when search panel is open to allow scroll-to-match)

### Search Panel
- CM6's native search panel (not Joplin's) — opened via magnifying glass icon in Text ribbon tab
- When search panel is open: `editorHasActiveFocus()` always returns true so matched lines show as raw text
- Scroll lock disabled during search so `findNext`/`findPrevious` can scroll to matches

### Footnotes
- Rendered as auto-incrementing superscript numbers `[1]`, `[2]`, `[3]` matching Asciidoctor output
- Named footnotes (`footnote:id[text]`) share the same number when referenced (`footnote:id[]`)
- Clicking a footnote shows a floating popup with the text — no scroll to bottom
- Numbering resets per `buildDecorations` call via `resetFootnoteNumbering()`

### Image Handling
- Joplin resource patterns (`:/resourceId`) recognized as local images via `isLocalImageTarget()`
- `resourceUrlCache` in live-preview.ts resolves `:/id` → `file://` URLs via IPC
- Image editor modal: Scale slider (single, applies to both width/height), Align, Title, Caption, Caption Position
- Caption Position adapts to Align: CENTER→BELOW only, LEFT→BELOW+RIGHT, RIGHT→BELOW+LEFT
- Side captions use flex row layout with image column at scale% width

### Markdown → AsciiDoc Conversion
- `convertMarkdownHeadings()` converts `# heading` → `= heading` (1-6 levels)
- Respects fenced code blocks (doesn't convert `#` inside ``` blocks)
- Applied in all conversion commands (in-place, copy, context menu)

### Auto-convert New Notes
- Setting: "Create new notes as AsciiDoc" (Preferences > AsciiDoc)
- Uses `onNoteSelectionChange` with debounce + lock to prevent loops
- Detects new notes by `age < 5000ms` and empty/default body
- No temp notes (previous approach caused infinite loops)

## Persisted Settings (localStorage)

| Key | Default | Purpose |
|-----|---------|---------|
| `asciidoc-editor-margin` | `0` | Content margin in px (0-300) |
| `asciidoc-overlay-editing` | `false` | Overlay block editing mode |

## File Structure

```
plugin-src/
├── src/
│   ├── index.ts              # Plugin sandbox entry point
│   ├── panel.ts              # Webview entry point (CM6 + live preview)
│   ├── api-shim.js           # Re-exports global joplin for import compatibility
│   ├── api.d.ts              # Joplin API type stubs
│   ├── manifest.json         # Plugin metadata
│   ├── lib/
│   │   ├── ipc.ts            # webviewApi.postMessage() wrappers
│   │   ├── editor/
│   │   │   ├── live-preview.ts      # ~4200-line CM6 decoration engine
│   │   │   ├── asciidoc-language.ts # Syntax highlighting
│   │   │   ├── keybindings.ts       # Keyboard shortcuts
│   │   │   └── wiki-link-completion.ts # << autocomplete
│   │   ├── utils/
│   │   │   ├── image-macro.ts       # image:: parsing (with captionPosition)
│   │   │   └── image-target.ts      # URL normalization + Joplin resource detection
│   │   └── toolbar/
│   │       ├── ribbon.ts            # Tab-based ribbon container
│   │       ├── toolbar-actions.ts   # Action dispatchers + data
│   │       └── panels/
│   │           ├── text-panel.ts       # Font, Color, Find sections
│   │           ├── insert-panel.ts     # Structure, Lists, Content, Media, Symbols
│   │           ├── formatting-panel.ts # Inline (kbd/btn/comment), Macros (menu/footnote/anchor)
│   │           └── editor-panel.ts     # Display, Appearance, Layout
│   └── styles/
│       ├── editor.css        # Ribbon, dropdowns, CM6 overrides, themes
│       └── preview.css       # Asciidoctor HTML styling
├── webpack.config.js         # Two entry points: index.ts → node, panel.ts → web
├── tsconfig.json
├── package.json
└── dist/                     # Build output (tar'd into .jpl)
```

## IPC Protocol

Webview (`panel.js`) communicates with sandbox (`index.js`) via `webviewApi.postMessage()`.
Sandbox pushes to webview via `editors.postMessage()`, received by `webviewApi.onMessage()`.

| Message Type | Direction | Purpose |
|---|---|---|
| `ready` | webview → sandbox | Request initial note + theme (always fetches fresh) |
| `updateNote` | sandbox → webview | Push note content on switch |
| `saveNote` | webview → sandbox | Save editor content (includes noteId to prevent race conditions) |
| `getNoteContent` | webview → sandbox | Fetch note for section preview |
| `renderAsciidoc` | webview → sandbox | Render AsciiDoc to HTML via Asciidoctor.js |
| `requestResources` | webview → sandbox | Resolve Joplin resource IDs to file:// URLs |
| `openImageDialog` | webview → sandbox | Show native file picker |
| `createResourceFromFile` | webview → sandbox | Create Joplin resource from file path |
| `searchNotes` | webview → sandbox | Search notes for wiki-link autocomplete |
| `getNoteSections` | webview → sandbox | Get heading sections for section autocomplete |
| `navigateToNote` | webview → sandbox | Open a different note (xref click) |
| `getTemplates` / `getTemplateContent` / `markAsTemplate` | webview → sandbox | Template management |

## Menu Items & Toolbar

| Location | Command | Label |
|---|---|---|
| Tools menu | `asciidoc.createNote` | New AsciiDoc Note |
| Tools menu | `asciidoc.convertCurrentNote` | Convert to AsciiDoc Note |
| Tools menu | `asciidoc.convertCurrentNoteCopy` | Convert to AsciiDoc Note (new file) |
| Tools menu | `asciidoc.editAttributes` | Edit AsciiDoc Attributes |
| Note list right-click | `asciidoc.convertToAsciiDocFile` | Convert to AsciiDoc File |
| Note toolbar button | `asciidoc.makeCurrentNoteAsciiDoc` | Make AsciiDoc |

## Debugging

```bash
# Check Joplin log
grep -i "asciidoc\|plugin.*error" ~/.config/joplin-desktop/log.txt | tail -20

# Verify installed plugin
ls -la ~/.config/joplin-desktop/cache/com.asciidoc.joplin-plugin/

# Test bundle loads (will fail on 'joplin is not defined' outside Joplin — that's expected)
cd plugin-src && node -e "require('./dist/index.js')"

# Run Joplin in dev mode with console output
/Applications/Joplin.app/Contents/MacOS/Joplin --env dev
```
