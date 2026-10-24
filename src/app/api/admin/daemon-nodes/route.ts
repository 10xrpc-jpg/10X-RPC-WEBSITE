// 10X RPC — /api/admin/daemon-nodes — 24/7 backend node management.
//
// GET     → env node list + dashboard override + EFFECTIVE node list + the
//           sync secret (admin-gated; the admin must be able to copy it into
//           each node's DAEMON_SYNC_SECRET variable on the panel).
// PUT     → save the override (URL list + append/replace mode + optional sync
//           secret). Writes hit PlatformSetting "daemon_nodes"; the resolver
//           busts its cache so the next presence sync uses the new list.
// DELETE  → drop the override (env takes over again).
//
// WHY: adding/repointing a 24/7 node used to require a Vercel env change +
// redeploy. The panel API key lives with the operator, so node setup is
// self-serve: upload the node kit to the panel, then paste the node URL here.
import { NextResponse } from 'next/server'
import { requireAdmin, writeAudit, adminRateLimited } from '@/lib/admin-guard'
import { getDaemonNodes, saveDaemonNodes, resetDaemonNodes } from '@/lib/daemon-nodes'

export const dynamic = 'force-dynamic'

function mask(v: string): string {
  if (!v) return ''
  return v.length <= 4 ? '••••' : `••••••••${v.slice(-4)}`
}

export async function GET() {
  const { session, error } = await requireAdmin()
  if (error) return error
  const nodes = await getDaemonNodes()
  return NextResponse.json({
    ok: true,
    envBases: nodes.envBases,
    effectiveBases: nodes.effectiveBases,
    override: nodes.override,
    syncSecret: nodes.syncSecret, // admin-only reveal — needed to configure the node side
    syncSecretMasked: mask(nodes.syncSecret),
    syncSecretSource: nodes.syncSecretSource,
    checkedAt: new Date().toISOString(),
    actor: session.user.discordId,
  })
}

export async function PUT(request: Request) {
  const { session, error } = await requireAdmin()
  if (error) return error
  const limited = adminRateLimited(request, 'daemon-nodes-save', 20, 60_000)
  if (limited) return limited

  let body: { urls?: string; mode?: 'append' | 'replace'; syncSecret?: string } = {}
  try {
    body = (await request.json()) as typeof body
  } catch {
    return NextResponse.json({ error: 'bad_request', message: 'Invalid JSON body.' }, { status: 400 })
  }

  const before = (await getDaemonNodes()).override
  try {
    const patch: { urls?: string; mode?: 'append' | 'replace'; syncSecret?: string } = {}
    if (body.urls !== undefined) patch.urls = String(body.urls)
    if (body.mode === 'append' || body.mode === 'replace') patch.mode = body.mode
    if (body.syncSecret !== undefined) {
      const secret = String(body.syncSecret).trim()
      if (/\s/.test(secret)) {
        return NextResponse.json({ error: 'invalid_secret', message: 'Sync secret must be a single token (no spaces/newlines).' }, { status: 400 })
      }
      patch.syncSecret = secret
    }
    if (Object.keys(patch).length === 0) {
      return NextResponse.json({ error: 'no_changes', message: 'Nothing to update.' }, { status: 400 })
    }
    const override = await saveDaemonNodes(patch)
    const nodes = await getDaemonNodes()
    await writeAudit({
      action: 'daemon_nodes.config_update',
      actorId: session.user.discordId,
      actorName: session.user.username,
      targetType: 'platform',
      targetId: 'daemon_nodes',
      targetLabel: '24/7 backend nodes',
      before: { mode: before?.mode ?? '(env)', urls: before?.urls ?? '(env)', updatedAt: before?.updatedAt ?? null },
      after: { mode: override.mode, urls: override.urls, syncSecretChanged: patch.syncSecret !== undefined, updatedAt: override.updatedAt },
    })
    return NextResponse.json({
      ok: true,
      envBases: nodes.envBases,
      effectiveBases: nodes.effectiveBases,
      override: nodes.override,
      syncSecret: nodes.syncSecret,
      syncSecretMasked: mask(nodes.syncSecret),
      syncSecretSource: nodes.syncSecretSource,
    })
  } catch (e) {
    console.error('[admin/daemon-nodes] save failed:', e)
    await writeAudit({
      action: 'daemon_nodes.config_update',
      actorId: session.user.discordId,
      actorName: session.user.username,
      targetType: 'platform',
      targetId: 'daemon_nodes',
      outcome: 'error',
      reason: e instanceof Error ? e.message : 'save failed',
    })
    return NextResponse.json({ error: 'save_failed', message: 'Could not save the node list — try again.' }, { status: 500 })
  }
}

export async function DELETE(request: Request) {
  const { session, error } = await requireAdmin()
  if (error) return error
  const limited = adminRateLimited(request, 'daemon-nodes-reset', 10, 60_000)
  if (limited) return limited
  try {
    const before = (await getDaemonNodes()).override
    await resetDaemonNodes()
    const nodes = await getDaemonNodes()
    await writeAudit({
      action: 'daemon_nodes.config_reset',
      actorId: session.user.discordId,
      actorName: session.user.username,
      targetType: 'platform',
      targetId: 'daemon_nodes',
      before: { mode: before?.mode ?? null, urls: before?.urls ?? null },
      after: { source: 'env', urls: nodes.effectiveBases },
    })
    return NextResponse.json({
      ok: true,
      envBases: nodes.envBases,
      effectiveBases: nodes.effectiveBases,
      override: nodes.override,
      syncSecretMasked: mask(nodes.syncSecret),
      syncSecretSource: nodes.syncSecretSource,
    })
  } catch (e) {
    console.error('[admin/daemon-nodes] reset failed:', e)
    return NextResponse.json({ error: 'reset_failed', message: 'Could not reset — try again.' }, { status: 500 })
  }
}
