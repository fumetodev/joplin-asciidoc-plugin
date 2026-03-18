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
| `index.js` (~791 KB) | node | Joplin plugin sandbox | Plugin registration, commands, Asciidoctor.js, IPC message handlers |
| `panel.js` (~543 KB) | web | Webview (editor UI) | CodeMirror 6, live-preview engine, toolbar, IPC client |

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
│   │   │   ├── live-preview.ts      # 3925-line CM6 decoration engine (from standalone app)
│   │   │   ├── asciidoc-language.ts # Syntax highlighting
│   │   │   ├── keybindings.ts       # Keyboard shortcuts
│   │   │   └── wiki-link-completion.ts # << autocomplete
│   │   ├── utils/
│   │   │   ├── image-macro.ts       # image:: parsing
│   │   │   └── image-target.ts      # URL normalization
│   │   └── toolbar/
│   │       ├── ribbon.ts            # Tab-based ribbon container
│   │       ├── toolbar-actions.ts   # Action dispatchers + data
│   │       └── panels/             # Text, Insert, Formatting, Editor
│   └── styles/
│       ├── editor.css        # Ribbon, dropdowns, CM6 overrides, themes
│       └── preview.css       # Asciidoctor HTML styling
├── webpack.config.js         # Two entry points: index.ts → node, panel.ts → web
├── tsconfig.json
├── package.json
├── scripts/
│   └── copy-asciidoctor.js   # (unused) Copies asciidoctor to dist if externalized
└── dist/                     # Build output (tar'd into .jpl)
```

## IPC Protocol

Webview (`panel.js`) communicates with sandbox (`index.js`) via `webviewApi.postMessage()`:

| Message Type | Direction | Purpose |
|---|---|---|
| `ready` | webview → sandbox | Request initial note + theme |
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

## AsciiDoc Note Detection

A note is AsciiDoc if its body contains `` ```asciidoc-settings ``. The sentinel block at the end stores JSON settings (document attributes). The `onActivationCheck` handler checks this to decide whether to show the custom editor.

## Menu Items

| Location | Command | Label |
|---|---|---|
| Tools menu | `asciidoc.createNote` | New AsciiDoc Note |
| Tools menu | `asciidoc.convertCurrentNote` | Convert to AsciiDoc Note |
| Tools menu | `asciidoc.convertCurrentNoteCopy` | Convert to AsciiDoc Note (new file) |
| Tools menu | `asciidoc.editAttributes` | Edit AsciiDoc Attributes |
| Note list right-click | `asciidoc.convertToAsciiDocFile` | Convert to AsciiDoc File |

## Debugging

```bash
# Check Joplin log
grep -i "asciidoc\|plugin.*error" ~/.config/joplin-desktop/log.txt | tail -20

# Verify installed plugin
ls -la ~/.config/joplin-desktop/cache/com.asciidoc.joplin-plugin/

# Test bundle loads (will fail on require('api') outside Joplin — that's expected)
cd plugin-src && node -e "require('./dist/index.js')"

# Run Joplin in dev mode with console output
/Applications/Joplin.app/Contents/MacOS/Joplin --env dev
```
