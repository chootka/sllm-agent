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

## Sample Output

The live terminal visualization renders the network as it grows:

```
▓▓ PHYSARUM EXPLORER ▓▓  tick 7  ● 12 nodes  ─ 15 edges  ~ 3/8 tendrils  ▓ 24 trail  API: 19/50
──────────────────────────────────────────────────────────────────────────
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
──────────────────────────────────────────────────────────────────────────
  t_3 ██████░░░░ mesh routing protocols in disaster zones
  t_5 ████░░░░░░ fungal network topology vs engineered mesh
  t_7 ████████░░ community-owned infrastructure models
  (5 dead tendrils)
──────────────────────────────────────────────────────────────────────────
  +node n_12: Community mesh networks in rural Oaxaca provide
  +edge n_11→n_12
  ⟷link n_7↔n_12
  ↑reinforce e_4 → 0.87
  ~pulse outward
```

Solver mode shows goals in the header and scores nodes against each food source. Sensor mode shows input source and batch size.

JSON output (`--json`) includes the full graph, tendrils, trail marks, and stats for further processing.

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

## Stigmergy

The trail system provides externalized memory. Pass `--trail slime.json` and the organism remembers where it's been across runs — avoiding already-explored territory and pushing into gaps.

## Requirements

- Node.js 22+ (uses `--experimental-strip-types`)
- `ANTHROPIC_API_KEY` in `.env`
