# Changelog

## [Unreleased]

## [0.3.0] - 2026-10-22

### Added

- When saw can ask during a fix, the **Decide** view offers the choice and a diff opens beside it.
  Keep is the focused action. Closing the diff does not answer, and stopping the fix does not
  answer. **Show the Decision** opens it again. The fix report lists what you decided. A saw that
  does not announce this stays as it was: the fix finishes, and anything left open stays in the
  report.

## [0.2.0] - 2026-10-22

### Added

- An open scan or audit report names the step saw is on, such as `reading git history (2/6)`, and
  updates as saw moves on. An audit report also shows the check saw names for a finding, and how to
  deal with a probe it could not read.
- In Cursor, the agent checks saw's verdict before it runs a command that installs or runs a
  folder's code, such as `npm install`, `make` or `./script.sh`. In a folder saw found infected the
  command is refused and the agent is told why; when saw found it suspicious or could not check it,
  Cursor asks you first. Turn it off with `saw.guardAgentCommands`.
- **saw: Open saw Documentation**, also in the saw view's title bar, opens
  [saw's documentation](https://saw-docs.ndevuspace.com/). Each report ends with a link to the page
  that explains it, and the saw view links to what each verdict means.

### Changed

- Installs stayawakebot 0.14.0, and moves a saw it installed earlier up to it.
- On Windows the extension finds and installs saw, the same as on Linux and macOS.
- The README is a user guide: what each feature does, the verdicts, commands, settings, remote
  windows, privacy, and troubleshooting, with screenshots and links to saw's documentation.

## [0.1.1] - 2026-10-20

### Changed

- The extension is now `Ndevu12.stayawakebot`, after saw's PyPI package, because the Visual
  Studio Marketplace already has an extension named `saw`. Its commands, settings and the `saw`
  program are unchanged. `Ndevu12.saw` 0.1.0 on Open VSX is the same extension under the old name.

## [0.1.0] - 2026-10-20

### Added

- Scans every workspace folder with `saw scan` on startup, on save, and when a file that can run
  code changes on disk; also on demand with **saw: Scan Workspace**.
- Findings in the Problems panel, a verdict per folder in the status bar and the saw view.
- Works in Restricted Mode, and warns before you trust a folder saw found infected.
- Finds `saw` on `PATH` or in `~/.local/bin` and checks its version. When it is missing or too old,
  installs it with pipx without asking, installing pipx first if needed; a failed install says why
  and what to run, with **Retry** and **Copy Diagnostics**. **saw: Install or Repair saw** and the
  `saw.autoInstall` setting.
- On Windows, where saw does not run yet, says so and points to WSL instead of installing it. The
  README explains remote windows, and setting up WSL step by step.
- **Fix…** on an infected folder runs `saw fix` after you confirm, in Restricted Mode too, shows
  its report in an editor tab and scans the folder again. Nothing is pushed.
- **saw: Audit This Machine** runs `saw audit` and repeats its verdict on whether changing
  credentials is safe; the saw view keeps the last one.
- The saw view shows whether saw's scan-on-clone git hooks are in place, and installs or repairs
  them.
- Scans again after a checkout, pull, merge or rebase.
- Asks saw what it can do (`saw capabilities --json`) and uses the structured output of a saw that
  has it: the audit's findings, the items to confirm first and what it could not read; each hook
  problem with what repairs it; and, after **Fix…**, the clean-up branch, what was removed, and a
  warning when uncommitted work could not be saved on a branch. **Open Changes** opens the
  clean-up as one diff against the branch it started from, and a partial clean-up says so. An older saw is read as before, and
  a report in a newer schema than the extension reads says to update the extension.
- With a saw that reports its progress (`--progress=jsonl`), the status bar, the saw view and the
  audit's notification show which step saw is on, and how many remain.
- Offers saw's own read-only MCP server (`saw mcp`) to agents when the installed saw has it: in
  Cursor through its MCP API, in VS Code 1.101 and later as an MCP server. The
  `saw.registerMcpServer` setting turns it off.
- Installs stayawakebot 0.13.1, and moves a saw it installed earlier up to it.
- A read-only `saw_folderVerdict` tool for AI agents in the editor: the folder's verdict from a scan
  of the latest changes, with the instruction to stop and ask you unless it is clean or residue.
- Reports you can read in an editor tab: **Open Report** shows a folder's scan, and Fix, Audit and
  the hook commands open theirs, following saw as it works, instead of a terminal. They are kept in
  the extension's own storage, never in the project, and the kept copies withhold evidence.

### Fixed

- A notification left open no longer holds up the next scan of its folder.
- The **Fix…** confirmation no longer promises that uncommitted work is saved on a branch: saw
  tries, and the confirmation warns when git has no name and email for the folder, so it cannot.
- The log of a successful install no longer shows the expected "no pipx yet" check as a warning,
  or a step twice.

[Unreleased]: https://github.com/Ndevu12/saw_ide_extension/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/Ndevu12/saw_ide_extension/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/Ndevu12/saw_ide_extension/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/Ndevu12/saw_ide_extension/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/Ndevu12/saw_ide_extension/releases/tag/v0.1.0
