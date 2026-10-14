// 10X RPC — Multi-RPC slots manager (dashboard)
// Renders one independent card per created slot (max 3), the "+ Add RPC"
// button (hidden at the cap), the optional Auto Rotate settings card, and the
// Game RPC CTA. Each slot owns its own config + enable state; no slot can
// ever affect another. Multi-Session runtime: every enabled RPC runs as its
// own Discord session at the same time — Auto Rotate is the optional
// one-at-a-time cycling mode and never modifies any saved configuration.
//
// Task 87 — the Auto Rotate card is now a full control center:
//   • LIVE "now on your profile" strip with a per-second countdown + progress
//     bar, computed from the SAME deterministic formula the daemon uses
//     (src/lib/rotation.ts) — the preview always matches Discord.
//   • Rotation ORDER: forward / reverse / shuffle (deterministic shuffle that
//     remixes every full cycle).
//   • "Keep Game RPC always visible": the game can opt OUT of the rotation
//     and stay on its own session while the slots rotate.
//   • SKIP NOW: advance to the next RPC immediately.
//   • More intervals: 15s … 30 minutes.
// Task 89 — MULTI-GAME + ROTATION SELECTION:
//   • Every enabled game is a first-class RPC in the chain (multi-Gamer-RPC:
//     all Gamer RPCs + Normal RPCs run at the same time in Multi-Session).
//   • "ROTATION RPCS" chips: the user picks EXACTLY which RPCs take turns —
//     only the highlighted ones participate in the Auto Rotator.
'use client'
import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { api, type Me, type RpcConfig } from '@/lib/api-client'
import { rotateCycleIndex, rotateNextSwitchInSecs, type RotateOrder } from '@/lib/rotation'
import { RichPresenceForm } from './RichPresenceForm'
import { PurpleSwitch } from './ui'
import {
  Plus, RefreshCcw, ChevronsDown, Layers, ArrowRight, ArrowLeft,
  Shuffle, SkipForward, Radio, Gamepad2, type LucideIcon,
} from 'lucide-react'

const ROTATE_OPTIONS = [
  { secs: 15, label: '15 seconds' },
  { secs: 30, label: '30 seconds' },
  { secs: 45, label: '45 seconds' },
  { secs: 60, label: '1 minute' },
  { secs: 120, label: '2 minutes' },
  { secs: 300, label: '5 minutes' },
  { secs: 600, label: '10 minutes' },
  { secs: 900, label: '15 minutes' },
  { secs: 1800, label: '30 minutes' },
]

const ORDER_OPTIONS: Array<{ value: RotateOrder; label: string; icon: LucideIcon; hint: string }> = [
  { value: 'forward', label: 'Forward', icon: ArrowRight, hint: 'Slot order — RPC 1 → RPC 2 → RPC 3.' },
  { value: 'reverse', label: 'Reverse', icon: ArrowLeft, hint: 'Runs the chain backwards.' },
  { value: 'shuffle', label: 'Shuffle', icon: Shuffle, hint: 'Random order — remixed every full cycle.' },
]

type AutoRotate = NonNullable<Me['autoRotate']>

const DEFAULT_ROTATE: AutoRotate = {
  enabled: false, secs: 30, order: 'forward', includeGame: true, skip: 0, refMs: null, slots: null,
}

function mmss(totalSecs: number): string {
  const s = Math.max(0, Math.floor(totalSecs))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

export function RpcSlotsManager({
  me,
  onRefresh,
  onGameRpcClick,
  onDraftChange,
}: {
  me: Me
  onRefresh: () => void
  onGameRpcClick?: () => void
  /** Live draft of an edited slot (for the profile preview merge). */
  onDraftChange?: (cfg: RpcConfig) => void
}) {
  const slots = me.rpcSlots ?? (me.rpcConfig ? [me.rpcConfig] : [])
  const rotate: AutoRotate = me.autoRotate ?? DEFAULT_ROTATE
  const atCap = slots.length >= 3

  const [adding, setAdding] = useState(false)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [duplicatingId, setDuplicatingId] = useState<string | null>(null)
  const [rotateEnabled, setRotateEnabled] = useState(rotate.enabled)
  const [rotateSecs, setRotateSecs] = useState(rotate.secs)
  const [rotateOrder, setRotateOrder] = useState<RotateOrder>(rotate.order)
  const [rotateIncludeGame, setRotateIncludeGame] = useState(rotate.includeGame)
  const [rotateSkip, setRotateSkip] = useState(rotate.skip)
  const [rotateRefMs, setRotateRefMs] = useState<number | null>(rotate.refMs)
  /** Task 89 — explicit rotation pool (candidate keys). null = every enabled
   *  RPC rotates (the stored selection is unset). */
  const [rotateSlots, setRotateSlots] = useState<string[] | null>(rotate.slots ?? null)
  const [savingRotate, setSavingRotate] = useState(false)
  const [skipping, setSkipping] = useState(false)
  const [nowMs, setNowMs] = useState(() => Date.now())

  const enabledSlots = slots.filter(s => s.enabled)
  // Task 89 — MULTI-GAME: every enabled game is its own RPC in the chain.
  const enabledGames = (me.activeGames?.length
    ? me.activeGames
    : (me.activeGame?.enabled ? [me.activeGame] : []))
    .filter(g => g.enabled)
  // Every rotate-able candidate (slots first, then games) with its stable key.
  const rotateCandidates = useMemo(() => [
    ...enabledSlots.filter(s => s.id).map(s => ({ key: s.id!, label: `RPC ${s.slot ?? '?'}`, game: false })),
    ...enabledGames.map(g => ({ key: `game:${g.slug}`, label: g.name, game: true })),
  ], [enabledSlots.map(s => s.id).join(','), enabledGames.map(g => g.slug).join(',')])
  const allKeys = rotateCandidates.map(c => c.key)
  // Effective selection — the explicit pick, or the legacy includeGame rule
  // when the user never touched the chips (games deselected → they sit out).
  const effectiveSelection = useMemo(() => {
    if (rotateSlots !== null) return rotateSlots.filter(k => allKeys.includes(k))
    return rotateIncludeGame ? allKeys : allKeys.filter(k => !k.startsWith('game:'))
  }, [rotateSlots, rotateIncludeGame, allKeys.join(',')])
  // Full chain (slots + games) — used by the Multi-Session status texts.
  const rotationChain = rotateCandidates.map(c => c.label)
  // Rotation POOL — matches the daemon EXACTLY (shared rule: explicit
  // selection, fallback to everything when the selection is empty).
  const pool = useMemo(() => {
    const sel = new Set(effectiveSelection)
    const p = rotateCandidates.filter(c => sel.has(c.key))
    return p.length > 0 ? p : rotateCandidates
  }, [effectiveSelection.join(','), rotateCandidates.map(c => c.key).join(',')])
  const poolLen = pool.length
  const masterOn = !!me.session?.rpcEnabled
  const rotating = rotateEnabled && poolLen >= 2 && masterOn

  // Live clock — ticks every second ONLY while the strip is visible.
  useEffect(() => {
    if (!rotating) return
    setNowMs(Date.now())
    const t = setInterval(() => setNowMs(Date.now()), 1000)
    return () => clearInterval(t)
  }, [rotating])

  // Same deterministic math as the daemon (shared rotation.ts) — identical
  // inputs produce the RPC that is ACTUALLY on the profile right now.
  const live = useMemo(() => {
    if (!rotating) return null
    const idx = rotateCycleIndex({
      refMs: rotateRefMs, secs: rotateSecs, skip: rotateSkip,
      order: rotateOrder, length: poolLen, seed: me.user?.id ?? 'me', nowMs,
    })
    const nextIn = rotateNextSwitchInSecs({ refMs: rotateRefMs, secs: rotateSecs, nowMs })
    const nextIdx = rotateCycleIndex({
      refMs: rotateRefMs, secs: rotateSecs, skip: rotateSkip,
      order: rotateOrder, length: poolLen, seed: me.user?.id ?? 'me',
      nowMs: nowMs + nextIn * 1000 + 250,
    })
    return {
      now: pool[idx] ?? null,
      next: pool[nextIdx] ?? null,
      nextIn,
      progressPct: Math.min(100, Math.max(0, ((rotateSecs - nextIn) / rotateSecs) * 100)),
    }
  }, [rotating, rotateRefMs, rotateSecs, rotateSkip, rotateOrder, poolLen, me.user?.id, nowMs, pool])

  const applyRotateResponse = (v?: AutoRotate) => {
    if (!v) return
    setRotateEnabled(v.enabled)
    setRotateSecs(v.secs)
    setRotateOrder(v.order)
    setRotateIncludeGame(v.includeGame)
    setRotateSkip(v.skip)
    setRotateRefMs(v.refMs)
    setRotateSlots(v.slots ?? null)
  }

  const saveRotate = async (patch: { enabled?: boolean; secs?: number; order?: RotateOrder; includeGame?: boolean; slots?: string[] | null }) => {
    setSavingRotate(true)
    try {
      const res = await api.rpcRotateSave(
        patch.enabled ?? rotateEnabled,
        patch.secs ?? rotateSecs,
        patch.order ?? rotateOrder,
        patch.includeGame ?? rotateIncludeGame,
        patch.slots !== undefined ? patch.slots : (rotateSlots ?? undefined),
      )
      if (res.ok) {
        applyRotateResponse(res.autoRotate)
        toast.success(res.message || 'Auto Rotate settings saved', { duration: 2500 })
        onRefresh()
      } else {
        toast.error('Failed to save Auto Rotate settings')
      }
    } catch (e) {
      console.error(e)
      toast.error('Failed to save Auto Rotate settings')
    } finally {
      setSavingRotate(false)
    }
  }

  /** Task 89 — include/remove one candidate in the Auto Rotator pool. */
  const toggleRotateCandidate = (key: string) => {
    if (savingRotate) return
    const current = effectiveSelection
    const next = current.includes(key) ? current.filter(k => k !== key) : [...current, key]
    if (next.length === 0) {
      toast.error('Keep at least one RPC in the rotation', { duration: 2200 })
      return
    }
    if (next.length === allKeys.length) {
      // Everything selected — store the canonical "every enabled RPC rotates".
      setRotateSlots(null)
      saveRotate({ slots: null, includeGame: true })
      return
    }
    setRotateSlots(next)
    saveRotate({ slots: next })
  }

  const handleSkip = async () => {
    if (skipping) return
    setSkipping(true)
    try {
      const res = await api.rpcRotateSkip()
      if (res.ok) {
        applyRotateResponse(res.autoRotate)
        toast.success(res.message || 'Skipped to the next RPC', { duration: 2200 })
        onRefresh()
      } else {
        toast.error(res.message || 'Could not skip — Auto Rotate may be off')
      }
    } catch (e) {
      console.error(e)
      toast.error('Could not skip')
    } finally {
      setSkipping(false)
    }
  }

  const handleAdd = async () => {
    if (adding || atCap) return
    setAdding(true)
    try {
      const res = await api.rpcSlotCreate()
      if (res.ok) {
        toast.success(`RPC ${res.slot} created`, { duration: 2200 })
        onRefresh()
      } else {
        toast.error(res.message || 'Could not add another RPC (max 3)')
      }
    } catch (e) {
      console.error(e)
      toast.error('Failed to add RPC')
    } finally {
      setAdding(false)
    }
  }

  const handleDelete = async (id: string) => {
    if (deletingId) return
    setDeletingId(id)
    try {
      const res = await api.rpcSlotDelete(id)
      if (res.ok) {
        toast.success(res.message || 'RPC deleted', { duration: 2500 })
        onRefresh()
      } else {
        toast.error('Failed to delete RPC')
      }
    } catch (e) {
      console.error(e)
      toast.error('Failed to delete RPC')
    } finally {
      setDeletingId(null)
    }
  }

  /** Duplicate a slot: create the next free slot and copy every saved field
   *  into it. The copy starts DISABLED — nothing goes live on its own. */
  const handleDuplicate = async (src: RpcConfig) => {
    if (duplicatingId || !src.id) return
    if (atCap) {
      toast.error('Maximum 3 RPCs — delete one first', { duration: 2800 })
      return
    }
    setDuplicatingId(src.id)
    try {
      const cr = await api.rpcSlotCreate()
      const newId = cr.rpcConfig?.id
      if (!cr.ok || !newId) throw new Error(cr.message || 'create failed')
      await api.rpcSlotSave(newId, {
        name: src.name ?? '10X RPC',
        type: src.type ?? 'PLAYING',
        platform: src.platform ?? 'desktop',
        state: src.state ?? null,
        details: src.details ?? null,
        largeImage: src.largeImage ?? null,
        largeText: src.largeText ?? null,
        smallImage: src.smallImage ?? null,
        smallText: src.smallText ?? null,
        button1Label: src.button1Label ?? null,
        button1Url: src.button1Url ?? null,
        button2Label: src.button2Label ?? null,
        button2Url: src.button2Url ?? null,
        partyCurrent: src.partyCurrent ?? null,
        partyMax: src.partyMax ?? null,
        partyId: src.partyId ?? null,
        partySecret: src.partySecret ?? null,
        startMinsAgo: src.startMinsAgo ?? 0,
        endTotalMins: src.endTotalMins ?? null,
        appId: src.appId ?? '',
        enabled: false,
      })
      toast.success(`RPC ${src.slot ?? ''} duplicated to RPC ${cr.slot ?? ''} — flip its switch when ready`, { duration: 3000 })
      onRefresh()
    } catch (e) {
      console.error(e)
      toast.error('Could not duplicate RPC')
    } finally {
      setDuplicatingId(null)
    }
  }

  const secsLabel = rotateSecs < 60 ? `${rotateSecs} seconds` : `${Math.round(rotateSecs / 60)} minute${rotateSecs >= 120 ? 's' : ''}`
  const orderHint = ORDER_OPTIONS.find(o => o.value === rotateOrder)?.hint

  return (
    <div className="space-y-4">
      {/* ── One independent card per created slot ── */}
      {slots.map((slot, i) => (
        <RichPresenceForm
          key={slot.id ?? slot.slot ?? i}
          initial={slot}
          slotId={slot.id}
          slotNumber={slot.slot ?? i + 1}
          collapsible
          defaultOpen={i === 0}
          rpcMode={me.session?.rpcMode ?? null}
          activeGameName={me.activeGame?.name ?? null}
          onDelete={slot.id ? () => handleDelete(slot.id!) : undefined}
          deleting={deletingId === slot.id}
          onDuplicate={slot.id ? () => handleDuplicate(slot) : undefined}
          duplicating={duplicatingId === slot.id || (duplicatingId !== null && atCap)}
          onChange={cfg => onDraftChange?.({ ...cfg, id: slot.id, slot: slot.slot })}
          onSaved={onRefresh}
          onToggle={() => onRefresh()}
        />
      ))}

      {/* ── Add RPC (hidden at the 3-slot cap) ── */}
      {!atCap ? (
        <button
          type="button"
          onClick={handleAdd}
          disabled={adding}
          className="w-full flex items-center justify-center gap-2 rounded-[28px] border border-dashed border-purple-500/40 hover:border-purple-400/70 bg-purple-500/[0.06] hover:bg-purple-500/[0.12] text-white/80 hover:text-white font-semibold text-sm uppercase tracking-widest py-5 transition-all active:scale-[0.99] disabled:opacity-50 cursor-pointer"
        >
          <Plus className="w-5 h-5" />
          {adding ? 'Adding…' : 'Add RPC'}
        </button>
      ) : (
        <p className="flex items-center justify-center gap-2 text-[11px] text-white/40 uppercase tracking-widest py-1" role="status">
          <Layers className="w-3.5 h-3.5" />
          Maximum: 3 RPCs
        </p>
      )}

      {/* ── Auto Rotate (optional, runtime-only) ── */}
      <div className="relative overflow-hidden bg-gradient-to-b from-[#13111d]/95 via-[#0e0d14]/95 to-[#0a0a0f] border border-white/10 rounded-[28px] p-6 sm:p-7 shadow-2xl backdrop-blur-xl">
        <div className="absolute -top-16 left-1/4 -translate-x-1/2 w-56 h-40 bg-purple-600/10 rounded-full blur-3xl pointer-events-none" />

        <div className="relative z-10 flex items-center justify-between gap-3 mb-1">
          <div className="flex items-center gap-2.5 min-w-0">
            <RefreshCcw className="w-5 h-5 text-white stroke-[2.2] shrink-0" />
            <h2 className="text-lg sm:text-xl font-bold text-white tracking-tight truncate">Auto Rotate RPC</h2>
          </div>
          <PurpleSwitch
            checked={rotateEnabled}
            onCheckedChange={v => { setRotateEnabled(v); saveRotate({ enabled: v }) }}
            ariaLabel="Auto Rotate on or off"
          />
        </div>

        {/* Multi-Session status — all enabled RPCs run at once as their own
            Discord sessions; Auto Rotate is the optional cycling mode. */}
        {rotationChain.length >= 2 ? (
          rotateEnabled ? (
            poolLen < 2 ? (
              // The daemon falls back to simultaneous when the pool has fewer
              // than 2 candidates — the copy must say exactly that.
              <p className="relative z-10 text-xs text-white/45 leading-relaxed mb-4 px-0.5">
                Auto Rotate is ON — select <span className="text-white/75 font-semibold">at least 2 RPCs</span> in
                ROTATION RPCS below to start cycling. Until then every enabled RPC runs at the same
                time (Multi-Session).
              </p>
            ) : (
              <p className="relative z-10 text-xs text-white/45 leading-relaxed mb-4 px-0.5">
                {poolLen < rotationChain.length
                  ? <>Auto Rotate is ON — your <span className="text-white/75 font-semibold">{poolLen} selected RPCs</span> take turns on your profile every {secsLabel} ({rotateOrder === 'shuffle' ? 'shuffled' : rotateOrder} order). RPCs you left out stay visible as usual.</>
                  : <>Auto Rotate is ON — your {rotationChain.length} RPCs take turns on your profile every{' '}{secsLabel} ({rotateOrder === 'shuffle' ? 'shuffled' : rotateOrder} order).{' '}</>}
                {' '}Turn it off to run all of them at the same time.
              </p>
            )
          ) : (
            <div className="relative z-10 mb-4 rounded-2xl border border-emerald-500/30 bg-emerald-500/[0.07] p-4" role="status">
              <div className="flex items-start gap-2.5">
                <Layers className="w-4.5 h-4.5 text-emerald-400 shrink-0 mt-0.5" aria-hidden />
                <div className="min-w-0">
                  <p className="text-xs font-semibold text-emerald-200 leading-relaxed">
                    Multi-Session is ON — all {rotationChain.length} RPCs are running at the same time ({rotationChain.join(', ')}).
                  </p>
                  <p className="mt-1 text-[11px] text-white/55 leading-relaxed">
                    Each RPC — every slot AND every enabled game — runs as its own Discord session
                    with its own device identity (desktop, phone, console, VR…), so Discord shows all
                    of them side by side. Auto Rotate stays off — nothing cycles.
                  </p>
                </div>
              </div>
            </div>
          )
        ) : (
          <p className="relative z-10 text-xs text-white/45 leading-relaxed mb-4 px-0.5">
            Optional: cycle your enabled RPCs one at a time instead of running them all at once.
            Rotation never modifies your saved configurations.
          </p>
        )}

        {/* ── LIVE rotation strip (Task 87) — matches the daemon's formula ── */}
        {rotating && live && (
          <div
            className="relative z-10 mb-4 rounded-2xl border border-purple-500/30 bg-purple-500/[0.08] p-4"
            role="status"
            aria-live="polite"
            aria-label="Live rotation status"
          >
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2 text-[10px] font-bold tracking-widest text-purple-300 uppercase min-w-0">
                <Radio className="w-3.5 h-3.5 animate-pulse shrink-0" aria-hidden />
                <span className="truncate">Now on your profile</span>
              </div>
              <button
                type="button"
                onClick={handleSkip}
                disabled={skipping || savingRotate}
                className="flex items-center gap-1.5 rounded-full border border-purple-400/40 bg-purple-500/15 hover:bg-purple-500/30 px-3 py-1.5 text-[10px] font-bold uppercase tracking-widest text-purple-100 transition-all hover:border-purple-300/60 active:scale-95 disabled:opacity-50 cursor-pointer shrink-0"
                aria-label="Skip to the next RPC now"
              >
                <SkipForward className="w-3 h-3" aria-hidden />
                {skipping ? 'Skipping…' : 'Skip now'}
              </button>
            </div>
            <div className="mt-2 flex items-baseline justify-between gap-3 min-w-0">
              <p className="text-sm font-bold text-white truncate">
                {live.now?.game ? '🎮 ' : ''}{live.now?.label ?? '—'}
              </p>
              <p className="text-[11px] text-white/55 shrink-0 tabular-nums">
                next: <span className="text-white/80 font-semibold">{live.next?.game ? '🎮 ' : ''}{live.next?.label ?? '—'}</span>
                {' '}in <span className="text-purple-200 font-bold tabular-nums">{mmss(live.nextIn)}</span>
              </p>
            </div>
            <div
              className="mt-2.5 h-1 rounded-full bg-white/10 overflow-hidden"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(live.progressPct)}
              aria-label="Time until the next switch"
            >
              <div
                className="h-full rounded-full bg-gradient-to-r from-purple-500 to-fuchsia-400 transition-all duration-1000 ease-linear"
                style={{ width: `${live.progressPct}%` }}
              />
            </div>
          </div>
        )}

        <div className="relative z-10">
          <label className="text-xs font-bold tracking-wider text-purple-400 uppercase block mb-1.5">
            ROTATION INTERVAL
          </label>
          <select
            value={rotateSecs}
            disabled={!rotateEnabled || savingRotate}
            onChange={e => {
              const secs = Number(e.target.value)
              setRotateSecs(secs)
              saveRotate({ secs })
            }}
            className="w-full h-12 bg-[#12131a] border border-white/10 hover:border-white/20 focus:border-purple-500/50 rounded-xl px-4 text-sm text-white outline-none transition-colors disabled:opacity-50 cursor-pointer"
            aria-label="Auto Rotate interval"
          >
            {ROTATE_OPTIONS.map(o => (
              <option key={o.secs} value={o.secs} className="bg-[#161720]">
                {o.label}
              </option>
            ))}
          </select>

          {/* ── Rotation order (Task 87) ── */}
          <div className="mt-4">
            <label className="text-xs font-bold tracking-wider text-purple-400 uppercase block mb-1.5">
              ROTATION ORDER
            </label>
            <div className="grid grid-cols-3 gap-2" role="group" aria-label="Rotation order">
              {ORDER_OPTIONS.map(o => {
                const active = rotateOrder === o.value
                return (
                  <button
                    key={o.value}
                    type="button"
                    disabled={!rotateEnabled || savingRotate}
                    onClick={() => { setRotateOrder(o.value); saveRotate({ order: o.value }) }}
                    aria-pressed={active}
                    className={`flex items-center justify-center gap-1.5 h-11 rounded-xl border text-xs font-bold uppercase tracking-wider transition-all active:scale-[0.97] disabled:opacity-50 cursor-pointer ${
                      active
                        ? 'border-purple-400/70 bg-purple-500/25 text-white shadow-lg shadow-purple-950/40'
                        : 'border-white/10 bg-[#12131a] text-white/60 hover:border-white/25 hover:text-white/90'
                    }`}
                  >
                    <o.icon className="w-4 h-4" aria-hidden />
                    {o.label}
                  </button>
                )
              })}
            </div>
            {orderHint && (
              <p className="mt-1.5 text-[11px] text-white/45 px-0.5">{orderHint}</p>
            )}
          </div>

          {/* ── ROTATION RPCs (Task 89) — pick EXACTLY which RPCs take turns ── */}
          {rotateCandidates.length > 0 && (
            <div className="mt-4">
              <label className="text-xs font-bold tracking-wider text-purple-400 uppercase block mb-1.5">
                ROTATION RPCS
              </label>
              <div className="flex flex-wrap gap-2" role="group" aria-label="RPCs included in the Auto Rotator">
                {rotateCandidates.map(c => {
                  const active = effectiveSelection.includes(c.key)
                  return (
                    <button
                      key={c.key}
                      type="button"
                      /* Task 89c — the pool selection is configurable WHILE rotation
                          is off: pick the members first, then flip the switch. The
                          stored selection has no runtime effect until rotation is on. */
                      disabled={savingRotate}
                      onClick={() => toggleRotateCandidate(c.key)}
                      aria-pressed={active}
                      title={active ? `${c.label} takes turns in the rotation — tap to remove` : `${c.label} sits out — tap to include`}
                      className={`flex items-center gap-1.5 h-10 px-3.5 rounded-full border text-xs font-bold tracking-wide transition-all active:scale-[0.96] disabled:opacity-50 cursor-pointer ${
                        active
                          ? 'border-purple-400/70 bg-purple-500/25 text-white shadow-lg shadow-purple-950/40'
                          : 'border-white/10 bg-[#12131a] text-white/45 hover:border-white/25 hover:text-white/80'
                      }`}
                    >
                      {c.game && <Gamepad2 className="w-3.5 h-3.5 shrink-0" aria-hidden />}
                      {c.label}
                    </button>
                  )
                })}
              </div>
              <p className="mt-1.5 text-[11px] text-white/45 px-0.5">
                Only the highlighted RPCs take turns in the Auto Rotator — tap to include or remove
                them (you can pick these before turning Auto Rotate on). RPCs left out stay visible
                as usual; nothing is ever deleted or reset.
              </p>
            </div>
          )}

          {/* Rotation order preview line */}
          {rotateEnabled && rotationChain.length > 0 && (
            <p className="mt-3 text-[11px] text-white/50 px-0.5" role="status" aria-live="polite">
              {rotateOrder === 'shuffle' ? (
                <>Shuffled rotation over:{' '}
                  <span className="text-white/75 font-semibold">{rotationChain.join(', ')}</span>
                  <span className="text-white/35"> — the order remixes every full cycle.</span>
                </>
              ) : (
                (() => {
                  const chain = rotateOrder === 'reverse' ? [...rotationChain].reverse() : rotationChain
                  return (
                    <>Rotation order:{' '}
                      <span className="text-white/75 font-semibold">{chain.join(' → ')}</span>
                      {chain.length > 1 && <span className="text-white/35"> → {chain[0]} → …</span>}
                    </>
                  )
                })()
              )}
            </p>
          )}
          {rotateEnabled && enabledSlots.length === 0 && enabledGames.length === 0 && (
            <p className="mt-3 text-[11px] text-white/50 px-0.5">
              Enable at least two RPCs to see rotation.
            </p>
          )}
          {rotateEnabled && !masterOn && rotationChain.length >= 2 && (
            <p className="mt-3 text-[11px] text-amber-300/80 px-0.5">
              Master RPC is off — turn it on to see rotation live.
            </p>
          )}
        </div>
      </div>

      {/* ── "want something cool ?" & TRY GAME RPC NOW (kept from the classic UI) ── */}
      {onGameRpcClick && (
        <div className="text-center pt-2 pb-6 space-y-4">
          <div className="space-y-1 font-['Comic_Sans_MS',_'Chalkboard_SE',_'Comic_Neue',_cursive,_sans-serif]">
            <p className="text-3xl sm:text-4xl text-white font-normal tracking-wide">
              want something cool
            </p>
            <p className="text-3xl sm:text-4xl text-white font-normal">
              ?
            </p>
          </div>

          <div className="flex justify-center py-1">
            <ChevronsDown className="w-8 h-8 text-white stroke-[2.5] animate-bounce" />
          </div>

          <button
            type="button"
            onClick={onGameRpcClick}
            className="w-full py-7 px-4 rounded-[28px] bg-gradient-to-r from-[#221b36] via-[#352554] to-[#221b36] border border-purple-500/35 hover:border-purple-400/60 shadow-2xl shadow-purple-950/50 text-center transition-all cursor-pointer group active:scale-[0.99]"
          >
            <div className="text-2xl sm:text-3xl font-black tracking-wider text-white/90 group-hover:text-white transition-colors">
              TRY GAME RPC
            </div>
            <div className="text-2xl sm:text-3xl font-black tracking-wider text-white/90 group-hover:text-white transition-colors mt-0.5">
              NOW
            </div>
          </button>
        </div>
      )}
    </div>
  )
}
