// 10X RPC — Multi-RPC slots manager (dashboard)
// Renders one independent card per created slot (max 3), the "+ Add RPC"
// button (hidden at the cap), the optional Auto Rotate settings card, and the
// Game RPC CTA. Each slot owns its own config + enable state; no slot can
// ever affect another. Multi-Session runtime: every enabled RPC runs as its
// own Discord session at the same time — Auto Rotate is the optional
// one-at-a-time cycling mode and never modifies any saved configuration.
'use client'
import { useState } from 'react'
import { toast } from 'sonner'
import { api, type Me, type RpcConfig } from '@/lib/api-client'
import { RichPresenceForm } from './RichPresenceForm'
import { PurpleSwitch } from './ui'
import { Plus, RefreshCcw, ChevronsDown, Layers } from 'lucide-react'

const ROTATE_OPTIONS = [
  { secs: 30, label: '30 seconds' },
  { secs: 60, label: '1 minute' },
  { secs: 120, label: '2 minutes' },
  { secs: 300, label: '5 minutes' },
  { secs: 600, label: '10 minutes' },
]

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
  const rotate = me.autoRotate ?? { enabled: false, secs: 30 }
  const atCap = slots.length >= 3

  const [adding, setAdding] = useState(false)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [rotateEnabled, setRotateEnabled] = useState(rotate.enabled)
  const [rotateSecs, setRotateSecs] = useState(rotate.secs)
  const [savingRotate, setSavingRotate] = useState(false)

  const enabledCount = slots.filter(s => s.enabled).length
  const enabledGame = me.activeGame?.enabled ? me.activeGame : null
  const rotationChain = [
    ...slots.filter(s => s.enabled).map(s => `RPC ${s.slot ?? '?'}`),
    ...(enabledGame ? ['Game RPC'] : []),
  ]

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

  const saveRotate = async (enabled: boolean, secs: number) => {
    setSavingRotate(true)
    try {
      const res = await api.rpcRotateSave(enabled, secs)
      if (res.ok) {
        if (res.autoRotate) {
          setRotateEnabled(res.autoRotate.enabled)
          setRotateSecs(res.autoRotate.secs)
        }
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
            onCheckedChange={v => { setRotateEnabled(v); saveRotate(v, rotateSecs) }}
          />
        </div>

        {/* Multi-Session status — all enabled RPCs run at once as their own
            Discord sessions; Auto Rotate is the optional cycling mode. */}
        {rotationChain.length >= 2 ? (
          rotateEnabled ? (
            <p className="relative z-10 text-xs text-white/45 leading-relaxed mb-4 px-0.5">
              Auto Rotate is ON — your {rotationChain.length} RPCs take turns on your profile every{' '}
              {rotateSecs < 60 ? `${rotateSecs} seconds` : `${Math.round(rotateSecs / 60)} minute${rotateSecs >= 120 ? 's' : ''}`}.{' '}
              Turn it off to run all of them at the same time.
            </p>
          ) : (
            <div className="relative z-10 mb-4 rounded-2xl border border-emerald-500/30 bg-emerald-500/[0.07] p-4" role="status">
              <div className="flex items-start gap-2.5">
                <Layers className="w-4.5 h-4.5 text-emerald-400 shrink-0 mt-0.5" aria-hidden />
                <div className="min-w-0">
                  <p className="text-xs font-semibold text-emerald-200 leading-relaxed">
                    Multi-Session is ON — all {rotationChain.length} RPCs are running at the same time ({rotationChain.join(', ')}).
                  </p>
                  <p className="mt-1 text-[11px] text-white/55 leading-relaxed">
                    Each RPC runs as its own Discord session with its own Application ID, so Discord
                    shows every RPC side by side. Auto Rotate stays off — nothing cycles.
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
              saveRotate(true, secs)
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

          {rotateEnabled && rotationChain.length > 0 && (
            <p className="mt-3 text-[11px] text-white/50 px-0.5" role="status" aria-live="polite">
              Rotation order:{' '}
              <span className="text-white/75 font-semibold">
                {rotationChain.join(' → ')}
              </span>
              {rotationChain.length > 1 && (
                <span className="text-white/35"> → {rotationChain[0]} → …</span>
              )}
            </p>
          )}
          {rotateEnabled && enabledCount === 0 && !enabledGame && (
            <p className="mt-3 text-[11px] text-white/50 px-0.5">
              Enable at least two RPCs to see rotation.
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
