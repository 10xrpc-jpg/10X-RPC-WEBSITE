// 10X RPC — /api/admin/razorpay — Payment Gateway credentials management.
//
// GET     → masked view of the resolved credentials (env vs DB override).
// PUT     → save an admin override (stored in PlatformSetting key "razorpay";
//           undefined fields keep their current value). Secret values are
//           never echoed back — responses show masked tails only.
// DELETE  → drop the DB override → fall back to the Vercel env vars.
//
// WHY: stale/invalid Razorpay keys on Vercel made Buy Now fail with
// "Could not start the payment" and only a redeploy could change them. This
// gives the admin a self-serve fix (and /test a live probe to verify keys
// before selling anything).
import { NextResponse } from 'next/server'
import { requireAdmin, writeAudit, adminRateLimited } from '@/lib/admin-guard'
import {
  getRazorpayKeys, maskedView, saveRazorpayOverride, resetRazorpayOverride, keyIdLooksValid,
} from '@/lib/razorpay-config'

export const dynamic = 'force-dynamic'

export async function GET() {
  const { session, error } = await requireAdmin()
  if (error) return error
  const { override, ...keys } = await getRazorpayKeys()
  return NextResponse.json({
    ok: true,
    ...maskedView(keys, override),
    webhookPath: '/api/subscription/webhook',
    checkedAt: new Date().toISOString(),
    actor: session.user.discordId,
  })
}

export async function PUT(request: Request) {
  const { session, error } = await requireAdmin()
  if (error) return error
  const limited = adminRateLimited(request, 'razorpay-save', 10, 60_000)
  if (limited) return limited

  let body: { keyId?: string; keySecret?: string; webhookSecret?: string } = {}
  try {
    body = (await request.json()) as typeof body
  } catch {
    return NextResponse.json({ error: 'bad_request', message: 'Invalid JSON body.' }, { status: 400 })
  }

  // Field presence semantics: a missing field keeps its stored value; an
  // empty string clears it. The UI only sends fields the admin touched.
  const patch: { keyId?: string; keySecret?: string; webhookSecret?: string } = {}
  if (body.keyId !== undefined) {
    const keyId = String(body.keyId).trim()
    if (keyId && !keyIdLooksValid(keyId)) {
      return NextResponse.json({
        error: 'invalid_key_id',
        message: 'Key Id must look like rzp_test_… or rzp_live_… (copy it from Razorpay Dashboard → Settings → API Keys).',
      }, { status: 400 })
    }
    patch.keyId = keyId
  }
  if (body.keySecret !== undefined) {
    const keySecret = String(body.keySecret).trim()
    if (keySecret && (keySecret.length < 8 || /\s/.test(keySecret))) {
      return NextResponse.json({ error: 'invalid_key_secret', message: 'Key Secret looks wrong — copy it exactly from the Razorpay dashboard (no spaces/newlines).' }, { status: 400 })
    }
    patch.keySecret = keySecret
  }
  if (body.webhookSecret !== undefined) {
    const webhookSecret = String(body.webhookSecret).trim()
    if (webhookSecret && /\s/.test(webhookSecret)) {
      return NextResponse.json({ error: 'invalid_webhook_secret', message: 'Webhook Secret must be a single token (no spaces/newlines).' }, { status: 400 })
    }
    patch.webhookSecret = webhookSecret
  }
  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: 'no_changes', message: 'Nothing to update — fill at least one field.' }, { status: 400 })
  }

  const before = (await getRazorpayKeys()).override ?? null
  try {
    const override = await saveRazorpayOverride(patch)
    await writeAudit({
      action: 'razorpay.config_update',
      actorId: session.user.discordId,
      actorName: session.user.username,
      targetType: 'platform',
      targetId: 'razorpay',
      targetLabel: 'Payment Gateway credentials',
      before: { keyId: before?.keyId || '(env)', updatedAt: before?.updatedAt || null },
      after: { keyId: override.keyId || '(env)', fields: Object.keys(patch), updatedAt: override.updatedAt },
    })
    const { override: fresh, ...keys } = await getRazorpayKeys()
    return NextResponse.json({ ok: true, ...maskedView(keys, fresh) })
  } catch (e) {
    console.error('[admin/razorpay] save failed:', e)
    await writeAudit({
      action: 'razorpay.config_update',
      actorId: session.user.discordId,
      actorName: session.user.username,
      targetType: 'platform',
      targetId: 'razorpay',
      outcome: 'error',
      reason: e instanceof Error ? e.message : 'save failed',
    })
    return NextResponse.json({ error: 'save_failed', message: 'Could not save the credentials — try again.' }, { status: 500 })
  }
}

export async function DELETE(request: Request) {
  const { session, error } = await requireAdmin()
  if (error) return error
  const limited = adminRateLimited(request, 'razorpay-reset', 10, 60_000)
  if (limited) return limited

  try {
    const before = (await getRazorpayKeys()).override
    await resetRazorpayOverride()
    await writeAudit({
      action: 'razorpay.config_reset',
      actorId: session.user.discordId,
      actorName: session.user.username,
      targetType: 'platform',
      targetId: 'razorpay',
      targetLabel: 'Payment Gateway credentials',
      before: { hadOverride: !!before, updatedAt: before?.updatedAt || null },
      after: { source: 'env' },
    })
    const { override, ...keys } = await getRazorpayKeys()
    return NextResponse.json({ ok: true, ...maskedView(keys, override) })
  } catch (e) {
    console.error('[admin/razorpay] reset failed:', e)
    return NextResponse.json({ error: 'reset_failed', message: 'Could not reset — try again.' }, { status: 500 })
  }
}
