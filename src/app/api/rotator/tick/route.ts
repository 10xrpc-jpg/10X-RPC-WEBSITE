// 10X RPC — /api/rotator/tick — advance to next preset (called by cron or self-ping)
// Logic:
//   1. Find all users with rotatorEnabled=true
//   2. For each user, check the currently-active preset's duration
//   3. If duration elapsed, advance to the next preset (cyclically) and apply it as custom status
//   4. Returns summary of how many users were ticked
import { NextResponse } from 'next/server'
import { db } from '@/lib/db'

export const dynamic = 'force-dynamic'

// To prevent abuse, this endpoint requires a secret token in the header
// Set ROTATOR_TICK_SECRET env var on Render/Vercel to enable protection.
// If env var is not set, the endpoint is open (for dev/demo).
export async function POST(req: Request) {
  const secret = process.env.ROTATOR_TICK_SECRET
  if (secret) {
    const auth = req.headers.get('authorization') || ''
    const provided = auth.replace(/^Bearer\s+/i, '')
    if (provided !== secret) {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
    }
  }

  const ticked: string[] = []
  const errors: string[] = []
  const now = new Date()

  // Find all users with rotator enabled
  const enabledUsers = await db.globalConfig.findMany({
    where: { rotatorEnabled: true },
    include: {
      user: {
        include: {
          rotatorPresets: { orderBy: { order: 'asc' } },
          sessions: { where: { expiresAt: { gt: now } }, take: 1 },
        },
      },
    },
  })

  for (const gc of enabledUsers) {
    try {
      const presets = gc.user.rotatorPresets.filter(p => p.enabled)
      if (presets.length === 0) continue

      // Determine which preset should be active right now.
      // Strategy: compute total cycle duration, find where we are in the cycle,
      // based on a fixed reference (createdAt of the first preset).
      const totalDurationSecs = presets.reduce((sum, p) => sum + Math.max(1, p.durationMins * 60), 0)
      const referenceTime = presets[0].createdAt.getTime()
      const elapsedSecs = Math.floor((now.getTime() - referenceTime) / 1000)
      const positionInCycle = elapsedSecs % totalDurationSecs

      // Walk through presets to find the active one
      let accumulated = 0
      let activeIndex = 0
      for (let i = 0; i < presets.length; i++) {
        const dur = Math.max(1, presets[i].durationMins * 60)
        if (accumulated + dur > positionInCycle) {
          activeIndex = i
          break
        }
        accumulated += dur
      }

      const activePreset = presets[activeIndex]
      const emoji = activePreset.emoji || null
      const text = activePreset.text

      // Apply as custom status to all active sessions for this user
      for (const session of gc.user.sessions) {
        await db.session.update({
          where: { id: session.id },
          data: {
            customStatus: text,
            customStatusEmoji: emoji,
          },
        })
      }
      ticked.push(gc.user.username)
    } catch (e) {
      errors.push(`${gc.user.username}: ${e instanceof Error ? e.message : 'unknown'}`)
    }
  }

  return NextResponse.json({
    ok: true,
    tickedCount: ticked.length,
    ticked,
    errors,
    at: now.toISOString(),
  })
}
