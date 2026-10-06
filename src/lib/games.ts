// 10X RPC — Game presets catalog
// Each game has a slug, name, default largeImage (Discord asset ID or URL),
// default state/details text, default platform, and a search tag list.

export interface GamePreset {
  slug: string
  name: string
  largeImage: string
  iconUrl?: string
  largeText: string
  defaultState: string
  defaultDetails: string
  defaultPlatform: string
  defaultPartyMax: number
  defaultPartyCurrent: number
  defaultEndTotalMins: number | null
  tags: string[]
}

export const GAME_PRESETS: GamePreset[] = [
  {
    slug: 'minecraft',
    name: 'Minecraft',
    largeImage: 'minecraft',
    iconUrl: '/games/minecraft.png',
    largeText: 'Minecraft',
    defaultState: 'Mining diamonds',
    defaultDetails: 'Survival Mode',
    defaultPlatform: 'desktop',
    defaultPartyCurrent: 1,
    defaultPartyMax: 8,
    defaultEndTotalMins: null,
    tags: ['minecraft', 'sandbox', 'block game'],
  },
  {
    slug: 'genshin-impact',
    name: 'Genshin Impact',
    largeImage: 'genshin',
    iconUrl: '/games/genshin.png',
    largeText: 'Genshin Impact',
    defaultState: 'Exploring Teyvat',
    defaultDetails: 'Adventure Rank 55',
    defaultPlatform: 'desktop',
    defaultPartyCurrent: 1,
    defaultPartyMax: 4,
    defaultEndTotalMins: null,
    tags: ['genshin', 'impact', 'genshin impact', 'gacha', 'arpg'],
  },
  {
    slug: 'wuthering-waves',
    name: 'Wuthering Waves',
    largeImage: 'wuthering-waves',
    iconUrl: '/games/wuthering-waves.png',
    largeText: 'Wuthering Waves',
    defaultState: 'Echo hunting',
    defaultDetails: 'Union Level 40',
    defaultPlatform: 'desktop',
    defaultPartyCurrent: 1,
    defaultPartyMax: 4,
    defaultEndTotalMins: null,
    tags: ['wuthering waves', 'wuwa', 'gacha'],
  },
  {
    slug: 'forza-horizon-5',
    name: 'Forza Horizon 5',
    largeImage: 'forza',
    iconUrl: '/games/forza.png',
    largeText: 'Forza Horizon 5',
    defaultState: 'Racing in Mexico',
    defaultDetails: 'Online Adventure',
    defaultPlatform: 'desktop',
    defaultPartyCurrent: 1,
    defaultPartyMax: 12,
    defaultEndTotalMins: 30,
    tags: ['forza', 'horizon', 'racing', 'forza horizon 5'],
  },
  {
    slug: 'arknights',
    name: 'Arknights',
    largeImage: 'arknights',
    iconUrl: '/games/arknights.png',
    largeText: 'Arknights',
    defaultState: 'Farming Annihilation',
    defaultDetails: 'Sanity: 135/135',
    defaultPlatform: 'android',
    defaultPartyCurrent: 1,
    defaultPartyMax: 1,
    defaultEndTotalMins: null,
    tags: ['arknights', 'tower defense', 'gacha'],
  },
  {
    slug: 'valorant',
    name: 'Valorant',
    largeImage: 'valorant',
    iconUrl: '/games/valorant.png',
    largeText: 'Valorant',
    defaultState: 'Competitive Match',
    defaultDetails: 'Rank: Diamond III',
    defaultPlatform: 'desktop',
    defaultPartyCurrent: 3,
    defaultPartyMax: 5,
    defaultEndTotalMins: 45,
    tags: ['valorant', 'fps', 'shooter', 'riot'],
  },
  {
    slug: 'gta-v',
    name: 'Grand Theft Auto V',
    largeImage: 'gtav',
    iconUrl: '/games/gtav.png',
    largeText: 'GTA V',
    defaultState: 'Heisting in Los Santos',
    defaultDetails: 'Online',
    defaultPlatform: 'desktop',
    defaultPartyCurrent: 2,
    defaultPartyMax: 4,
    defaultEndTotalMins: 60,
    tags: ['gta', 'gta v', 'gta 5', 'grand theft auto'],
  },
  {
    slug: 'vrchat',
    name: 'VRChat',
    largeImage: 'vrchat',
    iconUrl: '/games/vrchat.png',
    largeText: 'VRChat',
    defaultState: 'Hanging out',
    defaultDetails: 'Public World',
    defaultPlatform: 'meta_quest',
    defaultPartyCurrent: 4,
    defaultPartyMax: 30,
    defaultEndTotalMins: null,
    tags: ['vrchat', 'vr', 'social', 'meta quest'],
  },
  {
    slug: 'cs2',
    name: 'Counter-Strike 2',
    largeImage: 'cs2',
    iconUrl: '/games/cs2.png',
    largeText: 'CS2',
    defaultState: 'Competitive',
    defaultDetails: 'Premier Mode',
    defaultPlatform: 'desktop',
    defaultPartyCurrent: 3,
    defaultPartyMax: 5,
    defaultEndTotalMins: 40,
    tags: ['cs', 'cs2', 'csgo', 'counter strike', 'fps', 'shooter'],
  },
]

// 10X RPC — Game spoof map: real Discord application identities.
// When one of these games is the user's ENABLED game (GameConfig.enabled and the
// active RpcConfig name matches the preset), the daemon presents the Rich
// Presence as the game's OFFICIAL Discord application: its real application_id,
// its official display name, and its official app icon as the large image.
// App IDs + icon hashes are sourced from the official Discord applications.
export interface GameSpoofEntry {
  appId: string
  name: string
  icon: string
}

export const GAME_SPOOF: Record<string, GameSpoofEntry> = {
  'minecraft': {
    appId: '1402418491272986635',
    name: 'Minecraft',
    icon: 'https://cdn.discordapp.com/app-icons/1402418491272986635/166fbad351ecdd02d11a3b464748f66b.png',
  },
  'genshin-impact': {
    appId: '762434991303950386',
    name: 'Genshin Impact',
    icon: 'https://cdn.discordapp.com/app-icons/762434991303950386/eb0e25b739e4fa38c1671a3d1edcd1e0.png',
  },
  'wuthering-waves': {
    appId: '1247227126416146462',
    name: 'Wuthering Waves',
    icon: 'https://cdn.discordapp.com/app-icons/1247227126416146462/c7bb04bdddaa82cf045b02df7168365e.png',
  },
  'forza-horizon-5': {
    appId: '905961880789590076',
    name: 'Forza Horizon 5',
    icon: 'https://cdn.discordapp.com/app-icons/905961880789590076/229e83c3817d45ecabdaa2f343eadd34.png',
  },
  'arknights': {
    appId: '1461154307171811401',
    name: 'Arknights:Endfield',
    icon: 'https://cdn.discordapp.com/app-icons/1461154307171811401/a1c43f46f274856e6fb9edc8afda149d.png',
  },
  'valorant': {
    appId: '700136079562375258',
    name: 'Valorant',
    icon: 'https://cdn.discordapp.com/app-icons/700136079562375258/e55fc8259df1548328f977d302779ab7.png',
  },
  'gta-v': {
    appId: '1402418714716143646',
    name: 'GTA5',
    icon: 'https://cdn.discordapp.com/app-icons/1402418714716143646/b77111108195cd5e4dd2011dd39bf67d.png',
  },
  'vrchat': {
    appId: '398632010442211348',
    name: 'VRChat',
    icon: 'https://cdn.discordapp.com/app-icons/398632010442211348/5881acfa9405ee69158591ec1a791c74.png',
  },
  'cs2': {
    appId: '1158877933042143272',
    name: 'Counter-Strike 2',
    icon: 'https://cdn.discordapp.com/app-icons/1158877933042143272/558f5a26ecb3b17c3dea3d15c1df537a.png',
  },
}

export function findGame(slug: string) {
  return GAME_PRESETS.find(g => g.slug === slug)
}

export function searchGames(query: string): GamePreset[] {
  const q = query.toLowerCase().trim()
  if (!q) return GAME_PRESETS
  return GAME_PRESETS.filter(g => {
    if (g.name.toLowerCase().includes(q)) return true
    return g.tags.some(t => t.includes(q))
  })
}

// 10X RPC — Discord Application lookup (for "Add Games" with an Application ID).
// Discord's public /rpc endpoint returns an application's official identity
// (name + icon hash) without authentication. Results are cached in-memory per
// serverless instance to avoid repeat outbound calls on every save.
export const DISCORD_APP_ID_RE = /^\d{15,21}$/

export interface DiscordAppIdentity {
  name: string
  iconUrl: string | null
}

const appIdentityCache = new Map<string, DiscordAppIdentity | null>()

export async function fetchDiscordApplication(appId: string): Promise<DiscordAppIdentity | null> {
  const id = (appId || '').trim()
  if (!DISCORD_APP_ID_RE.test(id)) return null
  if (appIdentityCache.has(id)) return appIdentityCache.get(id) ?? null
  try {
    const res = await fetch(`https://discord.com/api/v10/applications/${id}/rpc`, {
      headers: { 'User-Agent': '10X-RPC (https://10x-rpc.vercel.app)' },
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) {
      appIdentityCache.set(id, null)
      return null
    }
    const app = (await res.json()) as { name?: string; icon?: string | null }
    const name = String(app.name || '').trim()
    if (!name) {
      appIdentityCache.set(id, null)
      return null
    }
    const identity: DiscordAppIdentity = {
      name: name.slice(0, 64),
      iconUrl: app.icon ? `https://cdn.discordapp.com/app-icons/${id}/${app.icon}.png` : null,
    }
    appIdentityCache.set(id, identity)
    return identity
  } catch {
    return null
  }
}
