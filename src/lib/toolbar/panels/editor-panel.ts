export interface EditorPanelOptions {
  onToggleLineNumbers: (show: boolean) => void;
  onToggleBlockShading: (show: boolean) => void;
  onToggleOverlayEditing: (show: boolean) => void;
  onMarginChange: (px: number) => void;
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

export function buildEditorPanel(options: EditorPanelOptions, initialMargin?: number): HTMLElement {
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
  lineNumCb.checked = false;
  lineNumCb.addEventListener("input", () => {
    options.onToggleLineNumbers(lineNumCb.checked);
  });
  const lineNumSpan = document.createElement("span");
  lineNumSpan.textContent = "Line numbers";
  lineNumLabel.appendChild(lineNumCb);
  lineNumLabel.appendChild(lineNumSpan);
  displayToggles.appendChild(lineNumLabel);

  wrapper.appendChild(createRibbonSection("Display", displayToggles));

  // --- Appearance section ---
  const appearanceToggles = document.createElement("div");
  appearanceToggles.className = "editor-toggles editor-toggles-appearance";

  // Special Block Shading checkbox
  const shadingLabel = document.createElement("label");
  shadingLabel.className = "ribbon-toggle";
  const shadingCb = document.createElement("input");
  shadingCb.type = "checkbox";
  shadingCb.checked = true;
  shadingCb.addEventListener("input", () => {
    options.onToggleBlockShading(shadingCb.checked);
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

  return wrapper;
}
