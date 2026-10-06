// 10X RPC — Live wire-format test for OP 3 activity buttons.
// Sends buttons as OBJECTS (current builder) vs STRINGS (expected wire format)
// and reads back what Discord actually stores, via a fresh observer connection.
import WebSocket from 'ws'
import { PrismaClient } from '@prisma/client'
import fs from 'fs'

const db = new PrismaClient()
const mode = process.argv[2] || 'object' // 'object' | 'string' | 'none'
const uid = process.argv[3] || 'cmuul9bp30001l404yzfhf5sj'

// load .env manually (platform may override env)
if (!process.env.DISCORD_CLIENT_ID) {
  try {
    for (const line of fs.readFileSync('/home/z/my-project/.env', 'utf8').split('\n')) {
      const m = line.match(/^([A-Z_]+)=(.*)$/)
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim()
    }
  } catch {}
}

const session = await db.session.findFirst({
  where: { userId: uid, discordAccessToken: { not: null } },
  orderBy: { createdAt: 'desc' },
})
const token = session?.discordAccessToken
if (!token) { console.error('no token'); process.exit(1) }
const APP_ID = process.env.DISCORD_CLIENT_ID

function connect(label) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket('wss://gateway.gaming-sdk.com/?v=10&encoding=json')
    let hb = null
    const to = setTimeout(() => reject(new Error(label + ' timeout')), 15000)
    ws.on('open', () => console.log(`[${label}] connected`))
    ws.on('error', (e) => { console.error(`[${label}] error:`, e.message) })
    ws.on('close', (code, reason) => {
      console.log(`[${label}] closed code=${code} reason=${reason?.toString?.() || ''}`)
      clearInterval(hb)
    })
    ws.on('message', (raw) => {
      const p = JSON.parse(raw.toString())
      if (p.op === 10) {
        hb = setInterval(() => { try { ws.send(JSON.stringify({ op: 1, d: null })) } catch {} }, p.d.heartbeat_interval)
        ws.send(JSON.stringify({ op: 2, d: { token: `Bearer ${token}`, properties: { os: 'Windows', browser: 'Discord Client', device: 'Desktop' } } }))
      } else if (p.op === 0 && p.t === 'READY') {
        clearTimeout(to)
        resolve({ ws, sessions: p.d.sessions || [] })
      } else if (p.t === 'SESSIONS_REPLACE') {
        const agg = (p.d.sessions || []).find((s) => s.session_id === 'all')
        const acts = (agg?.activities || []).filter((a) => a.type !== 4)
        console.log(`[${label}] SESSIONS_REPLACE aggregate activities:`, JSON.stringify(acts, null, 1))
      }
    })
  })
}

function dumpReady(label, sessions) {
  console.log(`\n[${label}] READY snapshot:`)
  for (const s of sessions) {
    if (s.session_id === 'all') {
      const acts = (s.activities || []).filter((a) => a.type !== 4)
      console.log(`  AGGREGATE: ${acts.length ? JSON.stringify(acts, null, 1) : '(no rich activity)'}`)
    }
  }
}

// --- Step 1: sender connection ---
const sender = await connect('sender')
dumpReady('sender', sender.sessions)

const base = {
  type: 0,
  name: '10X RPC',
  application_id: APP_ID,
  platform: 'desktop',
  state: 'wire-format-test',
  details: `buttons mode: ${mode}`,
}
if (mode === 'object') {
  base.buttons = [{ label: 'BtnObjTest', url: 'https://example.com/btnobj' }]
  base.metadata = { button_urls: ['https://example.com/btnobj'] }
} else if (mode === 'string') {
  base.buttons = ['BtnStrTest']
  base.metadata = { button_urls: ['https://example.com/btnstr'] }
}

console.log(`\n[sender] sending OP 3 (mode=${mode}):`, JSON.stringify(base))
sender.ws.send(JSON.stringify({ op: 3, d: { status: 'online', activities: [base], afk: false, since: null } }))

await new Promise((r) => setTimeout(r, 4000))

// --- Step 2: observer connection (fresh READY = what Discord stored) ---
try {
  const obs = await connect('observer')
  dumpReady('observer', obs.sessions)
  setTimeout(() => { try { obs.ws.close() } catch {} ; process.exit(0) }, 2500)
} catch (e) {
  console.error('observer failed:', e.message)
  process.exit(1)
}
