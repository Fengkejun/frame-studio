# 分镜首帧与本地素材

已完成：分镜结果 → 镜头提示词 → 云端 OpenAI 或本机 ComfyUI → 候选图 → 明确选择首帧 → 画布图片节点汇集版本。生图以分镜为入口，独立记录图片任务；「运行整个工作流」遇到图片节点时会等待当前分镜的每个镜头选定首帧，不会批量提交图片任务。只使用云端图片生成功能时，无需安装 ComfyUI。

## 云端生图（OpenAI 兼容 Images API）

1. 在分镜卡片点击「制作首帧」，选择「云端生图」。填写路径为 `/v1` 的图片 API 根地址（默认 `https://api.openai.com/v1`），输入该地址对应的 API Key 并点击「保存密钥」。每个地址的密钥分别保存在操作系统凭据库；切换地址不会把原地址密钥发送给新服务。地址会保存在本机偏好和图片任务记录中，密钥不进入项目 JSON、SQLite 或图片任务记录。仅支持 HTTPS 云端地址或本机 HTTP 地址。
2. 可用「检查连接」读取所填地址的模型目录，核对认证和当前模型是否列出。该检查不发起生图，也不保证生成权限或额度。
3. 从分镜带入提示词，选择模型、画幅与画质，然后点击「生成 1 张云端候选图」。默认 `gpt-image-2`、竖屏、低画质；也可选择 `gpt-image-2.5-flare` 或 `gpt-image-2.5-sunburst`。提交前填写本次预算预留金额（默认 $0.25），可设置项目云端媒体预算上限。每次点击都会发起可能计费的请求；需要可用的 API Key、网络和相应模型权限。
4. 返回的原图与预览保存在本机素材库。检查画面后，再明确点击「选为首帧」；重新生成不会覆盖已选版本。「不希望出现的画面元素」会作为普通文字附在提示词后，因为 Images API 没有独立的负面提示词参数。

云端请求没有可用于恢复查询的任务 ID，也不能远程取消。应用先在 SQLite 记录请求，再发起一次 POST；请求超时、连接中断或应用退出后标记为「结果未知」，不会自动重发。此时先核对所用服务商的用量与扣费，再决定是否手动生成新的候选图。确定被 API 拒绝的 4xx 错误标记为失败。若图片已经落盘但任务状态未写完，重启后会找回该候选图。支持在面板中移除当前地址已保存的密钥。

云端支持镜头文生图与角色参考图驱动的图生图，每次生成一张候选图。批量调度仍属后续阶段。模型费用随模型、画幅、画质和实际用量变化，以所填服务商的价格与账单为准；使用官方地址时可参照 [OpenAI 官方价格](https://developers.openai.com/api/docs/pricing)。

图片预算预留由用户填写，不是自动测得的图片价格。系统在提交前把预留金额与同项目已记录的图片和视频任务预估额相加；超过已设置的上限则拒绝本地提交。已提交、失败及结果未知的任务都保留在累计值中，旧版任务没有预算字段，未计入。OpenAI 按实际 token 计费，特别是图生图参考图的输入 token 无法在提交前准确获知；本地预算上限不能约束服务商实际扣费，需以服务商账单为准。

## 角色参考图与图生图

1. 在「首帧与素材」的角色参考图区域输入角色名称。可以从文生图候选、本机 ComfyUI 候选或导入图片中点击「绑定为角色参考图」。绑定按工作流和角色名保存准确的 `versionId`，更新同名角色时要明确选择新素材版本；镜头已选首帧不随角色绑定变化。
2. 在云端生图表单的「生图方式」中选择该角色参考图。提交后，桌面端读取本地原图，通过 OpenAI Images `/v1/images/edits` 的 multipart `image[]` 发送图片和提示词。返回图作为新版本保存，不覆盖参考图，也不自动改变首帧。
3. 检查候选后按需要再次绑定角色或选为镜头首帧。任务记录保存请求时所选的参考图版本，重启后仍可核对来源。图生图同样可能产生云端费用，提交结果未知时不会自动重发。

角色参考图需要先存在本地素材库。云端图生图通过 OpenAI 图片编辑接口实现；本机 ComfyUI 可通过自定义 API 格式工作流的 LoadImage 节点使用参考图。

## 本机 ComfyUI 使用

1. 启动已安装的 ComfyUI，将兼容 SD 1.5 或 SDXL 的完整 checkpoint 放在它的模型目录中。只使用本机生图时需要这一步；Frame Studio 不安装 ComfyUI 或 GPU 驱动。应用可在用户明确选择后下载下述两个 FLUX 文件。
2. 在桌面应用中生成分镜，或在分镜节点的「编辑结构化结果」中录入已有分镜。分镜必须确认且未过期。
3. 点击镜头卡片的「制作首帧」，进入「首帧与素材」，选择「本机 ComfyUI」。填本机根地址（默认 `http://127.0.0.1:8188`），检测连接并选择 checkpoint。
4. 镜头的 `imagePrompt` 自动带入正面提示词；可编辑正面/负面词。设置尺寸、步数、种子和候选数后生成。初始 512 × 768、20 步、1 张；按模型要求调整，SDXL 常需更高尺寸及更多显存。
5. 如需 Flux、LoRA、ControlNet 或本机图生图，切换「导入 API 格式工作流」，选择 ComfyUI 导出的 API JSON。应用自动填入第一个 SaveImage 节点 ID；有多个 SaveImage 时可手动指定。将需要动态赋值的输入改成字符串占位符：`{{positive}}`、`{{negative}}`、`{{seed}}`、`{{width}}`、`{{height}}`、`{{steps}}`、`{{count}}`、`{{checkpoint}}`，以及可选的 `{{output_prefix}}`。其中完全等于数字占位符的输入会保持数字类型。
6. 本机图生图时，先绑定一张角色参考图，在自定义工作流的 LoadImage.image 输入中写 `{{reference_image}}`，然后在表单中选择该角色。应用在提交工作流前上传当前素材版本的原图，再把 ComfyUI 返回的文件名填入节点。上传和任务提交都是本机请求；提交结果丢失时仍按原规则标记结果未知，不自动重发。
7. 从候选图选择，或把素材拖到首帧区域，再确认使用该版本。再次生成只增加候选，不替换已选首帧。相同种子和参数通常生成同样的图，探索时更换种子。
8. 可导入 PNG、JPEG、WebP（最多 20 MiB、最长边 8192、最多 16,777,216 像素），并明确绑定到镜头或角色。导入图片可作为云端或本机图生图参考输入。

内置模式仍使用 `CheckpointLoaderSimple → CLIPTextEncode → EmptyLatentImage → KSampler → VAEDecode → SaveImage`。自定义模式执行导入的 API JSON，最多 256 KB、512 个节点，要求指定 SaveImage 输出节点，返回图片数量应与表单中的候选数一致。ComfyUI 自身仍需安装工作流使用的节点和模型。UI 的连接检测仅验证服务及 Checkpoint 列表，不保证自定义工作流的节点、模型或显存可用。

### 可选 FLUX 模型下载

在「本机 ComfyUI」的「可选下载 FLUX / LoRA 模型」中选择现有 ComfyUI 的 `models` 文件夹。应用显示当前磁盘剩余空间、目标文件和未完成的 `.part` 文件。选择模型并确认许可与体积后才会下载。可选 [FLUX.1-dev FP8 checkpoint](https://huggingface.co/Comfy-Org/flux1-dev/blob/main/flux1-dev-fp8.safetensors)（17,246,524,772 字节）和 [FLUX.1 Depth LoRA](https://huggingface.co/Comfy-Org/flux1-dev/blob/a6518765851ffa45c55e2bb9ca5ad208fd5d8023/split_files/loras/flux1-depth-dev-lora.safetensors)（1,244,440,512 字节）；两者均受 FLUX.1-dev 非商业许可约束。Depth LoRA 还需要兼容的 FLUX.1-dev 基础模型及 Depth 工作流。

下载器只接受内置模型目录中的文件，写入 `models/checkpoints` 或 `models/loras`。如模型仓库要求认证，先在 Hugging Face 网页接受许可，再输入有读取权限的 Token；Token 仅用于本次请求，不保存到项目或系统凭据库。HTTP Range 用于续传；下载结束核对固定 SHA-256，成功后才发布最终文件名。暂停或退出应用会保留 `.part`，下次点击「继续下载」即可恢复。已有最终文件不会被覆盖，界面仅报告其存在及大小，不声称已校验。校验失败会清理损坏的 `.part`。下载完成后重启 ComfyUI，再导入对应 FLUX API 格式工作流；内置 SD 工作流不兼容 FLUX。Windows 和 macOS 安装包均不附带这些模型。仅使用云端生图时无需下载。

## 任务与版本行为

- SQLite 在 POST 前保存请求快照；收到 `prompt_id` 后立即落库。全应用一次只跟踪一个图片任务，单次生成 1–4 张。
- 每 2 秒查询 `/history/{prompt_id}`；完成后读取 `/view`，验证图片内容，保存原图和预览。每个 HTTP 请求超时 30 秒，连续等待最多 30 分钟。
- 「停止等待」只暂停客户端跟踪，不删除队列，不调用全局 `/interrupt`，也不会阻止服务端继续使用 GPU。当前网络请求完成/超时后生效。暂停后再次生成可能在服务端排队。
- 有任务 ID 的网络、下载或保存失败可「继续查询原任务」，只 GET 原任务，不重新 POST。图片版本 ID 由任务 ID 和候选序号决定，重复获取不会增加同一候选的版本。
- 重启后，等待/下载中的任务标记为可继续查询；提交响应丢失且没有 ID 的任务标记为结果未知。结果未知时先检查 ComfyUI 队列，不自动重试。
- 服务端拒绝请求或明确报告执行失败时记录失败。ComfyUI 历史被清理后，原任务可能无法取回；需检查服务端再决定是否重新生成。
- 首帧绑定键是 `workflowId + nodeId + artifactId + shotId`。重新保存分镜结果会生成新的 artifactId；旧首帧不会悄悄套用到新分镜，旧图片仍在本地素材库。
- 画布中添加「图片节点」并连接分镜节点后，先在「首帧与素材」为每个镜头明确选择一张图，再点击「汇集已选首帧」。输出记录分镜产物 ID、镜头 ID、素材 ID、版本 ID 和尺寸。缺少首帧时运行记录为「等待首帧」；更换首帧会使已有图片节点结果待更新。该节点不调用生图服务。
- 切换项目、离开画布不会取消图片任务。浏览器预览不执行真实请求或导入图片。

## 本地数据与备份

应用数据目录下 `studio.sqlite` 保存项目、任务快照、素材元数据、角色参考图版本、首帧选择及最近使用的 ComfyUI 参数；`assets/` 保存图片原件和 640 像素以内的 PNG 预览。数据库版本 4 增加角色参考图绑定，版本 5 增加视频任务、视频版本与镜头片段选择，保留原有项目和图片数据。API Key 由操作系统凭据库保存。

本地素材库显示最近 500 个版本，分页显示缩略图；当前项目显示最近 100 条图片任务。旧文件和记录不会被自动删除。尚无自动磁盘清理功能。

当前画布 JSON 导出包含节点和首帧输出的版本引用，不打包图片、图片任务、角色参考图或首帧绑定。复制/导入工作流产生新项目 ID，需要重新绑定角色参考图与首帧。完整备份请在退出应用后保存整个应用数据目录，不能只复制 JSON。跨设备项目素材包属于后续任务。

## 验证范围

`npm run test:desktop` 在隔离 WebView2 配置和数据库内执行真实 Rust IPC，使用 localhost 协议测试服务返回固定 PNG。覆盖候选入库、选择、角色版本绑定、文生图与图生图 multipart 请求、自定义 ComfyUI 工作流参数替换与参考图上传、可选模型目录和许可确认、暂停恢复、下载失败后恢复、执行错误、HTTP 拒绝、导入校验、页面重载持久化、分镜版本隔离，以及图片节点的等待、汇集和版本变更后待更新状态。默认使用假 API Key 和本机假服务；设置 `FRAME_STUDIO_LIVE_IMAGE_BASE_URL` 与 `FRAME_STUDIO_LIVE_IMAGE_KEY` 时追加真实文生图，另设置 `FRAME_STUDIO_LIVE_IMAGE_EDIT=1` 时追加真实图生图，可能产生费用。Rust 单元测试覆盖模型续传、校验、无覆盖发布、模板校验、重启恢复及 v1/v2/v3 数据库迁移。

协议测试不执行 AI 推理，不评估模型权限、模型兼容性、显存占用和图片质量。设置 `FRAME_STUDIO_LIVE_COMFY_URL` 可在桌面测试中对运行中的本机 ComfyUI 执行无需模型的 EmptyImage 工作流，以及上传现有角色参考图的 LoadImage 工作流；这两条真实服务测试覆盖队列、历史、图片下载和素材入库。自定义工作流的真实推理验收仍需启动装有对应节点和模型的本机 ComfyUI，并运行一条镜头。

## 接口依据

本次通过 Context7 核对 [ComfyUI API 格式导出](https://github.com/comfy-org/docs/blob/main/development/api-development/workflow-api-format.mdx)、[ComfyUI API 示例](https://github.com/comfy-org/ComfyUI/blob/master/script_examples/basic_api_example.py)、[服务端路由](https://github.com/comfy-org/ComfyUI/blob/master/server.py) 与 [执行历史状态](https://github.com/comfy-org/ComfyUI/blob/master/execution.py)。

云端图片接口对照 [OpenAI 图片生成指南](https://developers.openai.com/api/docs/guides/image-generation)、[生成接口](https://developers.openai.com/api/reference/resources/images/methods/generate) 与 [编辑接口](https://developers.openai.com/api/reference/resources/images/methods/edit)。
