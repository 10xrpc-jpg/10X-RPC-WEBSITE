// 10X RPC — /api/weather — fetch weather for a city
import { NextResponse } from 'next/server'
import { fetchWeather } from '@/lib/weather'

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  const url = new URL(req.url)
  const city = url.searchParams.get('city')
  if (!city) return NextResponse.json({ error: 'city_required' }, { status: 400 })

  const info = await fetchWeather(city)
  if (!info) return NextResponse.json({ error: 'not_found' }, { status: 404 })

  return NextResponse.json(info)
}
