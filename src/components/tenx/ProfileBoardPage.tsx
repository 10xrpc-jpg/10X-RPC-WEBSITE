// 10X RPC — Profile Board page (/profile)
// The user's profile board: account identity + "Favorite Game" section.
// Favorite Game → Add Game opens a search that covers the existing game
// catalog PLUS all of Discord: the official TRENDING GAMES ranking and the
// full 24,600+ DETECTABLE GAMES catalog (scored search — exact > prefix >
// contains > executable, like the reference standalone-profile-board.js).
// One click on a result automatically grabs the correct Discord Application
// ID (official name + icon auto-fill), stars it as a favorite and sets it as
// the live Game RPC.
// Any favorited row can be re-applied as Game RPC with a single tap.
'use client'
import { useEffect, useState, useRef, useCallback } from 'react'
import { toast } from 'sonner'
import { api, type Me, type GameListItem, type DiscoveredApp, type FavoriteGameItem } from '@/lib/api-client'
import { useRouter } from './useRouter'
import { BackButton } from './ui'
import { ReconnectBanner } from './ReconnectBanner'
import { User, Star, Plus, X, Gamepad2, BadgeCheck, Loader2, CheckCircle2, Search, Zap, ChevronDown } from 'lucide-react'

export function ProfileBoardPage() {
  const { navigate } = useRouter()
  const [me, setMe] = useState<Me | null>(null)
  const [favorites, setFavorites] = useState<FavoriteGameItem[]>([])
  const [loading, setLoading] = useState(true)
  const [addOpen, setAddOpen] = useState(false)
  const [usingId, setUsingId] = useState<string | null>(null)
  const [removingId, setRemovingId] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const [m, f] = await Promise.all([
        api.me().catch(() => ({ authenticated: false }) as Me),
        api.favoritesList(),
      ])
      setMe(m)
      setFavorites(f.favorites || [])
    } catch {
      // favorites list failed — leave whatever we have
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  /** One click on a favorite = apply it as the live Game RPC (auto-creates the
   * game with its official App ID when it isn't in the catalog yet). */
  const handleUse = async (fav: FavoriteGameItem) => {
    if (usingId) return
    setUsingId(fav.id)
    try {
      const r = await api.favoriteUse(fav.id)
      toast.success(`${r.name} is now your Game RPC`, { duration: 2500 })
      await refresh()
      navigate({ name: 'game', slug: r.slug })
    } catch (e) {
      toast.error(e instanceof Error && e.message !== 'not_authenticated'
        ? `Could not apply ${fav.name} — try again`
        : 'Could not apply this favorite')
    } finally {
      setUsingId(null)
    }
  }

  const handleRemove = async (fav: FavoriteGameItem) => {
    if (removingId) return
    setRemovingId(fav.id)
    try {
      await api.favoriteRemove(fav.id)
      setFavorites(prev => prev.filter(f => f.id !== fav.id))
      toast.success(`${fav.name} removed from favorites`, { duration: 2000 })
    } catch {
      toast.error('Could not remove this favorite')
    } finally {
      setRemovingId(null)
    }
  }

  const activeGame = me?.activeGame ?? null
  const isActiveFavorite = (fav: FavoriteGameItem) => {
    if (!activeGame) return false
    if (fav.slug) return activeGame.slug === fav.slug
    return activeGame.name.toLowerCase() === fav.name.toLowerCase()
  }

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <div className="w-12 h-12 rounded-xl purple-gradient flex items-center justify-center font-black text-white mx-auto mb-3 animate-pulse">10</div>
          <p className="text-white/60 text-sm">Loading profile board...</p>
        </div>
      </div>
    )
  }

  if (!me?.authenticated || !me.user) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4">
        <div className="glass-card p-8 max-w-md text-center">
          <div className="w-14 h-14 rounded-2xl purple-gradient flex items-center justify-center font-black text-white mx-auto mb-4">10</div>
          <h1 className="text-xl font-bold text-white mb-2">Profile Board</h1>
          <p className="text-sm text-white/60 mb-6">Sign in with Discord to manage your favorite games.</p>
          <button
            onClick={() => { window.location.href = '/auth/discord' }}
            className="purple-gradient text-white font-semibold rounded-xl px-4 py-3 shadow-lg shadow-purple-900/30 hover:opacity-90 active:scale-[0.98] transition-all"
          >
            Sign in with Discord
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen px-4 sm:px-6 py-6 max-w-2xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <BackButton onClick={() => navigate({ name: 'dashboard' })} />
        <div className="flex items-center gap-2.5">
          <User className="w-6 h-6 text-purple-400 stroke-[2.2]" />
          <h1 className="text-2xl font-bold text-white tracking-tight">Profile Board</h1>
        </div>
        <div className="min-w-[90px]" />
      </div>

      {/* Discord-link health: without a live token the 24/7 daemon cannot run
          anything — surface it instead of failing silently. */}
      {me.session?.hasDiscordToken === false && (
        <ReconnectBanner isDemo={me.user.id === 'demo-user-10x'} />
      )}

      {/* Account card */}
      <div className="relative overflow-hidden bg-gradient-to-b from-[#13111d]/95 via-[#0e0d14]/95 to-[#0a0a0f] border border-white/10 rounded-[28px] p-6 shadow-2xl backdrop-blur-xl">
        <div className="absolute -top-16 -left-12 w-56 h-56 bg-purple-600/15 rounded-full blur-3xl pointer-events-none" />
        <div className="relative z-10 flex items-center gap-4">
          <div className="w-16 h-16 rounded-2xl overflow-hidden border border-white/10 shadow-lg shrink-0 bg-[#121319]">
            <img src={me.user.avatar} alt={me.user.username} className="w-full h-full object-cover" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-lg font-bold text-white truncate">{me.user.username}</p>
            <p className="text-xs text-white/45 font-mono truncate">{me.user.id}</p>
            <div className="flex flex-wrap items-center gap-1.5 mt-2">
              {me.session?.gatewayReady && (
                <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-md bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 inline-flex items-center gap-1">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" /> Gateway Live
                </span>
              )}
              {me.activeGame ? (
                <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-md bg-purple-500/15 text-purple-300 border border-purple-500/30 inline-flex items-center gap-1">
                  <Zap className="w-2.5 h-2.5" /> Game RPC: {me.activeGame.name}
                </span>
              ) : me.session?.rpcEnabled ? (
                <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-md bg-purple-500/15 text-purple-300 border border-purple-500/30 inline-flex items-center gap-1">
                  <Zap className="w-2.5 h-2.5" /> Normal RPC
                </span>
              ) : (
                <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-md bg-white/5 text-white/50 border border-white/10">
                  RPC Off
                </span>
              )}
              {me.trial?.active && (
                <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-md bg-white/5 text-white/50 border border-white/10">
                  {me.trial.daysLeft}d trial
                </span>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Favorite Game card */}
      <div className="relative overflow-hidden bg-gradient-to-b from-[#13111d]/95 via-[#0e0d14]/95 to-[#0a0a0f] border border-white/10 rounded-[28px] p-6 sm:p-7 shadow-2xl backdrop-blur-xl">
        <div className="absolute -top-16 -right-12 w-56 h-56 bg-purple-600/10 rounded-full blur-3xl pointer-events-none" />

        <div className="relative z-10 space-y-5">
          {/* Section header */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Star className="w-5 h-5 text-amber-300 fill-amber-300/80" />
              <h2 className="text-lg font-bold text-white tracking-tight">Favorite Game</h2>
            </div>
            <button
              type="button"
              onClick={() => setAddOpen(true)}
              className="inline-flex items-center gap-1.5 purple-gradient text-white font-bold text-xs tracking-wider uppercase px-4 py-2.5 rounded-xl shadow-lg shadow-purple-900/40 hover:opacity-90 active:scale-[0.98] transition-all cursor-pointer"
            >
              <Plus className="w-4 h-4 stroke-[2.5]" />
              Add Game
            </button>
          </div>

          <p className="text-xs text-white/40 -mt-2">
            Star any game and apply it as your Game RPC in one tap. Adding a new game grabs its official Discord Application ID automatically.
          </p>

          {/* Favorites list */}
          {favorites.length === 0 ? (
            <div className="p-10 text-center space-y-3 border border-dashed border-white/10 rounded-2xl">
              <div className="text-4xl select-none">⭐</div>
              <p className="text-white/70 font-medium">No favorite games yet</p>
              <p className="text-xs text-white/40 max-w-xs mx-auto">
                Tap <span className="text-purple-300 font-semibold">Add Game</span> and search e.g. "Minecraft" — the Application ID is fetched automatically and the game goes live as your Game RPC.
              </p>
            </div>
          ) : (
            <div className="space-y-2 max-h-96 overflow-y-auto scrollbar-thin scrollbar-thumb-white/10 scrollbar-track-transparent pr-0.5">
              {favorites.map(fav => {
                const active = isActiveFavorite(fav)
                const busy = usingId === fav.id
                return (
                  <div
                    key={fav.id}
                    role="button"
                    tabIndex={0}
                    onClick={() => handleUse(fav)}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleUse(fav) } }}
                    className="w-full flex items-center justify-between p-3 sm:p-3.5 bg-[#171822]/75 hover:bg-[#20212f] border border-white/5 hover:border-purple-500/30 rounded-2xl transition-all text-left cursor-pointer group active:scale-[0.99] outline-none focus-visible:border-purple-500/60"
                    aria-label={`${fav.name} — use as Game RPC`}
                  >
                    <div className="flex items-center gap-3.5 min-w-0">
                      <div className="w-12 h-12 rounded-xl overflow-hidden bg-[#121319] border border-white/10 shrink-0 relative shadow-md">
                        <div className="absolute inset-0 icon-fallback flex items-center justify-center text-xs font-bold text-white/70 select-none">
                          {fav.name.slice(0, 2).toUpperCase()}
                        </div>
                        {fav.iconUrl && (
                          <img
                            src={fav.iconUrl}
                            alt={fav.name}
                            className="absolute inset-0 w-full h-full object-cover group-hover:scale-105 transition-transform duration-200"
                            onError={(e) => { e.currentTarget.style.display = 'none' }}
                          />
                        )}
                      </div>
                      <div className="min-w-0">
                        <span className="flex items-center gap-1.5 min-w-0">
                          <span className="text-sm sm:text-base font-bold text-white group-hover:text-purple-200 transition-colors truncate">
                            {fav.name}
                          </span>
                          <Star className="w-3.5 h-3.5 shrink-0 text-amber-300 fill-amber-300/80" />
                          {fav.appId && (
                            <span className="shrink-0 hidden sm:inline text-[9px] font-mono text-white/40 border border-white/10 rounded-md px-1.5 py-0.5">
                              ID {fav.appId}
                            </span>
                          )}
                        </span>
                        <span className="text-xs text-white/50 block truncate mt-0.5">
                          {active ? 'Live on your Discord profile' : 'Tap to set as Game RPC'}
                        </span>
                      </div>
                    </div>

                    <div className="flex items-center gap-2 shrink-0 ml-3">
                      {active && (
                        <span className="text-xs font-semibold px-2.5 py-0.5 rounded-full bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 inline-flex items-center gap-1.5 whitespace-nowrap shadow-sm">
                          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                          <span>Active</span>
                        </span>
                      )}
                      {busy ? (
                        <Loader2 className="w-4 h-4 text-purple-300 animate-spin" />
                      ) : (
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); handleRemove(fav) }}
                          disabled={!!removingId}
                          aria-label={`Remove ${fav.name} from favorites`}
                          className="w-8 h-8 rounded-lg bg-white/5 hover:bg-red-500/15 border border-white/10 hover:border-red-500/40 flex items-center justify-center transition-colors cursor-pointer disabled:opacity-50"
                        >
                          <X className="w-4 h-4 text-white/50 hover:text-red-300" />
                        </button>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>

      <p className="text-xs text-white/30 text-center pt-2">
        ⚠ 10X RPC is not responsible if your account gets banned or blocked. Use at your own risk.
      </p>

      {/* Add Game dialog */}
      {addOpen && (
        <AddFavoriteGameDialog
          onClose={() => setAddOpen(false)}
          onDone={async () => {
            setAddOpen(false)
            await refresh()
          }}
        />
      )}
    </div>
  )
}

/** Search dialog: existing catalog games + Discord App Directory results.
 * One click on a directory result = auto-grab the Application ID, favorite it
 * and set it as the live Game RPC. */
function AddFavoriteGameDialog({
  onClose,
  onDone,
}: {
  onClose: () => void
  onDone: () => Promise<void>
}) {
  const { navigate } = useRouter()
  const [query, setQuery] = useState('')
  const [games, setGames] = useState<GameListItem[]>([])
  const [favorites, setFavorites] = useState<FavoriteGameItem[]>([])
  const [discordResults, setDiscordResults] = useState<DiscoveredApp[]>([])
  const [discordSearching, setDiscordSearching] = useState(false)
  const [discordIsPopular, setDiscordIsPopular] = useState(true)
  const [busyAppId, setBusyAppId] = useState<string | null>(null)
  const [starringName, setStarringName] = useState<string | null>(null)
  // "See more" pagination for the dialog's Discord search results
  const [searchLimit, setSearchLimit] = useState(24)
  const [loadingMore, setLoadingMore] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const discordSeq = useRef(0)

  useEffect(() => {
    inputRef.current?.focus()
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    api.gamesList().then(r => setGames(r.games)).catch(() => {})
    api.favoritesList().then(r => setFavorites(r.favorites || [])).catch(() => {})
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  // Debounced Discord search (same sources as the Games page: trending games
  // first, then the 24,600+ detectable games catalog). An empty query returns
  // curated Popular Games so the dialog opens with instant suggestions.
  useEffect(() => {
    const q = query.trim()
    setSearchLimit(24)
    if (q.length === 1) {
      // Too short for a real search — show only the matched catalog games.
      ++discordSeq.current
      setDiscordResults([])
      setDiscordSearching(false)
      setDiscordIsPopular(false)
      return
    }
    const seq = ++discordSeq.current
    setDiscordSearching(true)
    const t = setTimeout(() => {
      api.gamesDiscover(q)
        .then(r => {
          if (discordSeq.current !== seq) return
          setDiscordResults(r.results || [])
          setDiscordIsPopular(!!r.popular)
          setDiscordSearching(false)
        })
        .catch(() => {
          if (discordSeq.current !== seq) return
          setDiscordResults([])
          setDiscordSearching(false)
        })
    }, q ? 350 : 0)
    return () => clearTimeout(t)
  }, [query])

  const isFavorited = (name: string) =>
    favorites.some(f => f.name.toLowerCase() === name.toLowerCase())

  /** "See more" — re-fetch the same query with a higher limit, revealing a
   * superset of the current results (trending stays, the catalog expands). */
  const seeMoreResults = async () => {
    const q = query.trim()
    if (loadingMore || q.length < 2) return
    setLoadingMore(true)
    try {
      const r = await api.gamesDiscover(q, searchLimit + 24)
      setDiscordResults(r.results || [])
      setDiscordIsPopular(false)
      setSearchLimit(searchLimit + 24)
    } catch {
      toast.error('Could not load more results')
    } finally {
      setLoadingMore(false)
    }
  }

  const starGame = async (g: GameListItem) => {
    if (starringName) return
    setStarringName(g.name)
    try {
      const r = await api.favoriteAdd({
        name: g.name,
        slug: g.custom ? undefined : g.slug,
        appId: g.appId || undefined,
        iconUrl: g.iconUrl || null,
      })
      setFavorites(prev => [r.favorite, ...prev.filter(f => f.id !== r.favorite.id)])
      toast.success(`${g.name} added to Favorite Game`, { duration: 2200 })
    } catch {
      toast.error('Could not favorite this game')
    } finally {
      setStarringName(null)
    }
  }

  /** Full one-click flow: auto-grab the official Application ID → create the
   * game → favorite it → set it live as Game RPC → open its config page. */
  const handleAddDiscovered = async (app: DiscoveredApp) => {
    if (busyAppId) return
    setBusyAppId(app.appId)
    try {
      // 1. Create the custom game — the official identity (App ID + name +
      //    icon) is fetched from Discord automatically.
      await api.gameCustomCreate({ appId: app.appId })
      // 2. Star it as a favorite on the Profile Board.
      const f = await api.favoriteAdd({ name: app.name, appId: app.appId, iconUrl: app.iconUrl })
      // 3. Apply it as the live Game RPC (mutual exclusivity + daemon push
      //    handled server-side).
      const u = await api.favoriteUse(f.favorite.id)
      toast.success(`${u.name} favorited & set as your Game RPC`, { duration: 3000 })
      setFavorites(prev => [f.favorite, ...prev])
      await onDone()
      navigate({ name: 'game', slug: u.slug })
    } catch {
      toast.error('Could not add this game — try again')
    } finally {
      setBusyAppId(null)
    }
  }

  // Search results split by source: trending games rank first, then ALL
  // matches from the 24,600+ detectable games catalog.
  const trendingResults = discordResults.filter(r => (r.source ?? 'trending') === 'trending')
  const detectableResults = discordResults.filter(r => r.source === 'detectable')

  /** Shared row for a discovered app — one click runs the full flow: grab the
   * official Application ID, favorite it and set it live as Game RPC. */
  const resultRow = (app: DiscoveredApp) => {
    const busy = busyAppId === app.appId
    const alreadyGame = games.some(
      g => g.custom && g.name.toLowerCase() === app.name.toLowerCase()
    )
    return (
      <button
        key={app.appId}
        type="button"
        disabled={!!busyAppId}
        onClick={() => handleAddDiscovered(app)}
        className="w-full flex items-center justify-between p-3 sm:p-3.5 bg-[#171822]/75 hover:bg-[#20212f] border border-white/5 hover:border-purple-500/30 rounded-2xl transition-all text-left cursor-pointer group active:scale-[0.99] disabled:opacity-60"
      >
        <div className="flex items-center gap-3.5 min-w-0">
          <div className="w-12 h-12 rounded-xl overflow-hidden bg-[#121319] border border-white/10 shrink-0 relative shadow-md">
            <div className="absolute inset-0 icon-fallback flex items-center justify-center text-xs font-bold text-white/70 select-none">
              {app.name.slice(0, 2).toUpperCase()}
            </div>
            {app.iconUrl && (
              <img
                src={app.iconUrl}
                alt={app.name}
                className="absolute inset-0 w-full h-full object-cover group-hover:scale-105 transition-transform duration-200"
                onError={(e) => { e.currentTarget.style.display = 'none' }}
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
              {app.description || (app.source === 'trending' ? 'Real game — trending on Discord' : 'Discord application')}
            </span>
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0 ml-3">
          {busy ? (
            <Loader2 className="w-4 h-4 text-purple-300 animate-spin" />
          ) : alreadyGame ? (
            <span className="text-xs font-semibold px-2.5 py-0.5 rounded-full bg-amber-400/10 text-amber-300 border border-amber-400/30 inline-flex items-center gap-1 whitespace-nowrap">
              <Star className="w-3 h-3 fill-amber-300/80" />
              <span>Favorite</span>
            </span>
          ) : (
            <span className="w-6 h-6 rounded-full bg-purple-500/15 border border-purple-500/30 flex items-center justify-center group-hover:bg-purple-500/25 group-hover:scale-110 transition-all">
              <Plus className="w-3.5 h-3.5 text-purple-300 stroke-[2.5]" />
            </span>
          )}
        </div>
      </button>
    )
  }

  const q = query.trim().toLowerCase()
  const matchedGames = q.length >= 1
    ? games.filter(g => g.name.toLowerCase().includes(q))
    : []
  const showDirectory = q.length >= 2 || q.length === 0

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Add a favorite game"
        className="relative w-full max-w-md bg-gradient-to-b from-[#13111d]/95 via-[#0e0d14]/95 to-[#0a0a0f] border border-white/10 rounded-[28px] p-6 shadow-2xl max-h-[85vh] overflow-y-auto"
      >
        {/* Header */}
        <div className="flex items-center justify-between pb-4 border-b border-white/8">
          <div className="flex items-center gap-2.5">
            <span className="w-9 h-9 rounded-xl bg-purple-500/15 border border-purple-500/30 flex items-center justify-center">
              <Star className="w-4.5 h-4.5 text-amber-300 fill-amber-300/70" />
            </span>
            <div>
              <h2 className="text-base font-bold text-white tracking-tight">Add Game</h2>
              <p className="text-[11px] text-white/40">Search any game — the ID is grabbed automatically</p>
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

        {/* Search */}
        <div className="pt-4">
          <div className="relative">
            <Search className="w-4 h-4 text-white/40 absolute left-4 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Search games... e.g. Minecraft"
              aria-label="Search games"
              className="w-full h-12 bg-[#12131a] border border-white/10 hover:border-white/20 focus:border-purple-500/50 rounded-2xl pl-11 pr-4 text-sm text-white placeholder:text-white/40 outline-none transition-colors"
            />
          </div>
        </div>

        <div className="space-y-2 pt-4">
          {/* Your existing games */}
          {matchedGames.length > 0 && (
            <div className="space-y-2">
              <div className="flex items-center gap-2 px-1">
                <span className="text-[10px] font-bold uppercase tracking-wider text-white/35">
                  Your Games
                </span>
              </div>
              {matchedGames.map(g => {
                const fav = isFavorited(g.name)
                const busy = starringName === g.name
                return (
                  <div
                    key={g.slug}
                    className="w-full flex items-center justify-between p-3 bg-[#171822]/75 border border-white/5 rounded-2xl"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="w-10 h-10 rounded-lg overflow-hidden bg-[#121319] border border-white/10 shrink-0 relative">
                        <div className="absolute inset-0 icon-fallback flex items-center justify-center text-[10px] font-bold text-white/70 select-none">
                          {g.name.slice(0, 2).toUpperCase()}
                        </div>
                        {g.iconUrl && (
                          <img
                            src={g.iconUrl}
                            alt={g.name}
                            className="absolute inset-0 w-full h-full object-cover"
                            onError={(e) => { e.currentTarget.style.display = 'none' }}
                          />
                        )}
                      </div>
                      <div className="min-w-0">
                        <p className="text-sm font-bold text-white truncate">{g.name}</p>
                        <p className="text-[11px] text-white/40 truncate">{g.custom ? 'Custom game' : 'Catalog preset'}</p>
                      </div>
                    </div>
                    {fav ? (
                      <span className="text-xs font-semibold px-2.5 py-0.5 rounded-full bg-amber-400/10 text-amber-300 border border-amber-400/30 inline-flex items-center gap-1 whitespace-nowrap">
                        <Star className="w-3 h-3 fill-amber-300/80" />
                        <span>Favorited</span>
                      </span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => starGame(g)}
                        disabled={!!starringName}
                        aria-label={`Favorite ${g.name}`}
                        className="w-9 h-9 rounded-full bg-purple-500/15 border border-purple-500/30 flex items-center justify-center hover:bg-purple-500/25 hover:scale-110 transition-all cursor-pointer disabled:opacity-50"
                      >
                        {busy ? (
                          <Loader2 className="w-4 h-4 text-purple-300 animate-spin" />
                        ) : (
                          <Star className="w-4 h-4 text-purple-300" />
                        )}
                      </button>
                    )}
                  </div>
                )
              })}
            </div>
          )}

          {/* Discord search results — trending games first, then ALL matches
              from the 24,600+ detectable games catalog */}
          {showDirectory && (
            <div className="space-y-2">
              {discordSearching && (
                <div className="flex items-center gap-2 px-1 pt-1">
                  <span className="text-[10px] font-bold uppercase tracking-wider text-white/35">
                    Searching Discord...
                  </span>
                  <Loader2 className="w-3.5 h-3.5 text-purple-300/70 animate-spin" />
                </div>
              )}

              {!discordSearching && discordIsPopular && discordResults.length > 0 && (
                <div className="space-y-2">
                  <div className="flex items-center gap-2 px-1 pt-1">
                    <span className="text-[10px] font-bold uppercase tracking-wider text-white/35">
                      Popular On Discord
                    </span>
                    <span className="text-[9px] font-semibold text-purple-300/70 bg-purple-500/10 border border-purple-500/20 px-1.5 py-0.5 rounded-md">
                      24,600+ catalog
                    </span>
                  </div>
                  {discordResults.map(resultRow)}
                </div>
              )}

              {!discordSearching && !discordIsPopular && trendingResults.length > 0 && (
                <div className="space-y-2">
                  <div className="flex items-center gap-2 px-1 pt-1">
                    <span className="text-[10px] font-bold uppercase tracking-wider text-white/35">
                      Trending Games On Discord
                    </span>
                  </div>
                  {trendingResults.map(resultRow)}
                </div>
              )}

              {!discordSearching && !discordIsPopular && detectableResults.length > 0 && (
                <div className="space-y-2">
                  <div className="flex items-center gap-2 px-1 pt-1">
                    <span className="text-[10px] font-bold uppercase tracking-wider text-white/35">
                      All Games On Discord
                    </span>
                    <span className="text-[9px] font-semibold text-purple-300/70 bg-purple-500/10 border border-purple-500/20 px-1.5 py-0.5 rounded-md">
                      24,600+ catalog
                    </span>
                  </div>
                  {detectableResults.map(resultRow)}
                </div>
              )}

              {/* See more — expand the catalog results */}
              {!discordSearching && !discordIsPopular && discordResults.length >= searchLimit && searchLimit < 96 && (
                <button
                  type="button"
                  onClick={seeMoreResults}
                  disabled={loadingMore}
                  className="w-full flex items-center justify-center gap-2 p-3 bg-[#171822]/75 hover:bg-[#20212f] border border-white/5 hover:border-purple-500/30 rounded-2xl text-xs font-bold uppercase tracking-wider text-white/60 hover:text-white transition-all cursor-pointer disabled:opacity-60"
                >
                  {loadingMore ? (
                    <Loader2 className="w-3.5 h-3.5 text-purple-300 animate-spin" />
                  ) : (
                    <ChevronDown className="w-3.5 h-3.5 text-purple-300" />
                  )}
                  {loadingMore ? 'Loading more...' : 'See more'}
                </button>
              )}

              {!discordSearching && !discordIsPopular && discordResults.length === 0 && (
                <p className="text-[11px] text-white/30 px-1 pb-1">
                  No results on Discord for "{query.trim()}".
                </p>
              )}

              {!discordSearching && discordResults.length > 0 && (
                <p className="text-[11px] text-white/35 px-1 pt-1 flex items-center gap-1.5">
                  <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400/70 shrink-0" />
                  One click grabs the official Application ID, favorites the game and sets it live as your Game RPC.
                </p>
              )}
            </div>
          )}

          {/* Idle hint (only if the popular list failed to load) */}
          {q.length === 0 && !discordSearching && discordResults.length === 0 && (
            <div className="p-8 text-center space-y-2">
              <Gamepad2 className="w-8 h-8 text-white/25 mx-auto" />
              <p className="text-sm text-white/50 font-medium">Search any game</p>
              <p className="text-xs text-white/35">
                Your games appear instantly — anything else is searched across ALL of Discord (trending games + the 24,600+ detectable catalog) with automatic ID detection.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
