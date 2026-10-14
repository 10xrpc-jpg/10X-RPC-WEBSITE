// 10X RPC — Auto-Rotate Game RPC card (Task 95) — the GAMES page.
// A FULLY INDEPENDENT rotation system for Game RPCs:
//   • own switch, own interval, own order, own skip counter, own pool
//   • rotates ONLY the games the user selected (single-active invariant:
//     exactly one game runs at a time — the daemon + API enforce it)
//   • shares NOTHING with the dashboard's "Auto Rotate RPC" (that card
//     rotates RPC slots only — see RpcSlotsManager)
// Saving settings is runtime-only: saved game configurations are never
// modified (only GameConfig.enabled flags flip to realize the active game).
'use client'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { api, type GameListItem, type GameRotateSettings } from '@/lib/api-client'
import { ROTATE_SECS_OPTIONS } from '@/lib/rotation'
import { PurpleSwitch } from './ui'
import { RefreshCcw, Radio, SkipForward, Info } from 'lucide-react'

const SECS_LABEL: Record<number, string> = {
  15: '15 seconds',
  30: '30 seconds',
  45: '45 seconds',
  60: '1 minute',
  120: '2 minutes',
  300: '5 minutes',
  600: '10 minutes',
  900: '15 minutes',
  1800: '30 minutes',
}

const ORDERS: Array<{ value: 'forward' | 'reverse' | 'shuffle'; label: string }> = [
  { value: 'forward', label: 'FORWARD' },
  { value: 'reverse', label: 'REVERSE' },
  { value: 'shuffle', label: 'SHUFFLE' },
]

export function GameRotateCard({
  games,
  onGamesChanged,
  onRotateChange,
}: {
  games: GameListItem[]
  /** Called whenever rotation changes which game is active (the caller
   *  refreshes its games list so the Active pills stay truthful). */
  onGamesChanged: () => void
  /** Reports every settings change (incl. the initial load) so page-level
   *  UI (the header pill) can reflect the rotation state. */
  onRotateChange?: (v: GameRotateSettings) => void
}) {
  const [view, setView] = useState<GameRotateSettings | null>(null)
  const [saving, setSaving] = useState(false)
  const [skipping, setSkipping] = useState(false)

  useEffect(() => {
    api.gamesRotateGet()
      .then(r => {
        setView(r.gameRotate)
        onRotateChange?.(r.gameRotate)
      })
      .catch(() => setView(null))
  }, [])

  if (!view) return null // settings not loaded yet — render nothing

  const enabled = view.enabled
  const allSlugs = games.map(g => g.slug)
  // Effective pool — explicit selection, or every game when unset.
  const poolSlugs = view.slots ?? allSlugs
  const currentGame = games.find(g => g.slug === view.current)
  const secsLabel = SECS_LABEL[view.secs] ?? `${view.secs} seconds`

  const apply = (v?: GameRotateSettings) => {
    if (v) {
      setView(v)
      onRotateChange?.(v)
    }
  }

  const save = async (patch: Partial<Pick<GameRotateSettings, 'enabled' | 'secs' | 'order' | 'slots'>>, opts?: { refreshGames?: boolean }) => {
    if (saving) return
    setSaving(true)
    try {
      const res = await api.gamesRotateSave(patch)
      if (res.ok) {
        apply(res.gameRotate)
        if (res.message) toast.success(res.message, { duration: 2600 })
        if (opts?.refreshGames) onGamesChanged()
      } else {
        toast.error('Failed to save Game Auto-Rotate settings')
      }
    } catch {
      toast.error('Failed to save Game Auto-Rotate settings')
    } finally {
      setSaving(false)
    }
  }

  const handleSkip = async () => {
    if (skipping || saving) return
    setSkipping(true)
    try {
      const res = await api.gamesRotateSkip()
      if (res.ok) {
        apply(res.gameRotate)
        toast.success(res.message || 'Skipped to the next game', { duration: 2200 })
        onGamesChanged()
      } else {
        toast.error(res.message || 'Could not skip — is rotation on?')
      }
    } catch {
      toast.error('Could not skip')
    } finally {
      setSkipping(false)
    }
  }

  /** Include/remove one game in the rotation pool. `slots: null` means
   *  "every game" — the first toggle materializes the explicit list. */
  const togglePool = (slug: string) => {
    if (saving) return
    const base = view.slots ?? allSlugs
    const next = base.includes(slug) ? base.filter(s => s !== slug) : [...base, slug]
    if (next.length === 0) {
      toast.error('Keep at least one game in the rotation', { duration: 2200 })
      return
    }
    if (next.length === allSlugs.length) {
      // Everything selected — store the canonical "every game rotates".
      save({ slots: null })
      return
    }
    save({ slots: next })
  }

  const poolCount = poolSlugs.length

  return (
    <div className="relative overflow-hidden bg-gradient-to-b from-[#13111d]/95 via-[#0e0d14]/95 to-[#0a0a0f] border border-white/10 rounded-[28px] p-6 sm:p-7 shadow-2xl backdrop-blur-xl">
      <div className="absolute -top-16 left-1/4 -translate-x-1/2 w-56 h-40 bg-purple-600/10 rounded-full blur-3xl pointer-events-none" />

      {/* Header */}
      <div className="relative z-10 flex items-center justify-between gap-3 mb-1">
        <div className="flex items-center gap-2.5 min-w-0">
          <RefreshCcw className="w-5 h-5 text-white stroke-[2.2] shrink-0" />
          <h2 className="text-lg sm:text-xl font-bold text-white tracking-tight truncate">Auto-Rotate Game RPC</h2>
        </div>
        <PurpleSwitch
          checked={enabled}
          onCheckedChange={v => { save({ enabled: v }, { refreshGames: true }) }}
          ariaLabel="Auto-Rotate Game RPC on or off"
        />
      </div>

      {/* Status copy */}
      <p className="relative z-10 text-xs text-white/45 leading-relaxed mb-4 px-0.5">
        {enabled ? (
          poolCount >= 2 ? (
            <>Auto-Rotate is ON — <span className="text-white/75 font-semibold">{poolCount} selected game{poolCount > 1 ? 's' : ''}</span> switch{poolCount > 1 ? '' : 'es'} every {secsLabel} ({view.order === 'shuffle' ? 'shuffled' : view.order} order). Enabling a game manually makes it the next rotation head.</>
          ) : (
            <>Auto-Rotate is ON — select <span className="text-white/75 font-semibold">at least 2 games</span> below to start cycling. Until then your enabled game stays as-is.</>
          )
        ) : (
          <>Cycle through your selected games automatically — <span className="text-white/75 font-semibold">one Game RPC is active at a time</span> (enabling a game pauses the previous one). Fully independent from Auto Rotate RPC on the dashboard.</>
        )}
      </p>

      {/* NOW PLAYING strip */}
      {enabled && currentGame && (
        <div
          className="relative z-10 mb-4 rounded-2xl border border-purple-500/30 bg-purple-500/[0.08] p-4"
          role="status"
          aria-live="polite"
          aria-label="Live game rotation status"
        >
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-[10px] font-bold tracking-widest text-purple-300 uppercase min-w-0">
              <Radio className="w-3.5 h-3.5 animate-pulse shrink-0" aria-hidden />
              <span className="truncate">Now playing</span>
            </div>
            <button
              type="button"
              onClick={handleSkip}
              disabled={skipping || saving}
              className="flex items-center gap-1.5 rounded-full border border-purple-400/40 bg-purple-500/15 hover:bg-purple-500/30 px-3 py-1.5 text-[10px] font-bold uppercase tracking-widest text-purple-100 transition-all hover:border-purple-300/60 active:scale-95 disabled:opacity-50 cursor-pointer shrink-0"
              aria-label="Skip to the next game now"
            >
              <SkipForward className="w-3 h-3" aria-hidden />
              {skipping ? 'Skipping…' : 'Skip'}
            </button>
          </div>
          <p className="mt-2 text-sm font-bold text-white truncate">🎮 {currentGame.name}</p>
        </div>
      )}

      {/* Interval + order (disabled while OFF — same pattern as the dashboard) */}
      <div className="relative z-10">
        <label className="text-xs font-bold tracking-wider text-purple-400 uppercase block mb-1.5">
          ROTATION INTERVAL
        </label>
        <select
          value={view.secs}
          disabled={!enabled || saving}
          onChange={e => save({ secs: Number(e.target.value) })}
          className="w-full h-11 bg-[#12131a] border border-white/10 hover:border-white/20 focus:border-purple-500/50 rounded-xl px-3 text-sm text-white outline-none transition-colors disabled:opacity-50 cursor-pointer disabled:cursor-not-allowed"
          aria-label="Game rotation interval"
        >
          {ROTATE_SECS_OPTIONS.map(s => (
            <option key={s} value={s}>{SECS_LABEL[s] ?? `${s} seconds`}</option>
          ))}
        </select>
      </div>

      <div className="relative z-10 mt-3">
        <label className="text-xs font-bold tracking-wider text-purple-400 uppercase block mb-1.5">
          ROTATION ORDER
        </label>
        <div className="grid grid-cols-3 gap-2" role="group" aria-label="Game rotation order">
          {ORDERS.map(o => (
            <button
              key={o.value}
              type="button"
              disabled={!enabled || saving}
              onClick={() => save({ order: o.value })}
              className={`h-10 rounded-xl border text-[10px] font-bold uppercase tracking-widest transition-all cursor-pointer disabled:cursor-not-allowed disabled:opacity-50 ${
                view.order === o.value
                  ? 'border-purple-400/60 bg-purple-500/20 text-white'
                  : 'border-white/10 bg-white/[0.03] text-white/55 hover:border-white/25 hover:text-white'
              }`}
              aria-pressed={view.order === o.value}
            >
              {o.label}
            </button>
          ))}
        </div>
      </div>

      {/* Pool selection — which games take turns */}
      <div className="relative z-10 mt-5">
        <label className="text-xs font-bold tracking-wider text-purple-400 uppercase block mb-2">
          ROTATION GAMES
        </label>
        {games.length === 0 ? (
          <p className="text-xs text-white/40 px-0.5">
            No games yet — add or configure games below, then pick the ones that should rotate.
          </p>
        ) : (
          <div className="flex flex-wrap gap-2" role="group" aria-label="Games included in the rotation">
            {games.map(g => {
              const active = poolSlugs.includes(g.slug)
              return (
                <button
                  key={g.slug}
                  type="button"
                  disabled={saving}
                  onClick={() => togglePool(g.slug)}
                  title={active ? `${g.name} takes turns in the rotation — tap to remove` : `${g.name} sits out — tap to include`}
                  aria-pressed={active}
                  className={`inline-flex items-center gap-1.5 max-w-full rounded-full border px-3 py-1.5 text-xs font-semibold transition-all cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed ${
                    active
                      ? 'border-purple-400/60 bg-purple-500/20 text-white shadow-sm shadow-purple-900/30'
                      : 'border-white/10 bg-white/[0.03] text-white/50 hover:border-white/25 hover:text-white/80'
                  }`}
                >
                  {active && <span className="w-1.5 h-1.5 rounded-full bg-purple-300 shrink-0" aria-hidden />}
                  <span className="truncate">{g.name}</span>
                  {g.enabled && (
                    <span className="shrink-0 text-[8px] font-bold uppercase tracking-wider px-1 py-0.5 rounded bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">
                      Live
                    </span>
                  )}
                </button>
              )
            })}
          </div>
        )}
      </div>

      {/* Independence note */}
      <p className="relative z-10 mt-4 flex items-start gap-1.5 text-[11px] leading-relaxed text-white/40 px-0.5">
        <Info className="w-3.5 h-3.5 shrink-0 mt-0.5" aria-hidden />
        <span>
          Rotation never modifies your saved game configurations — only which one is live. It also never
          touches your Normal RPC slots or the dashboard's Auto Rotate RPC: the two rotation systems run
          on separate settings, timers and endpoints.
        </span>
      </p>
    </div>
  )
}
