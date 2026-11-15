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

/** The page around those buttons: black ground, mint wordmark, green edges. */
export function pageCss(): string {
  return `
    body { margin: 0; padding: 14px; background: ${BLACK}; color: ${INK}; font-family: var(--vscode-font-family, system-ui, sans-serif); font-size: var(--vscode-font-size, 13px); }
    .mark { margin: 0 0 16px; }
    .word { margin: 0; color: ${MINT}; font-weight: 750; letter-spacing: 0.04em; }
    .tag { margin: 2px 0 0; color: ${DIM}; font-style: italic; }
    .thread { display: flex; flex-direction: column; gap: 14px; }
    .who { font-size: 11px; font-weight: 750; letter-spacing: 0.14em; text-transform: uppercase; color: ${MINT}; margin: 0 0 6px; }
    .card { border: 1px solid ${EDGE}; border-radius: 8px; padding: 12px 14px; background: ${CARD}; }
    .card.ok { border-color: ${GREEN}; }
    .card.warn { border-color: ${CYAN}; }
    .card.bad { border-color: #e06a6a; }
    .head { display: flex; flex-direction: column; align-items: flex-start; gap: 6px; margin-bottom: 10px; }
    .badge { display: inline-block; font-size: 11px; font-weight: 750; letter-spacing: 0.08em; text-transform: uppercase; padding: 3px 8px; border-radius: 4px; background: #10281c; color: ${MINT}; border: 1px solid ${GREEN}; }
    .title { margin: 0; font-size: 15px; font-weight: 650; color: ${WHITE}; line-height: 1.3; overflow-wrap: anywhere; }
    p { margin: 0 0 8px; line-height: 1.45; }
    .rows { display: flex; flex-direction: column; gap: 8px; margin-bottom: 10px; }
    .rows button { justify-content: flex-start; text-align: left; font-weight: 550; background: #101816; border-color: #245c40; color: ${INK}; white-space: normal; }
    .rows button:hover { background: #163028; border-color: ${MINT}; }
    .actions { display: flex; flex-direction: column; gap: 8px; }
    .hint, .meta { color: ${DIM}; }
    ul { padding-left: 1.2em; }
    li { margin: 6px 0; }
    input[type=checkbox] { accent-color: ${GREEN}; width: 1rem; height: 1rem; margin-top: 2px; }
    label { display: flex; gap: 8px; align-items: flex-start; }
    body.editor .actions { flex-direction: row; flex-wrap: wrap; }
    body.editor .actions button { width: auto; min-width: 11rem; }
    ${buttonCss()}
    ${chatCss()}
  `;
}

/** Chat: a verdict reads first, findings read as a list, and only the next step is a full button. */
function chatCss(): string {
  return `
    .thread .card { border-left-width: 3px; padding: 12px 12px 12px 13px; }
    body.editor .thread, body.editor .mark { max-width: 760px; margin-left: auto; margin-right: auto; }
    .card.neutral { border-left-color: ${EDGE}; }
    .card.ok { border-color: ${EDGE}; border-left-color: ${GREEN}; }
    .card.warn { border-color: ${EDGE}; border-left-color: ${AMBER}; }
    .card.bad { border-color: #4a1e22; border-left-color: ${RED}; }
    .thread .head { flex-direction: row; align-items: center; flex-wrap: wrap; gap: 8px; margin-bottom: 6px; }
    .card.neutral .badge { color: ${DIM}; border-color: #2a3340; background: #0f1418; }
    .card.ok .badge { color: ${MINT}; border-color: ${GREEN}; background: #10281c; }
    .card.warn .badge { color: ${AMBER}; border-color: ${AMBER}; background: #2a2210; }
    .card.bad .badge { color: #ffd6d6; border-color: ${RED}; background: #3a1518; }
    .live { display: flex; align-items: center; gap: 8px; color: ${CYAN}; font-size: 12px; margin: 0 0 8px; }
    .spin { flex: none; width: 10px; height: 10px; border-radius: 50%; border: 2px solid #1d4a4e; border-top-color: ${CYAN}; animation: spin 0.9s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
    @media (prefers-reduced-motion: reduce) { .spin { animation: none; } }
    .summary { color: ${WHITE}; font-weight: 600; margin: 4px 0 8px; }
    .notice { margin: 0 0 8px; padding: 7px 10px; border-radius: 4px; border-left: 2px solid ${DIM}; background: #0f1513; line-height: 1.4; }
    .notice.warn { border-left-color: ${AMBER}; background: #1d1a0e; }
    .notice.bad { border-left-color: ${RED}; background: #241012; }
    .notice.ok { border-left-color: ${GREEN}; }
    .hint { font-size: 12px; line-height: 1.45; }
    .findings { list-style: none; margin: 4px 0 8px; padding: 0; display: flex; flex-direction: column; }
    .findings li { margin: 0; padding: 8px 0; border-top: 1px solid #16251f; }
    .findings li:first-child { border-top: none; padding-top: 2px; }
    .what { display: flex; gap: 8px; align-items: baseline; line-height: 1.4; }
    .sev { flex: none; font-size: 10px; font-weight: 750; letter-spacing: 0.06em; text-transform: uppercase; padding: 1px 5px; border-radius: 3px; border: 1px solid ${DIM}; color: ${DIM}; }
    .sev.critical { background: ${RED}; border-color: ${RED}; color: #1a0506; }
    .sev.high { border-color: ${RED}; color: ${RED}; }
    .sev.medium { border-color: ${AMBER}; color: ${AMBER}; }
    .count { color: ${DIM}; font-size: 12px; white-space: nowrap; }
    .places { display: flex; flex-wrap: wrap; gap: 4px; margin: 6px 0 0; padding-left: 0; }
    .places button { width: auto; min-height: 0; padding: 2px 7px; border-radius: 4px; font-family: var(--vscode-editor-font-family, monospace); font-size: 11.5px; font-weight: 500; background: #0f1916; border: 1px solid #1f3a2e; color: ${INK}; box-shadow: none; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; display: inline-block; }
    .places button:hover { border-color: ${MINT}; color: ${WHITE}; background: #133024; }
    .places button.more { font-family: inherit; color: ${DIM}; }
    .items { margin: 2px 0 8px; }
    .item { display: grid; grid-template-columns: minmax(0, 1fr) auto; column-gap: 10px; align-items: center; padding: 8px 0; border-top: 1px solid #16251f; }
    .item:first-child { border-top: none; padding-top: 2px; }
    .item .name, .item .state { grid-column: 1; }
    .item .name { font-size: 10.5px; font-weight: 750; letter-spacing: 0.1em; text-transform: uppercase; color: ${DIM}; }
    .item .state { display: flex; gap: 7px; align-items: baseline; line-height: 1.4; color: ${INK}; }
    .dot { flex: none; width: 7px; height: 7px; border-radius: 50%; background: ${DIM}; transform: translateY(-1px); }
    .dot.ok { background: ${GREEN}; }
    .dot.warn { background: ${AMBER}; }
    .dot.bad { background: ${RED}; }
    .item button { grid-column: 2; grid-row: 1 / span 2; width: auto; min-height: 26px; padding: 3px 10px; font-size: 12px; }
    .item button.secondary { background: transparent; border-color: #23463a; color: ${INK}; box-shadow: none; }
    .item button.secondary:hover { background: #12241d; border-color: ${MINT}; color: ${WHITE}; }
    .main { display: flex; flex-direction: column; gap: 6px; margin-top: 10px; }
    .main button.danger { background: #c93c44; border-color: ${RED}; color: #fff5f5; }
    .main button.danger:hover { background: #dc4a52; }
    .links { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
    .links button { width: auto; min-height: 26px; padding: 3px 10px; font-size: 12px; font-weight: 600; background: transparent; border-color: #23463a; color: ${INK}; box-shadow: none; }
    .links button:hover { background: #12241d; border-color: ${MINT}; color: ${WHITE}; }
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
