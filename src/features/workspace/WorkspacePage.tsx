import type { RuntimeStatus } from '@/shared/types/desktop'
import { Icon } from '@/shared/ui/Icon'
import { RuntimePanel } from './RuntimePanel'
import { SetupChecklist } from './SetupChecklist'

export function WorkspacePage({
  status,
  onRetry,
  onWorkflow,
  onModels,
  onImages,
  onVideos,
  onTimeline,
}: {
  status: RuntimeStatus
  onRetry: () => void
  onWorkflow: () => void
  onModels: () => void
  onImages: () => void
  onVideos: () => void
  onTimeline: () => void
}) {
  return (
    <div className="workspace-page">
      <section className="hero" aria-labelledby="welcome-title">
        <div className="hero-copy">
          <p className="eyebrow">YOUR CREATIVE SPACE</p>
          <h1 id="welcome-title">
            从一个想法，
            <br />
            <span>到一部短片。</span>
          </h1>
          <p className="hero-description">
            欢迎来到帧序。从故事、分镜和首帧，
            <br className="desktop-break" />
            到镜头视频与成片导出。
          </p>
          <button className="button primary" onClick={onWorkflow}>
            打开工作流画布
            <Icon name="arrow" />
          </button>
          <div className="hero-caption">
            <span className="status-dot" />
            故事、首帧、视频与成片
          </div>
        </div>
        <div className="frame-art" aria-hidden="true">
          <div className="frame-label">FRAME / 001</div>
          <div className="film-frame back" />
          <div className="film-frame front">
            <div className="frame-corner tl" />
            <div className="frame-corner tr" />
            <div className="frame-corner bl" />
            <div className="frame-corner br" />
            <span className="crosshair">+</span>
            <span className="frame-word">
              MAKE
              <br />
              ROOM FOR
              <br />
              <em>ideas.</em>
            </span>
            <span className="frame-time">00 : 00 : 00</span>
          </div>
          <span className="frame-bottom">THE NEXT FRAME IS YOURS.</span>
        </div>
      </section>
      <SetupChecklist
        onModels={onModels}
        onImages={onImages}
        onVideos={onVideos}
        onTimeline={onTimeline}
      />
      <div className="workspace-bottom">
        <section className="next-section" aria-labelledby="next-title">
          <div className="section-heading">
            <div>
              <p className="eyebrow">YOUR WORKFLOW</p>
              <h2 id="next-title">从故事走向画面</h2>
            </div>
            <span className="badge">创作工具</span>
          </div>
          <p className="section-description">
            围绕故事组织素材，让每个镜头都有自己的位置。
          </p>
          <button className="coming-row coming-row-button" onClick={onWorkflow}>
            <span className="feature-symbol">
              <Icon name="workflow" />
            </span>
            <div>
              <h3>工作流画布</h3>
              <p>节点编排、素材连接与逐步执行</p>
            </div>
            <span className="coming-label">打开</span>
          </button>
          <div className="coming-row">
            <span className="feature-symbol">
              <Icon name="asset" />
            </span>
            <div>
              <h3>首帧与素材</h3>
              <p>分镜生图、导入图片与首帧版本选择</p>
            </div>
            <span className="coming-label">画布内使用</span>
          </div>
        </section>
        <RuntimePanel status={status} onRetry={onRetry} />
      </div>
    </div>
  )
}
