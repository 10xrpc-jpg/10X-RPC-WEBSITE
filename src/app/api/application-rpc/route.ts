// 10X RPC — /api/application-rpc — the THIRD RPC system's own API (Task 90).
//
// Fully independent from /api/rpc/* (Normal RPC) and /api/games/* (Game RPC):
//   • reads/writes ONLY the ApplicationRpcConfig row of THIS user
//   • a config save NEVER flips the enabled flag (owned by /toggle)
//   • enabling/disabling/saving here never touches RpcConfig, GameConfig or
//     the Session RPC flags — and the reverse is equally true
//   • honest status: runState is written by the daemon (execution truth),
//     never faked by the API layer
import { NextResponse } from 'next/server'
import { getSession } from '@/lib/session'
import { db } from '@/lib/db'
import { capStr, capNum, LIMIT_TEXT, LIMIT_ASSET_REF, LIMIT_URL, LIMIT_SHORT } from '@/lib/validate'
import { resolveRpcActivityName } from '@/lib/constants'
import { validateApplicationRpcAppId } from '@/lib/application-rpc'
import { ensureApplicationRpcRow, serializeApplicationRpcRow } from '@/lib/application-rpc-server'
import { fetchDiscordApplication } from '@/lib/games'
import { presenceBackend } from '@/lib/presence-sync'
import { syncApplicationPresence } from '@/lib/application-presence-sync'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

/** GET — the user's Application RPC config + the daemon-reported run state. */
export async function GET() {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'not_authenticated' }, { status: 401 })

  const row = await ensureApplicationRpcRow(session.userId)
  return NextResponse.json({
    ok: true,
    config: serializeApplicationRpcRow(row),
    /** Where execution actually runs — lets the UI be honest about the backend. */
    backend: presenceBackend(),
  })
}

/** PUT — save the configuration fields (the enabled flag is NEVER touched). */
export async function PUT(req: Request) {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'not_authenticated' }, { status: 401 })

    const existing = await ensureApplicationRpcRow(session.userId)

    const body = await req.json() as Record<string, unknown>

    // Application ID — validated with the same rules the enable gate enforces.
    const appIdCheck = validateApplicationRpcAppId(body.appId)
    if (!appIdCheck.ok) {
      return NextResponse.json({
        ok: false,
        error: appIdCheck.reason,
        message: appIdCheck.reason === 'game_app_id_reserved'
          ? 'This Application ID belongs to the Game RPC catalog — game identities are reserved for the Game RPC system. Use any other Discord Application ID here.'
          : 'That is not a valid Discord Application ID (expected a 15–21 digit number from the Developer Portal).',
      }, { status: 400 })
    }
    const nextAppId = appIdCheck.appId
    // When an id is set/changed it must resolve to a REAL public Discord
    // application — "Validate application identifiers" is a hard gate here.
    if (nextAppId && nextAppId !== (existing.appId ?? null)) {
      const identity = await fetchDiscordApplication(nextAppId)
      if (!identity) {
        return NextResponse.json({
          ok: false,
          error: 'app_not_found',
          message: 'Discord returned no public application for this ID — double-check the Application ID in the Developer Portal.',
        }, { status: 400 })
      }
    }

    // DEVICE-SELECTION RULE — the platform is ONLY what the user explicitly
    // saved. Nothing is auto-selected: an unset/empty value stays 'desktop'
    // (the selector's "None") — the daemon resolves the icon-less session
    // label at runtime; no PlayStation/Xbox/Meta Quest default, ever.
    const platform = (body.platform as string) || existing.platform || 'desktop'
    const updated = await db.applicationRpcConfig.update({
      where: { userId: session.userId },
      data: {
        name: resolveRpcActivityName(body.name as string, platform),
        type: (body.type as string) || existing.type || 'PLAYING',
        platform,
        appId: nextAppId,
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
        startMinsAgo: capNum(body.startMinsAgo, 0, 10080) ?? 0,
        endTotalMins: capNum(body.endTotalMins, 0, 10080),
        // enabled deliberately ABSENT — a save cannot enable/disable the RPC.
      },
    })

    // Live config → push the fresh fields; disabled → nothing to do (a save
    // never starts or stops presence).
    if (session.discordAccessToken && updated.enabled) {
      await syncApplicationPresence(session.userId)
    }

    return NextResponse.json({
      ok: true,
      config: serializeApplicationRpcRow(updated),
      enabled: updated.enabled,
      message: updated.enabled ? 'Application RPC saved & live on Discord' : 'Application RPC saved',
    })
  } catch (e: unknown) {
    console.error('Error saving Application RPC:', e instanceof Error ? e.message : e)
    return NextResponse.json({ ok: false, error: 'save_failed' }, { status: 500 })
  }
}
