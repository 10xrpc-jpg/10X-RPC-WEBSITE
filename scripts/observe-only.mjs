import WebSocket from 'ws'
import { PrismaClient } from '@prisma/client'
const db = new PrismaClient()
const uid = 'cmuul9bp30001l404yzfhf5sj'
const session = await db.session.findFirst({ where: { userId: uid, discordAccessToken: { not: null } }, orderBy: { createdAt: 'desc' } })
const ws = new WebSocket('wss://gateway.gaming-sdk.com/?v=10&encoding=json')
let hb = null
ws.on('message', (raw) => {
  const p = JSON.parse(raw.toString())
  if (p.op === 10) {
    hb = setInterval(() => { try { ws.send(JSON.stringify({ op: 1, d: null })) } catch {} }, p.d.heartbeat_interval)
    ws.send(JSON.stringify({ op: 2, d: { token: `Bearer ${session.discordAccessToken}`, properties: { os: 'Windows', browser: 'Discord Client', device: 'Desktop' } } }))
  } else if (p.op === 0 && p.t === 'READY') {
    const agg = (p.d.sessions || []).find((s) => s.session_id === 'all')
    const acts = (agg?.activities || []).filter((a) => a.type !== 4)
    for (const a of acts) console.log(`aggregate activity: name="${a.name}" buttons=${JSON.stringify(a.buttons)} metadata=${JSON.stringify(a.metadata)} state="${a.state}" app=${a.application_id}`)
    if (!acts.length) console.log('aggregate: (no rich activity)')
    clearInterval(hb); setTimeout(() => process.exit(0), 500)
  }
})
setTimeout(() => process.exit(0), 15000)
