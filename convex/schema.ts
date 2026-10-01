import { defineSchema, defineTable } from 'convex/server'
import { v } from 'convex/values'

export const appStatus = v.union(
  v.literal('creating sandbox'),
  v.literal('generating code'),
  v.literal('writing files'),
  v.literal('installing dependencies'),
  v.literal('starting dev server'),
  v.literal('ready'),
  v.literal('error'),
)

export default defineSchema({
  // One row per generated app. Every step is a plain document patch, so the
  // UI (useQuery) re-renders live with no polling code.
  apps: defineTable({
    /** Anonymous browser session that owns this app (also the sandbox userKey). */
    sessionId: v.string(),
    prompt: v.string(),
    status: appStatus,
    sandboxId: v.optional(v.string()),
    /** The `daytona.runBackground` execution for `npm install`. Its row streams the logs. */
    installExecutionId: v.optional(v.string()),
    previewUrl: v.optional(v.string()),
    /** Current App.jsx source, used as context for follow-up edits. */
    code: v.optional(v.string()),
    /** Partial code streamed in while the LLM is generating. */
    draftCode: v.optional(v.string()),
    error: v.optional(v.string()),
  }).index('by_session', ['sessionId']),
})
