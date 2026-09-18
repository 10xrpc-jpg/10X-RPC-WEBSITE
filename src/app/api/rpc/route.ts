// 10X RPC — /api/rpc — Save & Load RPC Config (Database as Single Source of Truth)
import { NextResponse } from 'next/server'
import { getSession } from '@/lib/session'
import { db } from '@/lib/db'
import { ensureDaemonRunning } from '@/lib/rpc-daemon'
import { resolveRpcActivityName } from '@/lib/constants'

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
    const enabled = !!body.enabled
    const platform = body.platform || 'desktop'
    const name = resolveRpcActivityName(body.name, platform)

    const data = {
      name,
      type: body.type || 'PLAYING',
      platform,
      state: body.state?.trim() || null,
      details: body.details?.trim() || null,
      largeImage: body.largeImage?.trim() || null,
      largeText: body.largeText?.trim() || null,
      smallImage: body.smallImage?.trim() || null,
      smallText: body.smallText?.trim() || null,
      button1Label: body.button1Label?.trim() || null,
      button1Url: body.button1Url?.trim() || null,
      button2Label: body.button2Label?.trim() || null,
      button2Url: body.button2Url?.trim() || null,
      partyCurrent: typeof body.partyCurrent === 'number' ? body.partyCurrent : null,
      partyMax: typeof body.partyMax === 'number' ? body.partyMax : null,
      partyId: body.partyId?.trim() || null,
      partySecret: body.partySecret?.trim() || null,
      startMinsAgo: typeof body.startMinsAgo === 'number' ? body.startMinsAgo : 0,
      endTotalMins: typeof body.endTotalMins === 'number' ? body.endTotalMins : null,
      enabled,
    }

    // 1. Save full configuration to Database (Single Source of Truth)
    const existing = await db.rpcConfig.findFirst({ where: { userId: session.userId } })
    let rpcConfig
    if (existing) {
      rpcConfig = await db.rpcConfig.update({ where: { id: existing.id }, data })
    } else {
      rpcConfig = await db.rpcConfig.create({ data: { userId: session.userId, ...data } })
    }

    // 2. Update Session state in Database for all active user sessions (strictly preserves status fields)
    const statusSession = await db.session.findFirst({
      where: {
        userId: session.userId,
        statusEnabled: true,
      },
    })
    const keepGateway = enabled || !!statusSession

    await db.session.updateMany({
      where: { userId: session.userId },
      data: {
        rpcEnabled: enabled,
        gatewayReady: keepGateway,
        lastPresenceUpdate: new Date(),
      },
    })

    // 3. Immediately sync Gateway:
    // If enabled: starts RPC using latest saved DB config (no glitches, exact timestamps)
    // If disabled: completely stops RPC, clears Rich Presence from Discord, stops all timers
    if (session.discordAccessToken) {
      const daemon = ensureDaemonRunning()
      if (enabled) {
        await daemon.syncUser(session.userId)
      } else {
        await daemon.stopUserRpc(session.userId)
      }
    }

    // 4. Return success only AFTER database update and gateway sync complete
    return NextResponse.json({
      ok: true,
      rpcConfig,
      message: enabled ? 'Rich Presence updated & live on Discord' : 'RPC disabled & cleared from Discord',
    })
  } catch (e: any) {
    console.error('Error saving RPC config:', e)
    return NextResponse.json({ ok: false, error: e?.message || 'Failed to save RPC config' }, { status: 500 })
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
