import { Component, type ErrorInfo, type ReactNode } from 'react'

export class ErrorBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Application render failed', error, info.componentStack)
  }
  render() {
    if (this.state.failed) {
      return (
        <main className="error-screen">
          <h1>页面暂时无法显示</h1>
          <p>请重新加载应用。若问题持续，请查看开发控制台。</p>
          <button
            className="button primary"
            onClick={() => window.location.reload()}
          >
            重新加载
          </button>
        </main>
      )
    }
    return this.props.children
  }
}
