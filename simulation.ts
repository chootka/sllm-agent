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
  SenseResult,
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

// ── Retry with backoff for rate limits ───────────────────────────────
//
// Wraps any async call that might hit Anthropic's rate limit (HTTP 429).
// On 429: wait, then retry. On anything else: throw immediately.
//
// Backoff schedule (if no retry-after header):
//   attempt 0 → wait 2s
//   attempt 1 → wait 4s
//   attempt 2 → wait 8s
//   (capped at 30s)
//
// If the API returns a retry-after header, we use that instead.

async function withRetry<T>(fn: () => Promise<T>, label: string, maxRetries = 3): Promise<T> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      // detect rate limits — Anthropic SDK throws with status 429,
      // but also check the message in case the error shape differs
      const status = err?.status ?? err?.statusCode;
      const isRateLimit = status === 429 ||
        (err?.message && typeof err.message === "string" && err.message.includes("rate_limit"));

      if (isRateLimit && attempt < maxRetries) {
        const retryAfter = err?.headers?.["retry-after"];
        const waitMs = retryAfter
          ? parseFloat(retryAfter) * 1000
          : Math.min(2000 * Math.pow(2, attempt), 30000); // exponential backoff
        log.warn(`  ${label}: rate limited, waiting ${(waitMs / 1000).toFixed(1)}s (attempt ${attempt + 1}/${maxRetries})`);
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }

      // not a rate limit, or out of retries — let the caller handle it
      throw err;
    }
  }
  throw new Error("unreachable");
}

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

  const response = await withRetry(
    () => client.messages.create({
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
    }),
    "fan-out"
  );

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

// ── Solver: goal-directed direction generation ──────────────────────

async function generateGoalDirections(
  seed: string,
  goals: string[],
  count: number,
  client: Anthropic,
  trail: TrailStore
): Promise<string[]> {
  const trailContext = trailSummary(trail);
  const perGoal = Math.max(1, Math.floor(count / goals.length));
  const extra = count - perGoal * goals.length;

  const response = await withRetry(
    () => client.messages.create({
      model: "claude-sonnet-4-5-20250929",
      max_tokens: 2048,
      messages: [
        {
          role: "user",
          content: `You are a research exploration planner for a Physarum-inspired solver agent. The organism needs to find paths TOWARD specific goals and build bridges BETWEEN them.

${seed ? `Context: "${seed}"\n` : ""}
## Goals (food sources):
${goals.map((g, i) => `${i + 1}. ${g}`).join("\n")}

Generate ${count} exploration directions — at least ${perGoal} targeting each goal specifically, plus ${extra} that bridge between goals.

For each goal: directions should seek content that directly advances understanding of that goal.
For bridges: directions should connect two or more goals — look for intersections, shared principles, analogies.

## Slime trail (already explored):
${trailContext}

Avoid directions that overlap with the slime trail. Explore the gaps.

Respond with ONLY a JSON array of ${count} strings, each a short (5-15 word) exploration direction. No other text.`,
        },
      ],
    }),
    "goal-directions"
  );

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
    // fallback
  }

  // fallback: one direction per goal
  return goals.map((g) => `explore: ${g}`);
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
  inputIterator?: AsyncIterableIterator<string>; // sensor mode: line iterator
  inputDone?: boolean; // sensor mode: stream exhausted
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
  const { initialTendrils, fanOutMultiplier, mode } = state.config;

  // ── Sensor mode: read batch from input stream each tick ──
  if (mode === "sense") {
    if (!state.inputIterator || state.inputDone) return;

    const batch: string[] = [];
    for (let i = 0; i < state.config.batchSize; i++) {
      const { value, done } = await state.inputIterator.next();
      if (done) {
        state.inputDone = true;
        break;
      }
      const line = (value as string).trim();
      if (line.length > 0) batch.push(line);
    }

    if (batch.length === 0) {
      state.inputDone = true;
      return;
    }

    log.tendril(`sensor: ingesting ${batch.length} lines`);
    for (const line of batch) {
      const tendril = createTendril(line, null, 0, 0.8);
      state.tendrils.push(tendril);
      state.events.push({
        type: "tendril_spawned",
        tendrilId: tendril.id,
        direction: line,
      });
      log.tendril(`sensor ${tendril.id}: "${line.slice(0, 60)}"`);
    }
    return;
  }

  // ── Tick 0: initial burst (explore + solve modes) ──
  if (state.tick === 0) {
    const totalProbes = initialTendrils * fanOutMultiplier;
    state.resources.apiCallsUsed++;

    if (mode === "solve") {
      // Solver: generate goal-directed directions
      log.tendril(`solver: extending ${totalProbes} pseudopods toward ${state.config.goals.length} goals`);
      const directions = await generateGoalDirections(
        state.config.seed,
        state.config.goals,
        totalProbes,
        client,
        state.trail
      );

      for (let i = 0; i < directions.length; i++) {
        const tendril = createTendril(directions[i], null, 0, 1.0);
        state.tendrils.push(tendril);
        state.events.push({
          type: "tendril_spawned",
          tendrilId: tendril.id,
          direction: directions[i],
        });
        log.tendril(`goal-seeker ${tendril.id}: "${directions[i]}"`);
      }
    } else {
      // Explorer: existing fan-out burst
      log.tendril(`fan-out: extending ${totalProbes} pseudopods in all directions`);
      const directions = await generateFanOutDirections(
        state.config.seed,
        totalProbes,
        client,
        state.trail
      );

      for (let i = 0; i < directions.length; i++) {
        const dir = directions[i];
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
      const { content, payload } = await withRetry(
        () => substrate.explore(
          tendril.direction,
          tendril,
          state.graph,
          state.trail
        ),
        tendril.id
      );

      if (!content || content.length < 20) {
        starve(tendril);
        tendril.status = "exploring";
        return;
      }

      // sense (uses Claude, receives trail for context)
      state.resources.apiCallsUsed++;
      const result = await withRetry(
        () => substrate.sense(
          content,
          tendril,
          state.graph,
          state.config.seed,
          state.trail,
          state.config
        ),
        tendril.id
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
  const { reinforcementBonus, trailAvoidance, fanOutMultiplier, mode } = state.config;

  for (const tendril of state.tendrils) {
    const result = (tendril as any)._lastSense as SenseResult | undefined;
    if (!result) continue;
    delete (tendril as any)._lastSense;
    delete (tendril as any)._lastPayload;

    // Sensor mode: base reinforcement on pattern recurrence, not just nutrient level
    const threshold = mode === "sense" ? 0.3 : 0.5;

    if (result.nutrient > threshold) {
      feed(tendril);
      awardEnergy(tendril, result.nutrient * reinforcementBonus);

      for (const edgeId of tendril.trail) {
        const edge = state.graph.edges.get(edgeId);
        if (edge) {
          let bonus = result.nutrient * reinforcementBonus;

          // Solver mode: extra boost for bridge edges
          // (source and target score high on DIFFERENT goals → highway)
          if (mode === "solve" && result.goalScores) {
            const sourceNode = edge.source ? getNode(state.graph, edge.source) : null;
            const targetNode = edge.target ? getNode(state.graph, edge.target) : null;
            const sourceGoalScores = sourceNode ? (sourceNode.meta.goalScores as Record<string, number> | undefined) : undefined;
            const targetGoalScores = targetNode ? (targetNode.meta.goalScores as Record<string, number> | undefined) : undefined;

            if (sourceGoalScores && targetGoalScores) {
              // check if they score high on different goals
              const sourceTop = Object.entries(sourceGoalScores).sort((a, b) => b[1] - a[1])[0];
              const targetTop = Object.entries(targetGoalScores).sort((a, b) => b[1] - a[1])[0];
              if (sourceTop && targetTop && sourceTop[0] !== targetTop[0] && sourceTop[1] > 0.5 && targetTop[1] > 0.5) {
                bonus *= 1.5; // bridge bonus
                log.connect(`bridge edge ${edgeId}: ${sourceTop[0]} ↔ ${targetTop[0]}`);
              }
            }
          }

          // Sensor mode: extra boost for edges involving recurring patterns
          if (mode === "sense" && result.patterns && result.patterns.length > 0) {
            bonus *= 1 + result.patterns.length * 0.1;
          }

          edge.conductivity = Math.min(1, edge.conductivity + bonus);
          edge.reinforcements++;
          state.events.push({
            type: "reinforce",
            edgeId,
            conductivity: edge.conductivity,
          });
        }
      }

      // Store goal scores on the node for solver bridge detection
      if (mode === "solve" && result.goalScores && tendril.headNodeId) {
        const node = getNode(state.graph, tendril.headNodeId);
        if (node) node.meta.goalScores = result.goalScores;
      }

      // Nutrient-triggered fan-out
      const branchCount = result.nutrient >= 0.9
        ? Math.min(result.directions.length, fanOutMultiplier + 1)
        : result.nutrient >= 0.7
        ? Math.min(result.directions.length, Math.ceil(fanOutMultiplier * 0.75))
        : Math.min(result.directions.length, 2);

      const ranked = rankByNovelty(
        state.trail,
        result.directions,
        state.config.trailDecayRate
      );

      let spawned = 0;
      for (const { direction, trailIntensity } of ranked) {
        if (spawned >= branchCount) break;

        if (trailIntensity > trailAvoidance) {
          state.events.push({
            type: "trail_avoid",
            tendrilId: tendril.id,
            direction,
            intensity: trailIntensity,
          });
          log.decay(`avoided slimed direction: "${direction.slice(0, 40)}" (${trailIntensity.toFixed(2)})`);
          continue;
        }

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
  const { mode } = state.config;

  // common: budget exhaustion
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

  // ── Sensor mode: terminate when input stream ends ──
  if (mode === "sense") {
    if (state.inputDone && active.length === 0 && state.spawnQueue.length === 0) {
      state.done = true;
      state.stopReason = "input stream exhausted";
      return;
    }
    // don't apply stability check — sensor just keeps reading
    return;
  }

  // ── Solver mode: check if all goals are reached and connected ──
  if (mode === "solve") {
    // still check all-dead
    if (active.length === 0 && state.spawnQueue.length === 0) {
      state.done = true;
      state.stopReason = "all tendrils dead";
      return;
    }

    // goal completion check
    const goals = state.config.goals;
    if (goals.length > 0 && state.tick > 3) {
      const reachedGoals = new Set<string>();
      for (const node of state.graph.nodes.values()) {
        const goalScores = node.meta.goalScores as Record<string, number> | undefined;
        if (goalScores) {
          for (const [goal, score] of Object.entries(goalScores)) {
            if (score > 0.7) reachedGoals.add(goal);
          }
        }
      }

      if (reachedGoals.size >= goals.length) {
        // all goals reached — check connectivity
        // (simplified: just check that cross-links exist)
        const crossLinks = state.events.filter((e) => e.type === "cross_link").length;
        if (crossLinks > 0 || state.graph.edges.size >= goals.length) {
          state.done = true;
          state.stopReason = "all goals reached and connected";
          return;
        }
      }
    }

    // fall through to stability check
  }

  // ── Explorer + Solver: standard termination ──
  if (active.length === 0 && state.spawnQueue.length === 0) {
    state.done = true;
    state.stopReason = "all tendrils dead";
    return;
  }

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

// ── Input stream for sensor mode ─────────────────────────────────────

async function* readLines(input: NodeJS.ReadableStream): AsyncIterableIterator<string> {
  let buffer = "";
  for await (const chunk of input) {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop()!; // keep incomplete line in buffer
    for (const line of lines) {
      yield line;
    }
  }
  if (buffer.length > 0) yield buffer;
}

async function openInputStream(config: SimulationConfig): Promise<AsyncIterableIterator<string>> {
  if (config.inputFile) {
    const { createReadStream } = await import("node:fs");
    const stream = createReadStream(config.inputFile, { encoding: "utf-8" });
    return readLines(stream);
  }
  // default: stdin
  process.stdin.setEncoding("utf-8");
  return readLines(process.stdin);
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

  // sensor mode: open input stream
  if (config.mode === "sense") {
    state.inputIterator = await openInputStream(config);
    state.inputDone = false;
  }

  const modeLabel = config.mode === "solve" ? "Solver" : config.mode === "sense" ? "Sensor" : "Explorer";
  log.info(`\n▓▓ Physarum Simulation (${modeLabel}) ▓▓`);
  log.info(`Seed: "${config.seed}"`);
  if (config.mode === "solve" && config.goals.length > 0) {
    log.info(`Goals: ${config.goals.join(", ")}`);
  }
  if (config.mode === "sense") {
    log.info(`Input: ${config.inputFile ?? "stdin"}, batch size: ${config.batchSize}`);
  }
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
