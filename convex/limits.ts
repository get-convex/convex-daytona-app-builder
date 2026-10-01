import { HOUR, RateLimiter } from '@convex-dev/rate-limiter'
import { components } from './_generated/api'

// Every run costs real Daytona + LLM money, so the public demo is capped.
// Tweak these if you're running your own copy.

/** Max characters in a prompt or follow-up instruction. */
export const MAX_PROMPT_CHARS = 500
/** Cap on LLM output per generation. */
export const MAX_OUTPUT_TOKENS = 8000
/** Refuse new builds while this many of this app's sandboxes are live. */
export const MAX_LIVE_SANDBOXES = 8
/** ...or while this one browser session already has this many live. */
export const MAX_LIVE_SANDBOXES_PER_SESSION = 2
/** Daytona pauses a sandbox after this many idle minutes... */
export const SANDBOX_AUTO_STOP_MINUTES = 10
/** ...and deletes it after this many minutes. */
export const SANDBOX_AUTO_DELETE_MINUTES = 60
/** Give up on `npm install` after this long. */
export const INSTALL_TIMEOUT_MS = 5 * 60 * 1000

export const rateLimiter = new RateLimiter(components.rateLimiter, {
  // New apps create sandboxes, so they get the tightest limits.
  buildPerSession: { kind: 'fixed window', rate: 5, period: HOUR },
  buildGlobal: { kind: 'fixed window', rate: 60, period: HOUR },
  // Follow-up edits reuse the sandbox and only cost an LLM call.
  editPerSession: { kind: 'fixed window', rate: 15, period: HOUR },
  editGlobal: { kind: 'fixed window', rate: 150, period: HOUR },
})
