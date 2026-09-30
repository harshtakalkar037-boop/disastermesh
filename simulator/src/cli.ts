import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { SCENARIOS, runScenario } from "./engine.js";

const args = process.argv.slice(2);
const command = args[0] ?? "list";

if (command === "list") {
  console.log("SIMULATOR scenarios (not field measurements):");
  for (const scenario of Object.values(SCENARIOS)) {
    console.log(`- ${scenario.id}: ${scenario.nodes} nodes — ${scenario.description}`);
  }
  process.exit(0);
}

if (command !== "run") {
  console.error("Usage: tsx src/cli.ts list | run --scenario <id> [--seed n] [--out file]");
  process.exit(1);
}

function flag(name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

const id = flag("--scenario");
if (!id || !SCENARIOS[id]) {
  console.error(`Unknown scenario. Known: ${Object.keys(SCENARIOS).join(", ")}`);
  process.exit(1);
}
const scenario = { ...SCENARIOS[id] };
const seed = flag("--seed");
if (seed) scenario.seed = Number(seed);
const result = runScenario(scenario);
console.log(JSON.stringify(result, null, 2));
const out = flag("--out");
if (out) {
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(result, null, 2));
}
