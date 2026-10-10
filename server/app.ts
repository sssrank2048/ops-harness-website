import type { IncomingMessage, ServerResponse } from 'node:http'
import path from 'node:path'
import { stringify } from 'yaml'
import { CheckQuerySchema, FileNameSchema, PlatformSchema, platforms, VersionSchema } from '@dsh-ops/release-contract'
import { archiveUrl } from './website-url.js'
import type { WebsiteConfig } from './config.js'
import { decideUpdate, readCatalog, visibleReleases } from './catalog.js'
import { serveFile } from './files.js'
import { GuideError } from './guide-store.js'
import type { KnowledgeStore } from './knowledge-store.js'
import type { ExpertStore } from './expert-store.js'
import { createExpertPublicHandler } from './expert-http.js'

type DevMiddleware = (req: IncomingMessage, res: ServerResponse, next: () => void) => void
export function createHandler(config: WebsiteConfig, options: { clientRoot: string; adminIconHash?: string; dev?: DevMiddleware; guide?: (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<boolean>; knowledge?: KnowledgeStore; experts?: ExpertStore; now?: () => number; onError?: (error: unknown) => void }) {
  if (options.adminIconHash && !/^[A-Za-z0-9+/]{43}=$/.test(options.adminIconHash)) throw new Error('Invalid administrator icon hash')
  const json = (req: IncomingMessage, res: ServerResponse, code: number, data: unknown) => {
    const body = JSON.stringify(data)
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store' })
    res.end(req.method === 'HEAD' ? undefined : body)
  }
  const experts = options.experts ? createExpertPublicHandler(options.experts, options.now ? { now: options.now } : {}) : undefined
  return async (req: IncomingMessage, res: ServerResponse) => {
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Referrer-Policy', 'no-referrer')
    res.setHeader('X-Frame-Options', 'DENY')
    try {
      if ((req.url?.length ?? 0) > 4096) { json(req, res, 414, { error: 'URL_TOO_LONG' }); return }
      const url = new URL(req.url ?? '/', config.websiteUrl)
      if (url.pathname === '/guide/admin' || url.pathname === '/admin/') {
        res.writeHead(308, { Location: '/admin', 'Cache-Control': 'no-store' }); res.end(); return
      }
      if (url.pathname === '/admin') {
        res.setHeader('Cache-Control', 'no-store')
        res.setHeader('X-Robots-Tag', 'noindex, nofollow')
      }
      if (options.guide && await options.guide(req, res, url)) return
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.setHeader('Allow', 'GET, HEAD'); json(req, res, 405, { error: 'METHOD_NOT_ALLOWED' }); return }
      if (url.pathname === '/health') { json(req, res, 200, { status: 'ok' }); return }
      if (url.pathname === '/api/releases/check') {
        const query = CheckQuerySchema.safeParse(Object.fromEntries(url.searchParams))
        const keys = Array.from(url.searchParams.keys())
        if (!query.success || new Set(keys).size !== keys.length) { json(req, res, 400, { error: 'INVALID_UPDATE_QUERY' }); return }
        const catalog = await readCatalog(config.releaseDirectory)
        json(req, res, 200, decideUpdate(catalog, query.data, config.websiteUrl, options.now?.()))
        return
      }
      if (url.pathname === '/api/releases') {
        const catalog = await readCatalog(config.releaseDirectory)
        const releases = visibleReleases(catalog, options.now?.()).map(r => ({
          version: r.version, title: r.title, notes: r.notes, publishedAt: r.publishedAt,
          downloads: platforms.flatMap(platform => (r.targets[platform]?.downloads ?? []).filter(f => !f.name.endsWith('.blockmap')).map(f => ({
            ...f, platform, url: `${archiveUrl(config.websiteUrl, r.version, platform)}${encodeURIComponent(f.name)}`,
          }))),
        }))
        json(req, res, 200, { schemaVersion: 1, releases }); return
      }
      if (url.pathname.startsWith('/updates/')) {
        const parts = url.pathname.split('/').slice(1).map(decodeURIComponent)
        const [updates, archive, version, platform, file] = parts
        if (parts.length !== 5 || updates !== 'updates' || archive !== 'archive' || !VersionSchema.safeParse(version).success || !PlatformSchema.safeParse(platform).success) {
          json(req, res, 404, { error: 'RELEASE_NOT_FOUND' }); return
        }
        const platformKey = PlatformSchema.parse(platform)
        const release = visibleReleases(await readCatalog(config.releaseDirectory), options.now?.()).find(r => r.version === version)
        const target = release?.targets[platformKey]
        if (!release || !target) { json(req, res, 404, { error: 'RELEASE_NOT_FOUND' }); return }
        if (file === (platformKey === 'windows-x64' ? 'latest.yml' : 'latest-mac.yml')) {
          const artifact = target.artifact
          const body = stringify({ version, files: [{ url: encodeURIComponent(artifact.name), sha512: artifact.sha512, size: artifact.size }],
            path: encodeURIComponent(artifact.name), sha512: artifact.sha512, releaseDate: release.publishedAt })
          res.writeHead(200, { 'Content-Type': 'application/yaml; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(body) })
          res.end(req.method === 'HEAD' ? undefined : body); return
        }
        const artifact = target.downloads.find(f => f.name === file)
        if (!artifact || !FileNameSchema.safeParse(file).success) { json(req, res, 404, { error: 'FILE_NOT_FOUND' }); return }
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
        await serveFile(req, res, config.releaseDirectory, ['archive', version!, platformKey, artifact.name], {
          type: 'application/octet-stream', expectedSize: artifact.size, etag: `"${artifact.sha512}"`, attachment: artifact.name,
        }); return
      }
      if (options.knowledge && url.pathname.startsWith('/api/knowledge/metrics')) {
        const store = options.knowledge
        try {
          if (url.pathname === '/api/knowledge/metrics' || url.pathname === '/api/knowledge/metrics/v2') {
            const catalog = url.pathname.endsWith('/v2') ? await store.publicListV2() : await store.publicList()
            const etag = `"${catalog.revision}"`
            if (req.headers['if-none-match'] === etag) { res.writeHead(304, { ETag: etag, 'Cache-Control': 'no-store' }); res.end(); return }
            res.setHeader('ETag', etag)
            json(req, res, 200, catalog); return
          }
          const skillTarget = /^\/api\/knowledge\/metrics\/skills\/([^/]+)$/.exec(url.pathname)
          const versionTarget = /^\/api\/knowledge\/metrics\/v2\/skills\/([^/]+)\/([^/]+)$/.exec(url.pathname)
          if (url.pathname !== '/api/knowledge/metrics/skill' && !skillTarget && !versionTarget) { json(req, res, 404, { error: 'NOT_FOUND' }); return }
          const file = versionTarget ? await store.openSkillVersion(decodeURIComponent(versionTarget[1]!), decodeURIComponent(versionTarget[2]!)) : await store.openSkill(skillTarget ? decodeURIComponent(skillTarget[1]!) : undefined)
          // The address is fixed while the file is replaceable, so revalidate on the content hash instead of caching.
          res.setHeader('Cache-Control', versionTarget ? 'public, max-age=31536000, immutable' : 'no-store')
          res.setHeader('X-Skill-Name', file.name)
          res.setHeader('X-Skill-Sha256', file.sha256)
          await serveFile(req, res, file.root, file.segments, { type: file.type, expectedSize: file.size, etag: `"${file.sha256}"`, attachment: file.fileName })
        } catch (error) {
          if (!(error instanceof GuideError)) throw error
          json(req, res, error.status, { error: error.code })
        }
        return
      }
      if (experts && await experts(req, res, url)) return
      if (url.pathname.startsWith('/api/')) { json(req, res, 404, { error: 'NOT_FOUND' }); return }
      if (options.dev) {
        options.dev(req, res, () => json(req, res, 404, { error: 'NOT_FOUND' })); return
      }
      const editorStyle = url.pathname === '/admin' ? " 'unsafe-inline'" : ''
      const editorScript = url.pathname === '/admin' && options.adminIconHash ? ` 'sha256-${options.adminIconHash}'` : ''
      res.setHeader('Content-Security-Policy', `default-src 'self'; script-src 'self'${editorScript}; style-src 'self'${editorStyle}; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'none'`)
      const page = ['/', '/guide', '/admin', '/releases'].includes(url.pathname)
      const segments = page ? ['index.html'] : url.pathname.slice(1).split('/').map(decodeURIComponent)
      const ext = path.extname(segments.at(-1) ?? '')
      const types: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.woff2': 'font/woff2' }
      if (!page && (!types[ext] || (!url.pathname.startsWith('/assets/') && url.pathname !== '/brand.svg'))) { json(req, res, 404, { error: 'NOT_FOUND' }); return }
      res.setHeader('Cache-Control', url.pathname === '/admin' ? 'no-store' : page ? 'no-cache' : 'public, max-age=3600')
      await serveFile(req, res, options.clientRoot, segments, { type: types[ext]! })
    } catch (error) {
      options.onError?.(error)
      if (res.headersSent) { res.destroy(); return }
      const missing = (error as NodeJS.ErrnoException).code === 'ENOENT'
      const badUrl = error instanceof URIError || error instanceof TypeError
      json(req, res, missing ? 404 : badUrl ? 400 : 503, { error: missing ? 'FILE_NOT_FOUND' : badUrl ? 'INVALID_REQUEST' : 'RELEASE_SERVICE_UNAVAILABLE' })
    }
  }
}
