import { wrapSelection, insertText, prefixLine, positionDropdown } from "../toolbar-actions";
import { getBiblioLabels } from "../../editor/live-preview";

const ARROW_SVG = `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"/></svg>`;

// Smart Quotes state — persisted via localStorage, read by panel.ts input handler
let smartQuotesEnabled = localStorage.getItem("asciidoc-smart-quotes") === "true";
export function isSmartQuotesEnabled(): boolean { return smartQuotesEnabled; }

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

// ---------------------------------------------------------------
// Dropdown state
// ---------------------------------------------------------------

interface DropdownState {
  quotes: boolean;
  passthrough: boolean;
  menu: boolean;
  footnote: boolean;
  anchor: boolean;
  keyboard: boolean;
  cite: boolean;
}

export function buildFormattingPanel(): { element: HTMLElement; cleanup: () => void } {
  const wrapper = document.createElement("div");
  wrapper.style.display = "contents";

  const state: DropdownState = { quotes: false, passthrough: false, menu: false, footnote: false, anchor: false, keyboard: false, cite: false };
  const wrapEls: Map<keyof DropdownState, HTMLElement> = new Map();

  function closeAll() {
    for (const key of Object.keys(state) as (keyof DropdownState)[]) {
      state[key] = false;
    }
    for (const [, el] of wrapEls) {
      const dd = el.querySelector(".split-dropdown");
      if (dd) dd.remove();
    }
  }

  function toggle(which: keyof DropdownState) {
    const was = state[which];
    closeAll();
    if (!was) {
      state[which] = true;
      buildDropdown(which);
    }
  }

  function handleWindowClick(e: MouseEvent) {
    const target = e.target as Element;
    if (target?.closest?.(".split-btn-wrap")) return;
    if (Object.values(state).some(Boolean)) closeAll();
  }
  window.addEventListener("mousedown", handleWindowClick, true);

  // ---------------------------------------------------------------
  // Simple buttons section (Keyboard, Button, Comment)
  // ---------------------------------------------------------------

  const simpleRow = document.createElement("div");
  simpleRow.className = "ribbon-row";

  // Keyboard — split button with preset dropdown
  const kbdWrap = document.createElement("div");
  kbdWrap.className = "split-btn-wrap";
  wrapEls.set("keyboard", kbdWrap);

  const kbdBtn = document.createElement("button");
  kbdBtn.className = "ribbon-labeled-btn";
  kbdBtn.title = "Keyboard (kbd:[...])";
  kbdBtn.innerHTML = `<span class="rlb-label">Keyboard</span>`;
  kbdBtn.addEventListener("click", () => wrapSelection("kbd:[", "]"));

  const kbdArrow = document.createElement("button");
  kbdArrow.className = "split-arrow";
  kbdArrow.innerHTML = ARROW_SVG;
  kbdArrow.addEventListener("click", (e) => { e.stopPropagation(); toggle("keyboard"); });

  kbdWrap.appendChild(kbdBtn);
  kbdWrap.appendChild(kbdArrow);
  simpleRow.appendChild(kbdWrap);

  // Button — wraps selection
  const btnBtn = document.createElement("button");
  btnBtn.className = "ribbon-labeled-btn";
  btnBtn.title = "Button (btn:[...])";
  btnBtn.innerHTML = `<span class="rlb-label">Button</span>`;
  btnBtn.addEventListener("click", () => wrapSelection("btn:[", "]"));
  simpleRow.appendChild(btnBtn);

  // Comment — toggles line prefix
  const commentBtn = document.createElement("button");
  commentBtn.className = "ribbon-labeled-btn";
  commentBtn.title = "Comment (// ...)";
  commentBtn.innerHTML = `<span class="rlb-label">Comment</span>`;
  commentBtn.addEventListener("click", () => prefixLine("// "));
  simpleRow.appendChild(commentBtn);



  // --- Quotes split button ---
  const quotesWrap = document.createElement("div");
  quotesWrap.className = "split-btn-wrap";
  wrapEls.set("quotes", quotesWrap);

  const quotesBtn = document.createElement("button");
  quotesBtn.className = "ribbon-labeled-btn";
  quotesBtn.title = 'Smart Quotes ("\u2026")';
  quotesBtn.innerHTML = `<span class="rlb-label">Quotes</span>`;
  quotesBtn.addEventListener("click", () => wrapSelection('"`', '`"'));

  const quotesArrow = document.createElement("button");
  quotesArrow.className = "split-arrow";
  quotesArrow.innerHTML = ARROW_SVG;
  quotesArrow.addEventListener("click", (e) => { e.stopPropagation(); toggle("quotes"); });

  quotesWrap.appendChild(quotesBtn);
  quotesWrap.appendChild(quotesArrow);
  simpleRow.appendChild(quotesWrap);

  // --- Passthrough split button ---
  const passWrap = document.createElement("div");
  passWrap.className = "split-btn-wrap";
  wrapEls.set("passthrough", passWrap);

  const passBtn = document.createElement("button");
  passBtn.className = "ribbon-labeled-btn";
  passBtn.title = "Passthrough (++\u2026++)";
  passBtn.innerHTML = `<span class="rlb-label">Passthrough</span>`;
  passBtn.addEventListener("click", () => wrapSelection("++", "++"));

  const passArrow = document.createElement("button");
  passArrow.className = "split-arrow";
  passArrow.innerHTML = ARROW_SVG;
  passArrow.addEventListener("click", (e) => { e.stopPropagation(); toggle("passthrough"); });

  passWrap.appendChild(passBtn);
  passWrap.appendChild(passArrow);
  simpleRow.appendChild(passWrap);

  wrapper.appendChild(createRibbonSection("Inline", simpleRow));

  // ---------------------------------------------------------------
  // Split-button section (Menu, Footnote, Anchor)
  // ---------------------------------------------------------------

  const macroRow = document.createElement("div");
  macroRow.className = "ribbon-row";

  // --- Menu split button ---
  const menuWrap = document.createElement("div");
  menuWrap.className = "split-btn-wrap";
  wrapEls.set("menu", menuWrap);

  const menuBtn = document.createElement("button");
  menuBtn.className = "ribbon-labeled-btn";
  menuBtn.title = "Menu (menu:...[...])";
  menuBtn.innerHTML = `<span class="rlb-label">Menu</span>`;
  menuBtn.addEventListener("click", () => toggle("menu"));

  const menuArrow = document.createElement("button");
  menuArrow.className = "split-arrow";
  menuArrow.innerHTML = ARROW_SVG;
  menuArrow.addEventListener("click", (e) => { e.stopPropagation(); toggle("menu"); });

  menuWrap.appendChild(menuBtn);
  menuWrap.appendChild(menuArrow);
  macroRow.appendChild(menuWrap);

  // --- Footnote split button ---
  const fnWrap = document.createElement("div");
  fnWrap.className = "split-btn-wrap";
  wrapEls.set("footnote", fnWrap);

  const fnBtn = document.createElement("button");
  fnBtn.className = "ribbon-labeled-btn";
  fnBtn.title = "Footnote (footnote:[...])";
  fnBtn.innerHTML = `<span class="rlb-label">Footnote</span>`;
  fnBtn.addEventListener("click", () => toggle("footnote"));

  const fnArrow = document.createElement("button");
  fnArrow.className = "split-arrow";
  fnArrow.innerHTML = ARROW_SVG;
  fnArrow.addEventListener("click", (e) => { e.stopPropagation(); toggle("footnote"); });

  fnWrap.appendChild(fnBtn);
  fnWrap.appendChild(fnArrow);
  macroRow.appendChild(fnWrap);

  // --- Anchor split button ---
  const anchorWrap = document.createElement("div");
  anchorWrap.className = "split-btn-wrap";
  wrapEls.set("anchor", anchorWrap);

  const anchorBtn = document.createElement("button");
  anchorBtn.className = "ribbon-labeled-btn";
  anchorBtn.title = "Anchor ([[...]])";
  anchorBtn.innerHTML = `<span class="rlb-label">Anchor</span>`;
  anchorBtn.addEventListener("click", () => toggle("anchor"));

  const anchorArrow = document.createElement("button");
  anchorArrow.className = "split-arrow";
  anchorArrow.innerHTML = ARROW_SVG;
  anchorArrow.addEventListener("click", (e) => { e.stopPropagation(); toggle("anchor"); });

  anchorWrap.appendChild(anchorBtn);
  anchorWrap.appendChild(anchorArrow);
  macroRow.appendChild(anchorWrap);

  wrapper.appendChild(createRibbonSection("Macros", macroRow));

  // ---------------------------------------------------------------
  // Bibliography section
  // ---------------------------------------------------------------

  const biblioRow = document.createElement("div");
  biblioRow.className = "ribbon-section-controls";
  biblioRow.style.display = "flex";
  biblioRow.style.gap = "4px";

  const addBiblioBtn = document.createElement("button");
  addBiblioBtn.className = "ribbon-labeled-btn";
  addBiblioBtn.title = "Insert bibliography section or open existing one";
  addBiblioBtn.innerHTML = `<span class="rlb-label">Bibliography</span>`;
  addBiblioBtn.addEventListener("click", () => {
    window.dispatchEvent(new CustomEvent("editor-command", { detail: { command: "insert-bibliography" } }));
  });
  biblioRow.appendChild(addBiblioBtn);

  const citeWrap = document.createElement("div");
  citeWrap.className = "split-btn-wrap";
  wrapEls.set("cite", citeWrap);

  const citeBtn = document.createElement("button");
  citeBtn.className = "ribbon-labeled-btn";
  citeBtn.title = "Insert citation reference (<<ref>>)";
  citeBtn.innerHTML = `<span class="rlb-label">Cite</span>`;
  citeBtn.addEventListener("click", () => {
    insertText("<<>>", 2);
  });

  const citeArrow = document.createElement("button");
  citeArrow.className = "split-arrow";
  citeArrow.innerHTML = ARROW_SVG;
  citeArrow.addEventListener("click", (e) => { e.stopPropagation(); toggle("cite"); });

  citeWrap.appendChild(citeBtn);
  citeWrap.appendChild(citeArrow);
  biblioRow.appendChild(citeWrap);

  wrapper.appendChild(createRibbonSection("References", biblioRow));

  // ---------------------------------------------------------------
  // Dropdown builders
  // ---------------------------------------------------------------

  function buildDropdown(which: keyof DropdownState) {
    switch (which) {
      case "quotes": buildQuotesDropdown(); break;
      case "passthrough": buildPassthroughDropdown(); break;
      case "menu": buildMenuDropdown(); break;
      case "footnote": buildFootnoteDropdown(); break;
      case "anchor": buildAnchorDropdown(); break;
      case "keyboard": buildKeyboardDropdown(); break;
      case "cite": buildCiteDropdown(); break;
    }
  }

  function buildQuotesDropdown() {
    const dd = document.createElement("div");
    dd.className = "split-dropdown open";
    dd.setAttribute("role", "menu");

    const options = [
      { label: '\u201CDouble Curly\u201D', before: '"`', after: '`"' },
      { label: '\u2018Single Curly\u2019', before: "'`", after: "`'" },
    ];
    for (const opt of options) {
      const item = document.createElement("button");
      item.className = "split-dropdown-item";
      item.textContent = opt.label;
      item.addEventListener("click", () => { wrapSelection(opt.before, opt.after); closeAll(); });
      dd.appendChild(item);
    }

    // Smart Quotes toggle
    const sep = document.createElement("div");
    sep.style.cssText = "border-top:1px solid var(--asciidoc-border,#ddd);margin:4px 0";
    dd.appendChild(sep);

    const toggleItem = document.createElement("label");
    toggleItem.className = "split-dropdown-item";
    toggleItem.style.cssText = "display:flex;align-items:center;gap:6px;cursor:pointer;user-select:none";

    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = smartQuotesEnabled;
    cb.style.cssText = "width:14px;height:14px;margin:0;cursor:pointer;accent-color:var(--asciidoc-link,#2156a5)";
    cb.addEventListener("change", () => {
      smartQuotesEnabled = cb.checked;
      localStorage.setItem("asciidoc-smart-quotes", String(cb.checked));
    });

    const toggleLabel = document.createElement("span");
    toggleLabel.textContent = "\u201CSmart Quotes\u201D";

    toggleItem.appendChild(cb);
    toggleItem.appendChild(toggleLabel);
    dd.appendChild(toggleItem);

    quotesWrap.appendChild(dd);
    positionDropdown(dd);
  }

  function buildPassthroughDropdown() {
    const dd = document.createElement("div");
    dd.className = "split-dropdown open";
    dd.setAttribute("role", "menu");

    const options = [
      { label: "Unconstrained (++\u2026++)", before: "++", after: "++" },
      { label: "Raw (+++\u2026+++)", before: "+++", after: "+++" },
      { label: "Pass Macro (pass:[\u2026])", before: "pass:[", after: "]" },
    ];
    for (const opt of options) {
      const item = document.createElement("button");
      item.className = "split-dropdown-item";
      item.textContent = opt.label;
      item.addEventListener("click", () => { wrapSelection(opt.before, opt.after); closeAll(); });
      dd.appendChild(item);
    }

    passWrap.appendChild(dd);
    positionDropdown(dd);
  }

  function buildMenuDropdown() {
    const dd = document.createElement("div");
    dd.className = "split-dropdown open";
    dd.setAttribute("role", "menu");

    const form = document.createElement("div");
    form.className = "split-dropdown-form";
    form.style.minWidth = "280px";

    // Top menu
    const topLabel = document.createElement("label");
    topLabel.textContent = "TOP MENU";
    form.appendChild(topLabel);
    const topInput = document.createElement("input");
    topInput.type = "text";
    topInput.className = "split-form-input";
    topInput.placeholder = "e.g. File";
    form.appendChild(topInput);

    // Menu path
    const pathLabel = document.createElement("label");
    pathLabel.innerHTML = `MENU ITEMS <span class="label-hint">(separate with &gt;)</span>`;
    form.appendChild(pathLabel);
    const pathInput = document.createElement("input");
    pathInput.type = "text";
    pathInput.className = "split-form-input";
    pathInput.placeholder = "e.g. Save As";
    pathInput.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });
    form.appendChild(pathInput);

    // Hint
    const hint = document.createElement("div");
    hint.style.fontSize = "11px";
    hint.style.color = "var(--asciidoc-placeholder, #888)";
    hint.style.marginTop = "2px";
    hint.textContent = 'For sub-menus: "Zoom > Reset"';
    form.appendChild(hint);

    const submitBtn = document.createElement("button");
    submitBtn.textContent = "Insert Menu";
    submitBtn.addEventListener("click", submit);
    form.appendChild(submitBtn);

    function submit() {
      const top = topInput.value.trim();
      const path = pathInput.value.trim();
      if (!top) return;
      insertText(`menu:${top}[${path}]`);
      closeAll();
    }

    dd.appendChild(form);
    menuWrap.appendChild(dd);
    positionDropdown(dd);
    topInput.focus();
  }

  function buildFootnoteDropdown() {
    const dd = document.createElement("div");
    dd.className = "split-dropdown open";
    dd.setAttribute("role", "menu");

    const form = document.createElement("div");
    form.className = "split-dropdown-form";
    form.style.minWidth = "300px";

    // Mode tabs
    let mode: "new" | "reuse" = "new";

    const tabBar = document.createElement("div");
    tabBar.className = "link-type-tabs";
    const newTab = document.createElement("button");
    newTab.className = "link-type-tab active";
    newTab.textContent = "New Footnote";
    const reuseTab = document.createElement("button");
    reuseTab.className = "link-type-tab";
    reuseTab.textContent = "Reference Existing";
    tabBar.appendChild(newTab);
    tabBar.appendChild(reuseTab);
    form.appendChild(tabBar);

    // Fields container
    const fieldsContainer = document.createElement("div");
    form.appendChild(fieldsContainer);

    // ID field (optional for new, required for reuse)
    const idLabel = document.createElement("label");
    const idInput = document.createElement("input");
    idInput.type = "text";
    idInput.className = "split-form-input";
    idInput.placeholder = "e.g. my-note";

    // Text field (required for new, hidden for reuse)
    const textLabel = document.createElement("label");
    const textInput = document.createElement("textarea");
    textInput.className = "split-form-input";
    textInput.placeholder = "Footnote text content";
    textInput.rows = 3;
    textInput.style.resize = "vertical";
    textInput.style.fontFamily = "inherit";

    const submitBtn = document.createElement("button");
    submitBtn.textContent = "Insert Footnote";
    submitBtn.addEventListener("click", submit);

    function renderFields() {
      fieldsContainer.innerHTML = "";
      if (mode === "new") {
        idLabel.innerHTML = `ID <span class="label-hint">(optional — for reusable footnotes)</span>`;
        fieldsContainer.appendChild(idLabel);
        fieldsContainer.appendChild(idInput);

        textLabel.textContent = "FOOTNOTE TEXT";
        fieldsContainer.appendChild(textLabel);
        fieldsContainer.appendChild(textInput);
      } else {
        idLabel.textContent = "FOOTNOTE ID";
        fieldsContainer.appendChild(idLabel);
        fieldsContainer.appendChild(idInput);

        const hint = document.createElement("div");
        hint.style.fontSize = "11px";
        hint.style.color = "var(--asciidoc-placeholder, #888)";
        hint.style.marginTop = "4px";
        hint.textContent = "References a previously defined footnote by its ID.";
        fieldsContainer.appendChild(hint);
      }
      fieldsContainer.appendChild(submitBtn);
    }

    newTab.addEventListener("click", (e) => {
      e.stopPropagation();
      mode = "new";
      newTab.classList.add("active");
      reuseTab.classList.remove("active");
      renderFields();
    });
    reuseTab.addEventListener("click", (e) => {
      e.stopPropagation();
      mode = "reuse";
      reuseTab.classList.add("active");
      newTab.classList.remove("active");
      renderFields();
    });

    renderFields();

    function submit() {
      const id = idInput.value.trim();
      const text = textInput.value.trim();

      if (mode === "reuse") {
        if (!id) return;
        insertText(`footnote:${id}[]`);
      } else {
        if (!text && !id) return;
        if (id) {
          insertText(`footnote:${id}[${text}]`);
        } else {
          insertText(`footnote:[${text}]`);
        }
      }
      closeAll();
    }

    textInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); }
    });
    idInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") submit();
    });

    dd.appendChild(form);
    fnWrap.appendChild(dd);
    positionDropdown(dd);
    if (mode === "new") textInput.focus(); else idInput.focus();
  }

  function buildAnchorDropdown() {
    const dd = document.createElement("div");
    dd.className = "split-dropdown open";
    dd.setAttribute("role", "menu");

    const form = document.createElement("div");
    form.className = "split-dropdown-form";
    form.style.minWidth = "260px";

    // ID
    const idLabel = document.createElement("label");
    idLabel.textContent = "ANCHOR ID";
    form.appendChild(idLabel);
    const idInput = document.createElement("input");
    idInput.type = "text";
    idInput.className = "split-form-input";
    idInput.placeholder = "e.g. my-section";
    form.appendChild(idInput);

    // Reference text
    const refLabel = document.createElement("label");
    refLabel.innerHTML = `REFERENCE TEXT <span class="label-hint">(optional)</span>`;
    form.appendChild(refLabel);
    const refInput = document.createElement("input");
    refInput.type = "text";
    refInput.className = "split-form-input";
    refInput.placeholder = "Display text for cross-references";
    refInput.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });
    form.appendChild(refInput);

    // Hint
    const hint = document.createElement("div");
    hint.style.fontSize = "11px";
    hint.style.color = "var(--asciidoc-placeholder, #888)";
    hint.style.marginTop = "2px";
    hint.textContent = "ID must start with a letter, underscore, or colon.";
    form.appendChild(hint);

    const submitBtn = document.createElement("button");
    submitBtn.textContent = "Insert Anchor";
    submitBtn.addEventListener("click", submit);
    form.appendChild(submitBtn);

    function submit() {
      const id = idInput.value.trim();
      if (!id) return;
      const ref = refInput.value.trim();
      if (ref) {
        insertText(`[[${id},${ref}]]`);
      } else {
        insertText(`[[${id}]]`);
      }
      closeAll();
    }

    idInput.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });

    dd.appendChild(form);
    anchorWrap.appendChild(dd);
    positionDropdown(dd);
    idInput.focus();
  }

  function buildCiteDropdown() {
    const biblioLabels = getBiblioLabels();
    const dd = document.createElement("div");
    dd.className = "split-dropdown open";
    dd.setAttribute("role", "menu");
    dd.style.maxHeight = "320px";
    dd.style.overflowY = "auto";

    if (biblioLabels.size === 0) {
      const empty = document.createElement("div");
      empty.style.cssText = "padding:10px 14px;font-size:12px;color:var(--asciidoc-placeholder,#888);font-style:italic";
      empty.textContent = "No bibliography entries in this note";
      dd.appendChild(empty);
    } else {
      for (const [label, xreftext] of biblioLabels) {
        const item = document.createElement("button");
        item.className = "split-dropdown-item";
        item.innerHTML = `<span style="font-weight:600">${xreftext}</span> <span style="opacity:0.5;font-size:0.85em;margin-left:4px">${label}</span>`;
        item.addEventListener("click", () => {
          insertText(`<<${label}>>`);
          closeAll();
        });
        dd.appendChild(item);
      }
    }

    citeWrap.appendChild(dd);
    positionDropdown(dd);
  }

  function buildKeyboardDropdown() {
    const dd = document.createElement("div");
    dd.className = "split-dropdown open";
    dd.setAttribute("role", "menu");
    dd.style.maxHeight = "320px";
    dd.style.overflowY = "auto";

    const groups: { label: string; keys: string[] }[] = [
      { label: "Modifiers", keys: ["Ctrl", "Shift", "Alt", "Meta", "Cmd", "Opt", "Fn"] },
      { label: "Navigation", keys: ["Enter", "Esc", "Tab", "Space", "Backspace", "Delete", "Insert"] },
      { label: "Arrows", keys: ["\u2190", "\u2191", "\u2192", "\u2193", "Home", "End", "Page Up", "Page Down"] },
      { label: "Function", keys: ["F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9", "F10", "F11", "F12"] },
      { label: "Punctuation", keys: ["+", "-", "=", "[", "]", "\\", "/", ";", "'", ",", ".", "`", "~"] },
      { label: "Common Combos", keys: ["Ctrl+C", "Ctrl+V", "Ctrl+X", "Ctrl+Z", "Ctrl+S", "Ctrl+A", "Ctrl+F", "Ctrl+Shift+F", "Alt+Tab"] },
    ];

    for (const group of groups) {
      const groupLabel = document.createElement("div");
      groupLabel.style.cssText = "font-size:10px;font-weight:600;color:var(--asciidoc-placeholder,#888);padding:6px 10px 2px;text-transform:uppercase;letter-spacing:0.5px";
      groupLabel.textContent = group.label;
      dd.appendChild(groupLabel);

      const row = document.createElement("div");
      row.style.cssText = "display:flex;flex-wrap:wrap;gap:3px;padding:2px 8px 4px";
      for (const key of group.keys) {
        const btn = document.createElement("button");
        btn.className = "split-dropdown-item";
        btn.style.cssText = "padding:3px 8px;font-size:12px;font-family:monospace;min-width:0;flex:0 0 auto";
        btn.textContent = key;
        btn.addEventListener("click", () => {
          insertText(`kbd:[${key}]`);
          closeAll();
        });
        row.appendChild(btn);
      }
      dd.appendChild(row);
    }

    kbdWrap.appendChild(dd);
    positionDropdown(dd);
  }

  return {
    element: wrapper,
    cleanup: () => {
      window.removeEventListener("mousedown", handleWindowClick, true);
    },
  };
}
