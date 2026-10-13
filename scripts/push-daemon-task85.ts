// Task 85 — push the Application-ID default rule to the Orihost 24/7 daemon.
// games.ts (isGameApplicationId helper) + rpc-manager.ts (guards on every
// normal-slot app-id resolution path) + rpc-daemon.ts (retired shell overlay).
// Normal RPCs now present under the user's custom Application ID or the 10X
// RPC application — game ids are Game-RPC-only. PLAIN TEXT body + exact-bytes
// verify, then restart and verify health.
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'

const PANEL = 'https://panel.orihost.com'
const KEY = 'ptlc_YrJhibr17CKcjvihtp60AChHs4xnvnUbMtkqYMsYUxx'
const SERVER = 'c726706f'
const LOCAL = '/home/z/my-project'

const FILES = [
  '/src/lib/games.ts',
  '/src/lib/rpc-manager.ts',
  '/src/lib/rpc-daemon.ts',
]

const hash = (s: string) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16)
const H = { Authorization: `Bearer ${KEY}`, Accept: 'application/json' }

async function main() {
  for (const FILE of FILES) {
    const content = fs.readFileSync(path.join(LOCAL, FILE), 'utf8')

    // 1. Write (plain text body — JSON envelope corrupts the file!)
    const w = await fetch(`${PANEL}/api/client/servers/${SERVER}/files/write?file=${encodeURIComponent(FILE)}`, {
      method: 'POST',
      headers: { ...H, 'Content-Type': 'text/plain' },
      body: content,
    })
    console.log(`WRITE ${FILE}: HTTP ${w.status}`)
    if (!w.ok && w.status !== 204) {
      console.error('WRITE FAILED:', (await w.text()).slice(0, 300))
      process.exit(1)
    }

    // 2. Verify exact bytes
    const r = await fetch(`${PANEL}/api/client/servers/${SERVER}/files/contents?file=${encodeURIComponent(FILE)}`, {
      headers: { ...H, Accept: 'text/plain' },
    })
    const remote = await r.text()
    const ok = remote === content
    console.log(`VERIFY ${FILE}: ${ok ? 'OK' : 'MISMATCH'} local=${hash(content)} remote=${hash(remote)}`)
    if (!ok) process.exit(1)
  }

  // 3. Restart the server (daemon boots, syncAllUsers reconnects everyone)
  const p = await fetch(`${PANEL}/api/client/servers/${SERVER}/power`, {
    method: 'POST',
    headers: { ...H, 'Content-Type': 'application/json' },
    body: JSON.stringify({ signal: 'restart' }),
  })
  console.log(`RESTART: HTTP ${p.status}`)

  // 4. Wait for boot then check public health endpoint
  console.log('waiting 25s for daemon boot...')
  await new Promise(res => setTimeout(res, 25000))
  for (let i = 0; i < 5; i++) {
    try {
      const res = await fetch('http://92.118.206.201:30250/health', { signal: AbortSignal.timeout(8000) })
      const j: any = await res.json().catch(() => ({}))
      console.log('HEALTH:', JSON.stringify(j).slice(0, 300))
      if (res.ok && j?.daemon?.connected > 0) {
        console.log('DAEMON LIVE — users reconnected')
        return
      }
    } catch (e: any) {
      console.log(`health attempt ${i + 1}: ${e.message}`)
    }
    await new Promise(res => setTimeout(res, 10000))
  }
  console.error('daemon did not report healthy in time — check panel console')
  process.exit(1)
}

main().catch(e => { console.error('fatal', e); process.exit(1) })
