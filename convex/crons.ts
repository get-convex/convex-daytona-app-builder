import { cronJobs } from 'convex/server'
import { internal } from './_generated/api'

const crons = cronJobs()

// The public demo wipes itself every 12 hours: sandboxes, apps, everything.
crons.interval('reset demo', { hours: 12 }, internal.reset.resetDemo, {})

export default crons
