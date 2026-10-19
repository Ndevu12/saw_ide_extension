# Architecture

A thin TypeScript client over the saw CLI. saw does all detection; the extension decides when to
scan, and shows what saw reported.

```text
extension.ts            composition root
editor/                 VS Code adapters
  controller            scan a folder on request, hand the outcome to the views
  triggers              save, file watchers, workspace folder changes
  engine                find and version-check saw once per settings change; install it when missing
  installer             progress, cross-window lock, failure notification, diagnostics report
  model                 folder states; every view renders from it
  diagnostics · statusBar · tree · alerts · settings · present
core/                   no `vscode` import (lint-enforced), unit-tested
  locate                saw candidates: setting alone, else PATH (absolute entries), ~/.local/bin, installed
  python                find Python 3.11+, as its base interpreter rather than a venv's copy
  install               pipx (bootstrapped if missing) → `pipx install stayawakebot==<pin>`
  diagnose              failed install → cause + fix, per OS and distribution
  run                   start a program without a shell, from a neutral cwd, with timeout/cancel
  scan                  `saw scan <folder> --json --no-stream [--config]` → outcome
  contract              validate the JSON report (unknown fields ignored, unknown values refused)
  verdict               report + exit status → clean | residue | suspicious | incomplete | infected
  schedule              one run per folder, debounced, with exactly one follow-up
  text                  plain-text rendering of bytes from scanned files
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
Wheels only: no package's build script runs. Bumping the pin is its own pull request.

**One install per machine at a time.** A lock directory in the extension's global storage keeps two
windows from running pipx at once; the second waits and then uses what the first installed. Where
saw went is recorded there too, and integrated terminals get that folder on `PATH` through the
extension's environment collection, rather than by editing shell profiles.

**`extensionKind: workspace`.** The extension runs where the files are, so remote folders are
scanned by the saw installed on the remote.

## Next

- `saw fix` from the editor, in a trusted workspace, after confirmation.
- Scan-on-clone hook status and `saw audit` results in the saw view.
- From saw: line numbers on more findings, a `schema_version` in the report, a long-running mode,
  and an MCP server so agents in VS Code and Cursor can ask for a verdict.
