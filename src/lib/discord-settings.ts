// 10X RPC — Discord ACCOUNT-level status control (the "Online/Idle/DND not
// working" fix, Task 97).
//
// WHY THIS EXISTS — live-verified 2026-10-15 (target account + fresh sessions):
// Discord's gateways (gateway.gaming-sdk.com AND gateway.discord.gg) NO LONGER
// apply the `status` field of gateway OP 3 presence updates for OAuth/sdk
// sessions. Activities in the SAME OP 3 still apply (the RPC cards work), but
// the profile status is pinned to the ACCOUNT-level setting
// (user_settings.status). The first dnd a user picks therefore sticks forever:
// every later Online/Idle/DND pick is silently ignored, and because Discord
// hides the Mobile/VR platform badge while the account status is idle/dnd,
// those badges "stop showing" too.
//
// THE HONORED PATH: REST `PATCH /users/@me/settings` with `{ status }` — the
// exact call the real Discord client makes when its status picker is used.
// The OAuth bearer token issued by our flow (scope sdk.social_layer_presence)
// is authorized for it (live-verified: PATCH 200, GET 401), and the change
// propagates to every session's rendered presence instantly.
//
// The same endpoint owns the profile's custom status text/emoji
// (`custom_status`), which the website's Custom Msg + emoji feature controls.

const DISCORD_API = 'https://discord.com/api/v10'

const VALID_STATUSES = new Set(['online', 'idle', 'dnd', 'invisible'])

export interface DiscordCustomStatus {
  /** Custom message text (≤128 chars). */
  text?: string | null
  /** Unicode emoji shown before the text (plain emoji character). */
  emoji_name?: string | null
}

export interface DiscordSettingsPatch {
  status?: string
  custom_status?: DiscordCustomStatus | null
}

export interface DiscordSettingsPatchResult {
  ok: boolean
  httpStatus?: number
  /** The account status Discord reports back after the patch (when ok). */
  status?: string | null
  error?: string
}

function buildBody(patch: DiscordSettingsPatch): Record<string, unknown> {
  const body: Record<string, unknown> = {}
  if (patch.status !== undefined) {
    if (!VALID_STATUSES.has(patch.status)) return body
    body.status = patch.status
  }
  if (patch.custom_status !== undefined) {
    if (patch.custom_status === null) {
      body.custom_status = null
    } else {
      const cs: Record<string, unknown> = { expires_at: null }
      if (patch.custom_status.text !== undefined) cs.text = patch.custom_status.text
      if (patch.custom_status.emoji_name !== undefined) cs.emoji_name = patch.custom_status.emoji_name
      body.custom_status = cs
    }
  }
  return body
}

/**
 * PATCH the user's Discord account settings (status / custom_status) with an
 * OAuth bearer token. Never throws — failures are returned, so callers can
 * stay honest in their responses while the daemon self-heal loop retries.
 */
export async function patchDiscordAccountSettings(
  accessToken: string,
  patch: DiscordSettingsPatch
): Promise<DiscordSettingsPatchResult> {
  const body = buildBody(patch)
  if (Object.keys(body).length === 0) {
    return { ok: false, error: 'nothing_to_patch' }
  }
  try {
    const res = await fetch(`${DISCORD_API}/users/@me/settings`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) {
      let detail = ''
      try { detail = (await res.text()).slice(0, 200) } catch {}
      return { ok: false, httpStatus: res.status, error: `discord_settings_patch_${res.status}${detail ? `: ${detail}` : ''}` }
    }
    let status: string | null = null
    try {
      const data = await res.json() as { status?: string }
      status = data?.status ?? null
    } catch { /* body parse is best-effort */ }
    return { ok: true, httpStatus: res.status, status }
  } catch (e) {
    return { ok: false, error: `discord_settings_patch_failed: ${(e as Error)?.message || 'unknown'}` }
  }
}
