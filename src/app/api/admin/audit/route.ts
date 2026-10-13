// 10X RPC — GET /api/admin/audit — admin action history (admin only).
// Query params: action (prefix match), actorId, targetType, q (free text in
// targetLabel/reason), page, pageSize (max 100). Newest first.
import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { Prisma } from '@prisma/client'
import { requireAdmin } from '@/lib/admin-guard'

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  const { error } = await requireAdmin()
  if (error) return error

  const url = new URL(req.url)
  const action = (url.searchParams.get('action') || '').trim()
  const actorId = (url.searchParams.get('actorId') || '').trim()
  const targetType = (url.searchParams.get('targetType') || '').trim()
  const q = (url.searchParams.get('q') || '').trim()
  const page = Math.max(1, Math.round(Number(url.searchParams.get('page')) || 1))
  const pageSize = Math.min(100, Math.max(5, Math.round(Number(url.searchParams.get('pageSize')) || 25)))

  const where: Prisma.AuditLogWhereInput = {}
  if (action) where.action = { startsWith: action }
  if (actorId) where.actorId = actorId
  if (targetType) where.targetType = targetType
  if (q) {
    where.OR = [
      { targetLabel: { contains: q, mode: 'insensitive' } },
      { reason: { contains: q, mode: 'insensitive' } },
      { action: { contains: q, mode: 'insensitive' } },
      { actorName: { contains: q, mode: 'insensitive' } },
    ]
  }

  try {
    const [total, logs] = await Promise.all([
      db.auditLog.count({ where }),
      db.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ])
    return NextResponse.json({
      ok: true,
      page,
      pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
      logs: logs.map(l => ({
        id: l.id,
        action: l.action,
        actorId: l.actorId,
        actorName: l.actorName,
        targetType: l.targetType,
        targetId: l.targetId,
        targetLabel: l.targetLabel,
        beforeJson: l.beforeJson,
        afterJson: l.afterJson,
        reason: l.reason,
        outcome: l.outcome,
        createdAt: l.createdAt.toISOString(),
      })),
    })
  } catch (e) {
    console.error('[admin/audit] list failed:', e)
    return NextResponse.json({ error: 'unavailable', message: 'Could not load the audit log.' }, { status: 500 })
  }
}
