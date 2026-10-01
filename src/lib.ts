import { ConvexError } from 'convex/values'

/** Our mutations throw ConvexError with a friendly message (rate limits, busy demo...). */
export function errorText(error: unknown) {
  return error instanceof ConvexError ? String(error.data) : 'Something went wrong. Try again.'
}

export function tone(status: string) {
  return status === 'ready' ? 'ok' : status === 'error' ? 'bad' : 'busy'
}
