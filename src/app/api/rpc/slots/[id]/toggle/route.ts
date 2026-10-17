// 10X RPC — /api/rpc/slots/[id]/toggle — enable/disable ONE RPC slot
// Each slot has its OWN independent status (never a global RPC switch):
//   • enable  → this slot's flag ON; ALL OTHER RPC1/2/3 slots are atomically
//     turned OFF in the same DB transaction (Task 108 mutual exclusivity —
//     at most one Normal RPC slot is active at any time). Game RPC, the
//     Application RPC and every saved field are never touched.
//   • disable → this slot's flag OFF; other candidates keep running untouched
// Task 113 — AUTO ROTATE LIFECYCLE: while Auto Rotate is ON the rotator OWNS
// the pool members' switches. After every toggle this route re-applies the
// rotation truth instantly (rpc-rotation-lifecycle.ts — the exact member the
// shared clock math picks is the one left enabled), so the switches, the DB
// and Discord always agree: a slot enabled out of turn hands back to the
// rotation within this very request, a rotation member disabled by hand is
// kept live by its turn. Messages describe exactly that — no stale UI.
import { NextResponse } from 'next/server'
import { getSession } from '@/lib/session'
import { db } from '@/lib/db'
import { syncPresence, syncPresenceVerified, stopPresence } from '@/lib/presence-sync'
import { requireSubscriptionAccess } from '@/lib/subscription'
import { enableSlotExclusively, rotationCoversAnySlot, serializeSlot } from '@/lib/rpc-slots'
import { ensureRpcConfiguredColumn, visibleRpcRows } from '@/lib/rpc-configured'
import { reconcileRpcRotationFlags } from '@/lib/rpc-rotation-lifecycle'
import { rotateSettingsView } from '@/lib/rpc-rotate-settings'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

/**
 * Task 113 — snap the slot enabled flags to the Auto-Rotate truth RIGHT NOW.
 * No-op (zero writes) when Auto Rotate is off or the master RPC gate is off.
 * Returns whether rotation is running and which slot number is live.
 */
async function applyRotationTruth(userId: string, masterOn: boolean): Promise<{ rotationOn: boolean; currentSlot: number | null; currentId: string | null }> {
  try {
    const gc = await db.globalConfig.findUnique({ where: { userId } })
    const view = rotateSettingsView(gc)
    if (!view.enabled || !masterOn) return { rotationOn: false, currentSlot: null, currentId: null }
    await ensureRpcConfiguredColumn()
    const rows = visibleRpcRows(await db.rpcConfig.findMany({
      where: { userId },
      orderBy: [{ slot: 'asc' }, { createdAt: 'asc' }],
    }))
    if (rows.length === 0) return { rotationOn: true, currentSlot: null, currentId: null }
    const result = await reconcileRpcRotationFlags(
      userId,
      { enabled: true, secs: view.secs, order: view.order, skip: view.skip, refMs: view.refMs, slots: view.slots, seed: userId },
      rows.map(r => ({ id: r.id as string, enabled: !!r.enabled, createdAtMs: new Date(r.createdAt as Date).getTime() })),
      Date.now(),
      masterOn,
    )
    const currentRow = rows.find(r => r.id === result.currentId) as { slot?: number } | undefined
    return { rotationOn: true, currentSlot: currentRow?.slot ?? null, currentId: result.currentId }
  } catch (e: unknown) {
    console.warn('toggle: rotation truth reconcile failed (daemon tick will reconcile):', e instanceof Error ? e.message : e)
    return { rotationOn: false, currentSlot: null, currentId: null }
  }
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params
    const session = await getSession()
    if (!session) {
      return NextResponse.json({ ok: false, error: 'not_authenticated' }, { status: 401 })
    }

    const body = await req.json() as { enabled?: boolean }
    const enabled = !!body.enabled

    // Task 111 — the column must exist BEFORE the first RpcConfig query of
    // this process (the generated client selects configured on every read).
    await ensureRpcConfiguredColumn()

    // Scoped to THIS user AND THIS row — no cross-slot writes, ever.
    const slot = await db.rpcConfig.findFirst({ where: { id, userId: session.userId } })
    if (!slot) return NextResponse.json({ ok: false, error: 'slot_not_found' }, { status: 404 })

    if (enabled) {
      // 0. DISCORD LINK CHECK — a toggle without a live Discord OAuth token
      //    would flip the DB while NOTHING runs on Discord.
      if (!session.discordAccessToken) {
        return NextResponse.json(
          { ok: false, error: 'discord_not_linked', message: 'Connect your Discord account first — click Reconnect Discord.' },
          { status: 403 }
        )
      }

      // 1. Subscription gate — trialing/active only; expired → suspended.
      const denied = await requireSubscriptionAccess(session.userId, session.user.discordId)
      if (denied) {
        return NextResponse.json(
          { ok: false, error: denied.error, message: denied.message },
          { status: 403 }
        )
      }

      // 2. ATOMIC MUTUAL EXCLUSIVITY (Task 108): THIS slot ON + every other
      //    RPC1/2/3 slot OFF inside ONE serialized transaction. Rapid
      //    switching, parallel requests and page refreshes can never leave
      //    two slots enabled. Game RPC is NOT part of this transaction.
      const result = await enableSlotExclusively(session.userId, slot.id)
      if (!result.ok) {
        if (result.reason === 'slot_not_found') {
          return NextResponse.json({ ok: false, error: 'slot_not_found' }, { status: 404 })
        }
        return NextResponse.json({
          ok: false,
          error: 'toggle_failed',
          message: 'Could not enable the RPC — please try again',
        }, { status: 500 })
      }
      const updated = result.row

      // 3. Master RPC gate ON (the daemon tracks the user while any candidate runs).
      await db.session.updateMany({
        where: { userId: session.userId },
        data: { rpcEnabled: true, lastPresenceUpdate: new Date() },
      })

      // 4. Task 113 — AUTO ROTATE OWNS THE LIFECYCLE: with rotation running,
      //    re-apply its truth instantly. Enabling a slot out of turn hands
      //    the switch back to the member whose turn it is (this very request
      //    — the UI never shows a state the rotator is about to revert).
      const rot = await applyRotationTruth(session.userId, true)

      // 5. Rebuild + push the full candidate set. The daemon publishes the
      //    rotation member (or this slot when rotation is off) — and its
      //    verify chain keeps retrying until Discord CONFIRMS the running
      //    state matches the saved config (runtime verified, not just the DB
      //    flag).
      let applied: boolean | undefined
      if (session.discordAccessToken) {
        const sync = await syncPresenceVerified(session.userId)
        applied = sync.applied
      }

      // 6. Authoritative slot list for an instant UI sync (Task 111 —
      //    configured slots only; unsaved drafts are never synced here).
      const allSlots = visibleRpcRows(await db.rpcConfig.findMany({
        where: { userId: session.userId },
        orderBy: [{ slot: 'asc' }, { createdAt: 'asc' }],
      }))

      // 7. Honest message — what the user flipped vs. what the rotator runs.
      const slotNum = updated.slot
      const stillEnabled = allSlots.some(s => s.id === slot.id && s.enabled)
      let message = `RPC ${slotNum} enabled & live on Discord`
      if (rot.rotationOn) {
        const offNames = result.disabledSlots.filter(s => s > 0).map(s => `RPC ${s}`)
        const offText = offNames.length
          ? ` — ${offNames.join(offNames.length > 1 ? ' and ' : ' & ')} turned off (one RPC at a time)`
          : ''
        if (rot.currentId === slot.id) {
          message = `RPC ${slotNum} enabled & live on Discord${offText}`
        } else if (stillEnabled) {
          // Left out of the rotation selection — runs independently by design.
          message = `RPC ${slotNum} is live on Discord and sits outside your Auto Rotate selection`
        } else {
          message = rot.currentSlot != null
            ? `Auto Rotate is running — RPC ${slotNum} takes its turn automatically (RPC ${rot.currentSlot} is live now)`
            : `Auto Rotate is running — RPC ${slotNum} takes its turn automatically`
        }
      }

      return NextResponse.json({
        ok: true,
        enabled: stillEnabled,
        rpcConfig: serializeSlot({ ...(allSlots.find(s => s.id === slot.id) ?? updated) as Record<string, unknown> & { slot: number } }),
        disabledSlots: result.disabledSlots,
        slots: allSlots.map(s => serializeSlot({ ...(s as Record<string, unknown> & { slot: number }) })),
        applied,
        message,
      })
    } else {
      // THIS slot OFF — only its own flag flips.
      const updated = await db.rpcConfig.update({
        where: { id: slot.id },
        data: { enabled: false },
      })

      // Task 113 — with Auto Rotate running, its turn keeps the member live:
      // re-apply the rotation truth instantly (a disabled rotation member is
      // re-activated by its own turn; non-members stay off). No-op when
      // rotation is off — zero automatic writes, requirement 10.
      const rot = await applyRotationTruth(session.userId, !!session.rpcEnabled)

      const moreLeft = await db.rpcConfig.count({
        where: { userId: session.userId, enabled: true },
      }) > 0
        || await db.gameConfig.count({
          where: { userId: session.userId, enabled: true },
        }) > 0
        // Task 106 — Auto Rotate ON with a selection that still covers an
        // existing slot (enabled or not): the rotator keeps cycling, so this
        // is NOT the last live candidate. The slot's own flag stays OFF —
        // its turns come from the selection, not from the enable switch.
        || await rotationCoversAnySlot(session.userId)

      if (moreLeft) {
        // Other candidates still running — rebuild without this slot.
        await db.session.updateMany({
          where: { userId: session.userId },
          data: { lastPresenceUpdate: new Date() },
        })
        if (session.discordAccessToken) {
          await syncPresence(session.userId)
        }
        const stillRotates = rot.rotationOn || await rotationCoversAnySlot(session.userId)
        const keptLive = rot.rotationOn && rot.currentId === slot.id
        const message = keptLive
          ? `Auto Rotate keeps RPC ${updated.slot} live — turn Auto Rotate off to stop it`
          : stillRotates
            ? `RPC ${updated.slot} disabled — it still takes its Auto Rotate turns while selected`
            : `RPC ${updated.slot} disabled — remaining RPCs keep running`
        return NextResponse.json({
          ok: true,
          enabled: keptLive,
          rpcConfig: serializeSlot({ ...(updated as Record<string, unknown> & { slot: number }) }),
          message,
        })
      }

      // Last enabled candidate → master gate OFF + clear the presence.
      const statusSession = await db.session.findFirst({
        where: { userId: session.userId, statusEnabled: true },
      })
      await db.session.updateMany({
        where: { userId: session.userId },
        data: {
          rpcEnabled: false,
          gatewayReady: !!statusSession,
          lastPresenceUpdate: new Date(),
        },
      })
      if (session.discordAccessToken) {
        await stopPresence(session.userId)
      }

      return NextResponse.json({
        ok: true,
        enabled: false,
        rpcConfig: serializeSlot({ ...(updated as Record<string, unknown> & { slot: number }) }),
        message: 'RPC stopped & Rich Presence cleared from Discord',
      })
    }
  } catch (e: unknown) {
    console.error('Error in /api/rpc/slots/[id]/toggle:', e)
    return NextResponse.json({
      ok: false,
      error: 'toggle_failed',
      message: e instanceof Error ? e.message : 'Failed to toggle RPC slot',
    }, { status: 500 })
  }
}
