// The colors `saw intro` prints. Mint is the wordmark, green is the work that matters,
// cyan is a command, and the page sits on black.

/** The logo. (126, 231, 176). */
export const MINT = "#7ee7b0";
/** detect · report · auto-fix. (76, 208, 125). */
export const GREEN = "#4cd07d";
/** A command, such as `saw scan`. (95, 211, 221). */
export const CYAN = "#5fd3dd";
/** Body copy. (201, 211, 222). */
export const INK = "#c9d3de";
/** A heading. (240, 246, 252). */
export const WHITE = "#f0f6fc";
/** Secondary copy. (122, 133, 148). */
export const DIM = "#7a8594";
/** The ground under the wordmark. */
export const BLACK = "#070908";
/** A card on that ground. */
export const CARD = "#0c1210";
/** A quiet edge. */
export const EDGE = "#1a3d2c";
/** Something to check: suspicious, could not scan, needs repair. */
export const AMBER = "#e3b341";
/** Infected, or a change that was not held. */
export const RED = "#ff6b6b";

/** A control with a fill and a border. A label alone is not a button. */
export function buttonCss(): string {
  return `
    button {
      appearance: none;
      font: inherit;
      font-weight: 650;
      line-height: 1.35;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      box-sizing: border-box;
      width: 100%;
      min-height: 34px;
      padding: 7px 14px;
      border-radius: 6px;
      border: 1px solid ${GREEN};
      background: #123524;
      color: ${WHITE};
      box-shadow: inset 0 1px 0 rgba(126, 231, 176, 0.22);
    }
    button:hover { background: #1b4a32; border-color: ${MINT}; }
    button.primary { background: ${GREEN}; border-color: ${MINT}; color: #04140c; box-shadow: none; }
    button.primary:hover { background: ${MINT}; }
    button.secondary { background: #0e1c18; border-color: ${CYAN}; color: #e7fdff; }
    button.secondary:hover { background: #14343a; border-color: #9aebf0; }
    button.danger { background: #3a1518; border-color: #e06a6a; color: #ffe8e8; box-shadow: none; }
    button.danger:hover { background: #541c22; }
    button:focus { outline: 2px solid ${MINT}; outline-offset: 2px; }
  `;
}

/** The page around those buttons: black ground, green edges, and the Decide tab's layout. */
export function pageCss(): string {
  return `
    body { margin: 0; padding: 12px; background: ${BLACK}; color: ${INK}; font-family: var(--vscode-font-family, system-ui, sans-serif); font-size: var(--vscode-font-size, 13px); line-height: 1.45; }
    body.editor { padding: 28px 32px 40px; }
    p { margin: 0 0 8px; }
    .hint, .meta { color: ${DIM}; }
    ul { padding-left: 1.2em; }
    li { margin: 6px 0; }
    .actions { display: flex; flex-direction: column; gap: 8px; }
    body.editor .actions { flex-direction: row; flex-wrap: wrap; }
    body.editor .actions button { width: auto; min-width: 11rem; }
    input[type=checkbox] { accent-color: ${GREEN}; width: 1rem; height: 1rem; margin-top: 2px; }
    label { display: flex; gap: 8px; align-items: flex-start; }
    ${buttonCss()}
    ${sharedCss()}
    ${chatCss()}
    ${verdictCss()}
  `;
}

/** What Chat and the verdict tab both draw: a status pill, a running line, a summary, and notices. */
function sharedCss(): string {
  return `
    .top { display: flex; align-items: center; gap: 8px; min-width: 0; }
    .title { margin: 0; flex: 1; min-width: 0; font-size: 13.5px; font-weight: 650; color: ${WHITE}; line-height: 1.3; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .pill { flex: none; font-size: 10.5px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; line-height: 1.5; padding: 1px 8px; border-radius: 999px; border: 1px solid #2a3340; color: ${DIM}; }
    .ok .pill { color: ${MINT}; border-color: #1f6b44; background: #0d2219; }
    .warn .pill { color: ${AMBER}; border-color: #6b5520; background: #1f1a0c; }
    .bad .pill { color: #ffd6d6; border-color: ${RED}; background: #3a1518; }
    .live { display: flex; align-items: center; gap: 7px; color: ${CYAN}; font-size: 12px; margin: 6px 0 0; }
    .spin { flex: none; width: 9px; height: 9px; border-radius: 50%; border: 2px solid #1d4a4e; border-top-color: ${CYAN}; animation: spin 0.9s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
    @media (prefers-reduced-motion: reduce) { .spin { animation: none; } }
    .sum { margin: 4px 0 0; font-size: 12.5px; color: ${INK}; }
    .notice { margin: 8px 0 0; padding: 6px 9px; border-radius: 4px; border-left: 2px solid ${DIM}; background: #0f1513; font-size: 12px; line-height: 1.4; }
    .notice.warn { border-left-color: ${AMBER}; background: #1d1a0e; }
    .notice.bad { border-left-color: ${RED}; background: #241012; }
    .notice.ok { border-left-color: ${GREEN}; }
    .dot { flex: none; width: 7px; height: 7px; border-radius: 50%; background: ${DIM}; }
    .dot.ok { background: ${GREEN}; }
    .dot.warn { background: ${AMBER}; }
    .dot.bad { background: ${RED}; }
    button.danger { background: #c93c44; border-color: ${RED}; color: #fff5f5; }
    button.danger:hover { background: #dc4a52; }
    button.link { width: auto; min-height: 0; padding: 2px 0; border: none; background: none; box-shadow: none; color: ${CYAN}; font-size: 12px; font-weight: 600; }
    button.link:hover { background: none; color: #9aebf0; text-decoration: underline; }
  `;
}

/** Chat: one card per folder with a single next step, then the machine as short rows. */
function chatCss(): string {
  return `
    .chat { display: flex; flex-direction: column; gap: 10px; }
    .card { background: ${CARD}; border: 1px solid ${EDGE}; border-left: 3px solid ${EDGE}; border-radius: 6px; padding: 10px 12px; }
    .card.ok { border-left-color: ${GREEN}; }
    .card.warn { border-left-color: ${AMBER}; }
    .card.bad { border-color: #4a1e22; border-left-color: ${RED}; }
    .body { margin: 6px 0 0; font-size: 12.5px; }
    .cta { margin-top: 10px; }
    .cta button { min-height: 30px; padding: 5px 12px; }
    .cta .note { margin: 5px 0 0; font-size: 11.5px; color: ${DIM}; text-align: center; }
    .links { display: flex; flex-wrap: wrap; gap: 2px 16px; margin-top: 8px; }
    .machine { margin-top: 2px; padding-top: 10px; border-top: 1px solid #16251f; }
    .machine > .top { padding: 0 2px 4px; }
    .machine .title { font-size: 11px; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; color: ${DIM}; }
    .items { list-style: none; margin: 0; padding: 0; }
    .item { display: flex; align-items: center; gap: 6px; margin: 0; }
    .row { flex: 1; min-width: 0; display: grid; grid-template-columns: 7px minmax(0, 1fr); column-gap: 9px; align-items: center; justify-content: stretch; text-align: left; padding: 6px 4px; border-radius: 5px; }
    button.row { width: auto; min-height: 0; border: none; background: none; box-shadow: none; font-weight: inherit; color: ${INK}; }
    button.row:hover { background: #101a16; border: none; }
    .row .dot { grid-row: 1 / span 2; }
    .row .name { font-size: 12.5px; font-weight: 600; color: ${WHITE}; }
    .row .state { grid-column: 2; font-size: 12px; color: ${DIM}; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
    button.small { flex: none; width: auto; min-height: 24px; padding: 2px 10px; font-size: 11.5px; }
    button.small.secondary { background: transparent; border-color: #23463a; color: ${INK}; box-shadow: none; }
    .foot { display: flex; flex-wrap: wrap; gap: 2px 16px; padding: 8px 4px 0; border-top: 1px solid #16251f; }
    .foot button.link { color: ${DIM}; font-weight: 500; }
    .foot button.link:hover { color: ${INK}; }
  `;
}

/** The verdict tab: the result and its next step on top, then why, then every finding. */
function verdictCss(): string {
  return `
    .verdict { max-width: 820px; margin: 0 auto; }
    .hero { padding-bottom: 18px; margin-bottom: 18px; border-bottom: 1px solid ${EDGE}; }
    .hero .top { gap: 12px; }
    .hero .title { font-size: 22px; white-space: normal; overflow-wrap: anywhere; }
    .path { margin: 6px 0 0; font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; color: ${DIM}; overflow-wrap: anywhere; }
    .hero .live { font-size: 13px; margin-top: 10px; }
    .hero .sum { margin-top: 10px; font-size: 14px; font-weight: 600; color: ${WHITE}; }
    .bar { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 14px; }
    .bar button { width: auto; min-width: 8rem; }
    .hero .hint { margin: 10px 0 0; max-width: 72ch; font-size: 12.5px; }
    .verdict > .notice { margin: 0 0 10px; font-size: 13px; }
    .block { margin-top: 22px; }
    .block h2 { margin: 0 0 8px; font-size: 11px; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; color: ${DIM}; }
    .why { margin: 0; padding-left: 1.1em; }
    .empty { margin-top: 4px; }
    .verdict > .hint { margin-top: 14px; }
    .findings { list-style: none; margin: 0; padding: 0; }
    .findings li { margin: 0; padding: 10px 0; border-top: 1px solid #16251f; }
    .findings li:first-child { border-top: none; padding-top: 2px; }
    .what { display: flex; gap: 8px; align-items: baseline; line-height: 1.4; color: ${WHITE}; }
    .sev { flex: none; font-size: 10px; font-weight: 750; letter-spacing: 0.06em; text-transform: uppercase; padding: 1px 5px; border-radius: 3px; border: 1px solid ${DIM}; color: ${DIM}; }
    .sev.critical { background: ${RED}; border-color: ${RED}; color: #1a0506; }
    .sev.high { border-color: ${RED}; color: ${RED}; }
    .sev.medium { border-color: ${AMBER}; color: ${AMBER}; }
    .count { color: ${DIM}; font-size: 12px; white-space: nowrap; }
    .places { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; margin-top: 6px; }
    .places button { display: inline-block; width: auto; max-width: 100%; min-height: 0; padding: 2px 7px; border-radius: 4px; font-family: var(--vscode-editor-font-family, monospace); font-size: 11.5px; font-weight: 500; background: #0f1916; border: 1px solid #1f3a2e; color: ${INK}; box-shadow: none; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .places button:hover { border-color: ${MINT}; color: ${WHITE}; background: #133024; }
    .more { color: ${DIM}; font-size: 12px; margin-left: 4px; }
  `;
}

/** One webview document. Scan text in `body` is already escaped. */
export function pageDocument(nonce: string, body: string, script: string, place: "side" | "editor" = "side"): string {
  const safe = escapeHtml(nonce);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${safe}'; script-src 'nonce-${safe}'">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style nonce="${safe}">
  ${pageCss()}
</style>
</head>
<body class="${place}">
${body}
<script nonce="${safe}">
${script}
</script>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] ?? character);
}
