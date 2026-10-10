<script setup lang="ts">
import { computed, nextTick, onMounted, onBeforeUnmount, ref, watch } from 'vue'
import type { MetricKnowledgeCatalog, MetricKnowledgeEntry, MetricKnowledgeSkill } from '../shared/knowledge'
import { maxKnowledgeSkills, maxKnowledgeWorkflows, maxSkillFileBytes, maxTypicalIndicators, maxWorkflowName, maxWorkflowValue, metricKnowledgeIdPattern, validWorkflowName, legacyKnowledgeCompatible } from '../shared/knowledge'
import { ApiError, guideApi, requestMessage, uploadFile } from './guide-api'
import WebsiteDialog from './WebsiteDialog.vue'

type WorkflowRow = { id: number; name: string; value: string }
type UploadResult = { file: string; status: 'saved' | 'failed' | 'cancelled' | 'skipped'; message: string }
let workflowSequence = 0
const workflowRow = (name = '', value = ''): WorkflowRow => ({ id: ++workflowSequence, name, value })
type Form = {
  id: string; tenant_name: string; tenant_id: string
  workflows: WorkflowRow[]; skill_name: string | null | undefined
  card_index_knowledge_base: string; card_meta_knowledge_base: string
  knowledge_description: string; indicators_cover: string; reports_cover: string; update_frequency: string
  typical_indicators: string; enabled: boolean
}
const empty = (): Form => ({
  id: '', tenant_name: '', tenant_id: '', workflows: ['get_card_index', 'get_card_meta', 'query_card_data'].map(name => workflowRow(name)), skill_name: null,
  card_index_knowledge_base: '', card_meta_knowledge_base: '', knowledge_description: '',
  indicators_cover: '', reports_cover: '', update_frequency: '', typical_indicators: '', enabled: true,
})
const props = defineProps<{ csrf: string }>()
const emit = defineEmits<{ error: [e: unknown]; dirty: [v: boolean]; busy: [v: boolean] }>()
const items = ref<MetricKnowledgeEntry[]>([]), revision = ref(''), current = ref<MetricKnowledgeEntry>(), creating = ref(false)
const skills = ref<MetricKnowledgeSkill[]>([])
const legacySkillName = ref<string | null>(), legacyChoice = ref<string | null>()
const form = ref<Form>(empty()), baseline = ref('')
const busy = ref(false), loading = ref(true), notice = ref(''), error = ref(''), progress = ref(0), uploadName = ref('')
const errorElement = ref<HTMLElement>(), fileInput = ref<HTMLInputElement>(), tenantInput = ref<HTMLInputElement>()
const addWorkflowButton = ref<HTMLButtonElement>(), workflowInputs = new Map<number, HTMLInputElement>()
const uploadResults = ref<UploadResult[]>([]), uploadIndex = ref(0), uploadTotal = ref(0)
const confirmation = ref<{ title: string; message: string; label?: string; action: () => void }>()
const lifetime = new AbortController()
let upload: AbortController | undefined
const active = computed(() => Boolean(current.value || creating.value))
const dirty = computed(() => active.value && JSON.stringify(form.value) !== baseline.value)
watch(dirty, v => emit('dirty', v)); watch(busy, v => emit('busy', v))
const call = <T,>(url: string, options: { method?: string; data?: unknown } = {}) =>
  guideApi<T>(url, { ...options, csrf: props.csrf, signal: lifetime.signal })
async function run(fn: () => Promise<void>) {
  if (busy.value) return
  busy.value = true; notice.value = ''; error.value = ''
  try { await fn() } catch (e) {
    error.value = requestMessage(e)
    if (e instanceof ApiError && ['AUTH_REQUIRED', 'CSRF_REJECTED'].includes(e.code)) emit('error', e)
    await nextTick(); errorElement.value?.focus()
  } finally { busy.value = false }
}
async function list() {
  const catalog = await call<MetricKnowledgeCatalog>('/api/admin/knowledge')
  items.value = catalog.items; revision.value = catalog.revision; skills.value = catalog.skills; legacySkillName.value = catalog.legacy_skill_name
  loading.value = false
}
function adopt(entry: MetricKnowledgeEntry) {
  creating.value = false; current.value = entry
  const meta = entry.knowledge_base_meta
  form.value = {
    id: entry.id, tenant_name: entry.tenant_name, tenant_id: entry.tenant_id,
    workflows: Object.entries(entry.knowledge_retrieve_workflow_id).map(([name, value]) => workflowRow(name, value)),
    skill_name: entry.pending_skill_names?.length ? undefined : entry.skill_name,
    card_index_knowledge_base: entry.knowledge_id.card_index_knowledge_base,
    card_meta_knowledge_base: entry.knowledge_id.card_meta_knowledge_base,
    knowledge_description: meta.knowledge_description, indicators_cover: meta.indicators_cover ?? '',
    reports_cover: meta.reports_cover ?? '', update_frequency: meta.update_frequency ?? '',
    typical_indicators: (meta.typical_indicators ?? []).join('\n'), enabled: entry.enabled,
  }
  baseline.value = JSON.stringify(form.value)
}
function guard(action: () => void) {
  if (busy.value) return
  if (dirty.value) confirmation.value = { title: '放弃未保存的修改？', message: '已保存的知识库条目和技能文件会保留。', label: '放弃修改', action }
  else action()
}
function select(entry: MetricKnowledgeEntry) { guard(() => { adopt(entry); error.value = ''; notice.value = '' }) }
function create() {
  guard(() => {
    creating.value = true; current.value = undefined
    form.value = empty(); baseline.value = JSON.stringify(form.value); notice.value = ''; error.value = ''
    void nextTick(() => tenantInput.value?.focus())
  })
}
function indicators() { return form.value.typical_indicators.split(/\r?\n/).map(v => v.trim()).filter(Boolean) }
function setWorkflowInput(id: number, element: unknown) {
  if (element instanceof HTMLInputElement) workflowInputs.set(id, element)
  else workflowInputs.delete(id)
}
async function addWorkflow() {
  if (busy.value || form.value.workflows.length >= maxKnowledgeWorkflows) return
  const row = workflowRow()
  form.value.workflows.push(row)
  await nextTick(); workflowInputs.get(row.id)?.focus()
}
async function removeWorkflow(id: number) {
  const index = form.value.workflows.findIndex(row => row.id === id)
  if (busy.value || index < 0) return
  form.value.workflows.splice(index, 1)
  await nextTick()
  const next = form.value.workflows[index] ?? form.value.workflows[index - 1]
  if (next) workflowInputs.get(next.id)?.focus()
  else addWorkflowButton.value?.focus()
}
function skillUsers(name: string) { return items.value.filter(item => item.skill_name === name || item.pending_skill_names?.includes(name)) }
async function validationError(message: string, row?: WorkflowRow) {
  error.value = message
  await nextTick()
  if (row) workflowInputs.get(row.id)?.focus()
  else errorElement.value?.focus()
}
function payload() {
  const value = form.value
  const meta: Record<string, unknown> = { knowledge_description: value.knowledge_description.trim() }
  if (value.indicators_cover.trim()) meta.indicators_cover = value.indicators_cover.trim()
  if (value.reports_cover.trim()) meta.reports_cover = value.reports_cover.trim()
  if (value.update_frequency.trim()) meta.update_frequency = value.update_frequency.trim()
  if (indicators().length) meta.typical_indicators = indicators()
  return {
    ...(creating.value && value.id.trim() ? { id: value.id.trim() } : {}),
    tenant_name: value.tenant_name.trim(), tenant_id: value.tenant_id.trim(),
    knowledge_retrieve_workflow_id: Object.fromEntries(value.workflows.map(row => [row.name.trim(), row.value.trim()])),
    skill_name: value.skill_name,
    knowledge_id: { card_index_knowledge_base: value.card_index_knowledge_base.trim(), card_meta_knowledge_base: value.card_meta_knowledge_base.trim() },
    knowledge_base_meta: meta, enabled: value.enabled,
  }
}
async function save() {
  if (creating.value && form.value.id.trim() && !metricKnowledgeIdPattern.test(form.value.id.trim())) return validationError('知识库标识需以 metrics- 开头，只使用小写字母、数字和连字符；留空由服务端生成。')
  if (indicators().length > maxTypicalIndicators) return validationError(`典型指标最多 ${maxTypicalIndicators} 行。`)
  if (form.value.workflows.length > maxKnowledgeWorkflows) return validationError(`工作流最多 ${maxKnowledgeWorkflows} 项。`)
  if (form.value.skill_name === undefined) return validationError('此知识库原先引用多个技能，请明确选择一个技能或不引用技能。')
  const names = new Set<string>()
  for (const row of form.value.workflows) {
    const name = row.name.trim(), value = row.value.trim()
    if (!name || !value) return validationError('每项工作流的名称和值都必须填写；不需要的工作流请移除。', row)
    if (name.length > maxWorkflowName || value.length > maxWorkflowValue) return validationError(`工作流名称最多 ${maxWorkflowName} 字，值最多 ${maxWorkflowValue} 字。`, row)
    if (!validWorkflowName(name) && !Object.hasOwn(current.value?.knowledge_retrieve_workflow_id ?? {}, name)) return validationError('新增或改名的工作流名称只允许 1–64 位字母、数字、下划线或连字符，且不能使用 run_code 等保留名称。', row)
    if (names.has(name)) return validationError(`工作流名称“${name}”重复，请修改名称或移除重复项。`, row)
    names.add(name)
  }
  await run(async () => {
    const id = current.value?.id
    const result = await call<{ revision: string; entry: MetricKnowledgeEntry }>(id ? `/api/admin/knowledge/${encodeURIComponent(id)}` : '/api/admin/knowledge',
      { method: id ? 'PUT' : 'POST', data: { entry: payload(), revision: revision.value } })
    revision.value = result.revision
    const index = items.value.findIndex(item => item.id === result.entry.id)
    if (index < 0) items.value.push(result.entry)
    else items.value[index] = result.entry
    adopt(result.entry)
    notice.value = id ? '知识库已保存，公开目录已更新。' : '知识库已创建，公开目录已更新。'
  })
}
function saveClick() {
  if (current.value?.enabled && !form.value.enabled) confirmation.value = { title: '下架这个知识库？', message: '公开目录将不再返回该条目，端侧已绑定的副本不受影响。', label: '保存并下架', action: () => void save() }
  else void save()
}
function remove() {
  const entry = current.value
  if (!entry) return
  confirmation.value = { title: '删除这个知识库条目？', message: `${entry.tenant_name} · ${entry.id}。公开目录立即不再返回该条目；技能库中的文件不受影响。`, label: '删除条目', action: () => void run(async () => {
    await call(`/api/admin/knowledge/${encodeURIComponent(entry.id)}`, { method: 'DELETE', data: { revision: revision.value } })
    current.value = undefined; creating.value = false; form.value = empty(); baseline.value = JSON.stringify(form.value)
    await list(); notice.value = '条目已删除。'
  }) }
}
async function send(event: Event) {
  const input = event.target as HTMLInputElement, files = Array.from(input.files ?? [])
  if (!files.length || busy.value) return
  await run(async () => {
    upload = new AbortController()
    uploadResults.value = []; uploadTotal.value = files.length
    try {
      for (const [index, file] of files.entries()) {
        uploadName.value = file.name; uploadIndex.value = index + 1; progress.value = 0
        try {
          if (file.size > maxSkillFileBytes) throw new ApiError('UPLOAD_TOO_LARGE')
          if (!/\.(zip|md)$/i.test(file.name)) throw new ApiError('INVALID_SKILL_FILE')
          const result = await uploadFile<{ revision: string; skill: MetricKnowledgeSkill; skills: MetricKnowledgeSkill[] }>(
            `/api/admin/knowledge/skills?name=${encodeURIComponent(file.name)}`, file,
            { csrf: props.csrf, revision: revision.value, signal: upload.signal, progress: v => progress.value = v })
          // Use this write's revision and collection without replacing the unsaved entry form.
          skills.value = result.skills; revision.value = result.revision
          uploadResults.value.push({ file: file.name, status: 'saved', message: `已保存 · ${result.skill.name}` })
        } catch (e) {
          const cancelled = upload.signal.aborted
          const rejected = e instanceof ApiError
          const message = cancelled ? '上传已取消，请刷新列表核对该文件是否已保存。' : requestMessage(e)
          uploadResults.value.push({ file: file.name, status: cancelled ? 'cancelled' : 'failed', message: !cancelled && !rejected ? `${message} 请刷新列表核对该文件是否已保存。` : message })
          // Validation rejections do not write. Other failures may invalidate the catalog revision.
          if (!cancelled && rejected && ['INVALID_SKILL_FILE', 'UPLOAD_TOO_LARGE', 'EMPTY_UPLOAD'].includes(e.code)) continue
          error.value = message
          if (rejected && ['AUTH_REQUIRED', 'CSRF_REJECTED'].includes(e.code)) emit('error', e)
          for (const remaining of files.slice(index + 1)) uploadResults.value.push({ file: remaining.name, status: 'skipped', message: '尚未上传' })
          break
        }
      }
      const saved = uploadResults.value.filter(result => result.status === 'saved').length
      notice.value = `本次选择 ${files.length} 个文件，已确认保存 ${saved} 个。${saved < files.length ? '其余文件的结果见下方。' : '可在各知识库中选择引用一个技能。'}`
      if (uploadResults.value.some(result => result.status === 'failed') && !error.value) error.value = '部分技能文件未通过校验，已保存的文件会保留。请检查下方结果。'
      if (error.value) { await nextTick(); errorElement.value?.focus() }
    } finally { uploadName.value = ''; input.value = ''; upload = undefined }
  })
}
function detach(value: MetricKnowledgeSkill) {
  if (busy.value || dirty.value || skillUsers(value.name).length || legacySkillName.value === value.name) return
  confirmation.value = { title: '移除这个技能？', message: `${value.name} · ${value.file_name}。移除后知识库将无法选择引用它；已上传的文件按内容哈希保留。`, label: '移除技能', action: () => void run(async () => {
    const result = await call<{ revision: string }>(`/api/admin/knowledge/skills/${encodeURIComponent(value.name)}`, { method: 'DELETE', data: { revision: revision.value } })
    revision.value = result.revision; skills.value = skills.value.filter(skill => skill.name !== value.name); notice.value = `技能“${value.name}”已移除。`
  }) }
}
function compatibility(entry: MetricKnowledgeEntry) {
  if (entry.pending_skill_names?.length) return '待选择单个技能'
  if (legacySkillName.value === undefined) return '待确认原公共技能'
  return legacyKnowledgeCompatible(entry, legacySkillName.value) ? '支持旧客户端' : '仅新版客户端'
}
const invalidHistoricalNames = computed(() => form.value.workflows.filter(row => !validWorkflowName(row.name.trim())).map(row => row.name))
const conflictingAlias = computed(() => {
  const values = Object.fromEntries(form.value.workflows.map(row => [row.name.trim(), row.value.trim()]))
  return Object.hasOwn(values, 'query_card_data') && Object.hasOwn(values, 'quer_card_data') && values.query_card_data !== values.quer_card_data
})
async function resolveLegacy() {
  if (legacyChoice.value === undefined) return
  await run(async () => {
    await call('/api/admin/knowledge/compatibility', { method: 'PUT', data: { legacy_skill_name: legacyChoice.value, revision: revision.value } })
    await list(); notice.value = '原公共技能已确认，旧客户端将继续获取它的当前版本。'
  })
}
function reload() {
  guard(() => void run(async () => {
    const id = current.value?.id
    await list()
    const entry = items.value.find(item => item.id === id)
    if (entry) adopt(entry)
    else { current.value = undefined; creating.value = false; form.value = empty(); baseline.value = JSON.stringify(form.value) }
  }))
}
function accept() { const action = confirmation.value?.action; confirmation.value = undefined; action?.() }
function size(bytes: number) { return bytes < 1024 ? `${bytes} B` : bytes < 1024 ** 2 ? `${(bytes / 1024).toFixed(1)} KiB` : `${(bytes / 1024 ** 2).toFixed(2)} MiB` }
onMounted(() => run(list))
onBeforeUnmount(() => { lifetime.abort(); upload?.abort(); emit('dirty', false); emit('busy', false) })
</script>

<template>
  <section :aria-busy="busy">
    <div class="editor-heading">
      <div><h2>知识库元数据</h2><p>维护指标知识库的租户、检索工作流与引用技能，保存后更新网站公开目录。</p></div>
      <div class="admin-actions"><button class="button secondary" :disabled="busy" @click="reload">刷新列表</button><button class="button primary" :disabled="busy" @click="create">新建知识库</button></div>
    </div>
    <p v-if="error" ref="errorElement" class="admin-error" role="alert" tabindex="-1">{{ error }}</p>
    <p v-if="notice" class="admin-success" role="status">{{ notice }}</p>
    <section class="package-upload shared-skill" aria-labelledby="knowledge-skill-heading">
      <div class="editor-heading">
        <div><h3 id="knowledge-skill-heading">技能库 <small>{{ skills.length }} / {{ maxKnowledgeSkills }}</small></h3><p>可一次选择多个 .zip 或 .md，每个最多 5 MiB。上传后，在下方每个知识库中选择引用一个技能。</p><p>同名技能会替换已有文件，并对所有引用它的知识库生效；名称取自 SKILL.md 中的 name。</p></div>
        <div class="admin-actions">
          <input ref="fileInput" class="file-input" type="file" accept=".zip,.md" multiple tabindex="-1" aria-label="选择多个技能文件" :disabled="busy" @change="send" />
          <button class="button secondary" :disabled="busy" @click="fileInput?.click()">上传技能文件</button>
          <button v-if="uploadName" class="button secondary" @click="upload?.abort()">取消上传</button>
        </div>
      </div>
      <p class="editor-help">ZIP 须恰好包含一个 SKILL.md，位于根目录或与技能同名的唯一一级目录内；文件须包含 name 和 description。被知识库引用的技能须先解除引用并保存，才可移除，下架的知识库也计入引用。</p>
      <p v-if="legacySkillName !== undefined" class="editor-help">旧客户端公共技能：{{ legacySkillName ?? '原来未配置技能' }}。此身份固定，同名上传会更新两端使用的文件。</p>
      <fieldset v-else class="legacy-choice"><legend>确认原公共技能</legend><p class="editor-help">旧数据未记录原公共技能，且备份中无法确认。请按原配置选择一次；确认前旧客户端下载暂不可用，新版不受影响。</p><label class="check-label"><input v-model="legacyChoice" type="radio" name="legacy-skill" :value="null" :disabled="busy" />原来未配置技能</label><label v-for="skill in skills" :key="skill.name" class="check-label"><input v-model="legacyChoice" type="radio" name="legacy-skill" :value="skill.name" :disabled="busy" />{{ skill.name }}</label><button class="button secondary" :disabled="busy || legacyChoice === undefined" @click="resolveLegacy">保存原公共技能</button></fieldset>
      <p v-if="dirty" class="editor-help">上传技能会保留当前表单修改；移除技能前请先保存表单。</p>
      <div v-if="uploadName" class="upload-progress" role="status"><span>{{ uploadIndex }} / {{ uploadTotal }} · {{ uploadName }}</span><progress :value="progress" max="100" :aria-label="`${uploadName} 上传进度`"></progress>{{ progress }}% · {{ progress === 100 ? '正在校验保存…' : '上传中' }}</div>
      <ul v-if="uploadResults.length" class="upload-results" aria-label="本次上传结果">
        <li v-for="(result, index) in uploadResults" :key="index" :class="{ 'upload-failed': result.status !== 'saved' }"><strong>{{ result.file }}</strong><span>{{ result.message }}</span></li>
      </ul>
      <article v-for="skill in skills" :key="skill.name" class="package-file knowledge-skill">
        <div><strong>{{ skill.name }}</strong><small>{{ skill.file_name }} · {{ skill.kind === 'zip' ? '压缩包' : 'Markdown' }} · {{ size(skill.size) }} · {{ new Date(skill.uploaded_at).toLocaleString('zh-CN') }}</small><p class="editor-help">{{ skillUsers(skill.name).length ? `被 ${skillUsers(skill.name).length} 个知识库引用：${skillUsers(skill.name).map(item => `${item.tenant_name}${item.enabled ? '' : '（已下架）'}`).join('、')}` : '尚未被知识库引用' }}</p><details><summary>内容哈希 SHA-256</summary><code>{{ skill.sha256 }}</code></details></div>
        <div class="admin-actions skill-actions">
          <a :href="`/api/knowledge/metrics/v2/skills/${encodeURIComponent(skill.name)}/${skill.sha256}`" :download="skill.file_name" :aria-label="`下载技能 ${skill.name}`">下载</a>
          <button :disabled="busy || dirty || skillUsers(skill.name).length > 0 || legacySkillName === skill.name" :aria-label="`移除技能 ${skill.name}`" @click="detach(skill)">移除</button>
        </div>
      </article>
      <p v-if="!skills.length" class="editor-help">尚未上传技能。知识库可不引用技能，也可在上传后选择一个。</p>
    </section>
    <div class="admin-layout">
      <aside class="admin-sidebar release-sidebar">
        <h3>知识库条目</h3>
        <p v-if="loading" class="editor-help">正在加载…</p>
        <p v-else-if="!items.length" class="editor-help">尚无条目</p>
        <nav aria-label="知识库条目"><button v-for="item in items" :key="item.id" :disabled="busy" :aria-current="current?.id === item.id ? 'page' : undefined" @click="select(item)"><span>{{ item.tenant_name }}</span><small>{{ item.id }}<br />{{ item.enabled ? '已上架' : '已下架' }} · {{ item.skill_name ?? '未引用技能' }}<br />{{ compatibility(item) }}</small></button></nav>
      </aside>
      <section v-if="active" class="admin-workspace release-workspace">
        <div class="editor-heading"><h3>{{ creating ? '创建知识库条目' : '维护知识库条目' }}</h3><span class="editor-help">{{ dirty ? '有未保存的修改' : creating ? '尚未创建' : '已保存' }}</span></div>
        <div v-if="current" class="release-identity">
          <span><small>知识库标识</small><strong>{{ current.id }}</strong></span>
          <span><small>创建时间</small><strong>{{ new Date(current.created_at).toLocaleString('zh-CN') }}</strong></span>
          <span><small>最近更新</small><strong>{{ new Date(current.updated_at).toLocaleString('zh-CN') }}</strong></span>
        </div>
        <form @submit.prevent="saveClick">
          <fieldset :disabled="busy">
            <div class="chapter-fields">
              <label v-if="creating">知识库标识<input v-model="form.id" maxlength="64" placeholder="留空自动生成，例如 metrics-retail" /><small>以 metrics- 开头，只用小写字母、数字和连字符；创建后不可修改。</small></label>
              <label>租户名称<input ref="tenantInput" v-model="form.tenant_name" required maxlength="80" placeholder="例如：示例零售" /></label>
              <label>租户 ID<input v-model="form.tenant_id" required maxlength="128" placeholder="DataAgent 中的租户标识" /><small>同一目录内唯一。</small></label>
              <label>知识库 card_index_knowledge_base<input v-model="form.card_index_knowledge_base" required maxlength="256" /></label>
              <label>知识库 card_meta_knowledge_base<input v-model="form.card_meta_knowledge_base" required maxlength="256" /></label>
              <label>指标覆盖<input v-model="form.indicators_cover" maxlength="80" placeholder="例如：1,200 项，可留空" /></label>
              <label>报表覆盖<input v-model="form.reports_cover" maxlength="80" placeholder="例如：32 张，可留空" /></label>
              <label>更新频率<input v-model="form.update_frequency" maxlength="80" placeholder="例如：每日 07:00，可留空" /></label>
            </div>
            <section class="knowledge-field-section" aria-labelledby="knowledge-workflows-heading">
              <div class="knowledge-field-heading"><h4 id="knowledge-workflows-heading">检索工作流</h4><span>{{ form.workflows.length }} / {{ maxKnowledgeWorkflows }}</span></div>
              <p id="knowledge-workflows-help" class="editor-help">按名称和值成对填写。名称对应客户端方法，使用 1–64 位字母、数字、下划线或连字符且不能重复，值填写对应的工作流 ID；不需要的项目可移除，也可不配置工作流。</p>
              <p v-if="invalidHistoricalNames.length" class="admin-error">历史工作流名称需要调整后才能作为新版客户端方法使用：{{ invalidHistoricalNames.join('、') }}。未修改的历史名称会保留。</p>
              <p v-if="conflictingAlias" class="admin-error">query_card_data 与 quer_card_data 的值不同，请核对；当前配置仅提供给新版客户端。</p>
              <div v-for="(row, index) in form.workflows" :key="row.id" class="workflow-row">
                <label>名称（key）<input :ref="element => setWorkflowInput(row.id, element)" v-model="row.name" required :maxlength="maxWorkflowName" :aria-label="`工作流 ${index + 1} 名称（key）`" aria-describedby="knowledge-workflows-help" placeholder="例如：get_card_index" /></label>
                <label>值（value）<input v-model="row.value" required :maxlength="maxWorkflowValue" :aria-label="`工作流 ${index + 1} 值（value）`" placeholder="填写工作流 ID" /></label>
                <button type="button" class="button secondary" :aria-label="`移除工作流 ${index + 1}${row.name ? `：${row.name}` : ''}`" @click="removeWorkflow(row.id)">移除</button>
              </div>
              <p v-if="!form.workflows.length" class="editor-help">尚未配置检索工作流。</p>
              <button ref="addWorkflowButton" type="button" class="button secondary add-workflow" :disabled="form.workflows.length >= maxKnowledgeWorkflows" @click="addWorkflow">添加工作流</button>
            </section>
            <fieldset class="knowledge-field-section skill-choices" aria-describedby="knowledge-skill-help">
              <legend>引用技能</legend>
              <p id="knowledge-skill-help" class="editor-help">每个知识库只引用一个技能，也可不引用。选择后保存条目生效。</p>
              <p v-if="current?.pending_skill_names?.length" class="admin-error">此知识库原先引用了 {{ current.pending_skill_names.join('、') }}，请明确选择一个；选择并保存前不会发布此条目，原配置保留。</p>
              <div class="skill-choice-list">
                <label class="check-label"><input v-model="form.skill_name" type="radio" name="knowledge-skill" :value="null" />不引用技能</label>
                <label v-for="skill in skills" :key="skill.name" class="check-label"><input v-model="form.skill_name" type="radio" name="knowledge-skill" :value="skill.name" :aria-label="`引用技能 ${skill.name}`" /><span><strong>{{ skill.name }}</strong><small>{{ skill.file_name }}</small></span></label>
              </div>
              <p v-if="!skills.length" class="editor-help">请先在上方技能库上传文件，即可在这里选择。</p>
            </fieldset>
            <label class="release-notes">知识库描述<textarea v-model="form.knowledge_description" required rows="4" maxlength="2000" placeholder="说明该知识库覆盖的业务范围与口径来源。"></textarea><small>展示在知识中心卡片上，最多 2000 字。</small></label>
            <label class="release-notes">典型指标<textarea v-model="form.typical_indicators" rows="4" :maxlength="maxTypicalIndicators * 81" placeholder="每行一个，例如：&#10;GMV&#10;动销率"></textarea><small>每行一个，最多 {{ maxTypicalIndicators }} 个，每个 80 字以内；留空则卡片不显示标签。</small></label>
            <label class="check-label knowledge-enabled"><input v-model="form.enabled" type="checkbox" />上架：在公开目录中提供此知识库</label>
            <button class="button primary" :disabled="busy || !dirty">{{ busy ? '处理中…' : creating ? '创建条目' : '保存条目' }}</button>
          </fieldset>
        </form>
        <div v-if="current" class="editor-bottom"><button :disabled="busy" @click="remove">删除条目</button></div>
      </section>
      <div v-else class="admin-empty">新建知识库条目，或选择左侧已有条目进行维护。</div>
    </div>
    <WebsiteDialog v-if="confirmation" :title="confirmation.title" :message="confirmation.message" :confirm-label="confirmation.label" @cancel="confirmation = undefined" @confirm="accept" />
  </section>
</template>

<style scoped>
.legacy-choice{margin:16px 24px;padding:16px;border:1px solid var(--border-default);border-radius:8px}.shared-skill{border-top:0;padding-top:0;margin-top:0;margin-bottom:24px}.shared-skill h3 small{font-size:12px;font-weight:400;color:var(--text-tertiary);margin-left:8px}.shared-skill>.editor-help{margin-left:24px;margin-right:24px}.knowledge-skill{margin:0 24px;align-items:flex-start}.knowledge-skill small,.knowledge-skill .editor-help{overflow-wrap:anywhere}.knowledge-skill>.skill-actions{flex:0 0 auto;padding-top:2px}.skill-actions a{color:var(--accent-primary)}.skill-actions button{font:inherit}.upload-results{list-style:none;margin:16px 24px;padding:12px 16px;border:1px solid var(--border-default);border-radius:8px;max-height:260px;overflow:auto;font-size:12px}.upload-results li{display:grid;gap:4px;padding:6px 0;overflow-wrap:anywhere}.upload-results span{color:#34705c;font-size:11px;line-height:1.7}.upload-results .upload-failed span{color:#973d3d}.knowledge-field-section{margin-top:24px;padding-top:20px;border-top:1px solid var(--border-default)}.knowledge-field-heading{display:flex;align-items:center;justify-content:space-between;gap:12px}.knowledge-field-heading h4{margin:0;font-size:14px}.knowledge-field-heading>span{font-size:11px;color:var(--text-tertiary)}.workflow-row{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr) auto;align-items:end;gap:12px;margin-top:16px}.workflow-row label{display:grid;gap:8px;min-width:0;font-size:12px}.workflow-row input{min-width:0}.add-workflow{margin-top:16px}.guide-admin .skill-choices{margin-top:24px;padding-top:12px}.skill-choices legend{font-size:14px;font-weight:650;padding:0}.skill-choices>.editor-help{margin-top:0}.skill-choice-list{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;margin-top:12px}.guide-admin .skill-choice-list .check-label{align-items:flex-start;white-space:normal;border:1px solid var(--border-default);padding:12px;border-radius:6px}.skill-choice-list input{margin-top:2px}.skill-choice-list span{min-width:0;overflow-wrap:anywhere}.skill-choice-list strong{font-weight:500}.skill-choice-list small{display:block;font-size:11px;color:var(--text-tertiary);margin-top:4px}.guide-admin .knowledge-enabled{white-space:normal;align-items:flex-start}.knowledge-enabled input{flex-shrink:0}
@media(max-width:760px){.shared-skill>.editor-help{margin-left:18px;margin-right:18px}.knowledge-skill{margin-left:18px;margin-right:18px;flex-wrap:wrap}.knowledge-skill>div:first-child{flex-basis:100%}.upload-results{margin-left:18px;margin-right:18px}.workflow-row{grid-template-columns:minmax(0,1fr);padding-bottom:16px;border-bottom:1px solid var(--border-subtle)}.workflow-row button{justify-self:start}.skill-choice-list{grid-template-columns:1fr}}
</style>
