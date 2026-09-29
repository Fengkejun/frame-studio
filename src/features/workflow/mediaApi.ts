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
  source: 'import' | 'comfyui' | 'openai'
  context: ShotContext | null
  jobId: string | null
  fileName: string
}
export interface FirstFrame {
  context: ShotContext
  versionId: string
}
export interface RoleReference {
  workflowId: string
  roleName: string
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
  workflowJson?: string
  outputNodeId?: string
  referenceVersionId?: string | null
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
export interface CloudImageRequest {
  context: ShotContext
  baseUrl: string
  model: 'gpt-image-2' | 'gpt-image-2.5-flare' | 'gpt-image-2.5-sunburst'
  positive: string
  negative: string
  size: '1024x1024' | '1024x1536' | '1536x1024'
  quality: 'low' | 'medium' | 'high'
  budgetReservationMicroUsd: number
  referenceVersionId?: string | null
}
export interface CloudImageJob {
  id: string
  request: CloudImageRequest
  status: string
  message: string
  createdAt: number
  updatedAt: number
  assetIds: string[]
  estimatedCostMicroUsd: number
}
export interface MediaBudget {
  limitMicroUsd: number | null
  reservedMicroUsd: number
}
export interface ConnectionCheck {
  status:
    | 'connected'
    | 'model_not_listed'
    | 'auth_failed'
    | 'rate_limited'
    | 'unavailable'
    | 'invalid_response'
  message: string
  modelListed: boolean | null
}
export interface VideoRequest {
  context: ShotContext
  firstFrameVersionId: string
  region: 'singapore' | 'beijing'
  prompt: string
  negativePrompt: string
  duration: number
  resolution: '720P' | '1080P'
}
export interface VideoJob {
  id: string
  request: VideoRequest
  taskId: string | null
  status: string
  message: string
  createdAt: number
  updatedAt: number
  assetId: string | null
  estimatedCostMicroUsd: number
}
export interface VideoAsset {
  assetId: string
  versionId: string
  context: ShotContext
  firstFrameVersionId: string
  jobId: string
  duration: number
  resolution: string
  bytes: number
  createdAt: number
  fileName: string
}
export interface SelectedVideo {
  context: ShotContext
  versionId: string
}
export interface TimelineClip {
  versionId: string
  trimStartMs: number
  trimEndMs: number
  caption: string
}
export interface Composition {
  workflowId: string
  clips: TimelineClip[]
  aspect: '9:16' | '16:9' | '1:1'
  resolution: 720 | 1080
  musicVersionId: string | null
  voiceVersionId: string | null
  musicVolume: number
  subtitleFormat: 'none' | 'srt' | 'vtt'
  subtitleText: string
}
export interface AudioAsset {
  versionId: string
  workflowId: string
  name: string
  fileName: string
  bytes: number
  durationMs: number
  createdAt: number
}
export interface ExportJob {
  id: string
  workflowId: string
  draft: Composition
  outputPath: string
  coverPath: string | null
  status: string
  progress: number
  message: string
  createdAt: number
  updatedAt: number
}
export interface ExportToolsStatus {
  ffmpeg: boolean
  ffprobe: boolean
  h264: boolean
  aac: boolean
  subtitles: boolean
  ready: boolean
  message: string
}
export const isVideoRunning = (j: VideoJob) =>
  ['submitting', 'queued', 'running', 'downloading'].includes(j.status)
export const isImageRunning = (j: ImageJob) =>
  ['submitting', 'waiting', 'downloading'].includes(j.status)
export const isCloudImageRunning = (j: CloudImageJob) =>
  ['submitting', 'saving'].includes(j.status)
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
export const listRoleReferences = (
  workflowId: string,
): Promise<RoleReference[]> =>
  isDesktop
    ? invoke('list_role_references', { workflowId })
    : Promise.resolve([])
export const setRoleReference = (
  workflowId: string,
  roleName: string,
  versionId: string,
): Promise<void> =>
  invoke('set_role_reference', { workflowId, roleName, versionId })
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
export const DEFAULT_CLOUD_IMAGE_BASE_URL = 'https://api.openai.com/v1'
export const cloudImageBaseUrlStorageKey = 'frame-studio.cloud-image-base-url'
export function savedCloudImageBaseUrl(): string {
  try {
    return (
      localStorage.getItem(cloudImageBaseUrlStorageKey) ||
      DEFAULT_CLOUD_IMAGE_BASE_URL
    )
  } catch {
    return DEFAULT_CLOUD_IMAGE_BASE_URL
  }
}
export const cloudImageKeyStatus = (baseUrl?: string): Promise<boolean> =>
  isDesktop
    ? invoke('cloud_image_key_status', { baseUrl })
    : Promise.resolve(false)
export const saveCloudImageKey = (
  apiKey: string,
  baseUrl: string,
): Promise<void> => invoke('save_cloud_image_key', { apiKey, baseUrl })
export const clearCloudImageKey = (baseUrl: string): Promise<void> =>
  invoke('clear_cloud_image_key', { baseUrl })
export const checkCloudImageConnection = (
  model: CloudImageRequest['model'],
  baseUrl: string,
): Promise<ConnectionCheck> =>
  invoke('check_cloud_image_connection', { model, baseUrl })
export const getMediaBudget = (workflowId: string): Promise<MediaBudget> =>
  isDesktop
    ? invoke('get_media_budget', { workflowId })
    : Promise.resolve({ limitMicroUsd: null, reservedMicroUsd: 0 })
export const setMediaBudget = (
  workflowId: string,
  limitMicroUsd: number | null,
): Promise<MediaBudget> =>
  invoke('set_media_budget', { workflowId, limitMicroUsd })
export function formatUsd(microUsd: number): string {
  return `$${(microUsd / 1_000_000).toFixed(6).replace(/(\.\d{2}\d*?)0+$/, '$1')}`
}
export function videoEstimateMicroUsd(
  region: VideoRequest['region'],
  resolution: VideoRequest['resolution'],
  duration: number,
): number {
  // Preview of the Rust budget tariff, checked against Model Studio on 2026-09-28.
  const rates = {
    beijing: { '720P': 86_012, '1080P': 143_353 },
    singapore: { '720P': 100_000, '1080P': 150_000 },
  }
  return rates[region][resolution] * duration
}
export const listCloudImageJobs = (
  workflowId: string,
): Promise<CloudImageJob[]> =>
  isDesktop
    ? invoke('list_cloud_image_jobs', { workflowId })
    : Promise.resolve([])
export const startCloudImageJob = (
  request: CloudImageRequest,
): Promise<CloudImageJob> => invoke('start_cloud_image_job', { request })
export const videoKeyStatus = (
  region: VideoRequest['region'],
): Promise<boolean> =>
  isDesktop ? invoke('video_key_status', { region }) : Promise.resolve(false)
export const saveVideoKey = (
  region: VideoRequest['region'],
  apiKey: string,
): Promise<void> => invoke('save_video_key', { region, apiKey })
export const clearVideoKey = (region: VideoRequest['region']): Promise<void> =>
  invoke('clear_video_key', { region })
export const checkVideoConnection = (
  region: VideoRequest['region'],
): Promise<ConnectionCheck> => invoke('check_video_connection', { region })
export const listVideoJobs = (workflowId: string): Promise<VideoJob[]> =>
  isDesktop ? invoke('list_video_jobs', { workflowId }) : Promise.resolve([])
export const startVideoJob = (request: VideoRequest): Promise<VideoJob> =>
  invoke('start_video_job', { request })
export const resumeVideoJob = (id: string): Promise<void> =>
  invoke('resume_video_job', { id })
export const pauseVideoJob = (id: string): Promise<void> =>
  invoke('pause_video_job', { id })
export const listVideoAssets = (workflowId: string): Promise<VideoAsset[]> =>
  isDesktop ? invoke('list_video_assets', { workflowId }) : Promise.resolve([])
export const videoPreview = (versionId: string): Promise<string> =>
  invoke('video_preview', { versionId })
export const listSelectedVideos = (
  workflowId: string,
): Promise<SelectedVideo[]> =>
  isDesktop
    ? invoke('list_selected_videos', { workflowId })
    : Promise.resolve([])
export const selectVideo = (
  context: ShotContext,
  versionId: string,
): Promise<void> => invoke('select_video', { context, versionId })
export const getComposition = (
  workflowId: string,
): Promise<Composition | null> =>
  isDesktop ? invoke('get_composition', { workflowId }) : Promise.resolve(null)
export const saveComposition = (draft: Composition): Promise<void> =>
  invoke('save_composition', { draft })
export const listAudioAssets = (workflowId: string): Promise<AudioAsset[]> =>
  isDesktop ? invoke('list_audio_assets', { workflowId }) : Promise.resolve([])
export const listExportJobs = (workflowId: string): Promise<ExportJob[]> =>
  isDesktop ? invoke('list_export_jobs', { workflowId }) : Promise.resolve([])
export const chooseExportPath = (): Promise<string | null> =>
  invoke('choose_export_path')
export const startExport = (
  draft: Composition,
  outputPath: string,
): Promise<ExportJob> => invoke('start_export', { draft, outputPath })
export const cancelExport = (id: string): Promise<void> =>
  invoke('cancel_export', { id })
export const checkExportTools = (): Promise<ExportToolsStatus> =>
  invoke('check_export_tools')
export async function importAudio(
  workflowId: string,
  file: File,
): Promise<AudioAsset> {
  if (file.size > 20 * 1024 * 1024) throw new Error('音频不能超过 20 MB')
  return invoke('import_audio', {
    workflowId,
    name: file.name,
    bytes: Array.from(new Uint8Array(await file.arrayBuffer())),
  })
}
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
