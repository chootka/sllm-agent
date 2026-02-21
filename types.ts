/**
 * Core data structures for the Physarum polycephalum simulation.
 * Everything is plain objects — no classes, no hidden state.
 */

// ── Graph ────────────────────────────────────────────────────────────

export interface PhysarumNode {
  id: string;
  content: string;
  payload: unknown;
  nutrient: number; // 0-1
  flow: number;
  age: number;
  discoveredBy: string; // tendril id
  meta: Record<string, unknown>;
}

export interface PhysarumEdge {
  id: string;
  source: string;
  target: string;
  conductivity: number; // 0-1
  reinforcements: number;
  age: number;
}

export interface PhysarumGraph {
  nodes: Map<string, PhysarumNode>;
  edges: Map<string, PhysarumEdge>;
}

// ── Tendrils ─────────────────────────────────────────────────────────

export type TendrilStatus = "exploring" | "sensing" | "dormant" | "dead";

export interface Tendril {
  id: string;
  headNodeId: string | null;
  trail: string[]; // edge ids
  energy: number;
  totalNutrient: number;
  status: TendrilStatus;
  starvation: number;
  direction: string; // natural language
  depth: number;
  parentId: string | null;
}

// ── Resource management ──────────────────────────────────────────────

export interface ResourcePool {
  totalEnergy: number;
  distributed: number;
  apiCallBudget: number;
  apiCallsUsed: number;
}

// ── Configuration ────────────────────────────────────────────────────

export interface SimulationConfig {
  seed: string;
  initialTendrils: number;
  maxTicks: number;
  concurrency: number;
  decayRate: number;
  pulseAmplitude: number;
  pulsePeriod: number;
  pruneThreshold: number;
  starvationLimit: number;
  reinforcementBonus: number;
  maxApiCalls: number;
  noRender: boolean;
  trailPath: string | null; // path for persistent trail file
  trailDecayRate: number; // how fast trail marks fade (0-1 per tick)
  trailAvoidance: number; // how strongly tendrils avoid slimed areas (0-1)
  fanOutMultiplier: number; // how many extra probes to send during fan-out (2 = 2x initial)
  mode: "explore" | "solve" | "sense"; // simulation mode
  goals: string[]; // food sources for solver mode
  inputFile: string | null; // input file for sensor mode (null = stdin)
  batchSize: number; // lines per tick in sensor mode
}

export const DEFAULT_CONFIG: Omit<SimulationConfig, "seed"> = {
  initialTendrils: 4,
  maxTicks: 30,
  concurrency: 3,
  decayRate: 0.05,
  pulseAmplitude: 0.3,
  pulsePeriod: 6,
  pruneThreshold: 0.05,
  starvationLimit: 3,
  reinforcementBonus: 0.2,
  maxApiCalls: 50,
  noRender: false,
  trailPath: null,
  trailDecayRate: 0.03,
  trailAvoidance: 0.6,
  fanOutMultiplier: 2,
  mode: "explore",
  goals: [],
  inputFile: null,
  batchSize: 5,
};

// ── Simulation events (for render + logging) ─────────────────────────

export type SimEvent =
  | { type: "node_added"; nodeId: string; content: string }
  | { type: "edge_added"; edgeId: string; source: string; target: string }
  | { type: "edge_pruned"; edgeId: string }
  | { type: "tendril_spawned"; tendrilId: string; direction: string }
  | { type: "tendril_died"; tendrilId: string; reason: string }
  | { type: "cross_link"; edgeId: string; source: string; target: string }
  | { type: "pulse"; tick: number; phase: "outward" | "inward" }
  | { type: "reinforce"; edgeId: string; conductivity: number }
  | { type: "trail_deposit"; location: string; intensity: number }
  | { type: "trail_avoid"; tendrilId: string; direction: string; intensity: number };

// ── Slime trail (externalized memory) ────────────────────────────────

export interface TrailMark {
  location: string; // arbitrary key: direction, URL, content hash
  intensity: number; // current strength (decays over time)
  timestamp: number; // ms since epoch
  agentId: string; // which agent/tendril deposited this
  visits: number; // how many times this location was marked
}

// ── Sense result (returned by nutrient functions) ────────────────────

export interface SenseResult {
  nutrient: number; // 0-1
  summary: string;
  directions: string[]; // new directions to explore
  relatedNodeIds: string[]; // existing nodes this connects to
  goalScores?: Record<string, number>; // per-goal proximity scores (solver mode)
  patterns?: string[]; // recurring patterns detected (sensor mode)
}

// ── Graph JSON export format ─────────────────────────────────────────

export interface GraphJSON {
  seed: string;
  tick: number;
  nodes: PhysarumNode[];
  edges: PhysarumEdge[];
  tendrils: Tendril[];
  trail: TrailMark[];
  stats: {
    totalNodes: number;
    totalEdges: number;
    crossLinks: number;
    apiCallsUsed: number;
    trailMarks: number;
  };
}
