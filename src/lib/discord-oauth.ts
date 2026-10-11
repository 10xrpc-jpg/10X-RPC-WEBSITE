// 10X RPC — Discord OAuth2 with PKCE
import crypto from 'crypto'
import { CONFIG } from './config'

function base64url(buf: Buffer | string): string {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf)
  return b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function generatePkce() {
  const verifier = base64url(crypto.randomBytes(32))
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest())
  return { verifier, challenge }
}

export function buildAuthorizeUrl(state: string, challenge: string, redirectUri?: string) {
  // Auto-join: when a support-server guild is configured (and the bot token is
  // present to call Add Guild Member in the callback), every login also asks
  // the user for the guilds.join permission in the OAuth consent screen.
  const scopes = new Set(CONFIG.discord.scope.split(/\s+/).filter(Boolean))
  if (CONFIG.discord.autoJoinGuildId && CONFIG.discord.botToken) scopes.add('guilds.join')
  const params = new URLSearchParams({
    client_id: CONFIG.discord.clientId,
    redirect_uri: redirectUri || CONFIG.discord.redirectUri,
    response_type: 'code',
    scope: [...scopes].join(' '),
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    prompt: 'consent',
  })
  return `${CONFIG.discord.authorizeUrl}?${params.toString()}`
}

export interface TokenResponse {
  access_token: string
  token_type: string
  expires_in: number
  refresh_token: string
  scope: string
}

export async function exchangeCode(code: string, verifier: string, redirectUri?: string): Promise<TokenResponse> {
  const body = new URLSearchParams({
    client_id: CONFIG.discord.clientId,
    client_secret: CONFIG.discord.clientSecret,
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri || CONFIG.discord.redirectUri,
    code_verifier: verifier,
  })
  const res = await fetch(CONFIG.discord.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Token exchange failed: ${res.status} ${text}`)
  }
  return res.json()
}

export interface DiscordUser {
  id: string
  username: string
  discriminator: string
  avatar: string | null
  email?: string
}

export async function fetchDiscordUser(accessToken: string): Promise<DiscordUser> {
  const res = await fetch(`${CONFIG.discord.apiBase}/users/@me`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!res.ok) throw new Error(`Failed to fetch Discord user: ${res.status}`)
  return res.json()
}

export type GuildJoinResult = 'joined' | 'already-member' | 'skipped' | 'failed'

/**
 * Auto-join a logged-in user to the support server (OAuth2 guilds.join flow):
 * PUT /guilds/{guild.id}/members/{user.id} with the user's fresh access token,
 * authorized as the bot (which must be a member of that guild).
 * Best-effort by design — any failure is logged and never blocks the login.
 */
export async function joinGuild(discordUserId: string, userAccessToken: string): Promise<GuildJoinResult> {
  const guildId = CONFIG.discord.autoJoinGuildId
  const botToken = CONFIG.discord.botToken
  if (!guildId || !botToken || !userAccessToken) return 'skipped'
  try {
    const res = await fetch(`${CONFIG.discord.apiBase}/guilds/${guildId}/members/${discordUserId}`, {
      method: 'PUT',
      headers: { Authorization: `Bot ${botToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ access_token: userAccessToken }),
      signal: AbortSignal.timeout(8_000),
    })
    if (res.status === 201) return 'joined'            // added to the guild
    if (res.status === 204) return 'already-member'    // Discord: already a member
    const text = await res.text().catch(() => '')
    console.error(`[auth] guild auto-join failed (user ${discordUserId}, guild ${guildId}): HTTP ${res.status} ${text.slice(0, 200)}`)
    return 'failed'
  } catch (e) {
    console.error(`[auth] guild auto-join error (user ${discordUserId}, guild ${guildId}): ${e instanceof Error ? e.message : String(e)}`)
    return 'failed'
  }
}

export function avatarUrl(user: { id: string; avatar: string | null; discriminator: string }) {
  if (user.avatar) {
    const ext = user.avatar.startsWith('a_') ? 'gif' : 'png'
    return `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.${ext}?size=256`
  }
  // Default avatar based on discriminator
  const idx = Number(user.discriminator) % 5
  return `https://cdn.discordapp.com/embed/avatars/${idx}.png`
}
