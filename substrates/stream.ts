/**
 * Stream substrate — sensor mode.
 *
 * explore: the input IS the content (lines from stdin or file)
 * sense: Claude evaluates patterns, recurring themes, and connections to existing network
 */

import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { NutrientFunction } from "../nutrient.ts";
import type { PhysarumGraph, Tendril } from "../types.ts";
import type { TrailStore } from "../trail.ts";
import { trailSummary } from "../trail.ts";
import { log } from "../log.ts";

const client = new Anthropic();

const SenseResponseSchema = z.object({
  nutrient: z.number().min(0).max(1),
  summary: z.string(),
  directions: z.array(z.string()),
  relatedNodeIds: z.array(z.string()),
  patterns: z.array(z.string()).optional(),
});

function buildNodeContext(graph: PhysarumGraph): string {
  const nodes = Array.from(graph.nodes.values());
  if (nodes.length === 0) return "No existing nodes yet.";

  return nodes
    .map((n) => `[${n.id}] (nutrient: ${n.nutrient.toFixed(2)}) ${n.content}`)
    .join("\n");
}

export const streamSubstrate: NutrientFunction = {
  async explore(direction, _tendril, _graph, _trail) {
    // In sensor mode, the direction IS the input line(s).
    // No external fetching — the input stream is the substrate.
    return {
      content: direction,
      payload: { source: "stream", raw: direction },
    };
  },

  async sense(content, tendril, graph, seed, trail, _config?) {
    const existingNodes = buildNodeContext(graph);
    const trailContext = trailSummary(trail);

    const response = await client.messages.create({
      model: "claude-sonnet-4-5-20250929",
      max_tokens: 1024,
      messages: [
        {
          role: "user",
          content: `You are a pattern-detection evaluator for a Physarum-inspired sensor agent.

The sensor is monitoring a stream${seed ? `, looking for: "${seed}"` : ""}.
This input line: "${tendril.direction}"

## Existing nodes in the network:
${existingNodes}

## Slime trail (patterns already observed):
${trailContext}

## Input content:
${content.slice(0, 4000)}

## Your task:
Evaluate this input and respond with ONLY a JSON object (no markdown, no backticks):

{
  "nutrient": <0.0-1.0 how significant/pattern-forming this input is>,
  "summary": "<1-2 sentence summary of this input's significance>",
  "directions": ["<0-3 themes or patterns this input suggests exploring further>"],
  "relatedNodeIds": ["<IDs of existing nodes this input connects to>"],
  "patterns": ["<recurring themes or patterns this input reinforces — empty if novel/one-off>"]
}

Scoring guide for sensor mode:
- 0.0-0.2: noise, one-off, no pattern connection
- 0.3-0.5: mildly interesting, weak pattern connection
- 0.6-0.8: reinforces an existing pattern or establishes a new one
- 0.9-1.0: strong recurring theme, connects multiple existing patterns

IMPORTANT: Focus on RECURRENCE and PATTERN. Content that connects to existing nodes or reinforces
observed themes is high-nutrient. Novel one-off content is low-nutrient unless it starts a new theme.`,
        },
      ],
    });

    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");

    try {
      const cleaned = text.replace(/```json?\s*/g, "").replace(/```\s*/g, "").trim();
      const parsed = JSON.parse(cleaned);
      const validated = SenseResponseSchema.parse(parsed);
      return validated;
    } catch (err) {
      log.warn(`  sensor sense parse failed for ${tendril.id}: ${err instanceof Error ? err.message : String(err)}`);
      return {
        nutrient: 0.3,
        summary: content.slice(0, 100),
        directions: [],
        relatedNodeIds: [],
        patterns: [],
      };
    }
  },
};
