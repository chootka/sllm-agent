/**
 * The tick loop — orchestrates all 9 Physarum behaviors.
 *
 * Each tick runs in fixed order:
 * 1. Decay    — edges/flows/energies/trail marks degrade
 * 2. Prune    — remove weak edges, kill starved tendrils, remove orphans
 * 3. Spawn    — create new tendrils (initial or queued)
 * 4. Sense    — active tendrils explore + sense (parallel, rate-limited)
 * 5. Deposit  — leave slime trail where we've been
 * 6. Reinforce — boost high-nutrient paths, drain low-nutrient ones
 * 7. Connect  — create cross-edges between related nodes
 * 8. Pulse    — sinusoidal flow injection (protoplasmic streaming)
 * 9. Render   — update display + check termination
 */

import Anthropic from "@anthropic-ai/sdk";
import type {
  SimulationConfig,
  PhysarumGraph,
  ResourcePool,
  Tendril,
  SimEvent,
  GraphJSON,
} from "./types.ts";
import {
  createGraph,
  addNode,
  addEdge,
  removeEdge,
  removeNode,
  getOrphanedNodes,
  getEdgesForNode,
  getNode,
  toJSON,
} from "./network.ts";
import {
  createTendril,
  drainEnergy,
  awardEnergy,
  starve,
  feed,
  kill,
  getActiveTendrils,
} from "./tendril.ts";
import type { NutrientFunction } from "./nutrient.ts";
import {
  createTrailStore,
  loadTrail,
  saveTrail,
  deposit,
  decayAll,
  rankByNovelty,
  trailSummary,
  type TrailStore,
} from "./trail.ts";
import { log } from "./log.ts";

// ── Semaphore for concurrency limiting ───────────────────────────────

class Semaphore {
  private queue: (() => void)[] = [];
  private active = 0;
  private max: number;
  constructor(max: number) {
    this.max = max;
  }

  async acquire(): Promise<void> {
    if (this.active < this.max) {
      this.active++;
      return;
    }
    return new Promise<void>((resolve) => {
      this.queue.push(() => {
        this.active++;
        resolve();
      });
    });
  }

  release(): void {
    this.active--;
    const next = this.queue.shift();
    if (next) next();
  }
}

// ── Initial direction generation ─────────────────────────────────────

async function generateFanOutDirections(
  seed: string,
  count: number,
  client: Anthropic,
  trail: TrailStore
): Promise<string[]> {
  const trailContext = trailSummary(trail);

  const response = await client.messages.create({
    model: "claude-sonnet-4-5-20250929",
    max_tokens: 2048,
    messages: [
      {
        role: "user",
        content: `You are a research exploration planner modeled on Physarum polycephalum (slime mould). When placed on a new substrate, the organism immediately fans out pseudopods in ALL directions — radially, maximally spread apart. Most will find nothing and retract. A few will hit food and explode outward again.

Generate ${count} maximally diverse exploration directions for this seed topic. Think of them as pseudopods extending in every direction from a central point:

- Cover different SCALES (micro to macro, individual to systemic)
- Cover different DISCIPLINES (technical, cultural, historical, economic, artistic, scientific, political)
- Cover different TIME HORIZONS (past origins, current state, future trajectories)
- Cover different MODALITIES (theory, practice, community, infrastructure, tools)
- Some should be obvious/direct. Others should be surprising/oblique — the weird angles that might find unexpected nutrition.

Seed topic: "${seed}"

## Slime trail (territory already explored in previous runs):
${trailContext}

IMPORTANT: Avoid directions that overlap with the slime trail above. Fan out into the GAPS. If the trail is empty, fan out freely in all directions.

Respond with ONLY a JSON array of ${count} strings, each a short (5-15 word) exploration direction. No other text.`,
      },
    ],
  });

  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");

  try {
    const directions = JSON.parse(text);
    if (Array.isArray(directions) && directions.every((d) => typeof d === "string")) {
      return directions.slice(0, count);
    }
  } catch {
    // fallback: split by newlines and clean up
  }

  // fallback: generate simple variations
  return Array.from({ length: count }, (_, i) =>
    `${seed} — perspective ${i + 1}`
  );
}

// ── The simulation ───────────────────────────────────────────────────

export interface SimulationState {
  graph: PhysarumGraph;
  tendrils: Tendril[];
  trail: TrailStore;
  resources: ResourcePool;
  config: SimulationConfig;
  tick: number;
  events: SimEvent[];
  spawnQueue: { direction: string; parentId: string; depth: number }[];
  done: boolean;
  stopReason: string;
}

export function createSimulation(config: SimulationConfig, trail: TrailStore): SimulationState {
  return {
    graph: createGraph(),
    tendrils: [],
    trail,
    resources: {
      totalEnergy: config.initialTendrils * 1.0,
      distributed: 0,
      apiCallBudget: config.maxApiCalls,
      apiCallsUsed: 0,
    },
    config,
    tick: 0,
    events: [],
    spawnQueue: [],
    done: false,
    stopReason: "",
  };
}

// ── 1. Decay ─────────────────────────────────────────────────────────

function decay(state: SimulationState): void {
  const { decayRate, trailDecayRate } = state.config;

  for (const edge of state.graph.edges.values()) {
    edge.conductivity *= 1 - decayRate;
    edge.age++;
  }

  for (const node of state.graph.nodes.values()) {
    node.flow *= 1 - decayRate;
    node.age++;
  }

  for (const tendril of getActiveTendrils(state.tendrils)) {
    drainEnergy(tendril, decayRate * 0.5);
  }

  // trail decay — the environment forgets
  const trailPruned = decayAll(state.trail, trailDecayRate);
  if (trailPruned > 0) {
    log.decay(`${trailPruned} trail marks faded away`);
  }
}

// ── 2. Prune ─────────────────────────────────────────────────────────

function prune(state: SimulationState): void {
  const { pruneThreshold, starvationLimit } = state.config;

  // prune weak edges
  for (const [edgeId, edge] of state.graph.edges) {
    if (edge.conductivity < pruneThreshold) {
      removeEdge(state.graph, edgeId);
      state.events.push({ type: "edge_pruned", edgeId });
      log.prune(`edge ${edgeId} dissolved (conductivity ${edge.conductivity.toFixed(3)})`);
    }
  }

  // kill starved tendrils
  for (const tendril of getActiveTendrils(state.tendrils)) {
    if (tendril.energy <= 0 || tendril.starvation >= starvationLimit) {
      const reason = tendril.energy <= 0 ? "no energy" : "starvation";
      kill(tendril, reason);
      state.events.push({ type: "tendril_died", tendrilId: tendril.id, reason });
      log.prune(`tendril ${tendril.id} died (${reason})`);
    }
  }

  // remove orphaned nodes
  for (const nodeId of getOrphanedNodes(state.graph)) {
    const node = getNode(state.graph, nodeId);
    if (node && node.age > 2) {
      removeNode(state.graph, nodeId);
      log.prune(`orphan node ${nodeId} removed`);
    }
  }
}

// ── 3. Spawn ─────────────────────────────────────────────────────────

async function spawn(
  state: SimulationState,
  client: Anthropic
): Promise<void> {
  const { initialTendrils, fanOutMultiplier } = state.config;

  // tick 0: fan-out burst — extend pseudopods in all directions
  if (state.tick === 0) {
    const totalProbes = initialTendrils * fanOutMultiplier;
    state.resources.apiCallsUsed++;

    log.tendril(`fan-out: extending ${totalProbes} pseudopods in all directions`);

    const directions = await generateFanOutDirections(
      state.config.seed,
      totalProbes,
      client,
      state.trail
    );

    for (let i = 0; i < directions.length; i++) {
      const dir = directions[i];
      // first N get full energy (the "core" tendrils)
      // the rest are expendable probes — low energy, die fast if they find nothing
      const isProbe = i >= initialTendrils;
      const energy = isProbe ? 0.4 : 1.0;
      const tendril = createTendril(dir, null, 0, energy);
      state.tendrils.push(tendril);
      state.events.push({
        type: "tendril_spawned",
        tendrilId: tendril.id,
        direction: dir,
      });
      log.tendril(`${isProbe ? "probe" : "core"} ${tendril.id}: "${dir}"`);
    }
    return;
  }

  // later ticks: drain spawn queue
  while (state.spawnQueue.length > 0) {
    const { direction, parentId, depth } = state.spawnQueue.shift()!;
    const tendril = createTendril(direction, parentId, depth, 0.8);
    state.tendrils.push(tendril);
    state.events.push({
      type: "tendril_spawned",
      tendrilId: tendril.id,
      direction,
    });
    log.tendril(`spawned ${tendril.id} from ${parentId}: "${direction}"`);
  }
}

// ── 4. Sense ─────────────────────────────────────────────────────────

async function sense(
  state: SimulationState,
  substrate: NutrientFunction
): Promise<void> {
  const active = getActiveTendrils(state.tendrils);
  if (active.length === 0) return;

  const sem = new Semaphore(state.config.concurrency);

  const tasks = active.map(async (tendril) => {
    // check API budget before each call
    if (state.resources.apiCallsUsed >= state.resources.apiCallBudget) {
      tendril.status = "dormant";
      return;
    }

    await sem.acquire();
    try {
      tendril.status = "sensing";

      // explore (substrate receives trail so it can avoid slimed URLs)
      state.resources.apiCallsUsed++;
      log.dim(`  ${tendril.id} exploring: "${tendril.direction}"`);
      const { content, payload } = await substrate.explore(
        tendril.direction,
        tendril,
        state.graph,
        state.trail
      );

      if (!content || content.length < 20) {
        starve(tendril);
        tendril.status = "exploring";
        return;
      }

      // sense (uses Claude, receives trail for context)
      state.resources.apiCallsUsed++;
      const result = await substrate.sense(
        content,
        tendril,
        state.graph,
        state.config.seed,
        state.trail
      );

      // add node for this discovery
      const node = addNode(
        state.graph,
        result.summary,
        tendril.id,
        payload,
        result.nutrient
      );
      state.events.push({
        type: "node_added",
        nodeId: node.id,
        content: result.summary.slice(0, 60),
      });

      // add edge from previous head to new node
      if (tendril.headNodeId) {
        const edge = addEdge(state.graph, tendril.headNodeId, node.id);
        tendril.trail.push(edge.id);
        state.events.push({
          type: "edge_added",
          edgeId: edge.id,
          source: tendril.headNodeId,
          target: node.id,
        });
      }

      tendril.headNodeId = node.id;
      tendril.totalNutrient += result.nutrient;

      // stash sense result + payload for deposit/reinforce/connect steps
      (tendril as any)._lastSense = result;
      (tendril as any)._lastPayload = payload;

      tendril.status = "exploring";
    } catch (err) {
      log.error(`  ${tendril.id} sense failed: ${err instanceof Error ? err.message : String(err)}`);
      starve(tendril);
      tendril.status = "exploring";
    } finally {
      sem.release();
    }
  });

  await Promise.allSettled(tasks);
}

// ── 5. Deposit ───────────────────────────────────────────────────────
// Leave slime trail wherever we've been. The environment remembers.

function depositTrail(state: SimulationState): void {
  for (const tendril of state.tendrils) {
    const result = (tendril as any)._lastSense;
    const payload = (tendril as any)._lastPayload;
    if (!result) continue;

    // deposit trail mark on the direction we explored
    const dirMark = deposit(state.trail, tendril.direction, tendril.id, 0.8);
    state.events.push({
      type: "trail_deposit",
      location: tendril.direction,
      intensity: dirMark.intensity,
    });

    // deposit trail mark on the URL if available (web substrate)
    if (payload && typeof payload === "object" && "url" in payload) {
      const url = (payload as Record<string, unknown>).url;
      if (typeof url === "string") {
        deposit(state.trail, url, tendril.id, 1.0);
      }
    }

    // deposit on the summary content (lighter mark)
    if (result.summary) {
      deposit(state.trail, result.summary, tendril.id, 0.4);
    }
  }
}

// ── 6. Reinforce ─────────────────────────────────────────────────────

function reinforce(state: SimulationState): void {
  const { reinforcementBonus, trailAvoidance, fanOutMultiplier } = state.config;

  for (const tendril of state.tendrils) {
    const result = (tendril as any)._lastSense;
    if (!result) continue;
    delete (tendril as any)._lastSense;
    delete (tendril as any)._lastPayload;

    if (result.nutrient > 0.5) {
      // high nutrient: boost trail edges
      feed(tendril);
      awardEnergy(tendril, result.nutrient * reinforcementBonus);

      for (const edgeId of tendril.trail) {
        const edge = state.graph.edges.get(edgeId);
        if (edge) {
          edge.conductivity = Math.min(1, edge.conductivity + result.nutrient * reinforcementBonus);
          edge.reinforcements++;
          state.events.push({
            type: "reinforce",
            edgeId,
            conductivity: edge.conductivity,
          });
        }
      }

      // Nutrient-triggered fan-out: rich finds cause a local burst of
      // new pseudopods. The richer the nutrient, the bigger the burst.
      // nutrient 0.5-0.7 → 2 sub-tendrils (normal branching)
      // nutrient 0.7-0.9 → more branches (found something good)
      // nutrient 0.9-1.0 → full fan-out burst (hit a vein of gold)
      const branchCount = result.nutrient >= 0.9
        ? Math.min(result.directions.length, fanOutMultiplier + 1)
        : result.nutrient >= 0.7
        ? Math.min(result.directions.length, Math.ceil(fanOutMultiplier * 0.75))
        : Math.min(result.directions.length, 2);

      // filter by trail novelty — avoid slimed territory
      const ranked = rankByNovelty(
        state.trail,
        result.directions,
        state.config.trailDecayRate
      );

      let spawned = 0;
      for (const { direction, trailIntensity } of ranked) {
        if (spawned >= branchCount) break;

        if (trailIntensity > trailAvoidance) {
          // too much slime — skip this direction
          state.events.push({
            type: "trail_avoid",
            tendrilId: tendril.id,
            direction,
            intensity: trailIntensity,
          });
          log.decay(`avoided slimed direction: "${direction.slice(0, 40)}" (${trailIntensity.toFixed(2)})`);
          continue;
        }

        // nutrient-triggered probes get slightly less energy than normal spawns
        // they're exploratory, not committed
        const probeEnergy = result.nutrient >= 0.9 ? 0.7 : 0.8;

        state.spawnQueue.push({
          direction,
          parentId: tendril.id,
          depth: tendril.depth + 1,
        });
        spawned++;
      }

      if (spawned > 2) {
        log.tendril(`nutrient burst from ${tendril.id}! (${result.nutrient.toFixed(2)}) → ${spawned} new pseudopods`);
      }
    } else {
      // low nutrient: drain energy
      starve(tendril);
      drainEnergy(tendril, 0.2);
    }
  }
}

// ── 7. Connect ───────────────────────────────────────────────────────

function connect(state: SimulationState): void {
  for (const tendril of state.tendrils) {
    const result = (tendril as any)._connectIds as string[] | undefined;
    if (!result) continue;
    delete (tendril as any)._connectIds;

    if (tendril.headNodeId) {
      for (const relatedId of result) {
        if (
          state.graph.nodes.has(relatedId) &&
          relatedId !== tendril.headNodeId
        ) {
          const edge = addEdge(state.graph, tendril.headNodeId, relatedId, 0.3);
          state.events.push({
            type: "cross_link",
            edgeId: edge.id,
            source: tendril.headNodeId,
            target: relatedId,
          });
          log.connect(`cross-link ${tendril.headNodeId} ⟷ ${relatedId}`);
        }
      }
    }
  }

  // Also handle sense results that were just processed
  for (const tendril of state.tendrils) {
    const result = (tendril as any).__relatedNodes as string[] | undefined;
    if (result && tendril.headNodeId) {
      for (const relatedId of result) {
        if (
          state.graph.nodes.has(relatedId) &&
          relatedId !== tendril.headNodeId
        ) {
          const edge = addEdge(state.graph, tendril.headNodeId, relatedId, 0.3);
          state.events.push({
            type: "cross_link",
            edgeId: edge.id,
            source: tendril.headNodeId,
            target: relatedId,
          });
          log.connect(`cross-link ${tendril.headNodeId} ⟷ ${relatedId}`);
        }
      }
      delete (tendril as any).__relatedNodes;
    }
  }
}

// ── 8. Pulse ─────────────────────────────────────────────────────────

function pulse(state: SimulationState): void {
  const { pulseAmplitude, pulsePeriod } = state.config;
  const phase = Math.sin((2 * Math.PI * state.tick) / pulsePeriod);
  const isOutward = phase > 0;

  state.events.push({
    type: "pulse",
    tick: state.tick,
    phase: isOutward ? "outward" : "inward",
  });

  for (const node of state.graph.nodes.values()) {
    const edges = getEdgesForNode(state.graph, node.id);
    const avgConductivity =
      edges.length > 0
        ? edges.reduce((s, e) => s + e.conductivity, 0) / edges.length
        : 0;

    if (isOutward) {
      // outward phase: push energy to frontier nodes (fewer connections)
      node.flow += pulseAmplitude * (1 - avgConductivity) * phase;
    } else {
      // inward phase: concentrate in high-value nodes (high nutrient, many connections)
      node.flow += pulseAmplitude * node.nutrient * avgConductivity * Math.abs(phase);
    }

    node.flow = Math.max(0, Math.min(2, node.flow));
  }

  log.pulse(
    `pulse tick ${state.tick}: ${isOutward ? "↗ outward" : "↙ inward"} (${phase.toFixed(2)})`
  );
}

// ── 9. Check termination ─────────────────────────────────────────────

function checkTermination(state: SimulationState): void {
  const active = getActiveTendrils(state.tendrils);

  if (active.length === 0 && state.spawnQueue.length === 0) {
    state.done = true;
    state.stopReason = "all tendrils dead";
    return;
  }

  if (state.tick >= state.config.maxTicks) {
    state.done = true;
    state.stopReason = "max ticks reached";
    return;
  }

  if (state.resources.apiCallsUsed >= state.resources.apiCallBudget) {
    state.done = true;
    state.stopReason = "API budget exhausted";
    return;
  }

  // stability check: if no new events in this tick (besides pulse/decay/trail)
  const significantEvents = state.events.filter(
    (e) =>
      e.type === "node_added" ||
      e.type === "edge_added" ||
      e.type === "cross_link" ||
      e.type === "tendril_spawned"
  );
  if (state.tick > 3 && significantEvents.length === 0 && state.spawnQueue.length === 0) {
    state.done = true;
    state.stopReason = "network stabilized";
  }
}

// ── Run simulation ───────────────────────────────────────────────────

export async function runSimulation(
  config: SimulationConfig,
  substrate: NutrientFunction,
  onTick?: (state: SimulationState) => void
): Promise<GraphJSON> {
  const client = new Anthropic();

  // load or create trail store
  const trail = config.trailPath
    ? await loadTrail(config.trailPath)
    : createTrailStore();

  const state = createSimulation(config, trail);

  log.info(`\n▓▓ Physarum Simulation ▓▓`);
  log.info(`Seed: "${config.seed}"`);
  log.info(`Budget: ${config.maxApiCalls} API calls, ${config.maxTicks} ticks`);
  log.dim(`Concurrency: ${config.concurrency}, Decay: ${config.decayRate}`);
  log.dim(`Trail: ${trail.marks.size} existing marks, decay ${config.trailDecayRate}, avoidance ${config.trailAvoidance}`);
  if (config.trailPath) log.dim(`Trail path: ${config.trailPath}`);
  log.dim("");

  while (!state.done) {
    state.events = []; // clear events for this tick
    log.info(`\n── tick ${state.tick} ──`);

    // 1. Decay (includes trail decay)
    decay(state);

    // 2. Prune
    prune(state);

    // 3. Spawn
    await spawn(state, client);

    // 4. Sense — store related node IDs for connect step
    const activeBefore = getActiveTendrils(state.tendrils);
    await sense(state, substrate);

    // After sense, stash relatedNodeIds for connect step
    for (const tendril of activeBefore) {
      const senseResult = (tendril as any)._lastSense;
      if (senseResult && senseResult.relatedNodeIds) {
        (tendril as any).__relatedNodes = senseResult.relatedNodeIds;
      }
    }

    // 5. Deposit — leave slime trail
    depositTrail(state);

    // 6. Reinforce (now filters directions by trail novelty)
    reinforce(state);

    // 7. Connect
    connect(state);

    // 8. Pulse
    pulse(state);

    // 9. Render / termination check
    checkTermination(state);

    log.dim(
      `  nodes: ${state.graph.nodes.size} | edges: ${state.graph.edges.size} | ` +
        `tendrils: ${getActiveTendrils(state.tendrils).length} | ` +
        `trail: ${state.trail.marks.size} marks | ` +
        `API: ${state.resources.apiCallsUsed}/${state.resources.apiCallBudget}`
    );

    if (onTick) onTick(state);

    state.tick++;

    // periodically save trail (every 5 ticks)
    if (config.trailPath && state.tick % 5 === 0) {
      await saveTrail(state.trail, config.trailPath);
    }
  }

  // final trail save
  if (config.trailPath) {
    await saveTrail(state.trail, config.trailPath);
  }

  log.success(`\n▓▓ Simulation complete: ${state.stopReason} ▓▓`);
  log.success(
    `Final: ${state.graph.nodes.size} nodes, ${state.graph.edges.size} edges, ` +
      `${state.trail.marks.size} trail marks, ` +
      `${state.resources.apiCallsUsed} API calls used`
  );

  return toJSON(
    state.graph,
    config.seed,
    state.tick,
    state.tendrils,
    state.resources.apiCallsUsed,
    state.trail
  );
}
