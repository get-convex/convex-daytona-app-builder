import { useMutation, useQuery } from 'convex/react'
import { useEffect, useRef, useState } from 'react'
import { api } from '../convex/_generated/api'
import type { Doc } from '../convex/_generated/dataModel'
import type { FunctionReturnType } from 'convex/server'
import { errorText, tone } from './lib'

type App = Doc<'apps'>
type Install = NonNullable<FunctionReturnType<typeof api.apps.installLogs>>

// Each step, and the @daytona/convex call that does the work.
const STEPS = [
  { status: 'creating sandbox', label: 'Create sandbox', call: 'daytona.createSandbox' },
  { status: 'generating code', label: 'Write the code', call: 'LLM streams src/App.jsx' },
  { status: 'writing files', label: 'Write files', call: 'daytona.writeFile' },
  { status: 'installing dependencies', label: 'Install packages', call: 'daytona.runBackground' },
  { status: 'starting dev server', label: 'Start dev server', call: 'daytona.run' },
  { status: 'ready', label: 'Live preview', call: 'daytona.getPreviewUrl' },
] as const

export function AppWorkspace({ app, sessionId }: { app: App; sessionId: string }) {
  // Live npm install output, read from the Daytona component's execution row.
  const install = useQuery(api.apps.installLogs, { sessionId, appId: app._id })
  const editing = Boolean(app.previewUrl) && app.status === 'generating code'
  return (
    <section className="workspace">
      <div className="workspace-head">
        <h2>{app.prompt}</h2>
        <span className={`pill pill-${tone(app.status)}`}>{editing ? 'editing' : app.status}</span>
      </div>

      <div className="columns">
        <div className="column">
          <Steps app={app} install={install} />
          {app.status === 'error' && <pre className="error">{app.error}</pre>}
          <OutputPanel app={app} install={install} />
        </div>
        <div className="column">
          <Preview app={app} />
          <EditForm app={app} sessionId={sessionId} />
        </div>
      </div>
    </section>
  )
}

type StepState = 'done' | 'active' | 'failed' | 'todo'

function stepStates(app: App, install: Install | null | undefined): StepState[] {
  if (app.status === 'error') {
    // Work out how far we got from which fields were filled in.
    const done = [app.sandboxId, app.code, app.installExecutionId, install?.status === 'completed', app.previewUrl, app.previewUrl]
    const failedAt = done.findIndex((field) => !field)
    return STEPS.map((_, i) => (failedAt === -1 || i < failedAt ? 'done' : i === failedAt ? 'failed' : 'todo'))
  }
  const at = app.previewUrl ? STEPS.length : STEPS.findIndex((step) => step.status === app.status)
  return STEPS.map((_, i) => {
    // The sandbox boots while the LLM writes the code, so both can be active at once.
    const parallel = i === 0 && at === 1 && !app.sandboxId
    return i === at || parallel ? 'active' : i < at ? 'done' : 'todo'
  })
}

function Steps({ app, install }: { app: App; install: Install | null | undefined }) {
  const states = stepStates(app, install)
  const building = !app.previewUrl && app.status !== 'error'
  const elapsed = useElapsed(app._creationTime, building)

  return (
    <div className="panel">
      <div className="panel-head">
        <span>Build steps</span>
        {elapsed && <span className="muted mono">{elapsed}</span>}
      </div>
      <ol className="steps">
        {STEPS.map((step, index) => {
          const state = states[index]
          return (
            <li key={step.status} className={`step step-${state}`}>
              <span className="step-icon" aria-hidden>
                {state === 'done' ? '✓' : state === 'failed' ? '✕' : ''}
              </span>
              <span className="step-label">{step.label}</span>
              <code className="step-call">{step.call}</code>
            </li>
          )
        })}
      </ol>
    </div>
  )
}

type Tab = 'code' | 'terminal'

/** One panel, two tabs: the LLM's code, then the sandbox terminal. It follows the build. */
function OutputPanel({ app, install }: { app: App; install: Install | null | undefined }) {
  const [tab, setTab] = useState<Tab>(
    app.installExecutionId && app.status !== 'generating code' ? 'terminal' : 'code',
  )
  useEffect(() => {
    if (app.status === 'generating code') setTab('code')
    if (app.status === 'installing dependencies') setTab('terminal')
  }, [app.status])

  return (
    <div className="panel">
      <div className="panel-head tabs">
        <div role="tablist">
          <button role="tab" aria-selected={tab === 'code'} onClick={() => setTab('code')}>
            src/App.jsx
          </button>
          <button role="tab" aria-selected={tab === 'terminal'} onClick={() => setTab('terminal')}>
            Terminal
          </button>
        </div>
        {tab === 'code' ? <CodeStatus app={app} /> : install && <TerminalStatus install={install} />}
      </div>
      {tab === 'code' ? <CodeBody app={app} /> : <TerminalBody install={install} />}
    </div>
  )
}

/**
 * `npm install` runs with daytona.runBackground. The component's poller writes
 * the logs into its execution row as they arrive, and the useQuery in
 * AppWorkspace is subscribed to that row, so this fills up by itself.
 */
function TerminalBody({ install }: { install: Install | null | undefined }) {
  const lines = useRevealedLines(install?.output ?? '')
  const scrollRef = useAutoScroll<HTMLDivElement>(lines.length)
  return (
    <div className="terminal-body" ref={scrollRef}>
      {install ? (
        <>
          <div className="log-command">sandbox:~/app$ {install.command}</div>
          {lines.map((line, index) => (
            <LogLine key={index} line={line} />
          ))}
          {install.status === 'running' && <span className="cursor" />}
        </>
      ) : (
        // undefined means the query is still loading (e.g. just after a refresh), so show nothing yet.
        install === null && <div className="log-dim">npm install starts once the code is written...</div>
      )}
    </div>
  )
}

function TerminalStatus({ install }: { install: Install }) {
  if (install.status === 'running') return <span className="pill pill-busy">running</span>
  const seconds = install.finishedAt ? ((install.finishedAt - install.startedAt) / 1000).toFixed(1) : '?'
  return (
    <span className={`pill pill-${install.status === 'completed' ? 'ok' : 'bad'}`}>
      exit {install.exitCode ?? '?'} · {seconds}s
    </span>
  )
}

function LogLine({ line }: { line: string }) {
  // "npm http fetch GET 200 https://registry.npmjs.org/react 181ms (cache miss)"
  const fetch = line.match(/^npm http fetch (\w+) (\d+) https:\/\/registry\.npmjs\.org\/(\S+)(.*)$/)
  if (fetch) {
    const [, method, code, path, rest] = fetch
    return (
      <div>
        <span className="log-dim">npm http fetch {method} </span>
        <span className={code.startsWith('2') ? 'log-ok' : 'log-bad'}>{code}</span>{' '}
        <span className="log-pkg">{decodeURIComponent(path)}</span>
        <span className="log-dim">{rest}</span>
      </div>
    )
  }
  const color = /ERR|error/i.test(line) ? 'log-bad' : /^(added|up to date)/.test(line) ? 'log-ok' : ''
  return <div className={color}>{line}</div>
}

function CodeStatus({ app }: { app: App }) {
  if (app.status === 'generating code') return <span className="pill pill-busy">streaming</span>
  return app.code ? <span className="muted mono">{app.code.split('\n').length} lines</span> : null
}

function CodeBody({ app }: { app: App }) {
  const code = (app.status === 'generating code' ? app.draftCode : app.code) ?? ''
  const scrollRef = useAutoScroll<HTMLPreElement>(code.length)
  return (
    <pre className="code" ref={scrollRef}>
      {code || <span className="log-dim">The LLM's code will stream in here...</span>}
    </pre>
  )
}

function Preview({ app }: { app: App }) {
  const host = app.previewUrl ? new URL(app.previewUrl).host : 'waiting for the dev server'
  return (
    <div className="browser">
      <div className="browser-bar">
        <span className="browser-dots" aria-hidden>
          <i /> <i /> <i />
        </span>
        <span className="browser-url mono">{host}</span>
        {app.previewUrl && (
          <a href={app.previewUrl} target="_blank" rel="noreferrer">
            Open ↗
          </a>
        )}
      </div>
      {app.previewUrl ? (
        <iframe
          src={app.previewUrl}
          title={app.prompt}
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
        />
      ) : (
        <div className="browser-empty">
          {app.status === 'error' ? 'The build failed.' : 'Your app will appear here.'}
        </div>
      )}
    </div>
  )
}

function EditForm({ app, sessionId }: { app: App; sessionId: string }) {
  const edit = useMutation(api.apps.edit)
  const [instruction, setInstruction] = useState('')
  const [error, setError] = useState('')
  const canEdit = Boolean(app.previewUrl) && (app.status === 'ready' || app.status === 'error')

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault()
    setError('')
    try {
      await edit({ sessionId, appId: app._id, instruction })
      setInstruction('')
    } catch (err) {
      setError(errorText(err))
    }
  }

  return (
    <>
      <form className="prompt" onSubmit={onSubmit}>
        <input
          value={instruction}
          onChange={(event) => setInstruction(event.target.value)}
          maxLength={500}
          placeholder="Change something, e.g. make it dark mode"
          aria-label="Describe a change to this app"
          disabled={!canEdit}
        />
        <button type="submit" disabled={!canEdit || !instruction.trim()}>
          Update
        </button>
      </form>
      {error && <div className="notice">{error}</div>}
    </>
  )
}

/** Reveal new log lines over ~1s instead of in one jump, so each poll reads as a scroll. */
function useRevealedLines(text: string) {
  const lines = text.split('\n').filter((line) => line.trim())
  const [shown, setShown] = useState(0)
  useEffect(() => {
    if (shown >= lines.length) return
    const step = Math.max(1, Math.ceil((lines.length - shown) / 25))
    const timer = setTimeout(() => setShown((n) => n + step), 40)
    return () => clearTimeout(timer)
  }, [shown, lines.length])
  return lines.slice(0, shown)
}

/** Keep a scrolling panel pinned to the bottom as it grows, unless you've scrolled up. */
function useAutoScroll<T extends HTMLElement>(size: number) {
  const ref = useRef<T>(null)
  const pinned = useRef(true)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const onScroll = () => {
      pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
    }
    el.addEventListener('scroll', onScroll)
    return () => el.removeEventListener('scroll', onScroll)
  }, [])
  useEffect(() => {
    if (pinned.current) ref.current?.scrollTo({ top: ref.current.scrollHeight })
  }, [size])
  return ref
}

/** "0:42" since `from`, ticking every second while `running`. */
function useElapsed(from: number, running: boolean) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!running) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [running])
  if (!running) return null
  const seconds = Math.max(0, Math.floor((now - from) / 1000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}
