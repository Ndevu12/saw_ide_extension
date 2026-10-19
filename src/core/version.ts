/** The oldest saw whose `scan --json` report this extension reads. */
export const MIN_SAW_VERSION = "0.7.0";

const VERSION = /\bsaw \(stayawakebot\) (\d+)\.(\d+)\.(\d+)/;

export type Version = readonly [number, number, number];

/** Read the release from `saw --version`, e.g. `saw (stayawakebot) 0.12.3`. A dev build reads as its base. */
export function parseVersion(output: string): Version | null {
  const match = VERSION.exec(output);
  if (!match) {
    return null;
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function atLeast(version: Version, minimum: string): boolean {
  const floor = minimum.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const have = version[i] ?? 0;
    const need = floor[i] ?? 0;
    if (have !== need) {
      return have > need;
    }
  }
  return true;
}

export function formatVersion(version: Version): string {
  return version.join(".");
}
