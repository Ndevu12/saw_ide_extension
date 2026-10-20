# Changelog

## [Unreleased]

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
  warning when uncommitted work could not be saved on a branch. An older saw is read as before, and
  a report in a newer schema than the extension reads says to update the extension.
- With a saw that reports its progress (`--progress=jsonl`), the status bar, the saw view and the
  audit's notification show which step saw is on, and how many remain.
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
