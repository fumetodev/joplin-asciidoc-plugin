import { deriveImageAlt, isLocalImageTarget } from "./image-target";

export interface ImageInsertOptions {
  target: string;
  alt: string;
  title: string;
  caption: string;
  width: number;
  height: number;
  align: "center" | "left" | "right";
  captionPosition: "below" | "left" | "right";
}

export interface ParsedImageMacro extends ImageInsertOptions {
  source: "web" | "local";
}

function escapeImageAttr(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function splitImageAttrs(attrText: string): string[] {
  const attrs: string[] = [];
  let current = "";
  let inQuotes = false;

  for (const char of attrText) {
    if (char === '"') inQuotes = !inQuotes;
    if (char === "," && !inQuotes) {
      if (current.trim()) attrs.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }

  if (current.trim()) attrs.push(current.trim());
  return attrs;
}

function stripWrappedQuotes(value: string) {
  return value.replace(/^"(.*)"$/, "$1").trim();
}

function parseScaleValue(rawValue: string | undefined) {
  if (!rawValue) return 100;
  const match = rawValue.trim().match(/^(\d+(?:\.\d+)?)/);
  if (!match) return 100;
  const numeric = Math.round(Number.parseFloat(match[1]));
  if (!Number.isFinite(numeric)) return 100;
  return Math.min(200, Math.max(10, numeric));
}

export function parseImageMacroLine(lineText: string, caption = ""): ParsedImageMacro | null {
  const trimmed = lineText.trim();
  const match = trimmed.match(/^image::(.+?)\[(.*)?\]$/);
  if (!match) return null;

  const target = match[1].trim();
  const attrs = splitImageAttrs(match[2] ?? "");
  const parsed: Record<string, string> = {
    alt: deriveImageAlt(target),
    align: "center",
  };

  let consumedPositionalAlt = false;
  for (const attr of attrs) {
    const named = attr.match(/^([a-zA-Z0-9_-]+)\s*=\s*(.+)$/);
    if (named) {
      parsed[named[1].toLowerCase()] = stripWrappedQuotes(named[2]);
      continue;
    }

    if (!consumedPositionalAlt) {
      parsed.alt = stripWrappedQuotes(attr);
      consumedPositionalAlt = true;
    }
  }

  const alignValue = (parsed.align || "center").toLowerCase();
  const align = alignValue === "left" || alignValue === "right" ? alignValue : "center";

  const cpValue = (parsed["caption-position"] || "below").toLowerCase();
  const captionPosition = cpValue === "left" || cpValue === "right" ? cpValue : "below";

  return {
    target,
    alt: parsed.alt || deriveImageAlt(target),
    title: parsed.title || "",
    caption,
    width: parseScaleValue(parsed.width),
    height: parseScaleValue(parsed.height),
    align,
    captionPosition,
    source: isLocalImageTarget(target) ? "local" : "web",
  };
}

export function serializeImageBlock(options: ImageInsertOptions): string {
  const target = options.target.trim();
  if (!target) return "";

  const attrs: string[] = [];
  const altText = options.alt.trim();
  const titleText = options.title.trim();
  const captionText = options.caption.trim();

  if (altText) attrs.push(`alt="${escapeImageAttr(altText)}"`);
  if (options.width !== 100) attrs.push(`width="${options.width}%"`);
  if (options.height !== 100) attrs.push(`height="${options.height}%"`);
  attrs.push(`align="${options.align}"`);
  if (options.captionPosition && options.captionPosition !== "below") {
    attrs.push(`caption-position="${options.captionPosition}"`);
  }
  if (titleText) attrs.push(`title="${escapeImageAttr(titleText)}"`);

  const imageLine = `image::${target}[${attrs.join(",")}]`;
  return captionText ? `.${captionText}\n${imageLine}` : imageLine;
}
