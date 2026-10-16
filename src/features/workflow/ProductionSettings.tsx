import type { Workflow } from './model'
import { emptyProduction } from './production'
export function ProductionSettings({
  workflow,
  disabled,
  onChange,
}: {
  workflow: Workflow
  disabled: boolean
  onChange: (w: Workflow) => void
}) {
  return (
    <details className="production-settings">
      <summary>全片统一设定 · 角色、场景与画风</summary>
      <p className="field-hint">
        这些设定会进入后续剧本、分镜及图片/视频提示词。修改不会自动重做已有素材；文字约束能减少漂移，视觉一致性还需参考图和审片确认。
      </p>
      <div className="timeline-settings-grid">
        {(
          [
            ['style', '统一画风'],
            ['characters', '固定角色外观'],
            ['scene', '固定场景与天气'],
            ['rules', '连续性要求'],
          ] as const
        ).map(([key, label]) => (
          <label className="field-label" key={key}>
            {label}
            <textarea
              aria-label={label}
              rows={3}
              maxLength={1500}
              disabled={disabled}
              value={workflow.production?.[key] ?? ''}
              onChange={(e) =>
                onChange({
                  ...workflow,
                  production: {
                    ...emptyProduction,
                    ...workflow.production,
                    [key]: e.target.value,
                  },
                })
              }
            />
          </label>
        ))}
      </div>
    </details>
  )
}
