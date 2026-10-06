// 10X RPC — history-based SPA router (clean URLs — no /#/ hash prefix).
// Navigations use history.pushState; the page component inside app/page.tsx
// re-renders from the URL pathname. next.config.ts rewrites the known app
// paths back to "/" so direct loads and refreshes serve the same SPA shell.
// Legacy "#/..." URLs are migrated to clean paths by an inline script in
// app/layout.tsx that runs before this module (and Next.js) boots.
'use client'
import { useCallback, useSyncExternalStore } from 'react'

export type Route =
  | { name: 'home' }
  | { name: 'dashboard' }
  | { name: 'games' }
  | { name: 'game', slug: string }
  | { name: 'config' }
  | { name: 'rotator' }
  | { name: 'oauth-consent' }
  | { name: 'admin' }

export function parsePath(pathname: string): Route {
  const clean = pathname.replace(/^\/+|\/+$/g, '').trim()
  if (!clean) return { name: 'home' }
  const parts = clean.split('/')
  if (parts[0] === 'dashboard') return { name: 'dashboard' }
  if (parts[0] === 'games') {
    if (parts[1]) return { name: 'game', slug: decodeURIComponent(parts[1]) }
    return { name: 'games' }
  }
  if (parts[0] === 'config') return { name: 'config' }
  if (parts[0] === 'rotator') return { name: 'rotator' }
  if (parts[0] === 'oauth-consent' || parts[0] === 'login') return { name: 'oauth-consent' }
  if (parts[0] === 'admin') return { name: 'admin' }
  return { name: 'home' }
}

export function toPath(route: Route): string {
  switch (route.name) {
    case 'home': return '/'
    case 'dashboard': return '/dashboard'
    case 'games': return '/games'
    case 'game': return `/games/${encodeURIComponent(route.slug)}`
    case 'config': return '/config'
    case 'rotator': return '/rotator'
    case 'oauth-consent': return '/oauth-consent'
    case 'admin': return '/admin'
  }
}

// External pathname store — keeps SSR/client render consistent and avoids
// setState-inside-effect cascades flagged by the react-hooks lint rules.
// pushState does not fire popstate, so navigate() also dispatches a
// "tenx:navigate" event that subscribers listen for.
const pathStore = {
  subscribe(onChange: () => void) {
    window.addEventListener('popstate', onChange)
    window.addEventListener('tenx:navigate', onChange)
    return () => {
      window.removeEventListener('popstate', onChange)
      window.removeEventListener('tenx:navigate', onChange)
    }
  },
  getSnapshot(): string {
    return window.location.pathname
  },
  getServerSnapshot(): string {
    return '/'
  },
}

export function useRouter() {
  const pathname = useSyncExternalStore(pathStore.subscribe, pathStore.getSnapshot, pathStore.getServerSnapshot)
  const mounted = typeof window !== 'undefined' && pathname !== undefined

  const navigate = useCallback((next: Route) => {
    const to = toPath(next)
    if (window.location.pathname !== to) {
      window.history.pushState(null, '', to)
    }
    window.dispatchEvent(new Event('tenx:navigate'))
  }, [])

  return { route: parsePath(pathname), navigate, mounted }
}
