/**
 * Graph operations — add/remove/query nodes and edges, JSON export.
 * The graph is the organism's body. Edges are tubes, nodes are junctions.
 */

import type {
  PhysarumGraph,
  PhysarumNode,
  PhysarumEdge,
  GraphJSON,
  Tendril,
} from "./types.ts";
import type { TrailStore } from "./trail.ts";

let nodeCounter = 0;
let edgeCounter = 0;

export function createGraph(): PhysarumGraph {
  return { nodes: new Map(), edges: new Map() };
}

// ── Nodes ────────────────────────────────────────────────────────────

export function addNode(
  graph: PhysarumGraph,
  content: string,
  discoveredBy: string,
  payload: unknown = null,
  nutrient: number = 0
): PhysarumNode {
  const id = `n${++nodeCounter}`;
  const node: PhysarumNode = {
    id,
    content,
    payload,
    nutrient,
    flow: 0,
    age: 0,
    discoveredBy,
    meta: {},
  };
  graph.nodes.set(id, node);
  return node;
}

export function removeNode(graph: PhysarumGraph, nodeId: string): void {
  graph.nodes.delete(nodeId);
  // remove all edges touching this node
  for (const [edgeId, edge] of graph.edges) {
    if (edge.source === nodeId || edge.target === nodeId) {
      graph.edges.delete(edgeId);
    }
  }
}

export function getNode(
  graph: PhysarumGraph,
  nodeId: string
): PhysarumNode | undefined {
  return graph.nodes.get(nodeId);
}

// ── Edges ────────────────────────────────────────────────────────────

export function addEdge(
  graph: PhysarumGraph,
  source: string,
  target: string,
  conductivity: number = 0.5
): PhysarumEdge {
  // check for existing edge between these nodes
  for (const edge of graph.edges.values()) {
    if (
      (edge.source === source && edge.target === target) ||
      (edge.source === target && edge.target === source)
    ) {
      edge.reinforcements++;
      edge.conductivity = Math.min(1, edge.conductivity + 0.1);
      return edge;
    }
  }
  const id = `e${++edgeCounter}`;
  const edge: PhysarumEdge = {
    id,
    source,
    target,
    conductivity,
    reinforcements: 0,
    age: 0,
  };
  graph.edges.set(id, edge);
  return edge;
}

export function removeEdge(graph: PhysarumGraph, edgeId: string): void {
  graph.edges.delete(edgeId);
}

export function getEdgesForNode(
  graph: PhysarumGraph,
  nodeId: string
): PhysarumEdge[] {
  const result: PhysarumEdge[] = [];
  for (const edge of graph.edges.values()) {
    if (edge.source === nodeId || edge.target === nodeId) {
      result.push(edge);
    }
  }
  return result;
}

// ── Queries ──────────────────────────────────────────────────────────

export function getOrphanedNodes(graph: PhysarumGraph): string[] {
  const connected = new Set<string>();
  for (const edge of graph.edges.values()) {
    connected.add(edge.source);
    connected.add(edge.target);
  }
  const orphans: string[] = [];
  for (const nodeId of graph.nodes.keys()) {
    if (!connected.has(nodeId) && graph.nodes.size > 1) {
      orphans.push(nodeId);
    }
  }
  return orphans;
}

export function countCrossLinks(graph: PhysarumGraph): number {
  let count = 0;
  for (const edge of graph.edges.values()) {
    const src = graph.nodes.get(edge.source);
    const tgt = graph.nodes.get(edge.target);
    if (src && tgt && src.discoveredBy !== tgt.discoveredBy) {
      count++;
    }
  }
  return count;
}

// ── Export ────────────────────────────────────────────────────────────

export function toJSON(
  graph: PhysarumGraph,
  seed: string,
  tick: number,
  tendrils: Tendril[],
  apiCallsUsed: number,
  trail?: TrailStore
): GraphJSON {
  return {
    seed,
    tick,
    nodes: Array.from(graph.nodes.values()),
    edges: Array.from(graph.edges.values()),
    tendrils,
    trail: trail ? Array.from(trail.marks.values()) : [],
    stats: {
      totalNodes: graph.nodes.size,
      totalEdges: graph.edges.size,
      crossLinks: countCrossLinks(graph),
      apiCallsUsed,
      trailMarks: trail ? trail.marks.size : 0,
    },
  };
}

/** Reset counters (for testing) */
export function resetCounters(): void {
  nodeCounter = 0;
  edgeCounter = 0;
}
