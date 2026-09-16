// 10X RPC — Main dashboard page (#/dashboard)
'use client'
import { useEffect, useState, useCallback } from 'react'
import { api, type Me } from '@/lib/api-client'
import { useRouter } from './useRouter'
import { ProfileSection } from './ProfileSection'
import { SmartSleepTimerCard } from './SmartSleepTimerCard'
import { RichPresenceForm } from './RichPresenceForm'

export function DashboardPage() {
  const { navigate } = useRouter()
  const [me, setMe] = useState<Me | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    try {
      const m = await api.me()
      setMe(m)
      setError(null)
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to load'
      if (msg.includes('not_authenticated') || msg.includes('401')) {
        // Don't redirect to OAuth — just show the Welcome gate with Demo option
        setMe({ authenticated: false })
        return
      }
      setError(msg)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    refresh()
    // Keep-alive: refresh session every 4 minutes + ping keep-awake endpoint
    const t = setInterval(refresh, 4 * 60 * 1000)
    // Also ping the keep-awake endpoint every 10 minutes to prevent Render sleep
    const awake = setInterval(() => {
      fetch('/api/keep-awake').catch(() => {})
    }, 10 * 60 * 1000)
    return () => { clearInterval(t); clearInterval(awake) }
  }, [refresh])

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <div className="w-12 h-12 rounded-xl purple-gradient flex items-center justify-center font-black text-white mx-auto mb-3 animate-pulse">10</div>
          <p className="text-white/60 text-sm">Loading dashboard...</p>
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4">
        <div className="glass-card p-6 max-w-md text-center">
          <p className="text-red-400 font-medium mb-2">⚠ Something went wrong</p>
          <p className="text-sm text-white/60 mb-4">{error}</p>
          <button
            onClick={refresh}
            className="purple-gradient text-white font-medium px-4 py-2 rounded-xl"
          >
            Try again
          </button>
        </div>
      </div>
    )
  }

  if (!me?.authenticated) {
    // Not logged in — show demo option
    return (
      <div className="min-h-screen flex items-center justify-center p-4">
        <div className="glass-card p-8 max-w-md text-center">
          <div className="w-14 h-14 rounded-2xl purple-gradient flex items-center justify-center font-black text-white mx-auto mb-4">10</div>
          <h1 className="text-2xl font-bold text-white mb-2">Welcome to 10X RPC</h1>
          <p className="text-sm text-white/60 mb-6">
            Sign in with Discord to access your dashboard, or try the demo mode to preview the UI.
          </p>
          <div className="flex flex-col gap-2">
            <button
              onClick={() => navigate({ name: 'oauth-consent' })}
              className="purple-gradient text-white font-semibold rounded-xl px-4 py-3 shadow-lg shadow-purple-900/30 hover:opacity-90 active:scale-[0.98] transition-all"
            >
              Sign in with Discord
            </button>
            <button
              onClick={async () => {
                try {
                  const r = await api.demoLogin()
                  if (r.redirect) {
                    // Redirect to /set-session to set the cookie on Vercel's domain
                    window.location.href = r.redirect
                  } else {
                    refresh()
                  }
                } catch (e) { console.error(e) }
              }}
              className="bg-white/5 border border-white/10 text-white font-medium rounded-xl px-4 py-3 hover:bg-white/10 active:scale-[0.98] transition-all"
            >
              Try Demo Mode
            </button>
            <button
              onClick={() => navigate({ name: 'home' })}
              className="text-xs text-white/50 hover:text-white mt-2"
            >
              ← Back to landing
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen px-4 sm:px-6 py-6 max-w-2xl mx-auto pb-12">
      {/* Header */}
      <header className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-2">
          <div className="w-9 h-9 rounded-xl purple-gradient flex items-center justify-center font-black text-white">10</div>
          <span className="text-lg font-bold text-white">10X RPC</span>
        </div>
        <button
          onClick={() => navigate({ name: 'home' })}
          className="text-xs text-white/60 hover:text-white px-3 py-1.5 rounded-lg hover:bg-white/5"
        >
          ← Home
        </button>
      </header>

      <div className="space-y-4">
        {/* Profile section */}
        <ProfileSection me={me} onRefresh={refresh} />

        {/* Smart sleep timer */}
        <SmartSleepTimerCard
          currentEndsAt={me.session?.sleepTimerActive ? me.session?.sleepTimerEndsAt : null}
          onSaved={refresh}
        />

        {/* Rich presence form */}
        <RichPresenceForm
          initial={me.rpcConfig}
          onSaved={refresh}
          onToggle={(v) => api.rpcToggle(v).then(refresh)}
          onGameRpcClick={() => navigate({ name: 'games' })}
        />

        {/* Footer */}
        <p className="text-xs text-white/30 text-center pt-4">
          ⚠ 10X RPC is not responsible if your account gets banned or blocked. Use at your own risk.
        </p>
      </div>
    </div>
  )
}
