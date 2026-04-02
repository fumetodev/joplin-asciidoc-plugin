/**
 * Joplin plugin sandbox entry point.
 * Registers the custom AsciiDoc editor, commands, and settings.
 * Reconstituted from the existing compiled plugin with the new
 * ribbon-based live-preview HTML template.
 */

import joplin from "api";

// Joplin MenuItemLocation values (defined locally to avoid requiring api/types at runtime)
const MenuItemLocation = {
  File: "file",
  Edit: "edit",
  View: "view",
  Note: "note",
  Tools: "tools",
  Help: "help",
  Context: "context",
  NoteListContextMenu: "noteListContextMenu",
  EditorContextMenu: "editorContextMenu",
  FolderContextMenu: "folderContextMenu",
  TagContextMenu: "tagContextMenu",
} as const;

const ToolbarButtonLocation = {
  NoteToolbar: "noteToolbar",
  EditorToolbar: "editorToolbar",
} as const;

// =====================================================
// Sentinel helpers
// =====================================================

const SENTINEL_REGEX = /\n?```asciidoc-settings\n([\s\S]*?)\n```\s*$/;

function isAsciiDocNote(body: string): boolean {
  return body.includes("```asciidoc-settings");
}

function stripSentinel(body: string): { content: string; settings: Record<string, any> } {
  const match = body.match(SENTINEL_REGEX);
  if (!match) return { content: body, settings: {} };
  const content = body.replace(SENTINEL_REGEX, "").trimEnd();
  let settings: Record<string, any> = {};
  try {
    settings = JSON.parse(match[1] || "{}");
  } catch {}
  return { content, settings };
}

function appendSentinel(content: string, settings: Record<string, any>): string {
  const { content: stripped } = stripSentinel(content);
  return `${stripped}\n\n\`\`\`asciidoc-settings\n${JSON.stringify(settings, null, 2)}\n\`\`\`\n`;
}

// =====================================================
// Markdown → AsciiDoc conversion helpers
// =====================================================

/**
 * Convert Markdown headings (# ... ######) to AsciiDoc headings (= ... ======).
 * Only converts lines where # is a heading marker:
 * - Must be at the start of the line (after optional whitespace)
 * - Must be followed by a space
 * - Skips lines inside fenced code blocks (``` or ~~~)
 */
function convertMarkdownHeadings(text: string): string {
  const lines = text.split("\n");
  let inCodeBlock = false;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trimStart();

    // Track fenced code blocks to avoid converting inside them
    if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (inCodeBlock) continue;

    // Match Markdown heading: 1-6 # chars at start of line, followed by a space
    const match = lines[i].match(/^(\s*)(#{1,6})\s+(.*)$/);
    if (match) {
      const [, leadingSpace, hashes, content] = match;
      const level = hashes.length;
      const equals = "=".repeat(level);
      lines[i] = `${leadingSpace}${equals} ${content}`;
    }
  }

  return lines.join("\n");
}

/**
 * Convert Markdown unordered lists using `-` markers to AsciiDoc `*` markers.
 *
 * Matches lines where `-` is a list marker:
 * - At the start of the line (after optional whitespace used for nesting)
 * - Followed by a space and then list content
 * - Indent level determines nesting depth (every 2 spaces = one extra level)
 *
 * Does NOT convert:
 * - Hyphens inside words (e.g., "side-effect")
 * - Lines inside fenced code blocks
 * - Horizontal rules (---, ----, etc.)
 * - Lines where `-` is not followed by a space (not a list marker)
 */
function convertMarkdownLists(text: string): string {
  const lines = text.split("\n");
  let inCodeBlock = false;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trimStart();

    // Track fenced code blocks to avoid converting inside them
    if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (inCodeBlock) continue;

    // Match a markdown list item: optional leading whitespace, then "- " followed by content
    const match = lines[i].match(/^(\s*)- (.+)$/);
    if (!match) continue;

    const [, indent, content] = match;

    // Skip horizontal rules (lines that are only dashes, possibly with spaces)
    if (/^-[\s-]*$/.test(trimmed)) continue;

    // Calculate nesting depth: base level is 1 star, each 2 spaces of indent adds a level
    const depth = Math.floor(indent.length / 2) + 1;
    const stars = "*".repeat(depth);
    lines[i] = `${stars} ${content}`;
  }

  return lines.join("\n");
}

/**
 * Convert Markdown inline links [text](url) to AsciiDoc link:url[text].
 * Also converts images ![alt](url) to image::url[alt].
 * Always uses the link: macro to prevent Asciidoctor from misinterpreting
 * special characters (commas, percent-encoding, fragments) in URLs.
 * Skips lines inside fenced code blocks.
 * Must run BEFORE convertMarkdownCodeBlocks so code block tracking still uses ```.
 */
function convertMarkdownLinks(text: string): string {
  const lines = text.split("\n");
  let inCodeBlock = false;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trimStart();

    if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (inCodeBlock) continue;

    // Convert images: ![alt](url "title")
    // Markdown titles are stripped.
    // If image is alone on line → block image (image::) with trailing text as caption
    // If image is inline with other content → inline image (image:)
    if (/!\[([^\]]*)\]\(/.test(lines[i])) {
      const imageOnlyMatch = lines[i].match(/^\s*!\[([^\]]*)\]\(([^\s)]+)(?:\s+["'][^"']*["'])?\)\s*$/);
      if (imageOnlyMatch) {
        // Standalone image → block macro
        lines[i] = `image::${imageOnlyMatch[2]}[${imageOnlyMatch[1]}]`;
      } else {
        const imageWithCaptionMatch = lines[i].match(/^\s*!\[([^\]]*)\]\(([^\s)]+)(?:\s+["'][^"']*["'])?\)\s*(.+)$/);
        if (imageWithCaptionMatch && !/!\[/.test(imageWithCaptionMatch[3])) {
          // Single image at start with trailing text (no other images) → block with caption
          const caption = imageWithCaptionMatch[3].trim();
          lines[i] = `${caption ? `.${caption}\n` : ""}image::${imageWithCaptionMatch[2]}[${imageWithCaptionMatch[1]}]`;
        } else {
          // Multiple images or image inline with text → inline image (image:)
          lines[i] = lines[i].replace(/!\[([^\]]*)\]\(([^\s)]+)(?:\s+["'][^"']*["'])?\)/g, "image:$2[$1]");
        }
      }
    }

    // Convert links: [text](url "title") → link:url[text]
    // Markdown titles are stripped
    lines[i] = lines[i].replace(/(.?)\[([^\]]*)\]\(([^\s)]+)(?:\s+["'][^"']*["'])?\)/g, (_match, before, linkText, url) => {
      // Ensure a space before link: when preceded by text (AsciiDoc requires word boundary)
      const needsSpace = before && !/\s/.test(before);
      return `${before}${needsSpace ? " " : ""}link:${url}[${linkText}]`;
    });
  }

  return lines.join("\n");
}

/**
 * Convert Markdown inline formatting to AsciiDoc equivalents.
 * - ***text*** (MD bold+italic) → *_text_* (AD bold+italic)
 * - **text**  (MD bold)         → *text* (AD constrained strong)
 * - ~~text~~  (MD strikethrough) → [line-through]#text# (AD)
 *
 * Note: single *text* (MD italic) is NOT converted because it conflicts
 * with AsciiDoc list markers and with the bold conversion output.
 * In AsciiDoc, *text* renders as bold which is acceptable.
 *
 * Processes outside of code blocks and inline code spans.
 */
function convertMarkdownInlineFormatting(text: string): string {
  const lines = text.split("\n");
  let inCodeBlock = false;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trimStart();

    if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (inCodeBlock) continue;

    // Split line into code spans and non-code segments to avoid
    // converting formatting inside inline code (`...`)
    const segments = lines[i].split(/(`[^`]+`)/);
    for (let j = 0; j < segments.length; j++) {
      // Skip inline code segments (odd indices from the split)
      if (segments[j].startsWith("`")) continue;

      // Bold+italic: ***text*** → *_text_* (must run before bold)
      segments[j] = segments[j].replace(/\*\*\*(.+?)\*\*\*/g, "*_$1_*");

      // Bold: **text** → *text*
      segments[j] = segments[j].replace(/\*\*(.+?)\*\*/g, "*$1*");

      // Strikethrough: ~~text~~ → [.line-through]#text#
      segments[j] = segments[j].replace(/~~(.+?)~~/g, "[.line-through]#$1#");
    }
    lines[i] = segments.join("");
  }

  return lines.join("\n");
}

/**
 * Convert Markdown fenced code blocks to AsciiDoc listing blocks.
 *   ```lang  →  [source,lang]\n----
 *   ```      →  ----
 *   ~~~lang  →  [source,lang]\n----
 * Must run AFTER all other line-based converters since it changes the
 * fence markers that those converters use for code-block tracking.
 */
function convertMarkdownCodeBlocks(text: string): string {
  const lines = text.split("\n");
  let inCodeBlock = false;
  const result: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trimStart();

    if (!inCodeBlock) {
      const openMatch = trimmed.match(/^(`{3,}|~{3,})\s*(\S*)\s*$/);
      if (openMatch) {
        inCodeBlock = true;
        const lang = openMatch[2];
        if (lang) {
          result.push(`[source,${lang}]`);
        }
        result.push("----");
        continue;
      }
    } else {
      if (/^(`{3,}|~{3,})\s*$/.test(trimmed)) {
        inCodeBlock = false;
        result.push("----");
        continue;
      }
    }

    result.push(lines[i]);
  }

  return result.join("\n");
}

/**
 * Convert HTML elements commonly found in Markdown notes.
 * - <br/>, <br>, <br /> → newline
 * - Strip inline HTML tags (<a>, <span>, <div>, etc.) preserving content
 * Must run BEFORE other converters so they see clean text.
 */
function convertHtmlElements(text: string): string {
  let result = text;
  // Convert <br> variants to newlines
  result = result.replace(/<br\s*\/?>/gi, "\n");
  // Strip common HTML tags, preserving their content
  result = result.replace(/<\/?(?:a|span|div|p|em|strong|b|i|u|s|del|ins|sup|sub|small|big|center|font|mark|abbr)(?:\s[^>]*)?>/gi, "");
  return result;
}

/**
 * Remove Markdown backslash escapes that have no meaning in AsciiDoc.
 * \* → *, \$ → $, \[ → [, \] → ], \- → -, \_ → _, \\ → \
 * Skips lines inside fenced code blocks.
 */
function convertMarkdownEscapes(text: string): string {
  const lines = text.split("\n");
  let inCodeBlock = false;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trimStart();

    if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (inCodeBlock) continue;

    // Split on inline code to avoid processing inside backticks
    const segments = lines[i].split(/(`[^`]+`)/);
    for (let j = 0; j < segments.length; j++) {
      if (segments[j].startsWith("`")) continue;
      // Remove backslash before common escaped characters
      segments[j] = segments[j].replace(/\\([*$\[\]\\_.!#\-+`~{}>])/g, "$1");
    }
    lines[i] = segments.join("");
  }

  return lines.join("\n");
}

/**
 * Convert Markdown linked images [![alt](imgUrl)](linkUrl)
 * to AsciiDoc image::imgUrl[alt, link=linkUrl].
 * Must run BEFORE convertMarkdownLinks to avoid nested bracket issues.
 */
function convertMarkdownLinkedImages(text: string): string {
  const lines = text.split("\n");
  let inCodeBlock = false;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trimStart();

    if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (inCodeBlock) continue;

    // [![alt](imgUrl "title")](linkUrl "title") → image macro with link
    // Markdown titles are stripped from both image and link URLs
    // If it's the only thing on the line → block (image::), otherwise inline (image:)
    const linkedImgRegex = /\[!\[([^\]]*)\]\(([^\s)]+)(?:\s+["'][^"']*["'])?\)\]\(([^\s)]+)(?:\s+["'][^"']*["'])?\)/g;
    const linkedImgOnlyMatch = lines[i].match(/^\s*\[!\[([^\]]*)\]\(([^\s)]+)(?:\s+["'][^"']*["'])?\)\]\(([^\s)]+)(?:\s+["'][^"']*["'])?\)\s*$/);
    if (linkedImgOnlyMatch) {
      // Single linked image alone on line → block macro
      lines[i] = `image::${linkedImgOnlyMatch[2]}[${linkedImgOnlyMatch[1]}, link=${linkedImgOnlyMatch[3]}]`;
    } else {
      // Inline with other content → inline macro (image:)
      lines[i] = lines[i].replace(linkedImgRegex, (_, alt, imgUrl, linkUrl) => {
        return `image:${imgUrl}[${alt}${linkUrl ? ", link=" + linkUrl : ""}]`;
      });
    }
  }

  return lines.join("\n");
}

/**
 * Apply all Markdown → AsciiDoc conversions.
 */
/**
 * Convert Markdown horizontal rules (---, ***, ___) to AsciiDoc (''').
 * Skips lines inside fenced code blocks.
 */
function convertMarkdownHorizontalRules(text: string): string {
  const lines = text.split("\n");
  let inCodeBlock = false;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trimStart();

    if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (inCodeBlock) continue;

    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(trimmed)) {
      lines[i] = "'''";
    }
  }

  return lines.join("\n");
}

function convertMarkdownToAsciidoc(text: string): string {
  let result = text;
  // HTML cleanup first so other converters see clean text
  result = convertHtmlElements(result);
  result = convertMarkdownEscapes(result);
  result = convertMarkdownHeadings(result);
  result = convertMarkdownLists(result);
  result = convertMarkdownHorizontalRules(result);
  result = convertMarkdownInlineFormatting(result);
  // Linked images before regular images/links (nested brackets)
  result = convertMarkdownLinkedImages(result);
  result = convertMarkdownLinks(result);
  // Code blocks last — changes fence markers that other converters rely on
  result = convertMarkdownCodeBlocks(result);
  return result;
}

// =====================================================
// Asciidoctor.js rendering
// =====================================================

let asciidoctorInstance: any = null;

function getAsciidoctor() {
  if (!asciidoctorInstance) {
    const Asciidoctor = require("asciidoctor");
    asciidoctorInstance = Asciidoctor();
  }
  return asciidoctorInstance;
}

function renderAsciidoc(source: string, settings: Record<string, any> = {}): string {
  try {
    const asciidoctor = getAsciidoctor();
    const attributes: Record<string, string> = {
      showtitle: "true",
      icons: "font",
      ...(settings.attributes || {}),
    };
    return asciidoctor.convert(source, {
      safe: "safe",
      backend: "html5",
      standalone: false,
      attributes,
    });
  } catch (e: any) {
    return `<div class="render-error"><h3>AsciiDoc Render Error</h3><pre>${
      (e.message || String(e)).replace(/</g, "&lt;").replace(/>/g, "&gt;")
    }</pre></div>`;
  }
}

// =====================================================
// Template tag
// =====================================================

const TEMPLATE_TAG = "asciidoc-template";

async function ensureTemplateTag(): Promise<string> {
  let page = 1;
  for (;;) {
    const result = await joplin.data.get(["tags"], {
      fields: ["id", "title"],
      page,
      limit: 100,
    });
    const items = result.items || result;
    for (const tag of items) {
      if (tag.title === TEMPLATE_TAG) return tag.id;
    }
    if (!result.has_more) break;
    page++;
  }
  const newTag = await joplin.data.post(["tags"], null, { title: TEMPLATE_TAG });
  return newTag.id;
}

async function getTemplateNotes(tagId: string): Promise<Array<{ id: string; title: string }>> {
  const notes: Array<{ id: string; title: string }> = [];
  let page = 1;
  for (;;) {
    const result = await joplin.data.get(["tags", tagId, "notes"], {
      fields: ["id", "title"],
      page,
      limit: 100,
    });
    const items = result.items || result;
    for (const note of items) {
      notes.push({ id: note.id, title: note.title });
    }
    if (!result.has_more) break;
    page++;
  }
  return notes.sort((a, b) => a.title.localeCompare(b.title));
}

// =====================================================
// Notebook conversion helpers
// =====================================================

async function getNotesInFolder(folderId: string): Promise<Array<{ id: string; title: string; body: string }>> {
  const notes: Array<{ id: string; title: string; body: string }> = [];
  let page = 1;
  for (;;) {
    const result = await joplin.data.get(["folders", folderId, "notes"], {
      fields: ["id", "title", "body"],
      page,
      limit: 100,
    });
    const items = result.items || result;
    for (const note of items) {
      notes.push({ id: note.id, title: note.title, body: note.body });
    }
    if (!result.has_more) break;
    page++;
  }
  return notes;
}

async function getSubFolders(parentId: string): Promise<Array<{ id: string; title: string }>> {
  const folders: Array<{ id: string; title: string }> = [];
  let page = 1;
  for (;;) {
    const result = await joplin.data.get(["folders"], {
      fields: ["id", "title", "parent_id"],
      page,
      limit: 100,
    });
    const items = result.items || result;
    for (const folder of items) {
      if ((folder as any).parent_id === parentId) {
        folders.push({ id: folder.id, title: folder.title });
      }
    }
    if (!result.has_more) break;
    page++;
  }
  return folders;
}

async function copyNotebookAsAsciiDoc(sourceFolderId: string, targetParentId: string, newTitle: string) {
  const newFolder = await joplin.data.post(["folders"], null, {
    parent_id: targetParentId,
    title: newTitle,
  });

  const notes = await getNotesInFolder(sourceFolderId);
  for (const note of notes) {
    const body = isAsciiDocNote(note.body)
      ? note.body
      : appendSentinel(convertMarkdownToAsciidoc(note.body), {});
    await joplin.data.post(["notes"], null, {
      parent_id: newFolder.id,
      title: note.title,
      body,
    });
  }

  const subFolders = await getSubFolders(sourceFolderId);
  for (const sub of subFolders) {
    await copyNotebookAsAsciiDoc(sub.id, newFolder.id, sub.title);
  }
}

async function replaceNotebookWithAsciiDoc(folderId: string) {
  const notes = await getNotesInFolder(folderId);
  for (const note of notes) {
    if (isAsciiDocNote(note.body)) continue;
    const converted = convertMarkdownToAsciidoc(note.body);
    const newBody = appendSentinel(converted, {});
    await joplin.data.put(["notes", note.id], null, { body: newBody });
  }

  const subFolders = await getSubFolders(folderId);
  for (const sub of subFolders) {
    await replaceNotebookWithAsciiDoc(sub.id);
  }
}

// =====================================================
// Commands registration
// =====================================================

let attributesDialog: any = null;

async function registerCommands() {
  await joplin.commands.register({
    name: "asciidoc.createNote",
    label: "New AsciiDoc Note",
    iconName: "fas fa-file-alt",
    execute: async () => {
      const folder = await joplin.workspace.selectedFolder();
      const note = await joplin.data.post(["notes"], null, {
        parent_id: folder.id,
        title: "New AsciiDoc Note",
        body: "= New AsciiDoc Note\n\nStart writing here...\n\n```asciidoc-settings\n{}\n```\n",
      });
      setTimeout(async () => {
        await joplin.commands.execute("openNote", note.id);
        try {
          await joplin.commands.execute("showEditorPlugin");
        } catch {}
      }, 100);
    },
  });

  await joplin.commands.register({
    name: "asciidoc.convertCurrentNote",
    label: "Convert to AsciiDoc Note",
    iconName: "fas fa-exchange-alt",
    execute: async () => {
      const selected = await joplin.workspace.selectedNote();
      if (!selected) return;
      const note = await joplin.data.get(["notes", selected.id], {
        fields: ["id", "body", "parent_id"],
      });
      if (!note || isAsciiDocNote(note.body)) return;
      const converted = convertMarkdownToAsciidoc(note.body);
      const newBody = appendSentinel(converted, {});
      await joplin.data.put(["notes", note.id], null, { body: newBody });
      // Force refresh by navigating away and back
      const tmp = await joplin.data.post(["notes"], null, {
        parent_id: note.parent_id,
        title: ".tmp-asciidoc-convert",
        body: "",
      });
      await joplin.commands.execute("openNote", tmp.id);
      await joplin.data.delete(["notes", tmp.id]);
      await joplin.commands.execute("openNote", note.id);
    },
  });

  await joplin.commands.register({
    name: "asciidoc.convertCurrentNoteCopy",
    label: "Convert to AsciiDoc Note (new file)",
    iconName: "fas fa-copy",
    execute: async () => {
      const selected = await joplin.workspace.selectedNote();
      if (!selected) return;
      const note = await joplin.data.get(["notes", selected.id], {
        fields: ["id", "title", "body", "parent_id"],
      });
      if (!note) return;
      const body = isAsciiDocNote(note.body)
        ? note.body
        : appendSentinel(convertMarkdownToAsciidoc(note.body), {});
      const copy = await joplin.data.post(["notes"], null, {
        parent_id: note.parent_id,
        title: note.title + " (AsciiDoc)",
        body,
      });
      setTimeout(async () => {
        await joplin.commands.execute("openNote", copy.id);
      }, 100);
    },
  });

  await joplin.commands.register({
    name: "asciidoc.editAttributes",
    label: "Edit AsciiDoc Attributes",
    iconName: "fas fa-cog",
    execute: async () => {
      const selected = await joplin.workspace.selectedNote();
      if (!selected || !isAsciiDocNote(selected.body)) return;

      const { content, settings } = stripSentinel(selected.body);
      const attributes = settings.attributes || {};
      const attrText = Object.entries(attributes)
        .map(([k, v]) => (v ? `${k}=${v}` : k))
        .join("\n");

      if (!attributesDialog) {
        attributesDialog = await joplin.views.dialogs.create("asciidoc-attributes");
      }

      await joplin.views.dialogs.setHtml(
        attributesDialog,
        `<div style="padding: 16px; font-family: sans-serif;">
          <h3 style="margin-top: 0;">AsciiDoc Document Attributes</h3>
          <p style="font-size: 13px; color: #666;">One attribute per line. Use <code>key=value</code> or just <code>key</code> for boolean attributes.</p>
          <textarea name="attributes" style="width: 100%; height: 200px; font-family: monospace; font-size: 13px; padding: 8px; box-sizing: border-box;">${attrText}</textarea>
        </div>`
      );

      await joplin.views.dialogs.setButtons(attributesDialog, [
        { id: "ok", title: "Save" },
        { id: "cancel", title: "Cancel" },
      ]);

      const result = await joplin.views.dialogs.open(attributesDialog);
      if (result.id === "ok" && result.formData) {
        const rawAttrs = result.formData.attributes?.attributes || "";
        const newAttrs: Record<string, string> = {};
        for (const line of rawAttrs.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          const eqIdx = trimmed.indexOf("=");
          if (eqIdx > 0) {
            newAttrs[trimmed.substring(0, eqIdx).trim()] = trimmed.substring(eqIdx + 1).trim();
          } else {
            newAttrs[trimmed] = "";
          }
        }
        const newSettings = { ...settings, attributes: newAttrs };
        const newBody = appendSentinel(content, newSettings);
        await joplin.data.put(["notes", selected.id], null, { body: newBody });
        await joplin.commands.execute("openNote", selected.id);
      }
    },
  });

  // "Create AsciiDoc Copy" — available in note list right-click menu
  await joplin.commands.register({
    name: "asciidoc.createAsciiDocCopy",
    label: "Create AsciiDoc Copy",
    iconName: "fas fa-copy",
    execute: async () => {
      const selected = await joplin.workspace.selectedNote();
      if (!selected) return;
      const note = await joplin.data.get(["notes", selected.id], {
        fields: ["id", "title", "body", "parent_id"],
      });
      if (!note) return;
      // Already an AsciiDoc note — just open it
      if (isAsciiDocNote(note.body)) {
        await joplin.commands.execute("openNote", note.id);
        return;
      }
      // Create a new AsciiDoc copy with converted headings and sentinel
      const converted = convertMarkdownToAsciidoc(note.body);
      const body = appendSentinel(converted, {});
      const copy = await joplin.data.post(["notes"], null, {
        parent_id: note.parent_id,
        title: note.title + " (AsciiDoc)",
        body,
      });
      setTimeout(async () => {
        await joplin.commands.execute("openNote", copy.id);
      }, 100);
    },
  });

  // "Replace with AsciiDoc File" — converts note in-place from note list right-click menu
  await joplin.commands.register({
    name: "asciidoc.replaceWithAsciiDoc",
    label: "Replace with AsciiDoc File",
    iconName: "fas fa-exchange-alt",
    execute: async () => {
      const selected = await joplin.workspace.selectedNote();
      if (!selected) return;
      const note = await joplin.data.get(["notes", selected.id], {
        fields: ["id", "body", "parent_id"],
      });
      if (!note) return;
      if (isAsciiDocNote(note.body)) return;
      const converted = convertMarkdownToAsciidoc(note.body);
      const newBody = appendSentinel(converted, {});
      await joplin.data.put(["notes", note.id], null, { body: newBody });
      // Force refresh by navigating away and back
      const tmp = await joplin.data.post(["notes"], null, {
        parent_id: note.parent_id,
        title: ".tmp-asciidoc-convert",
        body: "",
      });
      await joplin.commands.execute("openNote", tmp.id);
      await joplin.data.delete(["notes", tmp.id]);
      await joplin.commands.execute("openNote", note.id);
    },
  });

  // "Make this note AsciiDoc" — converts current note in-place, shown as toolbar button
  await joplin.commands.register({
    name: "asciidoc.makeCurrentNoteAsciiDoc",
    label: "Make AsciiDoc",
    iconName: "fas fa-file-alt",
    execute: async () => {
      const selected = await joplin.workspace.selectedNote();
      if (!selected) return;
      const note = await joplin.data.get(["notes", selected.id], {
        fields: ["id", "body", "parent_id"],
      });
      if (!note) return;
      if (isAsciiDocNote(note.body)) return; // Already AsciiDoc
      const converted = convertMarkdownToAsciidoc(note.body);
      const newBody = appendSentinel(converted, {});
      await joplin.data.put(["notes", note.id], null, { body: newBody });
      // Force Joplin to reload the note with the custom editor
      const tmp = await joplin.data.post(["notes"], null, {
        parent_id: note.parent_id,
        title: ".tmp-asciidoc-convert",
        body: "",
      });
      await joplin.commands.execute("openNote", tmp.id);
      await joplin.data.delete(["notes", tmp.id]);
      await joplin.commands.execute("openNote", note.id);
    },
  });

  // Register toolbar button — appears in the note toolbar for quick access
  await joplin.views.toolbarButtons.create(
    "asciidocMakeAsciiDocBtn",
    "asciidoc.makeCurrentNoteAsciiDoc",
    ToolbarButtonLocation.NoteToolbar,
  );

  // Register menu items
  await joplin.views.menuItems.create("asciidocCreateNote", "asciidoc.createNote", MenuItemLocation.Tools);
  await joplin.views.menuItems.create("asciidocConvert", "asciidoc.convertCurrentNote", MenuItemLocation.Tools);
  await joplin.views.menuItems.create("asciidocConvertCopy", "asciidoc.convertCurrentNoteCopy", MenuItemLocation.Tools);
  await joplin.views.menuItems.create("asciidocEditAttrs", "asciidoc.editAttributes", MenuItemLocation.Tools);

  // Note list right-click context menu
  await joplin.views.menuItems.create("asciidocCopyContextMenu", "asciidoc.createAsciiDocCopy", MenuItemLocation.NoteListContextMenu);
  await joplin.views.menuItems.create("asciidocReplaceContextMenu", "asciidoc.replaceWithAsciiDoc", MenuItemLocation.NoteListContextMenu);

  // Notebook (folder) conversion commands
  await joplin.commands.register({
    name: "asciidoc.copyNotebookAsAsciiDoc",
    label: "Create AsciiDoc Copy of Notebook",
    iconName: "fas fa-copy",
    execute: async (...args: any[]) => {
      try {
        // Folder ID may be passed as argument from context menu, or fall back to selected folder
        const folderId = args[0] || (await joplin.workspace.selectedFolder())?.id;
        if (!folderId) {
          console.error("[AsciiDoc] copyNotebook: no folder ID available");
          return;
        }
        const folderData = await joplin.data.get(["folders", folderId], {
          fields: ["id", "title", "parent_id"],
        });
        if (!folderData) {
          console.error("[AsciiDoc] copyNotebook: folder not found:", folderId);
          return;
        }
        console.info("[AsciiDoc] Creating AsciiDoc copy of notebook:", folderData.title);
        await copyNotebookAsAsciiDoc(folderData.id, folderData.parent_id || "", folderData.title + " (AsciiDoc)");
        console.info("[AsciiDoc] Notebook copy complete");
      } catch (e) {
        console.error("[AsciiDoc] copyNotebook failed:", e);
      }
    },
  });

  await joplin.commands.register({
    name: "asciidoc.replaceNotebookWithAsciiDoc",
    label: "Replace with AsciiDoc Notebook",
    iconName: "fas fa-exchange-alt",
    execute: async (...args: any[]) => {
      try {
        const folderId = args[0] || (await joplin.workspace.selectedFolder())?.id;
        if (!folderId) {
          console.error("[AsciiDoc] replaceNotebook: no folder ID available");
          return;
        }
        console.info("[AsciiDoc] Replacing notebook with AsciiDoc:", folderId);
        await replaceNotebookWithAsciiDoc(folderId);
        console.info("[AsciiDoc] Notebook replacement complete");
      } catch (e) {
        console.error("[AsciiDoc] replaceNotebook failed:", e);
      }
    },
  });

  // Folder right-click context menu
  await joplin.views.menuItems.create("asciidocCopyNotebookContextMenu", "asciidoc.copyNotebookAsAsciiDoc", MenuItemLocation.FolderContextMenu);
  await joplin.views.menuItems.create("asciidocReplaceNotebookContextMenu", "asciidoc.replaceNotebookWithAsciiDoc", MenuItemLocation.FolderContextMenu);
}

// =====================================================
// Settings registration
// =====================================================

async function registerSettings() {
  await joplin.settings.registerSection("asciidoc", {
    label: "AsciiDoc",
    iconName: "fas fa-file-alt",
  });

  await joplin.settings.registerSection("asciidoc-spellchecker", {
    label: "Spell Checker",
    iconName: "fas fa-spell-check",
  });

  await joplin.settings.registerSettings({
    "asciidoc.newNotesAsAsciiDoc": {
      section: "asciidoc",
      public: true,
      type: 3, // Boolean
      value: false,
      label: "Create new notes as AsciiDoc",
      description: "When enabled, new notes will automatically be created as AsciiDoc notes with the Live Preview editor.",
    },
    "asciidoc.compactSpacing": {
      section: "asciidoc",
      public: true,
      type: 3, // Boolean
      value: false,
      label: "Compact Spacing",
      description: "When enabled, uses tighter spacing between elements instead of official Asciidoctor spacing values.",
    },
    "asciidoc.personalDictionary": {
      section: "asciidoc",
      public: false,
      type: 2, // String
      value: "[]",
      label: "Personal Dictionary",
      description: "JSON array of custom dictionary words (managed by the spell checker).",
    },
    "asciidoc.spellcheckPluralSingular": {
      section: "asciidoc-spellchecker",
      public: true,
      type: 3, // Boolean
      value: true,
      label: "Adding New Words Adds Their Plural/Singular",
      description: "When enabled, the spell-checker right-click menu includes options to add a word along with its plural or singular form.",
    },
    "asciidoc.favoriteCopies": {
      section: "asciidoc",
      public: true,
      type: 3, // Boolean
      value: true,
      label: "Favorite Copies (Ctrl+Shift+C / Ctrl+Shift+V)",
      description: "When enabled, Ctrl+Shift+C copies text and adds it to a session-only favorites list. Ctrl+Shift+V opens an autocomplete dropdown to paste from that list.",
    },
    "asciidoc.favoriteCopiesMaxLength": {
      section: "asciidoc",
      public: true,
      type: 1, // Int
      value: 20,
      minimum: 1,
      maximum: 100,
      label: "Favorite Copies Max List Size",
      description: "Maximum number of items to keep in the Favorite Copies list (1-100).",
    },
    "asciidoc.attributeAutocomplete": {
      section: "asciidoc",
      public: true,
      type: 3, // Boolean
      value: true,
      label: "Attribute Autocomplete",
      description: "When enabled, typing { shows an autocomplete menu for document attributes defined in the header.",
    },
    "asciidoc.spellCheck": {
      section: "asciidoc",
      public: true,
      type: 3, // Boolean
      value: true,
      label: "Spell Checker",
      description: "Enable or disable the spell checker in the editor.",
    },
  });
}

// =====================================================
// Plugin entry point
// =====================================================

joplin.plugins.register({
  onStart: async function () {
    console.info("[AsciiDoc] Plugin onStart called");
    try {
    await registerSettings();
    await registerCommands();
    console.info("[AsciiDoc] Commands and settings registered");

    let templateTagId: string;
    try {
      templateTagId = await ensureTemplateTag();
    } catch (e) {
      console.error("[AsciiDoc] Failed to ensure template tag:", e);
      templateTagId = "";
    }

    const editors = (joplin.views as any).editors;
    if (!editors) {
      console.error("[AsciiDoc] joplin.views.editors not available — custom editor requires Joplin 3.1+");
      return;
    }
    let currentNoteId: string | null = null;
    let lastNote: { id: string; body: string; html: string } | null = null;

    async function renderNote(body: string): Promise<string> {
      const { content, settings } = stripSentinel(body);
      return renderAsciidoc(content, settings);
    }

    try {
    await editors.register("asciidoc-editor", {
      async onSetup(handle: any) {
        const isDark = await joplin.shouldUseDarkColors();
        const themeClass = isDark ? "dark-theme" : "light-theme";

        // NEW HTML template: ribbon + single editor pane (no split view)
        await editors.setHtml(
          handle,
          `<div id="asciidoc-editor-root" class="${themeClass}">
            <div id="ribbon-container"></div>
            <div id="editor-pane"></div>
          </div>`
        );

        await editors.addScript(handle, "./panel.js");
        await editors.addScript(handle, "./styles/editor.css");
        await editors.addScript(handle, "./styles/preview.css");
        await editors.addScript(handle, "./styles/katex.min.css");

        // Handle note updates from Joplin
        await editors.onUpdate(handle, async (update: any) => {
          if (!isAsciiDocNote(update.newBody)) return;
          currentNoteId = update.noteId;
          const html = await renderNote(update.newBody);
          lastNote = { id: update.noteId, body: update.newBody, html };
          editors.postMessage(handle, {
            type: "updateNote",
            value: lastNote,
          });
        });

        // Handle messages from webview
        await editors.onMessage(handle, async (msg: any) => {
          if (msg.kind === "ReturnValueResponse") return;

          // Ready — send current note (always fetch fresh to avoid stale cache)
          if (msg.type === "ready") {
            const response: any = {
              isDark: await joplin.shouldUseDarkColors(),
              compactSpacing: await joplin.settings.value("asciidoc.compactSpacing") === true,
              favoriteCopies: await joplin.settings.value("asciidoc.favoriteCopies") !== false,
              favoriteCopiesMaxLength: parseInt(String(await joplin.settings.value("asciidoc.favoriteCopiesMaxLength") || 20), 10),
              attributeAutocomplete: await joplin.settings.value("asciidoc.attributeAutocomplete") !== false,
              spellCheck: await joplin.settings.value("asciidoc.spellCheck") !== false,
            };
            try {
              const note = await joplin.workspace.selectedNote();
              if (note && isAsciiDocNote(note.body)) {
                currentNoteId = note.id;
                const html = await renderNote(note.body);
                lastNote = { id: note.id, body: note.body, html };
                response.note = lastNote;
              } else {
                // Clear stale cache when switching to a non-AsciiDoc note
                lastNote = null;
              }
            } catch {}
            return response;
          }

          // Save note — panel.ts sends body with sentinel already included
          if (msg.type === "saveNote") {
            const noteId = msg.noteId || currentNoteId;
            if (!noteId) return { status: "error", error: "No note ID" };
            // Ensure the sentinel is present; if panel sent raw content, add it
            const body = isAsciiDocNote(msg.body) ? msg.body : appendSentinel(msg.body, {});
            await editors.saveNote(handle, { noteId, body });
            return { status: "saved" };
          }

          // Get note content (for section preview)
          if (msg.type === "getNoteContent") {
            try {
              const note = await joplin.data.get(["notes", msg.noteId], {
                fields: ["id", "title", "body"],
              });
              const { content } = stripSentinel(note.body || "");
              return { id: note.id, title: note.title, body: content };
            } catch {
              return { id: msg.noteId, title: "", body: "" };
            }
          }

          // Render AsciiDoc
          if (msg.type === "renderAsciidoc") {
            return { html: await renderNote(msg.source) };
          }

          // Resolve Joplin resources
          if (msg.type === "requestResources") {
            const resources: Array<{ id: string; dataUrl: string }> = [];
            for (const id of msg.resourceIds) {
              try {
                const path = await joplin.data.resourcePath(id);
                resources.push({ id, dataUrl: "file://" + path });
              } catch (e) {
                console.warn("Failed to resolve resource " + id + ":", e);
              }
            }
            return { resources };
          }

          // Open image file dialog
          if (msg.type === "openImageDialog") {
            try {
              const result = await joplin.views.dialogs.showOpenDialog({
                title: "Select Image",
                filters: [
                  {
                    name: "Images",
                    extensions: [
                      "jpg", "jpeg", "png", "gif", "bmp", "svg",
                      "webp", "ico", "tiff", "tif", "avif",
                    ],
                  },
                ],
                properties: ["openFile"],
              } as any);

              if (Array.isArray(result)) {
                if (result.length > 0) return { filePath: result[0] };
              } else if (result && !result.canceled && result.filePaths?.length > 0) {
                return { filePath: result.filePaths[0] };
              }
            } catch (e) {
              console.warn("showOpenDialog failed:", e);
            }
            return { filePath: null };
          }

          // Create resource from file
          if (msg.type === "createResourceFromFile") {
            try {
              const path = require("path");
              const title = path.basename(msg.filePath);
              const resource = await joplin.data.post(
                ["resources"],
                null,
                { title },
                [{ path: msg.filePath }]
              );
              return { resourceId: resource.id, title: resource.title };
            } catch (e) {
              console.warn("createResourceFromFile failed:", e);
              return { error: String(e) };
            }
          }

          // Search notes
          if (msg.type === "searchNotes") {
            try {
              const query = (msg.query || "").trim();
              const result = query
                ? await joplin.data.get(["search"], {
                    query,
                    fields: ["id", "title", "body"],
                    limit: 20,
                  })
                : await joplin.data.get(["notes"], {
                    fields: ["id", "title", "body"],
                    order_by: "updated_time",
                    order_dir: "DESC",
                    limit: 20,
                  });
              const items = result.items || result;
              return {
                notes: items.map((n: any) => ({
                  id: n.id,
                  title: n.title,
                  isAsciiDoc: isAsciiDocNote(n.body || ""),
                })),
              };
            } catch {
              return { notes: [] };
            }
          }

          // Get note sections (headings)
          if (msg.type === "getNoteSections") {
            try {
              const note = await joplin.data.get(["notes", msg.noteId], {
                fields: ["body"],
              });
              const { content } = stripSentinel(note.body || "");
              const sections: Array<{ id: string; title: string; level: number }> = [];
              for (const line of content.split("\n")) {
                const match = line.match(/^(={1,5})\s+(.+)$/);
                if (match) {
                  const level = match[1].length;
                  const title = match[2].trim();
                  const anchor =
                    "_" +
                    title
                      .toLowerCase()
                      .replace(/[^a-z0-9\s_-]/g, "")
                      .replace(/[\s-]+/g, "_");
                  sections.push({ id: anchor, title, level });
                }
              }
              return { sections };
            } catch {
              return { sections: [] };
            }
          }

          // Navigate to note
          if (msg.type === "navigateToNote") {
            await joplin.commands.execute("openNote", msg.noteId);
            return { status: "ok" };
          }

          // Get templates
          if (msg.type === "getTemplates") {
            const templates = await getTemplateNotes(templateTagId);
            return { templates };
          }

          // Get template content
          if (msg.type === "getTemplateContent") {
            try {
              const note = await joplin.data.get(["notes", msg.noteId], {
                fields: ["body"],
              });
              const { content } = stripSentinel(note.body || "");
              return { content };
            } catch {
              return { content: "", error: "Failed to load template" };
            }
          }

          // Mark note as template
          if (msg.type === "markAsTemplate" && currentNoteId) {
            try {
              await joplin.data.post(["tags", templateTagId, "notes"], null, {
                id: currentNoteId,
              });
              return { status: "ok" };
            } catch {
              return { status: "error" };
            }
          }

          // Unmark template
          if (msg.type === "unmarkTemplate" && currentNoteId) {
            try {
              await joplin.data.delete(["tags", templateTagId, "notes", currentNoteId]);
              return { status: "ok" };
            } catch {
              return { status: "error" };
            }
          }

          // Remove a specific note from templates by ID
          if (msg.type === "removeTemplate" && msg.noteId) {
            try {
              await joplin.data.delete(["tags", templateTagId, "notes", msg.noteId]);
              return { status: "ok" };
            } catch {
              return { status: "error" };
            }
          }

          // Get spell-check settings
          if (msg.type === "getSpellcheckSettings") {
            try {
              const pluralSingular = await joplin.settings.value("asciidoc.spellcheckPluralSingular");
              return { pluralSingular: pluralSingular !== false };
            } catch {
              return { pluralSingular: true };
            }
          }

          // Get personal dictionary
          if (msg.type === "getPersonalDictionary") {
            try {
              const raw = await joplin.settings.value("asciidoc.personalDictionary");
              const words = JSON.parse(raw || "[]");
              return { words: Array.isArray(words) ? words : [] };
            } catch {
              return { words: [] };
            }
          }

          // Add word to personal dictionary
          if (msg.type === "addWordToPersonalDictionary") {
            try {
              const raw = await joplin.settings.value("asciidoc.personalDictionary");
              const words: string[] = JSON.parse(raw || "[]");
              if (!words.includes(msg.word)) {
                words.push(msg.word);
                words.sort();
                await joplin.settings.setValue("asciidoc.personalDictionary", JSON.stringify(words));
              }
              return { status: "ok" };
            } catch (e) {
              console.error("[AsciiDoc] Failed to save dictionary word:", e);
              return { status: "error" };
            }
          }

          // Fullscreen mode — toggle sidebars
          if (msg.type === "setFullscreenMode") {
            try {
              const layout = await (joplin.settings as any).globalValue("ui.layout");
              if (msg.enabled) {
                // Store current visibility before hiding
                let sideBarVisible = true;
                let noteListVisible = true;
                if (layout) {
                  const findVisible = (items: any[], key: string): boolean | undefined => {
                    for (const item of items) {
                      if (item.key === key) return item.visible !== false;
                      if (item.children) {
                        const found = findVisible(item.children, key);
                        if (found !== undefined) return found;
                      }
                    }
                    return undefined;
                  };
                  const layoutChildren = layout.children || [layout];
                  sideBarVisible = findVisible(layoutChildren, "sideBar") ?? true;
                  noteListVisible = findVisible(layoutChildren, "noteList") ?? true;
                }
                (globalThis as any).__asciidocFullscreenState = { sideBarVisible, noteListVisible };
                if (sideBarVisible) await joplin.commands.execute("toggleSideBar");
                if (noteListVisible) await joplin.commands.execute("toggleNoteList");
              } else {
                // Restore previous visibility
                const state = (globalThis as any).__asciidocFullscreenState;
                if (state) {
                  if (state.sideBarVisible) await joplin.commands.execute("toggleSideBar");
                  if (state.noteListVisible) await joplin.commands.execute("toggleNoteList");
                  delete (globalThis as any).__asciidocFullscreenState;
                }
              }
              return { status: "ok" };
            } catch (e) {
              console.error("[AsciiDoc] Failed to toggle fullscreen:", e);
              return { status: "error" };
            }
          }

          // Convert Markdown to AsciiDoc (for paste conversion)
          if (msg.type === "convertMarkdownPaste") {
            return { asciidoc: convertMarkdownToAsciidoc(msg.markdown || "") };
          }
        });

        // Push setting changes to the webview
        await (joplin.settings as any).onChange(async (event: any) => {
          if (event.keys.includes("asciidoc.compactSpacing")) {
            const value = await joplin.settings.value("asciidoc.compactSpacing");
            editors.postMessage(handle, {
              type: "updateCompactSpacing",
              value: value === true,
            });
          }
          if (event.keys.includes("asciidoc.favoriteCopies") || event.keys.includes("asciidoc.favoriteCopiesMaxLength")) {
            editors.postMessage(handle, {
              type: "updateFavoriteCopies",
              enabled: await joplin.settings.value("asciidoc.favoriteCopies") !== false,
              maxLength: parseInt(String(await joplin.settings.value("asciidoc.favoriteCopiesMaxLength") || 20), 10),
            });
          }
          if (event.keys.includes("asciidoc.attributeAutocomplete")) {
            editors.postMessage(handle, {
              type: "updateAttributeAutocomplete",
              enabled: await joplin.settings.value("asciidoc.attributeAutocomplete") !== false,
            });
          }
          if (event.keys.includes("asciidoc.spellCheck")) {
            editors.postMessage(handle, {
              type: "updateSpellCheck",
              enabled: await joplin.settings.value("asciidoc.spellCheck") !== false,
            });
          }
        });
      },

      async onActivationCheck(event: any) {
        if (!event.noteId) return false;
        const note = await joplin.data.get(["notes", event.noteId], {
          fields: ["body"],
        });
        return isAsciiDocNote(note?.body ?? "");
      },
    } as any);
    } catch (e) {
      console.error("[AsciiDoc] Failed to register custom editor:", e);
    }
    // Auto-convert new notes to AsciiDoc when setting is enabled.
    // Uses a debounce + lock to prevent loops. No temp notes.
    let autoConvertLock = false;
    const convertedNoteIds = new Set<string>();
    await joplin.workspace.onNoteSelectionChange(async (event: any) => {
      if (autoConvertLock) return;
      try {
        const autoConvert = await joplin.settings.value("asciidoc.newNotesAsAsciiDoc");
        if (!autoConvert) return;

        const noteIds = event.value;
        if (!noteIds || noteIds.length === 0) return;
        const noteId = noteIds[0];

        // Never process the same note twice
        if (convertedNoteIds.has(noteId)) return;

        const note = await joplin.data.get(["notes", noteId], {
          fields: ["id", "title", "body", "created_time"],
        });
        if (!note) return;
        if (isAsciiDocNote(note.body)) {
          convertedNoteIds.add(noteId); // Already AsciiDoc, mark as seen
          return;
        }

        // Only convert notes created very recently (within 5 seconds) with empty/default body
        const age = Date.now() - note.created_time;
        const bodyTrimmed = (note.body || "").trim();
        const isNew = age < 5000 && (bodyTrimmed === "" || bodyTrimmed === note.title);
        if (!isNew) return;

        // Lock to prevent re-entry from our own openNote call
        autoConvertLock = true;
        convertedNoteIds.add(noteId);

        // Just add the sentinel — Joplin will detect the change and reload
        const newBody = appendSentinel(note.body, {});
        await joplin.data.put(["notes", noteId], null, { body: newBody });

        // Re-open the same note so Joplin re-evaluates which editor to use
        await joplin.commands.execute("openNote", noteId);
      } catch (e) {
        console.error("[AsciiDoc] Auto-convert failed:", e);
      } finally {
        // Release lock after a delay to let Joplin settle
        setTimeout(() => { autoConvertLock = false; }, 1000);
      }
    });

    } catch (e) {
      console.error("[AsciiDoc] Plugin onStart failed:", e);
    }
  },
});
