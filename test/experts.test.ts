import { crc32, deflateRawSync } from 'node:zlib'
import { createHash, randomBytes } from 'node:crypto'
import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { GuideStore, encodeChapter } from '../server/guide-store.js'
import { MediaStore } from '../server/media-store.js'
import { ReleaseAdmin } from '../server/release-admin.js'
import { KnowledgeStore } from '../server/knowledge-store.js'
import { ExpertStore } from '../server/expert-store.js'
import { createAdminHandler } from '../server/admin-http.js'
import { createGuideHandler } from '../server/guide-http.js'
import { createHandler } from '../server/app.js'
import { BUILTIN_EXPERTS, BuiltinScenarioOverrideSchema, parseCloudExpertCatalog } from '@dsh-ops/expert-distribution-contract'

// Deflate-only ZIP writer: local headers + central directory + EOCD, no data descriptors.
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
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
const skillZip = (name: string, body = '按步骤撰写推送文案。') => archive([{ name: `${name}/SKILL.md`, data: Buffer.from(`---\nname: ${name}\ndescription: ${name} 的说明\n---\n\n# 用法\n\n${body}\n`, 'utf8') }])
const owner = { name: '张三', employeeId: 'z00123456' }
// Pin the shipped client inventory independently of the contract; custom and unshipped tools stay out.
const shippedBuiltinTools = [
  { id: 'webfetch', name: '网页抓取' },
  { id: 'browser', name: '浏览器操作' },
  { id: 'multimedia', name: '多媒体创作' },
  { id: 'metric-query', name: '指标查询' },
  { id: 'data-asset-query', name: '数据资产查询' },
  { id: 'data-agent-tool', name: 'DataAgent连接器' },
  { id: 'dataops-tool', name: 'DataOps连接器' },
  { id: 'welink', name: 'WeLink' },
  { id: 'operations-platform-auth', name: '运营平台认证' },
]

function draft(extra: Record<string, unknown> = {}) {
  return {
    name: '推送运营助手', summary: '策划推送活动、撰写文案并复盘效果。',
    appearance: { icon: 'megaphone', accent: '#2F6BFF', background: '#EEF3FF' },
    categoryIds: ['push'], tags: ['推送'], starterPrompts: ['帮我策划一次周末促活推送'], sortOrder: 1000,
    builtinTools: ['shell', 'filesystem'], responsibility: '# 推送运营助手\n\n负责策划推送活动。\n',
    skills: [], tools: [{ toolId: 'webfetch', required: true }],
    knowledge: [{ kind: 'onebox', ref: 'handbook', name: '推送运营手册', required: false }],
    owner, ...extra,
  }
}

function expertPackage(options: { definition?: Record<string, unknown>; responsibility?: string; skills?: Array<{ name: string; bytes: Buffer }>; tamper?: (files: { name: string; data: Buffer }[]) => void; origin?: Record<string, unknown> } = {}) {
  const skills = options.skills ?? [{ name: 'push-copywriting', bytes: skillZip('push-copywriting') }]
  const responsibility = Buffer.from(options.responsibility ?? '# 推送运营助手\n\n负责策划推送活动、撰写文案。\n', 'utf8')
  const definition = {
    name: '推送运营助手', summary: '策划推送活动、撰写文案并复盘效果。',
    appearance: { icon: 'megaphone', accent: '#2F6BFF', background: '#EEF3FF' },
    categoryIds: ['push'], tags: ['推送'], starterPrompts: ['帮我策划一次周末促活推送'],
    builtinTools: ['shell', 'filesystem'],
    skills: skills.map(skill => ({ name: skill.name, required: true, file: `skills/${skill.name}.zip`, sha256: sha(skill.bytes), size: skill.bytes.length })),
    tools: [{ toolId: 'webfetch', required: true }],
    customTools: [],
    knowledge: [
      { kind: 'onebox', ref: 'handbook', name: '推送运营手册', spaceId: '7100123', required: true },
      { kind: 'onebox', ref: 'review', name: '活动复盘库', required: false },
    ],
    owner, suggestedAllowlist: ['s00526367'],
    ...options.definition,
  }
  const definitionBytes = Buffer.from(JSON.stringify(definition), 'utf8')
  const files = [
    { name: 'expert.json', data: definitionBytes },
    { name: 'AGENTS.md', data: responsibility },
    ...skills.map(skill => ({ name: `skills/${skill.name}.zip`, data: skill.bytes })),
  ]
  const manifest = {
    format: 'dsh-ops-expert-package', schemaVersion: 1, exportedAt: '2026-09-26T08:00:00.000Z', appVersion: '0.1.0',
    origin: { expertId: 'product-default-custom-a1b2c3', employeeId: 'z00123456', ...options.origin },
    files: files.map(file => ({ path: file.name, size: file.data.length, sha256: sha(file.data) })),
  }
  const all = [{ name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest), 'utf8') }, ...files]
  options.tamper?.(all)
  return archive(all)
}

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), 'website-experts-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const source = path.join(root, 'repository/content'), seed = path.join(source, 'guide')
  await mkdir(seed, { recursive: true })
  await writeFile(path.join(seed, 'one.md'), encodeChapter({ id: 'one', title: '入门', group: '入门', order: 10, summary: '', archived: false, markdown: '# 正文\n' }))
  const content = path.join(root, 'content')
  const guides = new GuideStore(seed, content), media = new MediaStore(content, source), releases = new ReleaseAdmin(path.join(root, 'releases'))
  const knowledge = new KnowledgeStore(content)
  const experts = new ExpertStore(content, knowledge)
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) })
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  const guide = await createGuideHandler(guides, { origin, password: 'test-admin-password-only', admin: createAdminHandler(releases, media, undefined, knowledge, experts) })
  server.on('request', createHandler({ schemaVersion: 1, websiteUrl: origin, host: '127.0.0.1', port: 4173, releaseDirectory: releases.root, contentDirectory: content, adminPasswordEnv: 'DSH_OPS_WEBSITE_ADMIN_PASSWORD', configPath: 'test' },
    { clientRoot: root, knowledge, experts, guide: async (req, res, url) => await media.serve(req, res, url) || await guide(req, res, url) }))
  const login = await fetch(origin + '/api/admin/login', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'test-admin-password-only' }) })
  const session = await login.json(), headers = { Cookie: login.headers.get('set-cookie')!.split(';')[0]!, Origin: origin, 'X-CSRF-Token': session.csrf }
  const json = (url: string, data: unknown, method = 'POST') => fetch(origin + url, { method, headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(data) })
  const upload = (url: string, bytes: Buffer, extra: Record<string, string> = {}) =>
    fetch(origin + url, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/octet-stream', ...extra }, body: bytes })
  const list = () => fetch(origin + '/api/admin/experts', { headers }).then(r => r.json())
  const catalog = (employee?: string, extra: Record<string, string> = {}) => fetch(origin + '/api/experts/v1/catalog', { headers: { ...(employee ? { 'X-Ops-Employee-Id': employee } : {}), ...extra } })
  return { root, origin, content, headers, json, upload, list, catalog, experts }
}

async function createPublished(f: Awaited<ReturnType<typeof fixture>>, visibility: unknown = { mode: 'allowlist', employeeIds: ['s00526367'] }, extra: Record<string, unknown> = {}) {
  const created = await f.json('/api/admin/experts', { id: 'push-ops', draft: draft(extra), revision: (await f.list()).revision })
  assert.equal(created.status, 200)
  let { revision } = await created.json()
  const skill = await f.upload('/api/admin/experts/push-ops/skills?name=push-copywriting.zip', skillZip('push-copywriting'), { 'X-Revision': revision })
  assert.equal(skill.status, 200); revision = (await skill.json()).revision
  const published = await f.json('/api/admin/experts/push-ops/publish', { revision })
  assert.equal(published.status, 200); revision = (await published.json()).revision
  const distributed = await f.json('/api/admin/experts/push-ops/distribution', { revision, distribution: { status: 'active', visibility, allowClone: true } }, 'PUT')
  assert.equal(distributed.status, 200)
  return (await distributed.json()).revision as string
}

test('drafts are validated, published immutably and versioned', async t => {
  const f = await fixture(t)
  const initial = await f.list()
  assert.deepEqual(initial.experts, [])
  const bad = await f.json('/api/admin/experts', { draft: { ...draft(), appearance: { icon: 'nope' } }, revision: initial.revision })
  assert.equal(bad.status, 400)
  assert.equal((await bad.json()).error, 'INVALID_EXPERT')
  const reserved = await f.json('/api/admin/experts', { id: 'import', draft: draft(), revision: initial.revision })
  assert.equal(reserved.status, 409)
  const created = await f.json('/api/admin/experts', { id: 'push-ops', draft: draft({ responsibility: '' }), revision: initial.revision })
  assert.equal(created.status, 200)
  const body = await created.json()
  assert.equal(body.expert.presetId, 'cloud-push-ops')
  assert.equal(body.expert.distribution.status, 'disabled')
  const stale = await f.json('/api/admin/experts/push-ops', { draft: draft(), revision: initial.revision }, 'PUT')
  assert.equal(stale.status, 409)
  const unpublishable = await f.json('/api/admin/experts/push-ops/publish', { revision: body.revision })
  assert.equal(unpublishable.status, 400)
  assert.match((await unpublishable.json()).issues.join(), /职责不能为空/)
  const saved = await f.json('/api/admin/experts/push-ops', { draft: draft(), revision: body.revision }, 'PUT')
  const { revision } = await saved.json()
  const smuggled = await f.json('/api/admin/experts/push-ops', { draft: draft({ skills: [{ name: 'x', sha256: 'a'.repeat(64), size: 1, kind: 'zip', required: true }] }), revision }, 'PUT')
  assert.equal(smuggled.status, 400)
  const published = await f.json('/api/admin/experts/push-ops/publish', { revision })
  assert.equal(published.status, 200)
  const after = await published.json()
  assert.equal(after.expert.published.version, 1)
  assert.equal(after.expert.distribution.status, 'active')
  assert.equal(after.expert.draftChanged, false)
  const again = await f.json('/api/admin/experts/push-ops/publish', { revision: after.revision })
  assert.equal(again.status, 409)
  assert.equal((await again.json()).error, 'NOTHING_TO_PUBLISH')
  assert.deepEqual(await readdir(path.join(f.content, 'experts', 'versions', 'push-ops')), ['1.json'])
})

test('all shipped built-in tools are offered and their references survive saving and publishing', async t => {
  const f = await fixture(t)
  const options = await fetch(f.origin + '/api/admin/experts/options', { headers: f.headers })
  assert.equal(options.status, 200)
  const availableTools = (await options.json()).tools
  assert.deepEqual(availableTools, shippedBuiltinTools)

  const created = await f.json('/api/admin/experts', { id: 'builtin-tools-ops', draft: draft(), revision: (await f.list()).revision })
  assert.equal(created.status, 200)
  const tools = shippedBuiltinTools.map((tool, index) => ({ toolId: tool.id, required: index % 2 === 1 }))
  const saved = await f.json('/api/admin/experts/builtin-tools-ops', { draft: draft({ tools }), revision: (await created.json()).revision }, 'PUT')
  assert.equal(saved.status, 200)
  const savedBody = await saved.json()
  assert.deepEqual(savedBody.expert.draft.tools, tools)
  const published = await f.json('/api/admin/experts/builtin-tools-ops/publish', { revision: savedBody.revision })
  assert.equal(published.status, 200)
  const snapshot = JSON.parse(await readFile(path.join(f.content, 'experts', 'versions', 'builtin-tools-ops', '1.json'), 'utf8'))
  assert.deepEqual(snapshot.content.tools, tools)
  const catalog = await f.catalog(owner.employeeId)
  assert.equal(catalog.status, 200)
  assert.deepEqual((await catalog.json()).experts[0].tools, tools)
})

test('the catalog and downloads only reach visible employees', async t => {
  const f = await fixture(t)
  await createPublished(f)
  const anonymous = await (await f.catalog()).json()
  assert.deepEqual(anonymous.experts, [])
  assert.equal(anonymous.identity.recognized, false)
  const listed = await f.catalog('S00526367')
  assert.equal(listed.status, 200)
  assert.equal(listed.headers.get('vary'), 'X-Ops-Employee-Id, X-Ops-Expert-Features')
  const entry = (await listed.json()).experts[0]
  assert.equal(entry.id, 'push-ops')
  assert.equal(entry.presetId, 'cloud-push-ops')
  assert.equal(entry.owner.employeeId, 'z00123456')
  assert.equal(entry.skills[0].name, 'push-copywriting')
  assert.deepEqual((await (await f.catalog('z00123456')).json()).experts.map((item: { id: string }) => item.id), ['push-ops'])
  assert.deepEqual((await (await f.catalog('x00000001')).json()).experts, [])
  const etag = listed.headers.get('etag')!
  assert.equal((await f.catalog('s00526367', { 'If-None-Match': etag })).status, 304)
  assert.notEqual((await f.catalog('z00123456')).headers.get('etag'), etag)
  assert.equal((await f.catalog('s00526367', { Origin: 'http://evil.example' })).status, 403)
  assert.equal((await f.catalog('bad id!')).status, 400)

  const responsibility = await fetch(f.origin + '/api/experts/v1/experts/push-ops/versions/1/responsibility', { headers: { 'X-Ops-Employee-Id': 's00526367' } })
  assert.equal(responsibility.status, 200)
  const text = await responsibility.text()
  assert.match(text, /负责策划推送活动/)
  assert.equal(`"${sha(Buffer.from(text, 'utf8'))}"`, responsibility.headers.get('etag'))
  assert.equal(entry.responsibility.sha256, sha(Buffer.from(text, 'utf8')))
  const skill = await fetch(f.origin + '/api/experts/v1/experts/push-ops/versions/1/skills/push-copywriting', { headers: { 'X-Ops-Employee-Id': 's00526367' } })
  assert.equal(skill.status, 200)
  assert.equal(sha(Buffer.from(await skill.arrayBuffer())), entry.skills[0].sha256)
  for (const [url, employee] of [
    ['/api/experts/v1/experts/push-ops/versions/1/responsibility', 'x00000001'],
    ['/api/experts/v1/experts/push-ops/versions/1/skills/push-copywriting', undefined],
    ['/api/experts/v1/experts/push-ops/versions/2/responsibility', 's00526367'],
    ['/api/experts/v1/experts/push-ops/versions/1/skills/other', 's00526367'],
  ] as const) {
    const response = await fetch(f.origin + url, { headers: employee ? { 'X-Ops-Employee-Id': employee } : {} })
    assert.equal(response.status, 404, url)
  }
})

test('taking an expert off sale or narrowing the allowlist applies immediately', async t => {
  const f = await fixture(t)
  const revision = await createPublished(f, { mode: 'everyone' })
  assert.equal((await (await f.catalog()).json()).experts.length, 1)
  const narrowed = await f.json('/api/admin/experts/push-ops/distribution', { revision, distribution: { status: 'active', visibility: { mode: 'allowlist', employeeIds: [] }, allowClone: false } }, 'PUT')
  const next = (await narrowed.json()).revision
  assert.equal((await (await f.catalog()).json()).experts.length, 0)
  const ownerView = (await (await f.catalog('z00123456')).json()).experts
  assert.equal(ownerView.length, 1)
  assert.equal(ownerView[0].allowClone, false)
  await f.json('/api/admin/experts/push-ops/distribution', { revision: next, distribution: { status: 'disabled', visibility: { mode: 'everyone' }, allowClone: true } }, 'PUT')
  assert.equal((await (await f.catalog('z00123456')).json()).experts.length, 0)
  assert.equal((await fetch(f.origin + '/api/experts/v1/experts/push-ops/versions/1/responsibility', { headers: { 'X-Ops-Employee-Id': 'z00123456' } })).status, 404)
})

test('an expert package imports as a draft and matches its origin on re-import', async t => {
  const f = await fixture(t)
  const uploaded = await f.upload('/api/admin/experts/import', expertPackage())
  assert.equal(uploaded.status, 200)
  const { preview } = await uploaded.json()
  assert.equal(preview.target.mode, 'create')
  assert.equal(preview.expert.owner.employeeId, 'z00123456')
  assert.deepEqual(preview.skills.map((item: { name: string }) => item.name), ['push-copywriting'])
  assert.deepEqual(preview.errors, [])
  assert.ok(preview.warnings.some((warning: string) => warning.includes('活动复盘库')))
  assert.deepEqual(preview.suggestedAllowlist, ['s00526367'])
  const applied = await f.json(`/api/admin/experts/import/${preview.importId}/apply`, { target: { mode: 'create', id: 'push-ops' }, adoptAllowlist: true, publish: true, revision: (await f.list()).revision })
  assert.equal(applied.status, 200)
  const expert = (await applied.json()).expert
  assert.equal(expert.published.version, 1)
  assert.deepEqual(expert.distribution.visibility, { mode: 'allowlist', employeeIds: ['s00526367'] })
  assert.equal(expert.importedFrom.expertId, 'product-default-custom-a1b2c3')
  assert.equal((await (await f.catalog('s00526367')).json()).experts[0].knowledge[0].spaceId, '7100123')
  assert.equal((await fetch(`${f.origin}/api/admin/experts/import/${preview.importId}`, { headers: f.headers })).status, 404)

  const second = await (await f.upload('/api/admin/experts/import', expertPackage({ responsibility: '# 推送运营助手\n\n新版职责。\n', skills: [{ name: 'push-review', bytes: skillZip('push-review') }] }))).json()
  assert.deepEqual(second.preview.target, { mode: 'update', id: 'push-ops' })
  assert.equal(second.preview.changes.responsibility, true)
  assert.deepEqual(second.preview.changes.skills, { added: ['push-review'], removed: ['push-copywriting'], updated: [] })
  const update = await f.json(`/api/admin/experts/import/${second.preview.importId}/apply`, { target: second.preview.target, revision: (await f.list()).revision })
  const updated = (await update.json()).expert
  assert.equal(updated.published.version, 1)
  assert.equal(updated.draftChanged, true)
  assert.match(updated.draft.responsibility, /新版职责/)
})

test('a package with all shipped built-in tools previews as known and retains its references after import', async t => {
  const f = await fixture(t)
  // Reverse the saved-draft flags above so every tool also travels with the other required value.
  const tools = shippedBuiltinTools.map((tool, index) => ({ toolId: tool.id, required: index % 2 === 0 }))
  const uploaded = await f.upload('/api/admin/experts/import', expertPackage({ definition: { tools } }))
  assert.equal(uploaded.status, 200)
  const { preview } = await uploaded.json()
  assert.deepEqual(preview.tools, shippedBuiltinTools.map((tool, index) => ({ toolId: tool.id, name: tool.name, required: index % 2 === 0, known: true })))
  assert.deepEqual(preview.errors, [])
  const applied = await f.json(`/api/admin/experts/import/${preview.importId}/apply`, { target: { mode: 'create', id: 'builtin-tools-ops' }, publish: true, revision: (await f.list()).revision })
  assert.equal(applied.status, 200)
  const expert = (await applied.json()).expert
  assert.deepEqual(expert.draft.tools, tools)
  assert.equal(expert.published.version, 1)
  const catalog = await f.catalog(owner.employeeId)
  assert.equal(catalog.status, 200)
  assert.deepEqual((await catalog.json()).experts[0].tools, tools)
})

test('tampered, foreign or unsupported packages are rejected with reasons', async t => {
  const f = await fixture(t)
  const rejected = async (bytes: Buffer) => {
    const response = await f.upload('/api/admin/experts/import', bytes)
    assert.equal(response.status, 400)
    return (await response.json()) as { error: string; issues?: string[] }
  }
  const corrupted = await rejected(expertPackage({ tamper: files => { files[2]!.data = Buffer.from('# 被改过的职责\n', 'utf8') } }))
  assert.equal(corrupted.error, 'INVALID_EXPERT_PACKAGE')
  assert.match(corrupted.issues!.join(), /AGENTS\.md/)
  const extra = await rejected(expertPackage({ tamper: files => { files.push({ name: 'evil.exe', data: Buffer.from('MZ') }) } }))
  assert.match(extra.issues!.join(), /evil\.exe/)
  assert.equal((await rejected(archive([{ name: '../escape.json', data: Buffer.from('{}') }]))).error, 'INVALID_EXPERT_PACKAGE')
  const wrongSkill = await rejected(expertPackage({ skills: [{ name: 'push-copywriting', bytes: skillZip('other-name') }] }))
  assert.match(wrongSkill.issues!.join(), /push-copywriting/)
  // A custom tool that would carry a secret or a machine path never gets past the package check.
  const secret = await rejected(expertPackage({ definition: {
    tools: [{ customTool: 'crm-query', required: true }],
    customTools: [crmTool({ headers: { Authorization: 'Bearer sk-live-123' }, credentials: [] })],
  } }))
  assert.match(secret.issues!.join(), /Authorization/)
  const localCommand = await rejected(expertPackage({ definition: {
    tools: [{ customTool: 'files', required: true }],
    customTools: [{ key: 'files', name: '文件', transport: 'stdio', serverName: 'files', command: 'C:\\tools\\files.exe', credentials: [] }],
  } }))
  assert.match(localCommand.issues!.join(), /本机文件路径/)
  const missingMetric = await f.upload('/api/admin/experts/import', expertPackage({ definition: { knowledge: [{ kind: 'metric', knowledgeId: 'metrics-none', required: true }] } }))
  const preview = (await missingMetric.json()).preview
  assert.ok(preview.errors.some((error: string) => error.includes('metrics-none')))
  const refused = await f.json(`/api/admin/experts/import/${preview.importId}/apply`, { target: preview.target, revision: (await f.list()).revision })
  assert.equal(refused.status, 400)
  assert.equal((await refused.json()).error, 'EXPERT_PACKAGE_REJECTED')
  const discarded = await fetch(`${f.origin}/api/admin/experts/import/${preview.importId}`, { method: 'DELETE', headers: f.headers })
  assert.equal(discarded.status, 200)
})

// One rule set for a Skill wherever it travels (contract `skill-tree`): what the creator's 我的技能 accepts
// imports here; what clients from before these rules cannot install is a warning, not a refusal.
const manifestOf = (name: string, description = `${name} 的说明`) => Buffer.from(`---\nname: ${name}\ndescription: ${description}\n---\n\n# 用法\n`, 'utf8')
function bigSkill(name = 'big-skill') {
  const files = [
    { name: `${name}/SKILL.md`, data: manifestOf(name, '适用场景很多。'.repeat(80)) },
    { name: `${name}/templates/example/SKILL.md`, data: manifestOf('example') },
    { name: `${name}/references/empty.md` },
    { name: `${name}/${Array.from({ length: 18 }, (_, index) => `d${index}`).join('/')}/deep.md`, data: Buffer.from('# 深层文件\n') },
    { name: '__MACOSX/._SKILL.md', data: Buffer.from('apple double') },
  ]
  for (let index = 0; index < 296; index++) files.push({ name: `${name}/references/note-${index}.md`, data: Buffer.from(`# 说明 ${index}\n`) })
  return archive(files)
}

test('a package carries what 我的技能 accepts, and the preview names what older clients cannot install', async t => {
  const f = await fixture(t)
  const skill = bigSkill()
  const uploaded = await f.upload('/api/admin/experts/import', expertPackage({ skills: [{ name: 'big-skill', bytes: skill }] }))
  assert.equal(uploaded.status, 200)
  const { preview } = await uploaded.json()
  assert.deepEqual(preview.errors, [])
  const legacy = preview.warnings.find((warning: string) => warning.startsWith('技能「big-skill」超出旧版工作助手的能力'))
  assert.ok(legacy, preview.warnings.join('\n'))
  assert.match(legacy, /301 个条目（旧版上限 256）/)
  assert.match(legacy, /20 层目录（旧版上限 16）/)
  assert.match(legacy, /子文件夹里还有 SKILL\.md/)
  assert.match(legacy, /描述 560 字（旧版上限 500）/)
  assert.match(legacy, /使用旧版工作助手的同事需先升级才能收到这位专家/)
  const applied = await f.json(`/api/admin/experts/import/${preview.importId}/apply`, { target: { mode: 'create', id: 'big-ops' }, adoptAllowlist: true, publish: true, revision: (await f.list()).revision })
  assert.equal(applied.status, 200)
  const expert = (await (await f.catalog('s00526367')).json()).experts[0]
  assert.deepEqual(expert.skills.map((item: { name: string, size: number }) => [item.name, item.size]), [['big-skill', skill.length]])
  const download = await fetch(`${f.origin}/api/experts/v1/experts/${expert.id}/versions/${expert.version}/skills/big-skill`, { headers: { 'X-Ops-Employee-Id': 's00526367' } })
  assert.equal(download.status, 200)
  assert.equal(Buffer.compare(Buffer.from(await download.arrayBuffer()), skill), 0)

  // 21 Skills: imported for new clients, flagged for old ones; 31: beyond the expert's limit.
  const many = (count: number) => Array.from({ length: count }, (_, index) => ({ name: `skill-${index}`, bytes: skillZip(`skill-${index}`) }))
  const twentyOne = (await (await f.upload('/api/admin/experts/import', expertPackage({ skills: many(21), origin: { expertId: 'twenty-one' } }))).json()).preview
  assert.deepEqual(twentyOne.errors, [])
  assert.ok(twentyOne.warnings.includes('这位专家有 21 个技能，超出旧版工作助手的上限 20 个。使用旧版工作助手的同事需先升级才能收到这位专家'))
  const thirtyOne = await f.upload('/api/admin/experts/import', expertPackage({ skills: many(31), origin: { expertId: 'thirty-one' } }))
  assert.equal(thirtyOne.status, 400)
  assert.equal((await thirtyOne.json()).error, 'INVALID_EXPERT_PACKAGE')
})

test('a Skill that breaks the shared rules is refused with the rule and the limit', async t => {
  const f = await fixture(t)
  const rejected = async (bytes: Buffer) => {
    const response = await f.upload('/api/admin/experts/import', expertPackage({ skills: [{ name: 'push-copywriting', bytes }] }))
    assert.equal(response.status, 400)
    const body = await response.json() as { error: string; issues: string[] }
    assert.equal(body.error, 'INVALID_EXPERT_PACKAGE')
    return body.issues
  }
  const tooMany = [{ name: 'push-copywriting/SKILL.md', data: manifestOf('push-copywriting') }]
  for (let index = 0; index < 2000; index++) tooMany.push({ name: `push-copywriting/data/f-${index}.md`, data: Buffer.from('x') })
  assert.deepEqual(await rejected(archive(tooMany)), ['技能「push-copywriting」：有 2001 个文件，超过 2000 个上限'])
  assert.deepEqual(await rejected(archive([{ name: 'push-copywriting/README.md', data: Buffer.from('没有清单') }])),
    ['技能「push-copywriting」：压缩包里找不到技能的 SKILL.md：它应在压缩包根目录，或唯一的一级文件夹里'])
  assert.deepEqual(await rejected(archive([{ name: 'push-copywriting/SKILL.md', data: manifestOf('other-name') }])),
    ['技能「push-copywriting」：SKILL.md 的 name（other-name）与技能名称（push-copywriting）不一致'])
  const long = `push-copywriting/${'a'.repeat(121)}.md`
  assert.deepEqual(await rejected(archive([{ name: 'push-copywriting/SKILL.md', data: manifestOf('push-copywriting') }, { name: long, data: Buffer.from('x') }])),
    [`技能「push-copywriting」：文件或文件夹名超过 120 个字符：${'a'.repeat(121)}.md`])

  // The same rules when the admin adds a Skill by hand; a large one is accepted with a note about older clients.
  const created = await f.json('/api/admin/experts', { id: 'push-ops', draft: draft(), revision: (await f.list()).revision })
  let { revision } = await created.json()
  const refused = await f.upload('/api/admin/experts/push-ops/skills?name=bad.zip', archive([{ name: 'bad/SKILL.md', data: Buffer.from('# 没有开头的信息块\n') }]), { 'X-Revision': revision })
  assert.equal(refused.status, 400)
  assert.deepEqual(await refused.json(), { error: 'INVALID_EXPERT_SKILL', issues: ['SKILL.md 开头缺少用 --- 包起来的 name 与 description，或格式不正确'] })
  const large = archive([{ name: 'large-data/SKILL.md', data: manifestOf('large-data') }, { name: 'large-data/data.bin', data: randomBytes(6 * 1024 * 1024) }])
  const accepted = await f.upload('/api/admin/experts/push-ops/skills?name=large-data.zip', large, { 'X-Revision': revision })
  assert.equal(accepted.status, 200)
  const body = await accepted.json() as { revision: string; warnings: string[] }
  revision = body.revision
  assert.equal(body.warnings.length, 1)
  assert.match(body.warnings[0]!, /^技能「large-data」超出旧版工作助手的能力：压缩后 6 MB（旧版上限 5 MB）/)
  const plain = await f.upload('/api/admin/experts/push-ops/skills?name=push-copywriting.zip', skillZip('push-copywriting'), { 'X-Revision': revision })
  assert.deepEqual((await plain.json()).warnings, [])
})

function crmTool(extra: Record<string, unknown> = {}) {
  return {
    key: 'crm-query', name: 'CRM 查询', transport: 'streamable-http', serverName: 'crm', url: 'https://crm.example.internal/mcp',
    headers: { 'X-Api-Key': '{{credential:api-key}}', 'X-Tenant-Id': 'acme' },
    credentials: [{ key: 'api-key', label: 'CRM 访问令牌', location: { kind: 'header', name: 'X-Api-Key' }, hint: 'CRM 个人设置 → API 令牌' }],
    ...extra,
  }
}
const withTool = (tool = crmTool(), origin: Record<string, unknown> = {}) => expertPackage({ origin, definition: { tools: [{ toolId: 'webfetch', required: true }, { customTool: tool.key, required: true }], customTools: [tool] } })

test('custom tools join the library on import, are reused or renamed, and reach only visible experts', async t => {
  const f = await fixture(t)
  const tools = () => fetch(f.origin + '/api/admin/expert-tools', { headers: f.headers }).then(r => r.json())
  const first = (await (await f.upload('/api/admin/experts/import', withTool())).json()).preview
  assert.deepEqual(first.errors, [])
  assert.deepEqual(first.customTools.map((row: { key: string; resolution: string; libraryKey: string }) => [row.key, row.resolution, row.libraryKey]), [['crm-query', 'new', 'crm-query']])
  assert.deepEqual(first.tools.map((row: { name: string; known: boolean }) => [row.name, row.known]), [['网页抓取', true], ['CRM 查询', true]])
  const applied = await f.json(`/api/admin/experts/import/${first.importId}/apply`, { target: { mode: 'create', id: 'push-ops' }, adoptAllowlist: true, publish: true, revision: (await f.list()).revision })
  assert.equal(applied.status, 200)
  assert.deepEqual((await applied.json()).expert.draft.tools, [{ toolId: 'webfetch', required: true }, { customTool: 'crm-query', required: true }])
  const library = await tools()
  assert.deepEqual(library.tools.map((tool: { key: string; usage: Array<{ id: string; published: boolean }> }) => [tool.key, tool.usage]), [['crm-query', [{ id: 'push-ops', name: '推送运营助手', draft: true, published: true }]]])

  // Only employees who see an expert receive its tool; the entry carries slots, never a value.
  const visible = await f.catalog('s00526367')
  const body = await visible.json()
  assert.equal(body.customTools.length, 1)
  assert.equal(body.customTools[0].revision, library.tools[0].revision)
  assert.deepEqual(body.customTools[0].headers, { 'X-Api-Key': '{{credential:api-key}}', 'X-Tenant-Id': 'acme' })
  assert.deepEqual((await (await f.catalog('x00000001')).json()).customTools, [])

  // The same package again: the identical tool is reused.
  const again = (await (await f.upload('/api/admin/experts/import', withTool())).json()).preview
  assert.equal(again.customTools[0].resolution, 'reuse')
  await fetch(`${f.origin}/api/admin/experts/import/${again.importId}`, { method: 'DELETE', headers: f.headers })

  // Another expert brings a different tool under the same server name: the admin must choose.
  const other = withTool(crmTool({ url: 'https://crm-test.example.internal/mcp' }), { expertId: 'product-default-custom-d4e5f6' })
  const conflict = (await (await f.upload('/api/admin/experts/import', other)).json()).preview
  assert.deepEqual(conflict.customTools[0].resolution, 'conflict')
  assert.deepEqual(conflict.customTools[0].rename, { key: 'crm-query-2', serverName: 'crm_2' })
  assert.deepEqual(conflict.customTools[0].affected, [{ id: 'push-ops', name: '推送运营助手' }])
  assert.deepEqual(conflict.errors, [])
  const unresolved = await f.json(`/api/admin/experts/import/${conflict.importId}/apply`, { target: { mode: 'create', id: 'crm-test' }, revision: (await f.list()).revision })
  assert.equal(unresolved.status, 400)
  assert.match((await unresolved.json()).issues.join(), /更新已有工具/)
  const renamed = await f.json(`/api/admin/experts/import/${conflict.importId}/apply`, { target: { mode: 'create', id: 'crm-test' }, tools: { 'crm-query': 'rename' }, revision: (await f.list()).revision })
  assert.equal(renamed.status, 200)
  assert.deepEqual((await renamed.json()).expert.draft.tools[1], { customTool: 'crm-query-2', required: true })
  const both = await tools()
  assert.deepEqual(both.tools.map((tool: { key: string; serverName: string }) => [tool.key, tool.serverName]), [['crm-query', 'crm'], ['crm-query-2', 'crm_2']])

  // Editing an entry takes effect at once: its revision and the catalog of everyone using it change.
  const etag = (await f.catalog('s00526367')).headers.get('etag')
  const edit = (url: string, extra: Record<string, unknown> = {}) => ({ name: 'CRM 查询', url, timeoutMs: 60000, credentials: [{ key: 'api-key', label: 'CRM 访问令牌', hint: '找 CRM 管理员申请' }], ...extra })
  const secretUrl = await f.json('/api/admin/expert-tools/crm-query', { tool: edit('https://crm.example.internal/mcp?token=abc'), revision: both.revision }, 'PUT')
  assert.equal(secretUrl.status, 400)
  assert.equal((await secretUrl.json()).error, 'INVALID_EXPERT_TOOL')
  const saved = await f.json('/api/admin/expert-tools/crm-query', { tool: edit('https://crm2.example.internal/mcp'), revision: both.revision }, 'PUT')
  assert.equal(saved.status, 200)
  const savedTool = (await saved.json()).tool
  assert.notEqual(savedTool.revision, both.tools[0].revision)
  assert.equal(savedTool.credentials[0].hint, '找 CRM 管理员申请')
  const next = await f.catalog('s00526367')
  assert.notEqual(next.headers.get('etag'), etag)
  assert.equal((await next.json()).customTools[0].url, 'https://crm2.example.internal/mcp')

  // An entry still referenced cannot be removed.
  const inUse = await f.json('/api/admin/expert-tools/crm-query', { revision: (await tools()).revision }, 'DELETE')
  assert.equal(inUse.status, 409)
  assert.match((await inUse.json()).issues.join(), /push-ops/)
})

test('admin routes require the session and CSRF', async t => {
  const f = await fixture(t)
  assert.equal((await fetch(f.origin + '/api/admin/experts')).status, 401)
  assert.equal((await fetch(f.origin + '/api/admin/expert-tools')).status, 401)
  const noCsrf = await fetch(f.origin + '/api/admin/experts', { method: 'POST', headers: { Cookie: f.headers.Cookie, Origin: f.origin, 'Content-Type': 'application/json' }, body: '{}' })
  assert.equal(noCsrf.status, 403)
  const crossSite = await fetch(f.origin + '/api/admin/experts', { method: 'POST', headers: { ...f.headers, Origin: 'http://evil.example', 'Content-Type': 'application/json' }, body: '{}' })
  assert.equal(crossSite.status, 403)
})


// ---- 常用场景 -------------------------------------------------------------------------------------

const FEATURES = { 'X-Ops-Expert-Features': 'scenarios' }
const scenarios = [
  { id: 'weekend-push', title: ' 周末促活推送 ', summary: '按人群拆分文案', prompt: '帮我策划一次【活动主题】的周末促活推送。\r\n目标人群：【人群】' },
  { id: 'push-review', title: '推送复盘', prompt: '复盘【活动名称】的推送效果', modeId: 'ppt' },
]
const canonical = [
  { id: 'weekend-push', title: '周末促活推送', summary: '按人群拆分文案', prompt: '帮我策划一次【活动主题】的周末促活推送。\n目标人群：【人群】' },
  { id: 'push-review', title: '推送复盘', prompt: '复盘【活动名称】的推送效果', modeId: 'ppt' },
]

test('scenarios are checked on save, published with the expert and served only to clients that read them', async t => {
  const f = await fixture(t)
  const revision = (await f.list()).revision
  const rejected = async (list: unknown[]) => {
    const response = await f.json('/api/admin/experts', { id: 'push-ops', draft: draft({ scenarios: list }), revision })
    assert.equal(response.status, 400)
    const body = await response.json() as { error: string; issues: string[] }
    assert.equal(body.error, 'INVALID_EXPERT')
    return body.issues.join('\n')
  }
  const one = (extra: Record<string, unknown>) => [{ id: 'a', title: '场景', prompt: '提问', ...extra }]
  assert.match(await rejected(one({ title: '一二三四五六七八九十一二三四五六七' })), /常用场景第 1 个：场景名称不超过 16 个字/)
  assert.match(await rejected(one({ prompt: '问'.repeat(301) })), /提问模板不超过 300 个字/)
  assert.match(await rejected(one({ prompt: '【一】【二】【三】【四】' })), /【】最多 3 处/)
  assert.match(await rejected(one({ modeId: 'spreadsheet' })), /工作模式无效/)
  assert.match(await rejected(one({ automationTemplateId: 'daily-report' })), /未知字段 automationTemplateId/)
  assert.match(await rejected(one({ prompt: '调用接口时带上 Bearer abcdefghijklmnopqrstuvwxyz' })), /密钥、令牌或密码/)
  assert.match(await rejected(one({ id: 'Not Kebab' })), /场景 ID 无效/)
  assert.match(await rejected([...one({}), { id: 'a', title: '另一个', prompt: '提问' }]), /常用场景第 2 个：场景 ID 重复/)
  assert.match(await rejected([...one({}), { id: 'b', title: '场景', prompt: '提问' }]), /场景名称「场景」重复/)
  assert.match(await rejected(Array.from({ length: 9 }, (_, index) => ({ id: `s-${index}`, title: `场景 ${index}`, prompt: '提问' }))), /最多 8 个常用场景/)

  await createPublished(f, { mode: 'everyone' }, { scenarios })
  const stored = (await (await fetch(f.origin + '/api/admin/experts/push-ops', { headers: f.headers })).json()).expert
  assert.deepEqual(stored.draft.scenarios, canonical)
  assert.equal(stored.draftChanged, false)
  const snapshot = JSON.parse(await readFile(path.join(f.content, 'experts', 'versions', 'push-ops', '1.json'), 'utf8'))
  assert.deepEqual(snapshot.content.scenarios, canonical)

  // A client built before scenarios: no scenarios key, the scenario names as prompt suggestions, no overrides key.
  const legacy = await f.catalog()
  assert.equal(legacy.headers.get('vary'), 'X-Ops-Employee-Id, X-Ops-Expert-Features')
  const legacyBody = await legacy.json()
  assert.equal('scenarios' in legacyBody.experts[0], false)
  assert.deepEqual(legacyBody.experts[0].starterPrompts, ['周末促活推送', '推送复盘'])
  assert.equal('builtinScenarios' in legacyBody, false)
  // A client that reads scenarios.
  const current = await f.catalog(undefined, FEATURES)
  const currentBody = await current.json()
  assert.deepEqual(currentBody.experts[0].scenarios, canonical)
  assert.deepEqual(currentBody.experts[0].starterPrompts, ['周末促活推送', '推送复盘'])
  assert.equal('builtinScenarios' in currentBody, false)
  const parsed = parseCloudExpertCatalog(currentBody)
  assert.deepEqual(parsed.rejected, [])
  assert.deepEqual(parsed.catalog.experts[0]!.scenarios, canonical)
  // Each feature set has its own tag; a tag never revalidates the other set.
  const legacyTag = legacy.headers.get('etag')!, currentTag = current.headers.get('etag')!
  assert.notEqual(legacyTag, currentTag)
  assert.equal((await f.catalog(undefined, { 'If-None-Match': legacyTag })).status, 304)
  assert.equal((await f.catalog(undefined, { ...FEATURES, 'If-None-Match': currentTag })).status, 304)
  assert.equal((await f.catalog(undefined, { ...FEATURES, 'If-None-Match': legacyTag })).status, 200)
  assert.equal((await f.catalog(undefined, { 'X-Ops-Expert-Features': 'unknown, SCENARIOS ', 'If-None-Match': currentTag })).status, 304)
})

test('an expert without scenarios keeps its digest and an old snapshot still serves', async t => {
  const f = await fixture(t)
  let revision = await createPublished(f)
  // Saving an empty list stores no key: the published expert shows no unpublished changes.
  const stored = (await (await fetch(f.origin + '/api/admin/experts/push-ops', { headers: f.headers })).json()).expert.draft
  const saved = await f.json('/api/admin/experts/push-ops', { draft: { ...stored, scenarios: [] }, revision }, 'PUT')
  assert.equal(saved.status, 200)
  const body = await saved.json()
  revision = body.revision
  assert.equal('scenarios' in body.expert.draft, false)
  assert.equal(body.expert.draftChanged, false)
  const catalog = JSON.parse(await readFile(path.join(f.content, 'experts', 'catalog.json'), 'utf8'))
  assert.equal('scenarios' in catalog.experts[0].draft, false)
  const again = await f.json('/api/admin/experts/push-ops/publish', { revision })
  assert.equal((await again.json()).error, 'NOTHING_TO_PUBLISH')
  // The snapshot on disk carries no scenarios (as every snapshot written before them); a fresh store reads it.
  const snapshot = JSON.parse(await readFile(path.join(f.content, 'experts', 'versions', 'push-ops', '1.json'), 'utf8'))
  assert.equal('scenarios' in snapshot.content, false)
  const fresh = new ExpertStore(f.content)
  for (const features of [new Set<'scenarios'>(), new Set<'scenarios'>(['scenarios'])]) {
    const served = await fresh.publicCatalog('s00526367', features)
    assert.equal(served.body.experts.length, 1)
    assert.deepEqual(served.body.experts[0]!.starterPrompts, ['帮我策划一次周末促活推送'])
    assert.equal(JSON.stringify(served.body).includes('"scenarios"'), false)
  }
  for (const headers of [{}, FEATURES]) assert.equal((await f.catalog('s00526367', headers)).status, 200)
})

test('package scenarios import into the draft and a re-import reports what changed', async t => {
  const f = await fixture(t)
  const first = (await (await f.upload('/api/admin/experts/import', expertPackage({ definition: { scenarios: canonical } }))).json()).preview
  assert.deepEqual(first.errors, [])
  assert.deepEqual(first.expert.scenarios, ['周末促活推送', '推送复盘'])
  const applied = await f.json(`/api/admin/experts/import/${first.importId}/apply`, { target: { mode: 'create', id: 'push-ops' }, publish: true, revision: (await f.list()).revision })
  assert.equal(applied.status, 200)
  const expert = (await applied.json()).expert
  assert.deepEqual(expert.draft.scenarios, canonical)
  assert.equal(expert.draftChanged, false)

  const next = [{ ...canonical[1]!, prompt: '复盘【活动名称】的推送效果，列出三条改进建议' }, canonical[0]!, { id: 'push-copy', title: '推送文案', prompt: '为【活动】写三版推送文案' }]
  const second = (await (await f.upload('/api/admin/experts/import', expertPackage({ definition: { scenarios: next } }))).json()).preview
  assert.deepEqual(second.changes.scenarios, { added: ['推送文案'], removed: [], updated: ['推送复盘'], reordered: true })
  const third = (await (await f.upload('/api/admin/experts/import', expertPackage())).json()).preview
  assert.deepEqual(third.changes.scenarios, { added: [], removed: ['周末促活推送', '推送复盘'], updated: [], reordered: false })

  // The package format is strict: a field this website does not know is refused, not dropped.
  const refused = await f.upload('/api/admin/experts/import', expertPackage({ definition: { scenarios: [{ ...canonical[0]!, automationTemplateId: 'x' }] } }))
  assert.equal(refused.status, 400)
  const reason = await refused.json()
  assert.equal(reason.error, 'INVALID_EXPERT_PACKAGE')
  assert.match(reason.issues.join(), /常用场景第 1 个：场景包含未知字段 automationTemplateId/)
})

test('scenario names a package carries as prompt suggestions do not outlive the scenarios', async t => {
  const f = await fixture(t)
  const titles = ['周末促活推送', '推送复盘'], legacy = ['帮我策划一次周末促活推送']
  const importAndApply = async (bytes: Buffer, target: { mode: 'create' | 'update'; id: string }) => {
    const { preview } = await (await f.upload('/api/admin/experts/import', bytes)).json()
    assert.deepEqual(preview.errors, [])
    const applied = await f.json(`/api/admin/experts/import/${preview.importId}/apply`, { target, adoptAllowlist: true, publish: true, revision: (await f.list()).revision })
    assert.equal(applied.status, 200)
    return { preview, ...(await applied.json()) as { revision: string; expert: { draft: Record<string, unknown> & { starterPrompts: string[] } } } }
  }
  const dropScenarios = async (id: string, draftValue: Record<string, unknown>, revision: string) => {
    const saved = await f.json(`/api/admin/experts/${id}`, { draft: { ...draftValue, scenarios: [] }, revision }, 'PUT')
    assert.equal(saved.status, 200)
    const published = await f.json(`/api/admin/experts/${id}/publish`, { revision: (await saved.json()).revision })
    assert.equal(published.status, 200)
  }
  const served = async (id: string) => {
    const body = await (await f.catalog('s00526367', FEATURES)).json() as { experts: Array<{ id: string; starterPrompts: string[] }> }
    return body.experts.find(item => item.id === id)!.starterPrompts
  }
  // As the product exports an expert that has scenarios: the prompt suggestions are the scenario names.
  const exported = (origin?: Record<string, unknown>) => expertPackage({ definition: { scenarios: canonical, starterPrompts: titles }, ...(origin ? { origin } : {}) })

  // A new expert keeps no suggestions of its own; clients without scenarios still see the names while they exist.
  const created = await importAndApply(exported({ expertId: 'product-default-custom-new' }), { mode: 'create', id: 'push-new' })
  assert.deepEqual(created.expert.draft.starterPrompts, [])
  assert.deepEqual(created.expert.draft.scenarios, canonical)
  assert.deepEqual(await served('push-new'), titles)
  assert.deepEqual((await (await f.catalog('s00526367')).json()).experts.find((item: { id: string }) => item.id === 'push-new').starterPrompts, titles)
  await dropScenarios('push-new', created.expert.draft, created.revision)
  assert.deepEqual(await served('push-new'), [])

  // An expert with its own suggestions keeps them through an import that brings scenarios, and shows them again without.
  await importAndApply(expertPackage(), { mode: 'create', id: 'push-ops' })
  const again = await (await f.upload('/api/admin/experts/import', exported())).json()
  assert.deepEqual(again.preview.target, { mode: 'update', id: 'push-ops' })
  assert.equal(again.preview.changes.basics, false)
  assert.deepEqual(again.preview.changes.scenarios.added, titles)
  const updated = await importAndApply(exported(), { mode: 'update', id: 'push-ops' })
  assert.deepEqual(updated.expert.draft.starterPrompts, legacy)
  assert.deepEqual(await served('push-ops'), titles)
  await dropScenarios('push-ops', updated.expert.draft, updated.revision)
  assert.deepEqual(await served('push-ops'), legacy)

  // Suggestions that are not the scenario names are the creator's own and are kept as they are.
  const own = await importAndApply(expertPackage({ definition: { scenarios: canonical, starterPrompts: ['帮我写一段推送文案'] }, origin: { expertId: 'product-default-custom-own' } }), { mode: 'create', id: 'push-own' })
  assert.deepEqual(own.expert.draft.starterPrompts, ['帮我写一段推送文案'])
})

test('built-in expert scenarios are drafted, published to everyone and withdrawn', async t => {
  const f = await fixture(t)
  const route = '/api/admin/expert-builtin-scenarios'
  assert.equal((await fetch(f.origin + route)).status, 401)
  const noCsrf = await fetch(f.origin + route + '/data-analyst', { method: 'PUT', headers: { Cookie: f.headers.Cookie, Origin: f.origin, 'Content-Type': 'application/json' }, body: '{}' })
  assert.equal(noCsrf.status, 403)
  const list = () => fetch(f.origin + route, { headers: f.headers }).then(r => r.json())
  const initial = await list()
  assert.deepEqual(initial.experts.map((item: { id: string; name: string }) => [item.id, item.name]), BUILTIN_EXPERTS.map(item => [item.id, item.name]))
  assert.ok(initial.experts.every((item: { draft: unknown[]; published?: unknown; draftChanged: boolean }) => item.draft.length === 0 && !item.published && !item.draftChanged))

  for (const id of ['push-ops', 'cloud-push-ops', 'Data-Analyst']) {
    const unknown = await f.json(`${route}/${id}`, { scenarios: canonical, revision: initial.revision }, 'PUT')
    assert.equal(unknown.status, 404, id)
    assert.equal((await unknown.json()).error, 'BUILTIN_EXPERT_NOT_FOUND')
  }
  const bad = await f.json(`${route}/data-analyst`, { scenarios: [{ id: 'a', title: '', prompt: '提问' }], revision: initial.revision }, 'PUT')
  assert.equal(bad.status, 400)
  const badBody = await bad.json()
  assert.equal(badBody.error, 'INVALID_SCENARIOS')
  assert.match(badBody.issues.join(), /常用场景第 1 个：请填写场景名称/)

  const before = await f.catalog(undefined, FEATURES)
  const beforeTag = before.headers.get('etag')!
  assert.equal('builtinScenarios' in await before.json(), false)
  const legacyTag = (await f.catalog()).headers.get('etag')!

  const saved = await f.json(`${route}/data-analyst`, { scenarios, revision: initial.revision }, 'PUT')
  assert.equal(saved.status, 200)
  const draftView = await saved.json()
  assert.deepEqual(draftView.expert.draft, canonical)
  assert.equal(draftView.expert.draftChanged, true)
  assert.equal(draftView.expert.published, undefined)
  const stale = await f.json(`${route}/data-analyst/publish`, { revision: initial.revision })
  assert.equal(stale.status, 409)
  assert.equal((await stale.json()).error, 'REVISION_CONFLICT')
  // A draft reaches no one.
  assert.equal((await f.catalog(undefined, { ...FEATURES, 'If-None-Match': beforeTag })).status, 304)

  const published = await f.json(`${route}/data-analyst/publish`, { revision: draftView.revision })
  assert.equal(published.status, 200)
  const publishedView = await published.json()
  assert.equal(publishedView.expert.published.version, 1)
  assert.deepEqual(publishedView.expert.published.scenarios, canonical)
  assert.equal(publishedView.expert.draftChanged, false)
  const nothing = await f.json(`${route}/data-analyst/publish`, { revision: publishedView.revision })
  assert.equal(nothing.status, 409)
  assert.equal((await nothing.json()).error, 'NOTHING_TO_PUBLISH')

  // Everyone reading scenarios receives the override (anonymous and identified alike); the old tag no longer matches.
  for (const employee of [undefined, 's00526367']) {
    const response = await f.catalog(employee, FEATURES)
    const body = await response.json()
    assert.equal(body.builtinScenarios.length, 1)
    assert.deepEqual(body.builtinScenarios[0], { expertId: 'data-analyst', scenarios: canonical, publishedAt: publishedView.expert.published.publishedAt })
    BuiltinScenarioOverrideSchema.parse(body.builtinScenarios[0])
    const parsed = parseCloudExpertCatalog(body)
    assert.deepEqual(parsed.rejected, [])
    assert.deepEqual(parsed.catalog.builtinScenarios, body.builtinScenarios)
  }
  const afterPublish = await f.catalog(undefined, { ...FEATURES, 'If-None-Match': beforeTag })
  assert.equal(afterPublish.status, 200)
  // Clients that do not read scenarios never see the key, and their tag is untouched.
  const legacy = await f.catalog(undefined, { 'If-None-Match': legacyTag })
  assert.equal(legacy.status, 304)

  // An empty override hides what the product shipped for that expert.
  let revision = publishedView.revision as string
  const emptied = await (await f.json(`${route}/push-expert`, { scenarios: [], revision }, 'PUT')).json()
  assert.equal(emptied.expert.draftChanged, true)
  revision = (await (await f.json(`${route}/push-expert/publish`, { revision: emptied.revision })).json()).revision
  const both = await (await f.catalog(undefined, FEATURES)).json()
  assert.deepEqual(both.builtinScenarios.map((item: { expertId: string; scenarios: unknown[] }) => [item.expertId, item.scenarios.length]), [['data-analyst', 2], ['push-expert', 0]])

  // An unpublished edit keeps serving the published list.
  const edited = await (await f.json(`${route}/data-analyst`, { scenarios: canonical.slice(0, 1), revision }, 'PUT')).json()
  assert.equal(edited.expert.draftChanged, true)
  revision = edited.revision
  assert.equal((await (await f.catalog(undefined, FEATURES)).json()).builtinScenarios[0].scenarios.length, 2)

  // Withdrawing goes back to what the product shipped; every replaced file is kept in .trash.
  const withdrawn = await f.json(`${route}/data-analyst`, { revision }, 'DELETE')
  assert.equal(withdrawn.status, 200)
  const withdrawnView = await withdrawn.json()
  assert.deepEqual(withdrawnView.expert, { id: 'data-analyst', name: '数据分析专家', draft: [], draftChanged: false })
  const remaining = await (await f.catalog(undefined, FEATURES)).json()
  assert.deepEqual(remaining.builtinScenarios.map((item: { expertId: string }) => item.expertId), ['push-expert'])
  const trash = (await readdir(path.join(f.content, 'experts', '.trash'))).filter(name => name.startsWith('builtin-scenarios-'))
  assert.ok(trash.length >= 4)
  const listed = await list()
  assert.equal(listed.revision, withdrawnView.revision)
  assert.deepEqual(listed.experts.filter((item: { published?: unknown }) => item.published).map((item: { id: string }) => item.id), ['push-expert'])

  // A damaged overrides file only affects clients that read scenarios.
  await writeFile(path.join(f.content, 'experts', 'builtin-scenarios.json'), '{"schemaVersion":1}')
  assert.equal((await f.catalog()).status, 200)
  assert.equal((await f.catalog(undefined, FEATURES)).status, 503)
})

test('scenario icons are checked on every write and travel with the scenario to the catalog, imports and built-in overrides', async t => {
  const f = await fixture(t)
  const withIcons = [{ ...canonical[0]!, icon: 'megaphone' }, canonical[1]!]
  const unknownIcon = [{ ...canonical[0]!, icon: 'rocket' }]

  // An icon outside the contract's set is refused on save, naming the scenario the way the editor numbers it.
  for (const icon of ['rocket', 42, '']) {
    const refused = await f.json('/api/admin/experts', { id: 'push-ops', draft: draft({ scenarios: [{ ...canonical[0]!, icon }] }), revision: (await f.list()).revision })
    assert.equal(refused.status, 400, String(icon))
    const body = await refused.json() as { error: string; issues: string[] }
    assert.equal(body.error, 'INVALID_EXPERT')
    assert.match(body.issues.join('\n'), /常用场景第 1 个：场景图标无效/)
  }

  // A valid icon is stored, published and served to clients that read scenarios; others never receive scenarios.
  await createPublished(f, { mode: 'everyone' }, { scenarios: withIcons })
  const stored = (await (await fetch(f.origin + '/api/admin/experts/push-ops', { headers: f.headers })).json()).expert
  assert.deepEqual(stored.draft.scenarios, withIcons)
  const snapshot = JSON.parse(await readFile(path.join(f.content, 'experts', 'versions', 'push-ops', '1.json'), 'utf8'))
  assert.deepEqual(snapshot.content.scenarios, withIcons)
  const served = await (await f.catalog(undefined, FEATURES)).json()
  assert.deepEqual(served.experts[0].scenarios, withIcons)
  const parsed = parseCloudExpertCatalog(served)
  assert.deepEqual(parsed.rejected, [])
  assert.deepEqual(parsed.catalog.experts[0]!.scenarios, withIcons)
  assert.equal('scenarios' in (await (await f.catalog()).json()).experts[0], false)

  // A package's icon is checked like a saved one; a changed icon is an update of that scenario.
  const badPackage = await f.upload('/api/admin/experts/import', expertPackage({ definition: { scenarios: unknownIcon } }))
  assert.equal(badPackage.status, 400)
  const badReason = await badPackage.json()
  assert.equal(badReason.error, 'INVALID_EXPERT_PACKAGE')
  assert.match(badReason.issues.join(), /常用场景第 1 个：场景图标无效/)
  const origin = { expertId: 'product-default-custom-icons' }
  const first = (await (await f.upload('/api/admin/experts/import', expertPackage({ definition: { scenarios: withIcons }, origin }))).json()).preview
  assert.deepEqual(first.errors, [])
  const applied = await f.json(`/api/admin/experts/import/${first.importId}/apply`, { target: { mode: 'create', id: 'push-icons' }, revision: (await f.list()).revision })
  assert.equal(applied.status, 200)
  assert.deepEqual((await applied.json()).expert.draft.scenarios, withIcons)
  const recolored = (await (await f.upload('/api/admin/experts/import', expertPackage({ definition: { scenarios: [{ ...withIcons[0]!, icon: 'gift' }, withIcons[1]!] }, origin }))).json()).preview
  assert.deepEqual(recolored.target, { mode: 'update', id: 'push-icons' })
  assert.deepEqual(recolored.changes.scenarios, { added: [], removed: [], updated: ['周末促活推送'], reordered: false })

  // Built-in overrides follow the same rule and reach everyone with the icon.
  const route = '/api/admin/expert-builtin-scenarios'
  const revision = (await (await fetch(f.origin + route, { headers: f.headers })).json()).revision as string
  const badBuiltin = await f.json(`${route}/data-analyst`, { scenarios: unknownIcon, revision }, 'PUT')
  assert.equal(badBuiltin.status, 400)
  const badBuiltinBody = await badBuiltin.json()
  assert.equal(badBuiltinBody.error, 'INVALID_SCENARIOS')
  assert.match(badBuiltinBody.issues.join(), /常用场景第 1 个：场景图标无效/)
  const saved = await f.json(`${route}/data-analyst`, { scenarios: withIcons, revision }, 'PUT')
  assert.equal(saved.status, 200)
  const published = await f.json(`${route}/data-analyst/publish`, { revision: (await saved.json()).revision })
  assert.equal(published.status, 200)
  const override = (await (await f.catalog(undefined, FEATURES)).json()).builtinScenarios[0]
  assert.equal(override.expertId, 'data-analyst')
  assert.deepEqual(override.scenarios, withIcons)
  BuiltinScenarioOverrideSchema.parse(override)
})

// Contract 0.2.1/0.2.2: what a Skill installed into its own folder while it ran (a dependency install and its lock file, a checkout) is not
// content: not counted against the 2000 files and no reason to refuse the package.
test('a Skill carrying node_modules, a lock file and .git imports, without them counted', async t => {
  const f = await fixture(t)
  const files: { name: string; data?: Buffer }[] = [
    { name: 'runs-npm/SKILL.md', data: manifestOf('runs-npm') },
    { name: 'runs-npm/package.json', data: Buffer.from('{}') },
    { name: 'runs-npm/.git/HEAD', data: Buffer.from('ref: refs/heads/main') },
    { name: 'runs-npm/package-lock.json', data: Buffer.from('{}') },
  ]
  for (let index = 0; index < 2100; index++) files.push({ name: `runs-npm/node_modules/dep-${index}/index.js`, data: Buffer.from('x') })
  const uploaded = await f.upload('/api/admin/experts/import', expertPackage({ skills: [{ name: 'runs-npm', bytes: archive(files) }], origin: { expertId: 'runs-npm' } }))
  assert.equal(uploaded.status, 200)
  const { preview } = await uploaded.json()
  assert.deepEqual(preview.errors, [])
})
