import {
  formattingItems,
  fontColors,
  highlightColors,
  handleFontColor,
  handleHighlight,
  positionDropdown,
  transformSelection,
} from "../toolbar-actions";

/** Helper: creates a `.ribbon-section` wrapper with label and child controls. */
function createRibbonSection(label: string, ...children: HTMLElement[]): HTMLElement {
  const section = document.createElement("div");
  section.className = "ribbon-section";

  const controls = document.createElement("div");
  controls.className = "ribbon-section-controls";
  for (const child of children) controls.appendChild(child);

  const lbl = document.createElement("div");
  lbl.className = "ribbon-section-label";
  lbl.textContent = label;

  section.appendChild(controls);
  section.appendChild(lbl);
  return section;
}

const ARROW_SVG = `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"/></svg>`;
const REMOVE_X_SVG = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;

export function buildTextPanel(): { element: HTMLElement; cleanup: () => void } {
  const wrapper = document.createElement("div");
  wrapper.style.display = "contents";

  // Track open dropdowns for outside-click closing
  let fontColorOpen = false;
  let highlightOpen = false;
  let fontColorWrapEl: HTMLElement | null = null;
  let highlightWrapEl: HTMLElement | null = null;

  function closeAll() {
    fontColorOpen = false;
    highlightOpen = false;
    const fc = fontColorWrapEl?.querySelector(".split-dropdown");
    if (fc) fc.remove();
    const hl = highlightWrapEl?.querySelector(".split-dropdown");
    if (hl) hl.remove();
  }

  // --- Font section ---
  const fontRow = document.createElement("div");
  fontRow.className = "ribbon-row";

  for (const item of formattingItems) {
    const btn = document.createElement("button");
    btn.className = "ribbon-icon-btn";
    btn.title = item.title;
    btn.innerHTML = item.icon;
    btn.addEventListener("click", () => item.action());
    fontRow.appendChild(btn);
  }

  // Text Case split button
  let caseDropdownOpen = false;
  const caseWrap = document.createElement("div");
  caseWrap.className = "split-btn-wrap";

  const caseBtn = document.createElement("button");
  caseBtn.className = "ribbon-icon-btn";
  caseBtn.title = "Change Text Case (cycle)";
  caseBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 15h6l-3-8z"/><path d="M1 19h10"/><path d="M14 8h4a2 2 0 0 1 0 4h-4v4h4a2 2 0 0 1 0 4h-4"/></svg>`;
  caseBtn.addEventListener("click", () => transformSelection("cycle"));

  const caseArrow = document.createElement("button");
  caseArrow.className = "split-arrow";
  caseArrow.title = "Text case options";
  caseArrow.innerHTML = ARROW_SVG;
  caseArrow.addEventListener("click", (e) => {
    e.stopPropagation();
    const was = caseDropdownOpen;
    closeCaseDropdown();
    if (!was) showCaseDropdown();
  });

  caseWrap.appendChild(caseBtn);
  caseWrap.appendChild(caseArrow);
  fontRow.appendChild(caseWrap);

  function closeCaseDropdown() {
    caseDropdownOpen = false;
    const dd = caseWrap.querySelector(".split-dropdown");
    if (dd) dd.remove();
  }

  function showCaseDropdown() {
    caseDropdownOpen = true;
    const dd = document.createElement("div");
    dd.className = "split-dropdown open";
    dd.setAttribute("role", "menu");

    const options = [
      { label: "CAPITALIZED", value: "upper" },
      { label: "Title Case", value: "title" },
      { label: "lower case", value: "lower" },
      { label: "snake_case", value: "snake" },
    ];

    for (const opt of options) {
      const item = document.createElement("button");
      item.className = "split-dropdown-item";
      item.textContent = opt.label;
      item.addEventListener("click", (e) => {
        e.stopPropagation();
        transformSelection(opt.value);
        closeCaseDropdown();
      });
      dd.appendChild(item);
    }

    caseWrap.appendChild(dd);
    positionDropdown(dd);

    const onClickOutside = (ev: MouseEvent) => {
      if (!caseWrap.contains(ev.target as Node)) {
        closeCaseDropdown();
        document.removeEventListener("mousedown", onClickOutside);
      }
    };
    document.addEventListener("mousedown", onClickOutside);
  }

  wrapper.appendChild(createRibbonSection("Font", fontRow));

  // --- Color section ---
  const colorRow = document.createElement("div");
  colorRow.className = "ribbon-row";

  // Font Color split button
  const fontColorWrap = document.createElement("div");
  fontColorWrap.className = "split-btn-wrap";
  fontColorWrapEl = fontColorWrap;

  const fontColorBtn = document.createElement("button");
  fontColorBtn.className = "ribbon-icon-btn";
  fontColorBtn.title = "Font Color";
  fontColorBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h16"/><path d="m9 4 3 8 3-8"/><path d="M7 16l2-4h6l2 4"/></svg>`;
  fontColorBtn.addEventListener("click", () => toggleFontColor());

  const fontColorArrow = document.createElement("button");
  fontColorArrow.className = "split-arrow";
  fontColorArrow.title = "Choose font color";
  fontColorArrow.innerHTML = ARROW_SVG;
  fontColorArrow.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleFontColor();
  });

  fontColorWrap.appendChild(fontColorBtn);
  fontColorWrap.appendChild(fontColorArrow);
  colorRow.appendChild(fontColorWrap);

  function toggleFontColor() {
    const was = fontColorOpen;
    closeAll();
    if (!was) {
      fontColorOpen = true;
      showFontColorDropdown();
    }
  }

  function showFontColorDropdown() {
    const dd = document.createElement("div");
    dd.className = "split-dropdown open";
    dd.setAttribute("role", "menu");

    const grid = document.createElement("div");
    grid.className = "color-grid";
    for (const color of fontColors) {
      const swatch = document.createElement("button");
      swatch.className = "color-swatch";
      swatch.style.background = color.hex;
      swatch.title = color.name;
      swatch.addEventListener("click", () => {
        handleFontColor(color.value);
        closeAll();
      });
      grid.appendChild(swatch);
    }
    dd.appendChild(grid);

    const removeBtn = document.createElement("button");
    removeBtn.className = "color-remove-btn";
    removeBtn.innerHTML = `${REMOVE_X_SVG} Remove color`;
    removeBtn.addEventListener("click", () => {
      handleFontColor("");
      closeAll();
    });
    dd.appendChild(removeBtn);

    fontColorWrap.appendChild(dd);
    positionDropdown(dd);
  }

  // Highlight split button
  const highlightWrap = document.createElement("div");
  highlightWrap.className = "split-btn-wrap";
  highlightWrapEl = highlightWrap;

  const highlightBtn = document.createElement("button");
  highlightBtn.className = "ribbon-icon-btn";
  highlightBtn.title = "Highlight";
  highlightBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 11-6 6v3h9l3-3"/><path d="m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4"/></svg>`;
  highlightBtn.addEventListener("click", () => toggleHighlight());

  const highlightArrow = document.createElement("button");
  highlightArrow.className = "split-arrow";
  highlightArrow.title = "Choose highlight color";
  highlightArrow.innerHTML = ARROW_SVG;
  highlightArrow.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleHighlight();
  });

  highlightWrap.appendChild(highlightBtn);
  highlightWrap.appendChild(highlightArrow);
  colorRow.appendChild(highlightWrap);

  function toggleHighlight() {
    const was = highlightOpen;
    closeAll();
    if (!was) {
      highlightOpen = true;
      showHighlightDropdown();
    }
  }

  function showHighlightDropdown() {
    const dd = document.createElement("div");
    dd.className = "split-dropdown open";
    dd.setAttribute("role", "menu");

    const grid = document.createElement("div");
    grid.className = "color-grid";
    for (const color of highlightColors) {
      const swatch = document.createElement("button");
      swatch.className = "color-swatch";
      swatch.style.background = color.hex;
      swatch.title = color.name;
      swatch.addEventListener("click", () => {
        handleHighlight(color.value);
        closeAll();
      });
      grid.appendChild(swatch);
    }
    dd.appendChild(grid);

    const removeBtn = document.createElement("button");
    removeBtn.className = "color-remove-btn";
    removeBtn.innerHTML = `${REMOVE_X_SVG} Remove highlight`;
    removeBtn.addEventListener("click", () => {
      handleHighlight("");
      closeAll();
    });
    dd.appendChild(removeBtn);

    highlightWrap.appendChild(dd);
    positionDropdown(dd);
  }

  wrapper.appendChild(createRibbonSection("Color", colorRow));

  // --- Search section ---
  const searchRow = document.createElement("div");
  searchRow.className = "ribbon-row";

  const searchBtn = document.createElement("button");
  searchBtn.className = "ribbon-icon-btn";
  searchBtn.title = "Find & Replace";
  searchBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>`;
  searchBtn.addEventListener("click", () => {
    window.dispatchEvent(new CustomEvent("open-search"));
  });
  searchRow.appendChild(searchBtn);

  wrapper.appendChild(createRibbonSection("Find", searchRow));

  // Outside-click handler
  function handleWindowClick(e: MouseEvent) {
    const target = e.target as Node;
    if (fontColorOpen && fontColorWrapEl && !fontColorWrapEl.contains(target)) {
      fontColorOpen = false;
      const dd = fontColorWrapEl.querySelector(".split-dropdown");
      if (dd) dd.remove();
    }
    if (highlightOpen && highlightWrapEl && !highlightWrapEl.contains(target)) {
      highlightOpen = false;
      const dd = highlightWrapEl.querySelector(".split-dropdown");
      if (dd) dd.remove();
    }
  }

  window.addEventListener("mousedown", handleWindowClick, true);

  return {
    element: wrapper,
    cleanup: () => {
      window.removeEventListener("mousedown", handleWindowClick, true);
    },
  };
}
