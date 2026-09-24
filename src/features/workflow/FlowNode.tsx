import { Handle, Position, type Node, type NodeProps } from '@xyflow/react'
import {
  catalog,
  outputSummary,
  statusLabels,
  type WorkflowNode,
} from './model'

export type CanvasNode = Node<
  { node: WorkflowNode; status?: string; providerName: string },
  'agent'
>
export function FlowNode({ data, selected }: NodeProps<CanvasNode>) {
  const { node, status, providerName } = data
  return (
    <div
      className={`agent-node ${selected ? 'is-selected' : ''} ${status === 'running' ? 'is-running' : ''}`}
    >
      {node.kind !== 'brief' && (
        <Handle
          type="target"
          position={Position.Left}
          id="input"
          aria-label={`${node.label}输入`}
        />
      )}
      <div className="agent-node-top">
        <span className="node-mark">{catalog[node.kind].mark}</span>
        <span className={`node-status ${status === 'failed' ? 'danger' : ''}`}>
          {status
            ? statusLabels[status]
            : node.stale
              ? '待更新'
              : node.output
                ? '已就绪'
                : '待配置'}
        </span>
      </div>
      <h3>{node.label || catalog[node.kind].title}</h3>
      <p className="node-subtitle">{catalog[node.kind].subtitle}</p>
      <div className="node-preview">{outputSummary(node)}</div>
      <div className="node-provider">
        <span className="status-dot" />
        {node.kind === 'brief'
          ? '手动输入 · 创作起点'
          : node.kind === 'image'
            ? '人工确认 · 首帧版本'
            : node.kind === 'video'
              ? '人工确认 · 视频版本'
              : node.kind === 'timeline'
                ? '本地合成 · MP4 文件'
                : providerName || '尚未选择模型'}
      </div>
      <Handle
        type="source"
        position={Position.Right}
        id="output"
        aria-label={`${node.label}输出`}
      />
    </div>
  )
}
