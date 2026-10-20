// Drives the VS Code window open in headless Chromium through the DevTools protocol, the way a
// person would: the command palette, and the buttons of a dialog.

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const KEYS = {
  F1: { key: "F1", code: "F1", windowsVirtualKeyCode: 112 },
  Enter: { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" },
};

export class Workbench {
  #socket;
  #next = 1;
  #pending = new Map();

  static async connect(debuggingPort) {
    const pages = await (await fetch(`http://127.0.0.1:${debuggingPort}/json`)).json();
    const page = pages.find((target) => target.type === "page");
    if (!page) {
      throw new Error("the browser has no page open");
    }
    const workbench = new Workbench();
    workbench.#socket = new WebSocket(page.webSocketDebuggerUrl);
    workbench.#socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      const pending = workbench.#pending.get(message.id);
      if (pending) {
        workbench.#pending.delete(message.id);
        if (message.error) {
          pending.reject(new Error(message.error.message));
        } else {
          pending.resolve(message.result);
        }
      }
    });
    await new Promise((resolve, reject) => {
      workbench.#socket.addEventListener("open", resolve, { once: true });
      workbench.#socket.addEventListener("error", reject, { once: true });
    });
    return workbench;
  }

  #send(method, params = {}) {
    const id = this.#next++;
    this.#socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.#pending.set(id, { resolve, reject }));
  }

  async #press(name) {
    const key = KEYS[name];
    await this.#send("Input.dispatchKeyEvent", { type: "keyDown", ...key });
    await this.#send("Input.dispatchKeyEvent", { type: "keyUp", ...key });
  }

  /** Evaluates an expression in the page and returns its value. */
  async evaluate(expression) {
    const { result } = await this.#send("Runtime.evaluate", { expression, returnByValue: true });
    return result.value;
  }

  async #until(expression, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await this.evaluate(expression)) {
        return true;
      }
      await sleep(250);
    }
    return false;
  }

  /**
   * Runs a command by its title in the command palette, as typed by a person. Enter is pressed only
   * once the highlighted entry is that command, so a slow palette never runs another one.
   */
  async run(title, timeoutMs = 20_000) {
    // A report open in the Markdown preview keeps the keyboard inside its frame, where F1 is not seen.
    await this.evaluate(`document.activeElement?.blur()`);
    await this.#press("F1");
    if (!(await this.#until(`Boolean(document.activeElement?.closest(".quick-input-widget"))`, timeoutMs))) {
      throw new Error(`the command palette did not open for "${title}"`);
    }
    await this.#send("Input.insertText", { text: title });
    const highlighted = `document.querySelector(".quick-input-list .monaco-list-row.focused")?.textContent ?? ""`;
    if (!(await this.#until(`(${highlighted}).includes(${JSON.stringify(title)})`, timeoutMs))) {
      throw new Error(`the command palette did not offer "${title}"; it highlighted "${await this.evaluate(highlighted)}"`);
    }
    await this.#press("Enter");
  }

  /** Clicks the button labelled `label` in the open dialog once it shows; false if it never does. */
  /** The open dialog's message, once one shows; undefined if none does. */
  async dialog(timeoutMs = 30_000) {
    const message = `document.querySelector(".monaco-dialog-box")?.innerText.trim()`;
    return (await this.#until(`Boolean(${message})`, timeoutMs)) ? this.evaluate(message) : undefined;
  }

  click(label, timeoutMs = 30_000) {
    return this.#until(`(() => {
      const button = [...document.querySelectorAll(".monaco-dialog-box .monaco-button")]
        .find((b) => b.textContent.trim() === ${JSON.stringify(label)});
      button?.click();
      return Boolean(button);
    })()`, timeoutMs);
  }

  /** The window as a PNG. */
  async screenshot() {
    const { data } = await this.#send("Page.captureScreenshot", { format: "png" });
    return Buffer.from(data, "base64");
  }

  /** What a person would read in the window's dialogs and notifications, for a failure report. */
  visibleMessages() {
    return this.evaluate(`[...document.querySelectorAll(".monaco-dialog-box, .notification-list-item-message")]
      .map((e) => e.innerText.trim()).filter(Boolean)`);
  }

  close() {
    this.#socket.close();
  }
}
