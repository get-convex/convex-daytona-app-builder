import { convexGateway } from '@convex-dev/ai-sdk-provider'
import { streamText } from 'ai'
import type { FunctionArgs } from 'convex/server'
import { v } from 'convex/values'
import { internal } from './_generated/api'
import type { Id } from './_generated/dataModel'
import { internalAction, internalMutation, type ActionCtx } from './_generated/server'
import { daytona } from './daytona'
import {
  INSTALL_TIMEOUT_MS,
  MAX_OUTPUT_TOKENS,
  SANDBOX_AUTO_DELETE_MINUTES,
  SANDBOX_AUTO_STOP_MINUTES,
} from './limits'
import { APP_DIR, DEV_PORT, SCAFFOLD_FILES, SYSTEM_PROMPT } from './scaffold'

const MODEL = 'anthropic/claude-sonnet-5'
const INSTALL_CHECK_MS = 1000

/*
 * The build runs as three scheduled steps, so no action ever sits waiting on npm:
 *
 *   createApp       sandbox + LLM code in parallel, write files, start `npm install` with runBackground
 *   waitForInstall  a tiny mutation that checks the install's execution row every second
 *   startDevServer  start Vite, wait until it answers, get a signed preview URL
 *
 * Every step patches the `apps` row, so the UI follows along live, and a page
 * refresh mid-build picks up exactly where it was.
 */

export const createApp = internalAction({
  args: { appId: v.id('apps') },
  handler: async (ctx, { appId }) => {
    await failAppOnError(ctx, appId, async () => {
      const app = await ctx.runQuery(internal.apps.get, { appId })
      if (!app) return

      // Create the sandbox and generate the code at the same time. If the
      // sandbox fails, abort the LLM stream so we stop paying for tokens.
      const abort = new AbortController()
      const sandbox = daytona
        .createSandbox(ctx, {
          labels: { app: 'convex-daytona-app-builder' },
          userKey: app.sessionId,
          autoStopInterval: SANDBOX_AUTO_STOP_MINUTES,
          autoDeleteInterval: SANDBOX_AUTO_DELETE_MINUTES,
        })
        .then(async (created) => {
          await update(ctx, appId, { sandboxId: created.sandboxId })
          return created
        })
        .catch((error: unknown) => {
          abort.abort()
          throw error
        })
      await update(ctx, appId, { status: 'generating code' })
      const [{ sandboxId }, code] = await Promise.all([
        sandbox,
        generateCode(ctx, appId, app.prompt, abort.signal),
      ])
      await update(ctx, appId, { code, draftCode: '', status: 'writing files' })

      const files = { ...SCAFFOLD_FILES, 'src/App.jsx': code }
      for (const [path, content] of Object.entries(files)) {
        await daytona.writeFile(ctx, { sandboxId, path: `${APP_DIR}/${path}`, content })
      }

      // runBackground returns straight away. The component's own poller
      // streams npm's logs into the execution row while it runs.
      const { executionId } = await daytona.runBackground(ctx, {
        sandboxId,
        command: 'npm install --no-audit --no-fund --no-update-notifier --loglevel=http',
        cwd: APP_DIR,
      })
      await update(ctx, appId, { status: 'installing dependencies', installExecutionId: executionId })
      await ctx.scheduler.runAfter(INSTALL_CHECK_MS, internal.builder.waitForInstall, { appId })
    })
  },
})

/**
 * runBackground has no "on finished" callback, only the reactive execution
 * row. So we check that row once a second (a cheap mutation, nothing held
 * open) and move on to the dev server once npm is done.
 */
export const waitForInstall = internalMutation({
  args: { appId: v.id('apps') },
  handler: async (ctx, { appId }) => {
    const app = await ctx.db.get('apps', appId)
    if (!app?.sandboxId || !app.installExecutionId) return
    const install = await daytona.getExecution(ctx, { executionId: app.installExecutionId })

    if (install?.status === 'running' && Date.now() - install.startedAt < INSTALL_TIMEOUT_MS) {
      await ctx.scheduler.runAfter(INSTALL_CHECK_MS, internal.builder.waitForInstall, { appId })
    } else if (install?.status === 'completed') {
      await ctx.db.patch('apps', appId, { status: 'starting dev server' })
      await ctx.scheduler.runAfter(0, internal.builder.startDevServer, { appId })
    } else {
      const reason = install?.status === 'running' ? 'timed out' : `failed: ${tail(install?.error ?? install?.result)}`
      await ctx.db.patch('apps', appId, { status: 'error', error: `npm install ${reason}` })
    }
  },
})

export const startDevServer = internalAction({
  args: { appId: v.id('apps') },
  handler: async (ctx, { appId }) => {
    await failAppOnError(ctx, appId, async () => {
      const app = await ctx.runQuery(internal.apps.get, { appId })
      if (!app?.sandboxId) return
      await ensureDevServer(ctx, app.sandboxId)
      const preview = await daytona.getPreviewUrl(ctx, {
        sandboxId: app.sandboxId,
        port: DEV_PORT,
        expiresInSeconds: SANDBOX_AUTO_DELETE_MINUTES * 60,
      })
      await update(ctx, appId, { previewUrl: preview.url, status: 'ready' })
    })
  },
})

/** Follow-up edit: regenerate App.jsx and write it. Vite hot-reloads the iframe. */
export const editApp = internalAction({
  args: { appId: v.id('apps'), instruction: v.string() },
  handler: async (ctx, { appId, instruction }) => {
    await failAppOnError(ctx, appId, async () => {
      const app = await ctx.runQuery(internal.apps.get, { appId })
      if (!app?.sandboxId) return
      // Check the sandbox is alive BEFORE spending tokens. It pauses when idle
      // (restart it, and the dev server with it) and is deleted after an hour.
      await daytona.startSandbox(ctx, { sandboxId: app.sandboxId }).catch(() => {
        throw new Error('This sandbox has been deleted (they only live for an hour). Build a new app.')
      })
      await ensureDevServer(ctx, app.sandboxId)
      const code = await generateCode(
        ctx,
        appId,
        `Here is the current src/App.jsx:\n\n${app.code}\n\nApply this change and output the complete updated file:\n${instruction}`,
      )
      await daytona.writeFile(ctx, { sandboxId: app.sandboxId, path: `${APP_DIR}/src/App.jsx`, content: code })
      await update(ctx, appId, { code, draftCode: '', status: 'ready' })
    })
  },
})

/** Start Vite in the background (unless it's already up), then wait until it answers. */
async function ensureDevServer(ctx: ActionCtx, sandboxId: string) {
  const url = `http://localhost:${DEV_PORT}`
  await daytona.run(ctx, {
    sandboxId,
    command: `curl -sf -o /dev/null ${url} || (nohup npm run dev > /tmp/dev.log 2>&1 &)`,
    cwd: APP_DIR,
  })
  const wait = await daytona.run(ctx, {
    sandboxId,
    command: `for i in $(seq 1 60); do curl -sf -o /dev/null ${url} && exit 0; sleep 1; done; cat /tmp/dev.log; exit 1`,
    timeoutSeconds: 90,
  })
  if (wait.exitCode !== 0) throw new Error(`Dev server failed to start: ${tail(wait.result)}`)
}

/**
 * Stream the LLM's code into the app row every ~300ms, so the code visibly
 * writes itself in the UI. It lives in the database, not a socket, so a
 * refresh mid-stream just carries on.
 */
async function generateCode(
  ctx: ActionCtx,
  appId: Id<'apps'>,
  prompt: string,
  abortSignal?: AbortSignal,
): Promise<string> {
  // streamText doesn't throw on provider errors (bad model, no credits), it
  // just ends the stream empty. So capture the error and fail loudly.
  let streamError: unknown
  const result = streamText({
    model: convexGateway(MODEL),
    system: SYSTEM_PROMPT,
    prompt,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    abortSignal,
    onError: ({ error }) => {
      streamError = error
    },
  })

  let draft = ''
  let lastPatch = 0
  for await (const chunk of result.textStream) {
    draft += chunk
    if (Date.now() - lastPatch > 300) {
      lastPatch = Date.now()
      await update(ctx, appId, { draftCode: draft })
    }
  }

  const text = await result.text
  if (streamError || !text.trim()) {
    throw new Error(`Code generation failed: ${streamError ? errorMessage(streamError) : 'the model returned no code'}`)
  }
  return text.replace(/^```[a-z]*\n?/, '').replace(/\n?```\s*$/, '')
}

type AppFields = Omit<FunctionArgs<typeof internal.apps.update>, 'appId'>

async function update(ctx: ActionCtx, appId: Id<'apps'>, fields: AppFields) {
  await ctx.runMutation(internal.apps.update, { appId, ...fields })
}

/** Any thrown error marks the app as failed (shown in the UI) and is rethrown for the logs. */
async function failAppOnError(ctx: ActionCtx, appId: Id<'apps'>, step: () => Promise<void>) {
  try {
    await step()
  } catch (error) {
    await update(ctx, appId, { status: 'error', error: errorMessage(error) })
    throw error
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  const nested = (error as { error?: { message?: string } } | undefined)?.error?.message
  return nested ?? String(error)
}

function tail(text: string | undefined, chars = 600) {
  return (text ?? '').trim().slice(-chars)
}
