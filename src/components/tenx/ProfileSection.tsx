// 10X RPC — Profile card + action row (matches Roxy reference, with bg + live preview)
'use client'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { api, type Me } from '@/lib/api-client'
import { useRouter } from './useRouter'
import { Card, GhostButton, PrimaryButton, PurpleSwitch, Badge } from './ui'
import { DISCORD_STATUSES, PLATFORMS, PLATFORM_GROUPS } from '@/lib/constants'
import { DiscordPreview } from './DiscordPreview'
import { QuickStatusPanel } from './QuickStatusPanel'

export function ProfileSection({ me, onRefresh }: { me: Me; onRefresh: () => void }) {
  const { navigate } = useRouter()
  const [statusDropdown, setStatusDropdown] = useState(false)
  const [customMsg, setCustomMsg] = useState(me.session?.customStatus || '')
  const [customEmoji, setCustomEmoji] = useState(me.session?.customStatusEmoji || '')
  const [rpcEnabled, setRpcEnabled] = useState(me.session?.rpcEnabled ?? false)
  const [saving, setSaving] = useState(false)
  const [vrActive, setVrActive] = useState(me.session?.vrStatusActive ?? false)
  const [bgModalOpen, setBgModalOpen] = useState(false)
  const [bgUrl, setBgUrl] = useState(me.user?.backgroundUrl || '')

  // Live tick — drives the digital countdown timer
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])

  // Sync local state when me changes (e.g. after refresh)
  useEffect(() => {
    setCustomMsg(me.session?.customStatus || '')
    setCustomEmoji(me.session?.customStatusEmoji || '')
    setRpcEnabled(me.session?.rpcEnabled ?? false)
    setVrActive(me.session?.vrStatusActive ?? false)
    setBgUrl(me.user?.backgroundUrl || '')
  }, [me])

  if (!me.user || !me.session || !me.trial) return null

  const userStatus = me.session.userStatus
  const statusInfo = DISCORD_STATUSES.find(s => s.value === userStatus) || DISCORD_STATUSES[0]
  const trialMsLeft = Math.max(0, me.trial.endsAt ? new Date(me.trial.endsAt).getTime() - now : 0)
  const trialDaysLeft = Math.max(0, Math.ceil(trialMsLeft / (24 * 60 * 60 * 1000)))

  // Sleep timer countdown
  const sleepMsLeft = me.session.sleepTimerEndsAt
    ? Math.max(0, new Date(me.session.sleepTimerEndsAt).getTime() - now)
    : 0
  const sleepActive = me.session.sleepTimerActive && sleepMsLeft > 0

  const handleStatusSelect = async (status: string) => {
    setStatusDropdown(false)
    try {
      await api.setStatus(status)
      toast.success(`Status set to ${status}`, { duration: 2000 })
      onRefresh()
    } catch (e) {
      console.error(e)
      toast.error('Failed to update status')
    }
  }

  const handleToggleRpc = async (v: boolean) => {
    setRpcEnabled(v)
    try {
      await api.rpcToggle(v)
      toast.success(v ? 'Status enabled' : 'Status disabled', { duration: 2000 })
      onRefresh()
    } catch (e) {
      console.error(e)
      setRpcEnabled(!v)  // revert on error
      toast.error('Failed to toggle status')
    }
  }

  const handleUpdate = async () => {
    setSaving(true)
    try {
      // Validate custom message length
      if (customMsg.length > 128) {
        toast.error('Custom message too long (max 128 chars)')
        return
      }
      // Save custom status + RPC config first
      await api.customStatus(customEmoji || null, customMsg || null)
      if (me.rpcConfig) {
        await api.rpcSave({ ...me.rpcConfig, enabled: rpcEnabled })
      }
      // Actually send presence to Discord via gateway
      const result = await api.rpcUpdate()
      if (result.ok) {
        toast.success(`✓ ${result.message || 'Presence sent to Discord'}`, { duration: 3000 })
      } else {
        // Show the actual error message from the gateway
        const msg = result.message || result.error || 'Unknown error'
        if (msg.includes('No Discord access token') || msg.includes('demo')) {
          toast.warning(
            'Demo mode — sign in with Discord to push RPC',
            {
              duration: 6000,
              action: {
                label: 'Sign in',
                onClick: () => navigate({ name: 'oauth-consent' }),
              },
            }
          )
        } else if (msg.includes('trial')) {
          toast.error('Trial expired — please upgrade to continue using RPC')
        } else if (msg.includes('Authentication failed') || msg.includes('4004')) {
          toast.error('Discord rejected the token. Sign out and sign in again.', {
            duration: 5000,
            action: {
              label: 'Re-sign in',
              onClick: () => navigate({ name: 'oauth-consent' }),
            },
          })
        } else {
          toast.error(`RPC failed: ${msg}`, { duration: 5000 })
        }
      }
      onRefresh()
    } catch (e) {
      console.error(e)
      toast.error('Failed to update presence')
    } finally {
      setSaving(false)
    }
  }

  const handleVrToggle = async (v: boolean) => {
    setVrActive(v)
    try {
      await api.vrToggle(v)
      toast.success(v ? 'VR status enabled' : 'VR status disabled', { duration: 2000 })
      onRefresh()
    } catch (e) {
      console.error(e)
      setVrActive(!v)  // revert
      toast.error('Failed to toggle VR status')
    }
  }

  const handleLogout = async () => {
    await api.logout()
    window.location.href = '/'
  }

  const handleSaveBg = async () => {
    // Validate URL
    const trimmed = bgUrl.trim()
    if (trimmed && !/^https?:\/\//i.test(trimmed)) {
      toast.error('Background URL must start with http:// or https://')
      return
    }
    if (trimmed.length > 2048) {
      toast.error('URL too long (max 2048 chars)')
      return
    }
    setSaving(true)
    try {
      await api.background(trimmed || null)
      toast.success('Background updated', { duration: 2000 })
      setBgModalOpen(false)
      onRefresh()
    } catch (e) {
      console.error(e)
      toast.error('Failed to save background')
    } finally {
      setSaving(false)
    }
  }

  const handleClearBg = async () => {
    setSaving(true)
    try {
      await api.background(null)
      setBgUrl('')
      toast.success('Background cleared', { duration: 2000 })
      setBgModalOpen(false)
      onRefresh()
    } catch (e) {
      console.error(e)
      toast.error('Failed to clear background')
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      {/* === PROFILE CARD === */}
      <Card className="relative overflow-hidden">
        {/* Background image (if set) */}
        {me.user.backgroundUrl && (
          <>
            { }
            <img
              src={me.user.backgroundUrl}
              alt=""
              className="absolute inset-0 w-full h-full object-cover opacity-30 pointer-events-none"
            />
            <div className="absolute inset-0 bg-gradient-to-b from-black/50 via-[#0a0b0f]/70 to-[#0a0b0f] pointer-events-none" />
          </>
        )}

        {/* Watermark username behind the content */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-1/2 -translate-y-1/2 text-center text-7xl font-black text-white/[0.03] select-none"
        >
          {me.user.username}
        </div>

        <div className="relative space-y-4">
          {/* Avatar + "click here" hint + small thumb */}
          <div className="flex items-start justify-between">
            <div className="relative">
              <img
                src={me.user.avatar}
                alt={me.user.username}
                className="w-20 h-20 rounded-2xl object-cover ring-2 ring-purple-500/40"
              />
              <span className={`absolute -bottom-0.5 -right-0.5 w-4 h-4 rounded-full border-2 border-[#0a0b0f] ${statusInfo.color}`} />
              <span
                className="absolute -left-16 top-1/2 -translate-y-1/2 text-xs text-white/40 hidden sm:block"
              >
                ← click here
              </span>
            </div>
            {/* Small avatar thumb in top-right corner */}
            <img
              src={me.user.avatar}
              alt=""
              className="w-8 h-8 rounded-lg object-cover opacity-60"
            />
          </div>

          {/* Username + TRIAL ACTIVE badge */}
          <div className="space-y-1.5">
            <div className="text-2xl font-bold text-white">{me.user.username}</div>
            {me.trial.active ? (
              <Badge className="bg-orange-500/20 text-orange-300 border border-orange-500/30">
                <span className="w-1.5 h-1.5 rounded-full bg-green-400" />
                TRIAL ACTIVE
              </Badge>
            ) : (
              <Badge className="bg-red-500/20 text-red-300 border border-red-500/30">
                <span className="w-1.5 h-1.5 rounded-full bg-red-400" />
                TRIAL EXPIRED
              </Badge>
            )}
          </div>

          {/* User ID line */}
          <div className="flex items-center gap-2 text-xs text-white/60">
            <span>👤</span>
            <span className="font-mono">{me.user.id}</span>
          </div>

          {/* "3 days remaining" line */}
          <div className="flex items-center gap-2 text-sm text-white/80">
            <span>🕐</span>
            <span>{customEmoji || '😋'}</span>
            <span>{trialDaysLeft} day{trialDaysLeft === 1 ? '' : 's'} remaining</span>
          </div>

          {/* Custom Msg input + status selector */}
          <div className="flex items-center gap-2">
            <div className="flex-1 flex items-center gap-2 bg-[#13141a] border border-white/8 rounded-xl px-3 py-2.5">
              <span className="text-xl">{customEmoji || '😋'}</span>
              <input
                type="text"
                value={customMsg}
                onChange={e => setCustomMsg(e.target.value)}
                placeholder="Custom Msg..."
                className="bg-transparent flex-1 outline-none text-sm text-white placeholder:text-white/40"
                maxLength={128}
              />
              <input
                type="text"
                value={customEmoji}
                onChange={e => setCustomEmoji(e.target.value.slice(0, 2))}
                placeholder="😀"
                className="w-10 bg-transparent outline-none text-center text-sm"
                maxLength={2}
              />
            </div>
            <div className="relative">
              <button
                onClick={() => setStatusDropdown(v => !v)}
                className="bg-[#13141a] border border-white/8 rounded-xl px-3 py-2.5 text-sm text-white hover:bg-white/5"
                aria-label="Status"
              >
                {statusInfo.emoji}
              </button>
              {statusDropdown && (
                <div className="absolute right-0 top-full mt-2 w-44 glass-card-inner p-1 z-20">
                  {DISCORD_STATUSES.map(s => (
                    <button
                      key={s.value}
                      onClick={() => handleStatusSelect(s.value)}
                      className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm hover:bg-white/5 ${userStatus === s.value ? 'text-purple-300' : 'text-white'}`}
                    >
                      <span className={`w-2 h-2 rounded-full ${s.color}`} />
                      {s.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Set Config menu item */}
          <button
            onClick={() => navigate({ name: 'config' })}
            className="w-full flex items-center gap-3 glass-card-inner p-3 hover:border-purple-500/30 transition-colors text-left"
          >
            <span className="text-xl text-purple-400">🌐</span>
            <span className="text-sm text-white/90 font-medium">Set Config</span>
            <span className="ml-auto text-white/30">›</span>
          </button>

          {/* Set Background menu item */}
          <button
            onClick={() => setBgModalOpen(true)}
            className="w-full flex items-center gap-3 glass-card-inner p-3 hover:border-purple-500/30 transition-colors text-left"
          >
            <span className="text-xl text-orange-400">🖼️</span>
            <span className="text-sm text-white/90 font-medium">
              Set Background {me.user.backgroundUrl && <span className="text-[10px] text-green-400">●</span>}
            </span>
            <span className="ml-auto text-white/30">›</span>
          </button>

          {/* Admin link (only for admin users) */}
          {me.user.id === '824940038617694279' && (
            <button
              onClick={() => navigate({ name: 'admin' })}
              className="w-full flex items-center gap-3 glass-card-inner p-3 hover:border-purple-500/30 transition-colors text-left"
            >
              <span className="text-xl text-purple-400">⚙️</span>
              <span className="text-sm text-white/90 font-medium">Admin Dashboard</span>
              <span className="ml-auto text-white/30">›</span>
            </button>
          )}

          {/* Digital countdown timer (trial remaining, HH:MM:SS) */}
          <div className="glass-card-inner p-4 text-center">
            <p className="text-[10px] uppercase tracking-wider text-white/40 mb-1">Trial Countdown</p>
            <p className="font-mono text-3xl font-bold text-purple-300 tabular-nums tracking-wider">
              {formatCountdown(trialMsLeft)}
            </p>
          </div>

          {/* Logout */}
          <button
            onClick={handleLogout}
            className="w-full flex items-center justify-center gap-2 text-red-400 hover:text-red-300 py-2 text-sm"
          >
            <span>🔴</span>
            <span>Logout</span>
          </button>
        </div>
      </Card>

      {/* === ENABLE STATUS toggle + action buttons row (below the card) === */}
      <Card className="space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <PurpleSwitch checked={rpcEnabled} onCheckedChange={handleToggleRpc} />
            <span className="text-sm font-semibold text-purple-300">ENABLE STATUS</span>
          </div>
          {/* Status selector (compact) */}
          <div className="relative">
            <button
              onClick={() => setStatusDropdown(v => !v)}
              className="text-xs text-white/70 hover:text-white inline-flex items-center gap-1"
            >
              <span className={`w-2 h-2 rounded-full ${statusInfo.color}`} />
              {statusInfo.label}
            </button>
            {statusDropdown && (
              <div className="absolute right-0 top-full mt-2 w-44 glass-card-inner p-1 z-20">
                {DISCORD_STATUSES.map(s => (
                  <button
                    key={s.value}
                    onClick={() => handleStatusSelect(s.value)}
                    className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm hover:bg-white/5 ${userStatus === s.value ? 'text-purple-300' : 'text-white'}`}
                  >
                    <span className={`w-2 h-2 rounded-full ${s.color}`} />
                    {s.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Action buttons row: Mobile / ROTATOR / UPDATE */}
        <div className="flex items-center gap-2">
          <PlatformPicker />
          <GhostButton onClick={() => navigate({ name: 'rotator' })} className="text-xs px-3 py-2 flex-1">
            ROTATOR
          </GhostButton>
          <PrimaryButton onClick={handleUpdate} disabled={saving} className="text-xs px-3 py-2 flex-1">
            {saving ? '...' : 'UPDATE'}
          </PrimaryButton>
        </div>

        {/* Smart sleep timer (inline display when active) */}
        {sleepActive && (
          <div className="glass-card-inner p-3 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="text-lg">⏰</span>
              <div>
                <p className="text-xs text-white/60">Smart Sleep Timer</p>
                <p className="text-sm text-white font-medium tabular-nums">
                  Sleeping in {formatCountdown(sleepMsLeft)}
                </p>
              </div>
            </div>
            <button
              onClick={() => api.sleepTimer(null).then(onRefresh)}
              className="text-xs text-red-300 hover:text-red-200"
            >
              Cancel
            </button>
          </div>
        )}

        {/* VR toggle */}
        <div className="flex items-center justify-between glass-card-inner p-3">
          <div className="flex items-center gap-2">
            <span className="text-lg">🥽</span>
            <div>
              <p className="text-sm font-medium text-white">VR Status (Meta Quest)</p>
              <p className="text-xs text-white/50">Show the green VR headset icon</p>
            </div>
          </div>
          <PurpleSwitch checked={vrActive} onCheckedChange={handleVrToggle} />
        </div>
      </Card>

      {/* === Quick Status panel === */}
      <QuickStatusPanel
        currentStatus={userStatus}
        onStatusChange={() => onRefresh()}
      />

      {/* === Live Discord RPC Preview === */}
      <Card>
        <DiscordPreview
          config={me.rpcConfig}
          username={me.user.username}
          avatarUrl={me.user.avatar}
          platform={me.rpcConfig?.platform}
          rpcEnabled={rpcEnabled}
          hasDiscordToken={me.session?.hasDiscordToken}
          lastPresenceUpdate={me.session?.lastPresenceUpdate}
        />
      </Card>

      {/* === Set Background Modal === */}
      {bgModalOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm"
          onClick={() => setBgModalOpen(false)}
        >
          <div
            className="glass-card w-full max-w-md p-6 space-y-5"
            onClick={e => e.stopPropagation()}
          >
            <h2 className="text-xl font-bold text-white text-center">Set Background</h2>

            <div className="space-y-1.5">
              <label className="text-xs uppercase tracking-wider text-purple-400 font-semibold">Image URL</label>
              <input
                type="url"
                value={bgUrl}
                onChange={e => setBgUrl(e.target.value)}
                placeholder="https://example.com/bg.jpg"
                className="w-full bg-[#13141a] border border-white/8 rounded-xl px-4 py-3 text-sm text-white outline-none focus:ring-2 focus:ring-purple-500/40 placeholder:text-white/40"
              />
              <p className="text-xs text-white/40">
                Paste any image URL. It will be displayed as the background of your profile card.
              </p>
            </div>

            {/* Preview */}
            {bgUrl && /^https?:\/\//.test(bgUrl) && (
              <div className="relative h-32 rounded-xl overflow-hidden bg-[#13141a]">
                { }
                <img src={bgUrl} alt="Preview" className="w-full h-full object-cover opacity-50" />
                <div className="absolute inset-0 bg-gradient-to-b from-transparent to-[#0a0b0f]" />
              </div>
            )}

            <div className="flex gap-2 pt-2">
              {me.user.backgroundUrl && (
                <button
                  onClick={handleClearBg}
                  disabled={saving}
                  className="text-sm text-red-400 hover:text-red-300 px-4 py-2.5"
                >
                  Clear
                </button>
              )}
              <button
                onClick={() => setBgModalOpen(false)}
                disabled={saving}
                className="flex-1 text-sm text-white/70 hover:text-white px-4 py-2.5"
              >
                Cancel
              </button>
              <button
                onClick={handleSaveBg}
                disabled={saving}
                className="flex-1 bg-white text-black font-bold rounded-xl px-4 py-2.5 text-sm hover:opacity-90 active:scale-[0.98] transition-all disabled:opacity-50"
              >
                {saving ? 'Saving...' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

function PlatformPicker() {
  const [open, setOpen] = useState(false)
  const [selected, setSelected] = useState('mobile')
  const platform = PLATFORMS.find(p => p.value === selected) || PLATFORMS[2]

  return (
    <div className="relative flex-1">
      <button
        onClick={() => setOpen(v => !v)}
        className="w-full bg-white/5 border border-white/8 rounded-xl px-3 py-2 text-xs text-white hover:bg-white/10 inline-flex items-center justify-center gap-1.5"
      >
        <span>{platform.emoji}</span>
        <span>{platform.label}</span>
      </button>
      {open && (
        <div className="absolute left-0 top-full mt-2 w-52 glass-card-inner p-2 z-20 max-h-72 overflow-y-auto styled-scroll">
          {PLATFORM_GROUPS.map(group => (
            <div key={group} className="mb-1.5">
              <p className="text-[10px] uppercase tracking-wider text-white/40 px-2 py-1">{group}</p>
              {PLATFORMS.filter(p => p.group === group).map(p => (
                <button
                  key={p.value}
                  onClick={() => { setSelected(p.value); setOpen(false) }}
                  className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-xs hover:bg-white/5 ${selected === p.value ? 'text-purple-300 bg-purple-500/10' : 'text-white'}`}
                >
                  <span>{p.emoji}</span>
                  <span>{p.label}</span>
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function formatCountdown(ms: number): string {
  const total = Math.floor(ms / 1000)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}
