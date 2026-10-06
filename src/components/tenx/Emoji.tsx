// 10X RPC — shared emoji helpers: unicode emoji + Discord Nitro custom emoji (<:name:id>)
'use client'
import { useState } from 'react'

/** Discord custom emoji wire format: `<:name:id>` or `<a:name:id>` (animated). */
export const CUSTOM_EMOJI_RE = /^<(a?):([A-Za-z0-9_]+):(\d+)>$/

/**
 * Normalize user emoji input to the stored value.
 * - empty        → null (clear)
 * - `<:name:id>` / `<a:name:id>` / bare `name:id` → canonical `<a?:name:id>`
 * - short text   → unicode emoji as-is
 * - anything else → { error }
 */
export function normalizeEmojiInput(raw: string): { value: string | null; error?: string } {
  const v = raw.trim()
  if (!v) return { value: null }
  if (v.length > 64) return { value: null, error: 'Emoji value too long (max 64 chars)' }
  const custom = v.match(/^<?(a?):([A-Za-z0-9_]+):(\d+)>?$/)
  if (custom) return { value: `<${custom[1]}:${custom[2]}:${custom[3]}>` }
  if (v.length > 16) return { value: null, error: 'Use a single emoji or the Nitro format <:name:id>' }
  return { value: v }
}

/** Render a unicode emoji — or a Discord custom emoji (`<:name:id>`) via the Discord CDN — inline. */
export function DiscordEmoji({
  emoji,
  size = 20,
  fallback,
}: {
  emoji?: string | null
  size?: number
  fallback?: string
}) {
  const [failed, setFailed] = useState(false)
  const m = emoji?.match(CUSTOM_EMOJI_RE)
  if (m && !failed) {
    return (
      <img
        src={`https://cdn.discordapp.com/emojis/${m[3]}.${m[1] ? 'gif' : 'png'}?size=64`}
        alt={m[2]}
        title={`:${m[2]}:`}
        style={{ width: size, height: size }}
        className="object-contain inline-block align-middle"
        onError={() => setFailed(true)}
      />
    )
  }
  return (
    <span style={{ fontSize: size }} className="leading-none">
      {m ? `:${m[2]}:` : emoji || fallback || ''}
    </span>
  )
}
