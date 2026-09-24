import { Icon, type IconName } from '@/shared/ui/Icon'
import type { Theme } from './useTheme'
import packageInfo from '../../../package.json'

const themes: {
  value: Theme
  label: string
  description: string
  icon: IconName
}[] = [
  { value: 'dark', label: '深色', description: '专注影像与创作', icon: 'moon' },
  {
    value: 'light',
    label: '浅色',
    description: '明亮清晰的工作空间',
    icon: 'sun',
  },
  {
    value: 'system',
    label: '跟随系统',
    description: '随系统外观自动切换',
    icon: 'monitor',
  },
]

export function SettingsPage({
  theme,
  onThemeChange,
  storageError,
}: {
  theme: Theme
  onThemeChange: (theme: Theme) => void
  storageError: boolean
}) {
  return (
    <div className="settings-page">
      <p className="eyebrow">PREFERENCES</p>
      <h1>让工作台更适合你。</h1>
      <p className="section-description">调整外观，建立舒适的创作环境。</p>
      <section className="settings-section">
        <h2>界面外观</h2>
        <p>选择你喜欢的主题，偏好会保存在当前设备。</p>
        <fieldset className="theme-options">
          <legend className="sr-only">界面主题</legend>
          {themes.map((option) => (
            <label
              className={`theme-option ${theme === option.value ? 'selected' : ''}`}
              key={option.value}
            >
              <input
                type="radio"
                name="theme"
                value={option.value}
                checked={theme === option.value}
                onChange={() => onThemeChange(option.value)}
              />
              <div
                className={`theme-swatch ${option.value}`}
                aria-hidden="true"
              >
                <i />
                <div>
                  <i />
                  <i />
                  <i />
                </div>
              </div>
              <span className="theme-name">
                <Icon name={option.icon} />
                {option.label}
                {theme === option.value && <Icon name="check" />}
              </span>
              <small>{option.description}</small>
            </label>
          ))}
        </fieldset>
        {storageError && (
          <p role="alert" className="error-text">
            主题已切换，但当前环境无法保存偏好，重启后可能恢复默认。
          </p>
        )}
      </section>
      <section className="settings-section about-section">
        <div>
          <p className="eyebrow">ABOUT FRAME</p>
          <h2>帧序 · Frame Studio</h2>
          <p>一个围绕 AI 短视频创作的桌面工作空间。</p>
        </div>
        <span className="version-badge">v{packageInfo.version}</span>
      </section>
      <p className="footnote">
        当前版本支持工作流画布、文本模型连接和分镜首帧制作。视频生成与成片合成将在后续接入。
      </p>
    </div>
  )
}
