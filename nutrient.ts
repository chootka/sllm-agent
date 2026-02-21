/**
 * NutrientFunction interface — the pluggable substrate abstraction.
 *
 * Each substrate implements two methods:
 * - explore: go find something (HTTP fetch, file read, API call)
 * - sense: evaluate what was found using Claude (always LLM-powered)
 *
 * This separation means the web-research substrate fetches pages,
 * but a future codebase substrate could use fs and grep instead.
 * Sensing always uses Claude.
 *
 * Both methods receive the trail store so substrates can factor in
 * externalized memory — avoid slimed territory, deposit new marks.
 */

import type { PhysarumGraph, SenseResult, SimulationConfig, Tendril } from "./types.ts";
import type { TrailStore } from "./trail.ts";

export interface NutrientFunction {
  /** Go find something in this direction. Returns raw content + metadata. */
  explore(
    direction: string,
    tendril: Tendril,
    graph: PhysarumGraph,
    trail: TrailStore
  ): Promise<{ content: string; payload: unknown }>;

  /** Evaluate found content using Claude. Returns nutrient score + new directions. */
  sense(
    content: string,
    tendril: Tendril,
    graph: PhysarumGraph,
    seed: string,
    trail: TrailStore,
    config?: SimulationConfig
  ): Promise<SenseResult>;
}
