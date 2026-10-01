const KEY = 'app-builder-session-id'

/**
 * An anonymous id for this browser, kept in localStorage. The backend uses it
 * for per-session rate limits and to scope your apps and sandboxes (userKey).
 * It's trivially spoofable, which is why there are global limits too.
 */
export function getSessionId(): string {
  try {
    let id = localStorage.getItem(KEY)
    if (!id) {
      id = crypto.randomUUID()
      localStorage.setItem(KEY, id)
    }
    return id
  } catch {
    return crypto.randomUUID()
  }
}
