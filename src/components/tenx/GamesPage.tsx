// 10X RPC — Games list page (#/games) with active game indicator
'use client'
import { useEffect, useState } from 'react'
import { api, type GameListItem } from '@/lib/api-client'
import { useRouter } from './useRouter'
import { BackButton } from './ui'
import { Gamepad2, Search, ChevronRight } from 'lucide-react'

export function GamesPage() {
  const { navigate } = useRouter()
  const [games, setGames] = useState<GameListItem[]>([])
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState('')

  useEffect(() => {
    api.gamesList()
      .then(r => {
        setGames(r.games)
        setLoading(false)
      })
      .catch(() => setLoading(false))
  }, [])

  const filtered = games.filter(g =>
    g.name.toLowerCase().includes(query.toLowerCase())
  )
  const activeCount = games.filter(g => g.enabled).length

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
                  <div className="w-12 h-12 rounded-xl overflow-hidden bg-[#121319] border border-white/10 shrink-0 relative flex items-center justify-center shadow-md">
                    {g.iconUrl ? (
                      <img
                        src={g.iconUrl}
                        alt={g.name}
                        className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-200"
                        onError={(e) => {
                          e.currentTarget.style.display = 'none'
                        }}
                      />
                    ) : null}
                    <div className="absolute inset-0 purple-gradient -z-10 flex items-center justify-center text-xs font-bold text-white select-none">
                      {g.name.slice(0, 2).toUpperCase()}
                    </div>
                  </div>

                  {/* Title & Details */}
                  <div className="min-w-0">
                    <span className="text-sm sm:text-base font-bold text-white group-hover:text-purple-200 transition-colors block truncate">
                      {g.name}
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
          </div>
        </div>
      </div>

      <p className="text-xs text-white/30 text-center pt-2">
        ⚠ 10X RPC is not responsible if your account gets banned or blocked. Use at your own risk.
      </p>
    </div>
  )
}
