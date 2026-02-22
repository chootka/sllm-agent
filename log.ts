/**
 * Colored stderr logging. stdout stays clean for JSON output.
 *
 * When live viz is enabled (log.muted = true), all output is suppressed —
 * the render panels are the only thing on screen.
 */

const RESET = "\x1b[0m";
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const DIM = "\x1b[2m";
const MAGENTA = "\x1b[35m";

function write(msg: string) {
  if (!log.muted) console.error(msg);
}

export const log = {
  muted: false,
  info: (msg: string) => write(`${CYAN}${msg}${RESET}`),
  success: (msg: string) => write(`${GREEN}${msg}${RESET}`),
  warn: (msg: string) => write(`${YELLOW}${msg}${RESET}`),
  error: (msg: string) => write(`${RED}${msg}${RESET}`),
  dim: (msg: string) => write(`${DIM}${msg}${RESET}`),
  pulse: (msg: string) => write(`${MAGENTA}${msg}${RESET}`),
  tendril: (msg: string) => write(`${GREEN}  ~ ${msg}${RESET}`),
  decay: (msg: string) => write(`${DIM}  ↓ ${msg}${RESET}`),
  prune: (msg: string) => write(`${YELLOW}  ✂ ${msg}${RESET}`),
  connect: (msg: string) => write(`${CYAN}  ⟷ ${msg}${RESET}`),
};
