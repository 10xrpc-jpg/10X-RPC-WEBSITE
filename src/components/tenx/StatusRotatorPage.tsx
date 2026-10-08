// 10X RPC — Status Rotator page (#/rotator) with Add Preset modal + reordering
'use client'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { api, type RotatorPreset, type Me } from '@/lib/api-client'
import { useRouter } from './useRouter'
import { Card, PrimaryButton, GhostButton, PurpleSwitch, BackButton } from './ui'
import { MAX_ROTATOR_PRESETS, DEFAULT_ROTATOR_PRESETS } from '@/lib/rotator'
import { DiscordEmoji, normalizeEmojiInput } from './Emoji'

type StatusType = 'online' | 'idle' | 'dnd'

export function StatusRotatorPage({ initial }: { initial?: Me }) {
  const { navigate } = useRouter()
  const [presets, setPresets] = useState<RotatorPreset[]>(initial?.rotatorPresets || [])
  const [enabled, setEnabled] = useState(initial?.rotatorEnabled ?? false)
  const [loading, setLoading] = useState(!initial?.rotatorPresets)
  const [modalOpen, setModalOpen] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!initial?.rotatorPresets) {
      api.rotatorList().then(r => { setPresets(r.presets); setLoading(false) }).catch(() => setLoading(false))
    }
  }, [initial])

  const handleToggle = async (v: boolean) => {
    setEnabled(v)
    try {
      await api.rotatorToggle(v)
      toast.success(v ? 'Rotator enabled' : 'Rotator disabled', { duration: 2000 })
    } catch (e) {
      console.error(e)
      setEnabled(!v)
      toast.error('Failed to toggle rotator')
    }
  }

  const handleAdd = async (data: { emoji: string | null; text: string; statusType: StatusType; durationSecs: number }) => {
    setBusy(true)
    try {
      const r = await api.rotatorSave({
        emoji: data.emoji,
        text: data.text,
        durationMins: Math.max(1, Math.round(data.durationSecs / 60)),
      })
      setPresets(prev => [...prev, r.preset])
      setModalOpen(false)
      toast.success('Preset added', { duration: 2000 })
    } catch (e) {
      console.error(e)
      toast.error('Failed to add preset')
    } finally {
      setBusy(false)
    }
  }

  const handleDelete = async (id: string) => {
    try {
      await api.rotatorDelete(id)
      setPresets(prev => prev.filter(p => p.id !== id))
      toast.success('Preset deleted', { duration: 2000 })
    } catch (e) {
      console.error(e)
      toast.error('Failed to delete preset')
    }
  }

  const handleMove = async (index: number, direction: 'up' | 'down') => {
    const newIndex = direction === 'up' ? index - 1 : index + 1
    if (newIndex < 0 || newIndex >= presets.length) return
    const reordered = [...presets]
    ;[reordered[index], reordered[newIndex]] = [reordered[newIndex], reordered[index]]
    // Update order fields locally
    reordered.forEach((p, i) => { p.order = i })
    setPresets(reordered)
    // Persist new order via save (idempotent)
    try {
      // Save the two swapped presets with their new order
      await api.rotatorSave({ id: reordered[newIndex].id, text: reordered[newIndex].text, emoji: reordered[newIndex].emoji, durationMins: reordered[newIndex].durationMins })
      await api.rotatorSave({ id: reordered[index].id, text: reordered[index].text, emoji: reordered[index].emoji, durationMins: reordered[index].durationMins })
      toast.success('Preset reordered', { duration: 1500 })
    } catch (e) {
      console.error(e)
      toast.error('Failed to reorder')
    }
  }

  const handleSeedDefaults = async () => {
    setBusy(true)
    try {
      const current = presets.length
      const toAdd = DEFAULT_ROTATOR_PRESETS.slice(0, Math.min(DEFAULT_ROTATOR_PRESETS.length, MAX_ROTATOR_PRESETS - current))
      const created: RotatorPreset[] = []
      for (const p of toAdd) {
        const r = await api.rotatorSave({ emoji: p.emoji, text: p.text, durationMins: p.durationMins })
        created.push(r.preset)
      }
      setPresets(prev => [...prev, ...created])
      toast.success(`Added ${created.length} default presets`, { duration: 2500 })
    } catch (e) {
      console.error(e)
      toast.error('Failed to seed presets')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="min-h-screen px-4 sm:px-6 py-6 max-w-2xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <BackButton onClick={() => navigate({ name: 'dashboard' })} />
        <h1 className="text-2xl font-bold text-white">Status Rotator</h1>
        <div className="w-16" />
      </div>

      <p className="text-sm text-white/60 mb-6 text-center">
        Automate your custom status with presets.
      </p>

      <Card>
        <div className="flex items-center justify-between glass-card-inner p-3 mb-5">
          <span className="text-sm font-semibold text-white">Enable Rotator</span>
          <PurpleSwitch checked={enabled} onCheckedChange={handleToggle} />
        </div>

        {/* Status indicator when enabled */}
        {enabled && presets.length > 0 && (
          <div className="glass-card-inner p-3 mb-4 flex items-center gap-2 text-xs">
            <span className="w-2 h-2 rounded-full bg-green-400 animate-pulse" />
            <span className="text-white/80">
              Rotator active — cycling through {presets.length} preset{presets.length === 1 ? '' : 's'}
            </span>
          </div>
        )}

        <div className="flex items-center justify-between mb-3">
          <h3 className="font-bold text-white">Presets ({presets.length}/{MAX_ROTATOR_PRESETS})</h3>
          {presets.length === 0 && (
            <GhostButton onClick={handleSeedDefaults} disabled={busy} className="text-xs px-3 py-1.5">
              + Seed Defaults
            </GhostButton>
          )}
        </div>

        {loading ? (
          <div className="glass-card-inner p-8 text-center">
            <div className="inline-block w-8 h-8 rounded-full border-2 border-purple-500/30 border-t-purple-500 animate-spin mb-3" />
            <p className="text-white/50 text-sm">Loading presets...</p>
          </div>
        ) : presets.length === 0 ? (
          <div className="glass-card-inner p-8 text-center space-y-3">
            <div className="text-4xl">🔁</div>
            <p className="text-white/60 font-medium">No presets added yet.</p>
            <p className="text-xs text-white/40 max-w-xs mx-auto">
              Create up to 20 presets and 10X RPC will cycle through them automatically at the duration you set.
            </p>
            <PrimaryButton onClick={() => setModalOpen(true)} className="text-xs px-4 py-2 mx-auto">
              + Add Your First Preset
            </PrimaryButton>
          </div>
        ) : (
          <div className="space-y-2">
            {presets.map((p, i) => (
              <PresetRow
                key={p.id || i}
                preset={p}
                index={i}
                total={presets.length}
                onMoveUp={() => handleMove(i, 'up')}
                onMoveDown={() => handleMove(i, 'down')}
                onDelete={() => p.id && handleDelete(p.id)}
              />
            ))}
          </div>
        )}

        {/* + Add Preset button */}
        {presets.length < MAX_ROTATOR_PRESETS && !loading && (
          <button
            onClick={() => setModalOpen(true)}
            disabled={busy}
            className="w-full mt-4 glass-card-inner p-3 hover:border-purple-500/30 transition-colors flex items-center justify-center gap-2 text-sm text-white/80 hover:text-white"
          >
            <span className="text-lg">+</span> Add Preset
          </button>
        )}

        {presets.length >= MAX_ROTATOR_PRESETS && (
          <p className="text-xs text-yellow-400/80 text-center mt-3">
            ⚠ Maximum {MAX_ROTATOR_PRESETS} presets reached. Delete one to add more.
          </p>
        )}

        <p className="text-xs text-white/40 italic mt-6 text-center">
          ⚠ 10X RPC is not responsible if your account gets banned or blocked. Use at your own risk.
        </p>
      </Card>

      {/* Add Preset Modal */}
      {modalOpen && (
        <AddPresetModal
          busy={busy}
          onCancel={() => setModalOpen(false)}
          onSave={handleAdd}
        />
      )}
    </div>
  )
}

// ============ Add Preset Modal ============

interface AddPresetData {
  emoji: string | null
  text: string
  statusType: StatusType
  durationSecs: number
}

function AddPresetModal({
  busy, onCancel, onSave,
}: {
  busy: boolean
  onCancel: () => void
  onSave: (data: AddPresetData) => void
}) {
  const [emoji, setEmoji] = useState('')
  const [text, setText] = useState('')
  const [statusType, setStatusType] = useState<StatusType>('online')
  const [durationSecs, setDurationSecs] = useState('15')
  const [errors, setErrors] = useState<Record<string, string>>({})

  const handleSave = () => {
    const newErrors: Record<string, string> = {}
    const em = normalizeEmojiInput(emoji)
    if (em.error) newErrors.emoji = em.error
    if (!text.trim()) newErrors.text = 'Message is required'
    if (text.length > 128) newErrors.text = 'Message too long (max 128 chars)'
    const dur = Number(durationSecs)
    if (!Number.isFinite(dur) || dur < 1) newErrors.duration = 'Duration must be at least 1 second'
    if (dur > 3600) newErrors.duration = 'Duration cannot exceed 1 hour (3600s)'
    setErrors(newErrors)
    if (Object.keys(newErrors).length > 0) return

    onSave({
      emoji: em.value,
      text: text.trim(),
      statusType,
      durationSecs: Math.max(1, dur),
    })
  }

  // Close on Escape
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm animate-in fade-in duration-150"
      onClick={onCancel}
      role="dialog"
      aria-modal="true"
      aria-labelledby="add-preset-title"
    >
      <div
        className="glass-card w-full max-w-md p-6 space-y-5 animate-in slide-in-from-bottom-3 duration-150 max-h-[90vh] overflow-y-auto styled-scroll"
        onClick={e => e.stopPropagation()}
      >
        <h2 id="add-preset-title" className="text-xl font-bold text-white">Add Preset</h2>

        {/* Emoji — unicode or Nitro custom emoji */}
        <div className="space-y-1.5">
          <label className="text-sm text-white/80 font-medium">Emoji</label>
          <input
            type="text"
            value={emoji}
            onChange={e => { setEmoji(e.target.value); if (errors.emoji) setErrors({ ...errors, emoji: '' }) }}
            placeholder="ex. ✨ or <:CuteBoy:1326137929852129345>"
            maxLength={64}
            className={`w-full bg-[#13141a] border rounded-xl px-4 py-3 text-sm text-white outline-none focus:ring-2 focus:ring-purple-500/40 placeholder:text-white/40 ${
              errors.emoji ? 'border-red-500/50' : 'border-white/8'
            }`}
            aria-label="Emoji"
            aria-invalid={!!errors.emoji}
            aria-describedby={errors.emoji ? 'emoji-error' : undefined}
          />
          {errors.emoji && (
            <p id="emoji-error" className="text-xs text-red-400" role="alert">{errors.emoji}</p>
          )}
        </div>

        {/* Message */}
        <div className="space-y-1.5">
          <label className="text-sm text-white/80 font-medium">Message</label>
          <input
            type="text"
            value={text}
            onChange={e => { setText(e.target.value); if (errors.text) setErrors({ ...errors, text: '' }) }}
            placeholder="What are you doing?"
            maxLength={128}
            className={`w-full bg-[#13141a] border rounded-xl px-4 py-3 text-sm text-white outline-none focus:ring-2 focus:ring-purple-500/40 placeholder:text-white/40 ${
              errors.text ? 'border-red-500/50' : 'border-white/8'
            }`}
            aria-label="Message"
            aria-invalid={!!errors.text}
            aria-describedby={errors.text ? 'msg-error' : undefined}
          />
          {errors.text && (
            <p id="msg-error" className="text-xs text-red-400" role="alert">{errors.text}</p>
          )}
        </div>

        {/* Status Type — connected segmented control */}
        <div className="space-y-1.5">
          <label className="text-sm text-white/80 font-medium">Status Type</label>
          <div className="flex rounded-xl border border-white/10 overflow-hidden">
            {([
              { v: 'online', label: 'ONLINE', dot: 'bg-green-500' },
              { v: 'idle', label: 'IDLE', dot: 'bg-yellow-500' },
              { v: 'dnd', label: 'DND', dot: 'bg-red-500' },
            ] as const).map((s, i) => (
              <button
                key={s.v}
                type="button"
                onClick={() => setStatusType(s.v)}
                aria-pressed={statusType === s.v}
                className={`flex-1 flex items-center justify-center gap-1.5 px-2 py-3 text-xs font-semibold transition-all ${
                  i > 0 ? 'border-l border-white/10' : ''
                } ${
                  statusType === s.v
                    ? 'bg-white/10 text-white'
                    : 'bg-[#13141a] text-white/60 hover:text-white'
                }`}
              >
                <span className={`w-2 h-2 rounded-full ${s.dot}`} />
                {s.label}
              </button>
            ))}
          </div>
        </div>

        {/* Duration (Seconds) */}
        <div className="space-y-1.5">
          <label className="text-sm text-white/80 font-medium">Duration (Seconds)</label>
          <input
            type="number"
            value={durationSecs}
            onChange={e => { setDurationSecs(e.target.value); if (errors.duration) setErrors({ ...errors, duration: '' }) }}
            min="1"
            max="3600"
            placeholder="15"
            className={`w-full bg-[#13141a] border rounded-xl px-4 py-3 text-sm text-white outline-none focus:ring-2 focus:ring-purple-500/40 ${
              errors.duration ? 'border-red-500/50' : 'border-white/8'
            }`}
            aria-label="Duration in seconds"
            aria-invalid={!!errors.duration}
          />
          {errors.duration && (
            <p className="text-xs text-red-400" role="alert">{errors.duration}</p>
          )}
        </div>

        {/* Action buttons */}
        <div className="flex justify-end gap-2 pt-2">
          <button
            onClick={onCancel}
            disabled={busy}
            className="text-sm text-white/70 hover:text-white px-4 py-2.5"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={busy || !text.trim()}
            className="bg-white text-black font-bold rounded-xl px-6 py-2.5 text-sm hover:opacity-90 active:scale-[0.98] transition-all disabled:opacity-50"
          >
            {busy ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ============ Preset Row ============

function PresetRow({
  preset, index, total, onMoveUp, onMoveDown, onDelete,
}: {
  preset: RotatorPreset
  index: number
  total: number
  onMoveUp: () => void
  onMoveDown: () => void
  onDelete: () => void
}) {
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState(preset.text)
  const [emoji, setEmoji] = useState(preset.emoji || '')
  const [duration, setDuration] = useState(String((preset.durationMins || 5) * 60))
  const [saving, setSaving] = useState(false)

  const handleSave = async () => {
    if (!text.trim()) {
      toast.error('Message cannot be empty')
      return
    }
    const em = normalizeEmojiInput(emoji)
    if (em.error) {
      toast.error(em.error)
      return
    }
    setSaving(true)
    try {
      const r = await api.rotatorSave({
        id: preset.id,
        emoji: em.value,
        text,
        durationMins: Math.max(1, Math.round(Number(duration) / 60)),
      })
      Object.assign(preset, r.preset)
      setEditing(false)
      toast.success('Preset updated', { duration: 2000 })
    } catch (e) {
      console.error(e)
      toast.error('Failed to update preset')
    } finally {
      setSaving(false)
    }
  }

  if (editing) {
    return (
      <div className="glass-card-inner p-3 space-y-2">
        <div className="flex items-center gap-2">
          <input
            type="text" value={emoji}
            onChange={e => setEmoji(e.target.value)}
            placeholder="😀 or <:name:id>"
            maxLength={64}
            className="w-24 bg-[#13141a] border border-white/8 rounded-lg px-2 py-2 text-sm text-white outline-none focus:ring-2 focus:ring-purple-500/40"
            aria-label="Emoji"
          />
          <input
            type="text" value={text}
            onChange={e => setText(e.target.value)}
            maxLength={128}
            className="flex-1 bg-[#13141a] border border-white/8 rounded-lg px-3 py-2 text-sm text-white outline-none focus:ring-2 focus:ring-purple-500/40"
            aria-label="Message"
          />
          <input
            type="number" value={duration}
            onChange={e => setDuration(e.target.value)}
            min="1" max="3600"
            className="w-16 bg-[#13141a] border border-white/8 rounded-lg px-2 py-2 text-center text-sm text-white outline-none focus:ring-2 focus:ring-purple-500/40"
            aria-label="Duration seconds"
          />
          <span className="text-xs text-white/40">s</span>
        </div>
        <div className="flex gap-2 justify-end">
          <GhostButton onClick={() => setEditing(false)} className="text-xs px-3 py-1.5">Cancel</GhostButton>
          <PrimaryButton onClick={handleSave} disabled={saving} className="text-xs px-3 py-1.5">
            {saving ? '...' : 'Save'}
          </PrimaryButton>
        </div>
      </div>
    )
  }

  return (
    <div className="glass-card-inner p-3 flex items-center gap-3">
      {/* Order index */}
      <span className="text-xs text-white/40 font-mono w-5 text-center">{index + 1}</span>
      <span className="w-7 text-center"><DiscordEmoji emoji={preset.emoji} size={22} fallback="💬" /></span>
      <div className="flex-1 min-w-0">
        <p className="text-sm text-white truncate">{preset.text}</p>
        <p className="text-xs text-white/40">{(preset.durationMins || 5) * 60}s • {preset.enabled === false ? 'disabled' : 'enabled'}</p>
      </div>
      {/* Reorder buttons */}
      <div className="flex flex-col gap-0.5">
        <button
          onClick={onMoveUp}
          disabled={index === 0}
          className="text-xs text-white/50 hover:text-white disabled:opacity-20 px-1 py-0.5"
          aria-label="Move up"
        >
          ▲
        </button>
        <button
          onClick={onMoveDown}
          disabled={index === total - 1}
          className="text-xs text-white/50 hover:text-white disabled:opacity-20 px-1 py-0.5"
          aria-label="Move down"
        >
          ▼
        </button>
      </div>
      <button onClick={() => setEditing(true)} className="text-xs text-purple-300 hover:text-purple-200 px-2 py-1">
        Edit
      </button>
      <button onClick={onDelete} className="text-xs text-red-400 hover:text-red-300 px-2 py-1" aria-label="Delete preset">
        ✕
      </button>
    </div>
  )
}
