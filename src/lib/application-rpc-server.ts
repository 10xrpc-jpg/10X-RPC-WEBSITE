// 10X RPC — Application RPC server-side row helpers (website-only).
// The standalone daemon never imports this module (it uses raw SQL); these
// typed Prisma helpers run exclusively inside the Next.js routes.
import { db } from '@/lib/db'
import { serializeApplicationRpc, type ApplicationRpcView } from '@/lib/application-rpc'

/** Load the user's Application RPC row, creating the default row when absent
 *  (same lazy-create convention /api/me uses for RPC slot 1). Creating an
 *  idle row never touches any other RPC system. */
export async function ensureApplicationRpcRow(userId: string) {
  const existing = await db.applicationRpcConfig.findUnique({ where: { userId } })
  if (existing) return existing
  try {
    return await db.applicationRpcConfig.create({
      data: {
        userId,
        name: '10X RPC',
        type: 'PLAYING',
        // DEVICE-SELECTION RULE — a fresh row has NO device: the selector's
        // "None". Nothing may be auto-selected (the old 'meta_quest' default
        // stamped a VR badge the user never picked).
        platform: 'desktop',
        startMinsAgo: 0,
        enabled: false,
        runState: 'idle',
      },
    })
  } catch {
    // Concurrent create race → re-read.
    const row = await db.applicationRpcConfig.findUnique({ where: { userId } })
    if (!row) throw new Error('application_rpc_row_unavailable')
    return row
  }
}

export function serializeApplicationRpcRow(row: Record<string, unknown>): ApplicationRpcView {
  return serializeApplicationRpc(row)
}
