import { describe, expect, it } from "vitest";

import { detailsPage, linkTarget } from "../../src/core/report/page";

describe("a details tab", () => {
  it("draws the document without passing markup or unsafe links through", () => {
    const html = detailsPage("# Full details: app\n\n<img src=x onerror=alert(1)>\n\n[docs](https://saw-docs.ndevuspace.com/) [bad](javascript:alert(1))\n\n```text\n<script>x</script>\n```", "n");
    expect(html).toContain("<h1>Full details: app</h1>");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).toContain('<a href="https://saw-docs.ndevuspace.com/">docs</a>');
    expect(html).not.toContain('href="javascript:');
    expect(html).toContain("&lt;script&gt;x&lt;/script&gt;");
    expect(html).toContain("default-src 'none'");
    expect(html).not.toContain("Preview");
  });

  it("opens https links only", () => {
    expect(linkTarget("https://saw-docs.ndevuspace.com/")).toBe("https://saw-docs.ndevuspace.com/");
    for (const href of ["http://example.test", "file:///etc/passwd", "command:saw.fixFolder", "javascript:alert(1)", 3, undefined]) {
      expect(linkTarget(href)).toBeUndefined();
    }
  });
});
