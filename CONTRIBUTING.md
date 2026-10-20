# Contributing

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
pnpm run test:linux   # the install, in WSL's Ubuntu, dev-container and bare Debian images (Docker)
pnpm run lint && pnpm run check-types
pnpm run package      # saw.vsix
```

Press F5 in the editor to run the extension in a development host.

## Remote windows

In a remote window (Remote - SSH, WSL, Dev Containers, or Cursor's equivalents) the extension runs
on the remote machine (`extensionKind: workspace`), so saw is found or installed there.
`pnpm test:linux` covers the install on those machines. Before a release, also check by hand with
`saw.vsix` installed in each kind of remote window:

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

Bump `version` in `package.json`, move the `[Unreleased]` changelog entries under a
`## [X.Y.Z] - YYYY-MM-DD` heading, merge, then tag the merge commit on `main` and push the tag
(`git tag vX.Y.Z && git push origin vX.Y.Z`). The release workflow packages once and publishes the
same `.vsix` to the Visual Studio Marketplace (`VSCE_PAT`) and Open VSX (`OVSX_PAT`), each only
when its secret is configured.

It refuses to release when the tag is not on `main`, does not match `package.json`, has no
changelog section, or when neither token is set.

One-time setup, before the first release:

- **Open VSX:** sign in at [open-vsx.org](https://open-vsx.org) with GitHub, sign the publisher
  agreement, create an access token, then create the namespace with
  `pnpm exec ovsx create-namespace ndevu12 -p <token>` and
  [claim ownership of it](https://github.com/EclipseFdn/open-vsx.org/issues/new?template=claim-namespace-ownership.yml)
  so the extension shows as verified. See
  [Publishing Extensions](https://github.com/EclipseFdn/open-vsx.org/wiki/Publishing-Extensions).
- **Visual Studio Marketplace:** create the publisher `ndevu12` at
  [marketplace.visualstudio.com/manage](https://marketplace.visualstudio.com/manage) and an Azure
  DevOps personal access token with the Marketplace (Manage) scope.
- **Secrets:** add the tokens as `OVSX_PAT` and `VSCE_PAT` to the `release` environment
  (Settings → Environments), not as repository secrets, and require a reviewer there so a pushed tag
  waits for approval before it publishes.
