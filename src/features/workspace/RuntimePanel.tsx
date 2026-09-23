import { Icon } from '@/shared/ui/Icon'
import type { RuntimeStatus } from '@/shared/types/desktop'

export function RuntimePanel({
  status,
  onRetry,
}: {
  status: RuntimeStatus
  onRetry: () => void
}) {
  const labels = {
    browser: '浏览器预览',
    loading: '正在连接桌面',
    ready: '桌面连接正常',
    error: '桌面连接失败',
  }
  return (
    <section className="runtime-panel" aria-labelledby="runtime-title">
      <div className="section-heading">
        <div>
          <p className="eyebrow">RUNTIME</p>
          <h2 id="runtime-title">运行环境</h2>
        </div>
        <Icon name="monitor" />
      </div>
      <div className={`runtime-status ${status.state}`} role="status">
        <span className="status-dot" />
        {labels[status.state]}
      </div>
      {status.state === 'ready' ? (
        <dl className="details-list">
          <div>
            <dt>应用</dt>
            <dd>{status.info.name}</dd>
          </div>
          <div>
            <dt>版本</dt>
            <dd>{status.info.version}</dd>
          </div>
          <div>
            <dt>系统</dt>
            <dd>
              {status.info.platform} / {status.info.architecture}
            </dd>
          </div>
        </dl>
      ) : (
        <p className="runtime-description">
          {status.state === 'browser'
            ? '当前为前端预览。使用桌面模式启动后，可以检查 React 与 Rust 的实际连接。'
            : status.state === 'loading'
              ? '正在从本机读取应用版本与系统信息。'
              : status.message}
        </p>
      )}
      <button
        className="button subtle"
        disabled={status.state === 'browser' || status.state === 'loading'}
        onClick={onRetry}
      >
        <Icon name="refresh" />
        重新检查连接
      </button>
      <p className="footnote">仅检查本机环境，不发送网络请求。</p>
    </section>
  )
}
