// Control characters and bidirectional overrides, which can make attacker-supplied evidence
// display as something other than what it is.
// eslint-disable-next-line no-control-regex
const UNSAFE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g;

/** Make text from a scanned file safe to show as plain text: one line, no hidden characters, bounded. */
export function plain(value: string, limit = 200): string {
  const flat = value.replace(/[\r\n\t]+/g, " ").replace(UNSAFE, "\uFFFD").trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}

// eslint-disable-next-line no-control-regex
const ESCAPE_SEQUENCE = /\u001b\[[0-?]*[ -/]*[@-~]/g;

/**
 * Make a program's output safe to show as text of several lines: lines and tabs are kept, colour
 * sequences are dropped, every other control character and every bidirectional override is
 * replaced, and the text is bounded.
 */
export function lines(value: string, limit = 200_000): string {
  const text = value.replace(/\r\n?/g, "\n").replace(ESCAPE_SEQUENCE, "").replace(UNSAFE, "\uFFFD").replace(/\s+$/, "");
  return text.length > limit ? `${text.slice(0, limit)}\n… (${text.length - limit} more characters not shown)` : text;
}
