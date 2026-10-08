// 10X RPC — Discord presence asset pipeline (wire-format resolver)
//
// WHY THIS EXISTS
// Gateway presence payloads (OP 3, both gateway.gaming-sdk.com and the regular
// client gateway) do NOT render arbitrary image references. Real Discord
// clients only render an activity image when `assets.large_image`/`small_image`
// is one of:
//   1. an ASSET ID (snowflake string) of an asset uploaded to the application
//      identified by `application_id`        e.g. "1556496377242984529"
//   2. an external media-proxy reference     e.g. "mp:external/<hash>/https/<host>/<path>"
//      — the ONLY variant that renders ANIMATED GIF / animated WebP / AVIF
//   3. (via the official Social SDK only, which resolves internally) an asset KEY
//
// Bare asset keys sent directly over the gateway are stored by Discord but no
// client can resolve them (nothing converts key→ID server-side) → the card
// reserves an empty image slot and shows nothing. Raw http(s) URLs are dropped
// entirely. Both forms produce the infamous "RPC image not showing" bug.
//
// HOW WE FIX IT
// resolveAssetRef() converts ANY user input into a wire-renderable value:
//   • asset keys / URLs → uploaded asset IDs      (static png/jpg/webp/gif)
//   • image URLs       → mp:external references  (animated GIFs render!)
//     using Discord's external-assets endpoint (user OAuth Bearer only — the
//     bot token is rejected with 20001 "Bots cannot use this endpoint")
//   • when the source URL is dead/expired (signed Discord CDN links rotate),
//     we fall back to the LOCAL MIRROR of the image hosted on the production
//     site (public/asset-mirror/*, served from Vercel) before giving up.
//
// If nothing can be resolved the caller receives `null` and MUST omit the
// image field — never fall back to raw URLs or bare keys.

import crypto from 'crypto'
import fs from 'fs'
import { db } from '@/lib/db'
import { CONFIG } from '@/lib/config'
import { discordAuthValue } from '@/lib/discord-auth'

const API = 'https://discord.com/api/v9'
const APP_ID = CONFIG.discord.clientId
const BOT_TOKEN = CONFIG.discord.botToken

const MAX_BYTES = 8 * 1024 * 1024 // Discord asset limit is 8MB via portal
const DOWNLOAD_TIMEOUT_MS = 12000
const REACHABILITY_TIMEOUT_MS = 5000
const MIRROR_DIR = 'public/asset-mirror'
const NEGATIVE_TTL_MS = 60_000
// Vercel serverless responses are practically capped ~4.5MB. Mirrors larger
// than this can't be served by /api/asset-mirror/<hash> and fall back to the
// STATIC file URL — which only exists on a deployed snapshot and 404s for any
// image added between deploys. Discord's media proxy then 404s too and the
// RPC image silently disappears (the exact "GIF not showing" bug). Anything
// larger is therefore RE-ENCODED to fit under this limit before persisting
// (see compressImageForMirror) so EVERY mirror is servable from the DB route.
const MIRROR_DB_MAX = 4_000_000

export interface ResolveOpts {
  /** The acting user's OAuth access token — required for the external-assets endpoint. */
  userAccessToken?: string | null
}

interface AppAsset {
  key: string
  asset_id: string
  asset_type?: number | string
  metadata?: { content_type?: string; is_animated?: boolean; width?: number; height?: number }
}

/* ------------------------------ classifiers ------------------------------ */

export function isImageUrl(value: string): boolean {
  return /^https?:\/\//i.test(value)
}

/** Discord asset IDs are 15-21 digit snowflakes. */
function isAssetId(v: string): boolean {
  return /^\d{15,21}$/.test(v)
}

/** External media-proxy references (wire format for animated/external images). */
function isMpExternal(v: string): boolean {
  return v.startsWith('mp:external/') || v.startsWith('external/')
}

/** True when the value is already renderable on the wire. */
function isWireFormat(v: string): boolean {
  return isAssetId(v) || isMpExternal(v)
}

/* ------------------------------ local mirror ----------------------------- */

function hashForUrl(url: string): string | null {
  try {
    return crypto.createHash('sha1').update(new URL(url).pathname).digest('hex').slice(0, 16)
  } catch {
    return null
  }
}

function mirrorFilesFor(url: string): string[] {
  const hash = hashForUrl(url)
  if (!hash) return []
  return ['gif', 'png', 'jpg', 'jpeg', 'webp'].map((ext) => `${MIRROR_DIR}/${hash}.${ext}`)
}

async function saveMirror(url: string, bytes: Buffer, ext: string, contentType?: string): Promise<void> {
  // Oversized images (e.g. 7MB GIFs) are re-encoded to ≤ MIRROR_DB_MAX so the
  // DB-backed mirror can serve them EVERYWHERE — a static-only fallback 404s
  // between deploys and the RPC image silently disappears in Discord.
  let store = { bytes, ext, contentType: contentType || 'image/png' }
  try {
    const compressed = await compressImageForMirror(bytes, store.contentType)
    if (compressed) store = { bytes: compressed.bytes, ext: compressed.ext, contentType: compressed.contentType }
  } catch {
    // keep the original on any compression failure
  }
  try {
    const hash = hashForUrl(url)
    if (hash) {
      if (!fs.existsSync(MIRROR_DIR)) fs.mkdirSync(MIRROR_DIR, { recursive: true })
      fs.writeFileSync(`${MIRROR_DIR}/${hash}.${store.ext}`, store.bytes)
      // remove stale same-hash files in other formats (they shadow the
      // compressed copy in loadMirror's extension priority order)
      for (const e of ['gif', 'png', 'jpg', 'jpeg', 'webp']) {
        if (e !== store.ext) fs.rmSync(`${MIRROR_DIR}/${hash}.${e}`, { force: true })
      }
    }
  } catch {
    // Mirror is best-effort only
  }
  // DB-backed mirror: reaches production (Vercel /api/asset-mirror/[hash])
  // IMMEDIATELY, without a redeploy — static files alone go stale between
  // deploys and produce 404s that break the media proxy (no image in Discord).
  await persistMirrorToDb(url, store.bytes, store.contentType).catch(() => {})
}

async function persistMirrorToDb(url: string, bytes: Buffer, contentType: string): Promise<void> {
  const hash = hashForUrl(url)
  if (!hash) return
  try {
    const payload = new Uint8Array(bytes)
    await db.mirrorAsset.upsert({
      where: { hash },
      create: { hash, contentType, bytes: payload, size: bytes.length },
      update: { contentType, bytes: payload, size: bytes.length },
    })
  } catch {
    // non-fatal — static mirror + source URL remain fallbacks
  }
}

/** Detect an image MIME type from buffer magic bytes. */
function sniffImageType(buf: Buffer): string | null {
  if (buf.length < 12) return null
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'image/gif' // "GIF"
  if (buf[0] === 0x89 && buf[1] === 0x50) return 'image/png'
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg'
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[8] === 0x57 && buf[9] === 0x45) return 'image/webp' // "RIFF…WEBP"
  return null
}

const MIME_EXT: Record<string, string> = {
  'image/gif': 'gif',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
}

/**
 * Re-encode an oversized image until it fits MIRROR_DB_MAX so the DB-backed
 * mirror route can serve it on production. Animated GIFs STAY animated: they
 * are first re-encoded as GIFs at decreasing widths/colours, then as animated
 * WebP (Discord renders animated WebP from external URLs too), and only as a
 * last resort a static PNG of the first frame. Returns null when no
 * compression is needed or sharp is unavailable.
 */
async function compressImageForMirror(
  bytes: Buffer,
  contentType: string
): Promise<{ bytes: Buffer; contentType: string; ext: string } | null> {
  if (bytes.length <= MIRROR_DB_MAX) return null
  let sharp: any = null
  try {
    sharp = (await import('sharp')).default
  } catch {
    console.error('[DiscordAssets] sharp unavailable — cannot compress oversized mirror')
    return null
  }
  if (typeof sharp !== 'function') return null

  const animated = contentType.includes('gif') || contentType.includes('webp')
  type Attempt = { run: () => Promise<Buffer>; ct: string }
  const attempts: Attempt[] = []
  if (animated) {
    for (const width of [512, 400, 320, 256]) {
      attempts.push({
        ct: 'image/gif',
        run: () =>
          sharp(bytes, { animated: true, failOn: 'none' })
            .resize({ width, withoutEnlargement: true })
            .gif({ colours: width >= 400 ? 192 : 128, effort: 7 })
            .toBuffer(),
      })
    }
    for (const width of [400, 320, 256]) {
      attempts.push({
        ct: 'image/webp',
        run: () =>
          sharp(bytes, { animated: true, failOn: 'none' })
            .resize({ width, withoutEnlargement: true })
            .webp({ quality: 70, effort: 4 })
            .toBuffer(),
      })
    }
  }
  for (const width of [1024, 768, 512]) {
    attempts.push({
      ct: 'image/jpeg',
      run: () =>
        sharp(bytes, { failOn: 'none' })
          .resize({ width, withoutEnlargement: true })
          .jpeg({ quality: 78, mozjpeg: true })
          .toBuffer(),
    })
  }
  attempts.push({
    ct: 'image/png',
    run: () =>
      sharp(bytes, { failOn: 'none' })
        .resize({ width: 512, withoutEnlargement: true })
        .png({ compressionLevel: 9 })
        .toBuffer(),
  })

  for (const attempt of attempts) {
    try {
      const out = Buffer.from(await attempt.run())
      if (out.length > 0 && out.length <= MIRROR_DB_MAX) {
        const ct = sniffImageType(out) || attempt.ct
        console.log(
          `[DiscordAssets] Compressed oversized mirror ${(bytes.length / 1048576).toFixed(2)}MB → ${(out.length / 1048576).toFixed(2)}MB (${ct})`
        )
        return { bytes: out, contentType: ct, ext: MIME_EXT[ct] || 'png' }
      }
    } catch {
      // try the next strategy
    }
  }
  return null
}

function loadMirror(url: string): { bytes: Buffer; contentType: string } | null {
  try {
    for (const file of mirrorFilesFor(url)) {
      if (fs.existsSync(file)) {
        const ext = file.split('.').pop() || 'png'
        const ct = ext === 'gif' ? 'image/gif' : ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'webp' ? 'image/webp' : 'image/png'
        return { bytes: fs.readFileSync(file), contentType: ct }
      }
    }
  } catch {
    // fallthrough to DB
  }
  return null
}

/** DB-backed mirror lookup — synchronous file mirror is preferred, DB is the durable copy. */
async function loadMirrorFromDb(url: string): Promise<{ bytes: Buffer; contentType: string } | null> {
  const hash = hashForUrl(url)
  if (!hash) return null
  try {
    const row = await db.mirrorAsset.findUnique({
      where: { hash },
      select: { bytes: true, contentType: true },
    })
    if (!row) return null
    return { bytes: Buffer.from(row.bytes), contentType: row.contentType }
  } catch {
    return null
  }
}

/**
 * Public base URL where local mirrors are reachable from the internet.
 * Mirrors are committed to the repo and served statically by the production
 * site (Vercel). Preference: ASSET_MIRROR_BASE → NEXT_PUBLIC_APP_URL (if https)
 * → the known production deployment.
 */
function mirrorBaseUrl(): string {
  const envBase = process.env.ASSET_MIRROR_BASE || process.env.NEXT_PUBLIC_APP_URL || ''
  if (envBase.startsWith('https://')) return envBase.replace(/\/+$/, '')
  return 'https://10x-rpc.vercel.app'
}

/**
 * Public URL where the mirrored copy of this image is reachable from the
 * internet. DB-backed mirrors are preferred (/api/asset-mirror/<hash> — live
 * on production the moment the row is written); the static file URL is the
 * fallback for pre-existing mirrors.
 */
async function publicMirrorUrl(url: string): Promise<string | null> {
  const hash = hashForUrl(url)
  if (!hash) return null
  // /api/asset-mirror/<hash>.<ext> is preferred (live without redeploy). The
  // EXTENSION matters: Discord's media proxy passes animation through for
  // .gif URLs but converts extension-less URLs to static thumbnails. Oversized
  // mirrors (>4.5MB Vercel cap) fall back to the static URL.
  try {
    const row = await db.mirrorAsset.findUnique({ where: { hash }, select: { size: true, contentType: true } })
    if (row && row.size <= MIRROR_DB_MAX) {
      const ext = MIME_EXT[(row.contentType || '').split(';')[0].trim().toLowerCase()]
      return `${mirrorBaseUrl()}/api/asset-mirror/${hash}${ext ? `.${ext}` : ''}`
    }
  } catch {
    // fall through to static
  }
  for (const ext of ['gif', 'png', 'jpg', 'jpeg', 'webp']) {
    if (fs.existsSync(`${MIRROR_DIR}/${hash}.${ext}`)) {
      return `${mirrorBaseUrl()}/asset-mirror/${hash}.${ext}`
    }
  }
  return null
}

/* ------------------------------ app asset map ---------------------------- */

let assetMapCache: { at: number; map: Map<string, AppAsset> } | null = null
let assetMapErrorAt = 0

/**
 * Application asset list (bot-authenticated), 5-minute cache.
 * Maps lowercase key → asset record (asset_id, animation info).
 */
async function getAppAssetMap(): Promise<Map<string, AppAsset>> {
  if (assetMapCache && Date.now() - assetMapCache.at < 5 * 60 * 1000) return assetMapCache.map
  if (Date.now() - assetMapErrorAt < 30_000 && assetMapCache) return assetMapCache.map
  const map = new Map<string, AppAsset>()
  try {
    const res = await fetch(`${API}/applications/${APP_ID}/assets`, {
      headers: { Authorization: `Bot ${BOT_TOKEN}` },
    })
    if (!res.ok) throw new Error(`asset_list_${res.status}`)
    const assets = (await res.json()) as AppAsset[]
    for (const a of assets) {
      if (a?.key && a?.asset_id) map.set(a.key.toLowerCase(), a)
    }
    assetMapCache = { at: Date.now(), map }
  } catch (err) {
    assetMapErrorAt = Date.now()
    console.error('[DiscordAssets] Failed to list application assets:', err)
    if (assetMapCache) return assetMapCache.map // serve stale on error
  }
  return map
}

/* ------------------------------ misc helpers ----------------------------- */

function sanitizeKey(base: string): string {
  return base.toLowerCase().replace(/[^a-z0-9-_]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 32) || 'image'
}

function extFromContentType(ct: string, fallbackUrl: string): string {
  const c = ct.split(';')[0].trim().toLowerCase()
  if (c === 'image/png' || c === 'image/apng') return 'png'
  if (c === 'image/jpeg' || c === 'image/jpg') return 'jpg'
  if (c === 'image/gif') return 'gif'
  if (c === 'image/webp') return 'webp'
  const m = /\.(png|jpe?g|gif|webp)(\?|$)/i.exec(fallbackUrl)
  if (m) return m[1].toLowerCase() === 'jpeg' ? 'jpg' : m[1].toLowerCase()
  return 'png'
}

async function fetchImage(url: string): Promise<{ bytes: Buffer; contentType: string } | null> {
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), DOWNLOAD_TIMEOUT_MS)
    const res = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': '10X-RPC/2.0 (asset pipeline)' } })
    clearTimeout(timer)
    if (!res.ok) return null
    const ct = res.headers.get('content-type') || ''
    if (!ct.startsWith('image/')) return null
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length === 0 || buf.length > MAX_BYTES) return null
    return { bytes: buf, contentType: ct.split(';')[0] }
  } catch {
    return null
  }
}

/* --------------------------- external asset API -------------------------- */

const externalMemCache = new Map<string, string>()

/**
 * Convert a publicly-fetchable image URL into Discord's external media-proxy
 * reference (`mp:external/...`) via the external-assets endpoint.
 * This is the ONLY wire format that renders animated GIF/WebP/AVIF.
 * Requires a USER OAuth access token (bot tokens are rejected, code 20001).
 */
export async function resolveExternalAsset(url: string, userAccessToken: string): Promise<string | null> {
  const cached = externalMemCache.get(url)
  if (cached) return cached
  try {
    const res = await fetch(`${API}/applications/${APP_ID}/external-assets`, {
      method: 'POST',
      headers: { Authorization: discordAuthValue(userAccessToken), 'Content-Type': 'application/json' },
      body: JSON.stringify({ urls: [url] }),
    })
    if (!res.ok) {
      console.error(`[DiscordAssets] external-assets ${res.status} for ${url.slice(0, 120)}`)
      return null
    }
    const data = (await res.json()) as Array<{ url: string; external_asset_path: string }>
    const path = data?.[0]?.external_asset_path
    if (!path) return null
    const wire = path.startsWith('external/') ? `mp:${path}` : path
    externalMemCache.set(url, wire)
    return wire
  } catch (err) {
    console.error('[DiscordAssets] external-assets error:', err)
    return null
  }
}

/* -------------------------------- caching -------------------------------- */

// input value → resolved wire value
const memCache = new Map<string, string>()
// input value → negative-result expiry timestamp
const negCache = new Map<string, number>()
// de-duplicate concurrent resolutions of the same input
const inFlight = new Map<string, Promise<string | null>>()

/**
 * DB cache lookup for a source URL — returns only WIRE-FORMAT values.
 * 1) Exact URL match. 2) Path-only match — signed Discord CDN URLs rotate their
 * `?ex=&is=&hm=` params while pointing at the same file.
 * Legacy rows (old asset-key cache) return null here so the caller can
 * upgrade them to an animated-capable mp:external reference first.
 */
async function findCachedWireValueForUrl(url: string): Promise<string | null> {
  let cachedKey: string | null = null
  try {
    const row = await db.discordAsset.findUnique({ where: { url } }).catch(() => null)
    if (row) cachedKey = row.key
    if (!cachedKey) {
      const path = new URL(url).pathname
      if (path && path !== '/') {
        const row2 = await db.discordAsset.findFirst({
          where: { url: { contains: path } },
          orderBy: { createdAt: 'desc' },
        })
        if (row2) cachedKey = row2.key
      }
    }
  } catch {
    return null
  }
  if (!cachedKey) return null
  if (!isWireFormat(cachedKey)) return null

  // Self-heal: cached wire values that reference an asset-mirror URL are only
  // valid while the mirror actually exists AND the referenced form is the one
  // the resolver would still choose. Mismatches are the "GIF not showing" bug:
  //  • static-path refs (/asset-mirror/<hash>.ext) 404 on production whenever
  //    the file never reached the deployed snapshot, and they go stale once the
  //    DB mirror is small enough for the /api/asset-mirror route (re-encode) —
  //    the mp:external hash Discord issued is per exact URL, so the reference
  //    must be re-registered against the NEW url.
  //  • DB-route refs (/api/asset-mirror/<hash>) are only valid while a small
  //    enough row actually exists — and they must carry a format extension
  //    (extension-less URLs are converted to static thumbnails by the proxy).
  const mirrorRef = /\/(?:api\/)?asset-mirror\/([0-9a-f]{16})(\.[a-z0-9]+)?/i.exec(cachedKey)
  if (mirrorRef) {
    const hash = mirrorRef[1]
    let dbSize = -1
    try {
      const row = await db.mirrorAsset.findUnique({ where: { hash }, select: { size: true } })
      dbSize = row?.size ?? -1
    } catch {
      dbSize = -1
    }
    const fileBacked = ['gif', 'png', 'jpg', 'jpeg', 'webp'].some((e) => fs.existsSync(`${MIRROR_DIR}/${hash}.${e}`))
    const isApiRef = /\/api\/asset-mirror\//i.test(cachedKey)
    const backed = isApiRef
      ? // DB-route refs are valid only while a small enough row exists AND the
        // ref carries a format extension (extension-less refs get converted to
        // static thumbnails by Discord's media proxy — stale by definition now).
        dbSize > 0 && dbSize <= MIRROR_DB_MAX && Boolean(mirrorRef[2])
      : dbSize > MIRROR_DB_MAX && fileBacked
    if (!backed) {
      try {
        await db.discordAsset.deleteMany({ where: { key: cachedKey } })
      } catch {
        // ignore
      }
      return null
    }
  }
  return cachedKey
}

async function rememberResolved(input: string, wire: string): Promise<void> {
  memCache.set(input, wire)
  negCache.delete(input)
  try {
    await db.discordAsset.upsert({ where: { url: input }, create: { url: input, key: wire }, update: { key: wire } })
  } catch {
    // cache write failure is non-fatal
  }
}

/**
 * Legacy cache lookup — returns the raw stored value (asset key or wire value)
 * for a source URL. Used by the uploaded-asset fallback path.
 */
async function findCachedLegacyValueForUrl(url: string): Promise<string | null> {
  try {
    const row = await db.discordAsset.findUnique({ where: { url } }).catch(() => null)
    if (row?.key) return row.key
    const path = new URL(url).pathname
    if (!path || path === '/') return null
    const row2 = await db.discordAsset.findFirst({
      where: { url: { contains: path } },
      orderBy: { createdAt: 'desc' },
    })
    return row2?.key ?? null
  } catch {
    return null
  }
}

/* ------------------------------ upload path ------------------------------ */

/**
 * Upload a raw image buffer as a Discord application asset.
 * Returns the asset key, or null on failure.
 */
export async function uploadAssetBuffer(
  keyBase: string,
  bytes: Buffer,
  contentType: string,
  filename: string
): Promise<string | null> {
  if (!APP_ID || !BOT_TOKEN) return null

  try {
    // Step 1 — stage the upload
    const stageRes = await discordFetch(`/applications/${APP_ID}/assets/upload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename, file_size: bytes.length }),
    })
    if (!stageRes.ok) {
      console.error(`[DiscordAssets] Stage failed (${stageRes.status}): ${await stageRes.text().catch(() => '')}`)
      return null
    }
    const stage = (await stageRes.json()) as { upload_url: string; upload_filename: string }

    // Step 2 — upload raw bytes to the signed GCS URL
    const putRes = await fetch(stage.upload_url, {
      method: 'PUT',
      headers: { 'Content-Type': contentType },
      body: new Uint8Array(bytes),
    })
    if (!putRes.ok) {
      console.error(`[DiscordAssets] GCS PUT failed (${putRes.status})`)
      return null
    }

    // Step 3 — register the asset
    const key = sanitizeKey(keyBase)
    const finalRes = await discordFetch(`/applications/${APP_ID}/assets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: key, key, upload_filename: stage.upload_filename }),
    })
    if (!finalRes.ok) {
      console.error(`[DiscordAssets] Finalize failed (${finalRes.status}): ${await finalRes.text().catch(() => '')}`)
      return null
    }
    const asset = (await finalRes.json()) as { key: string; asset_id?: string }
    return asset.key
  } catch (err) {
    console.error('[DiscordAssets] Upload error:', err)
    return null
  }
}

function discordFetch(path: string, init: RequestInit): Promise<Response> {
  return fetch(`${API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bot ${BOT_TOKEN}`,
      ...(init.headers as Record<string, string> | undefined),
    },
  })
}

/* ------------------------------ main resolver ---------------------------- */

/**
 * Resolve an image reference (URL or asset key) into a WIRE-RENDERABLE value:
 *  • URLs → `mp:external/...` (animated GIF capable) or an uploaded asset ID
 *  • asset keys → their uploaded asset ID
 * Returns null when nothing renderable can be produced (callers must omit the
 * image — raw URLs / bare keys never render from gateway presences).
 */
export async function resolveAssetRef(value: string | null | undefined, opts?: ResolveOpts): Promise<string | null> {
  if (!value) return null
  const v = value.trim()
  if (!v) return null

  // Already renderable — pass through untouched.
  if (isWireFormat(v)) return v

  // Plain asset key → resolve to its uploaded asset ID.
  if (!isImageUrl(v)) {
    const map = await getAppAssetMap()
    const asset = map.get(v.toLowerCase())
    if (asset?.asset_id) return asset.asset_id
    console.error(`[DiscordAssets] Unknown asset key "${v}" — image will be omitted (keys never render from gateway presences)`)
    return null
  }

  // URL input
  const mem = memCache.get(v)
  if (mem) return mem

  const neg = negCache.get(v)
  if (neg && Date.now() < neg) return null

  const dbCached = await findCachedWireValueForUrl(v)
  if (dbCached) {
    memCache.set(v, dbCached)
    return dbCached
  }

  const existing = inFlight.get(v)
  if (existing) return existing

  const task = (async (): Promise<string | null> => {
    // 1) Download the source (also refreshes the local + DB mirrors). If the
    //    source is dead/expired, fall back to the mirrors.
    let downloaded = await fetchImage(v)
    if (downloaded) {
      await saveMirror(v, downloaded.bytes, extFromContentType(downloaded.contentType, v), downloaded.contentType)
    } else {
      downloaded = loadMirror(v) ?? (await loadMirrorFromDb(v))
    }

    // 2) Preferred wire format: external media-proxy reference (animated GIF capable).
    const token = opts?.userAccessToken || null
    if (token) {
      const candidates: string[] = []
      // Stable public mirror URL first — for Discord CDN attachments Discord
      // returns a bare media.discordapp.net URL (low-confidence wire format),
      // while arbitrary hosts get the canonical external/<hash>/https/... path.
      const mirrorUrl = await publicMirrorUrl(v)
      if (mirrorUrl && (await isReachable(mirrorUrl))) candidates.push(mirrorUrl)
      if (await isReachable(v)) candidates.push(v)
      if (candidates.length === 0) {
        // Nothing verified reachable — still try the mirror, then the original blindly.
        if (mirrorUrl) candidates.push(mirrorUrl)
        candidates.push(v)
      }
      let best: string | null = null
      for (const candidate of candidates) {
        const wire = await resolveExternalAsset(candidate, token)
        if (!wire) continue
        if (wire.startsWith('mp:')) { best = wire; break } // canonical — use immediately
        if (!best) best = wire // low-confidence fallback (bare media proxy URL)
      }
      if (best) {
        console.log(`[DiscordAssets] Resolved ${v.slice(0, 100)} → ${best.slice(0, 90)} (external, animated-capable)`)
        await rememberResolved(v, best)
        return best
      }
    }

    // 3) Fallback: uploaded application asset → asset ID (static image).
    //    Prefer a previously uploaded asset (legacy cache rows hold its key)
    //    before uploading a fresh copy.
    let wire: string | null = null
    const legacy = await findCachedLegacyValueForUrl(v)
    if (legacy && !isWireFormat(legacy)) {
      const map = await getAppAssetMap()
      const asset = map.get(legacy.toLowerCase())
      if (asset?.asset_id) wire = asset.asset_id
    }
    if (!wire) {
      const bytes = downloaded?.bytes ?? null
      const contentType = downloaded?.contentType ?? 'image/png'
      if (bytes) {
        const hash = crypto.createHash('sha1').update(v).update(bytes).digest('hex').slice(0, 10)
        const keyBase = `img-${hash}`
        const ext = extFromContentType(contentType, v)
        const key = await uploadAssetBuffer(keyBase, bytes, contentType, `${keyBase}.${ext}`)
        if (key) {
          assetMapCache = null // force refresh so the new key is mapped
          const map = await getAppAssetMap()
          const asset = map.get(key.toLowerCase())
          wire = asset?.asset_id ?? key
          console.log(`[DiscordAssets] Uploaded ${v.slice(0, 100)} → asset "${key}" (id ${asset?.asset_id ?? '?'})`)
        }
      }
    }
    if (wire) {
      await rememberResolved(v, wire)
      return wire
    }

    console.error(`[DiscordAssets] Could not resolve to a renderable asset — image will be omitted: ${v.slice(0, 140)}`)
    negCache.set(v, Date.now() + NEGATIVE_TTL_MS)
    return null
  })().finally(() => {
    inFlight.delete(v)
  })

  inFlight.set(v, task)
  return task
}

async function isReachable(url: string): Promise<boolean> {
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), REACHABILITY_TIMEOUT_MS)
    const res = await fetch(url, { method: 'HEAD', signal: ctrl.signal, headers: { 'User-Agent': '10X-RPC/2.0 (asset pipeline)' } })
    clearTimeout(timer)
    if (res.ok) return true
    // Some hosts reject HEAD — allow GET when HEAD fails.
    const res2 = await fetch(url, { method: 'GET', headers: { 'User-Agent': '10X-RPC/2.0', Range: 'bytes=0-64' }, signal: ctrl.signal })
    return res2.ok
  } catch {
    return false
  }
}

/* ------------------------------ sanitizers ------------------------------- */

/**
 * Wire formats Discord clients render inside assets.large_image/small_image:
 *   • asset IDs (digits)          → app-assets CDN
 *   • mp:external/<hash>/https/…  → media proxy (animated GIF capable)
 *   • spotify:<id>                → built-in integration
 *   • https://media.discordapp.net/… → Discord's OWN media proxy — the exact
 *     value the external-assets endpoint returns for Discord-CDN attachment
 *     URLs; clients that accept Social SDK external images render it.
 * EVERYTHING else (arbitrary http(s) URLs, unknown keys) is silently dropped
 * or shows an empty slot — strip it before the OP 3 leaves this process.
 */
const ALLOWED_ASSET_URL = /^https:\/\/media\.discordapp\.net\//i
const RAW_URL_IN_ASSETS = /^https?:\/\//i

export function sanitizeActivityAssets<T extends Record<string, unknown>>(activity: T): T {
  const assets = (activity as { assets?: Record<string, unknown> }).assets
  if (!assets) return activity
  let changed = false
  const cleaned: Record<string, unknown> = { ...assets }
  for (const field of ['large_image', 'small_image']) {
    const v = cleaned[field]
    if (typeof v === 'string' && RAW_URL_IN_ASSETS.test(v) && !ALLOWED_ASSET_URL.test(v)) {
      console.error(`[DiscordAssets] Stripped raw URL from assets.${field} (Discord would drop it): ${v.slice(0, 120)}`)
      delete cleaned[field]
      changed = true
    }
  }
  if (changed) {
    if (Object.keys(cleaned).length === 0) {
      const { assets: _drop, ...rest } = activity as Record<string, unknown>
      return rest as T
    }
    return { ...activity, assets: cleaned }
  }
  return activity
}

export function sanitizeActivities<T extends Record<string, unknown>>(activities: T[]): T[] {
  return activities.map((a) => sanitizeActivityButtons(sanitizeActivityAssets(a)))
}

/**
 * Buttons wire-format guard: Discord's gateway presence accepts `buttons` as an
 * array of LABEL STRINGS only (URLs belong in `metadata.button_urls`). An array
 * of {label,url} objects is invalid and — proven live — makes Discord silently
 * drop the ENTIRE activity (the "saving Button Config turns the RPC off" bug).
 * Coerce any malformed value into the accepted string format before sending.
 */
export function sanitizeActivityButtons<T extends Record<string, unknown>>(activity: T): T {
  const buttons = (activity as { buttons?: unknown }).buttons
  if (!Array.isArray(buttons)) return activity

  const labels: string[] = []
  const urls: string[] = []
  let changed = false
  for (const b of buttons) {
    if (typeof b === 'string') {
      if (b.length > 0) labels.push(b)
      else changed = true
    } else if (b && typeof b === 'object' && typeof (b as { label?: unknown }).label === 'string') {
      changed = true // object form → coerce to the wire format
      const { label, url } = b as { label: string; url?: unknown }
      labels.push(label)
      if (typeof url === 'string' && url.length > 0) urls.push(url)
    } else if (b != null) {
      changed = true // anything else → drop the entry
    }
  }

  const meta = (activity as { metadata?: { button_urls?: unknown } }).metadata
  const metaUrls = Array.isArray(meta?.button_urls)
    ? (meta!.button_urls as unknown[]).filter((u): u is string => typeof u === 'string')
    : []
  const finalUrls = urls.length > 0 ? (urls.length >= metaUrls.length ? urls : metaUrls) : metaUrls

  if (!changed && labels.length === buttons.length && (finalUrls.length === 0 || meta?.button_urls != null)) {
    return activity // already valid string form with metadata — nothing to do
  }

  const cleaned: Record<string, unknown> = { ...activity, buttons: labels }
  if (labels.length > 0 && finalUrls.length > 0) {
    cleaned.metadata = { ...(meta || {}), button_urls: finalUrls }
  } else {
    delete cleaned.metadata // labels without URLs would render dead buttons
  }
  console.error(
    `[DiscordAssets] Coerced malformed activity.buttons to wire format (strings) — ` +
      `object/mixed values make Discord drop the whole activity: ${JSON.stringify(buttons).slice(0, 160)}`
  )
  return cleaned as T
}

/**
 * Upload every icon in public/games/* as a named application asset.
 * Used by a one-time maintenance script; asset keys match game preset keys.
 */
export async function uploadPresetAssets(files: Array<{ key: string; path: string }>): Promise<Record<string, string | null>> {
  const results: Record<string, string | null> = {}
  const fs = await import('fs')
  for (const { key, path } of files) {
    try {
      const bytes = fs.readFileSync(path)
      const ct = path.endsWith('.png') ? 'image/png' : path.endsWith('.gif') ? 'image/gif' : 'image/jpeg'
      const k = await uploadAssetBuffer(key, bytes, ct, `${sanitizeKey(key)}.${path.endsWith('.png') ? 'png' : path.endsWith('.gif') ? 'gif' : 'jpg'}`)
      results[key] = k
      if (k) console.log(`[DiscordAssets] Preset "${key}" uploaded as "${k}"`)
    } catch (err) {
      console.error(`[DiscordAssets] Preset "${key}" failed:`, err)
      results[key] = null
    }
  }
  return results
}
