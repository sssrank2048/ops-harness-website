import { crc32, deflateRawSync } from 'node:zlib'
import { createHash } from 'node:crypto'
import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { GuideStore, encodeChapter } from '../server/guide-store.js'
import { MediaStore } from '../server/media-store.js'
import { ReleaseAdmin } from '../server/release-admin.js'
import { KnowledgeStore } from '../server/knowledge-store.js'
import { createAdminHandler } from '../server/admin-http.js'
import { createGuideHandler } from '../server/guide-http.js'
import { createHandler } from '../server/app.js'
import { maxKnowledgeSkills, maxKnowledgeWorkflows, maxWorkflowName, maxWorkflowValue, maxSkillFileBytes, maxTypicalIndicators } from '../shared/knowledge.js'

// Minimal writer: local headers + central directory + EOCD, deflate only, no data descriptors.
function archive(files: { name: string; data?: Buffer }[]) {
  const locals: Buffer[] = [], central: Buffer[] = []
  let offset = 0
  for (const file of files) {
    const name = Buffer.from(file.name, 'utf8'), plain = file.data ?? Buffer.alloc(0)
    const deflated = deflateRawSync(plain), crc = crc32(plain)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0, 6); local.writeUInt16LE(8, 8)
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(deflated.length, 18); local.writeUInt32LE(plain.length, 22)
    local.writeUInt16LE(name.length, 26); local.writeUInt16LE(0, 28)
    const header = Buffer.concat([local, name, deflated])
    const record = Buffer.alloc(46)
    record.writeUInt32LE(0x02014b50, 0); record.writeUInt16LE(20, 4); record.writeUInt16LE(20, 6); record.writeUInt16LE(0, 8); record.writeUInt16LE(8, 10)
    record.writeUInt32LE(crc, 16); record.writeUInt32LE(deflated.length, 20); record.writeUInt32LE(plain.length, 24)
    record.writeUInt16LE(name.length, 28); record.writeUInt32LE(offset, 42)
    locals.push(header); central.push(Buffer.concat([record, name]))
    offset += header.length
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, directory, end])
}
const skillMarkdown = (name = 'metric-skill', description = '指标知识库配套技能，说明检索口径。') =>
  Buffer.from(`---\nname: ${name}\ndescription: ${description}\n---\n\n# 使用说明\n\n先取卡片索引，再取口径。\n`, 'utf8')
function entry(extra: Record<string, unknown> = {}) {
  return {
    tenant_name: '示例零售', tenant_id: 'tenant-retail',
    knowledge_retrieve_workflow_id: { get_card_index: 'wf-card-index', get_card_meta: 'wf-card-meta', query_card_data: 'wf-card-data' },
    knowledge_id: { card_index_knowledge_base: 'kb-card-index', card_meta_knowledge_base: 'kb-card-meta' },
    knowledge_base_meta: {
      knowledge_description: '零售业务的核心指标口径与报表说明。', indicators_cover: '1,200 项', reports_cover: '32 张', update_frequency: '每日 07:00',
      typical_indicators: ['GMV', '动销率'],
    },
    enabled: true, skill_name: null, ...extra,
  }
}
async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), 'website-knowledge-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const source = path.join(root, 'repository/content'), seed = path.join(source, 'guide')
  await mkdir(seed, { recursive: true })
  await writeFile(path.join(seed, 'one.md'), encodeChapter({ id: 'one', title: '入门', group: '入门', order: 10, summary: '', archived: false, markdown: '# 正文\n' }))
  const content = path.join(root, 'content')
  const guides = new GuideStore(seed, content), media = new MediaStore(content, source), releases = new ReleaseAdmin(path.join(root, 'releases'))
  const knowledge = new KnowledgeStore(content)
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) })
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  const guide = await createGuideHandler(guides, { origin, password: 'test-admin-password-only', admin: createAdminHandler(releases, media, undefined, knowledge) })
  server.on('request', createHandler({ schemaVersion: 1, websiteUrl: origin, host: '127.0.0.1', port: 4173, releaseDirectory: releases.root, contentDirectory: content, adminPasswordEnv: 'DSH_OPS_WEBSITE_ADMIN_PASSWORD', configPath: 'test' },
    { clientRoot: root, knowledge, guide: async (req, res, url) => await media.serve(req, res, url) || await guide(req, res, url) }))
  const login = await fetch(origin + '/api/admin/login', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'test-admin-password-only' }) })
  const session = await login.json(), headers = { Cookie: login.headers.get('set-cookie')!.split(';')[0]!, Origin: origin, 'X-CSRF-Token': session.csrf }
  const json = (url: string, data: unknown, method = 'POST') => fetch(origin + url, { method, headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(data) })
  const upload = (url: string, bytes: Buffer, extra: Record<string, string> = {}) =>
    fetch(origin + url, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/octet-stream', ...extra }, body: bytes })
  const read = () => fetch(origin + '/api/admin/knowledge', { headers }).then(r => r.json())
  return { root, origin, content, headers, json, upload, read, knowledge }
}

test('knowledge entries are created, edited and removed under revision control and reject invalid input', async t => {
  const { json, read, knowledge, content } = await fixture(t)
  let state = await read()
  assert.deepEqual(state.items, []); assert.equal(state.schemaVersion, 2)
  assert.equal((await json('/api/admin/knowledge', { entry: entry(), revision: 'stale' })).status, 409)
  let response = await json('/api/admin/knowledge', { entry: entry(), revision: state.revision })
  assert.equal(response.status, 200)
  let created = await response.json()
  assert.match(created.entry.id, /^metrics-[a-f0-9]{10}$/)
  assert.equal(created.entry.knowledge_retrieve_workflow_id.query_card_data, 'wf-card-data')
  assert.equal(created.entry.created_at, created.entry.updated_at)
  const id = created.entry.id
  assert.equal((await json('/api/admin/knowledge', { entry: entry({ id, tenant_id: 'tenant-other' }), revision: created.revision })).status, 409)
  assert.equal((await (await json('/api/admin/knowledge', { entry: entry({ id, tenant_id: 'tenant-other' }), revision: created.revision })).json()).error, 'KNOWLEDGE_ID_TAKEN')
  assert.equal((await (await json('/api/admin/knowledge', { entry: entry({ id: 'metrics-second' }), revision: created.revision })).json()).error, 'TENANT_ID_TAKEN')
  for (const invalid of [entry({ id: 'Metrics-Bad' }), entry({ id: 'wrong-prefix' }), entry({ tenant_name: '' }), entry({ enabled: 'yes' }),
    entry({ knowledge_base_meta: { knowledge_description: '描述', typical_indicators: Array.from({ length: maxTypicalIndicators + 1 }, (_, i) => `指标${i}`) } }),
    entry({ knowledge_retrieve_workflow_id: { '': 'value' } }), entry({ extra: true })]) {
    const rejected = await json('/api/admin/knowledge', { entry: invalid, revision: created.revision })
    assert.equal(rejected.status, 400); assert.equal((await rejected.json()).error, 'INVALID_KNOWLEDGE')
  }
  response = await json(`/api/admin/knowledge/${id}`, { entry: entry({ tenant_name: '示例零售集团', enabled: false }), revision: created.revision }, 'PUT')
  assert.equal(response.status, 200)
  const updated = await response.json()
  assert.equal(updated.entry.tenant_name, '示例零售集团'); assert.equal(updated.entry.enabled, false)
  assert.equal(updated.entry.created_at, created.entry.created_at)
  assert.notEqual(updated.revision, created.revision)
  assert.equal((await json(`/api/admin/knowledge/${id}`, { entry: entry(), revision: created.revision }, 'PUT')).status, 409)
  assert.equal((await (await json(`/api/admin/knowledge/${id}`, { entry: entry({ id: 'metrics-renamed' }), revision: updated.revision }, 'PUT')).json()).error, 'INVALID_KNOWLEDGE')
  assert.equal((await (await json('/api/admin/knowledge/metrics-missing', { entry: entry(), revision: updated.revision }, 'PUT')).json()).error, 'KNOWLEDGE_NOT_FOUND')
  assert.ok((await readdir(path.join(content, 'knowledge/.trash'))).some(name => /^catalog-.*\.json$/.test(name)))
  // A second store on the same directory reads the persisted state, including the revision.
  state = await new KnowledgeStore(content).list()
  assert.equal(state.revision, updated.revision); assert.equal(state.items.length, 1)
  assert.equal((await json(`/api/admin/knowledge/${id}`, { revision: created.revision }, 'DELETE')).status, 409)
  const removed = await json(`/api/admin/knowledge/${id}`, { revision: updated.revision }, 'DELETE')
  assert.equal(removed.status, 200); assert.equal((await removed.json()).revision, (await knowledge.list()).revision)
  assert.deepEqual((await read()).items, [])
})

test('the public catalog omits withdrawn entries, answers If-None-Match and never lists admin-only state', async t => {
  const { json, read, origin } = await fixture(t)
  const base = await read()
  const first = await (await json('/api/admin/knowledge', { entry: entry({ id: 'metrics-retail' }), revision: base.revision })).json()
  const second = await (await json('/api/admin/knowledge', { entry: entry({ id: 'metrics-hidden', tenant_id: 'tenant-hidden', enabled: false }), revision: first.revision })).json()
  const response = await fetch(origin + '/api/knowledge/metrics')
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  const etag = response.headers.get('etag')
  assert.notEqual(etag, `"${second.revision}"`)
  const catalog = await response.json()
  assert.equal(catalog.schemaVersion, 1); assert.equal(etag, `"${catalog.revision}"`)
  assert.deepEqual(catalog.items.map((item: { id: string }) => item.id), ['metrics-retail'])
  assert.equal(catalog.items[0].skill_name, undefined)
  assert.equal(catalog.items[0].knowledge_retrieve_workflow_id.quer_card_data, 'wf-card-data')
  assert.equal(catalog.updatedAt, second.updatedAt)
  const cached = await fetch(origin + '/api/knowledge/metrics', { headers: { 'If-None-Match': etag! } })
  assert.equal(cached.status, 304); assert.equal(cached.headers.get('etag'), etag)
  assert.equal((await cached.text()).length, 0)
  assert.equal((await fetch(origin + '/api/knowledge/metrics', { headers: { 'If-None-Match': '"other"' } })).status, 200)
  assert.equal((await fetch(origin + '/api/knowledge/metrics', { method: 'POST' })).status, 405)
  assert.equal((await fetch(origin + '/api/knowledge/metrics/metrics-retail')).status, 404)
})

test('multiple skills are registered, referenced by library and replaced by stable name without losing references', async t => {
  const { json, upload, read, origin, content } = await fixture(t)
  const base = await read()
  let current = await (await json('/api/admin/knowledge', { entry: entry({ id: 'metrics-retail' }), revision: base.revision })).json()
  const api = '/api/admin/knowledge/skills'
  const publicSkill = (name: string) => origin + '/api/knowledge/metrics/skills/' + name
  assert.equal((await fetch(publicSkill('metric-skill'))).status, 404)
  assert.equal((await (await fetch(origin + '/api/knowledge/metrics/skill')).json()).error, 'SKILL_NOT_FOUND')
  const packaged = archive([{ name: 'metric-skill/' }, { name: 'metric-skill/SKILL.md', data: skillMarkdown() }, { name: 'metric-skill/references/glossary.md', data: Buffer.from('# 词表\n') }])
  let response = await upload(`${api}?name=metric-skill.zip`, packaged, { 'X-Revision': current.revision })
  assert.equal(response.status, 200)
  current = await response.json()
  assert.equal(current.skill.name, 'metric-skill')
  assert.equal(current.skill.kind, 'zip')
  assert.equal(current.skill.file_name, 'metric-skill.zip')
  assert.equal(current.skill.size, packaged.length)
  assert.equal(current.skill.sha256, createHash('sha256').update(packaged).digest('hex'))
  assert.deepEqual(current.skills, [current.skill])
  assert.deepEqual(await readdir(path.join(content, 'knowledge/skills')), [`${current.skill.sha256}.zip`])
  const listed = await read()
  assert.equal(listed.skills[0].sha256, current.skill.sha256)
  assert.equal(listed.items[0].skill_name, null)
  assert.equal(listed.items[0].skill, undefined)
  const pub = await (await fetch(origin + '/api/knowledge/metrics/v2')).json()
  assert.equal(pub.skills[0].name, 'metric-skill'); assert.equal(pub.items[0].skill, undefined)
  const download = await fetch(publicSkill('metric-skill'))
  assert.equal(download.status, 200)
  assert.equal(download.headers.get('content-type'), 'application/zip')
  assert.equal(download.headers.get('etag'), `"${current.skill.sha256}"`)
  assert.equal(download.headers.get('x-skill-name'), 'metric-skill')
  assert.equal(download.headers.get('x-skill-sha256'), current.skill.sha256)
  assert.equal(download.headers.get('cache-control'), 'no-store')
  assert.match(download.headers.get('content-disposition')!, /metric-skill\.zip$/)
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), packaged)
  assert.equal((await fetch(publicSkill('metric-skill'), { headers: { 'If-None-Match': `"${current.skill.sha256}"` } })).status, 304)
  assert.equal((await fetch(origin + '/api/knowledge/metrics/skill')).status, 404)
  const flat = archive([{ name: 'SKILL.md', data: skillMarkdown('flat-skill') }])
  current = await (await upload(`${api}?name=flat.zip`, flat, { 'X-Revision': current.revision })).json()
  assert.equal(current.skill.name, 'flat-skill')
  assert.equal(current.skills.length, 2)
  // A fresh catalog with no historical public skill must not invent an identity from uploaded skills.
  assert.equal((await (await fetch(origin + '/api/knowledge/metrics/skill')).json()).error, 'SKILL_NOT_FOUND')
  assert.equal((await (await json('/api/admin/knowledge/skill', { revision: current.revision }, 'DELETE')).json()).error, 'SKILL_NOT_FOUND')
  current = await (await json('/api/admin/knowledge/metrics-retail', { entry: entry({ skill_name: 'metric-skill' }), revision: current.revision }, 'PUT')).json()
  assert.equal(current.entry.skill_name, 'metric-skill')
  current = await (await json('/api/admin/knowledge', { entry: entry({ id: 'metrics-media', tenant_id: 'tenant-media', enabled: false, skill_name: 'flat-skill' }), revision: current.revision })).json()
  assert.equal(current.entry.skill_name, 'flat-skill')
  const invalid = await json('/api/admin/knowledge/metrics-retail', { entry: entry({ skill_name: 'unknown-skill' }), revision: current.revision }, 'PUT')
  assert.equal(invalid.status, 400); assert.equal((await invalid.json()).error, 'INVALID_SKILL_REFERENCE')
  assert.equal((await json('/api/admin/knowledge/metrics-retail', { entry: entry({ skill_name: ['flat-skill', 'flat-skill'] }), revision: current.revision }, 'PUT')).status, 400)
  const previous = listed.skills[0].sha256
  const plain = skillMarkdown('metric-skill', '新版指标技能')
  current = await (await upload(`${api}?name=SKILL.md`, plain, { 'X-Revision': current.revision })).json()
  assert.equal(current.skill.kind, 'md'); assert.equal(current.skills.length, 2)
  assert.equal((await read()).items[0].skill_name, 'metric-skill')
  const replaced = await fetch(publicSkill('metric-skill'), { headers: { 'If-None-Match': `"${previous}"` } })
  assert.equal(replaced.status, 200)
  assert.equal(replaced.headers.get('etag'), `"${current.skill.sha256}"`)
  assert.equal(replaced.headers.get('content-type'), 'text/markdown; charset=utf-8')
  assert.deepEqual(Buffer.from(await replaced.arrayBuffer()), plain)
  current = await (await upload(`${api}?name=again.md`, plain, { 'X-Revision': current.revision })).json()
  assert.equal((await readdir(path.join(content, 'knowledge/skills'))).length, 3)
  // A legacy editor omitting the new field must not clear explicit references.
  const withoutReferences = entry(); delete (withoutReferences as Record<string, unknown>).skill_name
  current = await (await json('/api/admin/knowledge/metrics-retail', { entry: withoutReferences, revision: current.revision }, 'PUT')).json()
  assert.equal(current.entry.skill_name, 'metric-skill')
  for (const [name, bytes] of [
    ['escape.zip', archive([{ name: '../SKILL.md', data: skillMarkdown() }])],
    ['backslash.zip', archive([{ name: 'metric-skill\\SKILL.md', data: skillMarkdown() }])],
    ['absent.zip', archive([{ name: 'metric-skill/README.md', data: Buffer.from('# 空\n') }])],
    ['twice.zip', archive([{ name: 'SKILL.md', data: skillMarkdown() }, { name: 'metric-skill/SKILL.md', data: skillMarkdown() }])],
    ['mismatch.zip', archive([{ name: 'other-name/SKILL.md', data: skillMarkdown('metric-skill') }])],
    ['sibling.zip', archive([{ name: 'metric-skill/SKILL.md', data: skillMarkdown() }, { name: 'extra/notes.md', data: Buffer.from('x') }])],
    ['deep.zip', archive([{ name: 'a/b/SKILL.md', data: skillMarkdown() }])],
    ['nameless.zip', archive([{ name: 'SKILL.md', data: Buffer.from('---\ndescription: 没有名称\n---\n') }])],
    ['blank.zip', archive([{ name: 'SKILL.md', data: Buffer.from('---\nname: metric-skill\ndescription: "  "\n---\n') }])],
    ['SKILL.md', Buffer.from('没有 frontmatter 的说明\n')],
    ['notes.txt', skillMarkdown()],
  ] as const) {
    const rejected = await upload(`${api}?name=${encodeURIComponent(name)}`, bytes, { 'X-Revision': current.revision })
    assert.equal(rejected.status, 400, name)
    assert.equal((await rejected.json()).error, 'INVALID_SKILL_FILE', name)
  }
  assert.equal((await upload(`${api}?name=big.md`, Buffer.alloc(maxSkillFileBytes + 1), { 'X-Revision': current.revision })).status, 413)
  assert.equal((await upload(`${api}?name=stale.md`, plain, { 'X-Revision': 'stale' })).status, 409)
  assert.ok(!(await readdir(path.join(content, 'knowledge/skills'))).some(name => name.endsWith('.upload')))
  const inUse = await json(`${api}/metric-skill`, { revision: current.revision }, 'DELETE')
  assert.equal(inUse.status, 409); assert.equal((await inUse.json()).error, 'SKILL_IN_USE')
  current = await (await json('/api/admin/knowledge/metrics-retail', { entry: entry({ skill_name: null }), revision: current.revision }, 'PUT')).json()
  // A withdrawn library still owns its reference and prevents removal.
  assert.equal((await (await json(`${api}/flat-skill`, { revision: current.revision }, 'DELETE')).json()).error, 'SKILL_IN_USE')
  current = await (await json(`${api}/metric-skill`, { revision: current.revision }, 'DELETE')).json()
  assert.equal((await fetch(publicSkill('metric-skill'))).status, 404)
  current = await (await json('/api/admin/knowledge/metrics-media', { revision: current.revision }, 'DELETE')).json()
  assert.equal((await fetch(publicSkill('flat-skill'))).status, 200)
  assert.equal((await json(`${api}/flat-skill`, { revision: 'stale' }, 'DELETE')).status, 409)
  current = await (await json(`${api}/flat-skill`, { revision: current.revision }, 'DELETE')).json()
  assert.deepEqual((await read()).skills, [])
  assert.equal((await json(`${api}/flat-skill`, { revision: current.revision }, 'DELETE')).status, 404)
  assert.equal((await readdir(path.join(content, 'knowledge/skills'))).length, 3)
})

test('schema 1 migration binds every old library to its original shared skill and projects live v1 responses', async t => {
  const { json, read, origin, content, upload } = await fixture(t)
  const base = await read()
  const uploaded = await (await upload('/api/admin/knowledge/skills?name=shared.md', skillMarkdown('shared-skill'), { 'X-Revision': base.revision })).json()
  await json('/api/admin/knowledge', { entry: entry({ id: 'metrics-retail' }), revision: uploaded.revision })
  const catalogPath = path.join(content, 'knowledge/catalog.json')
  const raw = JSON.parse(await readFile(catalogPath, 'utf8'))
  raw.schemaVersion = 1; raw.skill = raw.skills[0]; delete raw.skills; delete raw.legacy_skill_name; delete raw.items[0].skill_name
  raw.items[0].knowledge_retrieve_workflow_id = { get_card_index: 'wf-card-index', get_card_meta: 'wf-card-meta', quer_card_data: 'wf-legacy' }
  const original = JSON.stringify(raw); await writeFile(catalogPath, original)
  const reloaded = await new KnowledgeStore(content).list()
  assert.equal(reloaded.legacy_skill_name, 'shared-skill')
  assert.equal(reloaded.items[0]!.skill_name, 'shared-skill')
  assert.equal(reloaded.items[0]!.knowledge_retrieve_workflow_id.query_card_data, 'wf-legacy')
  assert.equal(await readFile(catalogPath, 'utf8'), original)
  const before = await (await fetch(origin + '/api/knowledge/metrics')).json()
  assert.equal(before.schemaVersion, 1); assert.equal(before.skill.name, 'shared-skill')
  assert.equal(before.items[0].skill_name, undefined)
  assert.equal(before.items[0].knowledge_retrieve_workflow_id.quer_card_data, 'wf-legacy')
  let current = await (await upload('/api/admin/knowledge/skills?name=second.md', skillMarkdown('second-skill'), { 'X-Revision': reloaded.revision })).json()
  assert.equal((await fetch(origin + '/api/knowledge/metrics/skill')).headers.get('x-skill-name'), 'shared-skill')
  current = await (await json('/api/admin/knowledge/metrics-retail', { entry: entry({ skill_name: 'shared-skill', knowledge_retrieve_workflow_id: { get_card_index: 'changed-index', get_card_meta: 'changed-meta', query_card_data: 'changed-data', custom: 'custom-id' } }), revision: current.revision }, 'PUT')).json()
  const old = await (await fetch(origin + '/api/knowledge/metrics')).json()
  const next = await (await fetch(origin + '/api/knowledge/metrics/v2')).json()
  assert.equal(old.items[0].knowledge_retrieve_workflow_id.query_card_data, 'changed-data')
  assert.equal(old.items[0].knowledge_retrieve_workflow_id.custom, undefined)
  assert.equal(next.items[0].knowledge_retrieve_workflow_id.custom, 'custom-id')
  assert.equal(next.items[0].skill_name, 'shared-skill'); assert.equal(next.legacy_skill_name, undefined)
  assert.notEqual(old.revision, next.revision)
  assert.equal((await fetch(origin + '/api/knowledge/metrics/v2', { headers: { 'If-None-Match': `"${old.revision}"` } })).status, 200)
  assert.equal((await fetch(origin + '/api/knowledge/metrics/v2', { headers: { 'If-None-Match': `"${next.revision}"` } })).status, 304)
  const backups = await readdir(path.join(content, 'knowledge/.trash'))
  assert.ok((await Promise.all(backups.map(name => readFile(path.join(content, 'knowledge/.trash', name), 'utf8')))).includes(original))
  assert.equal((await new KnowledgeStore(content).list()).revision, current.revision)
  assert.equal((await json('/api/admin/knowledge/skills/shared-skill', { revision: current.revision }, 'DELETE')).status, 409)
})

test('unpublished array references preserve ambiguous choices and recover the original identity from v1 backups', async t => {
  const { json, read, content, upload, origin } = await fixture(t)
  let current = await read()
  for (const name of ['first-skill', 'second-skill']) current = await (await upload(`/api/admin/knowledge/skills?name=${name}.md`, skillMarkdown(name), { 'X-Revision': current.revision })).json()
  await json('/api/admin/knowledge', { entry: entry({ id: 'metrics-retail', skill_name: 'first-skill' }), revision: current.revision })
  const catalogPath = path.join(content, 'knowledge/catalog.json'), raw = JSON.parse(await readFile(catalogPath, 'utf8'))
  delete raw.legacy_skill_name; delete raw.items[0].skill_name; raw.items[0].skill_names = ['first-skill', 'second-skill']
  const original = JSON.stringify(raw); await writeFile(catalogPath, original)
  current = await read()
  assert.deepEqual(current.items[0].pending_skill_names, ['first-skill', 'second-skill'])
  assert.equal((await fetch(origin + '/api/knowledge/metrics')).status, 503)
  assert.deepEqual((await (await fetch(origin + '/api/knowledge/metrics/v2')).json()).items, [])
  const noSelection = entry(); delete (noSelection as Record<string, unknown>).skill_name
  assert.equal((await (await json('/api/admin/knowledge/metrics-retail', { entry: noSelection, revision: current.revision }, 'PUT')).json()).error, 'SKILL_SELECTION_REQUIRED')
  current = await (await json('/api/admin/knowledge/compatibility', { legacy_skill_name: 'second-skill', revision: current.revision }, 'PUT')).json()
  current = await (await json('/api/admin/knowledge/metrics-retail', { entry: entry({ skill_name: 'second-skill' }), revision: current.revision }, 'PUT')).json()
  assert.equal(current.entry.pending_skill_names, undefined)
  assert.equal((await (await fetch(origin + '/api/knowledge/metrics')).json()).items.length, 1)
  const legacy = { schemaVersion: 1, updatedAt: raw.updatedAt, skill: raw.skills[1], items: raw.items.map(({ skill_names: _names, ...item }: any) => item) }
  await mkdir(path.join(content, 'knowledge/.trash'), { recursive: true })
  await writeFile(path.join(content, 'knowledge/.trash/catalog-9999.json'), JSON.stringify(legacy))
  await writeFile(catalogPath, original)
  assert.equal((await new KnowledgeStore(content).list()).legacy_skill_name, 'second-skill')
  assert.equal(await readFile(catalogPath, 'utf8'), original)
})

test('workflow mappings accept custom method names and empty maps, trim rows, and reject invalid or ambiguous rows', async t => {
  const { json, read } = await fixture(t)
  const base = await read()
  const response = await json('/api/admin/knowledge', { entry: entry({ id: 'metrics-custom', knowledge_retrieve_workflow_id: { ' fetch_metrics ': ' wf-1 ', analysis: 'workflow-2', toString: 'workflow-3' } }), revision: base.revision })
  assert.equal(response.status, 200)
  const created = await response.json()
  assert.deepEqual(created.entry.knowledge_retrieve_workflow_id, { fetch_metrics: 'wf-1', analysis: 'workflow-2', toString: 'workflow-3' })
  const invalidMaps = [null, [], 'workflow', { key: '' }, { ' ': 'value' }, { key: 12 }, { key: 'a', ' key ': 'b' },
    { ["x".repeat(maxWorkflowName + 1)]: 'value' }, { key: 'x'.repeat(maxWorkflowValue + 1) },
    Object.fromEntries(Array.from({ length: maxKnowledgeWorkflows + 1 }, (_, index) => [`name-${index}`, 'value'])),
    JSON.parse('{"__proto__":"pollution"}'), { constructor: 'pollution' }, { prototype: 'pollution' }, { ' __proto__ ': 'pollution' }]
  for (const mapping of invalidMaps) {
    const rejected = await json('/api/admin/knowledge/metrics-custom', { entry: entry({ knowledge_retrieve_workflow_id: mapping }), revision: created.revision }, 'PUT')
    assert.equal(rejected.status, 400, JSON.stringify(mapping)); assert.equal((await rejected.json()).error, 'INVALID_KNOWLEDGE')
  }
  assert.equal((await read()).revision, created.revision)
  const empty = await json('/api/admin/knowledge/metrics-custom', { entry: entry({ knowledge_retrieve_workflow_id: {} }), revision: created.revision }, 'PUT')
  assert.equal(empty.status, 200)
  assert.deepEqual((await empty.json()).entry.knowledge_retrieve_workflow_id, {})
})

test('stored duplicate identities and dangling skill references fail closed without changing the file', async t => {
  const { json, upload, read, content } = await fixture(t)
  const base = await read()
  const registered = await (await upload('/api/admin/knowledge/skills?name=skill.md', skillMarkdown(), { 'X-Revision': base.revision })).json()
  await json('/api/admin/knowledge', { entry: entry({ skill_name: 'metric-skill' }), revision: registered.revision })
  const catalogPath = path.join(content, 'knowledge/catalog.json')
  const valid = JSON.parse(await readFile(catalogPath, 'utf8'))
  for (const mutate of [
    (raw: typeof valid) => { raw.skills.push(raw.skills[0]) },
    (raw: typeof valid) => { raw.items[0].skill_name = ['metric-skill', 'metric-skill'] },
    (raw: typeof valid) => { raw.items[0].skill_name = 'missing-skill' },
    (raw: typeof valid) => { raw.items.push(raw.items[0]) },
  ]) {
    const raw = structuredClone(valid); mutate(raw)
    const bytes = JSON.stringify(raw)
    await writeFile(catalogPath, bytes)
    await assert.rejects(new KnowledgeStore(content).list(), { code: 'CONTENT_UNAVAILABLE', status: 503 })
    assert.equal(await readFile(catalogPath, 'utf8'), bytes)
  }
})

test('skill registry enforces its limit while allowing same-name replacement', async t => {
  const { upload, read, content } = await fixture(t)
  const base = await read()
  await upload('/api/admin/knowledge/skills?name=skill.md', skillMarkdown(), { 'X-Revision': base.revision })
  const catalogPath = path.join(content, 'knowledge/catalog.json')
  const raw = JSON.parse(await readFile(catalogPath, 'utf8'))
  raw.skills = Array.from({ length: maxKnowledgeSkills }, (_, index) => ({ ...raw.skills[0], name: `skill-${index}` }))
  await writeFile(catalogPath, JSON.stringify(raw))
  const full = await read()
  const rejected = await upload('/api/admin/knowledge/skills?name=new.md', skillMarkdown('new-skill'), { 'X-Revision': full.revision })
  assert.equal(rejected.status, 409); assert.equal((await rejected.json()).error, 'KNOWLEDGE_SKILL_LIMIT')
  const replaced = await upload('/api/admin/knowledge/skills?name=existing.md', skillMarkdown('skill-0'), { 'X-Revision': full.revision })
  assert.equal(replaced.status, 200); assert.equal((await replaced.json()).skills.length, maxKnowledgeSkills)
  assert.ok(!(await readdir(path.join(content, 'knowledge/skills'))).some(name => name.endsWith('.upload')))
})

test('a populated catalog larger than the former read ceiling remains readable after persistence', async t => {
  const { json, read, content } = await fixture(t)
  const base = await read()
  await json('/api/admin/knowledge', { entry: entry(), revision: base.revision })
  const catalogPath = path.join(content, 'knowledge/catalog.json')
  const raw = JSON.parse(await readFile(catalogPath, 'utf8'))
  const workflows = Object.fromEntries(Array.from({ length: maxKnowledgeWorkflows }, (_, index) => [`workflow-${index}`, '值'.repeat(maxWorkflowValue)]))
  raw.items = Array.from({ length: 150 }, (_, index) => ({ ...raw.items[0], id: `metrics-${index}`, tenant_id: `tenant-${index}`, knowledge_retrieve_workflow_id: workflows }))
  const bytes = JSON.stringify(raw)
  assert.ok(Buffer.byteLength(bytes) > 4 * 1024 ** 2)
  await writeFile(catalogPath, bytes)
  const reloaded = await new KnowledgeStore(content).list()
  assert.equal(reloaded.items.length, 150)
  const updated = await json('/api/admin/knowledge/metrics-0', { entry: entry({ tenant_id: 'tenant-0', knowledge_retrieve_workflow_id: workflows }), revision: reloaded.revision }, 'PUT')
  assert.equal(updated.status, 200)
  assert.equal((await new KnowledgeStore(content).list()).revision, (await updated.json()).revision)
})

test('knowledge administration rejects anonymous, cross-origin and missing CSRF requests', async t => {
  const { origin, headers } = await fixture(t)
  for (const route of ['/api/admin/knowledge', '/api/admin/knowledge/metrics-retail', '/api/admin/knowledge/skill', '/api/admin/knowledge/skills', '/api/admin/knowledge/skills/metric-skill']) {
    assert.equal((await fetch(origin + route)).status, 401)
    assert.equal((await fetch(origin + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 401)
    for (const override of [{ 'X-CSRF-Token': '' }, { Origin: 'https://evil.example' }]) {
      assert.equal((await fetch(origin + route, { method: 'POST', headers: { ...headers, ...override, 'Content-Type': 'application/json' }, body: '{}' })).status, 403)
    }
  }
})

test('immutable skill downloads retain old versions after same-name replacement and reject mismatched names', async t => {
  const { read, upload, origin } = await fixture(t)
  const oldBytes = skillMarkdown('metric-skill'), nextBytes = skillMarkdown('metric-skill', '新版')
  let current = await read()
  current = await (await upload('/api/admin/knowledge/skills?name=old.md', oldBytes, { 'X-Revision': current.revision })).json()
  const oldHash = current.skill.sha256
  current = await (await upload('/api/admin/knowledge/skills?name=new.md', nextBytes, { 'X-Revision': current.revision })).json()
  for (const [hash, bytes] of [[oldHash, oldBytes], [current.skill.sha256, nextBytes]] as const) {
    const response = await fetch(`${origin}/api/knowledge/metrics/v2/skills/metric-skill/${hash}`)
    assert.equal(response.status, 200); assert.match(response.headers.get('cache-control')!, /immutable/)
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes)
  }
  assert.equal((await fetch(`${origin}/api/knowledge/metrics/v2/skills/another-skill/${oldHash}`)).status, 404)
  assert.equal((await fetch(`${origin}/api/knowledge/metrics/v2/skills/metric-skill/${'a'.repeat(64)}`)).status, 404)
})

test('new compatible libraries appear in v1, custom-only and conflicting aliases remain v2-only', async t => {
  const { read, json, origin } = await fixture(t)
  let current = await read()
  for (const [id, workflows] of Object.entries({ compatible: { get_card_index: 'i', get_card_meta: 'm', query_card_data: 'q' }, custom: { custom: 'x' }, conflict: { get_card_index: 'i', get_card_meta: 'm', query_card_data: 'q', quer_card_data: 'different' } })) {
    current = await (await json('/api/admin/knowledge', { entry: entry({ id: `metrics-${id}`, tenant_id: id, knowledge_retrieve_workflow_id: workflows }), revision: current.revision })).json()
  }
  assert.deepEqual((await (await fetch(origin + '/api/knowledge/metrics')).json()).items.map((item: any) => item.id), ['metrics-compatible'])
  assert.equal((await (await fetch(origin + '/api/knowledge/metrics/v2')).json()).items.length, 3)
  current = await (await json('/api/admin/knowledge/metrics-compatible', { entry: entry({ tenant_id: 'compatible', enabled: false }), revision: current.revision }, 'PUT')).json()
  assert.equal((await (await fetch(origin + '/api/knowledge/metrics')).json()).items.length, 0)
  assert.equal((await (await fetch(origin + '/api/knowledge/metrics/v2')).json()).items.length, 2)
})

test('historical invalid method names survive ordinary edits but newly added invalid names are rejected', async t => {
  const { read, json, content } = await fixture(t)
  let current = await read()
  await json('/api/admin/knowledge', { entry: entry({ id: 'metrics-retail' }), revision: current.revision })
  const file = path.join(content, 'knowledge/catalog.json'), raw = JSON.parse(await readFile(file, 'utf8'))
  raw.items[0].knowledge_retrieve_workflow_id = { '历史名称': 'original', run_code: 'reserved' }
  await writeFile(file, JSON.stringify(raw)); current = await read()
  const preserved = await json('/api/admin/knowledge/metrics-retail', { entry: entry({ tenant_name: '新名称', knowledge_retrieve_workflow_id: raw.items[0].knowledge_retrieve_workflow_id }), revision: current.revision }, 'PUT')
  assert.equal(preserved.status, 200); current = await preserved.json()
  for (const name of ['新的中文名称', 'space name', 'x'.repeat(65)]) {
    const rejected = await json('/api/admin/knowledge/metrics-retail', { entry: entry({ knowledge_retrieve_workflow_id: { [name]: 'id' } }), revision: current.revision }, 'PUT')
    assert.equal((await rejected.json()).error, 'INVALID_WORKFLOW_NAME')
  }
})

test('schema 1 without a public skill keeps its original no-skill behavior', async t => {
  const { read, json, content, origin } = await fixture(t)
  const base = await read()
  await json('/api/admin/knowledge', { entry: entry({ id: 'metrics-retail' }), revision: base.revision })
  const file = path.join(content, 'knowledge/catalog.json'), raw = JSON.parse(await readFile(file, 'utf8'))
  raw.schemaVersion = 1; delete raw.skills; delete raw.legacy_skill_name; delete raw.items[0].skill_name
  await writeFile(file, JSON.stringify(raw))
  const migrated = await new KnowledgeStore(content).list()
  assert.equal(migrated.legacy_skill_name, null); assert.equal(migrated.items[0]!.skill_name, null)
  const old = await (await fetch(origin + '/api/knowledge/metrics')).json()
  assert.equal(old.items.length, 1); assert.equal(old.skill, undefined)
  assert.equal((await fetch(origin + '/api/knowledge/metrics/skill')).status, 404)
})

test('a write exceeding the old 2 MiB response ceiling is rejected before changing the current catalog', async t => {
  const { read, json, content, origin } = await fixture(t)
  let current = await read()
  await json('/api/admin/knowledge', { entry: entry({ id: 'metrics-retail' }), revision: current.revision })
  const file = path.join(content, 'knowledge/catalog.json'), raw = JSON.parse(await readFile(file, 'utf8'))
  const fullMeta = { knowledge_description: '描'.repeat(2000), typical_indicators: Array.from({ length: 50 }, () => '指'.repeat(80)) }
  const seed = { ...raw.items[0], knowledge_base_meta: fullMeta }
  raw.items = []
  const projection = (items: typeof raw.items) => ({ schemaVersion: 1, updatedAt: raw.updatedAt, revision: 'a'.repeat(64), items: items.map(({ skill_name: _skill, ...item }: any) => ({ ...item, knowledge_retrieve_workflow_id: { ...item.knowledge_retrieve_workflow_id, quer_card_data: item.knowledge_retrieve_workflow_id.query_card_data } })) })
  for (let index = 0; index < 500; index++) {
    const candidate = [...raw.items, { ...seed, id: `metrics-${index}`, tenant_id: `tenant-${index}` }]
    if (Buffer.byteLength(JSON.stringify(projection(candidate))) > 2 * 1024 ** 2) break
    raw.items = candidate
  }
  const before = JSON.stringify(raw); await writeFile(file, before); current = await read()
  assert.equal((await fetch(origin + '/api/knowledge/metrics')).status, 200)
  const rejected = await json('/api/admin/knowledge', { entry: entry({ id: 'metrics-over-limit', tenant_id: 'tenant-over-limit', knowledge_base_meta: fullMeta }), revision: current.revision })
  assert.equal(rejected.status, 503); assert.equal((await rejected.json()).error, 'KNOWLEDGE_CATALOG_TOO_LARGE')
  assert.equal(await readFile(file, 'utf8'), before)
  assert.equal((await fetch(origin + '/api/knowledge/metrics')).status, 200)
})
