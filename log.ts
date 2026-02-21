/**
 * Colored stderr logging. stdout stays clean for JSON output.
 */

const RESET = "\x1b[0m";
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const DIM = "\x1b[2m";
const MAGENTA = "\x1b[35m";

export const log = {
  info: (msg: string) => console.error(`${CYAN}${msg}${RESET}`),
  success: (msg: string) => console.error(`${GREEN}${msg}${RESET}`),
  warn: (msg: string) => console.error(`${YELLOW}${msg}${RESET}`),
  error: (msg: string) => console.error(`${RED}${msg}${RESET}`),
  dim: (msg: string) => console.error(`${DIM}${msg}${RESET}`),
  pulse: (msg: string) => console.error(`${MAGENTA}${msg}${RESET}`),
  tendril: (msg: string) => console.error(`${GREEN}  ~ ${msg}${RESET}`),
  decay: (msg: string) => console.error(`${DIM}  ↓ ${msg}${RESET}`),
  prune: (msg: string) => console.error(`${YELLOW}  ✂ ${msg}${RESET}`),
  connect: (msg: string) => console.error(`${CYAN}  ⟷ ${msg}${RESET}`),
};
