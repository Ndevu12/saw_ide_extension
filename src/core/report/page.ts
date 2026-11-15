import MarkdownIt from "markdown-it";

import { pageDocument } from "../chat/brand";
import { PAGE_SCRIPT } from "../chat/transcript";

// A details document as an editor tab of the extension's own. Markup in the document is not
// passed through: what saw quoted stays text, and links keep markdown-it's safe schemes.
const markdown = new MarkdownIt({ html: false, linkify: false, typographer: false });

/** A link is handed to the extension, which opens it only when it is https. */
const LINK_SCRIPT = `
  document.body.addEventListener("click", (event) => {
    const link = event.target instanceof Element ? event.target.closest("a[href]") : null;
    if (!link) return;
    event.preventDefault();
    vscode.postMessage({ link: link.getAttribute("href") });
  });
`;

export function detailsPage(text: string, nonce: string): string {
  return pageDocument(nonce, `<main class="details">${markdown.render(text)}</main>`, PAGE_SCRIPT + LINK_SCRIPT, "editor");
}

/** The address a details link may open: https only. */
export function linkTarget(href: unknown): string | undefined {
  if (typeof href !== "string") {
    return undefined;
  }
  try {
    return new URL(href).protocol === "https:" ? href : undefined;
  } catch {
    return undefined;
  }
}
