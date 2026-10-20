import { lines, plain } from "./text";

// Every value from a scan (file names, descriptions, evidence, saw's own output) may be chosen by
// whoever wrote the scanned folder. It reaches Markdown only through `inline` and `block`, which
// keep it literal: no links, images, HTML or emphasis can come out of it.

function longestRun(value: string, char: string): number {
  let longest = 0;
  let run = 0;
  for (const c of value) {
    run = c === char ? run + 1 : 0;
    longest = Math.max(longest, run);
  }
  return longest;
}

/** A value as ordinary text on one line, with every character Markdown would act on escaped. */
export function prose(value: string, limit = 400): string {
  return plain(value, limit).replace(/[!-/:-@[-`{-~]/g, (c) => `\\${c}`);
}

/** A value as an inline code span, on one line. */
export function inline(value: string, limit = 300): string {
  const text = plain(value, limit);
  if (!text) {
    return "*(empty)*";
  }
  const fence = "`".repeat(longestRun(text, "`") + 1);
  const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
  return `${fence}${pad}${text}${pad}${fence}`;
}

/** Text of several lines as a fenced code block. */
export function block(value: string, limit?: number): string {
  const text = lines(value, limit);
  const fence = "`".repeat(Math.max(3, longestRun(text, "`") + 1));
  return `${fence}text\n${text}\n${fence}`;
}

const SAFE_HREF = /^[A-Za-z0-9\-._~:/?#[\]@!$&'*+,;=%]+$/;

/** A link to an https page, or the address as code when it is not a plain https URL. */
export function webLink(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "https:" && SAFE_HREF.test(parsed.href) && !/[()]/.test(parsed.href)) {
      return `[${inline(parsed.host, 100)}](${parsed.href})`;
    }
  } catch {
    // Not a URL: shown as text below.
  }
  return inline(url, 300);
}
