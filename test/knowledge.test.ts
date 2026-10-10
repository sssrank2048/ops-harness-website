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
    enabled: true, skill_names: [], ...extra,
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
  assert.equal(etag, `"${second.revision}"`)
  const catalog = await response.json()
  assert.equal(catalog.schemaVersion, 2); assert.equal(catalog.revision, second.revision)
  assert.deepEqual(catalog.items.map((item: { id: string }) => item.id), ['metrics-retail'])
  assert.deepEqual(catalog.items[0], first.entry)
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
  assert.deepEqual(listed.items[0].skill_names, [])
  assert.equal(listed.items[0].skill, undefined)
  const pub = await (await fetch(origin + '/api/knowledge/metrics')).json()
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
  assert.equal((await fetch(origin + '/api/knowledge/metrics/skill')).status, 200)
  const flat = archive([{ name: 'SKILL.md', data: skillMarkdown('flat-skill') }])
  current = await (await upload(`${api}?name=flat.zip`, flat, { 'X-Revision': current.revision })).json()
  assert.equal(current.skill.name, 'flat-skill')
  assert.equal(current.skills.length, 2)
  // The old unnamed address cannot pick an arbitrary file once more than one skill exists.
  assert.equal((await (await fetch(origin + '/api/knowledge/metrics/skill')).json()).error, 'SKILL_NAME_REQUIRED')
  assert.equal((await (await json('/api/admin/knowledge/skill', { revision: current.revision }, 'DELETE')).json()).error, 'SKILL_NAME_REQUIRED')
  current = await (await json('/api/admin/knowledge/metrics-retail', { entry: entry({ skill_names: ['metric-skill', 'flat-skill'] }), revision: current.revision }, 'PUT')).json()
  assert.deepEqual(current.entry.skill_names, ['metric-skill', 'flat-skill'])
  current = await (await json('/api/admin/knowledge', { entry: entry({ id: 'metrics-media', tenant_id: 'tenant-media', enabled: false, skill_names: ['flat-skill'] }), revision: current.revision })).json()
  assert.deepEqual(current.entry.skill_names, ['flat-skill'])
  const invalid = await json('/api/admin/knowledge/metrics-retail', { entry: entry({ skill_names: ['unknown-skill'] }), revision: current.revision }, 'PUT')
  assert.equal(invalid.status, 400); assert.equal((await invalid.json()).error, 'INVALID_SKILL_REFERENCE')
  assert.equal((await json('/api/admin/knowledge/metrics-retail', { entry: entry({ skill_names: ['flat-skill', 'flat-skill'] }), revision: current.revision }, 'PUT')).status, 400)
  const previous = listed.skills[0].sha256
  const plain = skillMarkdown('metric-skill', '新版指标技能')
  current = await (await upload(`${api}?name=SKILL.md`, plain, { 'X-Revision': current.revision })).json()
  assert.equal(current.skill.kind, 'md'); assert.equal(current.skills.length, 2)
  assert.deepEqual((await read()).items[0].skill_names, ['metric-skill', 'flat-skill'])
  const replaced = await fetch(publicSkill('metric-skill'), { headers: { 'If-None-Match': `"${previous}"` } })
  assert.equal(replaced.status, 200)
  assert.equal(replaced.headers.get('etag'), `"${current.skill.sha256}"`)
  assert.equal(replaced.headers.get('content-type'), 'text/markdown; charset=utf-8')
  assert.deepEqual(Buffer.from(await replaced.arrayBuffer()), plain)
  current = await (await upload(`${api}?name=again.md`, plain, { 'X-Revision': current.revision })).json()
  assert.equal((await readdir(path.join(content, 'knowledge/skills'))).length, 3)
  // A legacy editor omitting the new field must not clear explicit references.
  const withoutReferences = entry(); delete (withoutReferences as Record<string, unknown>).skill_names
  current = await (await json('/api/admin/knowledge/metrics-retail', { entry: withoutReferences, revision: current.revision }, 'PUT')).json()
  assert.deepEqual(current.entry.skill_names, ['metric-skill', 'flat-skill'])
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
  current = await (await json('/api/admin/knowledge/metrics-retail', { entry: entry({ skill_names: [] }), revision: current.revision }, 'PUT')).json()
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

test('schema 1 catalogs migrate their shared skill and preserve explicit choices with a backup on the first write', async t => {
  const { json, read, origin, headers, content } = await fixture(t)
  const base = await read()
  const created = await (await json('/api/admin/knowledge', { entry: entry({ id: 'metrics-retail' }), revision: base.revision })).json()
  const wrongType = await fetch(origin + '/api/admin/knowledge/skills?name=a.md', {
    method: 'POST', headers: { ...headers, 'Content-Type': 'text/plain', 'X-Revision': created.revision }, body: 'x',
  })
  assert.equal(wrongType.status, 415); assert.equal((await wrongType.json()).error, 'BINARY_REQUIRED')
  const catalogPath = path.join(content, 'knowledge/catalog.json')
  const raw = JSON.parse(await readFile(catalogPath, 'utf8'))
  raw.schemaVersion = 1; delete raw.skills
  raw.skill = { name: 'shared-skill', file_name: 'shared.md', sha256: 'a'.repeat(64), size: 10, kind: 'md', uploaded_at: '2026-09-18T00:00:00.000Z' }
  raw.items[0].skill = { ...raw.skill, name: 'ignored-skill' }
  delete raw.items[0].skill_names
  raw.items[0].knowledge_retrieve_workflow_id = { get_card_index: 'wf-card-index', get_card_meta: 'wf-card-meta', quer_card_data: 'wf-legacy' }
  raw.items.push({ ...raw.items[0], id: 'metrics-unbound', tenant_id: 'tenant-unbound', skill_names: [] })
  raw.items.push({ ...raw.items[0], id: 'metrics-explicit', tenant_id: 'tenant-explicit', skill_names: ['shared-skill'] })
  const original = JSON.stringify(raw)
  await writeFile(catalogPath, original)
  const reloaded = await new KnowledgeStore(content).list()
  assert.equal(reloaded.schemaVersion, 2)
  assert.deepEqual(reloaded.skills, [raw.skill])
  assert.deepEqual(reloaded.items.map(item => item.skill_names), [['shared-skill'], [], ['shared-skill']])
  assert.equal('skill' in reloaded.items[0]!, false)
  assert.deepEqual(reloaded.items[0]!.knowledge_retrieve_workflow_id, { get_card_index: 'wf-card-index', get_card_meta: 'wf-card-meta', query_card_data: 'wf-legacy' })
  assert.equal(await readFile(catalogPath, 'utf8'), original)
  const pub = await (await fetch(origin + '/api/knowledge/metrics')).json()
  assert.deepEqual(pub.items[0].skill_names, ['shared-skill'])
  assert.equal(pub.items[0].knowledge_retrieve_workflow_id.query_card_data, 'wf-legacy')
  // The schema 2 editor may intentionally use the former typo as a custom name.
  const response = await json('/api/admin/knowledge', { entry: entry({ tenant_id: 'tenant-new', knowledge_retrieve_workflow_id: { quer_card_data: 'custom-value' } }), revision: reloaded.revision })
  assert.equal(response.status, 200)
  const result = await response.json()
  assert.deepEqual(result.entry.knowledge_retrieve_workflow_id, { quer_card_data: 'custom-value' })
  const stored = JSON.parse(await readFile(catalogPath, 'utf8'))
  assert.equal(stored.schemaVersion, 2); assert.equal('skill' in stored, false)
  assert.deepEqual(stored.items[0].skill_names, ['shared-skill'])
  assert.ok(stored.items.every((item: Record<string, unknown>) => !('skill' in item)))
  const backups = await readdir(path.join(content, 'knowledge/.trash'))
  assert.equal(backups.length, 1)
  assert.equal(await readFile(path.join(content, 'knowledge/.trash', backups[0]!), 'utf8'), original)
  assert.equal((await new KnowledgeStore(content).list()).revision, result.revision)
})

test('schema 1 entry-only skills stay ignored and no automatic reference is invented', async t => {
  const { json, read, content } = await fixture(t)
  const base = await read()
  await json('/api/admin/knowledge', { entry: entry(), revision: base.revision })
  const catalogPath = path.join(content, 'knowledge/catalog.json')
  const raw = JSON.parse(await readFile(catalogPath, 'utf8'))
  raw.schemaVersion = 1; delete raw.skills; delete raw.items[0].skill_names
  raw.items[0].skill = { name: 'ignored-skill', file_name: 'legacy.md', sha256: 'a'.repeat(64), size: 10, kind: 'md', uploaded_at: '2026-09-18T00:00:00.000Z' }
  await writeFile(catalogPath, JSON.stringify(raw))
  const reloaded = await new KnowledgeStore(content).list()
  assert.deepEqual(reloaded.skills, [])
  assert.deepEqual(reloaded.items[0]!.skill_names, [])
  assert.equal('skill' in reloaded.items[0]!, false)
})

test('workflow mappings accept arbitrary names and empty maps, trim rows, and reject invalid or ambiguous rows', async t => {
  const { json, read } = await fixture(t)
  const base = await read()
  const response = await json('/api/admin/knowledge', { entry: entry({ id: 'metrics-custom', knowledge_retrieve_workflow_id: { ' 获取指标 ': ' wf-1 ', analysis: 'workflow-2', toString: 'workflow-3' } }), revision: base.revision })
  assert.equal(response.status, 200)
  const created = await response.json()
  assert.deepEqual(created.entry.knowledge_retrieve_workflow_id, { '获取指标': 'wf-1', analysis: 'workflow-2', toString: 'workflow-3' })
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
  await json('/api/admin/knowledge', { entry: entry({ skill_names: ['metric-skill'] }), revision: registered.revision })
  const catalogPath = path.join(content, 'knowledge/catalog.json')
  const valid = JSON.parse(await readFile(catalogPath, 'utf8'))
  for (const mutate of [
    (raw: typeof valid) => { raw.skills.push(raw.skills[0]) },
    (raw: typeof valid) => { raw.items[0].skill_names = ['metric-skill', 'metric-skill'] },
    (raw: typeof valid) => { raw.items[0].skill_names = ['missing-skill'] },
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
