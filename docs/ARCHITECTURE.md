# Architecture

A thin TypeScript client over the saw CLI. saw does all detection; the extension decides when to
scan, and shows what saw reported.

```text
extension.ts            composition root
editor/                 VS Code adapters
  controller            scan a folder on request, hand the outcome to the views
  actions               fix a folder, audit the machine, scan-on-clone hook status/install/repair
  reports               saw-report: documents in the Markdown preview; copies in extension storage
  triggers              save, checkout/pull (.git/HEAD, ORIG_HEAD), file watchers, folder changes
  engine                find and version-check saw once per settings change; install it when missing
  installer             progress, cross-window lock, failure notification, diagnostics report
  model                 folder states; every view renders from it
  agentTool             saw_folderVerdict language-model tool: waits for a current scan, read-only
  diagnostics · statusBar · tree · alerts · settings · present
core/                   no `vscode` import (lint-enforced), unit-tested
  locate                saw candidates: setting alone, else PATH (absolute entries), ~/.local/bin, installed
  python                find Python 3.11+, as its base interpreter rather than a venv's copy
  install               pipx (bootstrapped if missing) → `pipx install stayawakebot==<pin>`
  diagnose              failed install → cause + fix, per OS and distribution
  run                   start a program without a shell, from a neutral cwd, with timeout/cancel
  scan                  `saw scan <folder> --json --no-stream [--config]` → outcome
  actions               `saw fix --json`, `saw audit`, `saw hook status` → what each said
  contract              validate the JSON report (unknown fields ignored, unknown values refused)
  verdict               report + exit status → clean | residue | suspicious | incomplete | infected
  schedule              one run per folder, debounced, with exactly one follow-up
  text                  plain-text rendering of bytes from scanned files
  agent                 the verdict as told to an AI agent, with the instruction to stop; no evidence
  markdown              Markdown that keeps scanned text literal: code spans, blocks, https links
  reports               scan, fix, audit and hook reports, with or without evidence
```

## Decisions

**One `.vsix`, two registries.** VS Code installs from the Visual Studio Marketplace; Cursor,
Antigravity, Devin Desktop and VSCodium install from Open VSX. The release publishes the same file
to both.

**`engines.vscode: ^1.96.0`.** Forks run an older editor than upstream, and their galleries hide an
extension that requires a newer one. The integration tests run on 1.96.0 and on current stable.

**Spawn the CLI per scan.** A small repository scans in about 0.4 s, most of it Python start-up.
A long-running `saw` mode (or a language server) is the next step if that becomes the bottleneck;
`core/scan` is the only place that would change.

**Always scan the whole folder.** saw judges a file by where it sits: `.vscode/tasks.json` scanned
alone reads clean, the folder containing it reads infected.

**The verdict comes from the report.** saw exits clean on a suspicious result, and prints nothing on
stdout when it cannot start a scan, so the exit status alone is not a verdict.

**Restricted Mode is supported.** Scanning reads only. Every setting is machine-scoped, and the two
that choose what runs are also listed in `restrictedConfigurations`.

**The extension installs saw itself.** The install command is known, so asking the operator to run
it is a step they should not need. It is not prompted for; the operator hears only when it fails,
with the cause and the fix. The order follows what works without administrator rights on every
platform, including PEP 668 systems that refuse `pip install --user`:

1. a `saw` that is found and new enough is used as it is;
2. pipx on PATH, in `~/.local/bin`, or as `python -m pipx`;
3. otherwise pipx from a temporary venv installs a permanent pipx (`pipx install pipx`), then the
   venv is deleted;
4. `pipx install --force --python <base python> --pip-args=--only-binary=:all: stayawakebot==<pin>`.

**Installs are pinned.** `package.json` `"saw"` names the stayawakebot and pipx releases, and CI runs
the contract tests against that stayawakebot. Installing whatever is newest would push a bad or
hijacked PyPI release onto every machine with the extension, and could break the report contract.
Wheels only: no package's build script runs. Bumping the pin is its own pull request, unless a
feature needs the newer release (0.13.0 for `fix --json`). A saw this extension installed is moved
to the pin when it falls behind; one the operator installed is left alone.

**One install per machine at a time.** A lock directory in the extension's global storage keeps two
windows from running pipx at once; the second waits and then uses what the first installed. Where
saw went is recorded there too, and integrated terminals get that folder on `PATH` through the
extension's environment collection, rather than by editing shell profiles.

**`extensionKind: workspace`.** The extension runs where the files are, so remote folders are
scanned by the saw installed on the remote.

**Installing never asks; fixing always does.** Installing saw changes nothing the operator owns.
`saw fix` deletes files from their checkout, so it runs only from an explicit **Fix…** and a modal
that says what it will change. It never takes `--pr`: publishing stays on the command line.

**Fix works in Restricted Mode.** An infected folder is exactly the one not to trust, so fixing
must not require trust. That is safe because saw, not the workspace, runs: saw starts git with an
empty hooks folder, `core.fsmonitor` off, no external diff, pager or editor, and no transport
protocols, so nothing the repository configures runs.

**Reports are documents the extension builds, not saw's terminal output.** saw stays focused on
detection; the extension turns its JSON (and, until `audit` and `hook` have JSON, its own words)
into Markdown and shows it in the editor's Markdown preview, through a read-only `saw-report:` file
system. Actions run in the background, without a shell, behind a progress notification that can
stop them, and their report follows saw as it works. With no TTY, `saw fix` asks nothing and leaves
what it is unsure of for review, which its report names.

**Scanned text stays literal in a report.** File names, descriptions, evidence and saw's own output
can come from whoever wrote the scanned folder. They reach Markdown only as code spans, fenced
blocks or fully escaped text, so they cannot make a link, an image (which would tell an attacker the
report was opened) or HTML. The only links are to plain https pages. Reports do not link to files:
the saw view and the Problems panel open a finding at its line.

**Reports are kept in the extension's own storage, never in the project.** Folder reports go in
workspace storage, keyed by a hash of the folder, and machine reports (audit, hooks) in global
storage, so nothing appears in `git status` and a cloned repository cannot plant or fake a report.
The kept copies withhold evidence, so storage never holds copies of malicious code; the preview
shows it from memory. A saved copy is shown, marked as such, only until this window has its own.

**What each action reports is read from the narrowest stable output.**
- `fix --json` (JSON on stdout, the report on stderr) for prepared, skipped or failed.
- `audit`'s exit status (3 unsafe to rotate, 2 incomplete) for how loudly to speak, and saw's own
  "Rotation safety:" sentence for what to say. Status 0 can still mean "safe once you confirm the
  items listed", so the extension never paraphrases it as "safe".
- `hook status`'s first line and its ⚠ lines. Anything else reads as unknown, never as installed.

**A notification never holds up a scan.** Alerts are shown without being awaited: a scan job that
waited for the operator to answer one would leave every later scan of that folder queued behind it.

**Two TypeScript compilers, for now.** `tsc` is TypeScript 7 (the `@typescript/native` alias),
which type-checks and builds the tests. TypeScript 7 has no JavaScript API yet, so `typescript`
is Microsoft's `@typescript/typescript6` package, which typescript-eslint reads. Drop the alias
once typescript-eslint supports TypeScript 7. `pnpm-workspace.yaml` likewise lifts mocha's
`diff` and `serialize-javascript` past their advisories until `@vscode/test-cli` moves to mocha 12.

**Agents get the verdict, not the evidence.** The `saw_folderVerdict` tool answers from the same
model as the views, after any scan that is due has run, and fails closed: no current answer reads
as "stop". It leaves out finding evidence and flattens file names, because both come from the
scanned folder and would otherwise put an attacker's text into the agent's prompt. It stays
read-only so an agent can never trigger `fix`, `audit` or `hook` on its own.

## Next

- From saw: `--json` for `audit` and `hook status`, line numbers on more findings, a
  `schema_version` in the report, a long-running mode, and an MCP server so agents in VS Code and
  Cursor can ask for a verdict.
- From saw: running on native Windows (it imports `pwd` at start-up).
