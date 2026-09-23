import { useState } from 'react'
import { WorkspacePage } from '@/features/workspace/WorkspacePage'
import { SettingsPage } from '@/features/settings/SettingsPage'
import { useTheme } from '@/features/settings/useTheme'
import { useRuntime } from '@/shared/hooks/useRuntime'
import { Icon } from '@/shared/ui/Icon'
import packageInfo from '../../package.json'
import './styles.css'

type Page = 'workspace' | 'settings'

export function App() {
  const [page, setPage] = useState<Page>('workspace')
  const { theme, changeTheme, storageError } = useTheme()
  const { status, retry } = useRuntime()

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        跳转到主要内容
      </a>
      <aside className="sidebar">
        <div className="brand">
          <img src="/favicon.svg" width="36" height="36" alt="" />
          <div>
            <strong>FRAME</strong>
            <span>帧序 · 创作工作台</span>
          </div>
        </div>
        <p className="nav-label">工作空间</p>
        <nav aria-label="主导航">
          <button
            className={`nav-item ${page === 'workspace' ? 'active' : ''}`}
            aria-label="工作台"
            aria-current={page === 'workspace' ? 'page' : undefined}
            onClick={() => setPage('workspace')}
          >
            <Icon name="home" />
            <span>工作台</span>
          </button>
          <button className="nav-item" aria-label="工作流 即将推出" disabled>
            <Icon name="workflow" />
            <span>工作流</span>
            <small>即将推出</small>
          </button>
          <button className="nav-item" aria-label="素材库 即将推出" disabled>
            <Icon name="asset" />
            <span>素材库</span>
            <small>即将推出</small>
          </button>
          <div className="nav-divider" />
          <button
            className={`nav-item ${page === 'settings' ? 'active' : ''}`}
            aria-label="设置"
            aria-current={page === 'settings' ? 'page' : undefined}
            onClick={() => setPage('settings')}
          >
            <Icon name="settings" />
            <span>设置</span>
          </button>
        </nav>
        <div className="sidebar-bottom">
          <span className="studio-avatar">F</span>
          <div>
            <strong>本地工作室</strong>
            <small>你的设备，你的创作空间</small>
          </div>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div>
            <span className="breadcrumb-muted">工作空间</span>
            <span className="breadcrumb-slash">/</span>
            <span>{page === 'workspace' ? '工作台' : '设置'}</span>
          </div>
          <span className="mode-badge">
            <span className="status-dot" />
            {status.state === 'browser' ? '浏览器预览' : '桌面应用'}
          </span>
        </header>
        <main id="main-content" className="main-content" tabIndex={-1}>
          {page === 'workspace' ? (
            <WorkspacePage
              status={status}
              onRetry={retry}
              onSettings={() => setPage('settings')}
            />
          ) : (
            <SettingsPage
              theme={theme}
              onThemeChange={changeTheme}
              storageError={storageError}
            />
          )}
        </main>
        <footer className="statusbar">
          <span>
            FRAME STUDIO <span className="statusbar-divider">/</span>{' '}
            创作始于下一帧
          </span>
          <span>
            基础框架 <span className="statusbar-divider">·</span> v
            {packageInfo.version}
          </span>
        </footer>
      </div>
    </div>
  )
}
