// 10X RPC — /api/rpc/rotate — RPC Auto Rotate settings (optional feature)
// Auto Rotate controls ONLY the runtime presentation (which enabled RPC is
// shown on Discord and how often it switches). It NEVER creates, deletes,
// resets, overwrites, enables or disables any RPC configuration, and it never
// touches Game RPC settings. Saved configs are 100% read-only to this route.
//
// Task 87 — the route also carries the rotation ORDER (forward | reverse |
// shuffle) and the "include Game RPC in the pool" flag. Task 89 — it also
// carries the EXPLICIT rotation pool (`slots`: candidate keys — RpcConfig ids
// or "game:<slug>"): ONLY the selected RPCs take turns. Every field is
// OPTIONAL: missing fields keep their current value (partial updates are
// safe — the dashboard may send only the field the user just changed).
import { NextResponse } from 'next/server'
import { getSession } from '@/lib/session'
import { db } from '@/lib/db'
import { syncPresence } from '@/lib/presence-sync'
import { normalizeRotateOrder, normalizeRotateSecs, rotateSecsLabel, type RotateOrder } from '@/lib/rotation'
import { rotateSettingsView } from '@/lib/rpc-rotate-settings'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

/** Task 89 — sanitize an explicit rotation pool: candidate keys only
 *  (cuid-ish slot ids or "game:<slug>"), deduped, capped at 12. */
function sanitizeRotateSlots(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null
  const out: string[] = []
  for (const v of raw) {
    if (typeof v !== 'string') continue
    const k = v.trim().slice(0, 64)
    if (/^[a-z0-9_:-]{1,64}$/i.test(k) && !out.includes(k)) out.push(k)
    if (out.length >= 12) break
  }
  return out
}

export async function POST(req: Request) {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ ok: false, error: 'not_authenticated' }, { status: 401 })

    const body = await req.json().catch(() => ({})) as {
      enabled?: boolean
      secs?: number
      order?: string
      includeGame?: boolean
      slots?: string[] | null
    }

    // Merge semantics — a field the caller omitted keeps its stored value.
    const existing = await db.globalConfig.findUnique({ where: { userId: session.userId } })
    const enabled = body.enabled === undefined ? !!existing?.rpcAutoRotate : !!body.enabled
    const secs = body.secs === undefined
      ? normalizeRotateSecs(existing?.rpcRotateSecs ?? 30)
      : normalizeRotateSecs(body.secs)
    const order: RotateOrder = body.order === undefined
      ? normalizeRotateOrder(existing?.rpcRotateOrder)
      : normalizeRotateOrder(body.order)
    const includeGame = body.includeGame === undefined
      ? existing?.rpcRotateIncludeGame !== false
      : body.includeGame !== false
    // Task 89 — explicit rotation pool. undefined = keep; null = clear back
    // to "every enabled RPC rotates" (the includeGame legacy rule); an array
    // = exactly those candidates rotate.
    const slots = body.slots === undefined
      ? rotateSettingsView(existing).slots
      : sanitizeRotateSlots(body.slots)

    const updated = await db.globalConfig.upsert({
      where: { userId: session.userId },
      create: {
        userId: session.userId, rpcAutoRotate: enabled, rpcRotateSecs: secs,
        rpcRotateOrder: order, rpcRotateIncludeGame: includeGame,
        rpcRotateSlots: slots ? JSON.stringify(slots) : null,
      },
      update: {
        rpcAutoRotate: enabled, rpcRotateSecs: secs, rpcRotateOrder: order,
        rpcRotateIncludeGame: includeGame,
        rpcRotateSlots: slots && slots.length > 0 ? JSON.stringify(slots) : null,
      },
    })

    // Runtime-only change — rebuild what is being sent (rotation starts/ends
    // immediately) without modifying any configuration.
    if (session.discordAccessToken && session.rpcEnabled) {
      await syncPresence(session.userId)
    }

    const view = rotateSettingsView(updated)
    const message = enabled
      ? `Auto Rotate ON — your enabled RPC slots switch every ${rotateSecsLabel(view.secs)} (${view.order === 'shuffle' ? 'shuffled order' : `${view.order} order`}; games run in their own sessions with their own Game Auto-Rotate)`
      : 'Auto Rotate OFF — all enabled RPCs are sent together'

    return NextResponse.json({ ok: true, autoRotate: view, message })
  } catch (e: unknown) {
    console.error('Error saving rotate settings:', e instanceof Error ? e.message : e)
    return NextResponse.json({ ok: false, error: 'rotate_save_failed' }, { status: 500 })
  }
}
