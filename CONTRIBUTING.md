# Contributing

Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) first: how the code is laid out, how a scan and an
action run, and where the security boundaries are. What saw itself does is documented at
[saw-docs.ndevuspace.com](https://saw-docs.ndevuspace.com/).

## Setup

Node 22 or later, pnpm 11 (`corepack enable` or `npm i -g pnpm`), and saw on `PATH`
(`pipx install stayawakebot`) for the contract and integration tests.

```bash
pnpm install
pnpm run build        # dist/extension.js
pnpm test             # unit + contract tests (contract tests run when saw is installed)
SAW_INSTALL_E2E=1 SAW_E2E_NO_PIPX=1 pnpm exec vitest run test/unit/real-install.test.ts
                      # the real install from PyPI, into a sandbox (your pipx is untouched)
pnpm run test:integration   # in a real VS Code, the oldest version supported
pnpm run test:remote:install-images   # the install, in WSL's Ubuntu, dev-container and bare Debian images (Docker)
pnpm run test:remote:vscode-server    # the extension in VS Code Server, which remote windows run (Docker)
pnpm run lint && pnpm run check-types
pnpm run package      # saw.vsix
```

Press F5 in the editor to run the extension in a development host.

## Tooling

- **TypeScript 7** (`@typescript/native`, the native compiler) runs `pnpm run check-types`.
  typescript-eslint still needs the TypeScript 6 API, so the `typescript` package is aliased to
  `@typescript/typescript6` for lint only.
- **esbuild** bundles `src/extension.ts` into `dist/extension.js`; nothing else ships.
- **`pnpm-workspace.yaml`** holds the install policy (minimum release age, trust policy, no exotic
  sub-dependencies, explicit build allowlist) and the overrides for mocha's `diff` and
  `serialize-javascript`, which `@vscode/test-cli` still pulls in. Keep both when upgrading.

## Remote windows

In a remote window (Remote - SSH, WSL, Dev Containers, or Cursor's equivalents) the extension runs
on the remote machine (`extensionKind: workspace`), so saw is found or installed there.
The tests for remote windows live in `test/remote/`, one folder per test, sharing the scenario runner
in `test/remote/scenarios.mjs`:

- `install-images/` (`pnpm test:remote:install-images`) runs the install on the machines those
  windows land on.
- `vscode-server/` (`pnpm test:remote:vscode-server`) runs `saw.vsix` in VS Code Server, the program
  those windows start on the remote, inside a Debian container with headless Chromium as the window
  (`VSCODE_TEST_VERSION` picks the server; default: latest stable). It checks that:
  - saw is installed and run on the server, and the folder's report is kept in the server's storage,
    not in the project;
  - the window warns that the folder is infected;
  - **Audit This Machine**, **Install Scan-on-Clone Hooks** and **Fix…**, started from the command
    palette and confirmed in the dialog as a person would, act on the server: saw reports its hooks
    installed there, and Fix prepares its branch in the server's checkout, after which the folder
    scans clean;
  - a server without network never shows a folder as clean.

  `workbench.mjs` drives the window through Chromium's DevTools protocol. A screenshot of the window
  is taken after each step; the path is printed first, `SAW_REMOTE_SCREENSHOTS` chooses it, and CI
  uploads them when the test fails.

Neither covers the editors' own remote extensions (Microsoft's Remote - SSH, WSL and Dev Containers
clients, which are not open source) or Cursor's remote server (Cursor documents neither a download
for it nor a browser window to drive it). Before a release, check those by hand with `saw.vsix`
installed in each kind of remote window:

- the status bar shows the remote folder's verdict, and an infected folder is reported as infected;
- `saw` is found or installed **on the remote** (`saw: Show Log` names its path), not on this machine;
- **Fix…**, **Audit This Machine** and the hooks act on the remote's files, git and machine;
- with no network, the install fails with the diagnosis, and no folder is reported clean.

## Rules

- **`src/core` never imports `vscode`.** It holds everything that can be tested without an editor:
  the report contract, the verdict, finding and running saw, scheduling. Lint enforces it.
- **Detection lives in saw.** The extension never decides that something is or is not malware. If a
  verdict looks wrong, the fix belongs in saw.
- **Never read a run that could not answer as clean.** A failed start, a timeout, unparsable output
  or an errored target is `incomplete`.
- **Nothing from the workspace chooses what runs.** saw is resolved to an absolute path from user
  settings, PATH or known install locations, and started without a shell from a neutral directory.
- **Text from a scanned file is shown as plain text only**, through `core/text.plain`.
- **The install never asks; it explains when it fails.** Every failure the installer can name gets a
  cause and a fix in `core/diagnose`, with a test.
- **Bump `"saw"` in `package.json` in its own pull request.** CI runs the contract tests against that
  stayawakebot release, and that is what the extension installs.
- **No runtime dependencies** without a decision recorded in the pull request. The bundle is the
  extension's own code.
- **`engines.vscode` moves only when a needed API requires it**, together with `@types/vscode`.
  VS Code forks lag upstream, and their galleries hide an extension that asks for a newer editor.
- Feature branches and pull requests; update `CHANGELOG.md` under `[Unreleased]` in the same PR.

## Releasing

The extension is `ndevu12.stayawakebot`, after saw's PyPI package; the display name is
**StayAwakeBot (saw)**. One `.vsix` goes to both registries, so both get the same build.

1. Bump `version` in `package.json` and move the `[Unreleased]` changelog entries under a
   `## [X.Y.Z] - YYYY-MM-DD` heading, in one pull request.
2. After it merges, tag the merge commit on `main` with a signed tag, and push it:

   ```bash
   git tag -s vX.Y.Z -m "vX.Y.Z" && git push origin vX.Y.Z
   ```

3. The release workflow packages once, then waits for approval in the `release` environment. Once
   approved, it publishes the `.vsix` to each registry whose token is set (`OVSX_PAT` for Open VSX,
   `VSCE_PAT` for the Visual Studio Marketplace), and attaches `stayawakebot-X.Y.Z.vsix` and its
   SHA-256 checksum to a GitHub Release with generated notes.
4. While `VSCE_PAT` is not set, upload that `.vsix` to the Marketplace by hand at
   [marketplace.visualstudio.com/manage](https://marketplace.visualstudio.com/manage/publishers/ndevu12).

The workflow refuses to release when the tag is not on `main`, does not match `package.json`, has no
changelog section, or when neither token is set.

### Registry setup

- **Open VSX:** the `ndevu12` namespace exists, and its
  [ownership claim](https://github.com/EclipseFdn/open-vsx.org/issues/14490) asks for the old
  `ndevu12.saw` listing to be deprecated. Open VSX scans each upload before it lists it, and its API
  paths are case-sensitive (`/api/Ndevu12/stayawakebot`).
- **Visual Studio Marketplace:** the publisher is `ndevu12`. For automatic publishing, create an Azure
  DevOps personal access token with the Marketplace (Manage) scope and add it as `VSCE_PAT`.
- **Secrets** belong to the `release` environment (Settings → Environments), not the repository, and
  that environment requires a reviewer, so a pushed tag waits for approval before it publishes.
