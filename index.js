// 10X RPC — Orihost / Pterodactyl 24/7 Backend Server Entrypoint
require('dotenv').config()
const { spawn, execSync } = require('child_process')
const http = require('http')

const PORT = process.env.SERVER_PORT || process.env.PORT || 3000

console.log('==============================================')
console.log('   🚀 10X RPC 24/7 Gateway Backend Server     ')
console.log('==============================================')

// 1. HTTP health check server for Pterodactyl / Orihost monitoring
const server = http.createServer((req, res) => {
  if (req.url === '/health' || req.url === '/') {
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    })
    res.end(JSON.stringify({
      status: 'ok',
      service: '10x-rpc-gateway-daemon',
      uptime: Math.floor(process.uptime()),
      timestamp: new Date().toISOString()
    }))
  } else {
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'not_found' }))
  }
})

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[10X RPC Server] HTTP Health check listening on 0.0.0.0:${PORT}`)
})

// 2. Ensure Prisma Client is generated
console.log('[10X RPC Server] Initializing Prisma ORM...')
try {
  execSync('npx prisma generate', { stdio: 'inherit' })
  console.log('[10X RPC Server] Prisma Client ready.')
} catch (err) {
  console.warn('[10X RPC Server] Prisma generate warning:', err.message)
}

// 3. Spawn the standalone 24/7 RPC daemon
console.log('[10X RPC Server] Launching 24/7 Discord RPC & Status Daemon...')

function startDaemon() {
  const daemon = spawn('npx', ['tsx', 'scripts/rpc-daemon-standalone.ts'], {
    stdio: 'inherit',
    env: process.env
  })

  daemon.on('close', (code) => {
    console.error(`[10X RPC Server] Daemon exited with code ${code}. Restarting in 5s...`)
    setTimeout(startDaemon, 5000)
  })

  daemon.on('error', (err) => {
    console.error('[10X RPC Server] Daemon failed to start:', err.message)
  })

  return daemon
}

const activeDaemon = startDaemon()

// Graceful shutdown handling
process.on('SIGINT', () => {
  console.log('[10X RPC Server] Received SIGINT. Shutting down...')
  server.close()
  if (activeDaemon) activeDaemon.kill('SIGINT')
  process.exit(0)
})

process.on('SIGTERM', () => {
  console.log('[10X RPC Server] Received SIGTERM. Shutting down...')
  server.close()
  if (activeDaemon) activeDaemon.kill('SIGTERM')
  process.exit(0)
})
