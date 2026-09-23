import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Connection,
  type Edge,
  type NodeChange,
  type EdgeChange,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { isDesktop } from '@/shared/lib/desktop'
import { FlowNode, type CanvasNode } from './FlowNode'
import { NodeInspector } from './NodeInspector'
import {
  applyRun,
  catalog,
  graphError,
  invalidate,
  kinds,
  makeNode,
  makeWorkflow,
  parseWorkflow,
  statusLabels,
  type NodeKind,
  type Provider,
} from './model'
import { errorMessage, listProviders } from './api'
import type { useWorkflow } from './useWorkflow'
import { useMedia } from './useMedia'
import { ImageStudio, type ShotTarget } from './ImageStudio'
import { AssetImage } from './AssetImage'
import './workflow.css'

const nodeTypes = { agent: FlowNode }
type Controller = ReturnType<typeof useWorkflow>
export function WorkflowPage(props: {
  controller: Controller
  onModels: () => void
  modelsRevision: number
}) {
  return (
    <ReactFlowProvider>
      <WorkflowEditor {...props} />
    </ReactFlowProvider>
  )
}
function WorkflowEditor({
  controller: c,
  onModels,
  modelsRevision,
}: {
  controller: Controller
  onModels: () => void
  modelsRevision: number
}) {
  const { workflow: w, busy } = c
  const [providers, setProviders] = useState<Provider[]>([])
  const [selected, setSelected] = useState<string[]>([])
  const [selectedEdges, setSelectedEdges] = useState<string[]>([])
  const [tab, setTab] = useState<'shots' | 'runs' | 'images'>('shots')
  const [mediaTarget, setMediaTarget] = useState<ShotTarget | null>(null)
  const media = useMedia(w?.id)
  const [confirmRun, setConfirmRun] = useState<{ target?: string } | null>(null)
  const importInput = useRef<HTMLInputElement>(null)
  const { screenToFlowPosition, fitView } = useReactFlow<CanvasNode>()
  const bottomPanel = useRef<HTMLElement>(null)
  useEffect(() => {
    if (tab === 'images')
      bottomPanel.current?.scrollIntoView({
        block: 'start',
        behavior: 'smooth',
      })
  }, [tab])
  useEffect(() => {
    let alive = true
    listProviders()
      .then((items) => {
        if (alive) setProviders(items)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [modelsRevision])
  const focused = w?.nodes.find((n) => n.id === selected[0]) ?? w?.nodes[0]
  const canvasNodes = useMemo<CanvasNode[]>(
    () =>
      (w?.nodes ?? []).map((n) => ({
        id: n.id,
        type: 'agent',
        position: n.position,
        selected: selected.includes(n.id),
        data: {
          node: n,
          providerName:
            providers.find((p) => p.id === n.config.providerId)?.name ?? '',
          status: c.activeRun?.nodes.find((r) => r.nodeId === n.id)?.status,
        },
      })),
    [w?.nodes, selected, providers, c.activeRun],
  )
  if (!w)
    return (
      <div className="workflow-loading">
        <h1>工作流画布</h1>
        <p>{c.saveState}</p>
        {c.error && <p role="alert">{c.error}</p>}
      </div>
    )

  function add(kind: NodeKind, position?: { x: number; y: number }) {
    if (!w || busy) return
    if (w.nodes.length >= 100) {
      c.setError('每个工作流最多 100 个节点')
      return
    }
    const pos = position ?? {
      x: 80 + (w.nodes.length % 4) * 280,
      y: 380 + Math.floor(w.nodes.length / 4) * 260,
    }
    const node = makeNode(kind, pos.x, pos.y)
    c.change({ ...w, nodes: [...w.nodes, node] })
    setSelected([node.id])
  }
  function validConnection(connection: Edge | Connection) {
    if (!w) return false
    return !graphError({
      ...w,
      edges: [
        ...w.edges,
        {
          id: 'candidate',
          source: connection.source,
          target: connection.target,
        },
      ],
    })
  }
  function nodesChange(changes: NodeChange<CanvasNode>[]) {
    if (!w || busy) return
    const removed = changes
      .filter((change) => change.type === 'remove')
      .map((change) => change.id)
    if (removed.length) {
      removeNodes(removed)
      return
    }
    const positions = changes.filter((change) => change.type === 'position')
    if (positions.length)
      c.change(
        {
          ...w,
          nodes: w.nodes.map((n) => {
            const change = positions.find((p) => p.id === n.id)
            return change?.position ? { ...n, position: change.position } : n
          }),
        },
        false,
      )
    const selections = changes.filter((change) => change.type === 'select')
    if (selections.length)
      setSelected((ids) => {
        const next = new Set(ids)
        for (const item of selections) {
          if (item.selected) next.add(item.id)
          else next.delete(item.id)
        }
        return [...next]
      })
  }
  function edgesChange(changes: EdgeChange[]) {
    if (!w || busy) return
    const removed = changes
      .filter((change) => change.type === 'remove')
      .map((change) => change.id)
    if (removed.length) {
      const targets = w.edges
        .filter((e) => removed.includes(e.id))
        .map((e) => e.target)
      c.change(
        invalidate(
          { ...w, edges: w.edges.filter((e) => !removed.includes(e.id)) },
          targets,
        ),
      )
    }
    const selections = changes.filter((change) => change.type === 'select')
    if (selections.length)
      setSelectedEdges((ids) => {
        const next = new Set(ids)
        for (const item of selections) {
          if (item.selected) next.add(item.id)
          else next.delete(item.id)
        }
        return [...next]
      })
  }
  function removeNodes(ids: string[]) {
    if (!w || busy) return
    if (w.nodes.length === ids.length) {
      c.setError('请至少保留一个节点')
      return
    }
    const invalid = invalidate(w, ids)
    c.change({
      ...invalid,
      nodes: invalid.nodes.filter((n) => !ids.includes(n.id)),
      edges: invalid.edges.filter(
        (e) => !ids.includes(e.source) && !ids.includes(e.target),
      ),
    })
    setSelected([])
  }
  function duplicate() {
    if (!w || !focused || busy) return
    if (w.nodes.length >= 100) {
      c.setError('每个工作流最多 100 个节点')
      return
    }
    const node = {
      ...focused,
      id: crypto.randomUUID(),
      label: `${focused.label} 副本`,
      position: { x: focused.position.x + 40, y: focused.position.y + 260 },
      output: null,
      stale: false,
    }
    c.change({ ...w, nodes: [...w.nodes, node] })
    setSelected([node.id])
  }
  async function importFile(file?: File) {
    if (!file || busy) return
    try {
      if (file.size > 4_000_000) throw new Error('工作流文件不能超过 4 MB')
      const imported = parseWorkflow(await file.text())
      await c.selectProject({
        ...imported,
        id: crypto.randomUUID(),
        name: `${imported.name}（导入）`,
        updatedAt: Date.now(),
        nodes: imported.nodes.map((n) => ({
          ...n,
          config: { ...n.config, providerId: '' },
          stale: !!n.output,
        })),
      })
      setSelected([])
    } catch (e) {
      c.setError(errorMessage(e))
    }
  }
  function exportFile() {
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(w, null, 2)], { type: 'application/json' }),
    )
    const a = document.createElement('a')
    a.href = url
    a.download = `${w!.name.replace(/[<>:"/\\|?*]/g, '-')}.frame.json`
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 2000)
  }
  const storyboards = w.nodes.filter(
    (n) => n.kind === 'storyboard' && n.output && 'shots' in n.output.value,
  )
  return (
    <div
      className="workflow-page"
      onKeyDown={(e) => {
        if (
          e.target instanceof HTMLElement &&
          (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName) ||
            e.target.isContentEditable)
        )
          return
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
          e.preventDefault()
          c.undo(e.shiftKey)
        }
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
          e.preventDefault()
          void c.save(w).catch(() => {})
        }
      }}
    >
      <div className="workflow-header">
        <div>
          <p className="eyebrow">STORY WORKSPACE</p>
          <h1>工作流画布</h1>
        </div>
        <div className="workflow-project">
          <label className="sr-only" htmlFor="project-select">
            切换工作流
          </label>
          <select
            id="project-select"
            value={w.id}
            disabled={busy}
            onChange={(e) => {
              const next = c.projects.find((p) => p.id === e.target.value)
              if (next) {
                void c.selectProject(next)
                setSelected([])
              }
            }}
          >
            {[w, ...c.projects.filter((p) => p.id !== w.id)].map((p) => (
              <option value={p.id} key={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <button
            className="small-button"
            disabled={busy}
            onClick={() => {
              void c.selectProject(makeWorkflow())
              setSelected([])
            }}
          >
            ＋ 新建工作流
          </button>
        </div>
      </div>
      <div className="workflow-toolbar">
        <input
          className="project-name"
          aria-label="工作流名称"
          value={w.name}
          maxLength={100}
          disabled={busy}
          onChange={(e) => c.change({ ...w, name: e.target.value })}
        />
        <span className="save-state">{c.saveState}</span>
        <div className="toolbar-spacer" />
        <button
          className="small-button"
          disabled={busy || !c.history.past.length}
          onClick={() => c.undo()}
        >
          撤销
        </button>
        <button
          className="small-button"
          disabled={busy || !c.history.future.length}
          onClick={() => c.undo(true)}
        >
          重做
        </button>
        <button
          className="small-button"
          disabled={busy}
          onClick={() => importInput.current?.click()}
        >
          导入
        </button>
        <button className="small-button" onClick={exportFile}>
          导出
        </button>
        <input
          ref={importInput}
          type="file"
          accept=".json"
          hidden
          onChange={(e) => {
            void importFile(e.target.files?.[0])
            e.target.value = ''
          }}
        />
        {busy ? (
          <button className="button secondary" onClick={() => void c.stop()}>
            停止执行
          </button>
        ) : (
          <button
            className="button primary"
            disabled={!isDesktop}
            onClick={() => setConfirmRun({})}
          >
            ▶ 运行工作流
          </button>
        )}
      </div>
      {!isDesktop && (
        <div className="preview-strip">
          浏览器画布预览 · 支持编辑和本机保存。真实模型调用请在桌面应用中运行。
        </div>
      )}
      {c.error && (
        <div role="alert" className="workflow-error dismissible">
          <span>{c.error}</span>
          <button className="text-button" onClick={() => c.setError('')}>
            关闭
          </button>
        </div>
      )}
      <div className="workflow-body">
        <aside className="node-library" aria-label="节点库">
          <div className="panel-heading">
            <h2>节点库</h2>
            <span className="muted">拖入画布</span>
          </div>
          {kinds.map((kind) => (
            <button
              className="library-node"
              key={kind}
              draggable={!busy}
              disabled={busy}
              onDragStart={(e) => {
                e.dataTransfer.setData('application/frame-node', kind)
                e.dataTransfer.effectAllowed = 'copy'
              }}
              onClick={() => add(kind)}
            >
              <span className="library-mark">{catalog[kind].mark}</span>
              <strong>{catalog[kind].title}</strong>
              <small>{catalog[kind].subtitle}</small>
            </button>
          ))}
          <div className="library-divider" />
          <button className="library-node" onClick={() => setTab('images')}>
            <span className="library-mark">▧</span>
            <strong>镜头首帧</strong>
            <small>ComfyUI 生图与本地素材</small>
          </button>
          <p className="eyebrow">即将接入</p>
          <div className="future-node">▷ 视频生成</div>
          <div className="future-node">▤ 剪辑与合成</div>
          <p className="field-hint">先打磨故事，再让每一帧发生。</p>
        </aside>
        <div
          className="canvas-area"
          onDragOver={(e) => {
            e.preventDefault()
            e.dataTransfer.dropEffect = 'copy'
          }}
          onDrop={(e) => {
            e.preventDefault()
            const kind = e.dataTransfer.getData('application/frame-node')
            if (kinds.includes(kind as NodeKind))
              add(
                kind as NodeKind,
                screenToFlowPosition({ x: e.clientX, y: e.clientY }),
              )
          }}
        >
          <div className="canvas-caption">
            <span className="status-dot" />
            {busy
              ? '执行中 · 画布暂时只读'
              : `${w.nodes.length} 个节点 · ${w.edges.length} 条连接`}
          </div>
          <ReactFlow<CanvasNode>
            key={w.id}
            nodes={canvasNodes}
            edges={w.edges.map((e) => ({
              ...e,
              sourceHandle: 'output',
              targetHandle: 'input',
              selected: selectedEdges.includes(e.id),
              animated:
                busy &&
                c.activeRun?.nodes.some(
                  (n) => n.nodeId === e.target && n.status === 'running',
                ),
            }))}
            nodeTypes={nodeTypes}
            onNodesChange={nodesChange}
            onEdgesChange={edgesChange}
            onNodeDragStart={c.checkpoint}
            onConnect={(connection) => {
              const next = {
                ...w,
                edges: [
                  ...w.edges,
                  {
                    id: crypto.randomUUID(),
                    source: connection.source,
                    target: connection.target,
                  },
                ],
              }
              const error = graphError(next)
              if (error) c.setError(error)
              else c.change(invalidate(next, [connection.target]))
            }}
            isValidConnection={(connection) => validConnection(connection)}
            nodesDraggable={!busy}
            nodesConnectable={!busy}
            elementsSelectable={!busy}
            deleteKeyCode={busy ? null : ['Backspace', 'Delete']}
            defaultViewport={w.viewport}
            onMoveEnd={(_, viewport) => {
              if (!busy) c.change({ ...w, viewport }, false)
            }}
            minZoom={0.2}
            maxZoom={1.5}
            fitView
            fitViewOptions={{ padding: 0.16 }}
          >
            <Background gap={22} size={1} color="var(--border)" />
            <Controls showInteractive={false} />
            <MiniMap
              nodeColor="var(--accent-soft)"
              maskColor="transparent"
              pannable
              zoomable
            />
          </ReactFlow>
          <div className="canvas-tools">
            <button
              className="small-button"
              onClick={() => void fitView({ padding: 0.2, duration: 250 })}
            >
              适应画布
            </button>
            <button
              className="small-button"
              disabled={busy || !focused}
              onClick={duplicate}
            >
              复制节点
            </button>
            <button
              className="small-button"
              disabled={busy || !selected.length}
              onClick={() => removeNodes(selected)}
            >
              删除选中
            </button>
          </div>
        </div>
        {focused && (
          <NodeInspector
            key={`${focused.id}-${focused.output?.id ?? ''}`}
            node={focused}
            providers={providers}
            busy={busy}
            onModels={onModels}
            onChange={(node) =>
              c.change(
                invalidate(
                  {
                    ...w,
                    nodes: w.nodes.map((n) => (n.id === node.id ? node : n)),
                  },
                  [node.id],
                ),
              )
            }
            onOutput={(output) => {
              const next = invalidate(w, [focused.id])
              c.change({
                ...next,
                nodes: next.nodes.map((n) =>
                  n.id === focused.id ? { ...n, output, stale: false } : n,
                ),
              })
            }}
            onRun={() => setConfirmRun({ target: focused.id })}
          />
        )}
      </div>
      <section className="workflow-bottom" ref={bottomPanel}>
        <div className="bottom-tabs">
          <button
            className={tab === 'shots' ? 'active' : ''}
            onClick={() => setTab('shots')}
          >
            分镜故事板
          </button>
          <button
            className={tab === 'runs' ? 'active' : ''}
            onClick={() => setTab('runs')}
          >
            运行记录 <span>{c.runs.length}</span>
          </button>
          <button
            className={tab === 'images' ? 'active' : ''}
            onClick={() => setTab('images')}
          >
            首帧与素材 {media.running && <span>生成中</span>}
          </button>
          <small>结果按版本保留在运行记录中</small>
        </div>
        {tab === 'shots' ? (
          <div className="storyboard-strip">
            {storyboards.length ? (
              storyboards.flatMap((node) =>
                node.output && 'shots' in node.output.value
                  ? node.output.value.shots.map((shot) => (
                      <article
                        key={`${node.id}-${shot.id}`}
                        className="storyboard-card"
                      >
                        <span>
                          {shot.id} <em>{shot.duration}s</em>
                        </span>
                        <strong>{shot.title}</strong>
                        <p>{shot.description}</p>
                        <small>
                          {node.stale ? '上游已修改 · 待更新' : shot.camera}
                        </small>
                        {media.frames
                          .filter(
                            (f) =>
                              f.context.nodeId === node.id &&
                              f.context.artifactId === node.output?.id &&
                              f.context.shotId === shot.id,
                          )
                          .map((f) => (
                            <div
                              className="shot-frame-preview"
                              key={f.versionId}
                            >
                              <AssetImage
                                versionId={f.versionId}
                                alt={`${shot.title} 首帧`}
                              />
                            </div>
                          ))}
                        <div className="shot-actions">
                          <button
                            className="text-button"
                            onClick={() => setSelected([node.id])}
                          >
                            查看分镜
                          </button>
                          <button
                            className="small-button"
                            disabled={busy || node.stale}
                            onClick={() => {
                              setMediaTarget({
                                nodeId: node.id,
                                shotId: shot.id,
                              })
                              setTab('images')
                            }}
                          >
                            制作首帧
                          </button>
                        </div>
                      </article>
                    ))
                  : [],
              )
            ) : (
              <div className="storyboard-empty">
                <span>▤</span>
                <div>
                  <strong>每个好故事，从一个镜头开始。</strong>
                  <p>运行分镜节点后，在这里预览镜头顺序、画面与时长。</p>
                </div>
              </div>
            )}
          </div>
        ) : tab === 'images' ? (
          <ImageStudio
            key={w.id}
            workflow={w}
            target={mediaTarget}
            onTarget={setMediaTarget}
            media={media}
            busy={busy}
            save={c.save}
          />
        ) : (
          <div className="run-history">
            {!c.runs.length && (
              <p className="empty-copy">
                还没有运行记录。每次执行都会保留当时的参数和输出。
              </p>
            )}
            {c.runs.map((r) => (
              <details key={r.id} open={r.id === c.activeRun?.id}>
                <summary>
                  <span
                    className={`badge ${r.status === 'failed' ? 'danger' : ''}`}
                  >
                    {statusLabels[r.status]}
                  </span>
                  <time>{new Date(r.startedAt).toLocaleString('zh-CN')}</time>
                  <span>{r.nodes.length} 个节点</span>
                </summary>
                {r.nodes.map((n) => (
                  <div className="run-node" key={n.nodeId}>
                    <strong>
                      {r.snapshot.nodes.find((s) => s.id === n.nodeId)?.label}
                    </strong>
                    <span>{statusLabels[n.status]}</span>
                    {n.message && <p>{n.message}</p>}
                    {n.output && (
                      <details>
                        <summary>查看结果</summary>
                        <pre>{JSON.stringify(n.output.value, null, 2)}</pre>
                      </details>
                    )}
                  </div>
                ))}
                {r.status !== 'running' && (
                  <button
                    className="small-button"
                    disabled={busy}
                    onClick={() => {
                      void c.selectProject({
                        ...applyRun(r.snapshot, r),
                        id: crypto.randomUUID(),
                        name: `${r.snapshot.name}（运行副本）`,
                        updatedAt: Date.now(),
                      })
                      setSelected([])
                    }}
                  >
                    从此记录创建副本
                  </button>
                )}
              </details>
            ))}
          </div>
        )}
      </section>
      {confirmRun && (
        <div className="run-confirm-backdrop">
          <div
            className="run-confirm"
            role="dialog"
            aria-modal="true"
            aria-labelledby="run-title"
          >
            <p className="eyebrow">READY TO CREATE</p>
            <h2 id="run-title">
              {confirmRun.target ? '运行选中节点' : '运行整个工作流'}
            </h2>
            <p>
              {confirmRun.target
                ? '将使用上游已确认的结果，执行这个节点。'
                : '按连接顺序重新执行全部节点。若要保留已编辑结果，请使用「运行当前节点」。'}
            </p>
            <p className="field-hint">
              云端请求可能产生费用。失败不会自动重试；本次结果会保存为独立运行记录。
            </p>
            <div className="form-actions">
              <button
                className="button secondary"
                autoFocus
                onClick={() => setConfirmRun(null)}
              >
                返回编辑
              </button>
              <button
                className="button primary"
                onClick={() => {
                  const target = confirmRun.target
                  setConfirmRun(null)
                  setTab('runs')
                  void c.run(target)
                }}
              >
                开始执行
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
