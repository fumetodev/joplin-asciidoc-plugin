# Spell-Check Research Report for AsciiDoc Live Preview Editor

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Plugin Architecture Context](#2-plugin-architecture-context)
3. [Constraints & Requirements](#3-constraints--requirements)
4. [Option 1: Electron's Built-in Spellchecker](#4-option-1-electrons-built-in-spellchecker)
5. [Option 2: Browser Native Spellcheck via CodeMirror 6](#5-option-2-browser-native-spellcheck-via-codemirror-6)
6. [Option 3: nspell (Pure JS Hunspell)](#6-option-3-nspell-pure-js-hunspell)
7. [Option 4: Typo.js](#7-option-4-typojs)
8. [Option 5: spellchecker-wasm (SymSpell/Rust)](#8-option-5-spellchecker-wasm-symspellrust)
9. [Option 6: LanguageTool API](#9-option-6-languagetool-api)
10. [Option 7: WProofreader SDK (Commercial)](#10-option-7-wproofreader-sdk-commercial)
11. [CodeMirror 6 Integration Approaches](#11-codemirror-6-integration-approaches)
12. [AsciiDoc Prose Extraction Strategies](#12-asciidoc-prose-extraction-strategies)
13. [Comparison Matrix](#13-comparison-matrix)
14. [Recommendation](#14-recommendation)
15. [Proposed Architecture](#15-proposed-architecture)
16. [Sources](#16-sources)

---

## 1. Executive Summary

After extensive research into spell-checking options for this Joplin AsciiDoc plugin, the recommended approach is:

**nspell + CodeMirror 6 Linter API + StreamLanguage syntax tree filtering**

This combination provides AsciiDoc-aware spell-checking (prose only, no markup), custom dictionary support, 92+ language dictionaries, and full integration with the existing CodeMirror 6 editor -- all within the constraints of Joplin's sandboxed plugin environment.

The key insight driving this recommendation is that **Joplin plugins cannot access Electron's native spellchecker APIs** due to sandboxing, so a pure JavaScript solution bundled within the plugin is the only viable path. The existing `StreamLanguage` parser in `asciidoc-language.ts` already classifies tokens as prose vs. markup, providing a ready-made foundation for syntax-aware spell-checking.

---

## 2. Plugin Architecture Context

Understanding the current architecture is essential for evaluating spell-check options:

| Aspect | Detail |
|--------|--------|
| **Framework** | Joplin Plugin API 3.1+ (desktop only) |
| **Editor** | CodeMirror 6 (`@codemirror/view`, `@codemirror/state`, `@codemirror/language`) |
| **AsciiDoc Parser** | Custom `StreamLanguage` tokenizer (`asciidoc-language.ts`) |
| **AsciiDoc Renderer** | Asciidoctor.js 3.0.4 |
| **Build** | Webpack 5 -> single-chunk `.jpl` bundle |
| **Runtime** | Two processes: Node.js sandbox (`index.ts`) + webview (`panel.ts`) |
| **Bundle sizes** | `index.js` ~800 KB, `panel.js` ~4.7 MB |
| **Existing spell-check** | None (browser native only, checks everything including markup) |

The plugin's webview runs in a sandboxed BrowserWindow with no access to Electron APIs (`webContents`, `webFrame`, `session`). All code must be pure JavaScript/TypeScript bundleable by webpack.

### Existing Token Classification (asciidoc-language.ts)

The `StreamLanguage` parser already returns these token types:

| Token Type | Examples | Spell-check? |
|------------|----------|--------------|
| `null` (no tag) | Plain prose text | **Yes** |
| `"heading"` | `= Title`, `== Subtitle` | **Yes** (text after `=` markers) |
| `"keyword"` | `NOTE:`, `TIP:`, `WARNING:` (+ body text) | **Partially** (body text only) |
| `"strong"` | `*bold text*` | **Yes** (text between markers) |
| `"emphasis"` | `_italic text_` | **Yes** (text between markers) |
| `"list"` | `* `, `. `, `- ` (markers only) | No |
| `"meta"` | `----`, `====`, `:attr: val`, block delimiters | No |
| `"comment"` | `// comment text` | No |
| `"monospace"` | `` `code` `` | No |
| `"string"` | `^super^`, `~sub~` (code block content) | No |
| `"link"` | `link:url[text]`, `<<ref>>`, `[[id]]` | No |
| `"url"` | `image::path[alt]` | No |
| `"variableName"` | `macro::target` | No |

---

## 3. Constraints & Requirements

### Hard Constraints (from the Joplin plugin sandbox)

- **No Electron API access.** Cannot use `webContents.session.setSpellCheckerLanguages()`, `webFrame.isWordMisspelled()`, or any `electron` module.
- **No native Node modules.** Cannot use `nodehun` (C++ Hunspell binding) or any package requiring compilation.
- **Single-chunk webpack bundle.** Joplin's webview cannot load dynamic imports or multiple chunks.
- **No external process spawning.** Cannot shell out to `aspell`, `hunspell`, or `vale`.

### Functional Requirements

- Spell-check **prose text only** (skip AsciiDoc markup, code blocks, URLs, attributes, etc.)
- **Custom dictionary support**: add/remove words, persist across sessions
- **Multiple language support**: at minimum English, ideally 10+ languages
- **Real-time feedback** in the editor (underline misspelled words as the user types)
- **Suggestions** for misspelled words (on demand, e.g., right-click or hover)
- **"Add to dictionary"** action for each flagged word

### Non-Functional Requirements

- Bundle size impact should be reasonable (< 1 MB for the library; dictionaries can be loaded lazily)
- No perceptible lag while typing (spell-check must be debounced/async)
- Works on macOS, Windows, and Linux (Joplin supports all three)

---

## 4. Option 1: Electron's Built-in Spellchecker

### How It Works

Electron provides a built-in spellchecker via the `session` API (main process) and `webFrame` API (renderer). On macOS it delegates to NSSpellChecker; on Windows/Linux it uses Hunspell with `.bdic` dictionaries downloaded from a Google CDN.

### Relevant APIs

```javascript
// Main process
session.setSpellCheckerLanguages(['en-US', 'fr'])
session.addWordToSpellCheckerDictionary('AsciiDoc')
session.removeWordFromSpellCheckerDictionary('AsciiDoc')
session.listWordsInSpellCheckerDictionary()

// Renderer (Electron 12+)
webFrame.isWordMisspelled(word)     // synchronous boolean
webFrame.getWordSuggestions(word)   // string[]
```

### Verdict: NOT FEASIBLE

Joplin plugins are sandboxed and **cannot access any of these APIs**. The plugin runs in a separate BrowserWindow process with a restricted IPC proxy. There is no `joplin.electron` namespace, no `require('electron')`, and no way to call session or webFrame methods.

Even if access were possible, the Electron spellchecker has **no syntax awareness** -- it checks all visible text including markup delimiters, URLs, attribute names, and code blocks.

**Joplin's own spellchecker** (in `SpellCheckerServiceDriverNative.ts`) uses these APIs directly from the main app code, but this is not exposed to plugins.

### Custom Dictionary Limitation

Custom words are stored in `Custom Dictionary.txt` with an MD5 checksum. Even if a plugin could write to this file, Joplin would need restarting to pick up changes.

---

## 5. Option 2: Browser Native Spellcheck via CodeMirror 6

### How It Works

CM6 can enable the browser's native `contenteditable` spellcheck:

```javascript
EditorView.contentAttributes.of({ spellcheck: "true" })
```

This delegates entirely to the browser/OS spellchecker, producing red squiggly underlines on misspelled words.

### Advantages

- Zero implementation effort
- Zero bundle size impact
- Uses the OS dictionary (already configured by the user)
- Right-click context menu with suggestions (browser-provided)

### Critical Limitations

1. **No syntax awareness.** Checks ALL text, including:
   - Block delimiters (`----`, `====`, `****`)
   - Attribute definitions (`:author: John`)
   - Macro names (`image::`, `link:`, `ifdef::`)
   - URLs, cross-references, anchor IDs
   - Code block content

2. **No custom dictionary control from JavaScript.** The browser's dictionary is opaque -- you cannot programmatically add words, query the dictionary, or manage custom word lists.

3. **iOS Safari completely ignores it.** When CM6 programmatically modifies the DOM (which it does constantly for syntax highlighting/decorations), Safari stops spell-checking. The CM6 maintainer confirmed this is unfixable.

4. **Replacing via context menu can cause issues.** CM6's DOM management can conflict with the browser's text replacement, causing cursor jumps or text corruption.

5. **No way to selectively disable by token.** While you could theoretically apply `Decoration.mark({ attributes: { spellcheck: "false" } })` to markup tokens, this is fragile, race-prone, and still subject to all the other limitations.

### Verdict: NOT RECOMMENDED as primary solution

Could be offered as a fallback option (enable/disable via settings), but does not meet the requirement of AsciiDoc-aware spell-checking or custom dictionaries.

---

## 6. Option 3: nspell (Pure JS Hunspell)

### Overview

nspell is a pure JavaScript implementation of Hunspell's core spell-checking algorithm by Titus Wormer (wooorm). It works identically in Node.js and browsers with no native dependencies.

| Attribute | Value |
|-----------|-------|
| **npm package** | `nspell` |
| **Latest version** | 2.1.5 (January 2021) |
| **Weekly downloads** | ~41,600 |
| **Bundle size** | ~11 KB min+gzip (library only) |
| **License** | MIT |
| **TypeScript types** | `@types/nspell` (v2.1.6) |
| **Dictionary format** | Hunspell `.aff` + `.dic` files |
| **Available languages** | 92 via `dictionary-*` npm packages |
| **Maintainer** | Titus Wormer (wooorm) -- prolific author of unified/remark ecosystem |

### Core API

```javascript
import nspell from 'nspell';
import enDict from 'dictionary-en';

// Load dictionary (async callback)
enDict((err, dict) => {
  const spell = nspell(dict);  // dict = { aff: Buffer, dic: Buffer }

  spell.correct('hello');     // true
  spell.correct('helo');      // false
  spell.suggest('helo');      // ['hello', 'help', 'hero', ...]
  spell.spell('helo');        // { correct: false, forbidden: false, warn: false }

  // Custom dictionary management
  spell.add('AsciiDoc');                // add word
  spell.add('asciidoctor', 'editor');   // add with affix model
  spell.remove('AsciiDoc');             // remove word
  spell.personal('AsciiDoc\nJoplin');   // load personal dictionary
  spell.dictionary('3\nnpm\nwebpack\ntypescript');  // load extra .dic
  spell.wordCharacters();               // extra word chars (e.g., "0123456789")
});
```

### Custom Dictionary Support (Excellent)

Three mechanisms for managing custom words:

1. **`spell.add(word, model?)`** -- Add individual words at runtime. Optional `model` parameter lets the new word inherit affix behavior from an existing word.

2. **`spell.personal(dic)`** -- Load a personal dictionary string. Supports special syntax:
   ```
   foo          # add 'foo'
   bar/baz      # add 'bar', modeled after 'baz'
   *qux         # forbid 'qux'
   ```

3. **`spell.dictionary(dic)`** -- Load an additional `.dic` file (must be compatible with the loaded `.aff`).

For this plugin, the personal dictionary could be serialized as a simple newline-separated string and stored in Joplin's plugin settings (via `joplin.settings`), persisting across sessions.

### Dictionary Packages

The companion `wooorm/dictionaries` repository provides 92 languages as npm packages:

- `dictionary-en` (US English, ~575 KB unpacked, ~135K words)
- `dictionary-en-gb`, `dictionary-en-au`, `dictionary-en-ca`, `dictionary-en-za`
- `dictionary-fr`, `dictionary-de`, `dictionary-de-ch`, `dictionary-es`, `dictionary-it`, `dictionary-pt`, `dictionary-ru`, `dictionary-nl`, `dictionary-da`, `dictionary-cs`, and 77+ more

Each package exports `{ aff: Buffer, dic: Buffer }` ready for nspell's constructor.

### Performance

| Operation | Performance | Notes |
|-----------|-------------|-------|
| Dictionary loading | 200-500ms | CPU-intensive, **must run in background/async** |
| `correct(word)` | ~0.01-0.1ms | Fast lookup, suitable for real-time |
| `suggest(word)` | 10-100ms | Slower, use **on-demand only** (not per-keystroke) |
| Memory | ~50-100 MB | After full English dictionary expansion |

**Critical:** Dictionary loading is synchronous and blocks the thread. For the webview, this should be done during plugin initialization (before the user starts typing) or via a deferred async pattern.

### Hunspell Feature Coverage

**Supported:** `FLAG`, `KEY`, `TRY`, `NOSUGGEST`, `REP`, `WARN`, `FORBIDWARN`, `COMPOUNDRULE`, `COMPOUNDMIN`, `ONLYINCOMPOUND`, `PFX`, `SFX`, `FORBIDDENWORD`, `KEEPCASE`, `ICONV`, `OCONV`, `NEEDAFFIX`, `WORDCHARS`

**NOT supported:** `MAP`, `PHONE` (phonetic suggestions), most compound word options (`COMPOUNDFLAG`, `CHECKCOMPOUND*`), `CIRCUMFIX`, `FULLSTRIP`, `CHECKSHARPS`

The missing `MAP` and `PHONE` features reduce suggestion quality for phonetic misspellings. Missing compound word support can cause false positives in German, Dutch, and Finnish.

### Known Issues

- **Unmaintained since January 2021.** 8 open issues with no activity.
- **Italian dictionary can crash/hang** during loading (complex affix rules exhaust memory).
- **German compound words partly broken.** Lowercase infinitives fail validation.
- **Korean validation always returns true** regardless of input.
- **CommonJS only** (no ESM), though webpack handles this fine.

### Verdict: RECOMMENDED (with caveats)

Best overall option for this plugin. Pure JS, small library, extensive language support, excellent custom dictionary API, and compatible with the webview sandbox. The lack of maintenance is a concern but the core functionality is stable and well-tested for major languages. Bundle the English dictionary and allow users to select additional languages.

---

## 7. Option 4: Typo.js

### Overview

| Attribute | Value |
|-----------|-------|
| **npm package** | `typo-js` |
| **Latest version** | 1.3.1 (August 2025) |
| **Weekly downloads** | ~210,400 |
| **Bundle size** | ~25 KB min+gzip |
| **License** | Modified BSD |
| **Dictionary format** | Hunspell `.aff` + `.dic` |
| **Maintenance** | Active (last release August 2025) |

### API

```javascript
const Typo = require('typo-js');
const dict = new Typo('en_US', affData, dicData);

dict.check('hello');    // true
dict.check('helo');     // false
dict.suggest('helo');   // ['hello', 'help', ...]
```

### Key Differences from nspell

| Feature | Typo.js | nspell |
|---------|---------|--------|
| Maintenance | Active (2025) | Stale (2021) |
| Downloads | 210K/week | 42K/week |
| `suggest()` speed | **Very slow** (7+ seconds on some words) | Much faster |
| `check()` speed | Similar | Similar |
| Custom dictionary API | Manual dictionary modification | Built-in `add()`, `remove()`, `personal()` |
| TypeScript types | None (no `@types/typo-js`) | `@types/nspell` available |
| Dictionary packages | Must load `.aff`/`.dic` manually | 92 ready-made npm packages |

### Critical Performance Issue

Typo.js's `suggest()` function uses a different algorithm than nspell and can take **7+ seconds** for suggestions on long or unusual misspelled words. This was documented in a PR replacing Typo.js with nspell in an Ace editor spell checker, where the performance difference was dramatic.

### Custom Dictionary Support

Typo.js does not have a built-in `add(word)` API. You would need to:
1. Modify the internal `dictionaryTable` directly
2. Maintain a separate custom word list and check it alongside Typo.js
3. Append words to the `.dic` string before initialization

### Verdict: NOT RECOMMENDED

While more actively maintained, the severe `suggest()` performance issue and lack of a clean custom dictionary API make Typo.js inferior to nspell for this use case.

---

## 8. Option 5: spellchecker-wasm (SymSpell/Rust)

### Overview

| Attribute | Value |
|-----------|-------|
| **npm package** | `spellchecker-wasm` |
| **Technology** | Rust compiled to WebAssembly, SymSpell algorithm |
| **Bundle size** | ~70 KB (WASM module) |
| **Dictionary format** | Custom frequency list (word + frequency per line) |
| **Performance** | Sub-millisecond per word check |

### How It Works

Uses the SymSpell algorithm (symmetric delete spelling correction), which pre-computes all possible deletions within a given edit distance during dictionary loading, enabling O(1) lookup during spell-checking.

### Performance (Excellent)

| Operation | Time |
|-----------|------|
| Dictionary loading | ~200ms |
| `checkSpelling(word)` | < 1ms |
| `getSuggestions(word)` | < 1ms |

This is significantly faster than both nspell and Typo.js, especially for suggestions.

### Limitations

1. **Different dictionary format.** Does not use Hunspell `.aff`/`.dic` files. Uses a simple frequency list format. The 92 language dictionaries from `wooorm/dictionaries` cannot be used directly.

2. **No affix/morphology support.** SymSpell checks exact word forms only. If "run" is in the dictionary but "running" is not explicitly listed, it will be flagged. Hunspell's affix rules handle this automatically.

3. **No built-in personal dictionary API.** You would need to rebuild the dictionary to add words.

4. **WASM loading complexity.** The `.wasm` file must be loaded and instantiated, which requires careful webpack configuration (file-loader or asset/resource for the WASM binary).

5. **Limited language support.** No curated dictionary packages -- you would need to source or generate frequency dictionaries.

### Verdict: VIABLE ALTERNATIVE

Best performance by far, but the lack of Hunspell compatibility, limited dictionary ecosystem, and no morphological analysis (affix rules) make it a weaker choice for a multi-language editor with custom dictionary requirements. Would be ideal if performance is the primary concern and only English is needed.

### Notable Usage

The [Review Board / Beanbag team](https://discuss.codemirror.net/t/showing-off-spellchecking-in-cm6-without-tricks/3254) used spellchecker-wasm in their CM6 spell-checking implementation, running it in a Web Worker with excellent results.

---

## 9. Option 6: LanguageTool API

### Overview

LanguageTool is an open-source grammar and spell checker available as a cloud API or self-hosted server.

### How It Works

Send text to the LanguageTool API endpoint; receive JSON with spelling/grammar errors, positions, and suggestions.

```javascript
const response = await fetch('https://api.languagetool.org/v2/check', {
  method: 'POST',
  body: new URLSearchParams({
    text: 'This is a sentnce.',
    language: 'en-US'
  })
});
```

### Advantages

- Grammar checking in addition to spell checking
- 30+ languages
- Very high quality suggestions (AI-powered in premium tier)
- No local dictionary loading required

### Limitations

1. **Requires network access.** Not available offline. Privacy concerns with sending note content to an external server.
2. **Rate limits.** Free tier: 20 requests/minute, 100KB text/request. Premium: paid.
3. **Latency.** Each API call takes 200-1000ms. Not suitable for real-time keystroke-level checking.
4. **No custom dictionary API** in the free tier. Premium has custom dictionaries.
5. **Self-hosted option** requires running a Java server -- not feasible within a Joplin plugin.

### Verdict: NOT RECOMMENDED as primary solution

Could be offered as an optional enhancement (e.g., "Check grammar with LanguageTool" command) but not suitable as the primary real-time spell checker due to latency, network dependency, and privacy concerns.

---

## 10. Option 7: WProofreader SDK (Commercial)

### Overview

WProofreader by WebSpellChecker is a commercial real-time proofreading SDK with official CodeMirror 6 support.

### Advantages

- Out-of-the-box CM6 integration
- Grammar + spell checking + autocorrect
- 20+ languages
- Custom dictionaries

### Limitations

1. **Commercial license required.** Pricing is per-user or per-domain.
2. **Cloud-based or on-premise server.** Same privacy/network concerns as LanguageTool.
3. **Closed source.** Cannot bundle into an open-source Joplin plugin.

### Verdict: NOT FEASIBLE

Licensing and architecture are incompatible with an open-source Joplin plugin.

---

## 11. CodeMirror 6 Integration Approaches

There is **no mature, dedicated CM6 spell-check package** on npm. All existing packages (`codemirror-spell-checker`, `codemirror-typo`, etc.) target CodeMirror 5 and are unmaintained. A custom integration must be built.

### Approach A: Linter API (`@codemirror/lint`) -- RECOMMENDED

The CM6 linter API is the most natural fit for spell-checking:

```typescript
import { linter, Diagnostic } from "@codemirror/lint";

const spellLinter = linter(async (view) => {
  const diagnostics: Diagnostic[] = [];

  // 1. Walk syntax tree to find prose ranges
  // 2. Extract words from prose ranges
  // 3. Check each word against nspell
  // 4. Return diagnostics for misspelled words

  return diagnostics;
}, { delay: 400 });
```

**Advantages:**
- Built-in UI: tooltips with message and actions, gutter markers, diagnostic panel (Ctrl+Shift+M)
- Built-in debouncing (`delay` option, default 750ms)
- Async support (return `Promise<Diagnostic[]>`)
- Actions on each diagnostic ("Replace with...", "Add to dictionary")
- `markClass` for custom CSS (red wavy underline)
- `source` label ("spellcheck")
- `forceLinting(view)` to trigger re-check on demand (e.g., after adding a word to dictionary)
- `setDiagnostics(state, diagnostics)` for programmatic updates

**Diagnostic interface:**
```typescript
interface Diagnostic {
  from: number;
  to: number;
  severity: "hint" | "info" | "warning" | "error";
  message: string;
  markClass?: string;
  source?: string;
  actions?: readonly Action[];
}

interface Action {
  name: string;
  apply: (view: EditorView, from: number, to: number) => void;
}
```

### Approach B: ViewPlugin + Decorations

For fully custom visual rendering (e.g., if the linter UI doesn't match the desired UX):

```typescript
import { ViewPlugin, Decoration, DecorationSet } from "@codemirror/view";

const spellPlugin = ViewPlugin.fromClass(class {
  decorations: DecorationSet;
  constructor(view: EditorView) {
    this.decorations = this.computeDecorations(view);
  }
  update(update: ViewUpdate) {
    if (update.docChanged || update.viewportChanged) {
      this.decorations = this.computeDecorations(update.view);
    }
  }
  computeDecorations(view: EditorView): DecorationSet {
    // ... check words, return Decoration.mark for misspelled
  }
}, { decorations: v => v.decorations });
```

This gives full control over rendering but requires building the tooltip/context menu UI from scratch.

### Recommendation

**Use Approach A (Linter API).** It provides 80% of the needed UI for free, supports async, and is the idiomatic CM6 pattern. Supplement with custom CSS for the underline style:

```css
.cm-lintRange-warning {
  background-image: none;
  text-decoration: underline wavy #e53e3e;
  text-decoration-skip-ink: none;
}
```

---

## 12. AsciiDoc Prose Extraction Strategies

The core challenge is identifying which text regions are prose (should be spell-checked) vs. markup/code (should be skipped).

### Strategy A: StreamLanguage Syntax Tree (RECOMMENDED)

Your existing `asciidoc-language.ts` parser already classifies every character in the document. Use `syntaxTree(state)` to iterate tokens and collect prose ranges:

```typescript
import { syntaxTree } from "@codemirror/language";

function getProseRanges(state: EditorState): { from: number; to: number }[] {
  const ranges: { from: number; to: number }[] = [];
  let current: { from: number; to: number } | null = null;

  syntaxTree(state).iterate({
    enter(node) {
      // StreamLanguage tokens with no tag (null) = prose
      // Also include content of "strong", "emphasis", "heading", "keyword"
      const name = node.type.name;
      const isProse = !name ||
        name === "strong" || name === "emphasis" ||
        name === "heading" || name === "keyword";

      if (isProse) {
        if (current && current.to === node.from) {
          current.to = node.to; // extend
        } else {
          if (current) ranges.push(current);
          current = { from: node.from, to: node.to };
        }
      } else {
        if (current) {
          ranges.push(current);
          current = null;
        }
      }
    }
  });
  if (current) ranges.push(current);
  return ranges;
}
```

**Advantages:**
- Works directly with document positions (no offset mapping needed)
- Leverages existing code
- Updates incrementally as the syntax tree updates
- Zero additional parsing overhead

**Limitation:** The StreamLanguage parser is relatively simple -- headings consume the entire line (including `= ` prefix), and formatted text includes the markers (`*bold*` is tagged as `"strong"` including the `*` characters). The word extraction regex should handle stripping leading/trailing markup characters.

### Strategy B: Whitespace Replacement

Replace all markup tokens with spaces of equal length, preserving character offsets:

```javascript
function maskMarkup(text: string): string {
  let masked = text;
  // Replace heading markers
  masked = masked.replace(/^(={1,5})\s/gm, m => ' '.repeat(m.length));
  // Replace bold markers (keep inner text)
  masked = masked.replace(/\*([^\s*](?:[^*]*[^\s*])?)\*/g,
    (m, inner) => ' ' + inner + ' ');
  // Replace entire code blocks with spaces
  // ... etc
  return masked;
}
```

**Advantage:** Simple offset mapping (position N in masked text = position N in original).
**Disadvantage:** Fragile regex that can miss edge cases; must re-implement parsing logic already present in the StreamLanguage parser.

### Strategy C: Asciidoctor.js AST

Use `asciidoctor.load(source, { sourcemap: true })` to get a block-level AST, then extract prose blocks:

```javascript
const doc = asciidoctor.load(source, { sourcemap: true });
const paragraphs = doc.findBy({ context: 'paragraph' });
paragraphs.forEach(p => {
  const lines = p.getSourceLines();
  const lineNum = p.getLineNumber();
  // Spell-check these lines
});
```

**Advantage:** Precise block-level identification (skips code, images, etc. perfectly).
**Disadvantage:** Asciidoctor.js does NOT expose inline nodes during parsing. `getSourceLines()` returns raw text with `*bold*`, `_italic_` markers still present. Also, this runs in the plugin sandbox (index.ts), not the webview, requiring IPC round-trips.

### Strategy D: Hybrid (AST + Regex)

Combine Asciidoctor.js AST for block-level filtering with regex for inline markup stripping.

**Verdict:** Overengineered for this use case. The StreamLanguage syntax tree (Strategy A) already provides sufficient granularity.

### Recommendation

**Use Strategy A** (StreamLanguage syntax tree). It is the simplest, most performant, and most maintainable approach. The token types already classify prose vs. markup, and the positions map directly to the editor document.

---

## 13. Comparison Matrix

| Criteria | Electron Spellcheck | Browser Native | nspell | Typo.js | spellchecker-wasm | LanguageTool |
|----------|---------------------|----------------|--------|---------|-------------------|--------------|
| **Feasible in plugin sandbox** | No | Yes | Yes | Yes | Yes | Yes |
| **AsciiDoc-aware** | No | No | Yes (with custom integration) | Yes (with custom integration) | Yes (with custom integration) | Partial (send pre-filtered text) |
| **Custom dictionary** | No (from plugin) | No | Excellent (`add`, `remove`, `personal`) | Manual only | No built-in API | Premium only |
| **Languages available** | OS-dependent | OS-dependent | 92 (npm packages) | Must source manually | Must source manually | 30+ |
| **check() speed** | N/A | N/A | Fast (~0.1ms) | Fast (~0.1ms) | Very fast (< 0.1ms) | 200-1000ms (network) |
| **suggest() speed** | N/A | N/A | Good (10-100ms) | Bad (up to 7s) | Excellent (< 1ms) | 200-1000ms (network) |
| **Bundle size (library)** | 0 | 0 | ~11 KB | ~25 KB | ~70 KB | 0 (API call) |
| **Dictionary size** | 0 (OS) | 0 (OS) | ~575 KB (English) | ~575 KB (English) | ~2 MB (frequency list) | 0 (server-side) |
| **Offline capable** | Yes | Yes | Yes | Yes | Yes | No |
| **Morphology (affix rules)** | Full Hunspell | OS-dependent | Partial Hunspell | Partial Hunspell | None (exact match) | Full |
| **TypeScript types** | N/A | N/A | Yes (`@types/nspell`) | No | Yes (built-in) | N/A |
| **Maintained** | N/A | N/A | Stale (2021) | Active (2025) | Active | Active |
| **Implementation effort** | N/A | Trivial | Medium | Medium | Medium-High | Low-Medium |
| **Privacy** | Local | Local | Local | Local | Local | Sends text to server |

---

## 14. Recommendation

### Primary: nspell + @codemirror/lint + StreamLanguage Filtering

**Why nspell over the alternatives:**

1. **vs. Electron spellchecker / browser native:** These cannot be made AsciiDoc-aware and don't support custom dictionaries from within a plugin.

2. **vs. Typo.js:** nspell's `suggest()` is dramatically faster (100ms vs. 7s worst case), has a clean `add()`/`remove()`/`personal()` API for custom dictionaries, has TypeScript types, and has 92 ready-made dictionary packages.

3. **vs. spellchecker-wasm:** While faster, spellchecker-wasm lacks Hunspell compatibility (no affix rules, no standard dictionary format), has no curated language packages, and has no personal dictionary API. The performance difference is negligible for the debounced-linter use case.

4. **vs. LanguageTool:** Network-dependent, has privacy concerns, rate-limited, and adds latency. Not suitable for real-time in-editor checking.

### Addressing nspell's Weaknesses

| Concern | Mitigation |
|---------|------------|
| Unmaintained (2021) | Core functionality is stable; English/major languages work well; fork if needed |
| Dictionary loading is slow | Load asynchronously during plugin init; show a status indicator |
| Memory usage | Only load one language at a time; allow language switching via settings |
| Missing Hunspell features | Acceptable for the majority of users; affects mainly German/Dutch compound words |
| `suggest()` latency | Call on-demand only (hover/click), not per-keystroke; debounce |

---

## 15. Proposed Architecture

```
+------------------------------------------------------------------+
|  Joplin Plugin Sandbox (index.ts)                                |
|  - Plugin settings: language, custom dictionary, enable/disable  |
|  - Stores personal dictionary in plugin settings                 |
|  - Sends settings to webview via IPC                             |
+------------------------------------------------------------------+
         |  IPC (postMessage)
         v
+------------------------------------------------------------------+
|  Webview (panel.ts)                                              |
|                                                                  |
|  +-----------------------------------------------------------+  |
|  |  CodeMirror 6 Editor                                       |  |
|  |  +-----------------------+  +---------------------------+  |  |
|  |  | asciidoc-language.ts  |  |  spell-check-linter.ts    |  |  |
|  |  | (StreamLanguage)      |  |  (@codemirror/lint)       |  |  |
|  |  | Token classification  |  |  1. Get prose ranges      |  |  |
|  |  +-----------------------+  |  2. Extract words          |  |  |
|  |             |               |  3. Check with nspell      |  |  |
|  |             | syntax tree   |  4. Return diagnostics     |  |  |
|  |             +-------------->|  5. Actions: suggest,      |  |  |
|  |                             |     add to dictionary      |  |  |
|  |                             +---------------------------+  |  |
|  |                                        |                   |  |
|  |                                        v                   |  |
|  |                             +---------------------------+  |  |
|  |                             |  nspell instance           |  |  |
|  |                             |  - dictionary-en loaded    |  |  |
|  |                             |  - personal dict applied   |  |  |
|  |                             |  - correct() / suggest()  |  |  |
|  |                             +---------------------------+  |  |
|  +-----------------------------------------------------------+  |
+------------------------------------------------------------------+
```

### Implementation Steps

1. **Add dependencies:**
   - `nspell` (spell checker engine)
   - `@types/nspell` (TypeScript types)
   - `@codemirror/lint` (linter framework)
   - `dictionary-en` (English dictionary; additional languages as needed)

2. **Create `src/lib/editor/spellcheck.ts`:**
   - Initialize nspell with the selected dictionary
   - Load personal dictionary from plugin settings
   - Create a CM6 linter extension that:
     - Walks the syntax tree to find prose ranges (token type `null`, `"strong"`, `"emphasis"`, `"heading"`, `"keyword"`)
     - Extracts words from prose ranges using regex (`/[a-zA-Z'\u00C0-\u024F]+/g` for Latin scripts)
     - Checks each word with `spell.correct(word)`
     - Returns `Diagnostic` objects for misspelled words
     - Includes actions: "Replace with [suggestion]", "Add to dictionary", "Ignore"
   - Use `delay: 400` for responsive debouncing
   - Only check visible ranges + buffer (`view.visibleRanges`) for performance

3. **Plugin settings (in index.ts):**
   - `spellcheck.enabled` (boolean, default: true)
   - `spellcheck.language` (dropdown: en, en-gb, fr, de, es, it, pt, ru, nl, etc.)
   - `spellcheck.customDictionary` (text area or hidden setting storing newline-separated words)

4. **IPC messages:**
   - `getSpellcheckSettings` -> returns `{ enabled, language, customDictionary }`
   - `updateCustomDictionary` -> persists updated word list to settings
   - `getAvailableDictionaries` -> returns list of bundled language codes

5. **Dictionary bundling strategy:**
   - Bundle English (`dictionary-en`) in the plugin (adds ~575 KB to bundle)
   - Additional languages: either bundle all desired languages, or implement lazy loading via IPC (the sandbox can `require()` dictionary packages at runtime)

6. **Toolbar integration:**
   - Add a spell-check toggle button to the Editor panel
   - Add a "Language" dropdown
   - Consider a status indicator showing "Spell check: EN" or "Loading dictionary..."

### Performance Optimizations

- **Viewport-only checking:** Only check words in `view.visibleRanges` plus a configurable buffer (e.g., 500 lines above/below)
- **Word cache:** Cache `correct()` results in a `Map<string, boolean>` to avoid re-checking the same word
- **Debounced linting:** Use the linter's built-in `delay: 400` to avoid checking on every keystroke
- **Lazy suggestions:** Only call `suggest()` when the user interacts with a diagnostic (hover, click, or keyboard action), not upfront for every misspelled word
- **Incremental updates:** On small edits, only re-check words near the change. The linter re-runs on every change but the word cache makes repeated checks instant

---

## 16. Sources

### nspell
- [nspell GitHub repository](https://github.com/wooorm/nspell)
- [nspell on npm](https://www.npmjs.com/package/nspell)
- [nspell on Bundlephobia](https://bundlephobia.com/package/nspell)
- [wooorm/dictionaries - 92 language dictionaries](https://github.com/wooorm/dictionaries)
- [PR: Replace Typo.js with nspell for performance](https://github.com/swenson/ace_spell_check_js/pull/4)
- [@types/nspell on npm](https://www.npmjs.com/package/@types/nspell)

### Typo.js
- [Typo.js on npm](https://www.npmjs.com/package/typo-js)
- [npm trends: nodehun vs nspell vs spellchecker vs typo-js](https://npmtrends.com/nodehun-vs-nspell-vs-spellchecker-vs-typo-js)

### spellchecker-wasm
- [spellchecker-wasm on GitHub](https://github.com/justinwilaby/spellchecker-wasm)

### CodeMirror 6
- [CM6 Lint Example](https://codemirror.net/examples/lint/)
- [CM6 Decoration Example](https://codemirror.net/examples/decoration/)
- [Showing off: Spellchecking in CM6, without tricks](https://discuss.codemirror.net/t/showing-off-spellchecking-in-cm6-without-tricks/3254)
- [CodeMirror and Spell Checking: Solved (chipx86 blog, 2025)](https://chipx86.blog/2025/06/26/codemirror-and-spell-checking-solved/)
- [Add browser spell checking - Issue #63](https://github.com/codemirror/codemirror.next/issues/63)
- [OS-level spellcheck disabled on iOS](https://discuss.codemirror.net/t/os-level-spellcheck-is-disabled-on-ios-even-after-adding-contentattribute/4128)
- [Set spellcheck attribute with Highlighter](https://discuss.codemirror.net/t/set-spellcheck-attribute-with-highlighter/3861)
- [How to do async lint](https://discuss.codemirror.net/t/how-to-do-async-lint/7110)
- [@codemirror/lint source](https://github.com/codemirror/lint/blob/main/src/lint.ts)

### Electron
- [Electron SpellChecker Tutorial](https://www.electronjs.org/docs/latest/tutorial/spellchecker)
- [Electron Session API](https://www.electronjs.org/docs/latest/api/session)
- [Electron webFrame API](https://www.electronjs.org/docs/latest/api/web-frame)
- [Electron PR #25060: Expose renderer spellcheck API](https://github.com/electron/electron/pull/25060)

### Joplin
- [Joplin Plugin System Architecture](https://joplinapp.org/help/dev/spec/plugins/)
- [Joplin Plugin API - joplin namespace](https://joplinapp.org/api/references/plugin_api/classes/joplin.html)
- [Joplin CM6 Plugin Tutorial](https://joplinapp.org/help/api/tutorials/cm6_plugin/)
- [Joplin SpellCheckerServiceDriverNative.ts](https://fossies.org/linux/joplin/packages/app-desktop/services/spellChecker/SpellCheckerServiceDriverNative.ts)
- [Joplin Forum: Spellcheck user dictionary](https://discourse.joplinapp.org/t/spellcheck-user-dictionary-suggestions/12699)

### AsciiDoc
- [Asciidoctor.js Extract API](https://docs.asciidoctor.org/asciidoctor.js/latest/processor/extract-api/)
- [asciidoctor.js #409: Extract text from AST](https://github.com/asciidoctor/asciidoctor.js/issues/409)
- [asciidoctor #1636: Plain text backend request](https://github.com/asciidoctor/asciidoctor/issues/1636)
- [tree-sitter-asciidoc](https://github.com/cathaysia/tree-sitter-asciidoc)
- [VS Code Spell Checker: AsciiDoc issue #1973](https://github.com/streetsidesoftware/vscode-spell-checker/issues/1973)

### General
- [Sapling: JavaScript Spelling and Grammar Checkers comparison](https://blog.sapling.ai/javascript-spelling-and-grammar-checkers/)
- [Vale AsciiDoc support](https://vale.sh/docs/formats/asciidoc)
