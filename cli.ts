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
import { streamSubstrate } from "./substrates/stream.ts";
import { render, enterRenderMode, exitRenderMode } from "./render.ts";
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
    mode: { type: "string", short: "m" },
    goals: { type: "string" },
    input: { type: "string" },
    "batch-size": { type: "string" },
    help: { type: "boolean", short: "h" },
  },
});

// ── Validate mode ────────────────────────────────────────────────────

const mode = (values.mode ?? "explore") as "explore" | "solve" | "sense";
if (!["explore", "solve", "sense"].includes(mode)) {
  log.error(`Unknown mode: "${values.mode}". Available: explore, solve, sense`);
  process.exit(1);
}

// ── Help ─────────────────────────────────────────────────────────────

const needsSeed = mode === "explore" && positionals.length === 0;

if (values.help || needsSeed) {
  console.error(`
${"\x1b[1m"}Usage:${"\x1b[0m"} node --env-file=.env --experimental-strip-types cli.ts [seed] [options]

${"\x1b[1m"}Modes:${"\x1b[0m"}
  --mode <explore|solve|sense>   Simulation mode (default: explore)
    explore: fan out from seed, map the problem space
    solve:   find paths between goals, build connection topology
    sense:   read from stream, detect patterns and recurring themes

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
  --goals <g1,g2,...>  Food sources for solver mode
  --input <path>       Input file for sensor mode (default: stdin)
  --batch-size <n>     Lines per tick in sensor mode (default: ${DEFAULT_CONFIG.batchSize})
  --help, -h           Show this help

${"\x1b[1m"}Examples:${"\x1b[0m"}
  ${"\x1b[2m"}# Explorer mode (default)${"\x1b[0m"}
  npm run explore -- "mesh networking" --ticks 20 --budget 40

  ${"\x1b[2m"}# Solver mode — find connections between goals${"\x1b[0m"}
  npm run explore -- --mode solve --goals "mesh networking,solarpunk urbanism,mycelial networks" --budget 15

  ${"\x1b[2m"}# Sensor mode — read from file${"\x1b[0m"}
  npm run explore -- --mode sense --input data.txt --batch-size 10

  ${"\x1b[2m"}# Sensor mode — read from stdin${"\x1b[0m"}
  cat logs.txt | npm run explore -- --mode sense --budget 20
`);
  process.exit(0);
}

// ── Build config ─────────────────────────────────────────────────────

const seed = positionals.join(" ");
const goals = values.goals ? values.goals.split(",").map((g) => g.trim()).filter(Boolean) : [];

if (mode === "solve" && goals.length === 0) {
  log.error("Solver mode requires --goals <g1,g2,...>");
  process.exit(1);
}

const config: SimulationConfig = {
  ...DEFAULT_CONFIG,
  seed,
  mode,
  goals,
  inputFile: values.input ?? DEFAULT_CONFIG.inputFile,
  batchSize: values["batch-size"] ? parseInt(values["batch-size"], 10) : DEFAULT_CONFIG.batchSize,
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

let substrate;
if (mode === "sense") {
  // sensor mode always uses the stream substrate
  substrate = streamSubstrate;
} else {
  const substrateName = values.substrate ?? "web";
  const substrates: Record<string, typeof webResearch> = {
    web: webResearch,
  };
  substrate = substrates[substrateName];
  if (!substrate) {
    log.error(`Unknown substrate: "${substrateName}". Available: ${Object.keys(substrates).join(", ")}`);
    process.exit(1);
  }
}

// ── Run ──────────────────────────────────────────────────────────────

const useRender = !config.noRender;
const onTick = useRender ? render : undefined;

// mute log output when live viz is active — the render panels show everything
if (useRender) log.muted = true;

// ensure we restore the terminal on exit (ctrl-c, crash, etc.)
function cleanup() {
  if (useRender) {
    exitRenderMode();
    log.muted = false;
  }
}
process.on("SIGINT", () => { cleanup(); process.exit(130); });
process.on("SIGTERM", () => { cleanup(); process.exit(143); });

try {
  const result = await runSimulation(config, substrate, onTick);

  // leave alt screen before printing results
  cleanup();

  // output JSON to stdout if requested
  if (values.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  }

  // save to file if requested
  if (values.save) {
    await writeFile(values.save, JSON.stringify(result, null, 2));
    log.success(`Graph saved to ${values.save}`);
  }

  // print summary
  log.success(
    `\nDone: ${result.stats.totalNodes} nodes, ${result.stats.totalEdges} edges, ` +
    `${result.stats.crossLinks} cross-links, ${result.stats.apiCallsUsed} API calls`
  );

  if (!values.json && !values.save) {
    log.info("Use --json to output the graph, or --save <path> to save it.");
  }
} catch (err) {
  cleanup();
  log.error(`\nSimulation failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
