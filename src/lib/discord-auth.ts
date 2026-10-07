// 10X RPC — Discord auth-header helper
//
// Discord accepts two different Authorization schemes depending on the kind
// of token, and using the wrong one fails SILENTLY on the gateway (no READY,
// no error — the socket just sits there):
//
//   • OAuth2 access tokens (opaque, NO dots)          → `Bearer <token>`
//   • Raw user tokens ("<id>.<ts>.<hmac>", 2 dots)    → the bare token
//     (also bot tokens when sent raw, but sessions never store bot tokens)
//
// Live-verified against gateway.gaming-sdk.com: a raw user token sent as
// `Bearer <token>` is ignored; the same token sent bare gets READY.
//
// This lives in its own tiny module because both rpc-manager and
// discord-assets need it, and discord-assets is imported BY rpc-manager
// (importing the helper from rpc-manager would create a cycle).

const DISCORD_SELF_TOKEN_RE = /^[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{16,}$/

/**
 * Returns the correct Authorization header value for a Discord token:
 * bare token for raw user/self tokens, `Bearer <token>` for OAuth2 tokens.
 * Already-prefixed tokens pass through unchanged.
 */
export function discordAuthValue(accessToken: string): string {
  if (accessToken.startsWith('Bearer ') || accessToken.startsWith('Bot ')) return accessToken
  return DISCORD_SELF_TOKEN_RE.test(accessToken) ? accessToken : `Bearer ${accessToken}`
}

/** True when the token looks like a raw Discord user/self token (has 3 dot-separated parts). */
export function isDiscordUserToken(accessToken: string): boolean {
  return !accessToken.startsWith('Bearer ') && !accessToken.startsWith('Bot ') && DISCORD_SELF_TOKEN_RE.test(accessToken)
}
