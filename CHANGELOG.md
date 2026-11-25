# Changelog

## [Unreleased]

### Fixed

- In the editor's terminal, git aimed at an open folder was given the extension's empty hooks folder as `core.hooksPath`, and `git rev-parse --git-path hooks` reported it. A hook installer could put hooks there, and then every governed command in every open folder would run them. On Linux and macOS that path is now `/dev/null`, where nothing can be added. On Windows the folder is kept empty: anything found there, including a link or a file, is moved aside with a warning in the log. The folder an earlier version used is emptied the same way on every system, since a terminal opened before the update still uses it ([#88](https://github.com/Ndevu12/saw_ide_extension/issues/88)).

## [0.8.0] - 2026-11-18

### Added

- The extension installs saw 0.17.3. It no longer holds an update for a finding the changed file already had, leaves an update it cannot check to you, says how long a scan should take, and stops a scan in time.
- saw stays up to date without an extension release. A new saw release, checked against its signed `SHA256SUMS`, installs on its own 3 days after publishing, or at once for a security release; **Update Now** installs it sooner. The new saw must find a known infection before it replaces the current one, and **saw: Go Back to the Previous saw** undoes an update. A saw you installed yourself, or one `saw.path` names, is never changed. The new setting `saw.autoUpdate` (`auto`, `notify`, or `off`) controls this.
- With a saw that offers the choice (`govern.decision`), an update saw cannot check is yours to decide. saw says why it cannot check it, and you can run the command as you typed it or leave the folder as it is. The terminal asks with a yes/no question that defaults to no. The Git view's pull and sync ask in a dialog. If you run it, the folder is scanned straight after. If no one answers within two minutes, or no one can be asked, the folder is left as it is. `SAW_GOVERN_DECISION=run-as-typed` or `leave-unchanged` decides ahead, as for saw's own stand-in. With that saw, `git fetch` waits for saw's check again, because that saw checks a fetch properly.
- An update saw holds now says what it found and what to do, and is never a dead end. The terminal lists the strongest findings and next steps, the notification's **See What Was Found** opens **Held update details**, and Chat links to it. That tab shows the update's own findings, the command, and next steps for the verdict. The scan is of the files the update brings, not of the folder's history. You can still let the update in: answer yes in the terminal, or choose **Let In Anyway** when the Git view's dialog asks. For an infected update you type the folder's name. `SAW_GOVERN_DECISION` never lets a held update in. Once it is in, the folder is scanned and Chat says you let it in.
- A check that ran out of time, a saw that would not start, or an answer that could not be read now asks whether to run the command as typed, instead of holding the update for good.
- With saw 0.17.3, a scan shows how many files a folder holds, how far it has come, and about how long is left.
- With saw 0.17.3, a scan or update check that reaches `saw.scanTimeoutSeconds` is stopped by saw itself, which reports it unfinished. The extension stops saw only if it has not finished 15 seconds later.

### Fixed

- `git pull` in the editor's terminal works again. saw 0.17.2 and earlier cannot bring most updates in to check them, because the copy they are checked in has no remote, upstream, or git identity, so every pull was held as "the update did not finish cleanly" ([saw#1956](https://github.com/Ndevu12/stayAwakeBot/issues/1956)). With such a saw, when it answers that it could not bring an update in at all, the command now runs as typed, the folder is scanned straight after, and Chat says the change was not checked first. A suspicious, infected, or unfinished scan still holds the update. The same goes for every command saw checks: a rebase, a merge that makes a merge commit, a checkout or switch of a branch that is only on the remote, `gh repo sync`, and `gh pr checkout`.
- `git fetch` fetches again, from the terminal and from the Git view's sync and background fetch. saw 0.17.2 and earlier reported it clean but fetched nothing. With such a saw, a fetch now runs at once, and what it brings waits for saw when you merge or check it out. A fetch with `--update-head-ok`, which can move the checked-out branch, still waits.
- A scan that runs out of time no longer leaves a folder on **Scanning** for good. saw 0.17.2 and earlier leave their scan workers running when stopped, and those workers held the scan's output open, so the extension never saw it end ([saw#1958](https://github.com/Ndevu12/stayAwakeBot/issues/1958)). On Linux and macOS, stopping saw now stops everything it started, and is followed by a forced stop 3 seconds later. A run counts as finished once saw itself has exited, whatever it left behind.
- `PYTHONPATH`, `PYTHONHOME` and `PYTHONSTARTUP` in the editor's environment no longer reach saw, so saw always runs its own installed code.
- Pressing Ctrl-C while saw checks an update in the terminal stops the check and leaves the folder as it was. Once saw has started writing a checked update into the folder, Ctrl-C waits for it to finish.

## [0.7.0] - 2026-11-16

### Added

- The extension installs saw 0.17.1, whose answers to AI agents name the saw release that gave them.
- When the saw release this extension installs has no ready-built package for this machine, the notification names the machine (for example Linux x86_64, macOS on Apple silicon, or Windows on Arm) and the platforms that release has a package for. It also says when the release is not on PyPI, when the Linux glibc is older than the package needs, and when a dependency has no package here. **Report It** opens an issue on the right repository, with the machine and versions filled in. Such a release is tried again after a day, or at once with **saw: Install or Repair saw**.

### Changed

- The extension is licensed under Apache-2.0, as saw is. It was BSD-3-Clause. The package carries the license and a NOTICE file.
- The screens use plain words instead of saw's own terms. **See results** opens a folder's **Scan results** tab, and **Full details** is the longer document with the evidence. **Choose what to keep** opens the **Your choice** tab. A residue result reads **traces left**. This machine's rows are **Before you change passwords**, **Check repos on clone and pull**, and **Background checks**. "saw didn't check this version before it arrived" replaces "not a commit saw let in". The commands carry the same names.
- The two fixes are separate commands, named for what they fix. **Fix infection in files** runs `saw fix`: it removes what saw confirmed from the files, puts the fix on a local branch, and pushes nothing. **Fix infection in git history** runs `saw fix amend`, which the editor can now start: it rewrites the past commits that hold the infection and force-pushes their branches, after a confirmation that lists what it changes and needs, and after you type the folder's name. Each has its own button, its own details, and its own line while it runs. The Scan results tab shows both under **Fix the infection**, with each command and where it stands. Once the files fix leaves the infection in past commits, the card says so and its main button becomes the git history fix. The Your choice tab names the fix that asked.
- Chat only steers. Each folder is one card: its status, one line of counts, the one notice that matters most, a single main button for the next step, and up to three links. The main button is Fix infection in files for an infected folder, Fix infection in git history once past commits still hold it, Choose what to keep while a fix waits, See what was found for a suspicious or could-not-scan folder, and Scan this folder before the first scan. A running scan or check is one line, without the folder's path.
- Each folder's scan results open in their own editor tab. The tab has the status, the path, the counts, the two fixes, the full notices, why saw says this, and everything it found. Findings of one kind are one line with their severity, a count, and the places, which open the file. The tab keeps its place while saw redraws it.
- The machine is three short rows. A row opens its details. A row has a button only when it needs you, such as Repair or Check.
- Chat ends with **All details** and **What these results mean**. Its sentences no longer repeat saw's name.
- The infected and could-not-scan alerts offer **See What Was Found**, which opens the Scan results tab.
- Every details document opens in a tab of its own, named for what it is, such as **Full details · payments-api** or **Git history fix details · payments-api**, in the same colors as Scan results. It no longer opens as a Markdown preview, so the tab does not say Preview or end in .md. It updates live while saw works, and a link opens in the browser.
- The saw sidebar is Chat alone. The Verdict list and the Decide pane are gone from it: the Scan results tab and the Your choice tab beside the change hold what they showed. When an older saw than the pinned release is scanning, Chat shows it as a card with **Install or Repair saw**, and each folder's Scan results tab says so.

### Fixed

- saw installs on Linux again. saw 0.17.1 has ready-built packages for Linux x86_64 and arm64, which 0.17.0 did not. Windows still has none in 0.17.1, so a Windows machine keeps the saw it has, and the notification names the platforms the release has.
- When `gh` runs through saw's own stand-in and no real git is left, saw's stand-in no longer finds this extension's `git` on PATH and runs it once more.
- The notification for a failed install of saw is no longer lost when a scan starts while the installed saw is being listed again.
- A `git pull`, `fetch`, `merge`, `rebase`, `checkout` or `switch` aimed at an open folder with `--git-dir`, `--work-tree`, `GIT_DIR` or `GIT_WORK_TREE` from outside it now waits for saw, as one run inside the folder does.
- A git alias for one of those commands, given with `-c alias.<name>=…` or set in git's configuration, is checked as the command it runs. A shell alias (`!…`) is left as it is, since the git it starts comes back through the stand-in.
- A clone into an open folder runs, since saw cannot hold a folder that does not exist yet. Whenever files land, even from a clone that fails partway, the folder is scanned at once and the editor says saw did not check the clone before it landed.
- `git checkout -m <branch>` and `git switch -m <branch>` now wait for saw. `-m` takes no value, and it was taken to swallow the branch name.
- When saw's own stand-in cannot start, an update into an open folder waits for this extension's saw check. Before, git ran it without a check.
- On Windows, the log no longer says a pull from the Git view waits for saw. Only the editor's terminal does there.
- `git` and `gh` run again in the editor's terminal. The package now carries saw's git stand-in, which every release since 0.4.0 left out, so each command stopped with `Cannot find module …/dist/govern-shim.js`. If the stand-in's script is ever missing, the command runs the real program and says saw did not check it.
- The stand-in runs git from its full path. A bare `git` led back to the stand-in. The stand-in also checks the git and gh it was given before it runs one: a bare name, or a path that leads to its own folder through a symlink or another spelling, is replaced by the real program on PATH, or not run at all, and the terminal says which. Every stand-in carries a mark, so another editor's stand-in, or a copy of one, is never taken for the real git. When no real program is left, nothing runs, not even saw's own stand-in.
- When saw cannot be moved up to the release this extension installs, the saw already installed keeps scanning, and the notification says so. Before, saw stopped until the install worked, and the notification said no folder is scanned. While the older saw runs, the status bar names it, for example `saw 0.16.0: clean`, and its tooltip says which release could not be installed and that a folder shown as clean may still hold what that release finds. Chat, each folder's Scan results tab, the details tabs, and the answer an AI agent gets say the same. The notification is shown once it is known whether an older saw is still there.

## [0.6.1] - 2026-11-13

### Changed

- The extension icon is the SAW wordmark from the site header, painted from the same letter grid as `saw`.

## [0.6.0] - 2026-11-05

### Added

- **Open verdict** opens the Chat session in an editor tab, and **Open the decision** opens Decide in an editor tab beside the diff. Chat keeps the buttons. The pages use the colors `saw intro` prints, and every control is a button.
- **Open Watch Report** reads what `saw watch status` says: whether the watcher is in place, what is still open, and what happened since the last report. Chat and the saw view open the same report.
- Opening a folder asks once whether saw let that commit in, before the window is asked to reload. While that runs, saw says it is checking, and the folder has not changed. A commit saw did not let in is put back when saw can. A folder that stays, and was not put back, is described as not a commit saw let in.

### Changed

- Git aimed at an open folder does not run that folder's fsmonitor, external diff, hooks, or a filter whose command is not `git-lfs`. While a folder is not in the clear, extension recommendations stay quiet and task detection stays off.
- Installs stayawakebot 0.17.0, and moves a saw it installed earlier up to it. A scan from this release names a project it found and the lockfile to commit, so saw can audit its dependencies. A Dart, Rust, .NET or Gradle project with no lockfile was silent before.
- The Marketplace and Open VSX pages carry the screenshots, the documentation and license badges, and saw's black page banner. Questions go to the repository issues.

## [0.5.0] - 2026-11-04

### Added

- While saw checks an incoming update, the status bar, the saw view, and Chat say saw is checking it, including the step saw names. The folder is unchanged until that check finishes. When the installed saw includes its git and gh stand-in, the editor places that and a bringing-files command is checked by saw. A git command saw did not run still changes the folder first; Chat says that change was not held.
- When saw already covers your terminals, the editor's terminal uses that and does not check the same command again. The Git view still checks on its own.
- When saw can say whether it let the current tree in, Chat names a change only when saw did not. A check that runs outside this window shows the same checking, applied, or held as one the editor started.
- When saw can put a folder back, a commit it did not let in is put back by saw and your unsaved work stays. A change to the files on a commit saw already let in is not put back. An agent that asks saw about a folder is told the same checking, held, or not-held state, and waits while a check is running.
- After saw holds an update, or after three checks of a folder come back with nothing saw knows, Chat asks for a rating. Rate, Star, Report a problem, and Request a feature are on that card. Not now hides it for this version. **Share feedback** opens it any time.

### Changed

- Installs stayawakebot 0.16.0, and moves a saw it installed earlier up to it. This is the saw release that checks an update before it reaches the folder, including from a terminal.

## [0.4.0] - 2026-11-04

### Added

- The saw sidebar opens on a Chat view. Each folder is a card with its verdict and buttons for the next action. Fixing the checkout and amending history are described apart: the checkout fix puts the clean-up on a new local branch and does not rewrite past commits or push, and amending history rewrites the commits that still carry the malicious code. A scan only reads the folder. When a fix is waiting, the card says which of those acts the question belongs to.
- When the installed saw can check an incoming update, a pull, checkout, or similar command in an open folder waits for that check. The folder changes only when the update is clean or residue. Otherwise it stays as it was, and saw says why. The open folder is scanned again after the check finishes. Turn it off with `saw.governUpdates`.

## [0.3.0] - 2026-10-22

### Added

- During a fix, the **Decide** view offers the choice and a diff opens beside it. Keep is the
  focused action. Closing the diff does not answer, and stopping the fix does not answer.
  **Show the Decision** opens it again. The fix report lists what you decided.

### Changed

- Installs stayawakebot 0.15.0, and moves a saw it installed earlier up to it. This is the saw
  release that asks those questions.

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

[Unreleased]: https://github.com/Ndevu12/saw_ide_extension/compare/v0.8.0...HEAD
[0.8.0]: https://github.com/Ndevu12/saw_ide_extension/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/Ndevu12/saw_ide_extension/compare/v0.6.1...v0.7.0
[0.6.1]: https://github.com/Ndevu12/saw_ide_extension/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/Ndevu12/saw_ide_extension/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/Ndevu12/saw_ide_extension/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/Ndevu12/saw_ide_extension/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/Ndevu12/saw_ide_extension/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/Ndevu12/saw_ide_extension/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/Ndevu12/saw_ide_extension/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/Ndevu12/saw_ide_extension/releases/tag/v0.1.0
