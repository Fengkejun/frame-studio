import { invoke } from '@tauri-apps/api/core'
import { isDesktop } from '@/shared/lib/desktop'
import type { Provider, Workflow } from '../workflow/model'
import type { VideoRequest, WulusaiVideoSettings } from '../workflow/mediaApi'
export interface Config {
  providerId: string
  video: {
    region: VideoRequest['region']
    resolution: VideoRequest['resolution']
    wulusai?: WulusaiVideoSettings | null
  } | null
  image: {
    baseUrl: string
    model: string
    size: string
    quality: string
    budgetReservationMicroUsd: number
  } | null
  budgetMicroUsd: number
  autoSearchSkills: boolean
}
export interface Plan {
  title: string
  summary: string
  storyDuration: number
  duration: number
  shotCount: number
  production: Workflow['production']
  steps: string[]
  skillIds: string[]
  skillSearchQuery: string
  generationMode: 'text' | 'frame'
}
export interface Session {
  id: string
  workflowId: string
  request: {
    goal: string
    config: Config
    referenceVersionId: string | null
    parentId: string | null
    scriptOnly: boolean
  }
  provider: Provider
  status: string
  message: string
  plan: Plan | null
  events: { tool: string; status: string; message: string; createdAt: number }[]
  cursor: number
  imageJobId: string | null
  videoJobId: string | null
  videoVersionId: string | null
  referenceVersionId: string | null
  outputPath: string | null
  createdAt: number
  updatedAt: number
}
export interface Skill {
  id: string
  name: string
  description: string
  source: string
  sha256: string
  enabled: boolean
}
export interface RemoteSkill {
  repository: string
  path: string
  sha: string
  name: string
}
export const getConfig = (): Promise<Config | null> =>
  isDesktop ? invoke('get_agent_config') : Promise.resolve(null)
export const saveConfig = (config: Config): Promise<void> =>
  invoke('save_agent_config', { config })
export const listSessions = (): Promise<Session[]> =>
  isDesktop ? invoke('list_agent_sessions') : Promise.resolve([])
export const getSession = (id: string): Promise<Session> =>
  invoke('get_agent_session', { id })
export const start = (request: Session['request']): Promise<Session> =>
  invoke('start_agent', { request })
export const stop = (id: string): Promise<void> => invoke('stop_agent', { id })
export const resume = (id: string): Promise<Session> =>
  invoke('resume_agent', { id })
export const listSkills = (): Promise<Skill[]> =>
  isDesktop ? invoke('list_agent_skills') : Promise.resolve([])
export const toggleSkill = (id: string, enabled: boolean): Promise<void> =>
  invoke('set_agent_skill_enabled', { id, enabled })
export const searchSkills = (
  repository: string,
  query: string,
): Promise<RemoteSkill[]> =>
  invoke('search_agent_skills', { repository, query })
export const installSkill = (remote: RemoteSkill): Promise<Skill> =>
  invoke('install_agent_skill', { remote })
export const running = (s?: Session | null) =>
  !!s && ['running', 'stopping'].includes(s.status)
export const toolNames: Record<string, string> = {
  plan: '制作计划',
  write_story: '创作剧本',
  write_storyboard: '编排分镜',
  generate_image: '生成首帧',
  generate_video: '生成视频',
  load_skills: '调用技能',
  search_skills: '搜索技能',
  install_skill: '安装技能',
  deliver: '交付结果',
  review: '检查视频文件',
  attention: '需要处理',
  recovery: '任务恢复',
}
