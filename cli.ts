/**
 * CLI entry point — arg parsing, wire everything together.
 *
 * Usage:
 *   node --env-file=.env --experimental-strip-types cli.ts <seed> [options]
 */

import { parseArgs } from "node:util";
import { writeFile } from "node:fs/promises";
import { runSimulation } from "./simulation.ts";
import { webResearch } from "./substrates/web-research.ts";
import { render } from "./render.ts";
import { log } from "./log.ts";
import { DEFAULT_CONFIG, type SimulationConfig } from "./types.ts";

// ── Parse args ───────────────────────────────────────────────────────

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    tendrils: { type: "string", short: "t" },
    ticks: { type: "string" },
    concurrency: { type: "string", short: "c" },
    budget: { type: "string", short: "b" },
    decay: { type: "string" },
    substrate: { type: "string", short: "s" },
    "no-render": { type: "boolean" },
    json: { type: "boolean" },
    save: { type: "string" },
    trail: { type: "string" },
    "trail-decay": { type: "string" },
    "trail-avoidance": { type: "string" },
    "fan-out": { type: "string", short: "f" },
    help: { type: "boolean", short: "h" },
  },
});

if (values.help || positionals.length === 0) {
  console.error(`
${"\x1b[1m"}Usage:${"\x1b[0m"} node --env-file=.env --experimental-strip-types cli.ts <seed> [options]

${"\x1b[1m"}Options:${"\x1b[0m"}
  --tendrils, -t <n>   Initial tendrils (default: ${DEFAULT_CONFIG.initialTendrils})
  --ticks <n>          Max ticks (default: ${DEFAULT_CONFIG.maxTicks})
  --concurrency, -c    Parallel ops per tick (default: ${DEFAULT_CONFIG.concurrency})
  --budget, -b <n>     Max API calls (default: ${DEFAULT_CONFIG.maxApiCalls})
  --decay <rate>       Decay rate 0-1 (default: ${DEFAULT_CONFIG.decayRate})
  --substrate, -s      Substrate name (default: "web")
  --no-render          Disable live terminal viz
  --json               Output final graph JSON to stdout
  --save <path>        Save graph JSON to file
  --trail <path>       Persistent trail file (stigmergy / cross-run memory)
  --trail-decay <rate> Trail decay rate 0-1 (default: ${DEFAULT_CONFIG.trailDecayRate})
  --trail-avoidance    How strongly to avoid slimed areas 0-1 (default: ${DEFAULT_CONFIG.trailAvoidance})
  --fan-out, -f <n>    Fan-out multiplier for initial burst (default: ${DEFAULT_CONFIG.fanOutMultiplier})
  --help, -h           Show this help

${"\x1b[1m"}Example:${"\x1b[0m"}
  npm run explore -- "mesh networking alternative infrastructure" --ticks 20 --budget 40
`);
  process.exit(0);
}

const seed = positionals.join(" ");

const config: SimulationConfig = {
  ...DEFAULT_CONFIG,
  seed,
  initialTendrils: values.tendrils ? parseInt(values.tendrils, 10) : DEFAULT_CONFIG.initialTendrils,
  maxTicks: values.ticks ? parseInt(values.ticks, 10) : DEFAULT_CONFIG.maxTicks,
  concurrency: values.concurrency ? parseInt(values.concurrency, 10) : DEFAULT_CONFIG.concurrency,
  maxApiCalls: values.budget ? parseInt(values.budget, 10) : DEFAULT_CONFIG.maxApiCalls,
  decayRate: values.decay ? parseFloat(values.decay) : DEFAULT_CONFIG.decayRate,
  noRender: values["no-render"] ?? DEFAULT_CONFIG.noRender,
  trailPath: values.trail ?? DEFAULT_CONFIG.trailPath,
  trailDecayRate: values["trail-decay"] ? parseFloat(values["trail-decay"]) : DEFAULT_CONFIG.trailDecayRate,
  trailAvoidance: values["trail-avoidance"] ? parseFloat(values["trail-avoidance"]) : DEFAULT_CONFIG.trailAvoidance,
  fanOutMultiplier: values["fan-out"] ? parseInt(values["fan-out"], 10) : DEFAULT_CONFIG.fanOutMultiplier,
};

// ── Select substrate ─────────────────────────────────────────────────

const substrateName = values.substrate ?? "web";
const substrates: Record<string, typeof webResearch> = {
  web: webResearch,
};

const substrate = substrates[substrateName];
if (!substrate) {
  log.error(`Unknown substrate: "${substrateName}". Available: ${Object.keys(substrates).join(", ")}`);
  process.exit(1);
}

// ── Run ──────────────────────────────────────────────────────────────

const onTick = config.noRender ? undefined : render;

try {
  const result = await runSimulation(config, substrate, onTick);

  // output JSON to stdout if requested
  if (values.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  }

  // save to file if requested
  if (values.save) {
    await writeFile(values.save, JSON.stringify(result, null, 2));
    log.success(`Graph saved to ${values.save}`);
  }

  // if neither --json nor --save, still print a summary
  if (!values.json && !values.save) {
    log.info("\nUse --json to output the graph, or --save <path> to save it.");
  }
} catch (err) {
  log.error(`\nSimulation failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
