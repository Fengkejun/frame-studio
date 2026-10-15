import { z } from 'zod'
import source from '@/shared/video-models.json'

const mode = z.enum(['text', 'frame'])
const resolution = z.enum(['480P', '720P', '768P', '1080P', '2K', '4K'])
const modelSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    aliases: z.array(z.string()),
    protocol: z.enum([
      'wan',
      'relay-content-v2',
      'relay-videos-v1',
      'relay-ark-v3',
    ]),
    modes: z.array(mode).min(1),
    defaultMode: mode,
    duration: z.object({
      min: z.number().int().positive(),
      max: z.number().int().positive(),
    }),
    resolutions: z.array(resolution).min(1),
    defaultResolution: resolution,
    ratios: z.array(z.string()),
    frameRatios: z.array(z.string()).optional(),
    framePromptOptional: z.boolean().default(false),
    frameSizes: z.record(
      z.string(),
      z.tuple([z.number().int().positive(), z.number().int().positive()]),
    ),
  })
  .strict()
export type VideoModel = z.infer<typeof modelSchema>
export type VideoMode = z.infer<typeof mode>
export type VideoResolution = z.infer<typeof resolution>
export const videoRatiosFor = (model: VideoModel, mode: VideoMode) =>
  mode === 'frame' ? (model.frameRatios ?? model.ratios) : model.ratios

const catalog = z
  .object({
    schemaVersion: z.literal(1),
    defaultWanModel: z.string(),
    defaultRelayModel: z.string(),
    models: z.array(modelSchema).min(1),
  })
  .strict()
  .parse(source)

export function getVideoModel(id: string): VideoModel {
  const model = catalog.models.find(
    (m) => m.id === id || m.aliases.includes(id),
  )
  if (!model) throw new Error('视频模型尚未适配，请选择已支持的模型')
  return model
}
export const wanVideoModel = getVideoModel(catalog.defaultWanModel)
export const defaultRelayModel = getVideoModel(catalog.defaultRelayModel)
export const relayVideoModels = catalog.models.filter(
  (m) => m.protocol !== 'wan',
)
export const videoModeLabels: Record<VideoMode, string> = {
  text: '文生视频',
  frame: '首帧图生视频',
}
