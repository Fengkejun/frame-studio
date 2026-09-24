import { z } from 'zod'

export const kinds = [
  'brief',
  'story',
  'storyboard',
  'prompt',
  'image',
  'video',
] as const
export type NodeKind = (typeof kinds)[number]
export const catalog: Record<
  NodeKind,
  { title: string; subtitle: string; mark: string }
> = {
  brief: { title: '创作需求', subtitle: '描述主题、人物与风格', mark: '01' },
  story: { title: '故事编剧', subtitle: '生成完整剧情与角色设定', mark: '02' },
  storyboard: {
    title: '分镜导演',
    subtitle: '拆解镜头、运镜与提示词',
    mark: '03',
  },
  prompt: { title: '提示词助手', subtitle: '优化正面与负面提示词', mark: '✦' },
  image: { title: '图片节点', subtitle: '汇集已确认的镜头首帧', mark: '▧' },
  video: { title: '视频节点', subtitle: '汇集已确认的镜头片段', mark: '▷' },
}
const text = z.string().max(250_000)
const required = text.min(1).refine((s) => s.trim().length > 0, '请填写内容')
export const storySchema = z.object({
  title: required,
  logline: required,
  content: required,
  characters: z.array(text),
})
export const shotSchema = z.object({
  id: required,
  title: required,
  description: required,
  duration: z.number().positive().max(600),
  characters: z.array(text),
  dialogue: text,
  camera: required,
  imagePrompt: required,
  videoPrompt: required,
})
export const storyboardSchema = z.object({
  shots: z
    .array(shotSchema)
    .min(1)
    .max(24)
    .refine(
      (shots) => new Set(shots.map((s) => s.id)).size === shots.length,
      '镜头 ID 不能重复',
    ),
})
export const outputSchemas = {
  brief: z.object({ text: required }),
  story: storySchema,
  storyboard: storyboardSchema,
  prompt: z.object({ text: required, negativePrompt: text }),
  image: z.object({
    storyboardArtifactId: required,
    frames: z
      .array(
        z.object({
          shotId: required,
          assetId: required,
          versionId: required,
          width: z.number().int().positive().max(8192),
          height: z.number().int().positive().max(8192),
        }),
      )
      .min(1)
      .max(24)
      .refine(
        (frames) => new Set(frames.map((f) => f.shotId)).size === frames.length,
        '镜头 ID 不能重复',
      ),
  }),
  video: z.object({
    storyboardArtifactId: required,
    clips: z
      .array(
        z.object({
          shotId: required,
          assetId: required,
          versionId: required,
          firstFrameVersionId: required,
          duration: z.number().int().min(2).max(15),
          resolution: z.enum(['720P', '1080P']),
        }),
      )
      .min(1)
      .max(24)
      .refine(
        (clips) =>
          new Set(clips.map((clip) => clip.shotId)).size === clips.length,
        '镜头 ID 不能重复',
      ),
  }),
}
export type Shot = z.infer<typeof shotSchema>
export const artifactSchema = z.object({
  id: z.string(),
  kind: z.enum(kinds),
  value: z.union([
    storySchema,
    storyboardSchema,
    outputSchemas.prompt,
    outputSchemas.brief,
    outputSchemas.image,
    outputSchemas.video,
  ]),
  createdAt: z.number(),
  source: z.enum(['model', 'manual', 'selection']),
})
export type Artifact = z.infer<typeof artifactSchema>
const nodeSchema = z
  .object({
    id: z.string().min(1).max(128),
    kind: z.enum(kinds),
    label: z.string().max(200),
    position: z.object({ x: z.number(), y: z.number() }),
    config: z.object({
      text: z.string().max(32_000),
      providerId: z.string().max(128),
      instructions: z.string().max(12_000),
      temperature: z.number().min(0).max(2),
      shotCount: z.number().int().min(1).max(24),
      duration: z.number().int().min(1).max(600),
    }),
    output: artifactSchema.nullable(),
    stale: z.boolean(),
  })
  .superRefine((node, ctx) => {
    if (
      node.output &&
      (node.output.kind !== node.kind ||
        !outputSchemas[node.kind].safeParse(node.output.value).success)
    )
      ctx.addIssue({ code: 'custom', message: '节点输出类型无效' })
  })
export const workflowSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().min(1).max(128),
  name: z.string().trim().min(1).max(300),
  nodes: z.array(nodeSchema).min(1).max(100),
  edges: z
    .array(z.object({ id: z.string(), source: z.string(), target: z.string() }))
    .max(200),
  viewport: z.object({
    x: z.number(),
    y: z.number(),
    zoom: z.number().min(0.1).max(4),
  }),
  updatedAt: z.number(),
})
export type Workflow = z.infer<typeof workflowSchema>
export type WorkflowNode = z.infer<typeof nodeSchema>
export interface Provider {
  id: string
  name: string
  kind: 'ollama' | 'openai'
  baseUrl: string
  model: string
  hasKey: boolean
}
export interface NodeRun {
  nodeId: string
  status: string
  message: string
  output: Artifact | null
}
export interface RunRecord {
  id: string
  workflowId: string
  startedAt: number
  finishedAt: number | null
  status: string
  snapshot: Workflow
  providers: Provider[]
  nodes: NodeRun[]
}
// Assets will be stored as files. Graphs bind an immutable asset version, never base64 media.
export interface AssetReference {
  assetId: string
  versionId: string
  kind: 'image' | 'video' | 'audio'
  role: 'reference' | 'firstFrame' | 'clip'
}

export const statusLabels: Record<string, string> = {
  pending: '等待中',
  running: '执行中',
  succeeded: '已完成',
  failed: '失败',
  cancelled: '已停止',
  interrupted: '执行中断',
  unknown: '结果待核实',
  skipped: '未执行',
  needs_input: '等待首帧',
  needs_video: '等待片段',
}
export function makeNode(kind: NodeKind, x = 80, y = 120): WorkflowNode {
  return {
    id: crypto.randomUUID(),
    kind,
    label: catalog[kind].title,
    position: { x, y },
    config: {
      text: '',
      providerId: '',
      instructions: '',
      temperature: 0.7,
      shotCount: 3,
      duration: 15,
    },
    output: null,
    stale: false,
  }
}
export function makeWorkflow(): Workflow {
  const nodes = [
    makeNode('brief', 40, 140),
    makeNode('story', 340, 140),
    makeNode('storyboard', 640, 140),
  ]
  return {
    schemaVersion: 1,
    id: crypto.randomUUID(),
    name: '未命名故事',
    nodes,
    edges: nodes.slice(1).map((n, i) => ({
      id: crypto.randomUUID(),
      source: nodes[i]!.id,
      target: n.id,
    })),
    viewport: { x: 0, y: 0, zoom: 0.8 },
    updatedAt: Date.now(),
  }
}
export function compatible(source: NodeKind, target: NodeKind) {
  return target === 'story'
    ? source === 'brief' || source === 'prompt'
    : target === 'storyboard'
      ? source === 'story'
      : target === 'prompt'
        ? source === 'brief' || source === 'story' || source === 'storyboard'
        : target === 'image'
          ? source === 'storyboard'
          : target === 'video'
            ? source === 'image'
            : false
}
export function graphError(w: Workflow): string | null {
  const ids = new Set(w.nodes.map((n) => n.id))
  if (ids.size !== w.nodes.length) return '节点 ID 重复'
  if (new Set(w.edges.map((e) => e.id)).size !== w.edges.length)
    return '连线 ID 重复'
  const degrees = new Map(w.nodes.map((n) => [n.id, 0]))
  for (const e of w.edges) {
    const source = w.nodes.find((n) => n.id === e.source),
      target = w.nodes.find((n) => n.id === e.target)
    if (
      !source ||
      !target ||
      e.source === e.target ||
      !compatible(source.kind, target.kind)
    )
      return '端口类型不兼容或节点不存在'
    const degree = (degrees.get(e.target) ?? 0) + 1
    if (degree > 1) return '一个输入端口只能连接一个上游'
    degrees.set(e.target, degree)
  }
  const queue = [...ids].filter((id) => degrees.get(id) === 0)
  let visited = 0
  while (queue.length) {
    const id = queue.shift()!
    visited++
    for (const edge of w.edges.filter((e) => e.source === id)) {
      degrees.set(edge.target, degrees.get(edge.target)! - 1)
      if (degrees.get(edge.target) === 0) queue.push(edge.target)
    }
  }
  return visited === ids.size ? null : '连接将产生循环'
}
export function invalidate(w: Workflow, changed: string[]): Workflow {
  const affected = new Set(changed)
  let size = 0
  while (size !== affected.size) {
    size = affected.size
    w.edges.forEach((e) => {
      if (affected.has(e.source)) affected.add(e.target)
    })
  }
  return {
    ...w,
    nodes: w.nodes.map((n) =>
      affected.has(n.id) && n.output ? { ...n, stale: true } : n,
    ),
  }
}
export function applyRun(w: Workflow, run: RunRecord): Workflow {
  const outputs = run.nodes.filter((n) => n.output)
  const changed = invalidate(
    w,
    outputs.map((n) => n.nodeId),
  )
  return {
    ...changed,
    nodes: changed.nodes.map((n) => {
      const result = outputs.find((r) => r.nodeId === n.id)
      return result?.output ? { ...n, output: result.output, stale: false } : n
    }),
  }
}
export function parseWorkflow(json: string): Workflow {
  if (new TextEncoder().encode(json).length > 4_000_000)
    throw new Error('工作流文件不能超过 4 MB')
  const w = workflowSchema.parse(JSON.parse(json))
  const error = graphError(w)
  if (error) throw new Error(error)
  return w
}
export function outputSummary(node: WorkflowNode): string {
  const v = node.output?.value
  if (!v)
    return node.kind === 'brief'
      ? node.config.text || '写下你想讲述的故事…'
      : node.kind === 'image'
        ? '连接分镜并确认每个镜头首帧'
        : node.kind === 'video'
          ? '连接图片节点并确认每个镜头片段'
          : '连接模型后，等待你的第一次创作'
  return 'shots' in v
    ? `${v.shots.length} 个镜头 · ${v.shots.reduce((a, s) => a + s.duration, 0)} 秒`
    : 'title' in v
      ? v.title
      : 'frames' in v
        ? `${v.frames.length} 个首帧版本已就绪`
        : 'clips' in v
          ? `${v.clips.length} 个视频片段已就绪`
          : v.text
}
