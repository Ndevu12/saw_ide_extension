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
    body { margin: 0; padding: 14px; background: ${BLACK}; color: ${INK}; font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); }
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
