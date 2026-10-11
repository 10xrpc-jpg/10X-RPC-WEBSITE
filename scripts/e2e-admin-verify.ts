// 10X RPC — E2E admin/subscription verification suite (read-mostly; restores state).
// Usage: bun scripts/e2e-admin-verify.ts   (dev server must be on :3000)
import { readFileSync } from 'fs'

// Force-override shell DATABASE_URL pollution from .env.local
for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_0-9]+)=(.*)$/)
  if (m) process.env[m[1]] = m[2]
}

const BASE = 'http://localhost:3000'
const COOKIE = '10x_rpc_session'
const DAY = 24 * 60 * 60 * 1000

let pass = 0
let fail = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail = '') {
  if (cond) {
    pass++
    console.log(`PASS ${name}`)
  } else {
    fail++
    failures.push(name + (detail ? ` — ${detail}` : ''))
    console.log(`FAIL ${name}${detail ? ' — ' + detail : ''}`)
  }
}

function adminHeaders(token: string) {
  return { 'Content-Type': 'application/json', Cookie: `${COOKIE}=${token}` }
}
async function adminFetch(token: string, path: string, init?: RequestInit) {
  const res = await fetch(BASE + path, { ...init, headers: { ...adminHeaders(token), ...(init?.headers ?? {}) } })
  const json = await res.json().catch(() => ({}))
  return { status: res.status, json }
}

const { PrismaClient } = await import('@prisma/client')
const db = new PrismaClient()

async function main() {
  // ---------- 0. sessions ----------
  const { execSync } = await import('child_process')
  const mintOut = execSync('bun scripts/mint-admin-session.ts', { encoding: 'utf8', env: process.env })
  const adminToken = (mintOut.match(/TOKEN=(\S+)/) ?? [])[1]
  check('admin session minted', !!adminToken)

  const demoRes = await fetch(BASE + '/api/demo-login', { method: 'POST' })
  const demoJson = await demoRes.json().catch(() => ({}))
  const demoToken = demoJson.sessionToken as string | undefined
  check('demo session minted', !!demoToken)
  if (!adminToken || !demoToken) throw new Error('no sessions')

  const demoUser = await db.user.findUnique({
    where: { discordId: 'demo-user-10x' },
    include: { subscription: true },
  })
  if (!demoUser?.subscription) throw new Error('demo user/subscription missing')
  const U = demoUser.id
  const demoSubOriginal = JSON.parse(JSON.stringify(demoUser.subscription)) as {
    plan: string; status: string; trialEndsAt: string | null; currentPeriodEnd: string | null
    suspendedAt: string | null; trialUsed: boolean
  }

  const H = adminHeaders(adminToken)
  const DH = { 'Content-Type': 'application/json', Cookie: `${COOKIE}=${demoToken}` }

  // ---------- 1. guards ----------
  const guardPaths = [
    '/api/admin/stats', '/api/admin/plans', '/api/admin/trial-config',
    '/api/admin/subscriptions', '/api/admin/analytics', '/api/admin/audit',
    '/api/admin/payments',
  ]
  for (const p of guardPaths) {
    const r = await fetch(BASE + p)
    check(`guard 401 unauth ${p}`, r.status === 401)
  }
  const adjustUn = await fetch(BASE + '/api/admin/subscriptions/adjust', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  })
  check('guard 401 unauth adjust', adjustUn.status === 401)

  for (const p of ['/api/admin/plans', '/api/admin/analytics', '/api/admin/audit', '/api/admin/subscriptions']) {
    const r = await fetch(BASE + p, { headers: DH })
    check(`guard 403 non-admin ${p}`, r.status === 403)
  }
  const adjustForbidden = await fetch(BASE + '/api/admin/subscriptions/adjust', {
    method: 'POST', headers: DH,
    body: JSON.stringify({ userId: demoUser.id, action: 'add_days', days: 5, reason: 'self upgrade attempt' }),
  })
  check('user cannot self-adjust subscription (403)', adjustForbidden.status === 403)

  // ---------- 2. plans CRUD ----------
  const plansGet = await adminFetch(adminToken, '/api/admin/plans')
  check('admin plans list 200', plansGet.status === 200)
  const planArr: Array<Record<string, unknown>> = plansGet.json.plans ?? plansGet.json
  check('seeded plans present (plus+pro)', planArr.some(p => p.slug === 'plus') && planArr.some(p => p.slug === 'pro'))
  const plusRow = planArr.find(p => p.slug === 'plus')
  check('plan stats attached (subscribers/paidCount/revenuePaise)',
    plusRow != null && 'subscribers' in plusRow && 'paidCount' in plusRow && 'revenuePaise' in plusRow)

  const slug = `e2e-verify-${Date.now().toString(36)}`
  const createRes = await adminFetch(adminToken, '/api/admin/plans', {
    method: 'POST',
    body: JSON.stringify({
      slug, name: 'E2E Verify Plan', description: 'temporary', amount: 12300,
      originalAmount: 24900, durationDays: 45, badge: 'TEST',
      features: ['feature a', 'feature b'], active: true, visible: true, displayOrder: 9,
    }),
  })
  check('plan create 200', createRes.status === 200, JSON.stringify(createRes.json).slice(0, 120))
  const createdId = createRes.json.plan?.id as string | undefined
  check('plan create returns id', !!createdId)

  const dupRes = await adminFetch(adminToken, '/api/admin/plans', {
    method: 'POST',
    body: JSON.stringify({ slug, name: 'dup', amount: 100, durationDays: 3 }),
  })
  check('duplicate slug rejected', dupRes.status >= 400 && dupRes.status < 500)
  const invalidRes = await adminFetch(adminToken, '/api/admin/plans', {
    method: 'POST',
    body: JSON.stringify({ slug: slug + '-bad', name: 'x', amount: -5, durationDays: 3 }),
  })
  check('negative amount rejected', invalidRes.status === 400 || invalidRes.status === 422)

  const patchRes = await adminFetch(adminToken, `/api/admin/plans/${createdId}`, {
    method: 'PATCH',
    body: JSON.stringify({ name: 'E2E Renamed', amount: 9900, badge: 'RENAMED', reason: 'e2e patch' }),
  })
  check('plan PATCH 200 + applied', patchRes.status === 200 && patchRes.json.plan?.name === 'E2E Renamed' && patchRes.json.plan?.amount === 9900)

  const hideRes = await adminFetch(adminToken, `/api/admin/plans/${createdId}`, {
    method: 'PATCH', body: JSON.stringify({ visible: false, reason: 'e2e hide' }),
  })
  check('plan hide 200', hideRes.status === 200)
  const pubHidden = await fetch(BASE + '/api/plans').then(r => r.json())
  const pubSlugs = (pubHidden.plans ?? []).map((p: { slug: string }) => p.slug)
  check('hidden plan not on public /api/plans', !pubSlugs.includes(slug))
  const pubHasTrial = pubHidden.trial != null || pubHidden.trialCard != null || pubHidden.trialPolicy != null
  check('public /api/plans includes trial card/policy', pubHasTrial, JSON.stringify(Object.keys(pubHidden)))

  const delRes = await adminFetch(adminToken, `/api/admin/plans/${createdId}`, { method: 'DELETE' })
  check('unused plan DELETE 200', delRes.status === 200)

  // In-use guard: point a scratch subscription at the scratch slug, then DELETE → 409.
  // NEVER deletes seeded production plans (plus/pro) — only the e2e scratch plan.
  await db.subscription.update({ where: { userId: U }, data: { plan: slug, status: 'active', currentPeriodEnd: new Date(Date.now() + DAY) } })
  const scratchPlan = await db.plan.findUnique({ where: { slug } })
  if (scratchPlan) {
    const delInUse = await adminFetch(adminToken, `/api/admin/plans/${scratchPlan.id}`, { method: 'DELETE' })
    check('in-use plan DELETE rejected (409/archive hint)', delInUse.status === 409 || delInUse.status === 400,
      `got ${delInUse.status}`)
  }
  await db.subscription.update({ where: { userId: U }, data: { plan: 'free', status: 'trialing', currentPeriodEnd: null } })

  // ---------- 3. trial config ----------
  const tcGet = await adminFetch(adminToken, '/api/admin/trial-config')
  check('trial config GET 200', tcGet.status === 200)
  const originalTrial = JSON.parse(JSON.stringify(tcGet.json.config)) as {
    enabled: boolean; days: number; name?: string; description?: string; features?: string[]; allowRepeat?: boolean
  }
  check('trial config has policy fields', typeof originalTrial.enabled === 'boolean' && typeof originalTrial.days === 'number')

  // days=0 is a SUPPORTED value (= trials disabled); clamp window is 0–90.
  const tcZero = await adminFetch(adminToken, '/api/admin/trial-config', {
    method: 'PUT', body: JSON.stringify({ days: 0, reason: 'e2e disable-by-zero' }),
  })
  check('trial config days=0 accepted (=disabled)', tcZero.status === 200 && tcZero.json.config?.days === 0)
  const tcBad = await adminFetch(adminToken, '/api/admin/trial-config', {
    method: 'PUT', body: JSON.stringify({ days: 'abc', reason: 'e2e non-numeric' }),
  })
  check('non-numeric days keeps previous value', tcBad.status === 200 && tcBad.json.config?.days === 0)
  const tcPut = await adminFetch(adminToken, '/api/admin/trial-config', {
    method: 'PUT',
    body: JSON.stringify({ days: 7, name: 'E2E Trial', features: ['trial f1'], reason: 'e2e set 7d' }),
  })
  check('trial config PUT 200', tcPut.status === 200)
  const tcAfter = await adminFetch(adminToken, '/api/admin/trial-config')
  const afterTrial = tcAfter.json.trial ?? tcAfter.json
  check('trial config persisted (7d)', (afterTrial.days ?? afterTrial.config?.days) === 7)
  // restore
  await adminFetch(adminToken, '/api/admin/trial-config', {
    method: 'PUT',
    body: JSON.stringify({
      days: originalTrial.days, name: originalTrial.name, description: originalTrial.description,
      features: originalTrial.features, allowRepeat: originalTrial.allowRepeat, reason: 'e2e restore',
    }),
  })

  // ---------- 4. subscriptions list ----------
  const subsAll = await adminFetch(adminToken, '/api/admin/subscriptions')
  check('subscriptions list 200', subsAll.status === 200)
  const rows: Array<Record<string, unknown>> = subsAll.json.users ?? []
  check('subscriptions summary block', typeof subsAll.json.summary === 'object' && subsAll.json.summary != null)
  check('subscriptions rows carry view+payment', rows.length > 0 && ('subscription' in rows[0]))

  const demoNameQ = encodeURIComponent(demoUser.username)
  const subsQ = await adminFetch(adminToken, `/api/admin/subscriptions?q=${demoNameQ}`)
  check('search by username finds demo', (subsQ.json.users ?? []).some((u: Record<string, unknown>) => u.id === demoUser.id))
  const subsStatus = await adminFetch(adminToken, '/api/admin/subscriptions?status=trialing')
  check('status=trialing filter', (subsStatus.json.users ?? []).every((u: Record<string, unknown>) => {
    const s = u.subscription as Record<string, unknown>
    return s.status === 'trialing' || s.rawStatus === 'trialing'
  }))
  const subsSort = await adminFetch(adminToken, '/api/admin/subscriptions?sort=expiry&pageSize=50')
  check('sort=expiry 200', subsSort.status === 200)
  const subsPage = await adminFetch(adminToken, '/api/admin/subscriptions?page=1&pageSize=5')
  check('pagination pageSize honored', (subsPage.json.users ?? []).length <= 5)

  // ---------- 5. user detail ----------
  const detail = await adminFetch(adminToken, `/api/admin/users/${demoUser.id}`)
  check('user detail 200', detail.status === 200)
  check('user detail has subscription+payments+audits+plans',
    detail.json.subscription != null && Array.isArray(detail.json.payments)
    && Array.isArray(detail.json.audits) && Array.isArray(detail.json.plans))

  // ---------- 6. adjust — validation ----------
  async function adj(body: Record<string, unknown>) {
    return adminFetch(adminToken, '/api/admin/subscriptions/adjust', {
      method: 'POST', body: JSON.stringify({ userId: U, ...body }),
    })
  }
  const noReason = await adj({ action: 'add_days', days: 3 })
  check('adjust without reason → 400', noReason.status === 400)
  const shortReason = await adj({ action: 'add_days', days: 3, reason: 'no' })
  check('adjust 2-char reason → 400', shortReason.status === 400)
  const negDays = await adj({ action: 'add_days', days: -5, reason: 'e2e negative' })
  check('negative days → 422', negDays.status === 422)
  const zeroDays = await adj({ action: 'add_days', days: 0, reason: 'e2e zero' })
  check('zero days → 422', zeroDays.status === 422)
  const badAction = await adj({ action: 'hack', reason: 'e2e bad action' })
  check('unknown action → 400', badAction.status === 400)
  const badDate = await adj({ action: 'set_expiry', date: 'not-a-date', reason: 'e2e bad date' })
  check('invalid expiry date → 422', badDate.status === 422)
  const unknownUser = await adminFetch(adminToken, '/api/admin/subscriptions/adjust', {
    method: 'POST', body: JSON.stringify({ userId: 'nonexistent-id', action: 'add_days', days: 3, reason: 'e2e' }),
  })
  check('unknown user → 404', unknownUser.status === 404)

  // ---------- 7. adjust — lifecycle on demo (fresh 3d trial) ----------
  // normalize to fresh 3d trialing first
  await db.subscription.update({
    where: { userId: U },
    data: {
      plan: 'free', status: 'trialing', trialEndsAt: new Date(Date.now() + 3 * DAY),
      currentPeriodEnd: null, suspendedAt: null, trialUsed: false,
    },
  })
  await db.user.update({ where: { id: U }, data: { adminNote: null } })

  const add5 = await adj({ action: 'add_days', days: 5, reason: 'e2e +5d' })
  check('add_days 5 → 8d left', add5.status === 200 && Math.round(
    ((new Date(add5.json.subscription.trialEndsAt).getTime()) - Date.now()) / DAY) === 8,
  JSON.stringify(add5.json.subscription?.trialEndsAt))

  const stale = await adj({ action: 'add_days', days: 1, reason: 'e2e stale', expectedUpdatedAt: '2020-01-01T00:00:00.000Z' })
  check('stale expectedUpdatedAt → 409', stale.status === 409)

  const fresh = await adminFetch(adminToken, `/api/admin/users/${U}`)
  const freshUpdatedAt = fresh.json.subscription?.updatedAt as string
  const conflictFree = await adj({ action: 'add_days', days: 1, reason: 'e2e fresh ts', expectedUpdatedAt: freshUpdatedAt })
  check('fresh expectedUpdatedAt passes (no 409)', conflictFree.status === 200, `got ${conflictFree.status}`)

  // NOTE: 8d after add_days 5, +1d from the fresh-ts conflict test → 9d; −2 → 7d.
  const sub2 = await adj({ action: 'subtract_days', days: 2, reason: 'e2e -2d' })
  check('subtract_days 2 → 7d left', sub2.status === 200 && Math.round(
    ((new Date(sub2.json.subscription.trialEndsAt).getTime()) - Date.now()) / DAY) === 7)

  const setExp = await adj({ action: 'set_expiry', date: new Date(Date.now() + 20 * DAY).toISOString(), reason: 'e2e set expiry' })
  check('set_expiry future → 20d trialing', setExp.status === 200 && Math.round(
    ((new Date(setExp.json.subscription.trialEndsAt).getTime()) - Date.now()) / DAY) === 20)

  const setStart = await adj({ action: 'set_start', date: new Date(Date.now() - 10 * DAY).toISOString(), reason: 'e2e set start' })
  const startInDb = await db.subscription.findUnique({ where: { userId: U } })
  check('set_start applied (db)', setStart.status === 200 && startInDb != null
    && Math.abs(startInDb.createdAt.getTime() - (Date.now() - 10 * DAY)) < 5000)

  const setPlan = await adj({ action: 'set_plan', plan: 'plus', reason: 'e2e set plan' })
  check('set_plan plus keeps dates', setPlan.status === 200 && setPlan.json.subscription.plan === 'plus'
    && setPlan.json.subscription.status === 'trialing')

  const setLifetime = await adj({ action: 'set_plan', plan: 'lifetime', reason: 'e2e set lifetime' })
  check('set_plan lifetime → active, no period end',
    setLifetime.status === 200 && setLifetime.json.subscription.plan === 'lifetime'
    && setLifetime.json.subscription.status === 'active'
    && setLifetime.json.subscription.currentPeriodEnd == null)
  const ltAdd = await adj({ action: 'add_days', days: 5, reason: 'e2e lifetime add' })
  check('lifetime add_days rejected', ltAdd.status === 422)

  const grantTrial = await adj({ action: 'grant_trial', days: 5, reason: 'e2e grant trial' })
  const trialInDb = await db.subscription.findUnique({ where: { userId: U } })
  check('grant_trial 5d → trialing, trialUsed (db)', grantTrial.status === 200
    && grantTrial.json.subscription.status === 'trialing' && trialInDb?.trialUsed === true)

  const suspend = await adj({ action: 'suspend', reason: 'e2e suspend' })
  check('suspend → suspended (dates preserved)', suspend.status === 200
    && suspend.json.subscription.status === 'suspended'
    && suspend.json.subscription.trialEndsAt != null)

  const suspAdd = await adj({ action: 'add_days', days: 5, reason: 'e2e suspended add' })
  check('suspended add_days → 422 (explicit renewal required)', suspAdd.status === 422)

  const reactivate = await adj({ action: 'reactivate', reason: 'e2e reactivate' })
  check('reactivate with time → trialing', reactivate.status === 200 && reactivate.json.subscription.status === 'trialing')

  const expireNow = await adj({ action: 'expire_now', reason: 'e2e expire now' })
  check('expire_now → suspended, end ≈ now', expireNow.status === 200
    && expireNow.json.subscription.status === 'suspended')

  const reactivateExpired = await adj({ action: 'reactivate', reason: 'e2e reactivate expired' })
  check('reactivate expired → 422', reactivateExpired.status === 422)

  const grantPlan = await adj({ action: 'grant_plan', plan: 'plus', reason: 'e2e grant plus (DB duration)' })
  const gpEnd = grantPlan.json.subscription?.currentPeriodEnd
  check('grant_plan lifts suspension, DB duration (30d)', grantPlan.status === 200
    && grantPlan.json.subscription.status === 'active' && grantPlan.json.subscription.plan === 'plus'
    && Math.round((new Date(gpEnd).getTime() - Date.now()) / DAY) === 30, `end=${gpEnd}`)

  const stack = await adj({ action: 'grant_plan', plan: 'plus', days: 10, reason: 'e2e stack 10d' })
  check('grant_plan stacks on active period (+10d → 40d)', stack.status === 200 && Math.round(
    ((new Date(stack.json.subscription.currentPeriodEnd).getTime()) - Date.now()) / DAY) === 40)

  const clearExp = await adj({ action: 'clear_expiry', reason: 'e2e clear expiry' })
  check('clear_expiry → never expires', clearExp.status === 200 && clearExp.json.subscription.currentPeriodEnd == null)
  const clearSuspended = await adj({ action: 'suspend', reason: 'e2e suspend 2' })
    .then(r => adj({ action: 'clear_expiry', reason: 'e2e clear while suspended' }))
  check('clear_expiry while suspended → 422', clearSuspended.status === 422)

  const cancel = await adj({ action: 'cancel', reason: 'e2e cancel' })
  check('cancel → suspended', cancel.status === 200 && cancel.json.subscription.status === 'suspended')

  const note = await adj({ action: 'add_note', note: 'e2e internal note', reason: 'e2e note' })
  check('add_note ok', note.status === 200)
  const noteInDb = await db.user.findUnique({ where: { id: U } })
  check('note persisted on user', noteInDb?.adminNote === 'e2e internal note')

  // ---------- 8. analytics ----------
  const an = await adminFetch(adminToken, '/api/admin/analytics')
  check('analytics 200', an.status === 200)
  const s = an.json.subscriptions ?? {}
  check('analytics lifecycle split present',
    ['total', 'trialing', 'active', 'suspended', 'expired', 'expiring7d', 'expiring30d'].every(k => typeof s[k] === 'number'))
  check('analytics conversion block', typeof an.json.conversion?.rate === 'number')
  check('analytics revenue block', typeof an.json.revenue?.allTimePaise === 'number')
  check('analytics plan popularity', an.json.planPopularity != null)
  // cross-check active count against DB
  const activeDb = await db.subscription.count({ where: { status: 'active' } })
  check('analytics active == DB active', s.active === activeDb, `api=${s.active} db=${activeDb}`)
  const revDb = await db.payment.aggregate({ where: { status: 'paid' }, _sum: { amount: true } })
  check('analytics revenue == DB paid sum', an.json.revenue.allTimePaise === (revDb._sum.amount ?? 0))

  // ---------- 9. audit ----------
  const au = await adminFetch(adminToken, '/api/admin/audit?action=subscription.add_days')
  const auditRows: Array<Record<string, unknown>> = au.json.logs ?? []
  check('audit filter by action', au.status === 200 && auditRows.length >= 2)
  check('audit rows carry reason+actor', auditRows.length > 0 && auditRows.every(r => typeof r.reason === 'string' && !!r.actorId))
  check('audit failed attempts recorded (outcome=error rows)', auditRows.some(r => r.outcome === 'error'))
  const auTarget = await adminFetch(adminToken, `/api/admin/audit?targetType=plan`)
  check('audit targetType filter', auTarget.status === 200 && (auTarget.json.logs ?? []).length >= 1)

  // ---------- 10. cleanup (restore demo user exactly) ----------
  await db.subscription.update({
    where: { userId: U },
    data: {
      plan: demoSubOriginal.plan, status: demoSubOriginal.status,
      trialEndsAt: demoSubOriginal.trialEndsAt ? new Date(demoSubOriginal.trialEndsAt) : null,
      currentPeriodEnd: demoSubOriginal.currentPeriodEnd ? new Date(demoSubOriginal.currentPeriodEnd) : null,
      suspendedAt: demoSubOriginal.suspendedAt ? new Date(demoSubOriginal.suspendedAt) : null,
      trialUsed: demoSubOriginal.trialUsed,
    },
  })
  await db.user.update({ where: { id: U }, data: { adminNote: null } })
  await db.session.deleteMany({ where: { user: { discordId: 'demo-user-10x' }, token: { not: demoToken } } })
  const orphanPlans = await db.plan.findMany({ where: { slug: { startsWith: 'e2e-verify' } } })
  for (const p of orphanPlans) {
    const refd = await db.subscription.count({ where: { plan: p.slug } }) + await db.payment.count({ where: { plan: p.slug } })
    if (refd === 0) await db.plan.delete({ where: { id: p.id } })
  }
  await db.auditLog.deleteMany({ where: { OR: [{ reason: { startsWith: 'e2e' } }, { reason: { startsWith: 'e2e ' } }] } })

  // Canary: seeded plans must still exist after the whole run.
  const canary = await db.plan.findMany({ where: { slug: { in: ['plus', 'pro'] } } })
  check('CANARY: seeded plans (plus+pro) intact after suite', canary.length === 2)

  console.log(`\n===== E2E RESULT: ${pass} passed, ${fail} failed =====`)
  if (failures.length) {
    console.log('FAILURES:')
    failures.forEach(f => console.log(' - ' + f))
  }
  await db.$disconnect()
  process.exit(fail ? 1 : 0)
}

main().catch(async e => {
  console.error('SUITE ERROR:', e)
  await db.$disconnect().catch(() => {})
  process.exit(2)
})
