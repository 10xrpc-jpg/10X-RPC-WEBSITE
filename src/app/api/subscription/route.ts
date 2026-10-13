// 10X RPC — /api/subscription — current user's subscription state.
// Runs the lazy per-user sweep first, so a trial/period that just ended is
// reflected (status → suspended, RPC killed) on the very next poll.
import { NextResponse } from 'next/server'
import { getSession } from '@/lib/session'
import { sweepSubscription, subscriptionView } from '@/lib/subscription'
import { CONFIG } from '@/lib/config'
import { getTrialConfig } from '@/lib/trial-config'

export const dynamic = 'force-dynamic'

export async function GET() {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'not_authenticated' }, { status: 401 })

  const { sub, transitioned } = await sweepSubscription(session.userId, session.user.discordId)

  return NextResponse.json({
    ok: true,
    subscription: subscriptionView(sub, session.user.discordId),
    transitioned,
    renewUrl: CONFIG.discord.inviteUrl,
    trialDays: (await getTrialConfig()).days,
  })
}
