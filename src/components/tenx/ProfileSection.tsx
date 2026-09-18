// 10X RPC — Profile card + action row (matches Roxy reference exactly)
'use client'
import { useEffect, useState, useRef } from 'react'
import { toast } from 'sonner'
import { api, type Me } from '@/lib/api-client'
import { useRouter } from './useRouter'
import { Card, PurpleSwitch } from './ui'
import { DISCORD_STATUSES } from '@/lib/constants'
import { Gamepad2, Globe, Monitor, Smartphone } from 'lucide-react'
import { DiscordPreview } from './DiscordPreview'

function VrIcon({ className = 'w-4 h-4' }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <rect x="2" y="6" width="20" height="12" rx="4" />
      <path d="M10 18a2 2 0 0 0 4 0" />
      <circle cx="8" cy="12" r="2.2" />
      <circle cx="16" cy="12" r="2.2" />
    </svg>
  )
}

const PLATFORM_ITEMS = [
  { value: 'mobile', label: 'Mobile', icon: Smartphone },
  { value: 'desktop', label: 'Desktop', icon: Monitor },
  { value: 'console', label: 'Console', icon: Gamepad2 },
  { value: 'web', label: 'Web', icon: Globe },
  { value: 'meta_quest', label: 'VR', icon: VrIcon },
]

export function ProfileSection({ me, onRefresh }: { me: Me; onRefresh: () => void }) {
  const { navigate } = useRouter()
  const [statusDropdown, setStatusDropdown] = useState(false)
  const [userMenuOpen, setUserMenuOpen] = useState(false)
  const [customMsg, setCustomMsg] = useState(me.session?.customStatus || '')
  const [customEmoji, setCustomEmoji] = useState(me.session?.customStatusEmoji || '')
  const [statusEnabled, setStatusEnabled] = useState(me.session?.statusEnabled ?? false)
  const [userStatus, setUserStatus] = useState(me.session?.userStatus || 'online')
  const [rpcEnabled, setRpcEnabled] = useState(me.session?.rpcEnabled ?? false)
  const [saving, setSaving] = useState(false)
  const [selectedPlatform, setSelectedPlatform] = useState(me.session?.statusPlatform || 'mobile')
  const [platformOpen, setPlatformOpen] = useState(false)
  const [bgModalOpen, setBgModalOpen] = useState(false)
  const [bgUrl, setBgUrl] = useState(me.user?.backgroundUrl || '')

  const statusDropdownRef = useRef<HTMLDivElement>(null)
  const userMenuRef = useRef<HTMLDivElement>(null)
  const platformRef = useRef<HTMLDivElement>(null)

  // Live tick for countdowns
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])

  // Outside click handlers
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Node
      if (platformRef.current && !platformRef.current.contains(target)) {
        setPlatformOpen(false)
      }
      if (statusDropdownRef.current && !statusDropdownRef.current.contains(target)) {
        setStatusDropdown(false)
      }
      if (userMenuRef.current && !userMenuRef.current.contains(target)) {
        setUserMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  // Sync local state when me changes
  useEffect(() => {
    setCustomMsg(me.session?.customStatus || '')
    setCustomEmoji(me.session?.customStatusEmoji || '')
    setStatusEnabled(me.session?.statusEnabled ?? false)
    setUserStatus(me.session?.userStatus || 'online')
    setRpcEnabled(me.session?.rpcEnabled ?? false)
    setSelectedPlatform(me.session?.statusPlatform || 'mobile')
    setBgUrl(me.user?.backgroundUrl || '')
  }, [me])

  if (!me.user || !me.session || !me.trial) return null

  const statusInfo = DISCORD_STATUSES.find(s => s.value === userStatus) || DISCORD_STATUSES[0]
  const trialMsLeft = Math.max(0, me.trial.endsAt ? new Date(me.trial.endsAt).getTime() - now : 0)
  const trialDaysLeft = Math.max(0, Math.ceil(trialMsLeft / (24 * 60 * 60 * 1000)))

  const handleStatusSelect = (status: string) => {
    setStatusDropdown(false)
    setUserStatus(status)
    // If status is currently enabled, save & sync immediately
    if (statusEnabled) {
      api.statusUpdate({ userStatus: status }).then(() => onRefresh()).catch(() => {})
      toast.success(`Status set to ${status}`, { duration: 2000 })
    } else {
      toast.success(`Status set to ${status} (click UPDATE to save)`, { duration: 2000 })
    }
  }

  const handleToggleStatus = async (v: boolean) => {
    setStatusEnabled(v)
    try {
      await api.statusToggle(v)
      toast.success(v ? 'Status enabled (Online on Discord)' : 'Status disabled (Offline)', { duration: 2000 })
      onRefresh()
    } catch (e) {
      console.error(e)
      setStatusEnabled(!v)
      toast.error('Failed to toggle status')
    }
  }

  const handleUpdate = async () => {
    setSaving(true)
    try {
      if (customMsg.length > 128) {
        toast.error('Custom message too long (max 128 chars)')
        return
      }
      const result = await api.statusUpdate({
        userStatus,
        customStatus: customMsg || null,
        customStatusEmoji: customEmoji || null,
        statusPlatform: selectedPlatform,
      })
      if (result.ok) {
        toast.success(statusEnabled ? '✓ Status updated & synced to Discord' : '✓ Status configuration saved (Status is OFF)', { duration: 3000 })
      } else {
        toast.error('Failed to update status')
      }
      onRefresh()
    } catch (e) {
      console.error(e)
      toast.error('Failed to update status')
    } finally {
      setSaving(false)
    }
  }

  const handleLogout = async () => {
    await api.logout()
    window.location.href = '/'
  }

  const handleSaveBg = async () => {
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

  const currentPlatformItem = PLATFORM_ITEMS.find(p => p.value === selectedPlatform) || PLATFORM_ITEMS[0]
  const PlatformIcon = currentPlatformItem.icon

  return (
    <>
      {/* === MAIN PROFILE CARD (Matches roxydev.xyz/me reference screenshot) === */}
      <div className="relative overflow-hidden bg-gradient-to-b from-[#13111d]/95 via-[#0e0d14]/95 to-[#0a0a0f] border border-white/10 rounded-[28px] p-6 shadow-2xl backdrop-blur-xl">
        {/* Ambient violet glow at top left and top right */}
        <div className="absolute -top-16 -left-12 w-56 h-56 bg-purple-600/15 rounded-full blur-3xl pointer-events-none" />
        <div className="absolute -top-16 -right-12 w-48 h-48 bg-purple-900/10 rounded-full blur-2xl pointer-events-none" />

        {/* Custom background image if configured */}
        {me.user.backgroundUrl && (
          <>
            <img
              src={me.user.backgroundUrl}
              alt=""
              className="absolute inset-0 w-full h-full object-cover opacity-25 pointer-events-none"
            />
            <div className="absolute inset-0 bg-gradient-to-b from-[#0e0d14]/75 via-[#0e0d14]/90 to-[#0a0a0f] pointer-events-none" />
          </>
        )}

        {/* Top-Right Small Avatar + Dropdown Menu */}
        <div className="relative flex items-center justify-end z-20">
          <div className="relative" ref={userMenuRef}>
            <button
              type="button"
              onClick={() => setUserMenuOpen(v => !v)}
              className="relative rounded-full focus:outline-none ring-1 ring-white/20 hover:ring-purple-400/60 transition-all cursor-pointer"
              title="Account options"
            >
              <img
                src={me.user.avatar}
                alt=""
                className="w-8 h-8 rounded-full object-cover"
              />
            </button>

            {/* Sleek User Settings Dropdown */}
            {userMenuOpen && (
              <div className="absolute right-0 top-full mt-2 w-52 bg-[#16171d]/95 backdrop-blur-xl border border-white/10 rounded-2xl p-2 shadow-2xl z-50 space-y-1 text-xs">
                <div className="px-3 py-2 border-b border-white/5">
                  <div className="font-semibold text-white truncate">{me.user.username}</div>
                  <div className="text-[10px] text-white/50 font-mono truncate">{me.user.id}</div>
                  <div className="text-[10px] text-purple-300 mt-1">
                    {trialDaysLeft} day{trialDaysLeft === 1 ? '' : 's'} trial remaining
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => { setUserMenuOpen(false); navigate({ name: 'config' }) }}
                  className="w-full flex items-center gap-2 px-3 py-2 rounded-xl text-white/80 hover:text-white hover:bg-white/5 text-left transition-colors"
                >
                  <span>🌐</span>
                  <span>Set Config</span>
                </button>
                <button
                  type="button"
                  onClick={() => { setUserMenuOpen(false); setBgModalOpen(true) }}
                  className="w-full flex items-center gap-2 px-3 py-2 rounded-xl text-white/80 hover:text-white hover:bg-white/5 text-left transition-colors"
                >
                  <span>🖼️</span>
                  <span>Set Background</span>
                </button>
                {(me.user.discordId === '824940038617694279' || me.user.id === '824940038617694279') && (
                  <button
                    type="button"
                    onClick={() => { setUserMenuOpen(false); navigate({ name: 'admin' }) }}
                    className="w-full flex items-center gap-2 px-3 py-2 rounded-xl text-purple-300 hover:text-white hover:bg-white/5 text-left transition-colors"
                  >
                    <span>⚙️</span>
                    <span>Admin Dashboard</span>
                  </button>
                )}
                <button
                  type="button"
                  onClick={handleLogout}
                  className="w-full flex items-center gap-2 px-3 py-2 rounded-xl text-red-400 hover:text-red-300 hover:bg-red-500/10 text-left border-t border-white/5 mt-1 transition-colors"
                >
                  <span>🔴</span>
                  <span>Logout</span>
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Center: Large Circular Avatar + Status Dot + "click here" */}
        <div className="relative flex flex-col items-center justify-center -mt-3 mb-5 z-20">
          <div className="relative inline-block" ref={statusDropdownRef}>
            {/* Avatar */}
            <div className="w-28 h-28 rounded-full overflow-hidden border-2 border-white/10 shadow-2xl ring-1 ring-white/5">
              <img
                src={me.user.avatar}
                alt={me.user.username}
                className="w-full h-full object-cover"
              />
            </div>

            {/* Status Dot at bottom-right of avatar */}
            <button
              type="button"
              onClick={() => setStatusDropdown(v => !v)}
              className={`absolute bottom-1 right-2 w-4 h-4 rounded-full border-2 border-[#13111d] ${statusInfo.color} shadow-lg cursor-pointer transition-transform hover:scale-125 active:scale-95`}
              aria-label="Change status"
              title="Click to change status"
            />

            {/* "click here" text */}
            <button
              type="button"
              onClick={() => setStatusDropdown(v => !v)}
              className="absolute left-[calc(100%-8px)] bottom-1.5 text-xs text-white/40 hover:text-white/70 transition-colors whitespace-nowrap pl-1.5 flex items-center cursor-pointer select-none"
            >
              click here
            </button>

            {/* Status Dropdown Popup (matches screenshot: Online, Idle, Do Not Disturb) */}
            {statusDropdown && (
              <div className="absolute left-1/2 -translate-x-1/2 top-full mt-3 w-48 bg-[#181920]/95 backdrop-blur-xl border border-white/10 rounded-2xl p-1.5 shadow-2xl z-50 space-y-1">
                <button
                  type="button"
                  onClick={() => handleStatusSelect('online')}
                  className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-xl text-xs transition-all text-left ${
                    userStatus === 'online' ? 'bg-white/10 text-white font-medium' : 'text-white/80 hover:text-white hover:bg-white/5'
                  }`}
                >
                  <span className="w-2.5 h-2.5 rounded-full bg-emerald-500 shadow-sm shadow-emerald-500/50" />
                  <span>Online</span>
                </button>

                <button
                  type="button"
                  onClick={() => handleStatusSelect('idle')}
                  className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-xl text-xs transition-all text-left ${
                    userStatus === 'idle' ? 'bg-white/10 text-white font-medium' : 'text-white/80 hover:text-white hover:bg-white/5'
                  }`}
                >
                  <span className="w-2.5 h-2.5 rounded-full bg-amber-500 shadow-sm shadow-amber-500/50" />
                  <span>Idle</span>
                </button>

                <button
                  type="button"
                  onClick={() => handleStatusSelect('dnd')}
                  className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-xl text-xs transition-all text-left ${
                    userStatus === 'dnd' ? 'bg-white/10 text-white font-medium' : 'text-white/80 hover:text-white hover:bg-white/5'
                  }`}
                >
                  <span className="w-2.5 h-2.5 rounded-full bg-rose-500 shadow-sm shadow-rose-500/50" />
                  <span>Do Not Disturb</span>
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Custom Msg Pill Input */}
        <div className="relative z-10 w-full max-w-sm mx-auto bg-[#181922]/90 border border-white/8 hover:border-white/15 focus-within:border-purple-500/40 rounded-2xl px-4 py-2.5 flex items-center gap-3 transition-colors shadow-inner">
          <button
            type="button"
            onClick={() => {
              const emojis = ['😋', '🔥', '🎮', '✨', '⚡', '🎧', '🚀']
              const next = emojis[(emojis.indexOf(customEmoji || '😋') + 1) % emojis.length]
              setCustomEmoji(next)
            }}
            className="text-xl select-none hover:scale-110 active:scale-95 transition-transform"
            title="Click to cycle emoji"
          >
            {customEmoji || '😋'}
          </button>
          <input
            type="text"
            value={customMsg}
            onChange={e => setCustomMsg(e.target.value)}
            placeholder="Custom Msg..."
            className="bg-transparent flex-1 outline-none text-sm text-white placeholder:text-white/40"
            maxLength={128}
          />
        </div>

        {/* Centered Username & Status (OFFLINE / ONLINE) */}
        <div className="relative z-10 text-center mt-5 mb-6 space-y-1">
          <h2 className="text-xl sm:text-2xl font-bold text-white tracking-wide">
            {me.user.username}
          </h2>
          <p className="text-xs sm:text-sm font-semibold tracking-widest text-white/50 uppercase">
            {statusEnabled ? (userStatus.toUpperCase() || 'ONLINE') : 'OFFLINE'}
          </p>
        </div>

        {/* ENABLE STATUS Toggle Row */}
        <div className="relative z-10 flex items-center justify-between px-1 mb-4 pt-1">
          <span className="text-xs sm:text-sm font-extrabold tracking-widest text-[#a855f7] uppercase">
            ENABLE STATUS
          </span>
          <PurpleSwitch checked={statusEnabled} onCheckedChange={handleToggleStatus} />
        </div>

        {/* 3 Action Buttons: [ 📱 Mobile ] [ ROTATOR ] [ UPDATE ] */}
        <div className="relative z-10 flex items-center gap-2 pt-1">
          {/* Platform Picker Button */}
          <div className="relative flex-1" ref={platformRef}>
            <button
              type="button"
              onClick={() => setPlatformOpen(v => !v)}
              className="w-full h-11 bg-[#181922] border border-white/10 rounded-xl px-3 text-xs text-white hover:bg-white/10 inline-flex items-center justify-center gap-2 font-medium transition-all active:scale-[0.98]"
            >
              <PlatformIcon className="w-4 h-4 text-white/90" />
              <span>{currentPlatformItem.label}</span>
            </button>

            {/* Platform Dropdown Popup (matches user reference screenshot exactly) */}
            {platformOpen && (
              <div className="absolute left-0 bottom-full mb-2 w-48 bg-[#161720]/95 backdrop-blur-xl border border-white/10 rounded-2xl p-1.5 shadow-2xl shadow-black/80 z-50 space-y-0.5">
                {PLATFORM_ITEMS.map((item) => {
                  const ItemIcon = item.icon
                  const isSelected = selectedPlatform === item.value
                  return (
                    <button
                      key={item.value}
                      type="button"
                      onClick={async () => {
                        setSelectedPlatform(item.value)
                        setPlatformOpen(false)
                        try {
                          await api.statusUpdate({ statusPlatform: item.value })
                          toast.success(`Status platform set to ${item.label}`, { duration: 2000 })
                          onRefresh()
                        } catch (e: any) {
                          console.error('Failed to update platform:', e)
                          toast.error(e?.message || 'Failed to update platform')
                        }
                      }}
                      className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-xs transition-all text-left ${
                        isSelected
                          ? 'bg-[#6b21a8] text-white font-medium shadow-md shadow-purple-950/40'
                          : 'text-white/80 hover:text-white hover:bg-white/5'
                      }`}
                    >
                      <ItemIcon className={`w-4 h-4 shrink-0 ${isSelected ? 'text-white' : 'text-white/80'}`} />
                      <span>{item.label}</span>
                    </button>
                  )
                })}
              </div>
            )}
          </div>

          {/* ROTATOR Button */}
          <button
            type="button"
            onClick={() => navigate({ name: 'rotator' })}
            className="flex-1 h-11 bg-[#181922] border border-white/10 rounded-xl px-3 text-xs text-white hover:bg-white/10 inline-flex items-center justify-center font-medium transition-all active:scale-[0.98]"
          >
            ROTATOR
          </button>

          {/* UPDATE Button */}
          <button
            type="button"
            onClick={handleUpdate}
            disabled={saving}
            className="flex-1 h-11 bg-[#181922] border border-white/10 rounded-xl px-3 text-xs text-white hover:bg-white/10 inline-flex items-center justify-center font-medium transition-all active:scale-[0.98] disabled:opacity-50"
          >
            {saving ? '...' : 'UPDATE'}
          </button>
        </div>
      </div>

      {/* === Live Discord RPC Preview === */}
      <DiscordPreview
        config={me.rpcConfig}
        username={me.user.username}
        avatarUrl={me.user.avatar}
        platform={me.rpcConfig?.platform || 'desktop'}
        rpcEnabled={!!(me.session?.rpcEnabled && me.rpcConfig?.enabled)}
        hasDiscordToken={me.session?.hasDiscordToken}
        lastPresenceUpdate={me.session?.lastPresenceUpdate}
      />

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
