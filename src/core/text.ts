// Control characters and bidirectional overrides, which can make attacker-supplied evidence
// display as something other than what it is.
// eslint-disable-next-line no-control-regex
const UNSAFE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g;

/** Make text from a scanned file safe to show as plain text: one line, no hidden characters, bounded. */
export function plain(value: string, limit = 200): string {
  const flat = value.replace(/[\r\n\t]+/g, " ").replace(UNSAFE, "\uFFFD").trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}

/**
 * Make a program's output safe to write to a terminal: lines and tabs are kept, every other control
 * character — the escape sequences a terminal would act on — and every bidirectional override is
 * replaced. Lines end in CRLF, as a terminal expects.
 */
export function forTerminal(value: string): string {
  return value.replace(/\r\n?/g, "\n").replace(UNSAFE, "\uFFFD").replace(/\n/g, "\r\n");
}
