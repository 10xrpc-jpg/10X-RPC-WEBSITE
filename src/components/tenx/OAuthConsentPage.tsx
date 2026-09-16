// 10X RPC — OAuth consent preview page (mirrors Discord's consent screen)
'use client'
import { useState } from 'react'
import { api } from '@/lib/api-client'
import { useRouter } from './useRouter'
import { Card, PrimaryButton, GhostButton, BackButton } from './ui'

const PERMISSIONS = [
  { icon: '👤', label: 'Access your profile information (username, avatar)', granted: true },
  { icon: '🎮', label: 'Update your activity status on Discord', granted: true },
  { icon: '📝', label: 'Update your profile on Discord with your application activity', granted: true },
  { icon: '⏰', label: 'Set custom status (emoji + text)', granted: true },
  { icon: '🟢', label: 'Set user status (Online / Idle / DND / Invisible)', granted: true },
  { icon: '🖼️', label: 'Display Rich Presence (game activity, images, buttons)', granted: true },
]

const FEATURES = [
  { icon: '🎮', text: 'Share your game activity with Discord' },
  { icon: '⚙️', text: 'Set custom status with emoji + text' },
  { icon: '🟢', text: 'Switch between Online, Idle, DND, and Invisible' },
]

export function OAuthConsentPage() {
  const { navigate } = useRouter()
  const [loading, setLoading] = useState<'oauth' | 'demo' | null>(null)

  const handleAuthorize = () => {
    setLoading('oauth')
    window.location.href = '/auth/discord'
  }

  const handleDemo = async () => {
    setLoading('demo')
    try {
      const r = await api.demoLogin()
      if (r.redirect) {
        // Redirect to /set-session to set the cookie on Vercel's domain
        window.location.href = r.redirect
      } else {
        navigate({ name: 'dashboard' })
      }
    } catch (e) {
      console.error(e)
      setLoading(null)
    }
  }

  return (
    <div className="min-h-screen flex flex-col bg-gradient-to-b from-[#1a0f2e] via-[#0a0b0f] to-[#0a0b0f] relative overflow-hidden">
      {/* Decorative bokeh orbs */}
      <div aria-hidden className="absolute top-1/4 left-1/4 w-72 h-72 rounded-full bg-purple-600/20 blur-[100px]" />
      <div aria-hidden className="absolute bottom-1/4 right-1/4 w-96 h-96 rounded-full bg-indigo-600/15 blur-[120px]" />

      <div className="relative z-10 px-4 sm:px-6 py-6 max-w-md mx-auto w-full">
        {/* Back */}
        <button
          onClick={() => navigate({ name: 'home' })}
          className="text-xs text-white/60 hover:text-white mb-4 inline-flex items-center gap-1"
        >
          ← Back to home
        </button>

        {/* Discord header */}
        <div className="flex items-center gap-2 mb-6">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="white">
            <path d="M20.317 4.369a19.79 19.79 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128c.126-.094.252-.192.372-.291a.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.061 0a.074.074 0 0 1 .078.009c.12.099.246.198.373.292a.077.077 0 0 1-.006.127 12.3 12.3 0 0 1-1.873.891.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.056c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.028zM8.02 15.331c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z"/>
          </svg>
          <span className="text-white font-bold">Discord</span>
        </div>

        {/* Authorization card */}
        <Card className="space-y-5">
          {/* App identity */}
          <div className="flex items-center justify-center gap-3 py-2">
            <div className="w-14 h-14 rounded-xl purple-gradient flex items-center justify-center font-black text-white text-lg">
              10
            </div>
            <span className="text-white/40 text-2xl">···</span>
            <div className="w-14 h-14 rounded-xl bg-white/5 border border-white/10 flex items-center justify-center text-2xl">
              🎮
            </div>
          </div>

          <div className="text-center space-y-1">
            <p className="text-sm text-white/60">Connect your Discord account to</p>
            <h1 className="text-2xl font-bold text-white">10X RPC PRO</h1>
          </div>

          {/* Info box */}
          <div className="bg-white/5 border border-white/8 rounded-xl p-3 space-y-2">
            <p className="text-xs text-white/70">
              This game&apos;s social experience is powered by Discord.{' '}
              <a href="https://discord.com/developers/docs/topics/oauth2" target="_blank" rel="noopener" className="text-blue-400 hover:underline">Learn more</a>
            </p>
            {FEATURES.map((f, i) => (
              <div key={i} className="flex items-start gap-2 text-xs text-white/80">
                <span>{f.icon}</span>
                <span>{f.text}</span>
              </div>
            ))}
          </div>

          {/* Permissions */}
          <div className="space-y-2">
            <p className="text-xs text-white/70 font-medium">
              This will allow the developer of <strong className="text-white">10X RPC PRO</strong> to:
            </p>
            <div className="space-y-1.5">
              {PERMISSIONS.map((p, i) => (
                <div key={i} className="flex items-center gap-2 text-xs text-white/80">
                  <span className="text-green-400 text-sm">✓</span>
                  <span>{p.label}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Redirect notice */}
          <div className="bg-white/5 border border-white/8 rounded-xl p-3 space-y-2">
            <div className="flex items-start gap-2 text-xs text-white/60">
              <span>🔗</span>
              <span>Once you authorize, you will be redirected outside of Discord to this app.</span>
            </div>
            <div className="flex items-start gap-2 text-xs text-white/60">
              <span>🛡️</span>
              <span>This application cannot read your messages or send messages as you.</span>
            </div>
          </div>

          {/* Action buttons */}
          <div className="flex gap-2 pt-2">
            <GhostButton
              onClick={() => navigate({ name: 'home' })}
              className="flex-1 py-3"
            >
              Cancel
            </GhostButton>
            <PrimaryButton
              onClick={handleAuthorize}
              disabled={loading !== null}
              className="flex-1 py-3"
            >
              {loading === 'oauth' ? 'Redirecting...' : 'Authorize'}
            </PrimaryButton>
          </div>

          {/* Demo login alternative */}
          <div className="pt-3 border-t border-white/5 text-center">
            <p className="text-xs text-white/50 mb-2">Just want to preview the dashboard?</p>
            <button
              onClick={handleDemo}
              disabled={loading !== null}
              className="text-xs text-purple-300 hover:text-purple-200 font-medium"
            >
              {loading === 'demo' ? 'Loading demo...' : 'Try Demo Mode →'}
            </button>
          </div>
        </Card>

        <p className="text-center text-xs text-white/40 mt-6">
          By authorizing, you agree to 10X RPC&apos;s Terms of Service and Privacy Policy.
        </p>
      </div>
    </div>
  )
}
