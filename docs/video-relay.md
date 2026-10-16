# 视频中转站

模型列表和参数限制现统一由 [模型能力配置](video-model-capabilities.md) 驱动，前后端使用同一份定义。

在桌面应用的「镜头视频 → 视频服务」选择「视频中转站」。根地址默认 `https://api.wulusai.com`，也接受该服务的 `/v1`、`/v2` 或 `/api/v3` 地址。保存密钥后可检查连接。

## 模型与方式

新增 [SD 系列四个型号](sd-video-workflow.md)：文生、首帧图生，4–15 秒，480P / 720P / 1080P / 4K；SD 2.5 首帧比例只支持 adaptive。

| 模型                          | 当前支持的方式         | 时长    | 分辨率                   | 比例                                              |
| ----------------------------- | ---------------------- | ------- | ------------------------ | ------------------------------------------------- |
| `minimax-h3`                  | 文生视频               | 4–15 秒 | 480P / 768P / 1080P / 2K | 可不传，或选 21:9 / 16:9 / 4:3 / 1:1 / 3:4 / 9:16 |
| `grok-imagine-video-1.5-lite` | 文生视频、首帧图生视频 | 1–15 秒 | 480P / 720P / 1080P      | 固定尺寸对应 16:9，不传 ratio                     |

先在当前镜头确认首帧，再核对提示词、生成方式和预算。文生模式只发送文字；首帧仍用于关联镜头、候选封面和版本管理。Grok 首帧模式按固定横屏尺寸等比缩放并补边，再编码为 JPEG：480P 为 854×480，720P 为 1280×720，1080P 为 1920×1080；不再隐式裁掉竖屏首帧的头部、人物或道具，原图保留。生成前界面说明此适配行为；竖屏作品宜选择支持原图比例的模型。补边不能保证服务端保持原构图，生成后仍需检查实际画面和尺寸。

每次提交均可能扣费。中转站的预算由用户填写，计入已有项目预算上限；它是本地预留金额，实际费用以服务商账单为准。连接检查读取 `/v1/models`，认证成功但模型目录为空时提示「模型未列出」，生成权限和额度仍以实际提交结果为准。

## 协议与恢复

- MiniMax：POST `/v2/video_generation`，文本放在 `content`；查询 GET `/v2/query/video_generation/{task_id}`。兼容说明中的 `Success/file_url` 和实测的 `task.status=succeeded/task.content.url`。
- Grok：POST `/v1/videos`，`seconds` 为字符串，`size` 为小写。首帧使用 JSON `input_reference` 字符串，值为 base64 data URL；查询 GET `/v1/videos/{id}`。实测下载地址位于 `metadata.url`；完成响应缺少下载地址时按中转站提供的 `https://ai.wulusai.com/workflow/files/{id}.mp4` 下载。
- 模型、时长、尺寸及文件地址遵循用户提供的中转站契约。2026-10-15 的真实请求明确返回 `input_reference` 必须为字符串；因此此处不同于 [OpenAI Videos 创建协议](https://developers.openai.com/api/reference/resources/videos/methods/create) 中的对象格式。
- 远程任务 ID 与请求参数一起持久化；停止查询、查询失败或重启后，只恢复同一个 ID 的查询和下载。
- 实测 Grok 刚提交后可能短暂返回 `unknown`，稍后变为 `in_progress`。有远程 ID 时保留为可继续查询的暂停任务；不会因此重新提交。此前已记录的中转站「结果未知」任务若保留远程 ID，也可继续查询。
- 提交响应丢失且没有远程 ID 时显示「结果未知」，不自动重复提交。先核对服务商记录。
- 下载的视频保存为独立素材版本，读取实际时长、尺寸和帧率；用户明确选择后才成为镜头片段。批量队列沿用同样的服务、模型、方式与单项预算。

密钥按规范化服务根地址隔离，保存在系统凭据库。它不进入工作流、任务 JSON 或项目包。切换根地址后重新检查该地址的密钥；文件下载不携带 API Key。

`person-substitution` 是参考人物图加已有视频的人物替换功能，与当前首帧生成视频不同，当前页面未接入。

## 验证方式

`npm run test:desktop` 使用真实桌面 IPC 和本机固定协议服务，验证 MiniMax/Grok 提交、首帧 JPEG 的实际尺寸、下载入库、预算、空模型目录、拒绝请求、未知结果和原任务恢复。不会调用外部付费服务。

真实首帧测试通过环境变量显式启用，再运行 `node scripts/live-native-workflow.mjs`：

- `FRAME_STUDIO_LIVE_VIDEO=1`
- `FRAME_STUDIO_LIVE_VIDEO_KEY`：当前中转站密钥
- `FRAME_STUDIO_LIVE_VIDEO_IMAGE`：本机首帧完整路径
- `FRAME_STUDIO_LIVE_VIDEO_BASE_URL`：可选，默认上述中转站

该测试默认只提交一次 1 秒、480P Grok 首帧请求。可以用 `FRAME_STUDIO_LIVE_VIDEO_MODEL` 选择已登记的中转模型、`FRAME_STUDIO_LIVE_VIDEO_MODE` 选择 `text` 或 `frame`；新请求固定使用该模型最短时长和首项分辨率，SD 为 4 秒、480P。每次提交均可能收费。报告保存在 `artifacts/live-video-relay-*.json`，包含隔离配置目录和提交尝试时间；测试凭据在退出前清理。超时、失败或未知结果后，先检查报告和服务商任务记录，再决定下一步，避免直接重复运行造成额外扣费。恢复时使用报告记录的原目录和 `FRAME_STUDIO_LIVE_VIDEO_RESUME_REPORT`，只恢复已知任务 ID，不再次提交生成。

恢复已有测试任务时设置 `FRAME_STUDIO_LIVE_VIDEO_RESUME_REPORT` 为原报告路径，并设置 `FRAME_STUDIO_LIVE_VIDEO_PROFILE` 为该次运行的原 `artifacts/live-workflow-*` 目录。恢复分支只调用查询恢复，不创建新任务；无需再提供首帧路径。
