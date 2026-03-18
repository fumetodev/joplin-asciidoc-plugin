import { StreamLanguage, type StreamParser } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";

/**
 * AsciiDoc syntax highlighting via StreamLanguage
 */
const asciidocParser: StreamParser<{ inBlock: string | null }> = {
  startState() {
    return { inBlock: null };
  },

  token(stream, state) {
    // Handle block modes
    if (state.inBlock) {
      if (stream.match("----") || stream.match("====") || stream.match("____") || stream.match("****")) {
        state.inBlock = null;
        return "meta";
      }
      stream.skipToEnd();
      if (state.inBlock === "source") return "string";
      return null;
    }

    // Start of line checks
    if (stream.sol()) {
      // Headings: = through =====
      if (stream.match(/^={1,5}\s/)) {
        stream.skipToEnd();
        return "heading";
      }

      // Admonition
      if (stream.match(/^(NOTE|TIP|WARNING|CAUTION|IMPORTANT):\s/)) {
        stream.skipToEnd();
        return "keyword";
      }

      // List markers: *, ., - , * [ ], * [x]
      if (stream.match(/^(\*+|\.+|-)\s/)) {
        return "list";
      }
      if (stream.match(/^\*\s\[[ x]\]\s/)) {
        return "list";
      }

      // Block delimiters
      if (stream.match("----")) {
        state.inBlock = "source";
        return "meta";
      }
      if (stream.match("====")) {
        state.inBlock = "example";
        return "meta";
      }
      if (stream.match("____")) {
        state.inBlock = "quote";
        return "meta";
      }
      if (stream.match("****")) {
        state.inBlock = "sidebar";
        return "meta";
      }

      // Attribute line :key: value
      if (stream.match(/^:[a-zA-Z0-9_-]+:.*$/)) {
        return "meta";
      }

      // Comment
      if (stream.match(/^\/\/.*/)) {
        return "comment";
      }

      // Horizontal rule
      if (stream.match(/^'{3,}$/)) {
        return "contentSeparator";
      }
    }

    // Inline formatting
    // Bold *text*
    if (stream.match(/\*[^\s*]([^*]*[^\s*])?\*/)) {
      return "strong";
    }

    // Italic _text_
    if (stream.match(/_[^\s_]([^_]*[^\s_])?_/)) {
      return "emphasis";
    }

    // Monospace `text`
    if (stream.match(/`[^`]+`/)) {
      return "monospace";
    }

    // Superscript ^text^
    if (stream.match(/\^[^^]+\^/)) {
      return "string";
    }

    // Subscript ~text~
    if (stream.match(/~[^~]+~/)) {
      return "string";
    }

    // Link: link:url[text] or [[id]] or <<id,text>>
    if (stream.match(/link:[^\s\[]+\[[^\]]*\]/)) {
      return "link";
    }
    if (stream.match(/\[\[[^\]]+\]\]/)) {
      return "link";
    }
    // Cross-reference: <<id>> or <<id,text>> or <<id#section,text>>
    if (stream.match(/<<[^>]+>>/)) {
      return "link";
    }

    // Image: image::path[alt]
    if (stream.match(/image::?[^\s\[]+\[[^\]]*\]/)) {
      return "url";
    }

    // Macro-like: word::text
    if (stream.match(/[a-zA-Z]+::[^\s]+/)) {
      return "variableName";
    }

    stream.next();
    return null;
  },
};

export function asciidocLanguage() {
  return StreamLanguage.define(asciidocParser);
}
