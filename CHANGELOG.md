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
- On Windows, where saw does not run yet, says so and points to WSL instead of installing it.
