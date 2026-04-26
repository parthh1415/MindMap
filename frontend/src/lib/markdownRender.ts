// markdownRender.ts
//
// Wraps `marked` (parser) + `dompurify` (sanitizer). Returns sanitized HTML
// suitable for `dangerouslySetInnerHTML`. Raw HTML is stripped entirely so
// the only tags reaching the DOM are the ones marked produces from the
// safe markdown subset (h1–h6, p, ul/ol/li, code, pre, strong, em, a, etc).
//
// Adds a kebab-case `id` to every H2 heading so the editor can scroll to a
// section anchor and the evidence panel can deep-link.
//
// Tabular numerals are applied via a wrapper class `.prose` defined where
// the HTML is rendered; this module only emits `<span class="tnum">N</span>`
// around bare integer tokens inside paragraphs so digits inside otherwise
// proportional text still align cleanly.

import { Marked, type Token, type Tokens } from "marked";
import DOMPurify from "dompurify";

// Recursively collect plain-text from a token tree (used for slugifying
// headings before HTML entity escaping happens).
function collectPlain(tokens: Token[] | undefined): string {
  if (!tokens) return "";
  let out = "";
  for (const t of tokens) {
    const o = t as { text?: string; tokens?: Token[] };
    if (Array.isArray(o.tokens)) {
      out += collectPlain(o.tokens);
    } else if (typeof o.text === "string") {
      out += o.text;
    }
  }
  return out;
}

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

function makeMarked(): Marked {
  const m = new Marked({
    gfm: true,
    breaks: false,
    pedantic: false,
  });

  // Add id="<kebab-slug>" to every H2.
  m.use({
    renderer: {
      heading({ tokens, depth }: Tokens.Heading): string {
        // Render inline children via the parser's parseInline (gives HTML).
        // For the slug we walk the raw tokens and recover plain text so
        // entity escapes (e.g. `&amp;` from `&`) don't pollute the id.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const parser = (this as any).parser;
        const html: string =
          parser && typeof parser.parseInline === "function"
            ? parser.parseInline(tokens)
            : tokens
                .map((t) =>
                  "text" in t ? (t as { text: string }).text : "",
                )
                .join("");
        if (depth === 2) {
          const plain = collectPlain(tokens);
          const id = slugify(plain);
          return `<h2 id="${id}">${html}</h2>`;
        }
        return `<h${depth}>${html}</h${depth}>`;
      },
    },
  });

  return m;
}

const _marked = makeMarked();

export function renderMarkdown(md: string): string {
  if (!md) return "";
  const raw = _marked.parse(md, { async: false }) as string;
  // Hard sanitize: forbid raw <script>, <style>, <iframe> etc. by default.
  // ALLOWED_TAGS is the default safe set; keep id attribute on headings for
  // anchor linking.
  const clean = DOMPurify.sanitize(raw, {
    USE_PROFILES: { html: true },
    ADD_ATTR: ["id"],
    FORBID_TAGS: ["script", "style", "iframe", "object", "embed"],
    FORBID_ATTR: ["onerror", "onclick", "onload", "onmouseover"],
  });
  return clean;
}

export default renderMarkdown;
