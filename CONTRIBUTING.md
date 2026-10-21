# Contributing

This guide is for changing this repository. Using the extension is covered in the
[README](README.md). The layout of the code is in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
What saw detects is documented at [saw-docs.ndevuspace.com](https://saw-docs.ndevuspace.com/).

## Issues

- **This extension** (installing saw, a view, a command): open an
  [issue here](https://github.com/Ndevu12/saw_ide_extension/issues).
- **A verdict that looks wrong:** detection lives in saw. Open an
  [issue on stayAwakeBot](https://github.com/Ndevu12/stayAwakeBot/issues).

## Set up

Node.js 22 or later, pnpm 11 (`corepack enable`), and saw on `PATH`
(`pipx install stayawakebot`). The contract and integration tests run saw.

```bash
pnpm install
pnpm run build
```

Press F5 to run the extension in a development window.

### Toolchain

- `pnpm run check-types` uses TypeScript 7 (`@typescript/native`). typescript-eslint needs the
  TypeScript 6 API, so the `typescript` package is aliased to `@typescript/typescript6` for lint.
- esbuild bundles the extension into `dist/`.
- `pnpm-workspace.yaml` holds the install policy and the overrides for mocha's `diff` and
  `serialize-javascript`, which the VS Code test runner still depends on. Keep those overrides when
  you upgrade the runner.

## Checks

Run these before opening a pull request. Continuous integration runs them on every pull request.

```bash
pnpm test                   # unit tests; the contract tests run when saw is installed
pnpm run lint
pnpm run check-types
pnpm run test:integration   # VS Code, at the oldest version this extension supports
pnpm run package            # writes saw.vsix
```

When your change touches one of these areas, run its check as well.

| Area | Command |
| --- | --- |
| Installing saw | `SAW_INSTALL_E2E=1 SAW_E2E_NO_PIPX=1 pnpm exec vitest run test/unit/real-install.test.ts` installs from PyPI into a sandbox. |
| Cursor | `SAW_IT_EDITOR=/path/to/cursor pnpm run test:integration` |
| Remote windows | `pnpm run test:remote:install-images` and `pnpm run test:remote:vscode-server`, both under Docker. |

## Conventions

A pull request needs to keep these.

- **`src/core` has no `vscode` import.** Lint enforces it. Editor code belongs in `src/editor`.
- **A scan that could not answer is `incomplete`.** A failed start, a timeout, output that does not
  parse, and a target saw could not read are all `incomplete`.
- **The workspace does not choose the program that runs.** saw is an absolute path, started without
  a shell, from a neutral directory. Settings that choose what runs are machine-scoped.
- **Text from a scanned file is plain text**, rendered through `core/text.plain`.
- **An install failure names its cause and the next command**, in `core/diagnose`, with a test.
- **A bump of the `"saw"` pin in `package.json` is its own pull request.** Continuous integration
  tests that release, and it is the release the extension installs.
- **The published bundle is this repository's own code.** A new runtime dependency needs its reason
  recorded in the pull request.
- **`engines.vscode` moves with `@types/vscode`, and only for an API the extension needs.** Galleries
  for VS Code forks hide an extension that requires an editor newer than they ship.

## Pull requests

Branch from `main`. For a change someone using the extension can see, add an entry under
`[Unreleased]` in `CHANGELOG.md`.

## Releases

Maintainers publish. A release is a signed `vX.Y.Z` tag on `main`: it matches `version` in
`package.json` and has a `## [X.Y.Z]` heading in `CHANGELOG.md`. Pushing the tag runs the release
workflow, which publishes that one build to the Visual Studio Marketplace and to Open VSX.
