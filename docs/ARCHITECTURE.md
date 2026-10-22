# Architecture

The extension is a thin TypeScript client over the [saw](https://saw-docs.ndevuspace.com/) CLI.
saw does all detection. The extension decides when to run saw, reads what saw reports, and shows
it in the editor.

## Layout

```text
src/
  extension.ts          composition root: builds the parts below and registers commands
  cursorHook.ts         Cursor's beforeShellExecution hook, bundled as dist/cursor-hook.js
  editor/               VS Code adapters
    controller          scan a folder on request, hand the outcome to the views
    triggers            save, checkout/pull (.git/HEAD, ORIG_HEAD), file watchers, folder changes
    engine              find and version-check saw once per settings change; install it when missing
    installer           install progress, cross-window lock, failure notification, diagnostics
    actions             fix a folder, audit the machine, scan-on-clone hook status/install/repair
    reports             the saw-report: file system that serves reports to the Markdown preview
    model               folder and machine state; every view renders from it
    agentTool           the saw_folderVerdict language-model tool
    mcp                 offers `saw mcp` to the editor's agents
    cursorGuard         in Cursor, registers the hook's plugin and writes each folder's verdict for it
    changes             opens a fix's clean-up as a diff through the Git extension
    diagnostics · statusBar · tree · alerts · settings · present
  core/                 no `vscode` import (lint-enforced), unit-tested
    locate              saw candidates: the setting alone, else PATH (absolute entries), ~/.local/bin
    python · install    find Python 3.11+, then pipx (bootstrapped if missing) → stayawakebot==<pin>
    diagnose            a failed install → its cause and fix, per OS and distribution
    run                 start a program without a shell, from a neutral cwd, with timeout and cancel
    capabilities        `saw capabilities --json` → the features and schemas this saw has
    scan                `saw scan <folder> --json --no-stream [--config]` → outcome
    contract            validate the scan report (unknown fields ignored, unknown values refused)
    verdict             report + exit status → clean | residue | suspicious | incomplete | infected
    actions             read what `fix`, `audit` and `hook` reported
    progress            `--progress=jsonl` events on stderr → the current step
    schedule            one run per folder, debounced, with exactly one follow-up
    reports · markdown  reports as Markdown, with scanned text kept literal
    agent · mcp         what agents are told, and how to start saw's MCP server
    guard               which commands the hook checks, and its answer for each verdict
    text · docs         plain-text rendering of scanned bytes; links to saw's documentation
```

## How a scan flows

1. A **trigger** (startup, a save, a change to a file that can run code, a checkout or pull) asks
   the **controller** to scan a workspace folder.
2. The **schedule** debounces requests and runs one scan per folder at a time, with at most one
   follow-up queued behind it.
3. The **engine** resolves saw to an absolute path, installing it first when it is missing.
4. **scan** runs `saw scan <folder> --json` without a shell. **contract** validates the JSON, and
   **verdict** combines it with the exit status. Anything that could not answer, such as a failed
   start, a timeout or unreadable output, is `incomplete`, never clean.
5. The outcome goes into the **model**. The status bar, the saw view, the Problems panel, alerts
   and reports all render from the model.

The whole folder is always scanned, because saw judges a file by where it sits:
`.vscode/tasks.json` scanned alone reads clean, while the folder containing it reads infected.

## How an action runs

**Fix…**, **Audit This Machine** and the hook commands run saw in the background behind a
cancellable progress notification. saw's output is collected as it arrives, and the action's
report follows it live. When saw finishes, **actions** reads its result: the JSON where saw writes
it, otherwise its exit status and its own words. A fix ends with a rescan of the folder.

Installing saw never asks, because it changes nothing the operator owns. Fixing always asks: it
deletes files from the checkout, so it runs only from an explicit **Fix…** and a modal that says
what will change. The extension never passes `--pr`, so nothing is pushed or published.

## Finding and installing saw

The engine uses, in order:

1. the `saw.path` setting, when set, and nothing else;
2. a `saw` on `PATH` or in `~/.local/bin` that is new enough (`saw.exe` on Windows);
3. otherwise it installs saw: pipx on `PATH`, in `~/.local/bin` or as `python -m pipx`. If none
   exists, a temporary venv installs a permanent pipx and is then deleted. Then
   `pipx install --python <base python> --pip-args=--only-binary=:all: stayawakebot==<pin>` runs.

This works without administrator rights on every platform, including PEP 668 systems that refuse
`pip install --user`. Only wheels are installed, so no package's build script runs.

- **Pinned:** the release installed is pinned in `package.json` (`"saw"`). A saw the extension
  installed is moved to the pin when it falls behind; one the operator installed is left alone.
- **One install at a time:** a lock directory in global storage keeps two windows from installing
  at once.
- **Terminals:** integrated terminals get saw's folder on `PATH` through the extension's
  environment collection, rather than by editing shell profiles.
- **Remote windows:** with `extensionKind: workspace`, the extension runs where the files are. A
  remote folder is scanned, fixed and audited by the saw installed on the remote.

## Reading saw's output

When the engine finds saw, it runs `saw capabilities --json` once. Each feature the extension uses
beyond plain scanning is read only when saw lists it in a schema the extension knows:

- `audit --json`, `hook … --json` and the fuller `fix --json` record;
- `--progress=jsonl`;
- `saw mcp`.

Otherwise the extension reads the output every supported saw has. A document in a newer
`schema_version` than the extension knows is refused with "update the extension", never misread.

| Command | Read from | Fallback |
| --- | --- | --- |
| `scan` | the JSON report on stdout, with the exit status | none: an unreadable report is `incomplete` |
| `fix` | the JSON record on stdout; saw's report on stderr | — |
| `audit` | the JSON when available; the more alarming of it and the exit status wins | the exit status (3 unsafe to rotate, 2 incomplete) and saw's own "Rotation safety:" sentence |
| `hook` | the status JSON, also printed by install and repair | the first line of `hook status` and its ⚠ lines; anything else is unknown, never installed |

Progress events are requested only where saw's human report is not shown, because saw keeps that
report off stderr while they are on. An open scan or audit report shows the step saw is on. A
verdict never comes from progress.

## Security boundaries

- **Nothing from the workspace chooses what runs.** saw is resolved to an absolute path from user
  settings, `PATH` or known install locations, and started without a shell from a neutral
  directory. Every setting is machine-scoped, and the ones that choose what runs are listed in
  `restrictedConfigurations`.
- **Restricted Mode is supported**, including for Fix, because an infected folder is exactly the
  one not to trust. saw, not the workspace, runs git: it uses an empty hooks folder,
  `core.fsmonitor` off, no external diff, pager or editor, and no transport protocols.
- **Scanned text stays literal.** File names, descriptions, evidence and saw's output can come from
  whoever wrote the scanned folder. They reach Markdown only as code spans, fenced blocks or fully
  escaped text, so they cannot form a link, an image or HTML. The only links are to plain https
  pages.
- **Reports live in the extension's own storage, never in the project.** Folder reports go in
  workspace storage, keyed by a hash of the folder; machine reports (audit, hooks) go in global
  storage. A cloned repository cannot plant or fake a report. The kept copies withhold evidence;
  the preview shows it from memory.
- **Agents get the verdict, not the evidence.** `saw_folderVerdict` answers from the model after
  any due scan has run, and fails closed: with no current answer, it says stop. It leaves out
  evidence and flattens file names, so a scanned file cannot put text into an agent's prompt. It is
  read-only and cannot start `fix`, `audit` or `hook`.
- **saw serves MCP, not the extension.** When saw lists `mcp`, the extension tells the editor how to
  start `saw mcp` with the saw it uses. Cursor gets it through `vscode.cursor.mcp.registerServer`,
  and VS Code 1.101 and later through an MCP server definition provider. Both APIs are detected at
  run time.
- **Cursor's agent asks saw before it runs a folder's code.** Cursor's agent cannot call
  `saw_folderVerdict`, so in Cursor the extension registers a plugin directory in its global storage
  with `vscode.cursor.plugins` (`addPlugin` in Cursor 3.26, `registerPath` as documented). Its `beforeShellExecution` hook matches commands that
  install or run a folder's code, and the extension writes each folder's latest finished verdict
  there, one file per folder and window, removed when the window closes. The hook, the extension's
  own script run by the editor's binary as Node, answers from the newest record: refuse when
  infected, ask the person when suspicious, incomplete or unknown, allow otherwise. If it cannot
  read its input or records, it asks. It is not registered on Windows or in remote windows, where
  Cursor does not document how hooks run.
- **A notification never holds up a scan.** Alerts are not awaited, so an unanswered notification
  cannot queue later scans behind it.
