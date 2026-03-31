import {
  structureItems,
  listItems,
  contentItems,
  mediaItems,
  admonitionTypes,
  sourceLanguages,
  handleAdmonition,
  handleSource,
  handleTable,
  handleBlock,
  handleImage as doImage,
  handleLink as doLink,
  handleMath,
  handleMermaid,
  mermaidDiagramTypes,
  mathNotations,
  symbolCategories,
  insertText,
  positionDropdown,
} from "../toolbar-actions";
import { openImageDialog, createResourceFromFile, getTemplates, getTemplateContent, markAsTemplate } from "../../ipc";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const ARROW_SVG = `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"/></svg>`;

/** Creates a `.ribbon-section` wrapper with label and child controls. */
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

// ---------------------------------------------------------------------------
// Dropdown state management
// ---------------------------------------------------------------------------

interface DropdownState {
  admonition: boolean;
  source: boolean;
  table: boolean;
  blocks: boolean;
  diagram: boolean;
  math: boolean;
  image: boolean;
  link: boolean;
  template: boolean;
  symbols: boolean;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export function buildInsertPanel(): { element: HTMLElement; cleanup: () => void } {
  const wrapper = document.createElement("div");
  wrapper.style.display = "contents";

  const state: DropdownState = {
    admonition: false,
    source: false,
    table: false,
    blocks: false,
    diagram: false,
    math: false,
    image: false,
    link: false,
    template: false,
    symbols: false,
  };

  // Map of split-btn-wrap elements for outside-click detection
  const wrapEls: Map<keyof DropdownState, HTMLElement> = new Map();

  function closeAll() {
    for (const key of Object.keys(state) as (keyof DropdownState)[]) {
      state[key] = false;
      const wrap = wrapEls.get(key);
      const dd = wrap?.querySelector(".split-dropdown");
      if (dd) dd.remove();
    }
  }

  function toggle(which: keyof DropdownState) {
    const was = state[which];
    closeAll();
    if (!was) {
      state[which] = true;
      showDropdown(which);
    }
  }

  // Window click handler to close dropdowns on outside click
  function handleWindowClick(e: MouseEvent) {
    const target = e.target as Element;
    if (target?.closest?.(".split-btn-wrap")) return;
    const anyOpen = Object.values(state).some(Boolean);
    if (anyOpen) closeAll();
  }
  window.addEventListener("mousedown", handleWindowClick, true);

  // -----------------------------------------------------------------------
  // Form state (closure variables)
  // -----------------------------------------------------------------------
  let tableRows = 3;
  let tableCols = 3;
  let imageSource: "web" | "local" = "web";
  let imageUrl = "";
  let imageLocalPath = "";
  let imageAlt = "";
  let imageTitle = "";
  let imageCaption = "";
  let imageScale = 100;
  let imageAlign: "center" | "left" | "right" = "center";
  let imageCaptionPosition: "below" | "left" | "right" = "below";
  let imagePickerError = "";
  let linkUrl = "";
  let linkText = "";
  let linkType: "external" | "wiki" = "external";
  let activeSymbolCat = 0;

  // Template state
  interface TemplateNode { id: string; title: string; }
  let templateOptions: TemplateNode[] = [];
  let templateQuery = "";
  let templateHighlightIndex = -1;
  let selectedTemplateId = "";
  let templateLoading = false;
  let templateError = "";
  let templateActionError = "";
  let assigningTemplate = false;
  let insertingTemplate = false;

  function getFilteredTemplates(): TemplateNode[] {
    const query = templateQuery.trim().toLowerCase();
    if (!query) return templateOptions;
    return templateOptions.filter((t) => t.title.toLowerCase().includes(query));
  }

  function getResolvedTemplate(): TemplateNode | undefined {
    if (selectedTemplateId) {
      return templateOptions.find((t) => t.id === selectedTemplateId);
    }
    const filtered = getFilteredTemplates();
    if (!filtered.length) return undefined;
    if (templateHighlightIndex >= 0 && templateHighlightIndex < filtered.length) {
      return filtered[templateHighlightIndex];
    }
    return filtered[0];
  }

  // -----------------------------------------------------------------------
  // Dropdown builders
  // -----------------------------------------------------------------------

  function showDropdown(which: keyof DropdownState) {
    switch (which) {
      case "admonition": showAdmonitionDropdown(); break;
      case "source": showSourceDropdown(); break;
      case "table": showTableDropdown(); break;
      case "blocks": showBlocksDropdown(); break;
      case "diagram": showDiagramDropdown(); break;
      case "math": showMathDropdown(); break;
      case "image": showImageDropdown(); break;
      case "link": showLinkDropdown(); break;
      case "template": showTemplateDropdown(); break;
      case "symbols": showSymbolsDropdown(); break;
    }
  }

  // -- Admonition --
  function showAdmonitionDropdown() {
    const wrap = wrapEls.get("admonition")!;
    const dd = document.createElement("div");
    dd.className = "split-dropdown open";
    dd.setAttribute("role", "menu");
    for (const type of admonitionTypes) {
      const btn = document.createElement("button");
      btn.className = "admonition-item";
      btn.textContent = type.label;
      btn.addEventListener("click", () => { handleAdmonition(type.value); closeAll(); });
      dd.appendChild(btn);
    }
    wrap.appendChild(dd);
    positionDropdown(dd);
  }

  // -- Source --
  function showSourceDropdown() {
    const wrap = wrapEls.get("source")!;
    const dd = document.createElement("div");
    dd.className = "split-dropdown open";
    dd.setAttribute("role", "menu");
    for (const lang of sourceLanguages) {
      const btn = document.createElement("button");
      btn.textContent = lang;
      btn.addEventListener("click", () => { handleSource(lang); closeAll(); });
      dd.appendChild(btn);
    }
    wrap.appendChild(dd);
    positionDropdown(dd);
  }

  // -- Table --
  function showTableDropdown() {
    const wrap = wrapEls.get("table")!;
    const dd = document.createElement("div");
    dd.className = "split-dropdown open";
    dd.setAttribute("role", "menu");

    const form = document.createElement("div");
    form.className = "split-dropdown-form table-size-form";

    // Rows
    const rowLabel = document.createElement("label");
    rowLabel.textContent = "Rows";
    const rowInput = document.createElement("input");
    rowInput.type = "number";
    rowInput.className = "split-form-input table-size-input";
    rowInput.min = "1";
    rowInput.max = "20";
    rowInput.value = String(tableRows);
    rowInput.addEventListener("input", () => { tableRows = parseInt(rowInput.value) || 3; });
    rowLabel.appendChild(rowInput);

    // Cols
    const colLabel = document.createElement("label");
    colLabel.textContent = "Cols";
    const colInput = document.createElement("input");
    colInput.type = "number";
    colInput.className = "split-form-input table-size-input";
    colInput.min = "1";
    colInput.max = "10";
    colInput.value = String(tableCols);
    colInput.addEventListener("input", () => { tableCols = parseInt(colInput.value) || 3; });
    colLabel.appendChild(colInput);

    const insertBtn = document.createElement("button");
    insertBtn.textContent = "Insert";
    insertBtn.addEventListener("click", () => { handleTable(tableRows, tableCols); closeAll(); });

    form.appendChild(rowLabel);
    form.appendChild(colLabel);
    form.appendChild(insertBtn);
    dd.appendChild(form);
    wrap.appendChild(dd);
    positionDropdown(dd);
  }

  // -- Blocks --
  function showBlocksDropdown() {
    const wrap = wrapEls.get("blocks")!;
    const dd = document.createElement("div");
    dd.className = "split-dropdown open";
    dd.setAttribute("role", "menu");

    const items: { label: string; type: string }[] = [
      { label: "Sidebar (****)", type: "sidebar" },
      { label: "Example (====)", type: "example" },
      { label: "Collapsible", type: "collapsible" },
      { label: "Page Break (<<<)", type: "pagebreak" },
    ];
    for (const item of items) {
      const btn = document.createElement("button");
      btn.textContent = item.label;
      btn.addEventListener("click", () => { handleBlock(item.type); closeAll(); });
      dd.appendChild(btn);
    }
    wrap.appendChild(dd);
    positionDropdown(dd);
  }

  // -- Diagram --
  function showDiagramDropdown() {
    const wrap = wrapEls.get("diagram")!;
    const dd = document.createElement("div");
    dd.className = "split-dropdown open";
    dd.setAttribute("role", "menu");
    dd.style.maxHeight = "300px";
    dd.style.overflowY = "auto";
    for (const type of mermaidDiagramTypes) {
      const btn = document.createElement("button");
      btn.textContent = type.label;
      btn.addEventListener("click", () => { handleMermaid(type.value); closeAll(); });
      dd.appendChild(btn);
    }
    wrap.appendChild(dd);
    positionDropdown(dd);
  }

  // -- Math --
  function showMathDropdown() {
    const wrap = wrapEls.get("math")!;
    const dd = document.createElement("div");
    dd.className = "split-dropdown open";
    dd.setAttribute("role", "menu");
    for (const item of mathNotations) {
      const btn = document.createElement("button");
      btn.className = "admonition-item";
      btn.textContent = item.label;
      btn.addEventListener("click", () => { handleMath(item.value, item.block); closeAll(); });
      dd.appendChild(btn);
    }
    wrap.appendChild(dd);
    positionDropdown(dd);
  }

  // -- Image --
  function showImageDropdown() {
    const wrap = wrapEls.get("image")!;
    const dd = document.createElement("div");
    dd.className = "split-dropdown open";
    dd.setAttribute("role", "menu");

    const form = document.createElement("div");
    form.className = "split-dropdown-form img-form";

    // Tab buttons (Web / Local)
    const typeTabs = document.createElement("div");
    typeTabs.className = "link-type-tabs";

    const webTab = document.createElement("button");
    webTab.className = "link-type-tab active";
    webTab.textContent = "Web";

    const localTab = document.createElement("button");
    localTab.className = "link-type-tab";
    localTab.textContent = "Local";

    typeTabs.appendChild(webTab);
    typeTabs.appendChild(localTab);
    form.appendChild(typeTabs);

    // Dynamic content area
    const dynamicArea = document.createElement("div");

    function renderImageSourceFields() {
      dynamicArea.innerHTML = "";
      webTab.classList.toggle("active", imageSource === "web");
      localTab.classList.toggle("active", imageSource === "local");

      if (imageSource === "web") {
        const urlLabel = document.createElement("label");
        urlLabel.setAttribute("for", "image-web-url");
        urlLabel.textContent = "Image URL";
        dynamicArea.appendChild(urlLabel);

        const urlInput = document.createElement("input");
        urlInput.id = "image-web-url";
        urlInput.type = "text";
        urlInput.className = "split-form-input";
        urlInput.placeholder = "https://example.com/image.png";
        urlInput.value = imageUrl;
        urlInput.addEventListener("input", () => { imageUrl = urlInput.value; });
        urlInput.addEventListener("keydown", (e) => { if (e.key === "Enter") submitImage(); });
        dynamicArea.appendChild(urlInput);
      } else {
        const pathLabel = document.createElement("label");
        pathLabel.setAttribute("for", "image-local-path");
        pathLabel.textContent = "Browse...";
        dynamicArea.appendChild(pathLabel);

        const picker = document.createElement("div");
        picker.className = "image-local-picker";

        const browseBtn = document.createElement("button");
        browseBtn.type = "button";
        browseBtn.className = "image-browse-btn";
        browseBtn.textContent = "Browse...";
        browseBtn.addEventListener("click", async () => {
          imagePickerError = "";
          try {
            const result = await openImageDialog();
            if (result.filePath) {
              // Create resource from file and use the resource URL
              const resource = await createResourceFromFile(result.filePath);
              imageLocalPath = `:/${resource.resourceId}`;
              pathInput.value = imageLocalPath;
              // Fire input event so checkSubmitState listener updates the button
              pathInput.dispatchEvent(new Event("input", { bubbles: true }));
            }
          } catch (error) {
            imagePickerError = "Couldn't open the file picker.";
            console.error("Failed to browse for image:", error);
            renderImageSourceFields();
          }
        });
        picker.appendChild(browseBtn);

        const pathInput = document.createElement("input");
        pathInput.id = "image-local-path";
        pathInput.type = "text";
        pathInput.className = "split-form-input image-local-path";
        pathInput.value = imageLocalPath;
        pathInput.placeholder = "No file selected";
        pathInput.readOnly = true;
        picker.appendChild(pathInput);
        dynamicArea.appendChild(picker);

        if (imagePickerError) {
          const errDiv = document.createElement("div");
          errDiv.className = "image-picker-error";
          errDiv.textContent = imagePickerError;
          dynamicArea.appendChild(errDiv);
        }
      }
    }

    webTab.addEventListener("click", () => { imageSource = "web"; imagePickerError = ""; renderImageSourceFields(); });
    localTab.addEventListener("click", () => { imageSource = "local"; imagePickerError = ""; renderImageSourceFields(); });

    renderImageSourceFields();
    form.appendChild(dynamicArea);

    // ALT text
    const altLabel = document.createElement("label");
    altLabel.setAttribute("for", "image-alt");
    altLabel.innerHTML = `ALT TEXT <span class="label-hint">(optional)</span>`;
    form.appendChild(altLabel);
    const altInput = document.createElement("input");
    altInput.id = "image-alt";
    altInput.type = "text";
    altInput.className = "split-form-input";
    altInput.placeholder = "Description";
    altInput.value = imageAlt;
    altInput.addEventListener("input", () => { imageAlt = altInput.value; });
    altInput.addEventListener("keydown", (e) => { if (e.key === "Enter") submitImage(); });
    form.appendChild(altInput);

    // Scale slider
    const scaleHeader = document.createElement("div");
    scaleHeader.className = "image-slider-header";
    const scaleLabel = document.createElement("label");
    scaleLabel.setAttribute("for", "image-scale");
    scaleLabel.textContent = "SCALE";
    const scaleVal = document.createElement("span");
    scaleVal.textContent = `${imageScale}%`;
    scaleHeader.appendChild(scaleLabel);
    scaleHeader.appendChild(scaleVal);
    form.appendChild(scaleHeader);

    const scaleSlider = document.createElement("input");
    scaleSlider.id = "image-scale";
    scaleSlider.type = "range";
    scaleSlider.className = "image-slider";
    scaleSlider.min = "10";
    scaleSlider.max = "200";
    scaleSlider.step = "5";
    scaleSlider.value = String(imageScale);
    scaleSlider.addEventListener("input", () => { imageScale = parseInt(scaleSlider.value); scaleVal.textContent = `${imageScale}%`; });
    form.appendChild(scaleSlider);

    // Align
    const alignLabel = document.createElement("label");
    alignLabel.setAttribute("for", "image-align");
    alignLabel.textContent = "ALIGN";
    form.appendChild(alignLabel);

    const alignSelect = document.createElement("select");
    alignSelect.id = "image-align";
    alignSelect.className = "split-form-input image-align-select";
    for (const opt of [{ value: "center", text: "CENTER" }, { value: "left", text: "LEFT" }, { value: "right", text: "RIGHT" }]) {
      const option = document.createElement("option");
      option.value = opt.value;
      option.textContent = opt.text;
      if (opt.value === imageAlign) option.selected = true;
      alignSelect.appendChild(option);
    }
    alignSelect.addEventListener("change", () => {
      imageAlign = alignSelect.value as "center" | "left" | "right";
      updateCaptionPosOptions();
    });
    form.appendChild(alignSelect);

    // Title
    const titleLabel = document.createElement("label");
    titleLabel.setAttribute("for", "image-title");
    titleLabel.innerHTML = `TITLE <span class="label-hint">(optional)</span>`;
    form.appendChild(titleLabel);
    const titleInput = document.createElement("input");
    titleInput.id = "image-title";
    titleInput.type = "text";
    titleInput.className = "split-form-input";
    titleInput.placeholder = "Image title";
    titleInput.value = imageTitle;
    titleInput.addEventListener("input", () => { imageTitle = titleInput.value; });
    titleInput.addEventListener("keydown", (e) => { if (e.key === "Enter") submitImage(); });
    form.appendChild(titleInput);

    // Caption
    const captionLabel = document.createElement("label");
    captionLabel.setAttribute("for", "image-caption");
    captionLabel.innerHTML = `CAPTION <span class="label-hint">(optional)</span>`;
    form.appendChild(captionLabel);
    const captionInput = document.createElement("input");
    captionInput.id = "image-caption";
    captionInput.type = "text";
    captionInput.className = "split-form-input";
    captionInput.placeholder = "Caption shown with the image";
    captionInput.value = imageCaption;
    captionInput.addEventListener("input", () => { imageCaption = captionInput.value; });
    captionInput.addEventListener("keydown", (e) => { if (e.key === "Enter") submitImage(); });
    form.appendChild(captionInput);

    // Caption Position
    const captionPosLabel = document.createElement("label");
    captionPosLabel.setAttribute("for", "image-caption-pos");
    captionPosLabel.textContent = "CAPTION POSITION";
    form.appendChild(captionPosLabel);

    const captionPosSelect = document.createElement("select");
    captionPosSelect.id = "image-caption-pos";
    captionPosSelect.className = "split-form-input";
    captionPosSelect.addEventListener("change", () => {
      imageCaptionPosition = captionPosSelect.value as "below" | "left" | "right";
    });
    form.appendChild(captionPosSelect);

    const updateCaptionPosOptions = () => {
      captionPosSelect.innerHTML = "";
      const belowOpt = document.createElement("option");
      belowOpt.value = "below"; belowOpt.textContent = "BELOW";
      captionPosSelect.appendChild(belowOpt);
      if (imageAlign === "left") {
        const rightOpt = document.createElement("option");
        rightOpt.value = "right"; rightOpt.textContent = "RIGHT";
        captionPosSelect.appendChild(rightOpt);
      } else if (imageAlign === "right") {
        const leftOpt = document.createElement("option");
        leftOpt.value = "left"; leftOpt.textContent = "LEFT";
        captionPosSelect.appendChild(leftOpt);
      }
      const validValues = Array.from(captionPosSelect.options).map(o => o.value);
      captionPosSelect.value = validValues.includes(imageCaptionPosition) ? imageCaptionPosition : "below";
      imageCaptionPosition = captionPosSelect.value as "below" | "left" | "right";
    };
    updateCaptionPosOptions();

    // Submit
    const submitBtn = document.createElement("button");
    submitBtn.textContent = "Insert Image";
    submitBtn.disabled = !getImageTarget().trim();
    const checkSubmitState = () => {
      submitBtn.disabled = !getImageTarget().trim();
    };
    form.addEventListener("input", checkSubmitState);
    submitBtn.addEventListener("click", submitImage);
    form.appendChild(submitBtn);

    dd.appendChild(form);
    wrap.appendChild(dd);
    positionDropdown(dd);
  }

  function getImageTarget(): string {
    return imageSource === "web" ? imageUrl : imageLocalPath;
  }

  function submitImage() {
    doImage({
      target: getImageTarget(),
      alt: imageAlt,
      title: imageTitle,
      caption: imageCaption,
      width: imageScale,
      height: imageScale,
      align: imageAlign,
      captionPosition: imageCaptionPosition,
    });
    // Reset
    imageSource = "web";
    imageUrl = "";
    imageLocalPath = "";
    imageAlt = "";
    imageTitle = "";
    imageCaption = "";
    imageScale = 100;
    imageAlign = "center";
    imageCaptionPosition = "below";
    imagePickerError = "";
    closeAll();
  }

  // -- Link --
  function showLinkDropdown() {
    const wrap = wrapEls.get("link")!;
    const dd = document.createElement("div");
    dd.className = "split-dropdown open";
    dd.setAttribute("role", "menu");

    const form = document.createElement("div");
    form.className = "split-dropdown-form link-form";

    // Tab buttons
    const typeTabs = document.createElement("div");
    typeTabs.className = "link-type-tabs";

    const extTab = document.createElement("button");
    extTab.className = `link-type-tab${linkType === "external" ? " active" : ""}`;
    extTab.textContent = "External";

    const wikiTab = document.createElement("button");
    wikiTab.className = `link-type-tab${linkType === "wiki" ? " active" : ""}`;
    wikiTab.textContent = "Cross-ref";

    typeTabs.appendChild(extTab);
    typeTabs.appendChild(wikiTab);
    form.appendChild(typeTabs);

    // Dynamic URL area
    const urlArea = document.createElement("div");

    function renderLinkFields() {
      urlArea.innerHTML = "";
      extTab.classList.toggle("active", linkType === "external");
      wikiTab.classList.toggle("active", linkType === "wiki");

      const urlLabel = document.createElement("label");
      urlLabel.textContent = linkType === "external" ? "URL" : "Target ID";
      urlArea.appendChild(urlLabel);

      const urlInput = document.createElement("input");
      urlInput.type = "text";
      urlInput.className = "split-form-input";
      urlInput.placeholder = linkType === "external" ? "https://example.com" : "section-id or note-id";
      urlInput.value = linkUrl;
      urlInput.addEventListener("input", () => {
        linkUrl = urlInput.value;
        submitLinkBtn.disabled = !linkUrl.trim();
      });
      urlInput.addEventListener("keydown", (e) => { if (e.key === "Enter") submitLink(); });
      urlArea.appendChild(urlInput);
    }

    extTab.addEventListener("click", () => { linkType = "external"; renderLinkFields(); });
    wikiTab.addEventListener("click", () => { linkType = "wiki"; renderLinkFields(); });

    renderLinkFields();
    form.appendChild(urlArea);

    // Display text
    const displayLabel = document.createElement("label");
    displayLabel.innerHTML = `Display text <span class="label-hint">(optional)</span>`;
    form.appendChild(displayLabel);
    const displayInput = document.createElement("input");
    displayInput.type = "text";
    displayInput.className = "split-form-input";
    displayInput.placeholder = "Click here";
    displayInput.value = linkText;
    displayInput.addEventListener("input", () => { linkText = displayInput.value; });
    displayInput.addEventListener("keydown", (e) => { if (e.key === "Enter") submitLink(); });
    form.appendChild(displayInput);

    const submitLinkBtn = document.createElement("button");
    submitLinkBtn.textContent = "Insert Link";
    submitLinkBtn.disabled = !linkUrl.trim();
    submitLinkBtn.addEventListener("click", submitLink);
    form.appendChild(submitLinkBtn);

    dd.appendChild(form);
    wrap.appendChild(dd);
    positionDropdown(dd);
  }

  function submitLink() {
    doLink(linkType, linkUrl, linkText);
    linkUrl = "";
    linkText = "";
    closeAll();
  }

  // -- Template --
  function showTemplateDropdown() {
    const wrap = wrapEls.get("template")!;
    const dd = document.createElement("div");
    dd.className = "split-dropdown open";
    dd.setAttribute("role", "menu");

    const form = document.createElement("div");
    form.className = "split-dropdown-form template-form";

    const searchLabel = document.createElement("label");
    searchLabel.setAttribute("for", "template-search");
    searchLabel.textContent = "Insert Template";
    form.appendChild(searchLabel);

    const searchInput = document.createElement("input");
    searchInput.id = "template-search";
    searchInput.type = "text";
    searchInput.className = "split-form-input";
    searchInput.placeholder = "Start typing a template note title";
    searchInput.value = templateQuery;
    searchInput.autocomplete = "off";
    form.appendChild(searchInput);

    const optionsDiv = document.createElement("div");
    optionsDiv.className = "template-options";
    optionsDiv.setAttribute("role", "listbox");
    optionsDiv.setAttribute("aria-label", "Template notes");
    form.appendChild(optionsDiv);

    const actionErrorDiv = document.createElement("div");
    actionErrorDiv.className = "template-status error";
    actionErrorDiv.style.display = "none";
    form.appendChild(actionErrorDiv);

    const actionsDiv = document.createElement("div");
    actionsDiv.className = "template-actions";

    const assignBtn = document.createElement("button");
    assignBtn.className = "template-action-button template-secondary-button";
    assignBtn.textContent = "Assign Note as Template";
    assignBtn.addEventListener("click", async () => {
      assigningTemplate = true;
      assignBtn.textContent = "Assigning...";
      assignBtn.disabled = true;
      templateActionError = "";
      actionErrorDiv.style.display = "none";
      try {
        // Plugin sandbox knows the current note ID
        await markAsTemplate();
        await loadTemplates();
        renderOptions();
      } catch (error) {
        templateActionError = "Couldn't assign the current note as a template.";
        actionErrorDiv.textContent = templateActionError;
        actionErrorDiv.style.display = "";
        console.error("Failed to assign template:", error);
      } finally {
        assigningTemplate = false;
        assignBtn.textContent = "Assign Note as Template";
        assignBtn.disabled = false;
      }
    });

    const insertBtn = document.createElement("button");
    insertBtn.className = "template-action-button";
    insertBtn.textContent = "Insert Template";
    insertBtn.addEventListener("click", async () => {
      const template = getResolvedTemplate();
      if (!template) return;
      insertingTemplate = true;
      insertBtn.textContent = "Inserting...";
      insertBtn.disabled = true;
      templateActionError = "";
      actionErrorDiv.style.display = "none";
      try {
        const result = await getTemplateContent(template.id);
        insertText(result.content);
        closeAll();
      } catch (error) {
        templateActionError = "Couldn't insert the selected template.";
        actionErrorDiv.textContent = templateActionError;
        actionErrorDiv.style.display = "";
        console.error("Failed to insert template:", error);
      } finally {
        insertingTemplate = false;
        insertBtn.textContent = "Insert Template";
        insertBtn.disabled = !getResolvedTemplate();
      }
    });

    actionsDiv.appendChild(assignBtn);
    actionsDiv.appendChild(insertBtn);
    form.appendChild(actionsDiv);

    function renderOptions() {
      optionsDiv.innerHTML = "";
      if (templateLoading) {
        const loadingDiv = document.createElement("div");
        loadingDiv.className = "template-empty-state";
        loadingDiv.textContent = "Loading templates...";
        optionsDiv.appendChild(loadingDiv);
        return;
      }
      if (templateError) {
        const errDiv = document.createElement("div");
        errDiv.className = "template-status error";
        errDiv.textContent = templateError;
        optionsDiv.appendChild(errDiv);
        return;
      }
      const filtered = getFilteredTemplates();
      if (filtered.length === 0) {
        const emptyDiv = document.createElement("div");
        emptyDiv.className = "template-empty-state";
        emptyDiv.textContent = "No template notes match that spelling.";
        optionsDiv.appendChild(emptyDiv);
        insertBtn.disabled = true;
        return;
      }
      for (let i = 0; i < filtered.length; i++) {
        const template = filtered[i];
        const btn = document.createElement("button");
        btn.className = "template-option";
        if (i === templateHighlightIndex) btn.classList.add("active");
        if (template.id === selectedTemplateId) btn.classList.add("selected");
        btn.textContent = template.title;
        btn.addEventListener("click", () => {
          selectedTemplateId = template.id;
          templateQuery = template.title;
          searchInput.value = templateQuery;
          templateActionError = "";
          actionErrorDiv.style.display = "none";
          // Update highlight index to match selection
          const filtered = getFilteredTemplates();
          templateHighlightIndex = Math.max(0, filtered.findIndex((c) => c.id === template.id));
          renderOptions();
        });
        optionsDiv.appendChild(btn);
      }
      insertBtn.disabled = !getResolvedTemplate();
    }

    searchInput.addEventListener("input", () => {
      templateQuery = searchInput.value;
      templateActionError = "";
      actionErrorDiv.style.display = "none";
      const normalized = templateQuery.trim().toLowerCase();
      const exactMatch = normalized
        ? templateOptions.find((t) => t.title.toLowerCase() === normalized)
        : undefined;
      selectedTemplateId = exactMatch?.id ?? "";
      // Clamp highlight index to filtered list bounds
      const filtered = getFilteredTemplates();
      templateHighlightIndex = filtered.length > 0 ? 0 : -1;
      renderOptions();
    });

    searchInput.addEventListener("keydown", (e) => {
      const filtered = getFilteredTemplates();
      if (e.key === "ArrowDown") {
        if (!filtered.length) return;
        e.preventDefault();
        templateHighlightIndex = templateHighlightIndex < filtered.length - 1 ? templateHighlightIndex + 1 : 0;
        renderOptions();
        return;
      }
      if (e.key === "ArrowUp") {
        if (!filtered.length) return;
        e.preventDefault();
        templateHighlightIndex = templateHighlightIndex > 0 ? templateHighlightIndex - 1 : filtered.length - 1;
        renderOptions();
        return;
      }
      if (e.key === "Enter") {
        const template = getResolvedTemplate();
        if (!template) return;
        e.preventDefault();
        selectedTemplateId = template.id;
        templateQuery = template.title;
        searchInput.value = templateQuery;
        renderOptions();
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        closeAll();
      }
    });

    async function loadTemplates() {
      templateLoading = true;
      templateError = "";
      renderOptions();
      try {
        const result = await getTemplates();
        templateOptions = result.templates;
      } catch (error) {
        templateOptions = [];
        templateError = "Couldn't load templates.";
        console.error("Failed to load templates:", error);
      } finally {
        templateLoading = false;
        const filtered = getFilteredTemplates();
        templateHighlightIndex = filtered.length > 0 ? 0 : -1;
        if (selectedTemplateId && !templateOptions.some((t) => t.id === selectedTemplateId)) {
          selectedTemplateId = "";
        }
        renderOptions();
      }
    }

    dd.appendChild(form);
    wrap.appendChild(dd);
    positionDropdown(dd);

    // Reset state and load
    templateQuery = "";
    selectedTemplateId = "";
    templateHighlightIndex = -1;
    templateActionError = "";
    searchInput.value = "";
    loadTemplates().then(() => {
      searchInput.focus();
    });
  }

  // -- Symbols --
  function showSymbolsDropdown() {
    const wrap = wrapEls.get("symbols")!;
    const dd = document.createElement("div");
    dd.className = "split-dropdown open symbols-dropdown";
    dd.setAttribute("role", "menu");

    let searchMode = false;

    // Category tabs
    const tabsRow = document.createElement("div");
    tabsRow.className = "symbols-tabs";

    const tabButtons: HTMLButtonElement[] = [];
    for (let i = 0; i < symbolCategories.length; i++) {
      const cat = symbolCategories[i];
      const btn = document.createElement("button");
      btn.className = `symbols-tab${i === activeSymbolCat ? " active" : ""}`;
      btn.textContent = cat.name;
      btn.addEventListener("click", () => {
        searchMode = false;
        searchInput.value = "";
        activeSymbolCat = i;
        for (let j = 0; j < tabButtons.length; j++) {
          tabButtons[j].classList.toggle("active", j === i);
        }
        renderGrid();
      });
      tabButtons.push(btn);
      tabsRow.appendChild(btn);
    }
    dd.appendChild(tabsRow);

    // Grid
    const grid = document.createElement("div");
    grid.className = "symbols-grid";
    dd.appendChild(grid);

    function renderGrid(items?: typeof symbolCategories[0]["items"]) {
      grid.innerHTML = "";
      const list = items || symbolCategories[activeSymbolCat].items;
      for (const sym of list) {
        const btn = document.createElement("button");
        btn.className = "symbol-btn";
        if (sym.char.length > 1 && (sym.char.codePointAt(0) ?? 0) < 256) {
          btn.classList.add("symbol-text");
        }
        btn.title = `${sym.label} (${sym.insert})`;
        btn.textContent = sym.char;
        btn.addEventListener("click", () => { insertText(sym.insert); closeAll(); });
        grid.appendChild(btn);
      }
      if (list.length === 0) {
        const empty = document.createElement("div");
        empty.style.cssText = "grid-column:1/-1;text-align:center;padding:12px;color:var(--asciidoc-placeholder,#888);font-size:12px";
        empty.textContent = "No symbols found";
        grid.appendChild(empty);
      }
    }

    // Search bar
    const searchBar = document.createElement("div");
    searchBar.className = "symbols-search";
    const searchInput = document.createElement("input");
    searchInput.type = "text";
    searchInput.placeholder = "Search symbols\u2026";
    searchInput.addEventListener("input", () => {
      const query = searchInput.value.trim().toLowerCase();
      if (query) {
        searchMode = true;
        // Deselect all tabs
        for (const tb of tabButtons) tb.classList.remove("active");
        // Search across all categories
        const results: typeof symbolCategories[0]["items"] = [];
        for (const cat of symbolCategories) {
          for (const sym of cat.items) {
            if (sym.label.toLowerCase().includes(query) || sym.char.includes(query) || sym.insert.toLowerCase().includes(query)) {
              results.push(sym);
            }
          }
        }
        renderGrid(results);
      } else {
        // Clear search — go back to default tab
        searchMode = false;
        activeSymbolCat = 0;
        for (let j = 0; j < tabButtons.length; j++) {
          tabButtons[j].classList.toggle("active", j === 0);
        }
        renderGrid();
      }
    });
    const clearBtn = document.createElement("button");
    clearBtn.className = "symbols-search-clear";
    clearBtn.textContent = "\u2715";
    clearBtn.title = "Clear search";
    clearBtn.addEventListener("click", () => {
      searchInput.value = "";
      searchMode = false;
      activeSymbolCat = 0;
      for (let j = 0; j < tabButtons.length; j++) {
        tabButtons[j].classList.toggle("active", j === 0);
      }
      renderGrid();
      searchInput.focus();
    });
    searchBar.appendChild(searchInput);
    searchBar.appendChild(clearBtn);
    dd.appendChild(searchBar);

    renderGrid();
    wrap.appendChild(dd);
    positionDropdown(dd);
  }

  // -----------------------------------------------------------------------
  // Build the split-button helper
  // -----------------------------------------------------------------------

  function createSplitButton(
    stateKey: keyof DropdownState,
    icon: string,
    title: string,
    defaultAction: () => void,
    arrowTitle: string,
  ): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "split-btn-wrap";
    wrapEls.set(stateKey, wrap);

    const mainBtn = document.createElement("button");
    mainBtn.className = "ribbon-icon-btn";
    mainBtn.title = title;
    mainBtn.innerHTML = icon;
    mainBtn.addEventListener("click", () => {
      defaultAction();
      closeAll();
    });

    const arrow = document.createElement("button");
    arrow.className = "split-arrow";
    arrow.title = arrowTitle;
    arrow.innerHTML = ARROW_SVG;
    arrow.addEventListener("click", (e) => {
      e.stopPropagation();
      toggle(stateKey);
    });

    wrap.appendChild(mainBtn);
    wrap.appendChild(arrow);
    return wrap;
  }

  /** Variant where main button also opens the dropdown instead of a default action. */
  function createSplitButtonToggle(
    stateKey: keyof DropdownState,
    icon: string,
    title: string,
    arrowTitle: string,
  ): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "split-btn-wrap";
    if (stateKey === "symbols") wrap.classList.add("symbols-wrap");
    wrapEls.set(stateKey, wrap);

    const mainBtn = document.createElement("button");
    mainBtn.className = "ribbon-icon-btn";
    mainBtn.title = title;
    mainBtn.innerHTML = icon;
    mainBtn.addEventListener("click", () => toggle(stateKey));

    const arrow = document.createElement("button");
    arrow.className = "split-arrow";
    arrow.title = arrowTitle;
    arrow.innerHTML = ARROW_SVG;
    arrow.addEventListener("click", (e) => {
      e.stopPropagation();
      toggle(stateKey);
    });

    wrap.appendChild(mainBtn);
    wrap.appendChild(arrow);
    return wrap;
  }

  // -----------------------------------------------------------------------
  // Structure section
  // -----------------------------------------------------------------------

  const structureRow = document.createElement("div");
  structureRow.className = "ribbon-row";

  structureRow.appendChild(createSplitButton(
    "admonition",
    structureItems[0].icon,
    "Admonition",
    () => handleAdmonition("NOTE"),
    "Admonition type",
  ));

  structureRow.appendChild(createSplitButton(
    "source",
    structureItems[1].icon,
    "Source Block",
    () => handleSource("javascript"),
    "Language",
  ));

  structureRow.appendChild(createSplitButton(
    "table",
    structureItems[2].icon,
    "Table",
    () => { handleTable(tableRows, tableCols); },
    "Table size",
  ));

  structureRow.appendChild(createSplitButton(
    "blocks",
    structureItems[3].icon,
    "Content Block",
    () => handleBlock("sidebar"),
    "Block type",
  ));

  wrapper.appendChild(createRibbonSection("Structure", structureRow));

  // -----------------------------------------------------------------------
  // Lists section
  // -----------------------------------------------------------------------

  const listsRow = document.createElement("div");
  listsRow.className = "ribbon-row";
  for (const item of listItems) {
    const btn = document.createElement("button");
    btn.className = "ribbon-icon-btn";
    btn.title = item.title;
    btn.innerHTML = item.icon;
    btn.addEventListener("click", () => item.action());
    listsRow.appendChild(btn);
  }
  wrapper.appendChild(createRibbonSection("Lists", listsRow));

  // -----------------------------------------------------------------------
  // Diagrams section
  // -----------------------------------------------------------------------

  const diagramRow = document.createElement("div");
  diagramRow.className = "ribbon-row";
  diagramRow.appendChild(createSplitButton(
    "diagram",
    `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="8" y="14" width="7" height="7" rx="1"/><line x1="6.5" y1="10" x2="11.5" y2="14"/><line x1="17.5" y1="10" x2="11.5" y2="14"/></svg>`,
    "Insert Mermaid Diagram",
    () => { handleMermaid("flowchart"); closeAll(); },
    "Diagram type",
  ));
  wrapper.appendChild(createRibbonSection("Diagrams", diagramRow));

  // -----------------------------------------------------------------------
  // Content section
  // -----------------------------------------------------------------------

  const contentRow = document.createElement("div");
  contentRow.className = "ribbon-row";
  for (const item of contentItems) {
    const btn = document.createElement("button");
    btn.className = "ribbon-icon-btn";
    btn.title = item.title;
    btn.innerHTML = item.icon;
    btn.addEventListener("click", () => item.action());
    contentRow.appendChild(btn);
  }
  wrapper.appendChild(createRibbonSection("Content", contentRow));

  // -----------------------------------------------------------------------
  // Math section
  // -----------------------------------------------------------------------

  const mathRow = document.createElement("div");
  mathRow.className = "ribbon-row";

  mathRow.appendChild(createSplitButton(
    "math",
    `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><text x="4" y="18" font-size="16" font-family="serif" font-style="italic" fill="currentColor" stroke="none">\u03A3</text></svg>`,
    "Insert Inline Math",
    () => { handleMath("latexmath", false); closeAll(); },
    "Math options",
  ));

  wrapper.appendChild(createRibbonSection("Math", mathRow));

  // -----------------------------------------------------------------------
  // Media section
  // -----------------------------------------------------------------------

  const mediaRow = document.createElement("div");
  mediaRow.className = "ribbon-row";

  mediaRow.appendChild(createSplitButtonToggle(
    "image",
    mediaItems[0].icon,
    "Image",
    "Image options",
  ));

  mediaRow.appendChild(createSplitButtonToggle(
    "link",
    mediaItems[1].icon,
    "Link",
    "Link options",
  ));

  mediaRow.appendChild(createSplitButtonToggle(
    "template",
    mediaItems[2].icon,
    "Template",
    "Template options",
  ));

  wrapper.appendChild(createRibbonSection("Media", mediaRow));

  // -----------------------------------------------------------------------
  // Symbols section
  // -----------------------------------------------------------------------

  const symbolsRow = document.createElement("div");
  symbolsRow.className = "ribbon-row symbols-row";

  symbolsRow.appendChild(createSplitButtonToggle(
    "symbols",
    `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7V4h16v3"/><path d="M9 20h6"/><path d="M12 4v16"/></svg>`,
    "Insert Symbol",
    "Browse symbols",
  ));

  wrapper.appendChild(createRibbonSection("Symbols", symbolsRow));

  return {
    element: wrapper,
    cleanup: () => {
      window.removeEventListener("mousedown", handleWindowClick, true);
    },
  };
}
