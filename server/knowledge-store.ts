import { createHash, randomBytes } from 'node:crypto'
import { copyFile, lstat, readFile, rename, unlink } from 'node:fs/promises'
import { crc32, inflateRawSync } from 'node:zlib'
import path from 'node:path'
import type { IncomingMessage } from 'node:http'
import { z } from 'zod'
import { parseDocument } from 'yaml'
import {
  maxKnowledgeEntries, maxKnowledgeId, maxKnowledgeSkills, maxKnowledgeWorkflows, maxWorkflowName, maxWorkflowValue, maxSkillArchiveBytes, maxSkillArchiveEntries, maxSkillDescription,
  maxSkillFileBytes, maxSkillFileName, maxSkillName, maxTypicalIndicators, metricKnowledgeIdPattern, skillNamePattern,
  type MetricKnowledgeCatalog, type MetricKnowledgeEntry, type MetricKnowledgeSkill,
} from '../shared/knowledge.js'
import { GuideError, revisionOf } from './guide-store.js'
import { atomicJson, missing, readJson, receiveFile, safeDirectory, withLock } from './admin-files.js'

const text = (max: number) => z.string().trim().min(1).max(max)
const optionalText = (max: number) => z.string().trim().max(max).optional()
const WorkflowSchema = z.unknown().transform((input, ctx): Record<string, string> => {
  const invalid = () => { ctx.addIssue({ code: 'custom', message: 'Invalid workflow mapping' }); return z.NEVER }
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return invalid()
  const rows = Object.entries(input)
  if (rows.length > maxKnowledgeWorkflows) return invalid()
  const result: Record<string, string> = {}
  for (const [rawName, rawValue] of rows) {
    const name = rawName.trim()
    if (!name || name.length > maxWorkflowName || ['__proto__', 'prototype', 'constructor'].includes(name) || Object.hasOwn(result, name)) return invalid()
    if (typeof rawValue !== 'string' || !rawValue.trim() || rawValue.trim().length > maxWorkflowValue) return invalid()
    result[name] = rawValue.trim()
  }
  return result
})
const KnowledgeIdSchema = z.object({ card_index_knowledge_base: text(256), card_meta_knowledge_base: text(256) }).strict()
const MetaSchema = z.object({
  knowledge_description: text(2000),
  indicators_cover: optionalText(80), reports_cover: optionalText(80), update_frequency: optionalText(80),
  typical_indicators: z.array(text(80)).max(maxTypicalIndicators).optional(),
}).strict()
const SkillSchema = z.object({
  name: z.string().max(maxSkillName).regex(skillNamePattern), file_name: text(maxSkillFileName),
  sha256: z.string().regex(/^[a-f0-9]{64}$/), size: z.number().int().positive().max(maxSkillFileBytes),
  kind: z.enum(['zip', 'md']), uploaded_at: z.string().datetime(),
}).strict()
const IdSchema = z.string().max(maxKnowledgeId).regex(metricKnowledgeIdPattern)
const SkillNameSchema = z.string().max(maxSkillName).regex(skillNamePattern)
const SkillNamesSchema = z.array(SkillNameSchema).max(maxKnowledgeSkills).refine(names => new Set(names).size === names.length)
const InputSchema = z.object({
  id: IdSchema.optional(), tenant_name: text(80), tenant_id: text(128),
  knowledge_retrieve_workflow_id: WorkflowSchema, knowledge_id: KnowledgeIdSchema, knowledge_base_meta: MetaSchema,
  enabled: z.boolean(), skill_names: SkillNamesSchema.optional(),
}).strict()
const EntrySchema = InputSchema.extend({
  id: IdSchema, skill_names: SkillNamesSchema, created_at: z.string().datetime(), updated_at: z.string().datetime(),
}).strict()
const DocumentSchema = z.object({ schemaVersion: z.literal(2), updatedAt: z.string().datetime(), skills: z.array(SkillSchema).max(maxKnowledgeSkills), items: z.array(EntrySchema).max(maxKnowledgeEntries) }).strict().superRefine((document, ctx) => {
  const skillNames = new Set(document.skills.map(skill => skill.name))
  if (skillNames.size !== document.skills.length || new Set(document.items.map(item => item.id)).size !== document.items.length ||
      new Set(document.items.map(item => item.tenant_id)).size !== document.items.length || document.items.some(item => item.skill_names.some(name => !skillNames.has(name)))) {
    ctx.addIssue({ code: 'custom', message: 'Duplicate identity or invalid skill reference' })
  }
})
const LegacyDocumentSchema = z.object({ schemaVersion: z.literal(1), updatedAt: z.string().datetime(), skill: SkillSchema.optional(),
  items: z.array(EntrySchema.extend({ skill: SkillSchema.optional(), skill_names: SkillNamesSchema.optional() })).max(maxKnowledgeEntries),
}).strict()
type CatalogDocument = z.infer<typeof DocumentSchema>
type LoadedDocument = CatalogDocument & { revision: string; migrated: boolean }
type KnowledgeInput = z.infer<typeof InputSchema>

const fail = (code: string, status = 400): never => { throw new GuideError(code, status) }
/**
 * Only schema 1 catalogs normalize this historical typo. Schema 2 allows arbitrary user-defined names.
 */
function normaliseLegacyWorkflowKey(input: unknown): unknown {
  const fix = (entry: unknown): unknown => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return entry
    const record = entry as Record<string, unknown>
    const workflows = record.knowledge_retrieve_workflow_id
    if (typeof workflows !== 'object' || workflows === null || Array.isArray(workflows)) return entry
    if (!('quer_card_data' in workflows)) return entry
    const { quer_card_data: legacy, ...rest } = workflows as Record<string, unknown>
    return { ...record, knowledge_retrieve_workflow_id: 'query_card_data' in rest ? rest : { ...rest, query_card_data: legacy } }
  }
  if (typeof input === 'object' && input !== null && !Array.isArray(input) && Array.isArray((input as { items?: unknown }).items)) {
    return { ...(input as Record<string, unknown>), items: (input as { items: unknown[] }).items.map(fix) }
  }
  return fix(input)
}

function parse<T>(schema: z.ZodType<T>, input: unknown, code = 'INVALID_KNOWLEDGE', status = 400): T {
  const result = schema.safeParse(input)
  if (!result.success) return fail(code, status)
  return result.data
}
// The stored document never contains its own hash; `revision` is derived from the normalized bytes.
const revisionOfDocument = (document: CatalogDocument) => revisionOf(JSON.stringify(document))
const emptyDocument: CatalogDocument = { schemaVersion: 2, updatedAt: new Date(0).toISOString(), skills: [], items: [] }

export function parseSkillFrontmatter(bytes: Buffer): { name: string; description: string } {
  if (bytes.length > maxSkillFileBytes) return fail('INVALID_SKILL_FILE')
  const raw = bytes.toString('utf8').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(raw)
  if (!match || match[1]!.length > 4096) return fail('INVALID_SKILL_FILE')
  let meta: Record<string, unknown>
  try {
    const parsed = parseDocument(match[1]!, { uniqueKeys: true, schema: 'core' })
    if (parsed.errors.length) return fail('INVALID_SKILL_FILE')
    meta = parsed.toJS({ maxAliasCount: 0 })
  } catch { return fail('INVALID_SKILL_FILE') }
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return fail('INVALID_SKILL_FILE')
  const name = meta.name, description = meta.description
  if (typeof name !== 'string' || name.length > maxSkillName || !skillNamePattern.test(name)) return fail('INVALID_SKILL_FILE')
  if (typeof description !== 'string' || !description.trim() || description.length > maxSkillDescription) return fail('INVALID_SKILL_FILE')
  return { name, description: description.trim() }
}

export type ArchiveEntry = { name: string; method: number; compressed: number; size: number; crc: number; offset: number }
/** Bounds of one archive read and the error it fails with; the defaults are the companion Skill limits. */
export type ArchiveLimits = { maxBytes: number; maxEntries: number; maxExtractedBytes: number; code: string; /** Levels of an entry name (default 16). */ maxDepth?: number }
const skillArchiveLimits: ArchiveLimits = { maxBytes: maxSkillFileBytes, maxEntries: maxSkillArchiveEntries, maxExtractedBytes: maxSkillArchiveBytes, code: 'INVALID_SKILL_FILE' }
function archiveName(name: string, code: string, maxDepth = 16) {
  if (!name || name.length > 255 || name.includes('\\') || name.includes('\0') || /^[A-Za-z]:/.test(name)) return fail(code)
  const segments = name.split('/')
  if (segments.length > maxDepth) return fail(code)
  segments.forEach((segment, index) => {
    if (segment === '.' || segment === '..') return fail(code)
    if (!segment && index !== segments.length - 1) return fail(code)
  })
  return name
}
// Minimal central-directory reader: stored and deflate only, no zip64, encryption, spanning or path escapes.
export function readArchive(bytes: Buffer, limits: ArchiveLimits = skillArchiveLimits): ArchiveEntry[] {
  const fail = (code = limits.code): never => { throw new GuideError(code, 400) }
  if (bytes.length < 22 || bytes.length > limits.maxBytes) return fail()
  let eocd = -1
  for (let i = bytes.length - 22; i >= 0 && i >= bytes.length - 22 - 0xffff; i--) if (bytes.readUInt32LE(i) === 0x06054b50) { eocd = i; break }
  if (eocd < 0) return fail()
  if (eocd + 22 + bytes.readUInt16LE(eocd + 20) !== bytes.length) return fail()
  if (eocd >= 20 && bytes.readUInt32LE(eocd - 20) === 0x07064b50) return fail()
  const disk = bytes.readUInt16LE(eocd + 4), start = bytes.readUInt16LE(eocd + 6)
  const local = bytes.readUInt16LE(eocd + 8), total = bytes.readUInt16LE(eocd + 10)
  const size = bytes.readUInt32LE(eocd + 12), offset = bytes.readUInt32LE(eocd + 16)
  if (disk !== 0 || start !== 0 || local !== total) return fail()
  if (total === 0xffff || size === 0xffffffff || offset === 0xffffffff) return fail()
  if (!total || total > limits.maxEntries || offset + size !== eocd) return fail()
  const entries: ArchiveEntry[] = []
  const names = new Set<string>()
  let cursor = offset, extracted = 0
  for (let index = 0; index < total; index++) {
    if (cursor + 46 > eocd || bytes.readUInt32LE(cursor) !== 0x02014b50) return fail()
    const flags = bytes.readUInt16LE(cursor + 8), method = bytes.readUInt16LE(cursor + 10)
    const crc = bytes.readUInt32LE(cursor + 16), compressed = bytes.readUInt32LE(cursor + 20), plain = bytes.readUInt32LE(cursor + 24)
    const nameLength = bytes.readUInt16LE(cursor + 28), extraLength = bytes.readUInt16LE(cursor + 30), commentLength = bytes.readUInt16LE(cursor + 32)
    const entryDisk = bytes.readUInt16LE(cursor + 34), external = bytes.readUInt32LE(cursor + 38), header = bytes.readUInt32LE(cursor + 42)
    const next = cursor + 46 + nameLength + extraLength + commentLength
    if (next > eocd) return fail()
    if (flags & 0x1 || flags & 0x40 || flags & 0x2000) return fail()
    if (method !== 0 && method !== 8) return fail()
    if (entryDisk !== 0 || compressed === 0xffffffff || plain === 0xffffffff || header === 0xffffffff) return fail()
    if ((external >>> 16 & 0xf000) === 0xa000) return fail()
    const name = archiveName(bytes.toString('utf8', cursor + 46, cursor + 46 + nameLength), limits.code, limits.maxDepth)
    const directory = name.endsWith('/')
    if (flags & 0x8 && !directory && (!compressed || !plain)) return fail()
    if (directory && plain) return fail()
    for (let extra = cursor + 46 + nameLength; extra + 4 <= cursor + 46 + nameLength + extraLength; extra += 4 + bytes.readUInt16LE(extra + 2)) {
      if (bytes.readUInt16LE(extra) === 0x0001) return fail()
    }
    if (names.has(name)) return fail()
    names.add(name)
    extracted += plain
    if (extracted > limits.maxExtractedBytes) return fail()
    if (header + 30 > offset) return fail()
    entries.push({ name, method, compressed, size: plain, crc, offset: header })
    cursor = next
  }
  if (cursor !== eocd) return fail()
  return entries
}
/** `copy: false` returns a stored entry as a view of `bytes` (a package of up to 1 GB is not copied entry by entry). */
export function extractArchiveEntry(bytes: Buffer, entry: ArchiveEntry, code = 'INVALID_SKILL_FILE', copy = true): Buffer {
  const at = entry.offset
  if (at + 30 > bytes.length || bytes.readUInt32LE(at) !== 0x04034b50) return fail(code)
  const flags = bytes.readUInt16LE(at + 6), method = bytes.readUInt16LE(at + 8)
  const nameLength = bytes.readUInt16LE(at + 26), extraLength = bytes.readUInt16LE(at + 28)
  if (flags & 0x1 || method !== entry.method) return fail(code)
  if (bytes.toString('utf8', at + 30, at + 30 + nameLength) !== entry.name) return fail(code)
  const from = at + 30 + nameLength + extraLength
  if (from + entry.compressed > bytes.length) return fail(code)
  const raw = bytes.subarray(from, from + entry.compressed)
  let data: Buffer
  try { data = entry.method === 0 ? (copy ? Buffer.from(raw) : raw) : inflateRawSync(raw, { maxOutputLength: Math.max(entry.size, 1) }) }
  catch { return fail(code) }
  if (data.length !== entry.size || crc32(data) !== entry.crc) return fail(code)
  return data
}
// The archive must carry exactly one SKILL.md, at the root or directly inside the single top-level directory.
export function inspectSkillArchive(bytes: Buffer) {
  const entries = readArchive(bytes)
  const candidates = entries.filter(entry => entry.name.split('/').at(-1) === 'SKILL.md')
  if (candidates.length !== 1) return fail('INVALID_SKILL_FILE')
  const target = candidates[0]!
  const segments = target.name.split('/')
  if (segments.length > 2) return fail('INVALID_SKILL_FILE')
  const directory = segments.length === 2 ? segments[0]! : undefined
  if (directory && new Set(entries.map(entry => entry.name.split('/')[0])).size !== 1) return fail('INVALID_SKILL_FILE')
  const frontmatter = parseSkillFrontmatter(extractArchiveEntry(bytes, target))
  if (directory && directory !== frontmatter.name) return fail('INVALID_SKILL_FILE')
  return frontmatter
}

export class KnowledgeStore {
  readonly root: string
  readonly skills: string
  constructor(directory: string) { this.root = path.join(directory, 'knowledge'); this.skills = path.join(this.root, 'skills') }

  private async load(): Promise<LoadedDocument> {
    let raw: unknown
    // Covers 500 fully populated entries, including worst-case escaped workflow keys and values.
    try { raw = await readJson(this.root, ['catalog.json'], 96 * 1024 ** 2) }
    catch (error) {
      if (missing(error)) return { ...emptyDocument, revision: revisionOfDocument(emptyDocument), migrated: false }
      if (error instanceof GuideError) throw error
      return fail('CONTENT_UNAVAILABLE', 503)
    }
    const migrated = typeof raw === 'object' && raw !== null && (raw as { schemaVersion?: unknown }).schemaVersion === 1
    if (migrated) {
      const legacy = parse(LegacyDocumentSchema, normaliseLegacyWorkflowKey(raw), 'CONTENT_UNAVAILABLE', 503)
      raw = { schemaVersion: 2, updatedAt: legacy.updatedAt, skills: legacy.skill ? [legacy.skill] : [], items: legacy.items.map(({ skill: _ignored, ...item }) => ({
        ...item, skill_names: item.skill_names ?? (legacy.skill ? [legacy.skill.name] : []),
      })) }
    }
    const document = parse(DocumentSchema, raw, 'CONTENT_UNAVAILABLE', 503)
    return { ...document, revision: revisionOfDocument(document), migrated }
  }
  private async backup() {
    const trash = path.join(this.root, '.trash')
    try { await lstat(path.join(this.root, 'catalog.json')) } catch (error) { if (missing(error)) return; throw error }
    await safeDirectory(trash)
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    await copyFile(path.join(this.root, 'catalog.json'), path.join(trash, `catalog-${stamp}.json`))
  }
  private async commit(items: MetricKnowledgeEntry[], skills: MetricKnowledgeSkill[], destructive: boolean) {
    const document = parse(DocumentSchema, { schemaVersion: 2, updatedAt: new Date().toISOString(), skills, items })
    if (destructive) await this.backup()
    await atomicJson(this.root, 'catalog.json', document)
    return { ...document, revision: revisionOfDocument(document) }
  }
  private change<T>(expected: unknown, action: (current: LoadedDocument) => Promise<T>) {
    return withLock(this.root, '.knowledge-lock', async () => {
      const current = await this.load()
      if (current.revision !== expected) return fail('REVISION_CONFLICT', 409)
      return action(current)
    })
  }
  private found(document: CatalogDocument, id: string) {
    const entry = document.items.find(item => item.id === id)
    if (!entry) return fail('KNOWLEDGE_NOT_FOUND', 404)
    return entry
  }
  private async replace(current: LoadedDocument, entry: MetricKnowledgeEntry, destructive: boolean) {
    const document = await this.commit(current.items.map(item => item.id === entry.id ? entry : item), current.skills, destructive || current.migrated)
    return { revision: document.revision, updatedAt: document.updatedAt, entry: this.found(document, entry.id) }
  }
  private validateReferences(current: CatalogDocument, names: string[]) {
    if (names.some(name => !current.skills.some(skill => skill.name === name))) return fail('INVALID_SKILL_REFERENCE')
  }
  private selectSkill(current: CatalogDocument, name?: string) {
    if (name === undefined && current.skills.length > 1) return fail('SKILL_NAME_REQUIRED', 409)
    const skill = name === undefined ? current.skills[0] : current.skills.find(skill => skill.name === name)
    if (!skill) return fail('SKILL_NOT_FOUND', 404)
    return skill
  }

  async list(): Promise<MetricKnowledgeCatalog> {
    const { migrated: _migrated, ...catalog } = await this.load()
    return catalog
  }
  async publicList(): Promise<MetricKnowledgeCatalog> {
    const catalog = await this.list()
    return { ...catalog, items: catalog.items.filter(item => item.enabled) }
  }
  async create(input: unknown, expected: unknown) {
    const value: KnowledgeInput = parse(InputSchema, input)
    return this.change(expected, async current => {
      if (current.items.length >= maxKnowledgeEntries) return fail('KNOWLEDGE_LIMIT', 409)
      const { id: requested, ...rest } = value
      let id = requested
      if (!id) do { id = `metrics-${randomBytes(5).toString('hex')}` } while (current.items.some(item => item.id === id))
      if (current.items.some(item => item.id === id)) return fail('KNOWLEDGE_ID_TAKEN', 409)
      if (current.items.some(item => item.tenant_id === value.tenant_id)) return fail('TENANT_ID_TAKEN', 409)
      const skill_names = value.skill_names ?? []
      this.validateReferences(current, skill_names)
      const now = new Date().toISOString()
      const document = await this.commit([...current.items, { id, ...rest, skill_names, created_at: now, updated_at: now }], current.skills, current.migrated)
      return { revision: document.revision, updatedAt: document.updatedAt, entry: this.found(document, id) }
    })
  }
  async update(id: string, input: unknown, expected: unknown) {
    const value: KnowledgeInput = parse(InputSchema, input)
    parse(IdSchema, id)
    // The identifier is part of the public contract and never changes after creation.
    if (value.id !== undefined && value.id !== id) return fail('INVALID_KNOWLEDGE')
    return this.change(expected, async current => {
      const previous = this.found(current, id)
      if (current.items.some(item => item.id !== id && item.tenant_id === value.tenant_id)) return fail('TENANT_ID_TAKEN', 409)
      const { id: ignored, ...rest } = value
      const skill_names = value.skill_names ?? previous.skill_names
      this.validateReferences(current, skill_names)
      return this.replace(current, { id, ...rest, skill_names, created_at: previous.created_at, updated_at: new Date().toISOString() }, true)
    })
  }
  async remove(id: string, expected: unknown) {
    parse(IdSchema, id)
    return this.change(expected, async current => {
      this.found(current, id)
      // Deleting a library leaves registered skills and immutable file bytes intact.
      const document = await this.commit(current.items.filter(item => item.id !== id), current.skills, true)
      return { revision: document.revision, updatedAt: document.updatedAt }
    })
  }
  /** Register a Skill, replacing the file for the same stable name without changing references. */
  async attachSkill(name: string, req: IncomingMessage, expected: unknown) {
    if (unsafeFileName(name)) return fail('INVALID_SKILL_FILE')
    const kind = /\.zip$/i.test(name) ? 'zip' as const : /\.md$/i.test(name) ? 'md' as const : fail('INVALID_SKILL_FILE')
    await safeDirectory(this.root); await safeDirectory(this.skills)
    const file = await receiveFile(req, this.skills, maxSkillFileBytes)
    try {
      const bytes = await readFile(file.temp)
      const skill = kind === 'zip' ? inspectSkillArchive(bytes) : parseSkillFrontmatter(bytes)
      const sha256 = createHash('sha256').update(bytes).digest('hex')
      const stored = `${sha256}.${kind}`
      return await this.change(expected, async current => {
        const existing = current.skills.some(item => item.name === skill.name)
        if (!existing && current.skills.length >= maxKnowledgeSkills) return fail('KNOWLEDGE_SKILL_LIMIT', 409)
        // Content-addressed and immutable: an identical file is reused, never rewritten.
        try {
          const info = await lstat(path.join(this.skills, stored))
          if (!info.isFile() || info.isSymbolicLink() || info.size !== file.size) return fail('CONTENT_UNAVAILABLE', 503)
        } catch (error) { if (!missing(error)) throw error; await rename(file.temp, path.join(this.skills, stored)) }
        const value: MetricKnowledgeSkill = { name: skill.name, file_name: name, sha256, size: file.size, kind, uploaded_at: new Date().toISOString() }
        const skills = existing ? current.skills.map(item => item.name === value.name ? value : item) : [...current.skills, value]
        const document = await this.commit(current.items, skills, existing || current.migrated)
        return { revision: document.revision, updatedAt: document.updatedAt, skill: value, skills: document.skills }
      })
    } finally { await unlink(file.temp).catch(error => { if (!missing(error)) throw error }) }
  }
  async detachSkill(expected: unknown, name?: string) {
    if (name !== undefined) parse(SkillNameSchema, name)
    return this.change(expected, async current => {
      const skill = this.selectSkill(current, name)
      if (current.items.some(item => item.skill_names.includes(skill.name))) return fail('SKILL_IN_USE', 409)
      const document = await this.commit(current.items, current.skills.filter(item => item.name !== skill.name), true)
      return { revision: document.revision, updatedAt: document.updatedAt }
    })
  }
  async openSkill(skillName?: string) {
    if (skillName !== undefined && !SkillNameSchema.safeParse(skillName).success) return fail('SKILL_NOT_FOUND', 404)
    const document = await this.load()
    const { name, sha256, size, kind, file_name: fileName } = this.selectSkill(document, skillName)
    return {
      root: this.root, segments: ['skills', `${sha256}.${kind}`], size, sha256, name, fileName,
      type: kind === 'zip' ? 'application/zip' : 'text/markdown; charset=utf-8',
    }
  }
}

function unsafeFileName(name: string): boolean {
  return !name || name.length > maxSkillFileName || [...name].some(char => char === '/' || char === '\\' || char.charCodeAt(0) < 32)
}
