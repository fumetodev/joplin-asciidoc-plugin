import { wrapSelection, insertText, prefixLine, positionDropdown } from "../toolbar-actions";

const ARROW_SVG = `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"/></svg>`;

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
  menu: boolean;
  footnote: boolean;
  anchor: boolean;
}

export function buildFormattingPanel(): { element: HTMLElement; cleanup: () => void } {
  const wrapper = document.createElement("div");
  wrapper.style.display = "contents";

  const state: DropdownState = { menu: false, footnote: false, anchor: false };
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
  window.addEventListener("click", handleWindowClick);

  // ---------------------------------------------------------------
  // Simple buttons section (Keyboard, Button, Comment)
  // ---------------------------------------------------------------

  const simpleRow = document.createElement("div");
  simpleRow.className = "ribbon-row";

  // Keyboard — wraps selection
  const kbdBtn = document.createElement("button");
  kbdBtn.className = "ribbon-labeled-btn";
  kbdBtn.title = "Keyboard (kbd:[...])";
  kbdBtn.innerHTML = `<span class="rlb-label">Keyboard</span>`;
  kbdBtn.addEventListener("click", () => wrapSelection("kbd:[", "]"));
  simpleRow.appendChild(kbdBtn);

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
  // Dropdown builders
  // ---------------------------------------------------------------

  function buildDropdown(which: keyof DropdownState) {
    switch (which) {
      case "menu": buildMenuDropdown(); break;
      case "footnote": buildFootnoteDropdown(); break;
      case "anchor": buildAnchorDropdown(); break;
    }
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

  return {
    element: wrapper,
    cleanup: () => {
      window.removeEventListener("click", handleWindowClick);
    },
  };
}
