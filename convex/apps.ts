import { ConvexError, v } from 'convex/values'
import { internal } from './_generated/api'
import { internalMutation, internalQuery, mutation, query, type MutationCtx } from './_generated/server'
import { daytona } from './daytona'
import {
  MAX_LIVE_SANDBOXES,
  MAX_LIVE_SANDBOXES_PER_SESSION,
  MAX_PROMPT_CHARS,
  SANDBOX_AUTO_STOP_MINUTES,
  rateLimiter,
} from './limits'
import { appStatus } from './schema'

const RUN_YOUR_OWN = 'Try again later, or run your own copy from the GitHub repo.'

/** The current browser session's apps, newest first. Reactive. */
export const list = query({
  args: { sessionId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query('apps')
      .withIndex('by_session', (q) => q.eq('sessionId', args.sessionId))
      .order('desc')
      .take(20)
  },
})

/**
 * Live `npm install` output, straight from the Daytona component's execution
 * row. `runBackground`'s poller patches that row as logs arrive, so this query
 * (and the terminal panel subscribed to it) updates with no polling code.
 */
export const installLogs = query({
  args: { sessionId: v.string(), appId: v.id('apps') },
  handler: async (ctx, args) => {
    const app = await ctx.db.get('apps', args.appId)
    if (!app || app.sessionId !== args.sessionId || !app.installExecutionId) return null
    const execution = await daytona.getExecution(ctx, { executionId: app.installExecutionId })
    if (!execution) return null
    const { input, status, result, exitCode, startedAt, finishedAt } = execution
    return { command: input, status, output: result ?? '', exitCode, startedAt, finishedAt }
  },
})

/** Start building a new app. The pipeline runs as scheduled steps in builder.ts. */
export const build = mutation({
  args: { sessionId: v.string(), prompt: v.string() },
  handler: async (ctx, args) => {
    const prompt = checkInput(args.sessionId, args.prompt)
    await enforceLimit(ctx, 'buildPerSession', args.sessionId, "You've hit the limit of new apps for now.")
    await enforceLimit(ctx, 'buildGlobal', undefined, 'The demo is busy right now.')
    await enforceSandboxCap(ctx, args.sessionId)

    const appId = await ctx.db.insert('apps', {
      sessionId: args.sessionId,
      prompt,
      status: 'creating sandbox',
    })
    await ctx.scheduler.runAfter(0, internal.builder.createApp, { appId })
    return appId
  },
})

/** Apply a follow-up instruction to a running app; Vite hot-reloads the preview. */
export const edit = mutation({
  args: { sessionId: v.string(), appId: v.id('apps'), instruction: v.string() },
  handler: async (ctx, args) => {
    const instruction = checkInput(args.sessionId, args.instruction)
    const app = await ctx.db.get('apps', args.appId)
    if (!app || app.sessionId !== args.sessionId) throw new ConvexError('App not found.')
    // Mutations are transactional, so two concurrent edits can't both pass this check.
    const canEdit = app.previewUrl && (app.status === 'ready' || app.status === 'error')
    if (!canEdit) throw new ConvexError('This app is busy. Wait for it to finish first.')
    await enforceLimit(ctx, 'editPerSession', args.sessionId, "You've hit the limit of edits for now.")
    await enforceLimit(ctx, 'editGlobal', undefined, 'The demo is busy right now.')

    await ctx.db.patch('apps', args.appId, { status: 'generating code', error: undefined })
    await ctx.scheduler.runAfter(0, internal.builder.editApp, { appId: args.appId, instruction })
  },
})

function checkInput(sessionId: string, text: string) {
  if (sessionId.length < 8 || sessionId.length > 64) throw new ConvexError('Invalid session.')
  const trimmed = text.trim()
  if (!trimmed) throw new ConvexError('Describe what you want first.')
  if (trimmed.length > MAX_PROMPT_CHARS) {
    throw new ConvexError(`Keep it under ${MAX_PROMPT_CHARS} characters.`)
  }
  return trimmed
}

async function enforceLimit(
  ctx: MutationCtx,
  name: 'buildPerSession' | 'buildGlobal' | 'editPerSession' | 'editGlobal',
  key: string | undefined,
  message: string,
) {
  const { ok, retryAfter } = await rateLimiter.limit(ctx, name, { key })
  if (!ok) {
    const minutes = Math.ceil(retryAfter / 60_000)
    throw new ConvexError(`${message} ${RUN_YOUR_OWN} (Resets in about ${minutes} min.)`)
  }
}

/**
 * Global concurrency cap, read from the component's reactive sandbox table.
 * Daytona pauses idle sandboxes after SANDBOX_AUTO_STOP_MINUTES, so a record
 * that hasn't been touched for longer than that is no longer counted.
 */
async function enforceSandboxCap(ctx: MutationCtx, sessionId: string) {
  const cutoff = Date.now() - SANDBOX_AUTO_STOP_MINUTES * 60_000
  const sandboxes = await daytona.listSandboxes(ctx, { limit: 100 })
  const live = sandboxes.filter((s) => s.state === 'started' && s.updatedAt > cutoff)
  if (live.length >= MAX_LIVE_SANDBOXES) {
    throw new ConvexError(`The demo is busy right now. ${RUN_YOUR_OWN}`)
  }
  if (live.filter((s) => s.userKey === sessionId).length >= MAX_LIVE_SANDBOXES_PER_SESSION) {
    throw new ConvexError('You already have apps running. Edit one of those, or wait a few minutes.')
  }
}

// ---- Internal helpers for the builder pipeline ----

export const get = internalQuery({
  args: { appId: v.id('apps') },
  handler: async (ctx, args) => {
    return await ctx.db.get('apps', args.appId)
  },
})

export const update = internalMutation({
  args: {
    appId: v.id('apps'),
    status: v.optional(appStatus),
    sandboxId: v.optional(v.string()),
    installExecutionId: v.optional(v.string()),
    previewUrl: v.optional(v.string()),
    code: v.optional(v.string()),
    draftCode: v.optional(v.string()),
    error: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { appId, ...fields } = args
    // The 12h reset may have wiped the row mid-build: just stop quietly.
    if (!(await ctx.db.get('apps', appId))) return
    await ctx.db.patch('apps', appId, fields)
  },
})
