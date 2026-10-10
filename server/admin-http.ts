import type { AdminHandler } from './admin-files.js'
import { ReleaseAdmin } from './release-admin.js'
import { MediaStore } from './media-store.js'
import type { ContentSync } from './content-sync.js'
import { GuideError } from './guide-store.js'
import type { KnowledgeStore } from './knowledge-store.js'
import { parseReleaseManifest } from './release-manifest.js'
import type { ExpertStore } from './expert-store.js'
import { handleExpertAdmin } from './expert-http.js'

export function createAdminHandler(releases: ReleaseAdmin, media: MediaStore, sync?: ContentSync, knowledge?: KnowledgeStore, experts?: ExpertStore): AdminHandler {
  return async (req, res, url, { json, method, body }) => {
    if (experts && await handleExpertAdmin(experts, req, res, url, { json, method, body })) return true
    if (url.pathname === '/api/admin/knowledge' || url.pathname.startsWith('/api/admin/knowledge/')) {
      if (!knowledge) throw new GuideError('CONTENT_UNAVAILABLE', 503)
      if (url.pathname === '/api/admin/knowledge') {
        method(req, ['GET', 'POST'])
        if (req.method === 'GET') json(res, await knowledge.list())
        else { const data = await body(req); json(res, await knowledge.create(data.entry, data.revision)) }
        return true
      }
      if (url.pathname === '/api/admin/knowledge/compatibility') {
        method(req, ['PUT'])
        const data = await body(req)
        json(res, await knowledge.resolveLegacySkill(data.legacy_skill_name, data.revision)); return true
      }
      if (url.pathname === '/api/admin/knowledge/skill' || url.pathname === '/api/admin/knowledge/skills') {
        method(req, url.pathname.endsWith('/skills') ? ['POST'] : ['POST', 'DELETE'])
        json(res, req.method === 'POST'
          ? await knowledge.attachSkill(url.searchParams.get('name') ?? '', req, req.headers['x-revision'])
          : await knowledge.detachSkill((await body(req)).revision))
        return true
      }
      const skillTarget = /^\/api\/admin\/knowledge\/skills\/([^/]+)$/.exec(url.pathname)
      if (skillTarget) {
        method(req, ['DELETE'])
        json(res, await knowledge.detachSkill((await body(req)).revision, decodeURIComponent(skillTarget[1]!)))
        return true
      }
      const target = /^\/api\/admin\/knowledge\/([^/]+)$/.exec(url.pathname)
      if (!target) throw new GuideError('NOT_FOUND', 404)
      const id = decodeURIComponent(target[1]!)
      method(req, ['PUT', 'DELETE'])
      const data = await body(req)
      json(res, req.method === 'PUT' ? await knowledge.update(id, data.entry, data.revision) : await knowledge.remove(id, data.revision))
      return true
    }
    if (url.pathname === '/api/admin/content-sync') {
      method(req, ['GET', 'POST'])
      if (!sync) throw new GuideError('CONTENT_SYNC_UNAVAILABLE', 503)
      if (req.method === 'GET') json(res, await sync.preview())
      else { const data = await body(req); if (Object.keys(data).some(key => key !== 'revision')) throw new GuideError('INVALID_REQUEST'); json(res, await sync.apply(data.revision)) }
      return true
    }
    if (url.pathname === '/api/admin/images') {
      method(req, ['GET','POST'])
      json(res, req.method === 'GET' ? { images: await media.list() } : { image: await media.upload(req, url.searchParams.get('name') ?? '') })
      return true
    }
    if (url.pathname === '/api/admin/releases/manifest') {
      method(req, ['POST'])
      json(res, { manifest: parseReleaseManifest((await body(req)).manifest) }); return true
    }
    if (url.pathname === '/api/admin/releases') {
      method(req, ['GET','POST'])
      json(res, req.method === 'GET' ? await releases.list() : { draft: await releases.create((await body(req)).draft) }); return true
    }
    const published = /^\/api\/admin\/releases\/published\/([^/]+)$/.exec(url.pathname)
    if (published) {
      method(req, ['PUT']); const data = await body(req)
      json(res, { release: await releases.update(decodeURIComponent(published[1]!), data.release, data.revision) }); return true
    }
    const match = /^\/api\/admin\/releases\/drafts\/([^/]+)(?:\/(files|publish|manifest))?$/.exec(url.pathname)
    if (!match) return false
    const id = match[1]!, action = match[2]
    if (action === 'manifest') {
      method(req, ['PUT']); const data = await body(req)
      json(res, { draft: await releases.attachManifest(id, data.manifest, data.revision) })
    } else if (action === 'files') {
      method(req, ['POST','DELETE']); const name = url.searchParams.get('name') ?? ''
      json(res, { draft: req.method === 'POST' ? await releases.upload(id, name, req, req.headers['x-revision']) : await releases.removeFile(id, name, (await body(req)).revision) })
    } else if (action === 'publish') {
      method(req, ['POST']); const data = await body(req), controller = new AbortController()
      const abort = () => { if (!res.writableEnded) controller.abort() }
      res.once('close', abort)
      const timer = setTimeout(() => controller.abort(), 30 * 60 * 1000)
      try { json(res, { release: await releases.publish(id, data.revision, controller.signal) }) }
      finally { clearTimeout(timer); res.off('close', abort) }
    } else {
      method(req, ['GET','PUT','DELETE'])
      if (req.method === 'GET') json(res, { draft: await releases.get(id) })
      else { const data = await body(req); if (req.method === 'PUT') json(res, { draft: await releases.save(id, data.draft, data.revision) }); else { await releases.discard(id, data.revision); json(res, { removed: true }) } }
    }
    return true
  }
}
