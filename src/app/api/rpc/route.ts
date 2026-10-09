// 10X RPC — /api/rpc — Save & Load RPC Config (Database as Single Source of Truth)
import { NextResponse } from 'next/server'
import { getSession } from '@/lib/session'
import { db } from '@/lib/db'
import { syncPresence } from '@/lib/presence-sync'
import { resolveRpcActivityName } from '@/lib/constants'
import { capStr, capNum, LIMIT_TEXT, LIMIT_ASSET_REF, LIMIT_URL, LIMIT_SHORT } from '@/lib/validate'

export const dynamic = 'force-dynamic'

export interface RpcSaveInput {
  name?: string
  type?: string
  platform?: string
  state?: string | null
  details?: string | null
  largeImage?: string | null
  largeText?: string | null
  smallImage?: string | null
  smallText?: string | null
  button1Label?: string | null
  button1Url?: string | null
  button2Label?: string | null
  button2Url?: string | null
  partyCurrent?: number | null
  partyMax?: number | null
  partyId?: string | null
  partySecret?: string | null
  startMinsAgo?: number | null
  endTotalMins?: number | null
  enabled?: boolean
}

export async function POST(req: Request) {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'not_authenticated' }, { status: 401 })

    const body: RpcSaveInput = await req.json()

    // ════════════════════════════════════════════════════════════════════
    // ENABLED-STATE INDEPENDENCE GUARANTEE (Button Config bug fix):
    // A configuration save (Rich Presence form UPDATE, incl. Button Config)
    // must NEVER change the RPC enabled/disabled state. The DB is the single
    // source of truth for `enabled`; enabling/disabling happens EXCLUSIVELY
    // through /api/rpc/toggle. Previously `enabled` came from the request
    // body (`!!body.enabled`), so a save with a stale client-side switch
    // silently flipped the DB to disabled and called stopUserRpc — turning
    // the user's RPC OFF whenever only the buttons were updated.
    // ════════════════════════════════════════════════════════════════════
    const existing = await db.rpcConfig.findFirst({ where: { userId: session.userId } })
    const enabled = existing?.enabled ?? false // preserved, never body-driven

    const platform = body.platform || existing?.platform || 'desktop'
    const name = resolveRpcActivityName(body.name, platform)

    const data = {
      name,
      type: body.type || 'PLAYING',
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
      enabled, // ← unchanged from DB: config save cannot disable the RPC
    }

    // 1. Save full configuration to Database (Single Source of Truth)
    let rpcConfig
    if (existing) {
      rpcConfig = await db.rpcConfig.update({ where: { id: existing.id }, data })
    } else {
      rpcConfig = await db.rpcConfig.create({ data: { userId: session.userId, ...data } })
    }

    // 2. Bump session timestamp only — rpcEnabled / gatewayReady / status fields
    //    are OWNED by the toggle & status endpoints and stay untouched here.
    await db.session.updateMany({
      where: { userId: session.userId },
      data: {
        lastPresenceUpdate: new Date(),
      },
    })

    // 3. Sync Gateway WITHOUT changing the running state:
    //    - If the RPC is enabled in the DB: push the freshly saved config
    //      (new buttons included) to the ALREADY RUNNING presence.
    //    - If it is disabled: do NOTHING — a config save must never start or
    //      stop the presence (stopUserRpc belongs to the toggle endpoint).
    //    NOTE: with Normal RPC and Gamer RPC being separate configurations,
    //    the daemon decides which mode's config is live; a Normal config save
    //    never starts, stops or modifies a running Gamer RPC.
    if (session.discordAccessToken && enabled) {
      await syncPresence(session.userId)
    }

    // 4. Return success only AFTER database update and gateway sync complete.
    //    Surface the mutual-exclusivity state: while a GAME owns the presence,
    //    this Normal config is remembered but idle (message reflects reality).
    let message: string
    if (enabled) {
      message = 'Configuration saved & live on Discord'
    } else {
      const enabledGame = await db.gameConfig.findFirst({
        where: { userId: session.userId, enabled: true },
      })
      message = enabledGame
        ? `Configuration saved — Game RPC (${enabledGame.gameName}) is currently active`
        : 'Configuration saved (RPC is off — use the toggle to enable)'
    }

    return NextResponse.json({
      ok: true,
      rpcConfig,
      rpcEnabled: enabled,
      message,
    })
  } catch (e: any) {
    // Log details server-side only — never leak internal errors to clients.
    console.error('Error saving RPC config:', e?.message || e)
    return NextResponse.json({ ok: false, error: 'Failed to save RPC config' }, { status: 500 })
  }
}

export async function GET() {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'not_authenticated' }, { status: 401 })

  let rpcConfig = await db.rpcConfig.findFirst({ where: { userId: session.userId } })
  if (!rpcConfig) {
    // Initialize in DB so database is always populated as single source of truth
    rpcConfig = await db.rpcConfig.create({
      data: {
        userId: session.userId,
        name: '10X RPC',
        type: 'PLAYING',
        platform: 'desktop',
        state: null,
        details: null,
        largeImage: null,
        largeText: null,
        smallImage: null,
        smallText: null,
        button1Label: null,
        button1Url: null,
        button2Label: null,
        button2Url: null,
        partyCurrent: null,
        partyMax: null,
        partyId: null,
        partySecret: null,
        startMinsAgo: 0,
        endTotalMins: null,
        enabled: false,
      },
    })
  }

  return NextResponse.json({ rpcConfig })
}
