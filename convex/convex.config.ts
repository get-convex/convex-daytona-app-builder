import rateLimiter from '@convex-dev/rate-limiter/convex.config.js'
import staticHosting from '@convex-dev/static-hosting/convex.config'
import daytona from '@daytona/convex/convex.config.js'
import { defineApp } from 'convex/server'
import { v } from 'convex/values'

const app = defineApp({
  // Typed, deploy-time-validated env vars: read them via `env` from ./_generated/server.
  env: {
    DAYTONA_API_KEY: v.string(),
  },
  // The static frontend owns the root of https://<deployment>.convex.site.
  httpPrefix: '/api',
})
app.use(daytona)
app.use(rateLimiter)
app.use(staticHosting, { httpPrefix: '/' })

export default app
