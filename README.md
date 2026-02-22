# sllm-agent

A Physarum polycephalum (slime mould) simulation engine for AI-driven research exploration. Tendrils extend outward like pseudopods, sense nutrients (relevant content), leave slime trails (externalized memory), and reinforce productive paths — the same way real slime mould solves mazes and optimizes transport networks.

## Three Modes

### Explorer (default)

Fan out from a seed topic in all directions. Map the problem space.

```
npm run explore -- "mesh networking" --budget 40 --ticks 10
```

### Solver

Define multiple goals (food sources). The organism finds efficient paths between them.

```
npm run explore -- --mode solve \
  --goals "mesh networking,solarpunk urbanism,mycelial networks" \
  --budget 15 --ticks 5
```

### Sensor

Read from a stream (stdin or file). No active exploration — the input IS the substrate. Recurring patterns get reinforced, one-off noise gets pruned.

```
cat server.log | npm run explore -- --mode sense --batch-size 10 --budget 30
npm run explore -- --mode sense --input data.txt --budget 20
```

## How It Works

Each tick runs 9 behaviors in fixed order:

1. **Decay** — edges, flows, energies, and trail marks degrade
2. **Prune** — weak edges dissolve, starved tendrils die, orphan nodes removed
3. **Spawn** — new tendrils created (fan-out / goal-directed / stream batch)
4. **Sense** — tendrils explore and evaluate content via Claude
5. **Deposit** — slime trail left wherever we've been
6. **Reinforce** — high-nutrient paths strengthened, low-nutrient paths drained
7. **Connect** — cross-edges created between related nodes
8. **Pulse** — sinusoidal flow injection (protoplasmic streaming)
9. **Terminate** — check stability / budget / goal completion / stream end

## Reading the Output

### The header

```
▓▓ PHYSARUM EXPLORER ▓▓  tick 7  ● 12 nodes  ─ 15 edges  ~ 3/8 tendrils  ▓ 24 trail  API: 19/50
```

- **tick 7** — the simulation is on its 7th cycle
- **12 nodes** — 12 pieces of content discovered so far
- **15 edges** — 15 connections between nodes (some direct paths, some cross-links)
- **3/8 tendrils** — 3 still alive out of 8 total spawned (5 died from starvation)
- **24 trail** — 24 slime marks in memory (directions, URLs, and summaries visited)
- **API: 19/50** — 19 of 50 budgeted API calls used

### The graph

```
                        ○
                       ·  ·
            ●════════●      ○
           ╱          ╲
     ○────●            ~
           ╲          ╱
            ●════════●──────●
                      ╲
                       ·
                        ~─────○
                               ╲
                                ~
```

Force-directed 2D layout of the network. What the symbols mean:

| Symbol | Meaning |
|--------|---------|
| `~` | Active tendril head — an explorer that's still alive and moving |
| `●` | High-nutrient node (scored > 0.4) — something valuable was found here |
| `○` | Low-nutrient node — marginal or tangential content |
| `═` | Strong edge (conductivity > 0.5) — a well-reinforced path |
| `─` | Medium edge (conductivity 0.2-0.5) |
| `·` | Weak edge (conductivity < 0.2) — about to be pruned |

The shape of the graph tells you what happened. A healthy exploration looks like clusters of `●` nodes connected by `═` highways, with `~` tendrils pushing out into new territory along `·` weak edges. Dead ends are `○` nodes connected by `·` dots that will fade away.

### The tendril list

```
  t_3 ██████░░░░ mesh routing protocols in disaster zones
  t_5 ████░░░░░░ fungal network topology vs engineered mesh
  t_7 ████████░░ community-owned infrastructure models
  (5 dead tendrils)
```

Each line is a living tendril: its ID, an energy bar, and the direction it's exploring. Green bar = healthy (> 0.6 energy), yellow = weakening (0.3-0.6), red = about to die (< 0.3). The direction is the natural language prompt that guides what it searches for next.

### The event log

```
  +node n_12: Community mesh networks in rural Oaxaca provide
  +edge n_11→n_12
  ⟷link n_7↔n_12
  ↑reinforce e_4 → 0.87
  ~pulse outward
```

Rolling log of what happened this tick:

| Prefix | Event |
|--------|-------|
| `+node` | New content discovered and added to the graph |
| `+edge` | New direct edge (tendril moved from one node to the next) |
| `-edge` | Edge dissolved (conductivity dropped below threshold) |
| `+tendril` | New tendril spawned (from fan-out or nutrient-triggered branching) |
| `-tendril` | Tendril died (starvation or no energy) |
| `⟷link` | Cross-link — lateral connection between nodes discovered by different tendrils |
| `↑reinforce` | Edge strengthened (the path leading here found good content) |
| `▓deposit` | Trail mark left (direction or URL slimed) |
| `▓avoid` | Tendril skipped a direction because it was already slimed |
| `~pulse` | Protoplasmic streaming phase (outward = explore, inward = consolidate) |

### The stderr log

The live viz renders to stderr. Below/above it you'll see detailed log lines:

```
  ↓ skipping slimed URL: https://example.com/… (0.88)
    🔍 searching: "mesh routing protocols"
    📄 fetching: https://example.com/mesh-routing...
  ✂ edge e_3 dissolved (conductivity 0.042)
  ~ nutrient burst from t_3! (0.91) → 4 new pseudopods
```

- `↓` = decay/avoidance (something fading or being skipped)
- `🔍` = DuckDuckGo search happening
- `📄` = page being fetched
- `✂` = pruning (edge or node removed)
- `~` = tendril activity (spawn, branch, die)
- `⟷` = cross-link created

### JSON output

Pass `--json` to get the full graph as structured data on stdout:

```json
{
  "seed": "mesh networking",
  "tick": 10,
  "nodes": [
    { "id": "n_1", "content": "...", "nutrient": 0.82, "flow": 0.4, ... }
  ],
  "edges": [
    { "id": "e_1", "source": "n_1", "target": "n_2", "conductivity": 0.71, ... }
  ],
  "tendrils": [ ... ],
  "trail": [ ... ],
  "stats": { "totalNodes": 12, "totalEdges": 15, "crossLinks": 3, "apiCallsUsed": 19, "trailMarks": 24 }
}
```

High-conductivity edges are the important connections. High-nutrient nodes are the valuable findings. Cross-links are the lateral discoveries that connect different branches of exploration.

## Options

```
--mode <explore|solve|sense>   Simulation mode (default: explore)
--tendrils, -t <n>             Initial tendrils (default: 4)
--ticks <n>                    Max ticks (default: 30)
--concurrency, -c <n>          Parallel ops per tick (default: 3)
--budget, -b <n>               Max API calls (default: 50)
--decay <rate>                 Decay rate 0-1 (default: 0.05)
--substrate, -s <name>         Substrate name (default: "web")
--no-render                    Disable live terminal visualization
--json                         Output final graph JSON to stdout
--save <path>                  Save graph JSON to file
--trail <path>                 Persistent trail file (cross-run memory)
--trail-decay <rate>           Trail decay rate (default: 0.03)
--trail-avoidance <rate>       Avoidance of slimed areas (default: 0.6)
--fan-out, -f <n>              Fan-out multiplier (default: 2)
--goals <g1,g2,...>            Food sources for solver mode
--input <path>                 Input file for sensor mode (default: stdin)
--batch-size <n>               Lines per tick in sensor mode (default: 5)
```

## Architecture

The codebase is ~10 files, no frameworks, no build step. Here's what each one does and how they connect.

### The graph: `types.ts`, `network.ts`

Everything is plain objects in Maps. A `PhysarumGraph` has:

- **Nodes** — each has a `content` string (what was found), a `nutrient` score (0-1, how valuable), `flow` (energy from pulsing), and `age`.
- **Edges** — each has `conductivity` (0-1, how strong the connection) and a `reinforcements` counter.

`network.ts` is just CRUD: `addNode`, `addEdge`, `removeEdge`, `getOrphanedNodes`, etc. No logic, just graph manipulation.

### The tendrils: `tendril.ts`

A tendril is a pseudopod — an exploratory probe with a direction (natural language string like "mesh routing protocols in disaster zones"), an energy level, and a trail of edge IDs it has traversed. Tendrils are the agents that do the actual exploring.

Key lifecycle: a tendril starts with energy, explores each tick, gains energy when it finds high-nutrient content (fed), loses energy when it finds nothing (starved). After enough starvation cycles it dies and gets pruned.

### The tick loop: `simulation.ts`

This is the core. `runSimulation()` creates the initial state and runs ticks until a termination condition is met. Each tick executes 9 steps in fixed order:

1. **Decay** — everything degrades. Edge conductivity, node flow, tendril energy, trail marks. This is how the organism "forgets" — unused paths weaken and eventually get pruned. Without decay the graph would only ever grow.

2. **Prune** — cleanup. Edges below the conductivity threshold get removed. Tendrils with zero energy or too many starvation cycles die. Orphaned nodes (no edges, age > 2) get removed.

3. **Spawn** — create new tendrils. On tick 0 this is the big fan-out burst: Claude generates N diverse directions from the seed topic and a tendril is created for each. On later ticks, tendrils spawn from the `spawnQueue` (populated during reinforce when a tendril finds rich content). Mode-specific: solver generates goal-directed directions, sensor reads lines from the input stream.

4. **Sense** — the expensive step. Each active tendril does two things in parallel (rate-limited by a semaphore):
   - **Explore**: the substrate goes and fetches content. For web research, this means a DuckDuckGo search + page fetch. For sensor mode, the input line IS the content.
   - **Sense**: Claude evaluates what was found — scores its nutrient value (0-1), writes a summary, proposes new directions to explore, and identifies which existing nodes it relates to.

   The result gets stashed on the tendril (`_lastSense`) for the next steps to use. Each sense call costs 2 API calls (explore + evaluate).

5. **Deposit** — leave slime trail marks on the direction explored, the URL fetched, and the content summary. This is how the organism marks territory. Future tendrils and future runs (with `--trail`) will see these marks and avoid retreading the same ground.

6. **Reinforce** — the core Physarum behavior. If a tendril found high-nutrient content (> 0.5):
   - Its trail edges get a conductivity boost (the path that led here was good).
   - It gets energy back (reward).
   - New tendrils are queued to branch off in the directions Claude suggested — richer finds spawn more branches. The directions are filtered by trail novelty so we don't re-explore slimed territory.

   If nutrient was low: the tendril gets starved and drained. Bad paths weaken.

   In solver mode, edges that bridge between different goals get an extra 1.5x conductivity boost — these are the "highways" connecting disparate ideas.

7. **Connect** — cross-link related nodes. When Claude's sense step says "this content relates to nodes n3 and n7", we create cross-edges. This is how the network develops lateral connections, not just linear tendril paths.

8. **Pulse** — sinusoidal flow injection, modeled on Physarum's protoplasmic streaming. Alternates between outward phase (push energy to frontier nodes) and inward phase (concentrate in high-value hub nodes). This creates a rhythmic exploration/consolidation cycle.

9. **Terminate** — check if we should stop. Conditions vary by mode:
   - All modes: max ticks, API budget exhausted
   - Explorer: all tendrils dead, or network stabilized (no new events for a tick)
   - Solver: all goals have high-scoring nodes and cross-links connect them
   - Sensor: input stream exhausted

### Substrates: `substrates/web-research.ts`, `substrates/stream.ts`

A substrate is the environment the organism explores. It implements two methods:

- `explore(direction)` — go find something. Web research does a DuckDuckGo search, picks the first non-slimed URL, fetches the page. Stream substrate just returns the input line as-is.
- `sense(content)` — ask Claude to evaluate it. Returns nutrient score, summary, new directions, related nodes. In solver mode the prompt also asks Claude to score against each goal.

The substrate interface (`nutrient.ts`) is how you'd add new substrates — a codebase explorer, an API substrate, etc.

### Trail / stigmergy: `trail.ts`

The externalized memory system. A `TrailStore` is a Map of location strings to `TrailMark` objects (intensity, timestamp, visit count). Key operations:

- `deposit(location, agentId, intensity)` — mark a location. If already marked, intensity stacks and visit count increments.
- `sense(location)` — query how slimed a location is (with time decay applied).
- `senseFuzzy(location)` — fuzzy match using word overlap (stemmed, stop-words removed). This is how "mesh networking protocols" partially matches "wireless mesh protocol design".
- `rankByNovelty(directions)` — rank proposed directions by how UN-explored they are. Used in reinforce to prioritize fresh territory.
- `decayAll(rate)` — called each tick. All marks fade. Marks below threshold get pruned entirely.

When you pass `--trail slime.json`, the store is loaded at start and saved periodically + at end. This is how the organism remembers across runs.

### Visualization: `render.ts`

Pure ANSI escape codes, no dependencies. Runs a simple force-directed layout algorithm (repulsion between all node pairs, attraction along edges, 5 iterations per frame) and renders to a grid:

- `~` green = active tendril head
- `●` cyan = high-nutrient node
- `○` dim = low-nutrient node
- `═` strong edge, `─` medium, `·` weak

Below the graph: tendril list with energy bars, then an event log ring buffer.

### CLI: `cli.ts`

Parses args with Node's built-in `parseArgs`, builds a `SimulationConfig`, picks the substrate, and calls `runSimulation`. The `--json` and `--save` flags control output.

### Rate limiting

Two mechanisms:
- **Semaphore** in the sense step limits concurrent API calls (default 3, set with `-c`).
- **withRetry** wraps all API calls with exponential backoff on 429s (2s, 4s, 8s, up to 3 retries).

### Data flow summary

```
seed topic
  → Claude generates directions (fan-out)
    → tendrils created with those directions
      → each tick, per tendril:
          substrate.explore(direction) → raw content
          substrate.sense(content)     → nutrient, summary, new directions, related nodes
          → node added to graph, edge from previous head
          → trail deposited
          → if high nutrient: edges reinforced, new tendrils queued
          → if low nutrient: tendril starved
      → cross-links created between related nodes
      → pulse redistributes flow
      → weak edges pruned, dead tendrils removed
  → repeat until termination
→ output: graph JSON with nodes, edges, tendrils, trail, stats
```

## Stigmergy

The trail system provides externalized memory. Pass `--trail slime.json` and the organism remembers where it's been across runs — avoiding already-explored territory and pushing into gaps.

## Requirements

- Node.js 22+ (uses `--experimental-strip-types`)
- `ANTHROPIC_API_KEY` in `.env`
