// 10X RPC — POST /api/admin/daemon-nodes/test — probe one daemon node.
//
// The admin pastes a node's public URL (panel allocation IP:port) and this
// endpoint calls `${url}/health` server-side (Vercel → node) with a short
// timeout, returning the supervisor's own health JSON summary. Confirms the
// node is reachable from the website BEFORE it joins the sync fan-out.
import { NextResponse } from 'next/server'
import { requireAdmin, adminRateLimited } from '@/lib/admin-guard'
import { sanitizeNodeUrls } from '@/lib/daemon-nodes'

export const dynamic = 'force-dynamic'

export async function POST(request: Request) {
  const { error } = await requireAdmin()
  if (error) return error
  const limited = adminRateLimited(request, 'daemon-nodes-test', 15, 60_000)
  if (limited) return limited

  let body: { url?: string } = {}
  try {
    body = (await request.json()) as typeof body
  } catch {
    return NextResponse.json({ error: 'bad_request', message: 'Invalid JSON body.' }, { status: 400 })
  }
  const urls = sanitizeNodeUrls(body.url || '')
  if (urls.length !== 1) {
    return NextResponse.json({ error: 'invalid_url', message: 'Provide exactly one node base URL (e.g. http://1.2.3.4:25613).' }, { status: 400 })
  }
  const base = urls[0]

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 8000)
  const startedAt = Date.now()
  try {
    const res = await fetch(`${base}/health`, {
      signal: controller.signal,
      cache: 'no-store',
      headers: { Accept: 'application/json' },
    })
    const latencyMs = Date.now() - startedAt
    let health: Record<string, unknown> | null = null
    try {
      health = (await res.json()) as Record<string, unknown>
    } catch {
      // non-JSON (wrong port serving something else) — still report status
    }
    const daemon = (health?.daemon ?? null) as { heartbeatAgeSec?: number | null; connected?: number | null; trackedUsers?: number | null } | null
    return NextResponse.json({
      ok: res.ok && !!health,
      url: base,
      status: res.status,
      latencyMs,
      health: health
        ? {
            service: health.service ?? null,
            uptimeSec: health.uptime ?? null,
            role: health.role ?? null,
            adopted: health.adopted ?? null,
            children: health.children ?? null,
            daemonHeartbeatAgeSec: daemon?.heartbeatAgeSec ?? null,
            connected: daemon?.connected ?? null,
            trackedUsers: daemon?.trackedUsers ?? null,
          }
        : null,
      hint: res.ok && health
        ? (daemon?.heartbeatAgeSec != null && daemon.heartbeatAgeSec <= 180
          ? 'Node is healthy — its daemon heartbeat is fresh.'
          : 'Node reachable but no FRESH daemon heartbeat — the daemon child may still be starting (or crashing). Check boot-log.txt in the panel console/files.')
        : `Reached something at ${base} but it is not a healthy 10X RPC node (HTTP ${res.status}). Check the port and that the server is running.`,
      testedAt: new Date().toISOString(),
    })
  } catch (e) {
    const latencyMs = Date.now() - startedAt
    return NextResponse.json({
      ok: false,
      url: base,
      status: 0,
      latencyMs,
      error: e instanceof Error ? e.message : 'unreachable',
      hint: `Could not reach ${base}/health within 8s. Verify the allocation's public IP:port (Panel → Network tab) and that the server is STARTED.`,
      testedAt: new Date().toISOString(),
    })
  } finally {
    clearTimeout(timer)
  }
}
