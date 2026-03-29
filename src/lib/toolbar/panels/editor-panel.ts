export interface EditorPanelOptions {
  onToggleLineNumbers: (show: boolean) => void;
  onToggleBlockShading: (show: boolean) => void;
  onToggleOverlayEditing: (show: boolean) => void;
  onToggleSpellCheck: (enabled: boolean) => void;
  onMarginChange: (px: number) => void;
  onZoomChange: (percent: number) => void;
}

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

export function buildEditorPanel(options: EditorPanelOptions, initialMargin?: number, initialZoom?: number): HTMLElement {
  const wrapper = document.createElement("div");
  wrapper.style.display = "contents";

  // --- Display section ---
  const displayToggles = document.createElement("div");
  displayToggles.className = "editor-toggles";

  // Line numbers checkbox
  const lineNumLabel = document.createElement("label");
  lineNumLabel.className = "ribbon-toggle";
  const lineNumCb = document.createElement("input");
  lineNumCb.type = "checkbox";
  const savedLineNumbers = localStorage.getItem("asciidoc-line-numbers");
  lineNumCb.checked = savedLineNumbers === "true";
  lineNumCb.addEventListener("input", () => {
    options.onToggleLineNumbers(lineNumCb.checked);
    localStorage.setItem("asciidoc-line-numbers", String(lineNumCb.checked));
  });
  const lineNumSpan = document.createElement("span");
  lineNumSpan.textContent = "Line Numbers";
  lineNumLabel.appendChild(lineNumCb);
  lineNumLabel.appendChild(lineNumSpan);
  displayToggles.appendChild(lineNumLabel);

  // Spell Checker checkbox
  const spellLabel = document.createElement("label");
  spellLabel.className = "ribbon-toggle";
  const spellCb = document.createElement("input");
  spellCb.type = "checkbox";
  const savedSpellCheck = localStorage.getItem("asciidoc-spellcheck");
  spellCb.checked = savedSpellCheck === null ? true : savedSpellCheck === "true";
  spellCb.addEventListener("input", () => {
    options.onToggleSpellCheck(spellCb.checked);
    localStorage.setItem("asciidoc-spellcheck", String(spellCb.checked));
  });
  const spellSpan = document.createElement("span");
  spellSpan.textContent = "Spell Checker";
  spellLabel.appendChild(spellCb);
  spellLabel.appendChild(spellSpan);
  displayToggles.appendChild(spellLabel);

  wrapper.appendChild(createRibbonSection("Display", displayToggles));

  // --- Appearance section ---
  const appearanceToggles = document.createElement("div");
  appearanceToggles.className = "editor-toggles editor-toggles-appearance";

  // Special Block Shading checkbox
  const shadingLabel = document.createElement("label");
  shadingLabel.className = "ribbon-toggle";
  const shadingCb = document.createElement("input");
  shadingCb.type = "checkbox";
  const savedShading = localStorage.getItem("asciidoc-block-shading");
  shadingCb.checked = savedShading === null ? true : savedShading === "true";
  shadingCb.addEventListener("input", () => {
    options.onToggleBlockShading(shadingCb.checked);
    localStorage.setItem("asciidoc-block-shading", String(shadingCb.checked));
  });
  const shadingSpan = document.createElement("span");
  shadingSpan.textContent = "Special Block Shading";
  shadingLabel.appendChild(shadingCb);
  shadingLabel.appendChild(shadingSpan);
  appearanceToggles.appendChild(shadingLabel);

  // Overlay Editing checkbox
  const overlayLabel = document.createElement("label");
  overlayLabel.className = "ribbon-toggle";
  const overlayCb = document.createElement("input");
  overlayCb.type = "checkbox";
  const savedOverlay = localStorage.getItem("asciidoc-overlay-editing");
  overlayCb.checked = savedOverlay === null ? false : savedOverlay === "true";
  overlayCb.addEventListener("input", () => {
    options.onToggleOverlayEditing(overlayCb.checked);
    localStorage.setItem("asciidoc-overlay-editing", String(overlayCb.checked));
  });
  const overlaySpan = document.createElement("span");
  overlaySpan.textContent = "Overlay Block Editing";
  overlayLabel.appendChild(overlayCb);
  overlayLabel.appendChild(overlaySpan);
  appearanceToggles.appendChild(overlayLabel);

  wrapper.appendChild(createRibbonSection("Appearance", appearanceToggles));

  // --- Layout section ---
  let marginValue = initialMargin || 0;

  const marginControl = document.createElement("div");
  marginControl.className = "ribbon-margin-control";

  const marginHeader = document.createElement("div");
  marginHeader.className = "ribbon-margin-header";

  const marginLabel = document.createElement("span");
  marginLabel.textContent = "Margin";

  const marginValueSpan = document.createElement("span");
  marginValueSpan.className = "ribbon-margin-value";
  marginValueSpan.textContent = `${marginValue}px`;

  marginHeader.appendChild(marginLabel);
  marginHeader.appendChild(marginValueSpan);

  const marginSlider = document.createElement("input");
  marginSlider.type = "range";
  marginSlider.min = "0";
  marginSlider.max = "300";
  marginSlider.step = "10";
  marginSlider.value = String(marginValue);
  marginSlider.className = "ribbon-margin-slider";
  marginSlider.addEventListener("input", () => {
    const val = parseInt(marginSlider.value);
    if (!isNaN(val)) {
      marginValue = val;
      marginValueSpan.textContent = `${val}px`;
      options.onMarginChange(val);
    }
  });

  marginControl.appendChild(marginHeader);
  marginControl.appendChild(marginSlider);

  wrapper.appendChild(createRibbonSection("Layout", marginControl));

  // --- Zoom section ---
  let zoomValue = initialZoom || 100;

  const zoomControl = document.createElement("div");
  zoomControl.className = "ribbon-zoom-control";

  const zoomHeader = document.createElement("div");
  zoomHeader.className = "ribbon-zoom-header";

  const zoomLabel = document.createElement("span");
  zoomLabel.textContent = "Zoom";

  const zoomValueSpan = document.createElement("span");
  zoomValueSpan.className = "ribbon-zoom-value";
  zoomValueSpan.textContent = `${zoomValue}%`;

  const zoomReset = document.createElement("button");
  zoomReset.className = "ribbon-zoom-reset";
  zoomReset.textContent = "Reset";
  zoomReset.title = "Reset to 100%";
  zoomReset.style.display = zoomValue === 100 ? "none" : "";
  zoomReset.addEventListener("click", () => {
    zoomValue = 100;
    zoomSlider.value = "100";
    zoomValueSpan.textContent = "100%";
    zoomReset.style.display = "none";
    options.onZoomChange(100);
  });

  zoomHeader.appendChild(zoomLabel);
  zoomHeader.appendChild(zoomReset);
  zoomHeader.appendChild(zoomValueSpan);

  const zoomSlider = document.createElement("input");
  zoomSlider.type = "range";
  zoomSlider.min = "50";
  zoomSlider.max = "150";
  zoomSlider.step = "5";
  zoomSlider.value = String(zoomValue);
  zoomSlider.className = "ribbon-zoom-slider";
  zoomSlider.addEventListener("input", () => {
    const val = parseInt(zoomSlider.value);
    if (!isNaN(val)) {
      zoomValue = val;
      zoomValueSpan.textContent = `${val}%`;
      zoomReset.style.display = val === 100 ? "none" : "";
      options.onZoomChange(val);
    }
  });

  zoomControl.appendChild(zoomHeader);
  zoomControl.appendChild(zoomSlider);

  wrapper.appendChild(createRibbonSection("Zoom", zoomControl));

  return wrapper;
}
