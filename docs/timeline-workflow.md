# 成片时间线与导出

## 从镜头到 MP4

1. 为镜头确认视频片段后，打开「时间线与导出」，把需要的版本添加到时间线。
2. 用左右按钮调整顺序，填写每段视频的开始和结束时间。时间线保存所选版本 ID 和裁剪参数，旧版本不会被新生成结果自动替换。
3. 选择 9:16、16:9 或 1:1 画幅，以及 720p 或 1080p 输出。合成时等比缩放并补边，统一为 30 fps、H.264 视频。
4. 可为每个片段填写字幕。也可导入不超过 100 KB 的 SRT 或 VTT 文件，导出时烧录进画面。
5. 可导入不超过 20 MB 的 MP3、WAV、M4A、AAC、FLAC 或 OGG 音频，分别选作配音和循环背景音乐。音乐音量可调，输出为 AAC 音轨。
6. 点击「选择位置并导出 MP4」，在系统保存对话框中选择文件。导出会记录进度与结果，成功后在同目录生成 `.cover.jpg` 封面。
7. 画布中连接「视频节点 → 成片节点」，完成导出后点击「汇集已导出成片」。节点记录导出任务、片段版本、路径、时长、画幅和分辨率，不把媒体数据写入工作流 JSON。

导出前会检查每个片段属于当前项目、仍是当前镜头的已选视频、源首帧仍匹配，并读取媒体文件的实际时长。裁剪终点超过实际时长时会提示调整。编辑时间线后，既有成片节点结果需重新导出并汇集。

## 本地数据和恢复

数据库 schema 6 新增时间线草稿、音频资产和导出任务。音频原件保存在应用数据目录 `assets/`；导出 MP4 和封面位于用户选择的文件夹。导出先写入同文件夹中的唯一临时文件，成功后更名，不覆盖现有文件。应用重启时运行中的本地任务标记为「已中断」，可从当前时间线重新导出。点击「停止导出」会终止当前 FFmpeg 进程并清理临时文件。

备份需复制应用数据目录，并单独保存已导出的 MP4 与封面。工作流 JSON 只包含已汇集成片的路径与版本引用，不包含原件、草稿、音频、字幕文件或导出历史。

## FFmpeg 配置与打包

桌面开发运行时优先使用应用程序旁的 `ffmpeg`、`ffprobe`，其次使用系统 PATH 中的安装。`npm run desktop:build` 在 Windows 生成 NSIS `.exe` 安装包，在 macOS 生成 `.dmg` 安装包。构建脚本从 `FRAME_STUDIO_FFMPEG_DIR` 指定的目录或 PATH 查找两个可执行文件，按 Rust target triple 放入忽略版本控制的 `src-tauri/binaries/`，再通过 Tauri `externalBin` 打包。脚本同时拷贝所选 FFmpeg 发布包中的 LICENSE 与 README；自定义发布包可通过 `FRAME_STUDIO_FFMPEG_LICENSE` 和 `FRAME_STUDIO_FFMPEG_README` 指定对应文件。每个目标系统与架构需要对应的 FFmpeg/FFprobe 二进制。所选 FFmpeg 构建须支持 `libx264`、`subtitles` 滤镜和 AAC 编码；macOS 构建还会拒绝依赖包外第三方动态库的二进制。

`.github/workflows/macos-installers.yml` 在原生 Apple Silicon 与 Intel runner 上分别构建 DMG，使用固定版本且校验 SHA256 的 FFmpeg 发布包，并在上传前运行应用内的 FFmpeg/FFprobe。两种 DMG 当前未配置 Apple Developer ID 签名或公证；面向普通用户发布前需配置签名与公证，并核对 FFmpeg 构建及其依赖许可。Windows 开发机所用 FFmpeg 也自报 GPL 授权。

## 验证范围

`npm run test:desktop` 使用隔离项目与本地固定 H.264 视频、WAV 音频执行真实 Tauri IPC 和 FFmpeg 合成。测试核查时间线持久化、字幕滤镜、配音与背景音乐混合、输出视频和音频流、画幅尺寸、时长、封面及成片节点。该测试不调用云端生成服务；实际云端生成仍需有效服务商密钥。已在 Windows/WebView2 环境验证，其他系统需要分别构建与运行验收。

接口依据：[FFmpeg 滤镜文档](https://ffmpeg.org/ffmpeg-filters.html)、[Tauri 外部二进制打包](https://v2.tauri.app/develop/sidecar/)。
