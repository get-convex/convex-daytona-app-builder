import { useMutation, useQuery } from 'convex/react'
import { useRef, useState } from 'react'
import { api } from '../convex/_generated/api'
import type { Id } from '../convex/_generated/dataModel'
import { AppWorkspace } from './AppWorkspace'
import { errorText, tone } from './lib'
import { getSessionId } from './session'

const REPO_URL = 'https://github.com/get-convex/convex-daytona-app-builder'
const MAX_PROMPT_CHARS = 500
const EXAMPLES = [
  'A pomodoro timer with a circular progress ring',
  'A kanban board with three columns and drag and drop',
  'A tip calculator that splits the bill',
]

const sessionId = getSessionId()

export default function App() {
  // Reactive: every patch the backend makes to an app re-renders this.
  const apps = useQuery(api.apps.list, { sessionId })
  const build = useMutation(api.apps.build)
  const [prompt, setPrompt] = useState('')
  const [error, setError] = useState('')
  const [selectedId, setSelectedId] = useState<Id<'apps'> | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const selected = apps?.find((app) => app._id === selectedId) ?? apps?.[0]

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault()
    if (!prompt.trim()) return
    setError('')
    try {
      setSelectedId(await build({ sessionId, prompt }))
      setPrompt('')
    } catch (err) {
      setError(errorText(err))
    }
  }

  return (
    <div className="page">
      <header className="header">
        <div className="brand">
          <span className="logo">⚡</span>
          <h1>App Builder</h1>
          <span className="badge">Convex + Daytona</span>
        </div>
        <a className="github" href={REPO_URL} target="_blank" rel="noreferrer">
          View on GitHub
        </a>
      </header>

      <main>
        <p className="intro">
          Describe an app. An LLM writes it, a Daytona sandbox installs and runs it, and Convex streams
          every step to this page. Try refreshing mid-build.
        </p>

        <form className="prompt" onSubmit={onSubmit}>
          <input
            ref={inputRef}
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            maxLength={MAX_PROMPT_CHARS}
            placeholder="Describe an app, e.g. a pomodoro timer with a circular progress ring"
            aria-label="Describe the app to build"
            autoFocus
          />
          <button type="submit" disabled={!prompt.trim()}>
            Build it
          </button>
        </form>
        <div className="prompt-meta">
          <div className="examples">
            {EXAMPLES.map((example) => (
              <button key={example} type="button" className="chip" onClick={() => {
                  setPrompt(example)
                  inputRef.current?.focus()
                }}>
                {example}
              </button>
            ))}
          </div>
          <span className="count">
            {prompt.length}/{MAX_PROMPT_CHARS}
          </span>
        </div>
        {error && <div className="notice">{error}</div>}

        {apps && apps.length > 1 && (
          <nav className="history" aria-label="Your apps">
            {apps.map((app) => (
              <button
                key={app._id}
                className={`history-item ${app._id === selected?._id ? 'selected' : ''}`}
                onClick={() => setSelectedId(app._id)}
              >
                <span className={`dot dot-${tone(app.status)}`} />
                {app.prompt}
              </button>
            ))}
          </nav>
        )}

        {selected ? (
          <AppWorkspace key={selected._id} app={selected} sessionId={sessionId} />
        ) : (
          apps && <p className="empty">Nothing built yet. Describe an app above to get started.</p>
        )}
      </main>

      <footer className="footer">
        Public demo. Everything resets every 12 hours. Run your own:{' '}
        <a href={REPO_URL} target="_blank" rel="noreferrer">
          {REPO_URL.replace('https://', '')}
        </a>
      </footer>
    </div>
  )
}
