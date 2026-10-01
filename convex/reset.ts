import { internal } from './_generated/api'
import { internalAction, internalMutation } from './_generated/server'
import { daytona } from './daytona'

/**
 * Puts the public demo back to a clean slate (run by the cron in crons.ts).
 * Safe to run any time, and running it twice is harmless.
 */
export const resetDemo = internalAction({
  args: {},
  handler: async (ctx) => {
    // 1. Delete every sandbox the component knows about that isn't gone yet.
    //    (The component is only installed in this app, so they're all ours.)
    const sandboxes = await daytona.listSandboxes(ctx, { limit: 500 })
    const alive = sandboxes.filter((s) => s.state !== 'destroyed')
    let deleted = 0
    for (let i = 0; i < alive.length; i += 10) {
      const batch = alive.slice(i, i + 10)
      await Promise.all(
        batch.map(async ({ sandboxId }) => {
          try {
            await daytona.deleteSandbox(ctx, { sandboxId })
            deleted++
          } catch {
            // Usually it was already auto-deleted (404). Refreshing marks the
            // record "destroyed"; anything else gets retried on the next run.
            await daytona.refreshSandbox(ctx, { sandboxId }).catch(() => null)
          }
        }),
      )
    }

    // 2. Wipe this app's own table. (This app stores no files; the only file
    //    storage on the deployment is the static-hosted frontend, so leave it.)
    let wiped = 0
    let batchSize: number
    do {
      batchSize = await ctx.runMutation(internal.reset.deleteSomeApps, {})
      wiped += batchSize
    } while (batchSize > 0)
    console.log(`Reset: deleted ${deleted} of ${alive.length} live sandboxes, wiped ${wiped} apps`)
  },
})

export const deleteSomeApps = internalMutation({
  args: {},
  handler: async (ctx) => {
    const apps = await ctx.db.query('apps').take(200)
    for (const app of apps) await ctx.db.delete('apps', app._id)
    return apps.length
  },
})
