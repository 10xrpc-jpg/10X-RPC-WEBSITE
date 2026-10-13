// 10X RPC — Configuration backup card (dashboard)
// NEW: Export every saved setting as a downloadable JSON file, or restore a
// backup on any account with one Import.
//
//   Exported: RPC slots (all fields), Status settings, Global config
//             (city/timezone/temp unit), Status-rotator presets, Auto Rotate
//             shape (interval/order/include-game).
//   NOT exported: Discord tokens, session secrets, subscription state.
//
// SAFETY GUARANTEE (matches the app's server-side invariants):
//   • Import NEVER flips any enable switch. RPC slots are saved through
//     PUT /api/rpc/slots/[id] which is server-hardcoded to preserve each
//     slot's enabled flag; new slots are created disabled. Rotator presets
//     are added row-disabled and the rotator master switch is never touched.
//     Auto Rotate saves with the account's CURRENT on/off state — only the
//     interval/order/include-game shape is restored.
//   • Everything is sanitized + clamped client-side AND server-side.
'use client'
import { useRef, useState } from 'react'
import { toast } from 'sonner'
import { api, type Me, type RpcConfig } from '@/lib/api-client'
import { DatabaseBackup, Download, Upload, Loader2, Check, TriangleAlert, FileJson } from 'lucide-react'

const BACKUP_KIND = 'config-backup'
const BACKUP_VERSION = 1

const ACTIVITY_TYPES = ['PLAYING', 'STREAMING', 'LISTENING', 'WATCHING', 'COMPETING']
const VALID_USER_STATUSES = ['online', 'idle', 'dnd', 'invisible']

type ImportSummary = {
  slotsRestored: number
  slotsCreated: number
  presetsAdded: number
  notes: string[]
}

/* ---------- tolerant sanitizers (mirror the server-side caps) ---------- */

const s = (v: unknown, max: number): string | null => {
  if (typeof v !== 'string') return null
  const t = v.trim()
  return t ? t.slice(0, max) : null
}
const num = (v: unknown, min: number, max: number): number | null => {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null
  return Math.min(max, Math.max(min, Math.round(v)))
}
const url = (v: unknown): string | null => {
  const t = s(v, 2048)
  return t && /^https?:\/\//i.test(t) ? t : null
}
const appId = (v: unknown): string => {
  const t = s(v, 21)
  return t && /^\d{15,21}$/.test(t) ? t : ''
}

/** Full sanitized slot payload — exactly what PUT /api/rpc/slots/[id] expects. */
function normalizeSlot(raw: Record<string, unknown>): RpcConfig {
  return {
    name: s(raw.name, 128) ?? '10X RPC',
    type: ACTIVITY_TYPES.includes(String(raw.type)) ? String(raw.type) : 'PLAYING',
    platform: s(raw.platform, 32) ?? 'desktop',
    state: s(raw.state, 128),
    details: s(raw.details, 128),
    largeImage: s(raw.largeImage, 1024),
    largeText: s(raw.largeText, 128),
    smallImage: s(raw.smallImage, 1024),
    smallText: s(raw.smallText, 128),
    button1Label: s(raw.button1Label, 32),
    button1Url: url(raw.button1Url),
    button2Label: s(raw.button2Label, 32),
    button2Url: url(raw.button2Url),
    partyCurrent: num(raw.partyCurrent, 0, 9999),
    partyMax: num(raw.partyMax, 0, 9999),
    partyId: s(raw.partyId, 64),
    partySecret: s(raw.partySecret, 64),
    startMinsAgo: num(raw.startMinsAgo, 0, 10080) ?? 0,
    endTotalMins: num(raw.endTotalMins, 0, 10080),
    appId: appId(raw.appId),
    enabled: false, // server preserves each slot's real enabled flag anyway
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)

export function ConfigBackupCard({ me, onRefresh }: { me: Me; onRefresh: () => void }) {
  const [busy, setBusy] = useState<'export' | 'import' | null>(null)
  const [summary, setSummary] = useState<ImportSummary | null>(null)
  const [replacePresets, setReplacePresets] = useState(true)
  const fileRef = useRef<HTMLInputElement>(null)

  /* ---------------- EXPORT ---------------- */
  const handleExport = async () => {
    if (busy) return
    setBusy('export')
    try {
      // Fresh snapshot so the file always matches what is saved right now.
      const m = await api.me()
      const slots = (m.rpcSlots ?? (m.rpcConfig ? [m.rpcConfig] : [])).map(sl => ({
        name: sl.name ?? '10X RPC',
        type: sl.type ?? 'PLAYING',
        platform: sl.platform ?? 'desktop',
        state: sl.state ?? null,
        details: sl.details ?? null,
        largeImage: sl.largeImage ?? null,
        largeText: sl.largeText ?? null,
        smallImage: sl.smallImage ?? null,
        smallText: sl.smallText ?? null,
        button1Label: sl.button1Label ?? null,
        button1Url: sl.button1Url ?? null,
        button2Label: sl.button2Label ?? null,
        button2Url: sl.button2Url ?? null,
        partyCurrent: sl.partyCurrent ?? null,
        partyMax: sl.partyMax ?? null,
        partyId: sl.partyId ?? null,
        partySecret: sl.partySecret ?? null,
        startMinsAgo: sl.startMinsAgo ?? 0,
        endTotalMins: sl.endTotalMins ?? null,
        appId: sl.appId ?? null,
        enabled: !!sl.enabled, // informational only — import never restores this
      }))
      const backup = {
        app: '10X RPC',
        kind: BACKUP_KIND,
        version: BACKUP_VERSION,
        exportedAt: new Date().toISOString(),
        slots,
        status: {
          userStatus: m.session?.userStatus ?? 'online',
          customStatus: m.session?.customStatus ?? null,
          customStatusEmoji: m.session?.customStatusEmoji ?? null,
          platform: m.session?.statusPlatform ?? 'desktop',
        },
        global: m.globalConfig
          ? {
              city: m.globalConfig.city,
              timezone: m.globalConfig.timezone,
              tempUnit: m.globalConfig.tempUnit ?? 'C',
            }
          : null,
        rotator: {
          enabled: !!m.rotatorEnabled,
          intervalMins: m.globalConfig?.rotatorIntervalMins ?? 5,
          presets: (m.rotatorPresets ?? []).map(p => ({
            emoji: p.emoji ?? null,
            text: p.text,
            durationMins: p.durationMins ?? 5,
          })),
        },
        autoRotate: m.autoRotate
          ? {
              secs: m.autoRotate.secs,
              order: m.autoRotate.order,
              includeGame: m.autoRotate.includeGame,
            }
          : null,
      }
      const fname = `10x-rpc-backup-${(m.user?.username || 'me').replace(/[^a-zA-Z0-9_-]+/g, '_')}-${new Date().toISOString().slice(0, 10)}.json`
      const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' })
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = fname
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(a.href)
      toast.success('Backup downloaded — nothing on your account changed', { duration: 2800 })
    } catch (e) {
      console.error(e)
      toast.error('Could not export your settings')
    } finally {
      setBusy(null)
    }
  }

  /* ---------------- IMPORT ---------------- */
  const handleImportFile = async (file: File) => {
    if (busy) return
    setBusy('import')
    setSummary(null)
    try {
      let data: unknown
      try {
        data = JSON.parse(await file.text())
      } catch {
        throw new Error('That file is not valid JSON.')
      }
      if (!isRecord(data) || data.kind !== BACKUP_KIND || data.app !== '10X RPC') {
        throw new Error('That file is not a 10X RPC backup (wrong kind).')
      }
      if (data.version !== BACKUP_VERSION) {
        throw new Error(`Unsupported backup version (${String(data.version)}).`)
      }

      const notes: string[] = []
      let slotsRestored = 0
      let slotsCreated = 0
      let presetsAdded = 0

      // 1. Global config (city / timezone / temp unit)
      if (isRecord(data.global)) {
        const tz = s(data.global.timezone, 64)
        if (tz) {
          await api.configSave(
            s(data.global.city, 64),
            tz,
            data.global.tempUnit === 'F' ? 'F' : 'C',
          )
        } else {
          notes.push('Global config skipped (missing timezone).')
        }
      }

      // 2. Status settings (texts + platform only — the enable switch is
      //    never touched, matching the route's own independence guarantee).
      if (isRecord(data.status)) {
        const userStatus = s(data.status.userStatus, 16)
        await api.statusUpdate({
          ...(userStatus && VALID_USER_STATUSES.includes(userStatus) ? { userStatus } : {}),
          customStatus: s(data.status.customStatus, 128),
          customStatusEmoji: s(data.status.customStatusEmoji, 64),
          ...(s(data.status.platform, 32) ? { statusPlatform: s(data.status.platform, 32) as string } : {}),
        })
      }

      // 3. Status-rotator presets — added row-disabled; the rotator's master
      //    on/off switch is never flipped by an import.
      if (isRecord(data.rotator)) {
        const presets = Array.isArray(data.rotator.presets) ? data.rotator.presets.filter(isRecord) : []
        if (replacePresets) {
          const existing = await api.rotatorList().catch(() => ({ presets: [] }))
          for (const p of existing.presets) {
            if (p.id) await api.rotatorDelete(p.id).catch(() => {})
          }
        }
        for (const p of presets.slice(0, 20)) {
          const text = s(p.text, 128)
          if (!text) continue
          try {
            await api.rotatorSave({
              text,
              emoji: s(p.emoji, 64),
              durationMins: num(p.durationMins, 1, 1440) ?? 5,
              enabled: false, // never goes live on its own
            })
            presetsAdded++
          } catch {
            notes.push('Some rotator presets could not be added (20 max).')
            break
          }
        }
      }

      // 4. Auto Rotate — restore the SHAPE (interval / order / include-game)
      //    while preserving the account's current ON/OFF state.
      if (isRecord(data.autoRotate)) {
        const secs = num(data.autoRotate.secs, 15, 1800) ?? 30
        const orderRaw = String(data.autoRotate.order)
        const order = orderRaw === 'reverse' || orderRaw === 'shuffle' ? orderRaw : 'forward'
        await api.rpcRotateSave(me.autoRotate?.enabled ?? false, secs, order, data.autoRotate.includeGame !== false)
      }

      // 5. RPC slots — existing slots are overwritten field-by-field (their
      //    enabled flags are server-preserved), missing slots are created.
      const rawSlots = Array.isArray(data.slots) ? data.slots.filter(isRecord).slice(0, 3) : []
      if (rawSlots.length > 0) {
        const current = await api.rpcSlotsList()
        const curSlots = current.slots ?? []
        for (let i = 0; i < rawSlots.length; i++) {
          const payload = normalizeSlot(rawSlots[i])
          let id = curSlots[i]?.id
          if (!id) {
            const cr = await api.rpcSlotCreate()
            id = cr.rpcConfig?.id
            if (!id) {
              notes.push('Could not create an additional slot (max 3).')
              break
            }
            slotsCreated++
          }
          await api.rpcSlotSave(id, payload)
          slotsRestored++
        }
      }

      const result: ImportSummary = { slotsRestored, slotsCreated, presetsAdded, notes }
      setSummary(result)
      toast.success(
        `Import complete — ${slotsRestored} slot${slotsRestored === 1 ? '' : 's'}${slotsCreated ? ` (${slotsCreated} new)` : ''}${presetsAdded ? `, ${presetsAdded} preset${presetsAdded === 1 ? '' : 's'}` : ''}`,
        { duration: 3500 },
      )
      onRefresh()
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Import failed'
      toast.error(msg, { duration: 4000 })
    } finally {
      setBusy(null)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  return (
    <div className="relative overflow-hidden bg-gradient-to-b from-[#13111d]/95 via-[#0e0d14]/95 to-[#0a0a0f] border border-white/10 rounded-[28px] p-6 sm:p-7 shadow-2xl backdrop-blur-xl">
      <div className="absolute -top-16 left-1/4 -translate-x-1/2 w-56 h-40 bg-purple-600/10 rounded-full blur-3xl pointer-events-none" />

      <div className="relative z-10 flex items-center gap-2.5 mb-1">
        <DatabaseBackup className="w-5 h-5 text-white stroke-[2.2] shrink-0" aria-hidden />
        <h2 className="text-lg sm:text-xl font-bold text-white tracking-tight">Backup &amp; Restore</h2>
      </div>
      <p className="relative z-10 text-xs text-white/45 leading-relaxed mb-4 px-0.5">
        Download every saved setting as a JSON file, or restore a backup on any account.
        Import never turns anything on — your enable switches stay exactly as they are.
      </p>

      <div className="relative z-10 flex flex-col sm:flex-row gap-2">
        <button
          type="button"
          onClick={handleExport}
          disabled={busy !== null}
          className="flex-1 flex items-center justify-center gap-2 h-12 rounded-xl border border-purple-400/40 bg-purple-500/15 hover:bg-purple-500/30 text-white text-xs font-bold uppercase tracking-widest transition-all active:scale-[0.98] disabled:opacity-50 cursor-pointer"
          aria-label="Export a JSON backup of your settings"
        >
          {busy === 'export' ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden /> : <Download className="w-4 h-4" aria-hidden />}
          {busy === 'export' ? 'Exporting…' : 'Export backup'}
        </button>

        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          disabled={busy !== null}
          className="flex-1 flex items-center justify-center gap-2 h-12 rounded-xl border border-white/10 bg-[#12131a] hover:border-white/25 text-white/90 hover:text-white text-xs font-bold uppercase tracking-widest transition-all active:scale-[0.98] disabled:opacity-50 cursor-pointer"
          aria-label="Restore settings from a backup file"
        >
          {busy === 'import' ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden /> : <Upload className="w-4 h-4" aria-hidden />}
          {busy === 'import' ? 'Importing…' : 'Import backup'}
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          className="hidden"
          aria-hidden
          tabIndex={-1}
          onChange={e => {
            const f = e.target.files?.[0]
            if (f) handleImportFile(f)
          }}
        />
      </div>

      {/* Replace-presets option */}
      <label className="relative z-10 mt-3 flex items-center gap-2.5 cursor-pointer select-none w-fit">
        <input
          type="checkbox"
          checked={replacePresets}
          onChange={e => setReplacePresets(e.target.checked)}
          className="w-4 h-4 accent-purple-500 cursor-pointer"
        />
        <span className="text-[11px] text-white/55">Replace my status-rotator presets on import</span>
      </label>

      {/* Import result summary */}
      {summary && (
        <div className="relative z-10 mt-4 rounded-2xl border border-emerald-500/30 bg-emerald-500/[0.07] p-4" role="status" aria-live="polite">
          <div className="flex items-start gap-2.5">
            {summary.notes.length > 0
              ? <TriangleAlert className="w-4.5 h-4.5 text-amber-300 shrink-0 mt-0.5" aria-hidden />
              : <Check className="w-4.5 h-4.5 text-emerald-400 shrink-0 mt-0.5" aria-hidden />}
            <div className="min-w-0">
              <p className="text-xs font-semibold text-emerald-200 leading-relaxed">
                Restored {summary.slotsRestored} RPC slot{summary.slotsRestored === 1 ? '' : 's'}
                {summary.slotsCreated > 0 ? ` (${summary.slotsCreated} newly created)` : ''}
                {summary.presetsAdded > 0 ? `, ${summary.presetsAdded} rotator preset${summary.presetsAdded === 1 ? '' : 's'}` : ''}
                {summary.slotsRestored === 0 && summary.presetsAdded === 0 ? ' — nothing to restore' : ''}.
                {' '}Enable switches were not changed.
              </p>
              {summary.notes.map((nt, i) => (
                <p key={i} className="mt-1 text-[11px] text-amber-200/80 leading-relaxed">{nt}</p>
              ))}
            </div>
          </div>
        </div>
      )}

      <p className="relative z-10 mt-3 flex items-center gap-1.5 text-[11px] text-white/35 px-0.5">
        <FileJson className="w-3 h-3 shrink-0" aria-hidden />
        Backup files contain your RPC configurations only — never tokens or secrets.
      </p>
    </div>
  )
}
