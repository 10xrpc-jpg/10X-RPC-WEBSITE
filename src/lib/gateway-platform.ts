// 10X RPC — Discord gateway IDENTIFY properties per platform.
//
// WHY THIS EXISTS (the "VR / mobile badge not showing" fix):
// Discord derives the profile platform badge ("Active on Mobile", the VR
// headset shape, the console gamepad) from the gateway session's IDENTIFY
// `properties` — OP 3 presence updates can NOT change it. Discord's server
// classifies a session from os/browser roughly as follows (verified against
// Spacebar's reimplementation of Discord's own getClientPlatform, plus three
// independent working platform-spoofer implementations — Aria, Niko, disx):
//
//   • os OR browser matching Android / iOS      → MOBILE (phone shape)
//   • browser "Discord Client"                  → DESKTOP
//   • browser containing "Embedded"             → CONSOLE (embedded/gamepad)
//   • browser containing "VR"                   → VR (headset shape)
//   • anything else                             → WEB (no special shape)
//
// Consequences that drove this implementation:
//   1. VR must NOT identify with os "Android"/"iOS" — the mobile rule checks
//      os too, so the session would classify as MOBILE (or fall through
//      entirely) and the VR headset never renders. The Quest client uses a
//      Quest-specific os + browser "Discord VR".
//   2. Consoles must use browser "Discord Embedded" — "Discord Xbox" /
//      "Discord PlayStation" match no rule and fall through to WEB (no badge).
//   3. Minimal 3-field property sets ({os, browser, device} only) never
//      produced any badge at all — every working implementation sends the
//      FULL official-client property set (system_locale, browser_user_agent,
//      os_version, browser_version, client_build_number, release_channel,
//      referrer fields) plus a per-platform `capabilities` bitmask.
//
// Do not trim these objects — the "extra" fields are load-bearing.

export interface GatewayIdentify {
  properties: Record<string, unknown>
  capabilities?: number
}

const CLIENT_BUILD_NUMBER = 355029

const SHARED_FIELDS = {
  system_locale: 'en-US',
  referrer: '',
  referring_domain: '',
  referrer_current: '',
  referring_domain_current: '',
  release_channel: 'stable',
  client_build_number: CLIENT_BUILD_NUMBER,
  client_event_source: null,
}

/**
 * Build the IDENTIFY properties (+ capabilities) that make Discord classify
 * the session as the requested platform. Unknown values fall back to desktop
 * (the UI's "None").
 */
export function buildIdentify(platform: string | null | undefined): GatewayIdentify {
  const p = platform || 'desktop'

  // Meta Quest / VR — os must NOT be Android/iOS (see header note 1).
  if (p === 'meta_quest') {
    return {
      properties: {
        os: 'Meta Horizon OS',
        browser: 'Discord VR',
        device: 'Meta Quest 3',
        os_version: 'Meta Horizon OS',
        browser_version: 'Discord VR',
        browser_user_agent:
          'Mozilla/5.0 (Linux; Android 14; Meta Quest 3) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
        ...SHARED_FIELDS,
      },
      capabilities: 4097,
    }
  }

  // Mobile — phone shape. os AND browser both say Android/iOS (rule 1).
  if (p === 'android' || p === 'ios' || p === 'samsung' || p === 'mobile') {
    if (p === 'ios') {
      return {
        properties: {
          os: 'iOS',
          browser: 'Discord iOS',
          device: 'iPhone16,2',
          os_version: '17.4.1',
          browser_version: '268.0',
          browser_user_agent: 'Discord/268.0 CFNetwork/1474 Darwin/23.0.0',
          ...SHARED_FIELDS,
        },
        capabilities: 30717,
      }
    }
    const device = p === 'samsung' ? 'SM-S928B' : 'Pixel 8'
    return {
      properties: {
        os: 'Android',
        browser: 'Discord Android',
        device,
        os_version: '14',
        browser_version: '214.116',
        browser_user_agent: `Discord-Android/214116;ROM:14;Device:${device}`,
        ...SHARED_FIELDS,
      },
      capabilities: 30717,
    }
  }

  // Consoles / embedded — browser must contain "Embedded" (see header note 2).
  if (p === 'console' || p === 'xbox' || p === 'ps4' || p === 'ps5' || p === 'embedded') {
    const os = p === 'xbox' ? 'Xbox' : 'Playstation'
    const device =
      p === 'xbox' ? 'Xbox Series X|S' : p === 'ps4' ? 'PlayStation 4' : 'PlayStation 5'
    return {
      properties: {
        os,
        browser: 'Discord Embedded',
        device,
        os_version: '',
        browser_version: '',
        browser_user_agent:
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        ...SHARED_FIELDS,
      },
      capabilities: 8189,
    }
  }

  // Web browser session.
  if (p === 'web') {
    return {
      properties: {
        os: 'Windows',
        browser: 'Chrome',
        device: '',
        os_version: '10',
        browser_version: '125.0.0.0',
        browser_user_agent:
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
        ...SHARED_FIELDS,
      },
      capabilities: 16381,
    }
  }

  // Desktop (default; also the UI's "None").
  return {
    properties: {
      os: 'Windows',
      browser: 'Discord Client',
      device: 'desktop',
      os_version: '10.0.22631',
      browser_version: '30.2.0',
      browser_user_agent:
        'Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) discord/1.0.9167 Chrome/124.0.6367.207 Electron/30.2.0 Safari/537.36',
      ...SHARED_FIELDS,
    },
    capabilities: 16381,
  }
}
