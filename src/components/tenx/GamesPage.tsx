// 10X RPC — Games list page (#/games) with active game indicator + "Add Games"
// Custom games (created via the Add Games dialog) appear after the presets and
// can be configured or deleted from their own config page.
// Game search source: Discord's official TRENDING GAMES ranking (real games
// with their real Application IDs — no bots). One click on a result adds the
// game with its official Application ID, name and icon pre-filled.
'use client'
import { useEffect, useState, useRef } from 'react'
import { toast } from 'sonner'
import { api, type GameListItem, type DiscoveredApp } from '@/lib/api-client'
import { useRouter } from './useRouter'
import { BackButton } from './ui'
import { Gamepad2, Search, ChevronRight, Plus, X, CheckCircle2, BadgeCheck, Loader2 } from 'lucide-react'

export function GamesPage() {
  const { navigate } = useRouter()
  const [games, setGames] = useState<GameListItem[]>([])
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState('')
  const [addOpen, setAddOpen] = useState(false)
  // Discord App Directory search (Task: search + auto-config)
  const [discordResults, setDiscordResults] = useState<DiscoveredApp[]>([])
  const [discordSearching, setDiscordSearching] = useState(false)
  const [addingAppId, setAddingAppId] = useState<string | null>(null)
  const discordSeq = useRef(0)

  const refresh = () =>
    api.gamesList()
      .then(r => {
        setGames(r.games)
        setLoading(false)
      })
      .catch(() => setLoading(false))

  useEffect(() => {
    refresh()
  }, [])

  // Debounced trending-games search — reuses the SAME search box, layout untouched.
  // Source: Discord's official trending-games ranking (real games only, no bots).
  useEffect(() => {
    const q = query.trim()
    if (q.length < 2) {
      setDiscordResults([])
      setDiscordSearching(false)
      return
    }
    const seq = ++discordSeq.current
    setDiscordSearching(true)
    const t = setTimeout(() => {
      api.gamesDiscover(q)
        .then(r => {
          if (discordSeq.current !== seq) return
          setDiscordResults(r.results || [])
          setDiscordSearching(false)
        })
        .catch(() => {
          if (discordSeq.current !== seq) return
          setDiscordResults([])
          setDiscordSearching(false)
        })
    }, 350)
    return () => clearTimeout(t)
  }, [query])

  // One click on a Discord result = add the game with its official Application
  // ID, name and icon pre-filled, then open its RPC configuration.
  const handleAddDiscovered = async (app: DiscoveredApp) => {
    if (addingAppId) return
    const existing = games.find(
      g => g.custom && g.name.toLowerCase() === app.name.toLowerCase()
    )
    if (existing) {
      navigate({ name: 'game', slug: existing.slug })
      return
    }
    setAddingAppId(app.appId)
    try {
      const r = await api.gameCustomCreate({ appId: app.appId })
      toast.success(`${r.config.gameName} added — official identity auto-filled`, { duration: 2500 })
      await refresh()
      navigate({ name: 'game', slug: r.config.gameSlug })
    } catch {
      toast.error('Could not add this application — try the Add Games dialog')
    } finally {
      setAddingAppId(null)
    }
  }

  const filtered = games.filter(g =>
    g.name.toLowerCase().includes(query.toLowerCase())
  )
  const activeCount = games.filter(g => g.enabled).length
  const showDiscordSection = !loading && query.trim().length >= 2

  return (
    <div className="min-h-screen px-4 sm:px-6 py-6 max-w-2xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <BackButton onClick={() => navigate({ name: 'dashboard' })} />
        <div className="flex items-center gap-2.5">
          <Gamepad2 className="w-6 h-6 text-purple-400 stroke-[2.2]" />
          <h1 className="text-2xl font-bold text-white tracking-tight">Games</h1>
        </div>
        <div className="min-w-[90px] flex justify-end">
          {activeCount > 0 && (
            <span className="text-xs font-semibold px-2.5 py-1 rounded-full bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 inline-flex items-center gap-1.5 whitespace-nowrap shadow-sm">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
              <span>{activeCount} active</span>
            </span>
          )}
        </div>
      </div>

      {/* Main Glass Card Container */}
      <div className="relative overflow-hidden bg-gradient-to-b from-[#13111d]/95 via-[#0e0d14]/95 to-[#0a0a0f] border border-white/10 rounded-[28px] p-6 sm:p-7 shadow-2xl backdrop-blur-xl">
        {/* Ambient violet glow at top left */}
        <div className="absolute -top-16 -left-12 w-56 h-56 bg-purple-600/15 rounded-full blur-3xl pointer-events-none" />

        <div className="relative z-10 space-y-5">
          {/* Search Bar */}
          <div className="relative">
            <Search className="w-4 h-4 text-white/40 absolute left-4 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              type="text"
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Search games..."
              className="w-full h-12 bg-[#12131a] border border-white/10 hover:border-white/20 focus:border-purple-500/50 rounded-2xl pl-11 pr-4 text-sm text-white placeholder:text-white/40 outline-none transition-colors"
            />
          </div>

          {/* Games List */}
          <div className="space-y-2">
            {loading && (
              <div className="p-12 text-center space-y-3">
                <div className="inline-block w-8 h-8 rounded-full border-2 border-purple-500/30 border-t-purple-500 animate-spin" />
                <p className="text-white/50 text-sm">Loading games...</p>
              </div>
            )}

            {!loading && filtered.length === 0 && (
              <div className="p-12 text-center space-y-3">
                <div className="text-4xl select-none">🎮</div>
                <p className="text-white/70 font-medium">No games found</p>
                <p className="text-xs text-white/40">
                  {query ? `No matches for "${query}". Try a different search.` : 'Game catalog is empty.'}
                </p>
                {query && (
                  <button
                    onClick={() => setQuery('')}
                    className="text-xs text-purple-300 hover:text-purple-200 mt-2 font-medium"
                  >
                    Clear search
                  </button>
                )}
              </div>
            )}

            {!loading && filtered.map(g => (
              <button
                key={g.slug}
                type="button"
                onClick={() => navigate({ name: 'game', slug: g.slug })}
                className="w-full flex items-center justify-between p-3 sm:p-3.5 bg-[#171822]/75 hover:bg-[#20212f] border border-white/5 hover:border-purple-500/30 rounded-2xl transition-all text-left cursor-pointer group active:scale-[0.99]"
              >
                <div className="flex items-center gap-3.5 min-w-0">
                  {/* Game Icon */}
                  <div className="w-12 h-12 rounded-xl overflow-hidden bg-[#121319] border border-white/10 shrink-0 relative shadow-md">
                    {/* Letter fallback (always behind the image layer) */}
                    <div className="absolute inset-0 purple-gradient flex items-center justify-center text-xs font-bold text-white select-none">
                      {g.name.slice(0, 2).toUpperCase()}
                    </div>
                    {g.iconUrl ? (
                      <img
                        src={g.iconUrl}
                        alt={g.name}
                        className="absolute inset-0 w-full h-full object-cover group-hover:scale-105 transition-transform duration-200"
                        onError={(e) => {
                          e.currentTarget.style.display = 'none'
                        }}
                      />
                    ) : null}
                  </div>

                  {/* Title & Details */}
                  <div className="min-w-0">
                    <span className="flex items-center gap-1.5 min-w-0">
                      <span className="text-sm sm:text-base font-bold text-white group-hover:text-purple-200 transition-colors truncate">
                        {g.name}
                      </span>
                      {g.custom && (
                        <span className="shrink-0 text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded-md bg-purple-500/15 text-purple-300 border border-purple-500/30">
                          Custom
                        </span>
                      )}
                    </span>
                    <span className="text-xs text-white/50 block truncate mt-0.5">
                      {g.defaultDetails || 'Rich Presence Preset'}
                    </span>
                  </div>
                </div>

                <div className="flex items-center gap-2 shrink-0 ml-3">
                  {g.enabled && (
                    <span className="text-xs font-semibold px-2.5 py-0.5 rounded-full bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 inline-flex items-center gap-1.5 whitespace-nowrap shadow-sm">
                      <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                      <span>Active</span>
                    </span>
                  )}
                  <ChevronRight className="w-5 h-5 text-white/30 group-hover:text-white/70 group-hover:translate-x-0.5 transition-all" />
                </div>
              </button>
            ))}

            {/* Trending games (real games with real App IDs) — same row style, one click to add */}
            {showDiscordSection && (
              <div className="pt-1 space-y-2">
                <div className="flex items-center gap-2 px-1 pt-2">
                  <span className="text-[10px] font-bold uppercase tracking-wider text-white/35">
                    Trending Games On Discord
                  </span>
                  {discordSearching && (
                    <Loader2 className="w-3.5 h-3.5 text-purple-300/70 animate-spin" />
                  )}
                </div>

                {!discordSearching && discordResults.length === 0 && (
                  <div className="text-[11px] text-white/30 px-1 pb-1 space-y-2">
                    <p>
                      No trending games found for "{query.trim()}".
                    </p>
                    <button
                      type="button"
                      onClick={() => setAddOpen(true)}
                      className="text-purple-300 hover:text-purple-200 font-medium inline-flex items-center gap-1 cursor-pointer"
                    >
                      <Plus className="w-3 h-3" />
                      Add it by Application ID instead
                    </button>
                  </div>
                )}

                {discordResults.map(app => {
                  const already = games.some(
                    g => g.custom && g.name.toLowerCase() === app.name.toLowerCase()
                  )
                  const busy = addingAppId === app.appId
                  return (
                    <button
                      key={app.appId}
                      type="button"
                      disabled={!!addingAppId}
                      onClick={() => handleAddDiscovered(app)}
                      className="w-full flex items-center justify-between p-3 sm:p-3.5 bg-[#171822]/75 hover:bg-[#20212f] border border-white/5 hover:border-purple-500/30 rounded-2xl transition-all text-left cursor-pointer group active:scale-[0.99] disabled:opacity-60"
                    >
                      <div className="flex items-center gap-3.5 min-w-0">
                        <div className="w-12 h-12 rounded-xl overflow-hidden bg-[#121319] border border-white/10 shrink-0 relative shadow-md">
                          <div className="absolute inset-0 purple-gradient flex items-center justify-center text-xs font-bold text-white select-none">
                            {app.name.slice(0, 2).toUpperCase()}
                          </div>
                          {app.iconUrl && (
                            <img
                              src={app.iconUrl}
                              alt={app.name}
                              className="absolute inset-0 w-full h-full object-cover group-hover:scale-105 transition-transform duration-200"
                              onError={(e) => {
                                e.currentTarget.style.display = 'none'
                              }}
                            />
                          )}
                        </div>
                        <div className="min-w-0">
                          <span className="flex items-center gap-1.5 min-w-0">
                            <span className="text-sm sm:text-base font-bold text-white group-hover:text-purple-200 transition-colors truncate">
                              {app.name}
                            </span>
                            {app.verified && (
                              <BadgeCheck className="w-3.5 h-3.5 shrink-0 text-sky-400" aria-label="Verified application" />
                            )}
                            {!app.isGame && (
                              <span className="shrink-0 text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded-md bg-white/10 text-white/60 border border-white/15">
                                App
                              </span>
                            )}
                          </span>
                          <span className="text-xs text-white/50 block truncate mt-0.5">
                            {app.description || 'Real game — trending on Discord'}
                          </span>
                        </div>
                      </div>

                      <div className="flex items-center gap-2 shrink-0 ml-3">
                        {already ? (
                          <span className="text-xs font-semibold px-2.5 py-0.5 rounded-full bg-purple-500/15 text-purple-300 border border-purple-500/30 inline-flex items-center gap-1 whitespace-nowrap">
                            <CheckCircle2 className="w-3 h-3" />
                            <span>Added</span>
                          </span>
                        ) : busy ? (
                          <Loader2 className="w-4 h-4 text-purple-300 animate-spin" />
                        ) : (
                          <span className="w-6 h-6 rounded-full bg-purple-500/15 border border-purple-500/30 flex items-center justify-center group-hover:bg-purple-500/25 group-hover:scale-110 transition-all">
                            <Plus className="w-3.5 h-3.5 text-purple-300 stroke-[2.5]" />
                          </span>
                        )}
                      </div>
                    </button>
                  )
                })}
              </div>
            )}

            {/* Add Games button */}
            {!loading && (
              <button
                type="button"
                onClick={() => setAddOpen(true)}
                className="w-full flex items-center justify-center gap-2 p-3.5 bg-transparent hover:bg-purple-500/5 border border-dashed border-white/15 hover:border-purple-500/50 rounded-2xl transition-all text-left cursor-pointer group active:scale-[0.99]"
              >
                <span className="w-6 h-6 rounded-full bg-purple-500/15 border border-purple-500/30 flex items-center justify-center group-hover:bg-purple-500/25 group-hover:scale-110 transition-all">
                  <Plus className="w-3.5 h-3.5 text-purple-300 stroke-[2.5]" />
                </span>
                <span className="text-sm font-bold text-white/60 group-hover:text-purple-200 transition-colors">
                  Add Games
                </span>
              </button>
            )}
          </div>
        </div>
      </div>

      <p className="text-xs text-white/30 text-center pt-2">
        ⚠ 10X RPC is not responsible if your account gets banned or blocked. Use at your own risk.
      </p>

      {/* Add Games dialog */}
      {addOpen && (
        <AddGameDialog
          onClose={() => setAddOpen(false)}
          onCreated={(slug) => {
            setAddOpen(false)
            refresh()
            navigate({ name: 'game', slug })
          }}
        />
      )}
    </div>
  )
}

function AddGameDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void
  onCreated: (slug: string) => void
}) {
  const [appId, setAppId] = useState('')
  const [foundApp, setFoundApp] = useState<{ name: string; iconUrl: string | null } | null>(null)
  const [lookingUp, setLookingUp] = useState(false)
  const [saving, setSaving] = useState(false)
  const appIdRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    appIdRef.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const handleAppIdLookup = async () => {
    const id = appId.trim()
    if (!id) return
    if (!/^\d{15,21}$/.test(id)) {
      toast.error('Application ID must be 15-21 digits')
      return
    }
    setLookingUp(true)
    try {
      const r = await api.appLookup(id)
      setFoundApp({ name: r.name, iconUrl: r.iconUrl })
      toast.success(`Found: ${r.name}`, { duration: 2500 })
    } catch {
      setFoundApp(null)
      toast.error('Application ID not found on Discord')
    } finally {
      setLookingUp(false)
    }
  }

  const handleCreate = async () => {
    const a = appId.trim()
    if (!a) {
      toast.error('Paste a Discord Application ID to add a game')
      return
    }
    if (!/^\d{15,21}$/.test(a)) {
      toast.error('Application ID must be 15-21 digits')
      return
    }
    setSaving(true)
    try {
      const r = await api.gameCustomCreate({ appId: a })
      toast.success(`${r.config.gameName} added to your games`, { duration: 2500 })
      onCreated(r.config.gameSlug)
    } catch {
      toast.error('Failed to add game (check the Application ID)')
    } finally {
      setSaving(false)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter') return
    e.preventDefault()
    const a = appId.trim()
    if (a && /^\d{15,21}$/.test(a) && !foundApp && !lookingUp) handleAppIdLookup()
    else if (!saving) handleCreate()
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Add a game"
        className="relative w-full max-w-md bg-gradient-to-b from-[#13111d]/95 via-[#0e0d14]/95 to-[#0a0a0f] border border-white/10 rounded-[28px] p-6 shadow-2xl max-h-[85vh] overflow-y-auto"
      >
        {/* Header */}
        <div className="flex items-center justify-between pb-4 border-b border-white/8">
          <div className="flex items-center gap-2.5">
            <span className="w-9 h-9 rounded-xl bg-purple-500/15 border border-purple-500/30 flex items-center justify-center">
              <Plus className="w-4.5 h-4.5 text-purple-300 stroke-[2.5]" />
            </span>
            <div>
              <h2 className="text-base font-bold text-white tracking-tight">Add a Game</h2>
              <p className="text-[11px] text-white/40">Create your own Rich Presence game</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="w-8 h-8 rounded-lg bg-white/5 hover:bg-white/10 border border-white/10 flex items-center justify-center transition-colors cursor-pointer"
          >
            <X className="w-4 h-4 text-white/60" />
          </button>
        </div>

        <div className="space-y-4 pt-4">
          {/* Application ID — the only field (official name + icon auto-fill) */}
          <div className="space-y-1.5">
            <label htmlFor="custom-game-appid" className="text-xs font-bold tracking-wider text-[#a855f7] uppercase block">
              Application ID
            </label>
            <input
              ref={appIdRef}
              id="custom-game-appid"
              type="text"
              value={appId}
              onChange={e => {
                setAppId(e.target.value)
                setFoundApp(null)
              }}
              onBlur={handleAppIdLookup}
              onKeyDown={handleKeyDown}
              placeholder="Discord Application ID — e.g. 1402418491272986635"
              inputMode="numeric"
              autoComplete="off"
              className="w-full h-12 bg-[#12131a] border border-white/10 hover:border-white/20 focus:border-purple-500/50 rounded-xl px-4 text-sm text-white placeholder:text-white/35 outline-none transition-colors"
            />
            <p className="text-[11px] text-white/35 px-1">
              {lookingUp ? 'Looking up application…' : 'Paste a Discord Application ID and the game is presented as that application (official name + icon auto-fill).'}
            </p>
          </div>

          {/* Found-app preview (auto-filled official identity) */}
          {foundApp && (
            <div className="flex items-center gap-3 p-3 rounded-2xl border border-emerald-500/25 bg-emerald-500/[0.07]">
              <div className="w-10 h-10 rounded-lg overflow-hidden bg-[#121319] border border-white/10 shrink-0 relative">
                <div className="absolute inset-0 purple-gradient flex items-center justify-center text-[10px] font-bold text-white select-none">
                  {foundApp.name.slice(0, 2).toUpperCase()}
                </div>
                {foundApp.iconUrl && (
                  <img
                    src={foundApp.iconUrl}
                    alt={foundApp.name}
                    className="absolute inset-0 w-full h-full object-cover"
                    onError={(e) => {
                      e.currentTarget.style.display = 'none'
                    }}
                  />
                )}
              </div>
              <div className="min-w-0">
                <p className="text-sm font-bold text-white truncate">{foundApp.name}</p>
                <p className="text-[11px] text-emerald-300/90 inline-flex items-center gap-1">
                  <CheckCircle2 className="w-3 h-3 shrink-0" />
                  Official identity found
                </p>
              </div>
            </div>
          )}

          <p className="text-[11px] leading-relaxed text-white/40 px-1">
            ℹ️ The game is presented as the official Discord application — its name and
            icon are fetched automatically. After adding, open the game to customize
            state, details, party, buttons and enable its RPC.
          </p>

          {/* Actions */}
          <div className="pt-2 flex justify-center gap-3">
            <button
              type="button"
              onClick={onClose}
              className="bg-[#1e1f26] hover:bg-[#282933] border border-white/10 text-white/80 font-medium text-xs tracking-widest uppercase px-6 py-3 rounded-xl transition-all active:scale-[0.98] cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleCreate}
              disabled={saving}
              className="purple-gradient text-white font-bold text-xs tracking-widest uppercase px-8 py-3 rounded-xl transition-all active:scale-[0.98] disabled:opacity-50 cursor-pointer shadow-lg shadow-purple-900/40"
            >
              {saving ? 'ADDING...' : 'Add Game'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
