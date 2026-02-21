/**
 * Externalized memory — the slime trail.
 *
 * Physarum doesn't remember anything internally. It secretes a physical
 * residue wherever it has been, then senses that residue to avoid
 * retreading the same ground. The memory is in the environment,
 * not in the organism.
 *
 * Trail marks are keyed by arbitrary location strings — a search query,
 * a URL, a direction phrase, a content fingerprint. The substrate decides
 * what to mark. The trail store just manages intensity and decay.
 *
 * Persistence: the trail saves to / loads from a JSON file on disk.
 * Multiple agent instances can share the same trail file — stigmergy.
 * No coordination protocol needed. Just: "I sense slime here, I go
 * the other way."
 */

import { readFile, writeFile } from "node:fs/promises";
import type { TrailMark } from "./types.ts";
import { log } from "./log.ts";

// ── Trail store ──────────────────────────────────────────────────────

export interface TrailStore {
  marks: Map<string, TrailMark>;
}

export function createTrailStore(): TrailStore {
  return { marks: new Map() };
}

/**
 * Deposit a trail mark. If one already exists at this location,
 * boost its intensity (like ants reinforcing a pheromone path).
 */
export function deposit(
  store: TrailStore,
  location: string,
  agentId: string,
  intensity: number = 1.0
): TrailMark {
  const existing = store.marks.get(location);
  if (existing) {
    existing.intensity = Math.min(2.0, existing.intensity + intensity);
    existing.timestamp = Date.now();
    existing.visits++;
    return existing;
  }

  const mark: TrailMark = {
    location,
    intensity,
    timestamp: Date.now(),
    agentId,
    visits: 1,
  };
  store.marks.set(location, mark);
  return mark;
}

/**
 * Sense the trail intensity at a location. Returns 0 if no trail.
 * Applies time-based decay to the reading (but doesn't mutate the mark).
 */
export function sense(
  store: TrailStore,
  location: string,
  decayRate: number = 0.001
): number {
  const mark = store.marks.get(location);
  if (!mark) return 0;

  const age = (Date.now() - mark.timestamp) / 1000; // seconds
  return mark.intensity * Math.exp(-decayRate * age);
}

/**
 * Sense with fuzzy matching — check all marks and return the highest
 * intensity among locations that share significant words with the query.
 * This catches "mesh networking protocols" avoiding "mesh network topology"
 * even though the strings don't exactly match.
 */
export function senseFuzzy(
  store: TrailStore,
  query: string,
  decayRate: number = 0.001
): number {
  const queryWords = normalizeToWords(query);
  if (queryWords.size === 0) return 0;

  let maxIntensity = 0;

  for (const [location, mark] of store.marks) {
    const locationWords = normalizeToWords(location);
    const overlap = intersection(queryWords, locationWords);
    const similarity = overlap.size / Math.max(queryWords.size, locationWords.size);

    if (similarity > 0.4) {
      const age = (Date.now() - mark.timestamp) / 1000;
      const effective = mark.intensity * Math.exp(-decayRate * age) * similarity;
      maxIntensity = Math.max(maxIntensity, effective);
    }
  }

  return maxIntensity;
}

/**
 * Decay all trail marks by a fixed amount per tick.
 * Remove marks that have faded below threshold.
 */
export function decayAll(
  store: TrailStore,
  decayRate: number,
  pruneThreshold: number = 0.01
): number {
  let pruned = 0;

  for (const [location, mark] of store.marks) {
    mark.intensity *= 1 - decayRate;
    if (mark.intensity < pruneThreshold) {
      store.marks.delete(location);
      pruned++;
    }
  }

  return pruned;
}

/**
 * Get a summary of the trail for including in LLM prompts.
 * Returns the most intense locations, so the LLM knows what's
 * already been explored.
 */
export function trailSummary(store: TrailStore, maxItems: number = 15): string {
  if (store.marks.size === 0) return "No trail yet — unexplored territory everywhere.";

  const sorted = Array.from(store.marks.values())
    .sort((a, b) => b.intensity - a.intensity)
    .slice(0, maxItems);

  const lines = sorted.map((m) => {
    const bar = intensityBar(m.intensity);
    return `  ${bar} ${m.location} (${m.visits}x)`;
  });

  return `Already explored (${store.marks.size} locations marked):\n${lines.join("\n")}`;
}

/**
 * Score a set of proposed directions against the trail.
 * Returns directions sorted by novelty (least-explored first),
 * with trail intensity attached.
 */
export function rankByNovelty(
  store: TrailStore,
  directions: string[],
  trailDecayRate: number = 0.001
): { direction: string; trailIntensity: number }[] {
  return directions
    .map((direction) => ({
      direction,
      trailIntensity: senseFuzzy(store, direction, trailDecayRate),
    }))
    .sort((a, b) => a.trailIntensity - b.trailIntensity);
}

// ── Persistence ──────────────────────────────────────────────────────

interface TrailJSON {
  version: 1;
  exportedAt: string;
  marks: TrailMark[];
}

export async function saveTrail(
  store: TrailStore,
  path: string
): Promise<void> {
  const data: TrailJSON = {
    version: 1,
    exportedAt: new Date().toISOString(),
    marks: Array.from(store.marks.values()),
  };
  await writeFile(path, JSON.stringify(data, null, 2));
  log.dim(`  trail saved: ${store.marks.size} marks → ${path}`);
}

export async function loadTrail(path: string): Promise<TrailStore> {
  try {
    const raw = await readFile(path, "utf-8");
    const data: TrailJSON = JSON.parse(raw);

    const store = createTrailStore();
    for (const mark of data.marks) {
      store.marks.set(mark.location, mark);
    }

    log.info(`  trail loaded: ${store.marks.size} marks from ${path}`);
    return store;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      log.dim(`  no existing trail at ${path} — starting fresh`);
      return createTrailStore();
    }
    throw err;
  }
}

// ── Helpers ──────────────────────────────────────────────────────────

const STOP_WORDS = new Set([
  "the", "a", "an", "and", "or", "but", "in", "on", "at", "to", "for",
  "of", "with", "by", "from", "as", "is", "was", "are", "were", "be",
  "been", "being", "have", "has", "had", "do", "does", "did", "will",
  "would", "could", "should", "may", "might", "can", "this", "that",
  "these", "those", "it", "its", "not", "no", "how", "what", "which",
]);

/** Crude suffix stemming — just enough to catch networking/network, protocols/protocol */
function stem(word: string): string {
  return word
    .replace(/ing$/, "")
    .replace(/tion$/, "t")
    .replace(/sion$/, "s")
    .replace(/ment$/, "")
    .replace(/ness$/, "")
    .replace(/ity$/, "")
    .replace(/ies$/, "y")
    .replace(/es$/, "")
    .replace(/s$/, "");
}

function normalizeToWords(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, "")
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOP_WORDS.has(w))
      .map(stem)
  );
}

function intersection<T>(a: Set<T>, b: Set<T>): Set<T> {
  const result = new Set<T>();
  for (const item of a) {
    if (b.has(item)) result.add(item);
  }
  return result;
}

function intensityBar(intensity: number): string {
  const capped = Math.min(2, intensity);
  const blocks = Math.round(capped * 4);
  return "▓".repeat(blocks) + "░".repeat(8 - blocks);
}
