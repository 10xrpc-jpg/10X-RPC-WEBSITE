// 10X RPC — /health — service health check and 24/7 daemon metrics
import { NextResponse } from 'next/server'
import { getRpcDaemon } from '@/lib/rpc-daemon'

export const dynamic = 'force-dynamic'

export async function GET() {
  const daemon = getRpcDaemon()
  const daemonStatus = daemon.getStatus()

  return NextResponse.json(
    {
      status: 'ok',
      service: '10x-rpc-backend',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      daemon: daemonStatus,
    },
    { status: 200 }
  )
}
