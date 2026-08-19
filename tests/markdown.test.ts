import { describe, expect, test } from "bun:test";
import { renderMarkdown } from "../ui/markdown";

describe("renderMarkdown", () => {
  test("escapes raw HTML — agent output can never inject markup", () => {
    const out = renderMarkdown('<img src=x onerror=alert(1)> & <script>hi</script>');
    expect(out).not.toContain("<img");
    expect(out).not.toContain("<script");
    expect(out).toContain("&lt;script&gt;");
  });

  test("fenced code keeps its content verbatim (escaped), with a lang tag", () => {
    const out = renderMarkdown("```ts\nconst a = 1 < 2;\n```");
    expect(out).toContain('<pre data-lang="ts">');
    expect(out).toContain("const a = 1 &lt; 2;");
  });

  test("an unclosed fence still renders as code, not soup", () => {
    const out = renderMarkdown("```\nraw *stuff*");
    expect(out).toContain("<pre");
    expect(out).toContain("raw *stuff*");
    expect(out).not.toContain("<em>");
  });

  test("inline: code, bold, italic, links — http(s) only", () => {
    const out = renderMarkdown("run `x` **now** *soon* [docs](https://a.b) [bad](javascript:alert(1))");
    expect(out).toContain("<code>x</code>");
    expect(out).toContain("<strong>now</strong>");
    expect(out).toContain("<em>soon</em>");
    expect(out).toContain('href="https://a.b"');
    expect(out).not.toContain('href="javascript:');   // the bad link stays plain text
  });

  test("lists, headings, quotes, hr", () => {
    const out = renderMarkdown("## Head\n- one\n- two\n\n1. first\n\n> quoted\n\n---");
    expect(out).toContain("<h4>Head</h4>");
    expect(out).toContain("<ul><li>one</li><li>two</li></ul>");
    expect(out).toContain("<ol><li>first</li></ol>");
    expect(out).toContain("<blockquote>quoted</blockquote>");
    expect(out).toContain("<hr>");
  });

  test("bare * and _ in prose stay literal", () => {
    const out = renderMarkdown("a * b and snake_case_name stay put");
    expect(out).not.toContain("<em>");
  });
});
