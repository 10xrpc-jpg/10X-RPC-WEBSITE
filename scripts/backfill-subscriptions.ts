// One-time backfill: create a Subscription row for every user missing one.
// Rule (mirrors ensureSubscription in src/lib/subscription.ts):
//   • legacy Trial still active  → plan free / status trialing / trialEndsAt = trial.endsAt
//   • legacy Trial expired       → plan free / status suspended
//   • no legacy Trial            → plan free / status trialing / trialEndsAt = now + 3 days
// Idempotent — skips users that already have a Subscription row.
// Run: bun scripts/backfill-subscriptions.ts  (with DATABASE_URL override from .env.local)
import { readFileSync } from 'fs'

for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_0-9]+)=(.*)$/)
  if (m && (m[1] === 'DATABASE_URL' || m[1] === 'DATABASE_URL_UNPOOLED')) process.env[m[1]] = m[2]
}

const { PrismaClient } = await import('@prisma/client')
const db = new PrismaClient()

const TRIAL_MS = 3 * 24 * 60 * 60 * 1000

async function main() {
  const users = await db.user.findMany({
    include: { trial: true, subscription: true },
  })
  const now = new Date()
  let created = 0
  for (const u of users) {
    if (u.subscription) continue
    const t = u.trial
    const data =
      t && t.endsAt > now
        ? { plan: 'free', status: 'trialing', trialEndsAt: t.endsAt }
        : t
          ? { plan: 'free', status: 'suspended', trialEndsAt: t.endsAt, suspendedAt: now }
          : { plan: 'free', status: 'trialing', trialEndsAt: new Date(now.getTime() + TRIAL_MS) }
    await db.subscription.create({ data: { userId: u.id, ...data } })
    created++
    console.log(`created for ${u.username}: ${JSON.stringify(data)}`)
  }
  console.log(`DONE — ${created} subscription row(s) created out of ${users.length} user(s)`)
}

main().catch(e => { console.error(e); process.exit(1) }).finally(() => db.$disconnect())
