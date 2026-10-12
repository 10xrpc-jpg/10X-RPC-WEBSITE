// 10X RPC — Reconnect Discord banner
//
// Shown whenever an authenticated session has NO live Discord OAuth token:
//   • the Discord grant expired and its refresh token died (24/7 daemon
//     cleared the dead tokens), or
//   • the session is a demo session (demo-login never carries a token).
// Without a token the 24/7 daemon cannot hold a Discord gateway connection,
// so Status / RPC / Game RPC would silently do nothing — this banner makes
// that state VISIBLE and gives the one-click fix (/auth/discord PKCE OAuth).

import { AlertTriangle, RefreshCw } from 'lucide-react'

interface ReconnectBannerProps {
  /** Demo sessions never carry a real token — adapt the wording. */
  isDemo?: boolean
}

export function ReconnectBanner({ isDemo }: ReconnectBannerProps) {
  return (
    <div
      role="alert"
      aria-live="polite"
      className="relative overflow-hidden rounded-2xl border border-amber-400/30 bg-gradient-to-r from-amber-500/10 via-[#13111d]/80 to-[#13111d]/80 p-4 sm:p-5"
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start gap-3 min-w-0">
          <div className="w-9 h-9 shrink-0 rounded-xl bg-amber-400/15 border border-amber-400/25 flex items-center justify-center">
            <AlertTriangle className="w-4.5 h-4.5 text-amber-400" />
          </div>
          <div className="min-w-0">
            <p className="text-sm font-bold text-white leading-tight">
              {isDemo ? 'You are in demo mode' : 'Discord connection expired'}
            </p>
            <p className="text-xs text-white/60 mt-1 leading-relaxed">
              {isDemo
                ? 'Connect your Discord account to run Status, RPC and Game RPC live 24/7.'
                : 'Your Discord link is no longer valid, so Status / RPC / Game RPC cannot run 24/7. Reconnect to go back live.'}
            </p>
          </div>
        </div>
        <button
          onClick={() => { window.location.href = '/auth/discord' }}
          className="shrink-0 inline-flex items-center justify-center gap-2 purple-gradient text-white text-sm font-bold rounded-xl px-4 py-3 min-h-[44px] shadow-lg shadow-purple-900/30 hover:opacity-90 active:scale-[0.98] transition-all"
        >
          <RefreshCw className="w-4 h-4" />
          {isDemo ? 'Connect Discord' : 'Reconnect Discord'}
        </button>
      </div>
    </div>
  )
}
