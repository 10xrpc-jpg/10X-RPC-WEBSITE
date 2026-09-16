// 10X RPC — single-page app with hash-based routing
'use client'
import { useEffect, useState } from 'react'
import { useRouter } from '@/components/tenx/useRouter'
import { LandingPage } from '@/components/tenx/LandingPage'
import { DashboardPage } from '@/components/tenx/DashboardPage'
import { GamesPage } from '@/components/tenx/GamesPage'
import { GameConfigPage } from '@/components/tenx/GameConfigPage'
import { GlobalConfigPage } from '@/components/tenx/GlobalConfigPage'
import { StatusRotatorPage } from '@/components/tenx/StatusRotatorPage'
import { OAuthConsentPage } from '@/components/tenx/OAuthConsentPage'
import { AdminPage } from '@/components/tenx/AdminPage'
import { api, type Me } from '@/lib/api-client'

export default function Home() {
  const { route } = useRouter()
  const [me, setMe] = useState<Me | null>(null)

  // Preload me for routes that need it
  useEffect(() => {
    api.me().then(setMe).catch(() => {})
  }, [route.name])

  // Close any open dropdown when route changes
  useEffect(() => {
    const onClick = () => {}
    document.addEventListener('click', onClick)
    return () => document.removeEventListener('click', onClick)
  }, [route.name])

  if (route.name === 'home') return <LandingPage />
  if (route.name === 'oauth-consent') return <OAuthConsentPage />
  if (route.name === 'dashboard') return <DashboardPage />
  if (route.name === 'admin') return <AdminPage />
  if (route.name === 'games') return <GamesPage />
  if (route.name === 'game') return <GameConfigPage slug={route.slug} />
  if (route.name === 'config') {
    return (
      <GlobalConfigPage
        initialCity={me?.globalConfig?.city}
        initialTimezone={me?.globalConfig?.timezone}
      />
    )
  }
  if (route.name === 'rotator') {
    return <StatusRotatorPage initial={me || undefined} />
  }
  return <LandingPage />
}
