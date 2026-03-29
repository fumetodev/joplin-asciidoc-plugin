# Zoom Feature — Structural Refactor Proposal

## Why a Structural Approach

The [feasibility report](./ZOOM_SLIDER_FEASIBILITY_REPORT.md) describes a targeted fix: add a Compartment, override `fontSize`, convert ~10 CSS rules from px to em, and patch the height cache. That approach works, but it papers over a deeper architectural issue: **the live preview rendering system mixes absolute and relative units without a coherent sizing model, and the height estimation pipeline hardcodes pixel constants that mirror CSS values it cannot reference.**

A structural refactor takes zoom as the catalyst to fix the root cause. The result is a sizing system where zoom is a natural one-variable change rather than a special case requiring workarounds.

---

## The Current Sizing Architecture and Its Problems

### Problem 1: No Single Source of Truth for the Base Size

The number `14` appears in three disconnected forms:

| Location | Form | Line |
|----------|------|------|
| `livePreviewTheme` `.cm-line` | `fontSize: "14px"` | 4476 |
| `measureRawLineHeightPx()` | Reads `getComputedStyle().fontSize` at runtime | 119 |
| Height estimators | Reverse-engineer font size as `rawHeightPx / 1.6` | 1464, 1477 |

The theme declares 14px. The measurement function reads whatever the browser computed. The estimators *derive* font size by dividing line-height by 1.6. These three representations are coupled by convention, not by code. A zoom feature that changes one must hope the others follow — and the estimators' `/ 1.6` derivation only works if the line-height ratio hasn't changed.

### Problem 2: Height Estimation Mirrors CSS Constants It Cannot Reference

The code block height estimator (`live-preview.ts:4073-4076`):
```typescript
// Code block widget has: header (~28px) + code lines * lineHeight + padding (~24px)
cachedCodeHeight = 28 + (codeLineCount * rawBaseHeightPx) + 24;
```

The `28` comes from `.cm-lp-codeblock-header { padding: "4px 12px", fontSize: "0.75em" }` — the header's rendered height. The `24` comes from `.cm-lp-codeblock-pre { padding: "12px" }` — top + bottom padding. These are **hardcoded pixel guesses** that mirror the CSS theme but aren't derived from it. If the CSS changes (or scales due to zoom), the estimates diverge.

Similarly, the heading estimator knows the heading multipliers `[2, 1.5, 1.25, 1.1, 1]` and the heading line-height `1.4` — values that also exist in `renderLineHtml()` and `livePreviewTheme`. Three copies of the same knowledge.

### Problem 3: Mixed px and em in Content Styling

The `livePreviewTheme` has ~96 px values and ~61 em values in content-area rules. Some elements use em for padding (blockquotes: `0.5em 1em`) while structurally identical elements use px (admonitions: `10px 14px`). This inconsistency means some content scales with font-size and some doesn't — a problem even without zoom, since users on high-DPI displays or with accessibility needs may override font sizes.

### Problem 4: Height Cache Invalidation Is Document-Change-Only

The `PreviewHeightCache` clears only on `docChanged` (`live-preview.ts:4385-4386`). Any change that affects rendered height without changing document content — font-size, line-height, viewport width (which changes line wrapping), or theme changes — leaves stale heights in the cache. The stabilized line decorations then apply wrong padding, causing visual jumps.

---

## Proposed Architecture: Em-First Content Sizing with Derived Height Constants

### Core Principle

**Every content-area dimension should be expressible as a multiple of the base font-size, either directly (via `em` units in CSS) or derivably (via constants in JS that reference a measured base).** UI chrome (modals, toolbar, dropdowns) stays in fixed px — it's separate UI that shouldn't scale with editor zoom.

### Change 1: CSS Variable Scale Factor on the Editor Root

Define the zoom control surface as a single CSS variable:

```typescript
// In livePreviewTheme:
"&": {
  "--editor-scale": "1",
  "--editor-base-size": "14px",
  // ...existing properties...
},
".cm-line": {
  fontSize: "calc(var(--editor-base-size) * var(--editor-scale))",
  lineHeight: "1.6",
  // ...existing properties...
},
".cm-gutters": {
  fontSize: "calc(var(--editor-base-size) * var(--editor-scale))",
  // ...existing properties...
},
```

Zoom becomes:
```typescript
editorView.dom.style.setProperty("--editor-scale", String(percent / 100));
editorView.requestMeasure();
editorView.dispatch({ effects: refreshLivePreviewEffect.of(null) });
```

**No Compartment needed for the font-size itself.** The CSS variable change is picked up by the browser immediately. The `requestMeasure()` + `refreshLivePreviewEffect` dispatch tells CM6 and the live preview to remeasure and rebuild.

**Why this is better than a Compartment override:** A Compartment creates a second theme with its own scoped class that must win the CSS cascade over the first theme's scoped class. This depends on extension array ordering and CM6's internal stylesheet insertion order — fragile. A CSS variable in the *same* theme is self-contained: the theme references its own variable, and JS mutates that variable on the DOM element. No precedence games.

### Change 2: Convert Content-Area px Values to em

Convert the ~25 most impactful content-area px rules to em equivalents. At the default 14px base, the em values produce identical pixel results, so there's zero visual change at 100% zoom.

**Conversion table (14px base):**

| Selector | Property | Current | Proposed | Equivalent at 14px |
|----------|----------|---------|----------|-------------------|
| `.cm-lp-admon` | padding | `10px 14px` | `0.714em 1em` | 10px 14px |
| `.cm-lp-admon` | gap | `14px` | `1em` | 14px |
| `.cm-lp-admon` | borderLeft | `4px solid` | `0.286em solid` | 4px |
| `.cm-lp-admon-line` | paddingTop/Bottom | `4px` | `0.286em` | 4px |
| `.cm-lp-admon-block` | padding | `10px 14px` | `0.714em 1em` | 10px 14px |
| `.cm-lp-admon-block` | gap | `4px` | `0.286em` | 4px |
| `.cm-lp-admon-label` | minWidth | `70px` | `5em` | 70px |
| `.cm-lp-codeblock-header` | padding | `4px 12px` | `0.286em 0.857em` | 4px 12px |
| `.cm-lp-codeblock-pre` | padding | `12px` | `0.857em` | 12px |
| `.cm-lp-table th/td` | padding | `6px 12px` | `0.429em 0.857em` | 6px 12px |
| `.cm-lp-table-buttons` | padding | `6px 8px` | `0.429em 0.571em` | 6px 8px |
| `.cm-lp-table-buttons` | gap | `4px` | `0.286em` | 4px |
| `.cm-lp-kbd` | padding | `2px 6px` | `0.143em 0.429em` | 2px 6px |
| `.cm-lp-btn` | padding | `2px 10px` | `0.143em 0.714em` | 2px 10px |
| `.cm-lp-footnote-popup` | padding | `10px 14px` | `0.714em 1em` | 10px 14px |
| `.cm-lp-docheader` | padding | `8px 12px` | `0.571em 0.857em` | 8px 12px |
| `.cm-lp-docheader` | gap | `6px` | `0.429em` | 6px |
| `.cm-lp-docheader-tags` | gap | `4px` | `0.286em` | 4px |
| `.cm-lp-docheader-tag-name/value` | padding | `1px 5px` | `0.071em 0.357em` | 1px 5px |
| `.cm-scroller` | padding | `12px 0` | `0.857em 0` | 12px 0 |

**Values intentionally left as px:**
- `border: 1px solid` — hairline borders are a visual constant; scaling them looks wrong
- `borderRadius: 2px–8px` — corner rounding is decorative; scaling produces oddly rounded corners at high zoom. Leaving at px keeps corners crisp.
- `boxShadow` — shadow spread/blur is a visual effect, not content sizing
- All modal/overlay/dropdown styles — these are UI chrome
- `letterSpacing` — tracking is typically a fixed optical adjustment

**In `editor.css`, convert the base `.cm-line` padding:**
```css
/* Before: */
#editor-pane .cm-line {
  padding-left: calc(20px + var(--content-margin, 0px));
  padding-right: calc(20px + var(--content-margin, 0px));
}

/* After: */
#editor-pane .cm-line {
  padding-left: calc(1.429em + var(--content-margin, 0px));
  padding-right: calc(1.429em + var(--content-margin, 0px));
}
```

### Change 3: Derive Height Constants from the Measured Base

Replace hardcoded pixel estimates with calculations derived from `rawBaseHeightPx`.

**Code block height estimate (line 4073-4076):**

```typescript
// Before:
cachedCodeHeight = 28 + (codeLineCount * rawBaseHeightPx) + 24;

// After — derive header and padding heights from the measured base:
const baseFontPx = rawBaseHeightPx / 1.6; // inverse of lineHeight: 1.6
const headerHeightPx = baseFontPx * 0.75 * 1.4 + baseFontPx * 0.286 * 2;
  // fontSize: 0.75em * lineHeight ~1.4 + padding: 0.286em * 2 (top+bottom)
const bodyPaddingPx = baseFontPx * 0.857 * 2;
  // padding: 0.857em * 2 (top+bottom)
cachedCodeHeight = headerHeightPx + (codeLineCount * rawBaseHeightPx) + bodyPaddingPx;
```

This is more verbose but **self-correcting**: when `rawBaseHeightPx` changes (due to zoom), the estimate scales proportionally because all terms derive from it.

**To keep this maintainable, extract the magic numbers as named constants:**

```typescript
// At module scope, alongside existing constants:
const CODE_HEADER_FONT_EM = 0.75;       // matches .cm-lp-codeblock-header fontSize
const CODE_HEADER_LINE_HEIGHT = 1.4;     // approximate header line-height
const CODE_HEADER_PADDING_EM = 0.286;    // matches .cm-lp-codeblock-header padding (top+bottom each)
const CODE_BODY_PADDING_EM = 0.857;      // matches .cm-lp-codeblock-pre padding

function estimateCodeBlockHeightPx(codeLineCount: number, rawBaseHeightPx: number): number {
  const baseFontPx = rawBaseHeightPx / 1.6;
  const headerHeight = baseFontPx * CODE_HEADER_FONT_EM * CODE_HEADER_LINE_HEIGHT
                     + baseFontPx * CODE_HEADER_PADDING_EM * 2;
  const bodyPadding = baseFontPx * CODE_BODY_PADDING_EM * 2;
  return headerHeight + (codeLineCount * rawBaseHeightPx) + bodyPadding;
}
```

The heading and list estimators (`estimateHeadingLineHeightPx`, `estimateListLineHeightPx`) already derive from `rawBaseHeightPx` using em-like multipliers — they're already structurally correct and need no changes.

### Change 4: Make Height Cache Zoom-Aware

Add zoom change detection to the `update()` method so the height cache is cleared when zoom changes.

**Approach: Track the last-known font size and clear on change.**

```typescript
// In the ViewPlugin class:
class {
  decorations: any;
  heightCache: PreviewHeightCache;
  lastRawHeight: number;

  constructor(view: EditorView) {
    this.heightCache = createPreviewHeightCache();
    this.lastRawHeight = measureRawLineHeightPx(view);
    this.decorations = buildDecorations(view, this.heightCache);
    schedulePreviewHeightMeasurement(view, this.heightCache);
  }

  update(update: any) {
    // ... existing forceRefresh check ...

    if (update.docChanged) {
      this.heightCache.lineHeights.clear();
      closeFootnotePopup();
    }

    // Detect zoom/font-size changes by checking if base line height changed
    const currentRawHeight = measureRawLineHeightPx(update.view);
    if (Math.abs(currentRawHeight - this.lastRawHeight) > 0.5) {
      this.heightCache.lineHeights.clear();
      this.lastRawHeight = currentRawHeight;
    }

    // ... rest of update() ...
  }
}
```

This is zoom-mechanism-agnostic: it doesn't matter whether the font-size changed via CSS variable, Compartment, user stylesheet, or browser zoom. If the measured base height changed, the cache is cleared.

**Why `measureRawLineHeightPx` is safe to call in `update()`:** It's a single `getComputedStyle` read — fast and side-effect-free. It's already called every time `buildDecorations()` runs, so adding one more call in `update()` is negligible.

### Change 5: Post-Zoom Rebuild Timing

After setting the CSS variable, the browser needs one frame to recalculate styles before `measureRawLineHeightPx()` returns the new value. The zoom callback should be:

```typescript
onZoomChange(percent: number) {
  localStorage.setItem("asciidoc-editor-zoom", String(percent));
  editorView.dom.style.setProperty("--editor-scale", String(percent / 100));
  // Allow one frame for style recalculation, then trigger rebuild
  requestAnimationFrame(() => {
    if (editorView) {
      editorView.dispatch({ effects: refreshLivePreviewEffect.of(null) });
    }
  });
}
```

The `refreshLivePreviewEffect` dispatch triggers the `update()` method, which detects the height change (Change 4), clears the cache, and rebuilds decorations with the new measured base. The one-frame delay ensures `getComputedStyle` returns the updated font-size.

---

## What This Architecture Enables

### Zoom is a one-variable change
```typescript
editorView.dom.style.setProperty("--editor-scale", "1.25");
```
No Compartment, no theme override, no cascade battle. The variable lives in the same theme that references it.

### Height estimates are self-correcting
All height calculations derive from `rawBaseHeightPx`, which is measured from the DOM. When font-size scales, `rawBaseHeightPx` scales, and every estimate follows. No hardcoded px constants to keep in sync.

### Height cache is self-healing
The zoom-change detection in `update()` doesn't depend on knowing *how* the zoom changed — it observes the effect (line-height changed) and reacts. This also fixes a pre-existing latent bug: any external cause of font-size change (browser zoom, user stylesheet, accessibility settings) would now correctly invalidate the cache.

### Future theme changes are safer
Converting content-area styling to em means that any future change to the base font-size (e.g., a "font size" user preference separate from zoom) automatically cascades to all content elements. No need to audit which px values need updating.

---

## Complete File Change Map

### `src/lib/editor/live-preview.ts`

| Area | Changes |
|------|---------|
| **livePreviewTheme `"&"` rule** (~line 4463) | Add `"--editor-scale": "1"` and `"--editor-base-size": "14px"` |
| **livePreviewTheme `.cm-line` rule** (line 4476) | Change `fontSize: "14px"` to `fontSize: "calc(var(--editor-base-size) * var(--editor-scale))"` |
| **livePreviewTheme `.cm-gutters` rule** (line 4492) | Add `fontSize: "calc(var(--editor-base-size) * var(--editor-scale))"` |
| **~25 content-area CSS rules** (see conversion table) | Convert px padding/gap/margin to em equivalents |
| **Height estimation** (line 4073-4076) | Extract `estimateCodeBlockHeightPx()` function, derive from `rawBaseHeightPx` instead of hardcoded 28+24 |
| **ViewPlugin class** (line 4371) | Add `lastRawHeight` field, add zoom-change detection in `update()` |
| **Named constants** (near line 94) | Add `CODE_HEADER_FONT_EM`, `CODE_HEADER_PADDING_EM`, `CODE_BODY_PADDING_EM` |

### `src/lib/toolbar/panels/editor-panel.ts`

| Area | Changes |
|------|---------|
| **`EditorPanelOptions` interface** (line 1) | Add `onZoomChange: (percent: number) => void` |
| **`buildEditorPanel` function** (line 26) | Add `initialZoom` parameter |
| **New "Zoom" section** (after line 131) | Range slider (80-150, step 5), value display, reset button — same pattern as margin slider |

### `src/panel.ts`

| Area | Changes |
|------|---------|
| **State initialization** (~line 37) | Add `let currentZoom = parseInt(localStorage.getItem("asciidoc-editor-zoom") \|\| "100", 10)` |
| **`init()` function** (~line 432) | Restore zoom from localStorage, apply to `--editor-scale` |
| **`buildRibbon` callbacks** (~line 445) | Add `onZoomChange` callback: set CSS variable, persist, trigger rebuild |
| **`createEditor` extensions** (~line 318) | No change needed (no Compartment required) |

### `src/styles/editor.css`

| Area | Changes |
|------|---------|
| **`.cm-line` padding** (line 720-721) | Convert `20px` base to `1.429em` |
| **New styles** | Add `.ribbon-zoom-control`, `.ribbon-zoom-slider`, `.ribbon-zoom-reset` (copy margin slider pattern) |

---

## Migration Safety

**Zero visual change at 100% zoom.** Every em conversion is the exact mathematical equivalent of the px value at 14px base font:

```
14px * 0.714em = 10.0px  (rounds to 10px)
14px * 1.000em = 14.0px
14px * 0.857em = 12.0px
14px * 0.286em =  4.0px
14px * 0.429em =  6.0px
14px * 0.571em =  8.0px
14px * 0.143em =  2.0px
14px * 1.429em = 20.0px
```

Sub-pixel rendering differences are negligible (< 0.1px) and browsers round to the nearest device pixel anyway.

**The height estimation refactor** produces the same numeric results at 14px:
- Old: `28 + lineCount * 22.4 + 24`
- New: `(14 * 0.75 * 1.4 + 14 * 0.286 * 2) + lineCount * 22.4 + (14 * 0.857 * 2)` = `(14.7 + 8.0) + lineCount * 22.4 + 24.0` = `22.7 + lineCount * 22.4 + 24.0`

The old estimate of `28` was approximate anyway (the actual rendered header height depends on font metrics). The new formula is closer to the true value and, critically, **scales correctly**.

---

## Scope Comparison

| | Targeted Fix (Current Report) | Structural Refactor (This Proposal) |
|---|---|---|
| **Lines changed** | ~150-200 | ~250-350 |
| **Files touched** | 4 | 4 (same files) |
| **New abstractions** | 1 Compartment | 2 CSS variables, 1 helper function, ~4 named constants |
| **Height cache fix** | Custom effect or nuclear clear | Self-detecting via measured height comparison |
| **Theme precedence concerns** | Yes (Compartment must win cascade) | No (CSS variable is self-contained) |
| **Hardcoded height constants** | Left as-is (only cache fix) | Replaced with derived calculations |
| **Pre-existing bugs fixed** | 0 | 1 (height cache not invalidated on external font-size changes) |
| **Future zoom range extensible** | Yes | Yes |
| **Maintenance burden** | Low (but fragile theme precedence) | Lower (self-contained, self-correcting) |

---

## Recommended Approach

The structural refactor is **moderately more work** (~100 extra lines, mostly mechanical px-to-em conversions in the theme) but produces a **significantly more robust result**. The height estimation and cache invalidation improvements fix real latent issues independent of zoom.

If the priority is shipping zoom quickly, the targeted fix from the feasibility report is viable. If the priority is doing it right and avoiding zoom-related bugs down the road, this refactor is the better investment.

Both approaches produce the same user-facing feature (a zoom slider in the Editor tab) and can be tested identically.
