# 帧序 · Frame Studio

AI 短视频创作桌面应用的基础工程。当前阶段只搭建桌面壳、React 界面、设置和原生通信，**尚未实现工作流画布、AI 调用或视频生成**。

## 技术栈

- Tauri 2 / Rust：桌面窗口、原生命令及权限边界。
- React 19 / TypeScript 严格模式：页面与交互。
- Vite 8：开发服务、热更新、生产构建。
- CSS 变量：深色、浅色与系统主题。
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
npm run desktop:build         # 发布构建和当前平台安装包
```

Windows 浏览器测试默认使用已安装的 Edge；其他系统先执行 `npx playwright install chromium`。可用 `PLAYWRIGHT_BROWSER_CHANNEL` 环境变量指定浏览器通道。浏览器测试不替代真实 Tauri / IPC 验证。

Windows 调试程序：`src-tauri/target/debug/frame-studio.exe`。
发布程序与安装包：`src-tauri/target/release/` 和其中的 `bundle/`。
安装包尚未配置代码签名、自动更新或发布渠道。

本机已验证前端生产构建、3 项浏览器测试、Windows 调试程序构建与原生 IPC、Clippy 和 Rust 格式检查。`test:desktop` 使用隔离的 WebView2 测试目录，截图与临时测试数据放在被 Git 忽略的 `artifacts/`。macOS / Linux 和发布安装包尚未验证。

## 目录

```text
src/
  app/                       # 应用入口、导航布局、全局样式和主题变量
  features/
    workspace/               # 工作台首页与运行环境信息
    settings/                # 外观设置与主题持久化
  shared/
    hooks/                   # 原生连接状态
    lib/desktop.ts           # 唯一前端 IPC 入口
    types/desktop.ts         # 前后端通信类型
    ui/                      # 图标、错误边界等基础组件
src-tauri/
  src/commands/              # Rust 原生命令
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

当前没有账号、数据库、项目文件格式、模型密钥输入、任务队列或画布节点执行器。侧栏“工作流”和“素材库”是明确禁用的未来入口。

## 官方参考

- [Tauri 环境要求](https://v2.tauri.app/start/prerequisites/)
- [Tauri + Vite 配置](https://v2.tauri.app/start/frontend/vite/)
- [前端调用 Rust](https://v2.tauri.app/develop/calling-rust/)
- [Tauri 权限](https://v2.tauri.app/security/capabilities/)
- [React 从零创建应用](https://react.dev/learn/build-a-react-app-from-scratch)

当前会话未提供 Context7 MCP，因此本次采用上述官方文档核对配置。
