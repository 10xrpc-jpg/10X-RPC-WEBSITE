// 10X RPC — Live Discord RPC Preview card (matches Roxy reference styling)
'use client'
import { useEffect, useState } from 'react'
import type { RpcConfig } from '@/lib/api-client'
import { resolveRpcActivityName } from '@/lib/constants'

interface PreviewProps {
  config: RpcConfig | null | undefined
  username?: string
  avatarUrl?: string
  platform?: string
  rpcEnabled?: boolean
  hasDiscordToken?: boolean
  lastPresenceUpdate?: string | null
}

export function DiscordPreview({ config, username, avatarUrl, platform, rpcEnabled, hasDiscordToken, lastPresenceUpdate }: PreviewProps) {
  const [now, setNow] = useState(Date.now())
  const [mountedAt] = useState(Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])

  const name = resolveRpcActivityName(config?.name, config?.platform || platform)
  const state = config?.state || ''
  const details = config?.details || ''
  const largeImage = config?.largeImage || ''
  const largeText = config?.largeText || name
  const smallImage = config?.smallImage || ''
  const smallText = config?.smallText || ''
  const startMinsAgo = config?.startMinsAgo ?? 0
  const endTotalMins = config?.endTotalMins ?? null
  const partyCurrent = config?.partyCurrent ?? 0
  const partyMax = config?.partyMax ?? 0
  const button1Label = config?.button1Label || ''
  const button1Url = config?.button1Url || ''
  const button2Label = config?.button2Label || ''
  const button2Url = config?.button2Url || ''
  const type = (config?.type || 'PLAYING').toUpperCase()

  // Compute elapsed time string anchored to baseTime
  const baseTime = (lastPresenceUpdate && !isNaN(new Date(lastPresenceUpdate).getTime()))
    ? new Date(lastPresenceUpdate).getTime()
    : mountedAt
  const startMs = baseTime - (startMinsAgo * 60 * 1000)
  const elapsedMs = Math.max(0, now - startMs)
  const elapsedStr = formatElapsed(elapsedMs)

  // Compute remaining time if endTotalMins is set
  let remainingStr = ''
  if (endTotalMins) {
    const endMs = startMs + (endTotalMins * 60 * 1000)
    const remainingMs = endMs - now
    if (remainingMs > 0) {
      remainingStr = formatRemaining(remainingMs)
    }
  }

  return (
    <div className="relative overflow-hidden bg-gradient-to-b from-[#13111d]/95 via-[#0e0d14]/95 to-[#0a0a0f] border border-white/10 rounded-[28px] p-6 shadow-2xl backdrop-blur-xl">
      {/* Ambient violet glow at top left */}
      <div className="absolute -top-16 -left-12 w-56 h-56 bg-purple-600/15 rounded-full blur-3xl pointer-events-none" />

      <div className="relative z-10">
        {/* Header: LIVE PREVIEW + Status */}
        <div className="flex items-center justify-between mb-4">
          <span className="text-xs font-bold tracking-widest text-purple-400 uppercase">
            LIVE PREVIEW
          </span>
          <div className="flex items-center gap-2">
            {hasDiscordToken === false && (
              <span className="text-[10px] uppercase tracking-wider font-bold text-yellow-400/90 bg-yellow-400/10 border border-yellow-400/20 px-2 py-0.5 rounded-full">
                DEMO
              </span>
            )}
            <span className={`inline-flex items-center gap-1.5 text-xs font-semibold ${rpcEnabled ? 'text-emerald-400' : 'text-white/40'}`}>
              <span className={`w-2 h-2 rounded-full ${rpcEnabled ? 'bg-emerald-400 animate-pulse' : 'bg-white/30'}`} />
              <span>{rpcEnabled ? 'LIVE' : 'OFFLINE'}</span>
            </span>
          </div>
        </div>

        {/* Discord-style activity card */}
        <div className="bg-[#1a1b22]/90 border border-white/10 rounded-2xl p-4 space-y-3.5 shadow-inner">
          {/* Top row: avatar + username + platform + activity name */}
          <div className="flex items-start gap-3">
            <div className="relative shrink-0">
              {avatarUrl ? (
                <img
                  src={avatarUrl}
                  alt={username || 'User'}
                  className="w-11 h-11 rounded-full object-cover ring-1 ring-white/10"
                />
              ) : (
                <div className="w-11 h-11 rounded-full bg-purple-500/40 flex items-center justify-center text-sm font-bold text-white">
                  {(username || '?').slice(0, 1).toUpperCase()}
                </div>
              )}
              {/* Discord status dot with optional VR badge */}
              {rpcEnabled && platform === 'meta_quest' ? (
                <div
                  className="absolute -bottom-1 -right-1 w-4 h-4 rounded-full bg-emerald-500 border-2 border-[#1a1b22] flex items-center justify-center text-[9px] shadow-sm animate-pulse"
                  title="Active on Meta Quest VR"
                >
                  🥽
                </div>
              ) : rpcEnabled ? (
                <div
                  className="absolute -bottom-0.5 -right-0.5 w-3.5 h-3.5 rounded-full bg-emerald-500 border-2 border-[#1a1b22]"
                  title="Online"
                />
              ) : (
                <div
                  className="absolute -bottom-0.5 -right-0.5 w-3.5 h-3.5 rounded-full bg-white/20 border-2 border-[#1a1b22]"
                  title="Offline"
                />
              )}
            </div>

            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-sm font-bold text-white truncate">{username || 'DemoUser'}</span>
                {rpcEnabled && platform && platform !== 'desktop' && (
                  <PlatformBadge platform={platform} />
                )}
              </div>
              {rpcEnabled ? (
                <div className="text-xs text-white/60 flex items-center gap-1.5 mt-0.5">
                  <span className="text-purple-400 font-bold">{type}</span>
                  <span className="truncate text-white/90 font-medium">{name}</span>
                  {elapsedStr && <span className="text-white/40 whitespace-nowrap">• {elapsedStr} elapsed</span>}
                </div>
              ) : (
                <div className="text-xs text-white/50 flex items-center gap-1.5 mt-0.5">
                  <span className="text-purple-400 font-bold">{type}</span>
                  <span className="truncate text-white/80 font-medium">{name}</span>
                  <span className="text-white/35 whitespace-nowrap">• (Offline Preview)</span>
                </div>
              )}
            </div>
          </div>

          {/* Activity detail block */}
          <div className="bg-[#121319] border border-white/5 rounded-xl p-3 flex items-center gap-3.5">
            {/* Large image */}
            <div className="relative shrink-0">
              {largeImage ? (
                isUrl(largeImage) ? (
                  <img
                    src={largeImage}
                    alt={largeText}
                    title={largeText}
                    className="w-14 h-14 rounded-xl object-cover border border-white/10"
                  />
                ) : (
                  <div
                    title={largeText}
                    className="w-14 h-14 rounded-xl purple-gradient flex items-center justify-center text-2xl font-bold text-white border border-white/10"
                  >
                    {(largeImage || name).slice(0, 1).toUpperCase()}
                  </div>
                )
              ) : (
                <div className="w-14 h-14 rounded-xl bg-[#1c1d25] border border-white/10 flex items-center justify-center text-2xl select-none">
                  🎮
                </div>
              )}
              {/* Small image overlay */}
              {smallImage && (
                <div className="absolute -bottom-1 -right-1 w-5 h-5 rounded-full border-2 border-[#121319] overflow-hidden bg-[#1c1d25] flex items-center justify-center text-[10px]">
                  {isUrl(smallImage) ? (
                    <img src={smallImage} alt={smallText} title={smallText} className="w-full h-full object-cover" />
                  ) : (
                    <span title={smallText}>⭐</span>
                  )}
                </div>
              )}
            </div>

            {/* Details & State */}
            <div className="flex-1 min-w-0 space-y-0.5">
              <div className="text-sm font-bold text-white truncate" title={name}>{name}</div>
              {details && <div className="text-xs text-white/80 font-medium truncate" title={details}>{details}</div>}
              {state && <div className="text-xs text-white/60 truncate" title={state}>{state}</div>}
              {remainingStr && (
                <div className="text-xs text-white/50 flex items-center gap-1 pt-0.5">
                  <span>⏳</span> <span>{remainingStr}</span>
                </div>
              )}
              {partyMax > 0 && partyCurrent > 0 && (
                <div className="text-xs text-white/50 flex items-center gap-1 pt-0.5">
                  <span>👥</span> <span>{partyCurrent} of {partyMax}</span>
                </div>
              )}
              {!details && !state && !remainingStr && (!partyMax || !partyCurrent) && (
                <div className="text-xs text-white/35 italic">No details set</div>
              )}
            </div>
          </div>

          {/* Interactive Buttons (if configured) */}
          {(button1Label || button2Label) && (
            <div className={`pt-1 gap-2 ${button1Label && button2Label ? 'grid grid-cols-2' : 'flex flex-col'}`}>
              {button1Label && (
                <button
                  type="button"
                  onClick={() => button1Url && window.open(button1Url, '_blank', 'noopener,noreferrer')}
                  className="w-full text-xs font-semibold text-purple-200 hover:text-white bg-[#20212b] hover:bg-[#282937] border border-white/10 hover:border-purple-500/40 rounded-xl py-2 px-3 truncate transition-all active:scale-[0.98] flex items-center justify-center gap-1.5 shadow-sm"
                  title={button1Url ? `${button1Label} (${button1Url})` : button1Label}
                >
                  <span className="truncate">{button1Label}</span>
                  {button1Url && <span className="text-[10px] text-white/40">↗</span>}
                </button>
              )}
              {button2Label && (
                <button
                  type="button"
                  onClick={() => button2Url && window.open(button2Url, '_blank', 'noopener,noreferrer')}
                  className="w-full text-xs font-semibold text-purple-200 hover:text-white bg-[#20212b] hover:bg-[#282937] border border-white/10 hover:border-purple-500/40 rounded-xl py-2 px-3 truncate transition-all active:scale-[0.98] flex items-center justify-center gap-1.5 shadow-sm"
                  title={button2Url ? `${button2Label} (${button2Url})` : button2Label}
                >
                  <span className="truncate">{button2Label}</span>
                  {button2Url && <span className="text-[10px] text-white/40">↗</span>}
                </button>
              )}
            </div>
          )}

          {!rpcEnabled && (
            <div className="bg-[#121319]/60 border border-white/5 rounded-xl p-2.5 text-center space-y-0.5">
              <div className="text-xs text-white/50 font-medium">Rich Presence is currently disabled</div>
              <div className="text-[11px] text-white/30">Turn on &quot;ENABLE RPC&quot; and click UPDATE to go live</div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function PlatformBadge({ platform }: { platform: string }) {
  const map: Record<string, { emoji: string; label: string }> = {
    mobile: { emoji: '📱', label: 'Mobile' },
    console: { emoji: '🎮', label: 'Console' },
    web: { emoji: '🌐', label: 'Web' },
    xbox: { emoji: '🎮', label: 'Xbox' },
    ps4: { emoji: '🎮', label: 'PS4' },
    ps5: { emoji: '🎮', label: 'PS5' },
    samsung: { emoji: '📱', label: 'Samsung' },
    ios: { emoji: '📱', label: 'iOS' },
    android: { emoji: '📱', label: 'Android' },
    embedded: { emoji: '🥽', label: 'Embedded' },
    meta_quest: { emoji: '🥽', label: 'Meta Quest VR' },
  }
  const p = map[platform]
  if (!p) return null
  return (
    <span className="text-[11px] bg-[#2a2b36] border border-white/10 text-white/90 px-2.5 py-0.5 rounded-full inline-flex items-center gap-1.5 font-medium">
      <span>{p.emoji}</span>
      <span>{p.label}</span>
    </span>
  )
}

function isUrl(s: string): boolean {
  return /^https?:\/\//i.test(s)
}

function formatElapsed(ms: number): string {
  const totalSec = Math.floor(ms / 1000)
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = totalSec % 60
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m ${s}s`
  return `${s}s`
}

function formatRemaining(ms: number): string {
  const totalSec = Math.floor(ms / 1000)
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = totalSec % 60
  if (h > 0) return `${h}h ${m}m left`
  if (m > 0) return `${m}m ${s}s left`
  return `${s}s left`
}
