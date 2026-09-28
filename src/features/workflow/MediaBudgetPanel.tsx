import { useEffect, useState } from 'react'
import { errorMessage } from './api'
import * as api from './mediaApi'

export function MediaBudgetPanel({
  workflowId,
  refreshSignal,
}: {
  workflowId: string
  refreshSignal: number
}) {
  const [budget, setBudget] = useState<api.MediaBudget | null>(null)
  const [limitText, setLimitText] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let alive = true
    void api
      .getMediaBudget(workflowId)
      .then((value) => {
        if (!alive) return
        setBudget(value)
        setLimitText(
          value.limitMicroUsd === null
            ? ''
            : (value.limitMicroUsd / 1_000_000).toFixed(2),
        )
      })
      .catch((reason: unknown) => {
        if (alive) setError(errorMessage(reason))
      })
    return () => {
      alive = false
    }
  }, [workflowId, refreshSignal])

  async function save() {
    const value = limitText.trim()
    if (
      value &&
      (!/^(?:0|[1-9]\d{0,6})(?:\.\d{1,2})?$/.test(value) ||
        Number(value) > 1_000_000)
    ) {
      setError('预算上限请填写 0–1000000 美元，最多两位小数。')
      return
    }
    setSaving(true)
    setError('')
    try {
      setBudget(
        await api.setMediaBudget(
          workflowId,
          value ? Math.round(Number(value) * 1_000_000) : null,
        ),
      )
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="media-budget-panel">
      <strong>项目云端媒体预算</strong>
      <p className="field-hint" role="status">
        已预留 {budget ? api.formatUsd(budget.reservedMicroUsd) : '读取中…'} /{' '}
        {budget?.limitMicroUsd === null || !budget
          ? '未设置上限'
          : api.formatUsd(budget.limitMicroUsd)}
      </p>
      <div className="form-actions">
        <label className="field-label">
          本地预算上限 / USD
          <input
            aria-label="项目云端媒体预算上限"
            type="number"
            min="0"
            max="1000000"
            step="0.01"
            value={limitText}
            placeholder="留空表示不限制"
            onChange={(event) => setLimitText(event.target.value)}
          />
        </label>
        <button
          className="small-button"
          type="button"
          disabled={saving || !budget}
          onClick={() => void save()}
        >
          {saving ? '保存中…' : '保存预算'}
        </button>
      </div>
      <p className="field-hint">
        预算按本项目已提交任务的预估或手动预留金额累计；失败和结果未知的任务也保留记录。它不是服务商账单或硬性扣费上限，旧任务未计入。
      </p>
      {error && (
        <p className="workflow-error" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}
