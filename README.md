# 帧序 · Frame Studio

AI 短视频创作桌面应用。支持故事、分镜和提示词可视化工作流、本地 Ollama 或 OpenAI 兼容文本服务，以及首帧生图、镜头视频、素材版本和本地成片导出。

## 技术栈

- Tauri 2 / Rust：桌面窗口、原生命令及权限边界。
- React 19 / TypeScript 严格模式：页面与交互。
- Vite 8：开发服务、热更新、生产构建。
- CSS 变量：深色、浅色与系统主题。
- React Flow：节点画布、端口连接、缩放与小地图。
- SQLite / Rust：项目、模型连接、运行快照和任务状态的本地持久化。
- Zod：前端工作流与结构化模型输出校验。
- ESLint / Prettier / Playwright：静态检查、格式与浏览器冒烟测试。
- npm：唯一包管理器；提交 `package-lock.json` 与 `src-tauri/Cargo.lock`。

TypeScript 暂锁定 5.9 系列，处于当前 typescript-eslint 的受支持范围内。Rust 工具链通过 `rust-toolchain.toml` 固定。

本机 Rust 1.98.1 编译 `tao` 时出现编译器线程栈溢出，已通过项目 `.cargo/config.toml` 将 `RUST_MIN_STACK` 设为 16 MiB 解决；不修改全局环境变量。

## 快速启动（Windows）

环境要求：Node.js 22.12+（建议 Node 24）、Rustup、Visual Studio 的“使用 C++ 的桌面开发”及 Windows SDK、WebView2 Runtime。

```powershell
npm ci
npm run desktop:dev
```

首次执行 Cargo 时，Rustup 会按 `rust-toolchain.toml` 下载对应工具链；首次 Rust 编译耗时较长。Tauri CLI 自动启动 Vite，不需要再单独执行 `npm run dev`。

仅开发前端：

```powershell
npm run dev
```

打开 http://127.0.0.1:15320。浏览器模式会明确提示“浏览器预览”，不会模拟原生成功状态。端口固定；如已运行前端服务，请先退出该服务，再使用 `desktop:dev`。浏览器测试使用独立的 15321 端口，不复用已有服务。

## 构建与检查

```powershell
npm run check                 # TypeScript、ESLint、Prettier
npm run build                 # 前端生产包，输出 dist/
npm test                      # 浏览器冒烟测试
npm run desktop:check         # Rust 编译检查
npm run desktop:lint          # Rust Clippy，警告视为错误
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
npm run tauri -- build --debug --no-bundle  # 本地调试可执行文件
npm run test:desktop           # Windows 原生冒烟测试，需要先构建上面的程序
npm run test:macos             # macOS .app 启动和内嵌 FFmpeg 冒烟测试
npm run desktop:build         # 发布构建和当前平台安装包
```

Windows 浏览器测试默认使用已安装的 Edge；其他系统先执行 `npx playwright install chromium`。可用 `PLAYWRIGHT_BROWSER_CHANNEL` 环境变量指定浏览器通道。浏览器测试不替代真实 Tauri / IPC 验证。

Windows 调试程序：`src-tauri/target/debug/frame-studio.exe`。
发布程序与安装包：`src-tauri/target/release/` 和其中的 `bundle/`。
Windows 构建生成 NSIS `.exe`，macOS 构建生成 Apple Silicon 或 Intel `.dmg`。Mac 构建流程见 [成片时间线与打包](docs/timeline-workflow.md)；当前尚未配置 Apple Developer ID 签名、公证、自动更新或发布渠道。

`test:desktop` 使用隔离的 WebView2 测试目录和 `FRAME_STUDIO_TEST_DATA_DIR`，截图与临时测试数据放在被 Git 忽略的 `artifacts/`；图片测试使用固定 PNG 与本机假服务，不执行真实模型推理，也不调用真实 OpenAI API。`test:macos` 验证 `.app` 结构、隔离数据目录启动、FFmpeg/FFprobe 能力及动态库封装。macOS 安装包由 GitHub Actions 的两个原生 Mac runner 分别构建并启动检查。

## 目录

```text
src/
  app/                       # 应用入口、导航布局、全局样式和主题变量
  features/
    workspace/               # 工作台首页与运行环境信息
    settings/                # 外观设置与主题持久化
    workflow/                # 画布、节点校验、模型连接与运行记录
  shared/
    hooks/                   # 原生连接状态
    lib/desktop.ts           # 唯一前端 IPC 入口
    types/desktop.ts         # 前后端通信类型
    ui/                      # 图标、错误边界等基础组件
src-tauri/
  src/commands/              # Rust 原生命令
  src/workflow/              # SQLite、模型适配器和 DAG 执行器
  capabilities/              # 主窗口权限
  tauri.conf.json            # 窗口、前端构建、CSP、打包配置
tests/                       # 浏览器冒烟测试
prototypes/html-v1/           # 上个任务的 HTML 草图与截图，独立保留
docs/architecture.md         # 当前边界与后续扩展约定
```

## 当前可用能力

- 桌面原生窗口及工作台 / 设置导航。
- 深色、浅色、跟随系统的主题选择；非敏感偏好保存在 WebView localStorage。
- `get_app_info` 命令：读取真实的应用名、版本、平台、架构。
- 原生连接错误、超时与手动重试；React 渲染错误兜底。
- 主窗口命令白名单及生产 CSP；没有开放文件系统、Shell 或远程页面权限。
- 工作流画布：创作需求 → 故事编剧 → 分镜导演 → 提示词助手；支持拖入节点、合法连线检查、撤销/重做、项目切换、JSON 导入导出和本地自动保存。
- 结构化 Agent 输出：故事字段、分镜镜头 ID、数量与总时长在前后端双重校验。
- 模型连接：Ollama 本地服务和 OpenAI Chat Completions 兼容服务；可列出本机 Ollama 模型、选择模型 ID、按 ID 手动下载并查看进度；API Key 只写入系统凭据库，工作流文件只保存连接 ID。
- 后台运行：按 DAG 顺序执行并保存每个节点的结果、运行快照和失败/中断状态；浏览器预览不会伪造原生调用成功。

分镜卡片的「制作首帧」可选择云端 OpenAI Images API（无需安装 ComfyUI，需 API Key，会产生云端费用）、本机 ComfyUI 或导入本地图片。候选图存入本地素材库，明确选择首帧后按分镜结果版本保存。ComfyUI 任务支持停止等待和按原任务 ID 恢复查询；云端图片请求无法远程取消，结果未知时不会自动重发。详见 [首帧工作流使用说明](docs/image-workflow.md)。

侧栏中的“模型连接”管理文本模型。图片服务在「首帧与素材」中配置，其密钥与文本连接分开保存。镜头视频和成片时间线分别在专属页面配置。画布 JSON 导出保存资产引用，不打包大文件。

## 官方参考

- [Tauri 环境要求](https://v2.tauri.app/start/prerequisites/)
- [Tauri + Vite 配置](https://v2.tauri.app/start/frontend/vite/)
- [前端调用 Rust](https://v2.tauri.app/develop/calling-rust/)
- [Tauri 权限](https://v2.tauri.app/security/capabilities/)
- [React 从零创建应用](https://react.dev/learn/build-a-react-app-from-scratch)

第二阶段通过 Context7 核对 ComfyUI 官方接口和图片解码库文档；云端图片接入核对了 OpenAI Images API 当前文档。
