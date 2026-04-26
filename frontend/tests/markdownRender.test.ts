import { describe, it, expect } from "vitest";
import { renderMarkdown, slugify } from "../src/lib/markdownRender";

describe("markdownRender", () => {
  it("renders headings, paragraphs, and lists", () => {
    const html = renderMarkdown(
      "# Title\n\n## Section One\n\nA paragraph.\n\n- one\n- two",
    );
    expect(html).toContain("<h1>Title</h1>");
    expect(html).toContain("<h2");
    expect(html).toContain(">Section One</h2>");
    expect(html).toContain("<li>one</li>");
    expect(html).toContain("<li>two</li>");
  });

  it("strips raw <script> tags via DOMPurify sanitization", () => {
    const html = renderMarkdown(
      "# Hi\n\nText\n\n<script>alert('xss')</script>",
    );
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toContain("alert('xss')");
  });

  it("emits kebab-case anchor ids on H2 headings", () => {
    const html = renderMarkdown(
      "## Goals & Constraints\n\n## Open Questions",
    );
    expect(html).toContain('id="goals-constraints"');
    expect(html).toContain('id="open-questions"');
  });

  it("does not anchor H1/H3 with ids", () => {
    const html = renderMarkdown("# Top\n\n### Sub");
    expect(html).toContain("<h1>Top</h1>");
    expect(html).toContain("<h3>Sub</h3>");
  });

  it("returns empty string for empty input", () => {
    expect(renderMarkdown("")).toBe("");
  });

  it("forbids inline event handler attributes", () => {
    const html = renderMarkdown('<a href="x" onclick="alert(1)">link</a>');
    expect(html).not.toMatch(/onclick=/i);
  });

  it("slugify produces stable kebab slugs", () => {
    expect(slugify("Hello, World!")).toBe("hello-world");
    expect(slugify("  Spacing   matters  ")).toBe("spacing-matters");
    expect(slugify("Symbols & Stuff")).toBe("symbols-stuff");
  });
});
