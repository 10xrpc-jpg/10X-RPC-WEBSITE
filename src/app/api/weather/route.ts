// 10X RPC — /api/weather — fetch weather for a city (authenticated users only:
// it proxies a third-party API whose free quota must not be burnable anonymously)
import { NextResponse } from 'next/server'
import { getSession } from '@/lib/session'
import { fetchWeather } from '@/lib/weather'

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'not_authenticated' }, { status: 401 })

  const url = new URL(req.url)
  const city = (url.searchParams.get('city') || '').slice(0, 100)
  if (!city) return NextResponse.json({ error: 'city_required' }, { status: 400 })

  const info = await fetchWeather(city)
  if (!info) return NextResponse.json({ error: 'not_found' }, { status: 404 })

  return NextResponse.json(info)
}
