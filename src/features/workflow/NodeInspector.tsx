import { useState } from 'react'
import { isDesktop } from '@/shared/lib/desktop'
import {
  catalog,
  type Artifact,
  type Provider,
  type WorkflowNode,
} from './model'
import { errorMessage, manualArtifact } from './api'

export function NodeInspector({
  node,
  providers,
  busy,
  onChange,
  onOutput,
  onRun,
  onModels,
}: {
  node: WorkflowNode
  providers: Provider[]
  busy: boolean
  onChange: (n: WorkflowNode) => void
  onOutput: (output: Artifact) => void
  onRun: () => void
  onModels: () => void
}) {
  const [outputText, setOutputText] = useState(() =>
    node.output ? JSON.stringify(node.output.value, null, 2) : '',
  )
  const [error, setError] = useState('')
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)
  const value = node.output?.value
  const patch = (next: Partial<WorkflowNode['config']>) =>
    onChange({ ...node, config: { ...node.config, ...next } })
  async function applyOutput() {
    setSaving(true)
    setError('')
    try {
      onOutput(await manualArtifact(node.kind, JSON.parse(outputText)))
      setEditing(false)
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setSaving(false)
    }
  }
  return (
    <aside className="node-inspector" aria-label="节点设置">
      <div className="panel-heading">
        <span className="eyebrow">INSPECTOR</span>
        <span className="badge">{catalog[node.kind].title}</span>
      </div>
      <fieldset className="plain-fieldset" disabled={busy}>
        <label className="field">
          节点名称
          <input
            value={node.label}
            maxLength={100}
            onChange={(e) => onChange({ ...node, label: e.target.value })}
          />
        </label>
        {node.kind === 'brief' ? (
          <label className="field">
            创作需求
            <textarea
              rows={8}
              maxLength={32_000}
              value={node.config.text}
              placeholder="例如：一只猫在雨夜书店寻找失主，温暖治愈，电影感。"
              onChange={(e) => patch({ text: e.target.value })}
            />
          </label>
        ) : (
          <>
            <label className="field">
              模型连接
              <select
                value={node.config.providerId}
                onChange={(e) => patch({ providerId: e.target.value })}
              >
                <option value="">请选择模型</option>
                {providers.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} · {p.model}
                  </option>
                ))}
              </select>
            </label>
            <button className="text-button" onClick={onModels}>
              管理模型连接 ↗
            </button>
            <label className="field">
              Agent 任务要求
              <textarea
                rows={4}
                maxLength={12_000}
                value={node.config.instructions}
                placeholder={
                  node.kind === 'story'
                    ? '例如：三幕结构，结尾温暖，不超过三个角色。'
                    : node.kind === 'storyboard'
                      ? '例如：保持角色一致，每个镜头明确景别和运镜。'
                      : '例如：电影摄影风格，强调灯光与构图。'
                }
                onChange={(e) => patch({ instructions: e.target.value })}
              />
            </label>
            <div className="field-row">
              <label className="field">
                总时长 / 秒
                <input
                  type="number"
                  min={1}
                  max={600}
                  value={node.config.duration}
                  onChange={(e) =>
                    patch({
                      duration: Math.min(
                        600,
                        Math.max(1, Number(e.target.value) || 1),
                      ),
                    })
                  }
                />
              </label>
              {node.kind === 'storyboard' && (
                <label className="field">
                  镜头数量
                  <input
                    type="number"
                    min={1}
                    max={24}
                    value={node.config.shotCount}
                    onChange={(e) =>
                      patch({
                        shotCount: Math.min(
                          24,
                          Math.max(1, Number(e.target.value) || 1),
                        ),
                      })
                    }
                  />
                </label>
              )}
            </div>
            <label className="field">
              创造性 · {node.config.temperature.toFixed(1)}
              <input
                type="range"
                min={0}
                max={2}
                step={0.1}
                value={node.config.temperature}
                onChange={(e) => patch({ temperature: Number(e.target.value) })}
              />
              <small>发送 temperature 参数；具体范围由所选服务支持。</small>
            </label>
          </>
        )}
        <button
          className="button primary full-width"
          disabled={!isDesktop}
          onClick={onRun}
        >
          运行当前节点
        </button>
        <p className="field-hint">
          使用上游已确认结果。改动参数会将当前及下游结果标记为待更新。
        </p>
      </fieldset>
      <section className="inspector-output">
        <div className="panel-heading">
          <h3>节点结果</h3>
          {node.output && (
            <span className="badge">
              {node.stale
                ? '待更新'
                : node.output.source === 'manual'
                  ? '已编辑'
                  : '已生成'}
            </span>
          )}
        </div>
        {!value && !editing && (
          <p className="empty-copy">
            运行后，结果会出现在这里。你也可以录入已有内容，再继续后续节点。
          </p>
        )}
        {value && !editing && (
          <div className="output-preview">
            {'title' in value ? (
              <>
                <strong>{value.title}</strong>
                <p>{value.logline}</p>
                <p className="preserve-lines">{value.content}</p>
                <small>{value.characters.join(' / ')}</small>
              </>
            ) : 'shots' in value ? (
              <>
                <strong>{value.shots.length} 个镜头</strong>
                {value.shots.map((shot) => (
                  <div className="shot-preview" key={shot.id}>
                    <span>
                      {shot.id} · {shot.duration}s
                    </span>
                    <h3>{shot.title}</h3>
                    <p>{shot.description}</p>
                    <small>{shot.camera}</small>
                  </div>
                ))}
              </>
            ) : (
              <p className="preserve-lines">{value.text}</p>
            )}
          </div>
        )}
        {!editing ? (
          <button
            className="text-button"
            disabled={busy || node.kind === 'brief'}
            onClick={() => {
              setOutputText(
                node.output
                  ? JSON.stringify(node.output.value, null, 2)
                  : node.kind === 'story'
                    ? JSON.stringify(
                        { title: '', logline: '', content: '', characters: [] },
                        null,
                        2,
                      )
                    : node.kind === 'prompt'
                      ? JSON.stringify(
                          { text: '', negativePrompt: '' },
                          null,
                          2,
                        )
                      : JSON.stringify(
                          {
                            shots: [
                              {
                                id: 'shot-01',
                                title: '',
                                description: '',
                                duration: 5,
                                characters: [],
                                dialogue: '',
                                camera: '',
                                imagePrompt: '',
                                videoPrompt: '',
                              },
                            ],
                          },
                          null,
                          2,
                        ),
              )
              setEditing(true)
            }}
          >
            编辑结构化结果
          </button>
        ) : (
          <>
            <label className="field">
              结果 JSON
              <textarea
                className="code-input"
                rows={14}
                value={outputText}
                onChange={(e) => setOutputText(e.target.value)}
                disabled={busy || saving}
              />
            </label>
            <div className="form-actions">
              <button
                className="small-button"
                disabled={busy || saving}
                onClick={() => void applyOutput()}
              >
                校验并保存结果
              </button>
              <button
                className="text-button"
                onClick={() => {
                  setEditing(false)
                  setError('')
                }}
              >
                取消编辑
              </button>
            </div>
          </>
        )}
        {error && (
          <p className="workflow-error" role="alert">
            {error}
          </p>
        )}
      </section>
    </aside>
  )
}
