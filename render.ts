/**
 * Live terminal visualization — ANSI escape codes, no external deps.
 *
 * Uses the alternate screen buffer so the viz stays in place and
 * doesn't pollute scrollback. When the simulation ends, we switch
 * back to the normal buffer and the terminal is clean.
 *
 * Three panels:
 * - Header: tick counter, stats
 * - Graph: force-directed 2D layout with ASCII nodes/edges
 * - Tendril list: energy bars, direction snippets
 * - Event log: ring buffer of recent events
 */

import type { SimulationState } from "./simulation.ts";
import type { PhysarumNode, PhysarumEdge, SimEvent } from "./types.ts";
import { getActiveTendrils } from "./tendril.ts";

const ESC = "\x1b";
const ALT_SCREEN_ON = `${ESC}[?1049h`;
const ALT_SCREEN_OFF = `${ESC}[?1049l`;
const CURSOR_HIDE = `${ESC}[?25l`;
const CURSOR_SHOW = `${ESC}[?25h`;
const CURSOR_HOME = `${ESC}[H`;
const CLEAR_SCREEN = `${ESC}[2J`;
const BOLD = `${ESC}[1m`;
const DIM = `${ESC}[2m`;
const RESET = `${ESC}[0m`;
const CYAN = `${ESC}[36m`;
const GREEN = `${ESC}[32m`;
const YELLOW = `${ESC}[33m`;
const RED = `${ESC}[31m`;
const MAGENTA = `${ESC}[35m`;
const WHITE = `${ESC}[37m`;

const EVENT_BUFFER_SIZE = 12;
const eventBuffer: string[] = [];
let entered = false;

/** Enter the alternate screen buffer + hide cursor. */
export function enterRenderMode(): void {
  if (entered) return;
  process.stderr.write(ALT_SCREEN_ON + CURSOR_HIDE + CLEAR_SCREEN);
  entered = true;
}

/** Leave the alternate screen buffer + restore cursor. */
export function exitRenderMode(): void {
  if (!entered) return;
  process.stderr.write(CURSOR_SHOW + ALT_SCREEN_OFF);
  entered = false;
}

// ── Simple force-directed layout ─────────────────────────────────────

interface Pos {
  x: number;
  y: number;
}

const positions = new Map<string, Pos>();

function layoutNodes(
  nodes: PhysarumNode[],
  edges: PhysarumEdge[],
  width: number,
  height: number
): Map<string, Pos> {
  // initialize new nodes at random positions
  for (const node of nodes) {
    if (!positions.has(node.id)) {
      positions.set(node.id, {
        x: Math.random() * (width - 4) + 2,
        y: Math.random() * (height - 2) + 1,
      });
    }
  }

  // remove positions for deleted nodes
  for (const id of positions.keys()) {
    if (!nodes.find((n) => n.id === id)) {
      positions.delete(id);
    }
  }

  // run a few iterations of force-directed layout
  for (let iter = 0; iter < 5; iter++) {
    const forces = new Map<string, Pos>();
    for (const node of nodes) {
      forces.set(node.id, { x: 0, y: 0 });
    }

    // repulsion between all pairs
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = positions.get(nodes[i].id)!;
        const b = positions.get(nodes[j].id)!;
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        const dist = Math.max(1, Math.sqrt(dx * dx + dy * dy));
        const force = 8 / (dist * dist);
        const fa = forces.get(nodes[i].id)!;
        const fb = forces.get(nodes[j].id)!;
        fa.x += (dx / dist) * force;
        fa.y += (dy / dist) * force;
        fb.x -= (dx / dist) * force;
        fb.y -= (dy / dist) * force;
      }
    }

    // attraction along edges
    for (const edge of edges) {
      const a = positions.get(edge.source);
      const b = positions.get(edge.target);
      if (!a || !b) continue;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const dist = Math.max(1, Math.sqrt(dx * dx + dy * dy));
      const force = dist * 0.1 * edge.conductivity;
      const fa = forces.get(edge.source)!;
      const fb = forces.get(edge.target)!;
      fa.x += (dx / dist) * force;
      fa.y += (dy / dist) * force;
      fb.x -= (dx / dist) * force;
      fb.y -= (dy / dist) * force;
    }

    // apply forces
    for (const node of nodes) {
      const pos = positions.get(node.id)!;
      const f = forces.get(node.id)!;
      pos.x = Math.max(1, Math.min(width - 2, pos.x + f.x * 0.3));
      pos.y = Math.max(1, Math.min(height - 2, pos.y + f.y * 0.3));
    }
  }

  return positions;
}

// ── Draw graph to grid ───────────────────────────────────────────────

function drawGraph(
  nodes: PhysarumNode[],
  edges: PhysarumEdge[],
  tendrilHeads: Set<string>,
  width: number,
  height: number
): string[] {
  const grid: string[][] = Array.from({ length: height }, () =>
    Array(width).fill(" ")
  );
  const colorGrid: string[][] = Array.from({ length: height }, () =>
    Array(width).fill("")
  );

  const pos = layoutNodes(nodes, edges, width, height);

  // draw edges
  for (const edge of edges) {
    const a = pos.get(edge.source);
    const b = pos.get(edge.target);
    if (!a || !b) continue;

    const steps = Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y), 1);
    const char = edge.conductivity > 0.5 ? "═" : edge.conductivity > 0.2 ? "─" : "·";
    const color = edge.conductivity > 0.5 ? WHITE : DIM;

    for (let s = 1; s < steps; s++) {
      const t = s / steps;
      const x = Math.round(a.x + (b.x - a.x) * t);
      const y = Math.round(a.y + (b.y - a.y) * t);
      if (y >= 0 && y < height && x >= 0 && x < width && grid[y][x] === " ") {
        grid[y][x] = char;
        colorGrid[y][x] = color;
      }
    }
  }

  // draw nodes (on top of edges)
  for (const node of nodes) {
    const p = pos.get(node.id);
    if (!p) continue;
    const x = Math.round(p.x);
    const y = Math.round(p.y);
    if (y < 0 || y >= height || x < 0 || x >= width) continue;

    if (tendrilHeads.has(node.id)) {
      grid[y][x] = "~";
      colorGrid[y][x] = GREEN + BOLD;
    } else if (node.nutrient > 0.7) {
      grid[y][x] = "●";
      colorGrid[y][x] = CYAN + BOLD;
    } else if (node.nutrient > 0.4) {
      grid[y][x] = "●";
      colorGrid[y][x] = CYAN;
    } else {
      grid[y][x] = "○";
      colorGrid[y][x] = DIM;
    }
  }

  // render grid to lines
  return grid.map((row, y) =>
    row.map((char, x) => `${colorGrid[y][x]}${char}${RESET}`).join("")
  );
}

// ── Energy bar ───────────────────────────────────────────────────────

function energyBar(energy: number, width: number = 10): string {
  const filled = Math.round(Math.min(1, energy) * width);
  const bar = "█".repeat(filled) + "░".repeat(width - filled);
  const color = energy > 0.6 ? GREEN : energy > 0.3 ? YELLOW : RED;
  return `${color}${bar}${RESET}`;
}

// ── Event formatting ─────────────────────────────────────────────────

function formatEvent(event: SimEvent): string {
  switch (event.type) {
    case "node_added":
      return `${GREEN}+node${RESET} ${event.nodeId}: ${event.content.slice(0, 40)}`;
    case "edge_added":
      return `${CYAN}+edge${RESET} ${event.source}→${event.target}`;
    case "edge_pruned":
      return `${DIM}-edge ${event.edgeId}${RESET}`;
    case "tendril_spawned":
      return `${GREEN}+tendril${RESET} ${event.tendrilId}: ${event.direction.slice(0, 35)}`;
    case "tendril_died":
      return `${RED}-tendril${RESET} ${event.tendrilId} (${event.reason})`;
    case "cross_link":
      return `${MAGENTA}⟷link${RESET} ${event.source}↔${event.target}`;
    case "pulse":
      return `${MAGENTA}~pulse${RESET} ${event.phase}`;
    case "reinforce":
      return `${YELLOW}↑reinforce${RESET} ${event.edgeId} → ${event.conductivity.toFixed(2)}`;
    case "trail_deposit":
      return `${DIM}▓deposit${RESET} ${event.location.slice(0, 35)} (${event.intensity.toFixed(1)})`;
    case "trail_avoid":
      return `${YELLOW}▓avoid${RESET} ${event.tendrilId}: ${event.direction.slice(0, 30)} (${event.intensity.toFixed(2)})`;
  }
}

// ── Main render function ─────────────────────────────────────────────

export function render(state: SimulationState): void {
  if (!entered) enterRenderMode();

  const cols = Math.min(process.stderr.columns || 80, 120);
  const rows = Math.min(process.stderr.rows || 40, 40);

  // add new events to buffer
  for (const event of state.events) {
    eventBuffer.push(formatEvent(event));
    if (eventBuffer.length > EVENT_BUFFER_SIZE) eventBuffer.shift();
  }

  const active = getActiveTendrils(state.tendrils);
  const tendrilHeads = new Set(
    active.map((t) => t.headNodeId).filter((id): id is string => id !== null)
  );

  const nodes = Array.from(state.graph.nodes.values());
  const edges = Array.from(state.graph.edges.values());

  // calculate layout dimensions
  const graphHeight = Math.max(8, rows - 18);
  const graphWidth = Math.max(20, cols - 4);

  const lines: string[] = [];

  // header
  const modeLabel = state.config.mode === "solve" ? "SOLVER" : state.config.mode === "sense" ? "SENSOR" : "EXPLORER";
  lines.push(
    `${BOLD}${MAGENTA}▓▓ PHYSARUM ${modeLabel} ▓▓${RESET}  ` +
      `tick ${BOLD}${state.tick}${RESET}  ` +
      `${CYAN}●${RESET} ${nodes.length} nodes  ` +
      `${WHITE}─${RESET} ${edges.length} edges  ` +
      `${GREEN}~${RESET} ${active.length}/${state.tendrils.length} tendrils  ` +
      `${DIM}▓${RESET} ${state.trail.marks.size} trail  ` +
      `API: ${state.resources.apiCallsUsed}/${state.resources.apiCallBudget}`
  );
  if (state.config.mode === "solve" && state.config.goals.length > 0) {
    lines.push(`${DIM}Goals: ${state.config.goals.join(" | ")}${RESET}`);
  }
  if (state.config.mode === "sense") {
    lines.push(`${DIM}Input: ${state.config.inputFile ?? "stdin"} (batch: ${state.config.batchSize})${RESET}`);
  }
  lines.push(`${DIM}${"─".repeat(cols - 2)}${RESET}`);

  // graph panel
  if (nodes.length > 0) {
    const graphLines = drawGraph(nodes, edges, tendrilHeads, graphWidth, graphHeight);
    lines.push(...graphLines);
  } else {
    lines.push(`${DIM}  (no nodes yet)${RESET}`);
    for (let i = 0; i < graphHeight - 1; i++) lines.push("");
  }

  lines.push(`${DIM}${"─".repeat(cols - 2)}${RESET}`);

  // tendril list
  const tendrilLines = state.tendrils
    .filter((t) => t.status !== "dead")
    .slice(0, 6)
    .map(
      (t) =>
        `  ${t.status === "sensing" ? YELLOW : GREEN}${t.id}${RESET} ` +
        `${energyBar(t.energy)} ` +
        `${DIM}${t.direction.slice(0, 40)}${t.direction.length > 40 ? "…" : ""}${RESET}`
    );
  lines.push(...tendrilLines);

  if (state.tendrils.filter((t) => t.status === "dead").length > 0) {
    lines.push(
      `  ${DIM}(${state.tendrils.filter((t) => t.status === "dead").length} dead tendrils)${RESET}`
    );
  }

  lines.push(`${DIM}${"─".repeat(cols - 2)}${RESET}`);

  // event log
  const recentEvents = eventBuffer.slice(-6);
  for (const evt of recentEvents) {
    lines.push(`  ${evt}`);
  }

  // move cursor to top-left and draw (no CLEAR — avoids flicker)
  process.stderr.write(CURSOR_HOME + CLEAR_SCREEN + lines.join("\n") + "\n");
}
