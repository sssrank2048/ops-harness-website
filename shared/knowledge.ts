// Shared JSON contract for the metric knowledge catalog. Field names use the snake_case spelling
// agreed with the product repository. Workflow names and values are administrator-defined.
export type MetricKnowledgeWorkflowIds = Record<string, string>
export type MetricKnowledgeIds = { card_index_knowledge_base: string; card_meta_knowledge_base: string }
export type MetricKnowledgeBaseMeta = {
  knowledge_description: string
  indicators_cover?: string | undefined
  reports_cover?: string | undefined
  update_frequency?: string | undefined
  typical_indicators?: string[] | undefined
}
export type MetricKnowledgeSkill = { name: string; file_name: string; sha256: string; size: number; kind: 'zip' | 'md'; uploaded_at: string }
export type MetricKnowledgeEntry = {
  id: string
  tenant_name: string
  tenant_id: string
  knowledge_retrieve_workflow_id: MetricKnowledgeWorkflowIds
  knowledge_id: MetricKnowledgeIds
  knowledge_base_meta: MetricKnowledgeBaseMeta
  enabled: boolean
  skill_names: string[]
  created_at: string
  updated_at: string
}
/** Skills are registered once and referenced by stable name from individual libraries. */
export type MetricKnowledgeCatalog = { schemaVersion: 2; revision: string; updatedAt: string; skills: MetricKnowledgeSkill[]; items: MetricKnowledgeEntry[] }
export type MetricKnowledgeInput = Omit<MetricKnowledgeEntry, 'id' | 'created_at' | 'updated_at' | 'skill_names'> & { id?: string | undefined; skill_names?: string[] | undefined }

export const metricKnowledgeIdPattern = /^metrics-[a-z0-9]+(?:-[a-z0-9]+)*$/
export const skillNamePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
export const maxKnowledgeId = 64
export const maxSkillName = 64
export const maxSkillDescription = 500
export const maxKnowledgeEntries = 500
export const maxKnowledgeSkills = 100
export const maxKnowledgeWorkflows = 50
export const maxWorkflowName = 80
export const maxWorkflowValue = 256
export const maxTypicalIndicators = 50
export const maxSkillFileBytes = 5 * 1024 ** 2
export const maxSkillArchiveEntries = 256
export const maxSkillArchiveBytes = 20 * 1024 ** 2
export const maxSkillFileName = 200

export function validMetricKnowledgeId(value: unknown): value is string {
  return typeof value === 'string' && value.length <= maxKnowledgeId && metricKnowledgeIdPattern.test(value)
}
