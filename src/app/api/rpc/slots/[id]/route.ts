// 10X RPC — /api/rpc/slots/[id] — save or delete ONE RPC slot
// Independent by design: a save/delete for slot N can never read, merge,
// overwrite or reset slot M or the Game RPC. The `enabled` flag is owned
// exclusively by /api/rpc/slots/[id]/toggle (a config save never flips it).
import { NextResponse } from 'next/server'
import { getSession } from '@/lib/session'
import { db } from '@/lib/db'
import { syncPresence, stopPresence } from '@/lib/presence-sync'
import { resolveRpcActivityName } from '@/lib/constants'
import { capStr, capNum, LIMIT_TEXT, LIMIT_ASSET_REF, LIMIT_URL, LIMIT_SHORT } from '@/lib/validate'
import { DISCORD_APP_ID_RE, isGameApplicationId } from '@/lib/games'
import { anyEnabledCandidate, serializeSlot } from '@/lib/rpc-slots'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

function normalizeAppId(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const t = v.trim()
  if (!t) return null
  if (!DISCORD_APP_ID_RE.test(t)) return null
  // Normal RPC slots never present under a game's application identity —
  // game app ids (Minecraft, Valorant, ...) are reserved for the isolated
  // Game RPC (GameConfig). Silently coerce to the 10X default (null).
  if (isGameApplicationId(t)) return null
  return t
}

/** PUT — save the configuration fields of one slot (enabled flag preserved). */
export async function PUT(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'not_authenticated' }, { status: 401 })

    // Scoped to THIS user AND THIS row — one slot can never touch another.
    const existing = await db.rpcConfig.findFirst({ where: { id, userId: session.userId } })
    if (!existing) return NextResponse.json({ ok: false, error: 'slot_not_found' }, { status: 404 })

    const body = await req.json() as Record<string, unknown>

    // ENABLED-STATE INDEPENDENCE: a config save must NEVER change the slot's
    // enabled/disabled state (same guarantee as the single-RPC era).
    const enabled = existing.enabled

    const platform = (body.platform as string) || existing.platform || 'desktop'
    const data = {
      name: resolveRpcActivityName(body.name as string, platform),
      type: (body.type as string) || existing.type || 'PLAYING',
      platform,
      state: capStr(body.state, LIMIT_TEXT),
      details: capStr(body.details, LIMIT_TEXT),
      largeImage: capStr(body.largeImage, LIMIT_ASSET_REF),
      largeText: capStr(body.largeText, LIMIT_TEXT),
      smallImage: capStr(body.smallImage, LIMIT_ASSET_REF),
      smallText: capStr(body.smallText, LIMIT_TEXT),
      button1Label: capStr(body.button1Label, LIMIT_SHORT),
      button1Url: capStr(body.button1Url, LIMIT_URL),
      button2Label: capStr(body.button2Label, LIMIT_SHORT),
      button2Url: capStr(body.button2Url, LIMIT_URL),
      partyCurrent: capNum(body.partyCurrent, 0, 9999),
      partyMax: capNum(body.partyMax, 0, 9999),
      partyId: capStr(body.partyId, LIMIT_SHORT),
      partySecret: capStr(body.partySecret, LIMIT_SHORT),
      startMinsAgo: capNum(body.startMinsAgo, 0, 10080) ?? 0,
      endTotalMins: capNum(body.endTotalMins, 0, 10080),
      appId: normalizeAppId(body.appId),
      enabled, // ← unchanged from DB: a config save cannot enable/disable the slot
    }

    const updated = await db.rpcConfig.update({ where: { id: existing.id }, data })

    await db.session.updateMany({
      where: { userId: session.userId },
      data: { lastPresenceUpdate: new Date() },
    })

    // Live slot → push the fresh fields to the ALREADY RUNNING presence.
    // Disabled slot → do nothing (a save never starts or stops presence).
    if (session.discordAccessToken && enabled) {
      await syncPresence(session.userId)
    }

    return NextResponse.json({
      ok: true,
      rpcConfig: serializeSlot(updated),
      enabled,
      message: enabled ? 'RPC saved & live on Discord' : 'RPC saved',
    })
  } catch (e: unknown) {
    console.error('Error saving RPC slot:', e instanceof Error ? e.message : e)
    return NextResponse.json({ ok: false, error: 'save_failed' }, { status: 500 })
  }
}

/** DELETE — remove ONE slot. Other slots and the Game RPC are never touched. */
export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'not_authenticated' }, { status: 401 })

    const existing = await db.rpcConfig.findFirst({ where: { id, userId: session.userId } })
    if (!existing) return NextResponse.json({ ok: false, error: 'slot_not_found' }, { status: 404 })

    const wasEnabled = existing.enabled
    await db.rpcConfig.delete({ where: { id: existing.id } })

    let message = 'RPC deleted'
    if (wasEnabled && session.discordAccessToken) {
      const moreLeft = await anyEnabledCandidate(session.userId)
      if (moreLeft) {
        // Other candidates still running — just rebuild the activity set.
        await syncPresence(session.userId)
        message = 'RPC deleted — remaining RPCs keep running'
      } else {
        // That was the last enabled candidate → clear the presence fully.
        await db.session.updateMany({
          where: { userId: session.userId },
          data: { rpcEnabled: false, lastPresenceUpdate: new Date() },
        })
        await stopPresence(session.userId)
        message = 'RPC deleted — Rich Presence cleared from Discord'
      }
    }

    return NextResponse.json({ ok: true, message })
  } catch (e: unknown) {
    console.error('Error deleting RPC slot:', e instanceof Error ? e.message : e)
    return NextResponse.json({ ok: false, error: 'delete_failed' }, { status: 500 })
  }
}
