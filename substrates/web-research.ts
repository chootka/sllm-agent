/**
 * Web research substrate — DuckDuckGo search + Claude scoring.
 *
 * explore: searches DDG, fetches top result content (avoids slimed URLs)
 * sense: Claude evaluates content relevance, scores nutrient, proposes directions
 *        (with trail context so it avoids proposing already-explored territory)
 */

import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { NutrientFunction } from "../nutrient.ts";
import type { PhysarumGraph, SenseResult, Tendril } from "../types.ts";
import type { TrailStore } from "../trail.ts";
import { sense as senseTrail, trailSummary } from "../trail.ts";
import { log } from "../log.ts";

const client = new Anthropic();

// ── Zod schema for sense response ────────────────────────────────────

const SenseResponseSchema = z.object({
  nutrient: z.number().min(0).max(1),
  summary: z.string(),
  directions: z.array(z.string()),
  relatedNodeIds: z.array(z.string()),
});

// ── URL extraction from DDG redirects ────────────────────────────────

/** DDG wraps results in redirect URLs like //duckduckgo.com/l/?uddg=https%3A... */
function extractUrl(raw: string): string {
  // decode HTML entities first (&amp; → &)
  const decoded = raw.replace(/&amp;/g, "&");

  // try to extract the uddg parameter (the actual target URL)
  const uddgMatch = decoded.match(/[?&]uddg=([^&]+)/);
  if (uddgMatch) {
    return decodeURIComponent(uddgMatch[1]);
  }

  // if it's a protocol-relative URL, add https:
  if (decoded.startsWith("//")) {
    return "https:" + decoded;
  }

  return decoded;
}

// ── DuckDuckGo search ────────────────────────────────────────────────

async function searchDDG(query: string): Promise<{ title: string; url: string; snippet: string }[]> {
  try {
    const resp = await fetch(
      `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
      {
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; PhysarumAgent/1.0)",
        },
        signal: AbortSignal.timeout(10000),
      }
    );
    const html = await resp.text();

    const results: { title: string; url: string; snippet: string }[] = [];
    const resultRegex = /<a rel="nofollow" class="result__a" href="([^"]+)"[^>]*>(.+?)<\/a>/g;
    const snippetRegex = /<a class="result__snippet"[^>]*>(.+?)<\/a>/g;

    const urls: string[] = [];
    const titles: string[] = [];
    let match;
    while ((match = resultRegex.exec(html)) !== null) {
      urls.push(match[1]);
      titles.push(match[2].replace(/<[^>]+>/g, ""));
    }
    const snippets: string[] = [];
    while ((match = snippetRegex.exec(html)) !== null) {
      snippets.push(match[1].replace(/<[^>]+>/g, ""));
    }

    for (let i = 0; i < Math.min(urls.length, 8); i++) {
      results.push({
        title: titles[i] || "Untitled",
        url: extractUrl(urls[i]),
        snippet: snippets[i] || "",
      });
    }

    return results;
  } catch (err) {
    log.error(`DDG search failed: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

// ── Fetch page content ───────────────────────────────────────────────

async function fetchPage(url: string): Promise<string> {
  try {
    const resp = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; PhysarumAgent/1.0)",
      },
      signal: AbortSignal.timeout(15000),
    });
    const html = await resp.text();

    const text = html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
      .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, "")
      .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, "")
      .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/&[a-z]+;/gi, " ")
      .replace(/\s+/g, " ")
      .trim();

    return text.slice(0, 6000);
  } catch (err) {
    log.error(`Fetch failed for ${url}: ${err instanceof Error ? err.message : String(err)}`);
    return "";
  }
}

// ── Build context of existing nodes for sense ────────────────────────

function buildNodeContext(graph: PhysarumGraph): string {
  const nodes = Array.from(graph.nodes.values());
  if (nodes.length === 0) return "No existing nodes yet.";

  return nodes
    .map((n) => `[${n.id}] (nutrient: ${n.nutrient.toFixed(2)}) ${n.content}`)
    .join("\n");
}

// ── The substrate ────────────────────────────────────────────────────

export const webResearch: NutrientFunction = {
  async explore(direction, _tendril, _graph, trail) {
    log.dim(`    🔍 searching: "${direction}"`);
    const results = await searchDDG(direction);

    if (results.length === 0) {
      return { content: "", payload: { query: direction, results: [] } };
    }

    // Pick the first result whose URL isn't heavily slimed.
    // If everything is slimed, fall back to the top result anyway —
    // better to retread a little than return nothing.
    let chosen = results[0];
    for (const r of results) {
      const urlIntensity = senseTrail(trail, r.url);
      if (urlIntensity < 0.3) {
        chosen = r;
        break;
      }
      log.decay(`skipping slimed URL: ${r.url.slice(0, 50)}… (${urlIntensity.toFixed(2)})`);
    }

    log.dim(`    📄 fetching: ${chosen.url.slice(0, 70)}...`);
    const pageContent = await fetchPage(chosen.url);

    const content = pageContent
      ? `# ${chosen.title}\nURL: ${chosen.url}\n\n${pageContent}`
      : `# ${chosen.title}\nURL: ${chosen.url}\nSnippet: ${chosen.snippet}`;

    // also include snippets from other results for context
    const otherSnippets = results
      .filter((r) => r !== chosen)
      .slice(0, 4)
      .map((r) => `- ${r.title}: ${r.snippet}`)
      .join("\n");

    return {
      content: content + (otherSnippets ? `\n\n## Other results:\n${otherSnippets}` : ""),
      payload: { query: direction, url: chosen.url, title: chosen.title, allResults: results },
    };
  },

  async sense(content, tendril, graph, seed, trail) {
    const existingNodes = buildNodeContext(graph);
    const trailContext = trailSummary(trail);

    const response = await client.messages.create({
      model: "claude-sonnet-4-5-20250929",
      max_tokens: 1024,
      messages: [
        {
          role: "user",
          content: `You are a research evaluator for a Physarum-inspired exploration agent.

The organism is exploring: "${seed}"
This tendril's direction: "${tendril.direction}"
Tendril depth: ${tendril.depth}

## Existing nodes in the network:
${existingNodes}

## Slime trail (already-explored territory):
${trailContext}

## Content found:
${content.slice(0, 4000)}

## Your task:
Evaluate this content and respond with ONLY a JSON object (no markdown, no backticks):

{
  "nutrient": <0.0-1.0 how relevant/valuable this is to the seed topic>,
  "summary": "<1-2 sentence summary of what was found>",
  "directions": ["<3-5 new directions to explore based on this — more if the content is rich>"],
  "relatedNodeIds": ["<IDs of existing nodes this content connects to, if any>"]
}

IMPORTANT for directions: Propose directions into UNEXPLORED territory.
Check the slime trail above — if an area has been explored, go somewhere else.
The most interesting signal is the ABSENCE of slime — the gaps in what's been covered.
Propose directions that complement rather than duplicate existing exploration.

Scoring guide:
- 0.0-0.2: irrelevant or empty content
- 0.3-0.5: tangentially related
- 0.6-0.8: directly relevant, new information
- 0.9-1.0: highly valuable, key insight or connection`,
        },
      ],
    });

    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");

    try {
      // strip markdown code fences if present
      const cleaned = text.replace(/```json?\s*/g, "").replace(/```\s*/g, "").trim();
      const parsed = JSON.parse(cleaned);
      const validated = SenseResponseSchema.parse(parsed);
      return validated;
    } catch (err) {
      log.warn(`  sense parse failed for ${tendril.id}: ${err instanceof Error ? err.message : String(err)}`);
      // fallback: extract what we can
      return {
        nutrient: 0.3,
        summary: content.slice(0, 100),
        directions: [],
        relatedNodeIds: [],
      };
    }
  },
};
