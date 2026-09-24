//! Local timeline and MP4 export. Inputs are immutable asset versions; no
//! arbitrary command fragments or filesystem paths are accepted from a draft.
use super::*;
use crate::workflow::{ActiveRun, WorkflowState};
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{atomic::Ordering, Arc},
    time::Duration,
};
use tauri::Manager;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};

const MAX_AUDIO_BYTES: usize = 20 * 1024 * 1024;

#[derive(Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TimelineClip {
    pub version_id: String,
    pub trim_start_ms: u32,
    pub trim_end_ms: u32,
    pub caption: String,
}

#[derive(Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Composition {
    pub workflow_id: String,
    pub clips: Vec<TimelineClip>,
    pub aspect: String,
    pub resolution: u16,
    pub music_version_id: Option<String>,
    pub voice_version_id: Option<String>,
    pub music_volume: u8,
    pub subtitle_format: String,
    pub subtitle_text: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioAsset {
    pub version_id: String,
    pub workflow_id: String,
    pub name: String,
    pub file_name: String,
    pub bytes: usize,
    pub duration_ms: u32,
    pub created_at: u64,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportJob {
    pub id: String,
    pub workflow_id: String,
    pub draft: Composition,
    pub output_path: String,
    pub cover_path: Option<String>,
    pub status: String,
    pub progress: u8,
    pub message: String,
    pub created_at: u64,
    pub updated_at: u64,
}

fn binary(name: &str) -> PathBuf {
    let filename = if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_owned()
    };
    if let Ok(exe) = std::env::current_exe() {
        let sibling = exe.with_file_name(&filename);
        if sibling.is_file() {
            return sibling;
        }
    }
    PathBuf::from(filename)
}

fn workflow_exists(state: &WorkflowState, id: &str) -> AppResult<()> {
    let exists: bool = state
        .store
        .db()?
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM workflows WHERE id=?1)",
            [id],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    if exists {
        Ok(())
    } else {
        Err("项目不存在，请先保存工作流".into())
    }
}

fn validate_draft(draft: &Composition) -> AppResult<()> {
    if draft.workflow_id.is_empty()
        || draft.workflow_id.len() > 128
        || draft.clips.len() > 24
        || !["9:16", "16:9", "1:1"].contains(&draft.aspect.as_str())
        || ![720, 1080].contains(&draft.resolution)
        || draft.music_volume > 100
        || !["none", "srt", "vtt"].contains(&draft.subtitle_format.as_str())
        || draft.subtitle_text.len() > 100_000
        || draft.clips.iter().any(|clip| {
            clip.version_id.len() > 128
                || clip.version_id.is_empty()
                || clip.trim_end_ms <= clip.trim_start_ms
                || clip.trim_end_ms - clip.trim_start_ms > 60_000
                || clip.caption.chars().count() > 500
        })
    {
        return Err("时间线参数无效或超过限制".into());
    }
    if draft
        .clips
        .iter()
        .map(|clip| &clip.version_id)
        .collect::<HashSet<_>>()
        .len()
        != draft.clips.len()
    {
        return Err("时间线中不能重复使用同一视频版本".into());
    }
    if (draft.subtitle_format == "none" && !draft.subtitle_text.is_empty())
        || (draft.subtitle_format != "none" && draft.subtitle_text.trim().is_empty())
    {
        return Err("字幕格式与导入内容不一致".into());
    }
    Ok(())
}

fn save_draft(state: &WorkflowState, draft: &Composition) -> AppResult<()> {
    state.store.db()?.execute(
        "INSERT INTO compositions VALUES (?1,?2,?3) ON CONFLICT(workflow_id) DO UPDATE SET json=excluded.json,updated_at=excluded.updated_at",
        params![draft.workflow_id, serde_json::to_string(draft).map_err(|e|e.to_string())?, now()],
    ).map_err(|e|e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn get_composition(
    state: tauri::State<WorkflowState>,
    workflow_id: String,
) -> AppResult<Option<Composition>> {
    let json: Option<String> = state
        .store
        .db()?
        .query_row(
            "SELECT json FROM compositions WHERE workflow_id=?1",
            [&workflow_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    json.map(|data| serde_json::from_str(&data).map_err(|e| e.to_string()))
        .transpose()
}

#[tauri::command]
pub fn save_composition(state: tauri::State<WorkflowState>, draft: Composition) -> AppResult<()> {
    validate_draft(&draft)?;
    workflow_exists(&state, &draft.workflow_id)?;
    save_draft(&state, &draft)
}

fn audio(state: &WorkflowState, id: &str) -> AppResult<AudioAsset> {
    let json: String = state
        .store
        .db()?
        .query_row("SELECT json FROM audio_assets WHERE id=?1", [id], |row| {
            row.get(0)
        })
        .map_err(|_| "音频素材不存在")?;
    serde_json::from_str(&json).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn list_audio_assets(
    state: tauri::State<WorkflowState>,
    workflow_id: String,
) -> AppResult<Vec<AudioAsset>> {
    let db = state.store.db()?;
    let mut query = db
        .prepare(
            "SELECT json FROM audio_assets WHERE workflow_id=?1 ORDER BY created_at DESC, rowid DESC LIMIT 100",
        )
        .map_err(|e| e.to_string())?;
    let result = query
        .query_map([workflow_id], |row| row.get::<_, String>(0))
        .map_err(|e| e.to_string())?
        .map(|row| {
            serde_json::from_str(&row.map_err(|e| e.to_string())?).map_err(|e| e.to_string())
        })
        .collect();
    result
}

fn probe_duration(path: &Path) -> AppResult<u32> {
    let output = std::process::Command::new(binary("ffprobe"))
        .args([
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=nw=1:nk=1",
        ])
        .arg(path)
        .output()
        .map_err(|_| "未找到 FFprobe，请安装 FFmpeg 或使用包含工具的应用包")?;
    let seconds: f64 = String::from_utf8_lossy(&output.stdout)
        .trim()
        .parse()
        .map_err(|_| "媒体文件无法读取时长")?;
    if !output.status.success() || !seconds.is_finite() || !(0.1..=3600.0).contains(&seconds) {
        return Err("媒体文件时长无效".into());
    }
    Ok((seconds * 1000.0).round() as u32)
}

fn probe_audio_duration(path: &Path) -> AppResult<u32> {
    let output = std::process::Command::new(binary("ffprobe"))
        .args([
            "-v",
            "error",
            "-select_streams",
            "a:0",
            "-show_entries",
            "stream=codec_type",
            "-of",
            "csv=p=0",
        ])
        .arg(path)
        .output()
        .map_err(|_| "未找到 FFprobe")?;
    if !output.status.success() || String::from_utf8_lossy(&output.stdout).trim() != "audio" {
        return Err("文件没有可解码的音频流".into());
    }
    probe_duration(path)
}

#[tauri::command]
pub async fn import_audio(
    app: tauri::AppHandle,
    workflow_id: String,
    name: String,
    bytes: Vec<u8>,
) -> AppResult<AudioAsset> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<WorkflowState>();
        workflow_exists(&state, &workflow_id)?;
        let ext = Path::new(&name)
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        if !["mp3", "wav", "m4a", "aac", "flac", "ogg"].contains(&ext.as_str())
            || name.len() > 255
            || bytes.is_empty()
            || bytes.len() > MAX_AUDIO_BYTES
        {
            return Err("音频需为 MP3、WAV、M4A、AAC、FLAC 或 OGG，且不超过 20 MB".into());
        }
        let version_id = uid();
        let file_name = format!("{version_id}.{ext}");
        let path = state.directory.join("assets").join(&file_name);
        std::fs::create_dir_all(path.parent().ok_or("素材目录无效")?).map_err(|e| e.to_string())?;
        std::fs::write(&path, &bytes).map_err(|_| "保存音频文件失败")?;
        let duration_ms = match probe_audio_duration(&path) {
            Ok(value) => value,
            Err(error) => {
                let _ = std::fs::remove_file(&path);
                return Err(error);
            }
        };
        let entry = AudioAsset {
            version_id: version_id.clone(),
            workflow_id: workflow_id.clone(),
            name,
            file_name,
            bytes: bytes.len(),
            duration_ms,
            created_at: now(),
        };
        if let Err(error) = state.store.db()?.execute(
            "INSERT INTO audio_assets VALUES (?1,?2,?3,?4)",
            params![
                version_id,
                workflow_id,
                serde_json::to_string(&entry).map_err(|e| e.to_string())?,
                entry.created_at
            ],
        ) {
            let _ = std::fs::remove_file(&path);
            return Err(error.to_string());
        }
        Ok(entry)
    })
    .await
    .map_err(|_| "音频导入中断")?
}

fn save_job(state: &WorkflowState, job: &ExportJob) -> AppResult<()> {
    state.store.db()?.execute(
        "INSERT INTO export_jobs VALUES (?1,?2,?3,?4) ON CONFLICT(id) DO UPDATE SET json=excluded.json",
        params![job.id, job.workflow_id, serde_json::to_string(job).map_err(|e|e.to_string())?, job.created_at]
    ).map_err(|e|e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn list_export_jobs(
    state: tauri::State<WorkflowState>,
    workflow_id: String,
) -> AppResult<Vec<ExportJob>> {
    let db = state.store.db()?;
    let mut query = db
        .prepare(
            "SELECT json FROM export_jobs WHERE workflow_id=?1 ORDER BY created_at DESC, rowid DESC LIMIT 50",
        )
        .map_err(|e| e.to_string())?;
    let result = query
        .query_map([workflow_id], |row| row.get::<_, String>(0))
        .map_err(|e| e.to_string())?
        .map(|row| {
            serde_json::from_str(&row.map_err(|e| e.to_string())?).map_err(|e| e.to_string())
        })
        .collect();
    result
}

pub fn collect_export(
    state: &WorkflowState,
    workflow_id: &str,
    video_artifact: &Artifact,
) -> AppResult<Option<Value>> {
    if video_artifact.kind != NodeKind::Video {
        return Err("成片节点需要视频节点结果".into());
    }
    validate_output(&NodeKind::Video, &video_artifact.value)?;
    let approved: HashSet<&str> = video_artifact.value["clips"]
        .as_array()
        .ok_or("视频片段列表无效")?
        .iter()
        .filter_map(|clip| clip["versionId"].as_str())
        .collect();
    let saved: Option<String> = state
        .store
        .db()?
        .query_row(
            "SELECT json FROM compositions WHERE workflow_id=?1",
            [workflow_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let Some(saved) = saved else {
        return Ok(None);
    };
    let current: Composition = serde_json::from_str(&saved).map_err(|e| e.to_string())?;
    let db = state.store.db()?;
    let mut query = db
        .prepare(
            "SELECT json FROM export_jobs WHERE workflow_id=?1 ORDER BY created_at DESC, rowid DESC LIMIT 50",
        )
        .map_err(|e| e.to_string())?;
    let rows = query
        .query_map([workflow_id], |row| row.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    for row in rows {
        let job: ExportJob =
            serde_json::from_str(&row.map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        if job.status == "succeeded"
            && job.draft == current
            && job
                .draft
                .clips
                .iter()
                .all(|clip| approved.contains(clip.version_id.as_str()))
            && Path::new(&job.output_path).is_file()
        {
            let duration_ms: u64 = job
                .draft
                .clips
                .iter()
                .map(|clip| u64::from(clip.trim_end_ms - clip.trim_start_ms))
                .sum();
            return Ok(Some(
                json!({"exportId":job.id,"outputPath":job.output_path,"durationMs":duration_ms,
                "aspect":job.draft.aspect,"resolution":job.draft.resolution,
                "clipVersionIds":job.draft.clips.iter().map(|clip|&clip.version_id).collect::<Vec<_>>()}),
            ));
        }
    }
    Ok(None)
}

pub fn recover(state: &WorkflowState) -> AppResult<()> {
    let jobs: Vec<ExportJob> = {
        let db = state.store.db()?;
        let mut query = db
            .prepare("SELECT json FROM export_jobs")
            .map_err(|e| e.to_string())?;
        let result = query
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|e| e.to_string())?
            .map(|row| {
                serde_json::from_str(&row.map_err(|e| e.to_string())?).map_err(|e| e.to_string())
            })
            .collect::<AppResult<_>>()?;
        result
    };
    for mut job in jobs {
        if job.status == "running" {
            job.status = "interrupted".into();
            job.message = "应用退出，导出已中断；可重新导出".into();
            job.updated_at = now();
            let _ = std::fs::remove_file(temporary_output(&job));
            save_job(state, &job)?;
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn choose_export_path(app: tauri::AppHandle) -> AppResult<Option<String>> {
    if cfg!(debug_assertions) && std::env::var_os("FRAME_STUDIO_TEST_DATA_DIR").is_some() {
        if let Some(path) = std::env::var_os("FRAME_STUDIO_TEST_EXPORT_PATH") {
            let base = PathBuf::from(path);
            if !base.exists() {
                return Ok(Some(base.to_string_lossy().into_owned()));
            }
            let stem = base
                .file_stem()
                .and_then(|value| value.to_str())
                .unwrap_or("export");
            for number in 2..=100 {
                let candidate = base.with_file_name(format!("{stem}-{number}.mp4"));
                if !candidate.exists() {
                    return Ok(Some(candidate.to_string_lossy().into_owned()));
                }
            }
            return Err("测试目录中的导出文件过多".into());
        }
    }
    let window = app.get_webview_window("main").ok_or("窗口不可用")?;
    tauri::async_runtime::spawn_blocking(move || {
        rfd::FileDialog::new()
            .set_parent(&window)
            .add_filter("MP4 视频", &["mp4"])
            .set_file_name("frame-studio.mp4")
            .save_file()
            .map(|path| path.to_string_lossy().into_owned())
    })
    .await
    .map_err(|_| "保存对话框中断".into())
}

struct ResolvedClip {
    path: PathBuf,
    start_ms: u32,
    end_ms: u32,
    caption: String,
}

fn resolve_inputs(
    state: &WorkflowState,
    draft: &Composition,
) -> AppResult<(Vec<ResolvedClip>, Vec<PathBuf>)> {
    let mut clips = Vec::new();
    for clip in &draft.clips {
        let json: String = state
            .store
            .db()?
            .query_row(
                "SELECT json FROM video_assets WHERE id=?1",
                [&clip.version_id],
                |row| row.get(0),
            )
            .map_err(|_| "视频版本不存在")?;
        let entry: video::VideoAsset = serde_json::from_str(&json).map_err(|e| e.to_string())?;
        if entry.context.workflow_id != draft.workflow_id {
            return Err("视频版本不属于当前项目".into());
        }
        validate_context(state, &entry.context)?;
        let frame: Option<String> = state.store.db()?.query_row(
            "SELECT version_id FROM first_frames WHERE workflow_id=?1 AND node_id=?2 AND artifact_id=?3 AND shot_id=?4",
            params![draft.workflow_id, entry.context.node_id, entry.context.artifact_id, entry.context.shot_id], |row|row.get(0)
        ).optional().map_err(|e|e.to_string())?;
        if frame.as_deref() != Some(&entry.first_frame_version_id) {
            return Err("源首帧已变化，请重新生成镜头视频".into());
        }
        let selected: Option<String> = state.store.db()?.query_row(
            "SELECT version_id FROM selected_videos WHERE workflow_id=?1 AND node_id=?2 AND artifact_id=?3 AND shot_id=?4",
            params![draft.workflow_id, entry.context.node_id, entry.context.artifact_id, entry.context.shot_id], |row|row.get(0)
        ).optional().map_err(|e|e.to_string())?;
        if selected.as_deref() != Some(&clip.version_id) {
            return Err("时间线含有已更换的视频版本，请重新选择".into());
        }
        let path = state.directory.join("assets").join(entry.file_name);
        if !path.is_file() {
            return Err("视频原文件已丢失".into());
        }
        let actual = probe_duration(&path)?;
        if clip.trim_end_ms > actual + 50 {
            return Err(format!("片段实际时长不足：最多 {} 毫秒", actual));
        }
        clips.push(ResolvedClip {
            path,
            start_ms: clip.trim_start_ms,
            end_ms: clip.trim_end_ms,
            caption: clip.caption.clone(),
        });
    }
    let mut audio_paths = Vec::new();
    for id in [&draft.music_version_id, &draft.voice_version_id]
        .into_iter()
        .flatten()
    {
        let entry = audio(state, id)?;
        if entry.workflow_id != draft.workflow_id {
            return Err("音频版本不属于当前项目".into());
        }
        let path = state.directory.join("assets").join(entry.file_name);
        if !path.is_file() {
            return Err("音频原文件已丢失".into());
        }
        audio_paths.push(path);
    }
    Ok((clips, audio_paths))
}

fn dimensions(aspect: &str, resolution: u16) -> (u16, u16) {
    match aspect {
        "9:16" => (resolution, resolution * 16 / 9),
        "1:1" => (resolution, resolution),
        _ => (resolution * 16 / 9, resolution),
    }
}

fn srt_time(ms: u64) -> String {
    format!(
        "{:02}:{:02}:{:02},{:03}",
        ms / 3_600_000,
        (ms / 60_000) % 60,
        (ms / 1000) % 60,
        ms % 1000
    )
}

fn subtitles(draft: &Composition, clips: &[ResolvedClip]) -> Option<(String, String)> {
    if draft.subtitle_format != "none" {
        return Some((
            format!("captions.{}", draft.subtitle_format),
            draft.subtitle_text.clone(),
        ));
    }
    let mut content = String::new();
    let mut position = 0u64;
    let mut count = 0;
    for clip in clips {
        let duration = u64::from(clip.end_ms - clip.start_ms);
        if !clip.caption.trim().is_empty() {
            count += 1;
            content.push_str(&format!(
                "{count}\n{} --> {}\n{}\n\n",
                srt_time(position),
                srt_time(position + duration),
                clip.caption.trim().replace(['\r', '\n'], " ")
            ));
        }
        position += duration;
    }
    if count == 0 {
        None
    } else {
        Some(("captions.srt".into(), content))
    }
}

fn temporary_output(job: &ExportJob) -> PathBuf {
    let final_path = Path::new(&job.output_path);
    final_path.with_file_name(format!(".frame-studio-{}.partial.mp4", job.id))
}

async fn render(
    state: &WorkflowState,
    job: &mut ExportJob,
    cancel: Arc<std::sync::atomic::AtomicBool>,
) -> AppResult<()> {
    let (clips, audio) = resolve_inputs(state, &job.draft)?;
    let total_ms: u64 = clips
        .iter()
        .map(|clip| u64::from(clip.end_ms - clip.start_ms))
        .sum();
    let (width, height) = dimensions(&job.draft.aspect, job.draft.resolution);
    let work = state.directory.join(format!("export-{}", job.id));
    tokio::fs::create_dir_all(&work)
        .await
        .map_err(|_| "无法创建导出工作目录")?;
    let result = async {
        let mut command = tokio::process::Command::new(binary("ffmpeg"));
        command.args(["-hide_banner","-nostdin","-n","-loglevel","error","-progress","pipe:1"]);
        for clip in &clips { command.arg("-i").arg(&clip.path); }
        for (index,path) in audio.iter().enumerate() {
            if index == 0 && job.draft.music_version_id.is_some() { command.args(["-stream_loop","-1"]); }
            command.arg("-i").arg(path);
        }
        let mut filters = Vec::new();
        for (index,clip) in clips.iter().enumerate() {
            filters.push(format!("[{index}:v]trim=start={:.3}:end={:.3},setpts=PTS-STARTPTS,fps=30,scale={width}:{height}:force_original_aspect_ratio=decrease,pad={width}:{height}:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p[v{index}]", f64::from(clip.start_ms)/1000.0, f64::from(clip.end_ms)/1000.0));
        }
        let labels = (0..clips.len()).map(|index|format!("[v{index}]")).collect::<String>();
        filters.push(format!("{labels}concat=n={}:v=1:a=0[joined]", clips.len()));
        if let Some((name, content)) = subtitles(&job.draft, &clips) {
            tokio::fs::write(work.join(&name), content).await.map_err(|_|"无法写入字幕")?;
            filters.push(format!("[joined]subtitles={name}[video]"));
        } else { filters.push("[joined]null[video]".into()); }
        let base = clips.len();
        match (job.draft.music_version_id.is_some(),job.draft.voice_version_id.is_some()) {
            (true,true) => {
                filters.push(format!("[{base}:a]atrim=duration={:.3},asetpts=PTS-STARTPTS,volume={:.2}[music]", total_ms as f64/1000.0, f64::from(job.draft.music_volume)/100.0));
                filters.push(format!("[{}:a]apad,atrim=duration={:.3},asetpts=PTS-STARTPTS[voice]",base+1,total_ms as f64/1000.0));
                filters.push("[music][voice]amix=inputs=2:duration=first:normalize=0[audio]".into());
            }
            (true,false) => filters.push(format!("[{base}:a]atrim=duration={:.3},asetpts=PTS-STARTPTS,volume={:.2}[audio]", total_ms as f64/1000.0, f64::from(job.draft.music_volume)/100.0)),
            (false,true) => filters.push(format!("[{base}:a]apad,atrim=duration={:.3},asetpts=PTS-STARTPTS[audio]",total_ms as f64/1000.0)),
            (false,false) => {},
        }
        command.arg("-filter_complex").arg(filters.join(";"))
            .args(["-map","[video]"]);
        if !audio.is_empty() { command.args(["-map","[audio]","-c:a","aac","-b:a","192k"]); }
        command.args(["-c:v","libx264","-preset","medium","-crf","20","-pix_fmt","yuv420p","-movflags","+faststart","-f","mp4"])
            .arg(temporary_output(job)).current_dir(&work)
            .stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
        let mut child = command.spawn().map_err(|_|"未找到 FFmpeg 或无法启动导出进程")?;
        let stdout = child.stdout.take().ok_or("无法读取导出进度")?;
        let mut lines = BufReader::new(stdout).lines();
        let status = loop {
            tokio::select! {
                line = lines.next_line() => {
                    if let Some(line) = line.map_err(|_|"导出进度中断")? {
                        if let Some(value) = line.strip_prefix("out_time=") {
                            let parts: Vec<f64> = value.split(':').filter_map(|part|part.parse().ok()).collect();
                            if parts.len() == 3 {
                                let ms = ((parts[0]*3600.0+parts[1]*60.0+parts[2])*1000.0) as u64;
                                let progress = ((ms.saturating_mul(99))/total_ms.max(1)).min(99) as u8;
                                if progress > job.progress { job.progress = progress; job.updated_at = now(); save_job(state,job)?; }
                            }
                        }
                    }
                }
                result = child.wait() => break result.map_err(|_|"导出进程中断")?,
                _ = tokio::time::sleep(Duration::from_millis(200)) => {
                    if cancel.load(Ordering::SeqCst) { child.kill().await.map_err(|_|"停止导出失败")?; return Err("已停止导出".into()); }
                }
            }
        };
        let mut errors = Vec::new();
        if let Some(stderr) = child.stderr.take() { stderr.take(8192).read_to_end(&mut errors).await.map_err(|_|"读取导出错误失败")?; }
        if !status.success() { return Err(format!("FFmpeg 导出失败：{}",String::from_utf8_lossy(&errors).chars().take(400).collect::<String>())); }
        let output = temporary_output(job);
        if tokio::fs::metadata(&output).await.map_err(|_|"MP4 导出文件未生成")?.len() < 12 { return Err("MP4 导出文件为空".into()); }
        if Path::new(&job.output_path).exists() { return Err("目标文件已存在，请选择其他名称".into()); }
        tokio::fs::rename(output, &job.output_path).await.map_err(|_|"无法保存最终 MP4")?;
        let destination = Path::new(&job.output_path);
        let stem = destination.file_stem().and_then(|value|value.to_str()).unwrap_or("frame-studio");
        let cover = destination.with_file_name(format!("{stem}.cover.jpg"));
        if !cover.exists() {
            let rendered = tokio::process::Command::new(binary("ffmpeg"))
                .args(["-hide_banner","-nostdin","-n","-loglevel","error","-ss","0.1","-i"])
                .arg(destination).args(["-frames:v","1","-q:v","2"])
                .arg(&cover).output().await;
            if rendered.is_ok_and(|result|result.status.success() && cover.is_file()) {
                job.cover_path = Some(cover.to_string_lossy().into_owned());
            }
        }
        Ok(())
    }.await;
    let _ = tokio::fs::remove_file(temporary_output(job)).await;
    let _ = tokio::fs::remove_dir_all(work).await;
    result
}

#[tauri::command]
pub fn start_export(
    app: tauri::AppHandle,
    state: tauri::State<WorkflowState>,
    draft: Composition,
    output_path: String,
) -> AppResult<ExportJob> {
    validate_draft(&draft)?;
    if draft.clips.is_empty() {
        return Err("时间线至少需要一个视频片段".into());
    }
    workflow_exists(&state, &draft.workflow_id)?;
    let path = Path::new(&output_path);
    if !path.is_absolute()
        || path
            .extension()
            .and_then(|value| value.to_str())
            .is_none_or(|value| !value.eq_ignore_ascii_case("mp4"))
        || path.exists()
        || !path.parent().is_some_and(Path::is_dir)
    {
        return Err("请选择尚未存在的 MP4 输出文件".into());
    }
    let mut active = state.export_active.lock().map_err(|_| "导出任务锁不可用")?;
    if active.is_some() {
        return Err("已有成片导出正在执行".into());
    }
    let job = ExportJob {
        id: uid(),
        workflow_id: draft.workflow_id.clone(),
        draft: draft.clone(),
        output_path,
        cover_path: None,
        status: "running".into(),
        progress: 0,
        message: "正在准备本地合成".into(),
        created_at: now(),
        updated_at: now(),
    };
    // Resolve every version before reserving or writing the destination.
    resolve_inputs(&state, &draft)?;
    save_draft(&state, &draft)?;
    save_job(&state, &job)?;
    let cancel = Arc::new(std::sync::atomic::AtomicBool::new(false));
    *active = Some(ActiveRun {
        id: job.id.clone(),
        cancel: cancel.clone(),
    });
    let response = job.clone();
    tauri::async_runtime::spawn(async move {
        let state = app.state::<WorkflowState>();
        let mut job = job;
        match render(&state, &mut job, cancel).await {
            Ok(()) => {
                job.status = "succeeded".into();
                job.progress = 100;
                job.message = if job.cover_path.is_some() {
                    "MP4 和封面已保存到所选位置"
                } else {
                    "MP4 已保存；封面未生成"
                }
                .into();
            }
            Err(error) => {
                job.status = "failed".into();
                job.message = error;
            }
        }
        job.updated_at = now();
        if let Err(error) = save_job(&state, &job) {
            eprintln!("Could not persist export job: {error}");
        }
        if let Ok(mut active) = state.export_active.lock() {
            *active = None;
        };
    });
    Ok(response)
}

#[tauri::command]
pub fn cancel_export(state: tauri::State<WorkflowState>, id: String) -> AppResult<()> {
    let active = state.export_active.lock().map_err(|_| "导出任务锁不可用")?;
    let run = active.as_ref().ok_or("当前没有正在执行的导出")?;
    if run.id != id {
        return Err("导出任务 ID 不匹配".into());
    }
    run.cancel.store(true, Ordering::SeqCst);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn interrupted_export_cleans_temporary_output() {
        let directory = std::env::temp_dir().join(format!("frame-export-test-{}", uid()));
        std::fs::create_dir(&directory).unwrap();
        let state = WorkflowState {
            store: crate::workflow::storage::Store::open(&directory.join("test.sqlite")).unwrap(),
            active: std::sync::Mutex::new(None),
            media_active: std::sync::Mutex::new(None),
            video_active: std::sync::Mutex::new(std::collections::HashMap::new()),
            export_active: std::sync::Mutex::new(None),
            directory: directory.clone(),
        };
        let job = ExportJob {
            id: uid(),
            workflow_id: "workflow".into(),
            draft: Composition {
                workflow_id: "workflow".into(),
                clips: vec![],
                aspect: "9:16".into(),
                resolution: 720,
                music_version_id: None,
                voice_version_id: None,
                music_volume: 35,
                subtitle_format: "none".into(),
                subtitle_text: String::new(),
            },
            output_path: directory.join("final.mp4").to_string_lossy().into_owned(),
            cover_path: None,
            status: "running".into(),
            progress: 33,
            message: String::new(),
            created_at: now(),
            updated_at: now(),
        };
        std::fs::write(temporary_output(&job), b"partial").unwrap();
        save_job(&state, &job).unwrap();
        recover(&state).unwrap();
        assert!(!temporary_output(&job).exists());
        let saved: String = state
            .store
            .db()
            .unwrap()
            .query_row(
                "SELECT json FROM export_jobs WHERE id=?1",
                [&job.id],
                |row| row.get(0),
            )
            .unwrap();
        let recovered: ExportJob = serde_json::from_str(&saved).unwrap();
        assert_eq!(recovered.status, "interrupted");
        assert!(!Path::new(&job.output_path).exists());
        drop(state);
        std::fs::remove_dir_all(directory).unwrap();
    }
}
