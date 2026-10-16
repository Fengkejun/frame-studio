import { z } from 'zod'
import * as api from './mediaApi'

export const videoSettingsKey = 'frame-studio.video-settings'
const videoSettingsSchema = z.object({
  region: z.enum(['singapore', 'beijing']),
  resolution: z.enum(['480P', '720P', '768P', '1080P', '2K', '4K']),
  wulusai: z
    .object({
      baseUrl: z.string().url(),
      model: z.string(),
      mode: z.enum(['text', 'frame']),
      ratio: z.string().nullable(),
      budgetReservationMicroUsd: z.number().int().nonnegative(),
    })
    .nullable(),
})
export function withSavedVideoSettings(
  request: api.VideoRequest,
): api.VideoRequest {
  try {
    const saved = videoSettingsSchema.parse(
      JSON.parse(localStorage.getItem(videoSettingsKey) ?? 'null'),
    )
    return api.normalizeVideoRequest({ ...request, ...saved })
  } catch {
    return api.normalizeVideoRequest(request)
  }
}
