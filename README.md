# StayAwakeBot (saw) for VS Code-compatible editors

The [saw](https://saw-docs.ndevuspace.com/) verdict for every folder you open, in VS Code, Cursor,
Antigravity, Devin Desktop (formerly Windsurf) and VSCodium.

saw hunts supply-chain worms: obfuscated loaders, editor tasks that run when a folder opens, poisoned
lockfiles and installed packages, and git hooks that run on checkout. This extension runs `saw scan`
on each workspace folder and shows what it finds:

- **Before you trust a folder.** Scanning only reads files, so it runs in Restricted Mode. When saw
  confirms malware in a folder you have not trusted, the extension tells you before you trust it.
- **In the Problems panel.** Confirmed findings are errors, heuristic ones are warnings.
- **In the status bar and the saw view.** Each folder's verdict: clean, suspicious, residue,
  infected, or could not scan. A folder that could not be scanned fully is never shown as clean.
- **As things change.** A saved file, a checkout, a pull or a package install that changes
  `.vscode/`, `package.json`, a lockfile, a workflow or a git hook triggers another scan.

And it acts, when you ask:

- **Fix a folder.** On an infected folder, **Fix…** (in the alert, the saw view or **saw: Fix
  Folder…**) runs `saw fix` after you confirm. saw removes what it confirms from the checkout,
  together with the installed packages, build output and lockfile, and prepares the clean-up on a
  new local branch. It first tries to keep what you had not committed on a local
  `saw/uncommitted-…` branch, which needs git to know your name and email; the confirmation warns
  you when it does not. Nothing is pushed. It works in Restricted Mode: saw runs git with the repository's own hooks and
  settings switched off, so nothing from the folder runs. The report stays in a terminal, and the
  folder is scanned again when saw is done.
- **Audit this machine.** **saw: Audit This Machine** runs `saw audit` and tells you, in saw's own
  words, whether changing your passwords and tokens is safe yet. Changing them while something on
  the machine still watches them can set off code that deletes your files.
- **Scan-on-clone hooks.** The saw view shows whether saw's git hooks are in place, so every clone,
  pull and branch switch is scanned, and installs or repairs them in one click.

## Requirements

Linux or macOS with Python 3.11 or later, on the machine where the files are (for Remote SSH, WSL
and dev containers, that is the remote). Nothing else: the extension sets up saw itself.

### Remote windows

In a Remote - SSH, WSL or dev container window, the extension runs on the remote machine. It finds
or installs saw there, scans the remote's files, and **Fix…** and the hooks act on the remote's git.
**Audit This Machine** audits that remote machine (the server, the WSL distribution or the
container), not the computer the editor's window is on.

### Windows

saw does not run on native Windows yet, so the extension does not install it there. Use WSL:

1. Install WSL with Ubuntu: `wsl --install` in an administrator PowerShell, then restart.
2. In Ubuntu, install what saw needs once: `sudo apt install python3 python3-venv pipx`. Ubuntu
   as WSL installs it has Python but cannot create the environment saw is installed into; without
   this step, the extension tells you to run that command.
3. Open your project in a WSL window: in VS Code, install the WSL extension and run **WSL: Open
   Folder in WSL…**; other editors such as Cursor have their own WSL remote. Keep the project on
   the Linux side, for example `~/code/project` rather than `/mnt/c/…`.
4. Install this extension in the WSL window when asked. It installs saw inside WSL and scans.

## Setting up saw

The extension uses the `saw` it finds on `PATH` or in `~/.local/bin`. When there is none, or it is
too old to read, the extension installs it without asking, in the background:

1. If pipx is not installed, it installs pipx first, from a temporary environment it deletes
   afterwards. Nothing is written into the system Python and no administrator rights are needed.
2. It installs saw with pipx, as `stayawakebot` at the release this version of the extension was
   tested with.

Both come from PyPI as ready-built packages only, so no package's build script runs. The status bar
shows **saw: installing** until saw is ready, and the first scan starts on its own.

You hear from the extension only if something needs you. If the install fails, one notification
says why and what to run (for example, the command that installs Python on your system), with
**Retry**, **Copy Diagnostics** for an issue report, and **Show Log**. **saw: Install or Repair
saw** reinstalls it at any time.

Turn off `saw.autoInstall` where software is installed only by an administrator; the extension
then uses the `saw` it finds, or the one `saw.path` names.

## Settings

| Setting | Default | |
| --- | --- | --- |
| `saw.path` | empty | Absolute path to `saw`. |
| `saw.autoInstall` | `true` | Install saw with pipx (and pipx first) when it is missing or too old. |
| `saw.configPath` | empty | Your own saw config (allowlist), passed as `saw scan -c`. |
| `saw.scanOnStartup` | `true` | Scan every folder when the window opens. |
| `saw.scanOnChange` | `true` | Scan again on save, and when a file that can run code changes. |
| `saw.scanTimeoutSeconds` | `120` | How long one folder's scan may take. |

These are read from your user settings only. A folder's own `.vscode/settings.json` cannot choose
which program runs or switch the scan off.

## What it does not do

It never changes your files on its own: only **Fix…**, after you confirm, does. It never pushes or
opens a pull request. The extension sends nothing anywhere: saw scans offline. The only download is the install from PyPI.
The install does not edit your shell profile: the extension's terminals get pipx's folder on `PATH`;
for other terminals, run `pipx ensurepath` once.

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md) and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
