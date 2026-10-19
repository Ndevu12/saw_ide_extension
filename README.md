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
- **As things change.** A saved file, a pull or a package install that changes `.vscode/`,
  `package.json`, a lockfile, a workflow or a git hook triggers another scan.

## Requirements

Python 3.11 or later, on the machine where the files are (for Remote SSH, WSL and dev containers,
that is the remote). Nothing else: the extension sets up saw itself.

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

It never changes your files. To remove what saw confirms, run `saw fix` in the folder. The
extension sends nothing anywhere: saw scans offline. The only download is the install from PyPI.
The install does not edit your shell profile: the extension's terminals get pipx's folder on `PATH`;
for other terminals, run `pipx ensurepath` once.

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md) and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
