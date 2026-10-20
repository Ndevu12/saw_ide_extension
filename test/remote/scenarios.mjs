// Shared by the remote tests: runs each scenario's container, reads the one JSON line its check
// prints last, and reports whether the scenario's expectation holds. `pnpm <script> [name…]` runs
// only the scenarios named.
import { spawnSync } from "node:child_process";

/**
 * @param {{ name: string, about: string, expect: (report: any) => boolean }[]} scenarios
 * @param {(scenario: any) => string[]} dockerRunArgs the arguments after `docker run --rm`
 * @param {string} [note] added to each result line, such as the editor version under test
 */
export function runScenarios(scenarios, dockerRunArgs, note) {
  const wanted = process.argv.slice(2);
  let failures = 0;
  for (const scenario of scenarios.filter((s) => !wanted.length || wanted.includes(s.name))) {
    const args = dockerRunArgs(scenario);
    const started = Date.now();
    const run = spawnSync("docker", ["run", "--rm", ...args], { encoding: "utf8", timeout: 15 * 60_000 });
    const line = run.stdout.trim().split("\n").pop() ?? "";
    let report;
    try {
      report = JSON.parse(line);
    } catch {
      report = { result: "no-report", stdout: run.stdout.slice(-2000), stderr: run.stderr.slice(-2000) };
    }
    let ok;
    try {
      ok = scenario.expect(report) === true;
    } catch {
      ok = false;
    }
    failures += ok ? 0 : 1;
    const seconds = Math.round((Date.now() - started) / 1000);
    console.log(`${ok ? "✔" : "✘"} ${scenario.name} (${seconds}s${note ? `, ${note}` : ""}): ${scenario.about}`);
    console.log(`    ${JSON.stringify(report)}`);
  }
  process.exitCode = failures ? 1 : 0;
}
