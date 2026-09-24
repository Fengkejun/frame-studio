import { invoke } from '@tauri-apps/api/core'
import { isDesktop } from '@/shared/lib/desktop'
import {
  parseWorkflow,
  outputSchemas,
  type Artifact,
  type NodeKind,
  type Provider,
  type RunRecord,
  type Workflow,
} from './model'

const previewKey = 'frame-studio.preview.workflows.v1'
export function errorMessage(error: unknown): string {
  if (error instanceof Error)
    return error.name === 'ZodError'
      ? '数据格式无效，请检查必填字段、镜头 ID、时长和工作流版本。'
      : error.message
  return typeof error === 'string' ? error : '操作失败，请重试。'
}
export async function listWorkflows(): Promise<Workflow[]> {
  if (isDesktop)
    return (await invoke<Workflow[]>('list_workflows')).map((w) =>
      parseWorkflow(JSON.stringify(w)),
    )
  const data: unknown = JSON.parse(localStorage.getItem(previewKey) ?? '[]')
  if (!Array.isArray(data)) throw new Error('预览项目数据损坏，请导入备份')
  return data.map((w) => parseWorkflow(JSON.stringify(w)))
}
export async function saveWorkflow(workflow: Workflow): Promise<void> {
  const clean = parseWorkflow(JSON.stringify(workflow))
  if (isDesktop) return invoke('save_workflow', { workflow: clean })
  const previous = await listWorkflows()
  localStorage.setItem(
    previewKey,
    JSON.stringify([clean, ...previous.filter((w) => w.id !== clean.id)]),
  )
}
export const listProviders = (): Promise<Provider[]> =>
  isDesktop ? invoke('list_providers') : Promise.resolve([])
export const saveProvider = (
  provider: Provider,
  apiKey: string,
  clearKey: boolean,
): Promise<Provider> =>
  invoke('save_provider', { provider, apiKey: apiKey.trim() || null, clearKey })
export const removeProvider = (id: string): Promise<void> =>
  invoke('remove_provider', { id })
export const testProvider = (id: string): Promise<string> =>
  invoke('test_provider', { id })
export interface OllamaModel {
  name: string
  size: number
}
export const listOllamaModels = (baseUrl: string): Promise<OllamaModel[]> =>
  invoke('list_ollama_models', { baseUrl })
export const pullOllamaModel = (
  baseUrl: string,
  model: string,
): Promise<void> => invoke('pull_ollama_model', { baseUrl, model })
export const cancelOllamaPull = (): Promise<void> =>
  invoke('cancel_ollama_pull')
export const listRuns = (workflowId: string): Promise<RunRecord[]> =>
  isDesktop ? invoke('list_runs', { workflowId }) : Promise.resolve([])
export const getRun = (id: string): Promise<RunRecord> =>
  invoke('get_run', { id })
export const startRun = (
  workflow: Workflow,
  target?: string,
): Promise<RunRecord> =>
  invoke('start_run', { workflow, target: target ?? null })
export const cancelRun = (id: string): Promise<void> =>
  invoke('cancel_run', { id })
export async function manualArtifact(
  kind: NodeKind,
  value: unknown,
): Promise<Artifact> {
  const clean = outputSchemas[kind].parse(value)
  if (isDesktop) return invoke('validate_artifact', { kind, value: clean })
  return {
    id: crypto.randomUUID(),
    kind,
    value: clean,
    source: 'manual',
    createdAt: Date.now(),
  }
}
