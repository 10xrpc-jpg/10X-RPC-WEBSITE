// 10X RPC — /uptime — live status page: regions, ping, 24/7 daemon health.
// Public page. Auto-refreshes every 20s; pings every backend component from the
// server (database, daemon node, Discord API, Pterodactyl node) and measures the
// visitor's own browser → 10X RPC ping locally.
'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from './useRouter'
import { GhostButton, Badge, Card } from './ui'
import type { UptimeReport } from '@/lib/uptime'

const REFRESH_MS = 20_000
const MAX_HISTORY = 40

type PingGrade = 'good' | 'ok' | 'slow' | 'down'

function grade(ping: number | null | undefined, ok: boolean): PingGrade {
  if (!ok || ping == null) return 'down'
  if (ping < 150) return 'good'
  if (ping < 350) return 'ok'
  return 'slow'
}

const GRADE_DOT: Record<PingGrade, string> = {
  good: 'bg-emerald-400',
  ok: 'bg-amber-400',
  slow: 'bg-orange-500',
  down: 'bg-red-500',
}
const GRADE_BAR: Record<PingGrade, string> = {
  good: 'bg-emerald-400',
  ok: 'bg-amber-400',
  slow: 'bg-orange-500',
  down: 'bg-red-500',
}
const GRADE_TEXT: Record<PingGrade, string> = {
  good: 'text-emerald-400',
  ok: 'text-amber-400',
  slow: 'text-orange-400',
  down: 'text-red-400',
}

function fmtMs(ping: number | null | undefined): string {
  return ping == null ? '—' : `${Math.round(ping)} ms`
}

function fmtUptime(sec: number | null | undefined): string {
  if (sec == null) return '—'
  const d = Math.floor(sec / 86400)
  const h = Math.floor((sec % 86400) / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = Math.floor(sec % 60)
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m ${s}s`
  return `${s}s`
}

function ago(iso: string | null | undefined): string {
  if (!iso) return '—'
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000))
  return s < 5 ? 'just now' : `${s}s ago`
}

async function browserPing(): Promise<number | null> {
  const t0 = performance.now()
  try {
    const r = await fetch(`/api/health?_=${Date.now()}`, { cache: 'no-store' })
    await r.arrayBuffer()
    return performance.now() - t0
  } catch {
    return null
  }
}

export function UptimePage() {
  const { navigate } = useRouter()
  const [report, setReport] = useState<UptimeReport | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [checkedAt, setCheckedAt] = useState<number | null>(null)
  const [, tick] = useState(0) // re-render every second for "Xs ago" labels

  // Browser ping samples → session history
  const [pingHistory, setPingHistory] = useState<{ ok: boolean; ms: number | null }[]>([])
  const [pingTesting, setPingTesting] = useState(false)
  const [pingResult, setPingResult] = useState<{ best: number | null; avg: number | null } | null>(null)
  const mounted = useRef(true)

  const load = useCallback(async (manual = false) => {
    if (manual) setLoading(true)
    try {
      const r = await fetch('/api/uptime', { cache: 'no-store' })
      const j = (await r.json()) as UptimeReport
      if (!mounted.current) return
      setReport(j)
      setLoadError(null)
      setCheckedAt(Date.now())
      // One browser ping sample per refresh → live session timeline
      const ms = await browserPing()
      if (mounted.current) {
        setPingHistory(h => [...h.slice(-(MAX_HISTORY - 1)), { ok: ms != null, ms }])
      }
    } catch (e) {
      if (mounted.current) {
        setLoadError(e instanceof Error ? e.message : 'Failed to reach status API')
        setPingHistory(h => [...h.slice(-(MAX_HISTORY - 1)), { ok: false, ms: null }])
      }
    } finally {
      if (mounted.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    mounted.current = true
    load()
    const refresh = setInterval(() => load(), REFRESH_MS)
    const t = setInterval(() => tick(x => x + 1), 1000)
    return () => {
      mounted.current = false
      clearInterval(refresh)
      clearInterval(t)
    }
  }, [load])

  const runPingTest = useCallback(async () => {
    setPingTesting(true)
    setPingResult(null)
    const samples: number[] = []
    for (let i = 0; i < 3; i++) {
      const ms = await browserPing()
      if (ms != null) samples.push(ms)
      setPingHistory(h => [...h.slice(-(MAX_HISTORY - 1)), { ok: ms != null, ms }])
      await new Promise(r => setTimeout(r, 250))
    }
    if (mounted.current) {
      setPingResult({
        best: samples.length ? Math.min(...samples) : null,
        avg: samples.length ? samples.reduce((a, b) => a + b, 0) / samples.length : null,
      })
      setPingTesting(false)
    }
  }, [])

  const operational = report?.operational
  const bannerTone = report == null
    ? 'border-white/10 bg-white/5'
    : loadError || report.ok === false
      ? 'border-red-500/40 bg-red-500/10'
      : operational
        ? 'border-emerald-500/40 bg-emerald-500/10'
        : 'border-amber-500/40 bg-amber-500/10'

  const browserGrade = grade(pingHistory.at(-1)?.ms, pingHistory.at(-1)?.ok !== false)

  return (
    <div className="min-h-screen flex flex-col">
      {/* Nav */}
      <nav className="flex items-center justify-between px-4 sm:px-8 py-4 sm:py-6">
        <button onClick={() => navigate({ name: 'home' })} className="flex items-center gap-2">
          <div className="w-9 h-9 rounded-xl purple-gradient flex items-center justify-center font-black text-white">10</div>
          <span className="text-lg sm:text-xl font-bold text-white">10X RPC</span>
        </button>
        <div className="flex items-center gap-2">
          <a href="/games" className="hidden sm:block text-sm text-white/70 hover:text-white px-3 py-1.5">Games</a>
          <GhostButton onClick={() => navigate({ name: 'dashboard' })} className="text-sm">
            Dashboard
          </GhostButton>
        </div>
      </nav>

      {/* Header + overall status */}
      <header className="px-4 sm:px-8 pt-8 sm:pt-14 pb-6">
        <div className="max-w-3xl mx-auto text-center">
          <h1 className="text-4xl sm:text-6xl font-black tracking-tight text-white">Uptime</h1>
          <p className="mt-2 text-white/60 text-sm sm:text-base">
            Live status of every 10X RPC region and service — real pings, refreshed automatically.
          </p>
          <div className={`mt-8 rounded-2xl border px-5 py-5 ${bannerTone}`}>
            {loadError ? (
              <div className="flex flex-col items-center gap-1">
                <span className="flex items-center gap-2.5 text-xl sm:text-2xl font-bold text-red-400">
                  <span className="w-3.5 h-3.5 rounded-full bg-red-500 animate-pulse" />
                  Status API unreachable
                </span>
                <span className="text-sm text-white/50">{loadError}</span>
              </div>
            ) : !report ? (
              <span className="flex items-center justify-center gap-2.5 text-xl sm:text-2xl font-bold text-white/70">
                <span className="w-3.5 h-3.5 rounded-full bg-white/40 animate-pulse" />
                Checking systems…
              </span>
            ) : operational ? (
              <span className="flex items-center justify-center gap-2.5 text-xl sm:text-2xl font-bold text-emerald-400">
                <span className="w-3.5 h-3.5 rounded-full bg-emerald-400" />
                All Systems Operational
              </span>
            ) : report.degraded ? (
              <span className="flex items-center justify-center gap-2.5 text-xl sm:text-2xl font-bold text-amber-400">
                <span className="w-3.5 h-3.5 rounded-full bg-amber-400 animate-pulse" />
                Degraded Performance
              </span>
            ) : (
              <span className="flex items-center justify-center gap-2.5 text-xl sm:text-2xl font-bold text-red-400">
                <span className="w-3.5 h-3.5 rounded-full bg-red-500 animate-pulse" />
                Service Disruption
              </span>
            )}
            <p className="mt-1.5 text-xs text-white/40">
              {checkedAt ? `Last checked ${Math.max(0, Math.round((Date.now() - checkedAt) / 1000))}s ago · auto-refresh every 20s` : 'Waiting for first check…'}
              {report?.serverRegion ? ` · API region ${report.serverRegion}` : ''}
            </p>
          </div>
        </div>
      </header>

      <main className="flex-1 px-4 sm:px-8 pb-14">
        <div className="max-w-3xl mx-auto space-y-8">
          {/* Regions & ping */}
          <section aria-label="Regions and ping">
            <h2 className="text-lg font-bold text-white mb-3 flex items-center gap-2">
              <span className="text-purple-400">🌍</span> Regions &amp; Ping
            </h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <RegionCard
                title="Website API"
                subtitle={`Vercel Edge${report?.serverRegion ? ` · ${report.serverRegion}` : ''}`}
                ping={pingHistory.at(-1)?.ms ?? null}
                pingLabel="your ping"
                grade={browserGrade}
                ok={pingHistory.at(-1)?.ok !== false && !loadError}
                detail={report ? `HTTP API responding · browser → server round-trip` : 'waiting for check…'}
              />
              <RegionCard
                title="24/7 Daemon"
                subtitle={report?.node?.name ? `Orihost ${report.node.name} · Germany` : 'Orihost node'}
                ping={report?.daemon?.latencyMs}
                pingLabel="server ping"
                grade={grade(report?.daemon?.latencyMs, !!report?.daemon?.ok)}
                ok={!!report?.daemon?.ok}
                detail={
                  report?.daemon?.configured
                    ? `${report.daemon.activeConnections ?? 0}/${report.daemon.totalTrackedUsers ?? 0} sessions live · up ${fmtUptime(report.daemon.daemonUptimeSeconds)}`
                    : 'daemon URL not configured'
                }
              />
              <RegionCard
                title="Database"
                subtitle="Neon Postgres · Singapore"
                ping={report?.database?.latencyMs}
                pingLabel="server ping"
                grade={grade(report?.database?.latencyMs, !!report?.database?.ok)}
                ok={!!report?.database?.ok}
                detail={report?.database?.error ? report.database.error : 'session + config store'}
              />
              <RegionCard
                title="Discord API"
                subtitle="discord.com gateway"
                ping={report?.discord?.latencyMs}
                pingLabel="server ping"
                grade={grade(report?.discord?.latencyMs, !!report?.discord?.ok)}
                ok={!!report?.discord?.ok}
                detail={report?.discord?.error ? report.discord.error : 'presence + OAuth endpoints'}
              />
            </div>
          </section>

          {/* 24/7 daemon details */}
          <section aria-label="Daemon details">
            <h2 className="text-lg font-bold text-white mb-3 flex items-center gap-2">
              <span className="text-purple-400">🤖</span> 24/7 Daemon
            </h2>
            <Card className="space-y-4">
              {!report ? (
                <p className="text-sm text-white/50">Waiting for first check…</p>
              ) : !report.daemon.configured ? (
                <p className="text-sm text-white/50">Remote daemon not configured on this deployment.</p>
              ) : (
                <>
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge className={report.daemon.ok ? 'bg-emerald-500/15 text-emerald-400' : 'bg-red-500/15 text-red-400'}>
                      <span className={`w-2 h-2 rounded-full ${report.daemon.ok ? 'bg-emerald-400' : 'bg-red-500'}`} />
                      {report.daemon.ok ? 'Running' : report.daemon.running === false ? 'Stopped' : 'Unreachable'}
                    </Badge>
                    <Badge className="bg-white/5 text-white/70 border border-white/10">
                      ping {fmtMs(report.daemon.latencyMs)}
                    </Badge>
                    {typeof report.daemon.heartbeatAgeSec === 'number' && (
                      <Badge className="bg-white/5 text-white/70 border border-white/10">
                        heartbeat {report.daemon.heartbeatAgeSec}s ago
                      </Badge>
                    )}
                    {report.node.maintenance && (
                      <Badge className="bg-amber-500/15 text-amber-400">node under maintenance</Badge>
                    )}
                  </div>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                    <Stat label="Live sessions" value={`${report.daemon.activeConnections ?? 0}/${report.daemon.totalTrackedUsers ?? 0}`} />
                    <Stat label="Daemon uptime" value={fmtUptime(report.daemon.daemonUptimeSeconds)} />
                    <Stat label="Last tick" value={ago(report.daemon.lastTickAt)} />
                    <Stat label="Auth failed" value={String(report.daemon.authFailedUsers ?? 0)} />
                  </div>
                  {report.daemon.platforms && Object.keys(report.daemon.platforms).length > 0 && (
                    <div className="flex flex-wrap gap-2">
                      {Object.entries(report.daemon.platforms).map(([p, n]) => (
                        <Badge key={p} className="bg-purple-500/10 text-purple-300 border border-purple-500/20">
                          {p} × {n}
                        </Badge>
                      ))}
                    </div>
                  )}
                  {report.node.state && (
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-1 border-t border-white/5">
                      <Stat label={`Node ${report.node.name ?? ''}`.trim()} value={report.node.state ?? '—'} />
                      <Stat label="Node uptime" value={fmtUptime(report.node.uptimeSeconds)} />
                      <Stat label="CPU" value={report.node.cpuPercent != null ? `${report.node.cpuPercent.toFixed(1)}%` : '—'} />
                      <Stat
                        label="Memory"
                        value={
                          report.node.memoryMb != null
                            ? `${report.node.memoryMb}${report.node.memoryLimitMb ? ` / ${report.node.memoryLimitMb} MB` : ''}`
                            : '—'
                        }
                      />
                    </div>
                  )}
                </>
              )}
            </Card>
          </section>

          {/* Your ping */}
          <section aria-label="Your ping">
            <h2 className="text-lg font-bold text-white mb-3 flex items-center gap-2">
              <span className="text-purple-400">⚡</span> Your Ping
            </h2>
            <Card className="space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-sm text-white/60">
                  Round-trip from <span className="text-white font-medium">your browser</span> to 10X RPC
                  {pingResult?.best != null && (
                    <>
                      {' '}— best <span className={GRADE_TEXT[grade(pingResult.best, true)]}>{Math.round(pingResult.best)} ms</span>
                      {pingResult.avg != null && <> · avg {Math.round(pingResult.avg)} ms</>}
                    </>
                  )}
                </p>
                <GhostButton onClick={runPingTest} disabled={pingTesting} className="text-sm">
                  {pingTesting ? 'Pinging…' : 'Run ping test'}
                </GhostButton>
              </div>
              <div className="flex items-end gap-1 h-16" aria-hidden="true">
                {pingHistory.length === 0 ? (
                  <p className="text-xs text-white/30">Collecting samples…</p>
                ) : (
                  pingHistory.map((s, i) => {
                    const g = grade(s.ms, s.ok)
                    const h = s.ok && s.ms != null ? Math.max(12, Math.min(100, (s.ms / 600) * 100)) : 100
                    return (
                      <div
                        key={i}
                        className={`flex-1 min-w-[6px] rounded-t ${GRADE_BAR[g]} ${s.ok ? 'opacity-80' : 'opacity-90'}`}
                        style={{ height: `${h}%` }}
                        title={s.ok && s.ms != null ? `${Math.round(s.ms)} ms` : 'failed'}
                      />
                    )
                  })
                )}
              </div>
              <p className="text-xs text-white/40">
                {pingHistory.length} sample{pingHistory.length === 1 ? '' : 's'} this visit · one sample per auto-refresh + full test on demand ·{' '}
                <span className={GRADE_TEXT[browserGrade]}>{browserGrade === 'down' ? 'failing' : `${fmtMs(pingHistory.at(-1)?.ms)} latest`}</span>
              </p>
            </Card>
          </section>
        </div>
      </main>

      {/* Footer (sticks to bottom) */}
      <footer className="mt-auto px-4 sm:px-8 py-10 border-t border-white/5">
        <div className="max-w-2xl mx-auto text-center space-y-4">
          <div className="flex flex-wrap items-center justify-center gap-x-5 gap-y-2 text-sm text-white/60">
            <a href="/uptime" className="hover:text-white">Status</a>
            <a href="/games" className="hover:text-white">Games</a>
            <a href="https://discord.gg/jr27qeCZU" target="_blank" rel="noopener noreferrer" className="hover:text-white">Join our Discord</a>
          </div>
          <p className="text-xs text-white/40">Copyright © 2026 10X RPC. All rights reserved.</p>
          <p className="text-xs text-white/30 max-w-md mx-auto">
            10X RPC is not affiliated with, endorsed, or sponsored by Discord Inc.
          </p>
        </div>
      </footer>
    </div>
  )
}

function RegionCard({
  title, subtitle, ping, pingLabel, grade: g, ok, detail,
}: {
  title: string
  subtitle: string
  ping: number | null | undefined
  pingLabel: string
  grade: PingGrade
  ok: boolean
  detail: string
}) {
  return (
    <div className="glass-card-inner p-5">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="font-bold text-white">{title}</p>
          <p className="text-xs text-white/50 mt-0.5">{subtitle}</p>
        </div>
        <span className={`flex items-center gap-1.5 text-xs font-semibold ${GRADE_TEXT[g]}`}>
          <span className={`w-2 h-2 rounded-full ${GRADE_DOT[g]} ${ok ? '' : 'animate-pulse'}`} />
          {ok ? (g === 'slow' ? 'Slow' : 'Online') : 'Down'}
        </span>
      </div>
      <div className="mt-4 flex items-baseline gap-2">
        <span className={`text-2xl font-black ${GRADE_TEXT[g]}`}>{fmtMs(ping)}</span>
        <span className="text-xs text-white/40">{pingLabel}</span>
      </div>
      <div className="mt-2 h-1.5 rounded-full bg-white/8 overflow-hidden">
        <div
          className={`h-full rounded-full ${GRADE_BAR[g]} transition-all duration-500`}
          style={{ width: ok && ping != null ? `${Math.max(6, Math.min(100, (ping / 600) * 100))}%` : '100%' }}
        />
      </div>
      <p className="mt-3 text-xs text-white/40 truncate" title={detail}>{detail}</p>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-white/[0.03] border border-white/8 px-3 py-2.5">
      <p className="text-[10px] uppercase tracking-wider text-white/40 font-semibold truncate">{label}</p>
      <p className="text-sm font-bold text-white mt-0.5 truncate">{value}</p>
    </div>
  )
}
