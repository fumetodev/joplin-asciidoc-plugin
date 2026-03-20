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
 * Apply all Markdown → AsciiDoc conversions.
 */
function convertMarkdownToAsciidoc(text: string): string {
  let result = text;
  result = convertMarkdownHeadings(result);
  result = convertMarkdownLists(result);
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
}

// =====================================================
// Settings registration
// =====================================================

async function registerSettings() {
  await joplin.settings.registerSection("asciidoc", {
    label: "AsciiDoc",
    iconName: "fas fa-file-alt",
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
              if (!query) return { notes: [] };
              const result = await joplin.data.get(["search"], {
                query,
                fields: ["id", "title", "body"],
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
