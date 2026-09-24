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
  model: 'gpt-image-2' | 'gpt-image-2.5-flare' | 'gpt-image-2.5-sunburst'
  positive: string
  negative: string
  size: '1024x1024' | '1024x1536' | '1536x1024'
  quality: 'low' | 'medium' | 'high'
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
export const cloudImageKeyStatus = (): Promise<boolean> =>
  isDesktop ? invoke('cloud_image_key_status') : Promise.resolve(false)
export const saveCloudImageKey = (apiKey: string): Promise<void> =>
  invoke('save_cloud_image_key', { apiKey })
export const clearCloudImageKey = (): Promise<void> =>
  invoke('clear_cloud_image_key')
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
