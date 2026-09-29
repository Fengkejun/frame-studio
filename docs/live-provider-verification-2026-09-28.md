# 真实服务验证记录（2026-09-28）

使用用户提供的 OpenAI 兼容网关及本机 Ollama，测试密钥仅通过进程内参数传入；仓库、测试脚本和报告均不保存密钥。`artifacts/live-api-2026-09-28/` 存放本机生成的 PNG，目录被 Git 忽略。

| 路径             | 结果                                                                                                                                                     |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 图片网关模型目录 | 返回 `gpt-image-2`、`gpt-image-2.5-flare`、`gpt-image-2.5-sunburst`。                                                                                    |
| CLI 文生图       | 三个模型各返回一张可解码的 1024×1024 PNG。                                                                                                               |
| CLI 图生图       | `gpt-image-2` 的 `/images/edits` 接受 `image[]` multipart，并返回有效 PNG。                                                                              |
| 桌面端真实文生图 | 连接检查、系统凭据库、提交、任务入库和素材原图保存成功。                                                                                                 |
| 桌面端真实图生图 | 已提交，但测试脚本在等待新任务入列表前误读了上一任务并提前退出；任务变为结果未知，未自动重提。此轮不把它算作通过。                                       |
| 文本网关         | `gpt-5.6-sol` 返回符合故事与单镜头分镜结构的 JSON。                                                                                                      |
| 本机 Ollama      | `qwen2.5-coder:7b` 可连接并返回 JSON。仅用 JSON 模式时，一镜头请求实际返回四镜头；给 `/api/chat` 的 `format` 传 JSON Schema 后，一镜头结果通过结构校验。 |
| 桌面端文本工作流 | 本机 Ollama 与文本云端服务分别经真实 Rust IPC 完成“创作需求 → 故事 → 单镜头分镜”，结果保存在运行记录中。                                                 |
| 本机 ComfyUI     | `127.0.0.1:8188` 未运行，未做真实本机生图。                                                                                                              |
| 视频云端         | 本次未提供 Wan 视频密钥，未发起真实视频任务。Windows 桌面端的协议模拟测试仍覆盖视频任务和 FFmpeg 合成。                                                  |

修复：云端图片表单可填写兼容 API 根地址，并按地址隔离系统凭据库中的密钥；本机 Ollama 文本请求添加结构化输出约束；真实桌面测试在等待完成前先确认新任务已出现，且在表单禁用时仍尝试清理测试密钥。旧版图片任务缺少地址字段时，默认使用官方根地址。

文本云端复核期间出现过一次 HTTP 503；随后手动重试通过。应用不会对结果不确定的付费请求自动重提。

把全部媒体模拟测试和两个真实文本工作流连在同一次 WebView2 进程中运行时，云端故事生成阶段曾出现一次测试页面关闭，Windows 应用事件日志没有相应崩溃记录。拆成隔离桌面进程重跑后通过；目前没有足够证据将其归为产品崩溃。原生测试现会在失败时打印应用退出码与 stderr，便于复现时定位。

默认 `npm run test:desktop` 仍只使用本机模拟服务。设置 `FRAME_STUDIO_LIVE_IMAGE_BASE_URL` 和 `FRAME_STUDIO_LIVE_IMAGE_KEY` 后会额外执行一次真实桌面文生图；只有另外设置 `FRAME_STUDIO_LIVE_IMAGE_EDIT=1` 才会追加真实图生图。设置 `FRAME_STUDIO_LIVE_WORKFLOW=1` 后通过桌面 Rust IPC 运行本机 Ollama 故事与分镜；同时设置 `FRAME_STUDIO_LIVE_TEXT_BASE_URL` 和 `FRAME_STUDIO_LIVE_TEXT_KEY` 后还会运行云端文本工作流。`npm run test:live-workflow` 可单独运行这段原生文本验证，`FRAME_STUDIO_LIVE_WORKFLOW_SKIP_LOCAL=1` 可只测云端。`node scripts/live-text-smoke.mjs` 可验证同一文本协议。真实请求可能产生费用。

## 2026-09-29 真实桌面图生图复核

在隔离的 Windows 桌面测试数据目录中，使用同一图片网关重新执行 `npm run test:desktop`，开启真实图生图开关。脚本确认新任务入列后等待其完成，检查候选图从 3 张增加到 4 张，生成截图保存为 `artifacts/desktop-live-cloud-edit.png`。本次真实文生图和真实图生图均通过；旧任务的「结果未知」记录仍保持原判断，不会被本次新任务覆盖。测试密钥在进程内提供，运行后调用原生 IPC 清理系统凭据库中的测试密钥。其余 ComfyUI、Wan 和时间线验证在本轮桌面测试中使用本机协议模拟服务。

## 2026-09-29 本机 ComfyUI 复核

从本机已安装的 ComfyUI 启动隔离测试实例，使用独立数据目录、CPU 模式和 `127.0.0.1:8190`。设置 `FRAME_STUDIO_LIVE_COMFY_URL=http://127.0.0.1:8190` 后执行 `npm run test:desktop`：自定义 `EmptyImage → SaveImage` 工作流提交、历史查询、下载和素材入库通过；选择项目中的角色参考图后，`/upload/image` 与 `LoadImage → SaveImage` 工作流也通过。桌面截图在 `artifacts/desktop-live-comfyui.png`。这两条工作流不进行 AI 模型推理；本机测试目录没有可用 checkpoint，尚未验证 Flux、LoRA、ControlNet 或实际图生图画质。
