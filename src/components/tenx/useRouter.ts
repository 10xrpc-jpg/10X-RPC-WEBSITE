// 10X RPC — hash router hook
'use client'
import { useState, useEffect, useCallback } from 'react'

export type Route = 
  | { name: 'home' }
  | { name: 'dashboard' }
  | { name: 'games' }
  | { name: 'game', slug: string }
  | { name: 'config' }
  | { name: 'rotator' }
  | { name: 'oauth-consent' }
  | { name: 'admin' }

export function parseHash(hash: string): Route {
  const clean = hash.replace(/^#\/?/, '').trim()
  if (!clean) return { name: 'home' }
  const parts = clean.split('/')
  if (parts[0] === 'dashboard') return { name: 'dashboard' }
  if (parts[0] === 'games') {
    if (parts[1]) return { name: 'game', slug: parts[1] }
    return { name: 'games' }
  }
  if (parts[0] === 'config') return { name: 'config' }
  if (parts[0] === 'rotator') return { name: 'rotator' }
  if (parts[0] === 'oauth-consent' || parts[0] === 'login') return { name: 'oauth-consent' }
  if (parts[0] === 'admin') return { name: 'admin' }
  return { name: 'home' }
}

export function toHash(route: Route): string {
  switch (route.name) {
    case 'home': return '#/'
    case 'dashboard': return '#/dashboard'
    case 'games': return '#/games'
    case 'game': return `#/games/${route.slug}`
    case 'config': return '#/config'
    case 'rotator': return '#/rotator'
    case 'oauth-consent': return '#/oauth-consent'
    case 'admin': return '#/admin'
  }
}

export function useRouter() {
  const [route, setRoute] = useState<Route>(() => parseHash(
    typeof window === 'undefined' ? '' : window.location.hash
  ))

  useEffect(() => {
    const onHashChange = () => setRoute(parseHash(window.location.hash))
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])

  const navigate = useCallback((next: Route) => {
    window.location.hash = toHash(next)
  }, [])

  return { route, navigate }
}
