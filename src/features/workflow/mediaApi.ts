import { invoke } from '@tauri-apps/api/core'
import { isDesktop } from '@/shared/lib/desktop'

export interface ShotContext {
  workflowId: string
  nodeId: string
  artifactId: string
  shotId: string
}
export interface ImageAsset {
  assetId: string
  versionId: string
  name: string
  width: number
  height: number
  bytes: number
  createdAt: number
  source: 'import' | 'comfyui'
  context: ShotContext | null
  jobId: string | null
  fileName: string
}
export interface FirstFrame {
  context: ShotContext
  versionId: string
}
export interface ImageRequest {
  context: ShotContext
  baseUrl: string
  checkpoint: string
  positive: string
  negative: string
  width: number
  height: number
  steps: number
  seed: number
  count: number
}
export interface ImageJob {
  id: string
  request: ImageRequest
  promptId: string | null
  status: string
  message: string
  createdAt: number
  updatedAt: number
  assetIds: string[]
}
export const isImageRunning = (j: ImageJob) =>
  ['submitting', 'waiting', 'downloading'].includes(j.status)
export const sameShot = (a: ShotContext | null, b: ShotContext | null) =>
  !!a &&
  !!b &&
  a.workflowId === b.workflowId &&
  a.nodeId === b.nodeId &&
  a.artifactId === b.artifactId &&
  a.shotId === b.shotId
export const listImageAssets = (): Promise<ImageAsset[]> =>
  isDesktop ? invoke('list_image_assets') : Promise.resolve([])
export const listFirstFrames = (workflowId: string): Promise<FirstFrame[]> =>
  isDesktop ? invoke('list_first_frames', { workflowId }) : Promise.resolve([])
export const listImageJobs = (workflowId: string): Promise<ImageJob[]> =>
  isDesktop ? invoke('list_image_jobs', { workflowId }) : Promise.resolve([])
export const imageSettings = (): Promise<ImageRequest | null> =>
  isDesktop ? invoke('image_settings') : Promise.resolve(null)
export const imagePreview = (versionId: string): Promise<string> =>
  invoke('image_preview', { versionId })
export const testComfy = (baseUrl: string): Promise<string[]> =>
  invoke('test_comfy', { baseUrl })
export const startImageJob = (request: ImageRequest): Promise<ImageJob> =>
  invoke('start_image_job', { request })
export const resumeImageJob = (id: string): Promise<void> =>
  invoke('resume_image_job', { id })
export const pauseImageJob = (id: string): Promise<void> =>
  invoke('pause_image_job', { id })
export const selectFirstFrame = (
  context: ShotContext,
  versionId: string,
): Promise<void> => invoke('select_first_frame', { context, versionId })
export async function importImage(file: File): Promise<ImageAsset> {
  if (file.size > 20 * 1024 * 1024) throw new Error('图片不能超过 20 MB')
  return invoke('import_image', {
    name: file.name,
    bytes: Array.from(new Uint8Array(await file.arrayBuffer())),
  })
}
