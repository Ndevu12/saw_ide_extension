import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { listFiles, PackageManager } from "@vscode/vsce";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "../..");

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const file = path.join(dir, name);
    return statSync(file).isDirectory() ? sources(file) : file.endsWith(".ts") ? [file] : [];
  });
}

/** Every file the extension loads from its own folder at run time. */
function loaded(): string[] {
  const build = readFileSync(path.join(ROOT, "esbuild.mjs"), "utf8");
  const entries = /entryPoints:\s*\{([^}]*)\}/.exec(build)?.[1] ?? "";
  const bundles = [...entries.matchAll(/"?([\w-]+)"?\s*:/g)].map((match) => `dist/${match[1]}.js`);
  const referenced = sources(path.join(ROOT, "src")).flatMap((file) => {
    const text = readFileSync(file, "utf8");
    const absolute = [...text.matchAll(/asAbsolutePath\("([^"]+)"\)/g)].map((match) => match[1] ?? "");
    // vscode.Uri.joinPath(context.extensionUri, "media", "x.svg"): the quoted parts, joined.
    const joined = [...text.matchAll(/joinPath\(\s*[\w.]*extensionUri\s*,((?:\s*"[^"]+"\s*,?)+)\)/g)].map((match) =>
      [...(match[1] ?? "").matchAll(/"([^"]+)"/g)].map((part) => part[1]).join("/"),
    );
    return [...absolute, ...joined];
  });
  const manifest = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as { icon: string; contributes?: unknown };
  return [...new Set([...bundles, ...referenced, manifest.icon, ...contributedFiles(manifest.contributes)])];
}

/** Files the manifest's contributions name, such as view and command icons. */
function contributedFiles(value: unknown): string[] {
  if (typeof value === "string") {
    return /^[\w./-]+\.(svg|png|gif|jpg|jpeg|json|js|md)$/.test(value) && !value.startsWith("http") ? [value.replace(/^\.\//, "")] : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap(contributedFiles);
  }
  return value && typeof value === "object" ? Object.values(value).flatMap(contributedFiles) : [];
}

describe("the packaged extension", () => {
  it("carries every bundle and file the extension loads", async () => {
    const files = loaded();
    expect(files).toEqual(expect.arrayContaining(["dist/extension.js", "dist/cursor-hook.js", "dist/govern-shim.js", "media/verdict-light.svg", "media/verdict-dark.svg"]));
    const dir = mkdtempSync(path.join(tmpdir(), "saw-package-"));
    try {
      copyFileSync(path.join(ROOT, "package.json"), path.join(dir, "package.json"));
      copyFileSync(path.join(ROOT, ".vscodeignore"), path.join(dir, ".vscodeignore"));
      for (const file of files) {
        mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
        writeFileSync(path.join(dir, file), "");
      }
      const packaged = await listFiles({ cwd: dir, packageManager: PackageManager.None });
      expect(packaged).toEqual(expect.arrayContaining(files));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
