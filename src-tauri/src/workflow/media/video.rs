//! Wan first-frame video jobs. Persist the remote task ID before polling; never
//! repeat a possibly billable submit after an uncertain response.
use super::*;
use crate::workflow::WorkflowState;
use image::{codecs::jpeg::JpegEncoder, GenericImageView};
use reqwest::{Client, Url};
use serde_json::{json, Value};
use std::{
    io::Cursor,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};
use tauri::Manager;
use tokio::io::AsyncWriteExt;

const MODEL: &str = "wan2.7-i2v-2026-04-25";
const MAX_VIDEO_BYTES: u64 = 256 * 1024 * 1024;
const MAX_PREVIEW_BYTES: u64 = 64 * 1024 * 1024;
const API_LIMIT: usize = 128 * 1024;

pub struct ActiveVideo {
    context: ShotContext,
    cancel: Arc<AtomicBool>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VideoRequest {
    pub context: ShotContext,
    pub first_frame_version_id: String,
    pub region: String,
    pub prompt: String,
    pub negative_prompt: String,
    pub duration: u8,
    pub resolution: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoJob {
    pub id: String,
    pub request: VideoRequest,
    pub task_id: Option<String>,
    pub status: String,
    pub message: String,
    pub created_at: u64,
    pub updated_at: u64,
    pub asset_id: Option<String>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoAsset {
    pub asset_id: String,
    pub version_id: String,
    pub context: ShotContext,
    pub first_frame_version_id: String,
    pub job_id: String,
    pub duration: u8,
    pub resolution: String,
    pub bytes: u64,
    pub created_at: u64,
    pub file_name: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SelectedVideo {
    pub context: ShotContext,
    pub version_id: String,
}
pub fn collect_video_clips(
    state: &WorkflowState,
    workflow_id: &str,
    storyboard_node_id: &str,
    image_artifact: &Artifact,
) -> AppResult<FrameCollection> {
    if image_artifact.kind != NodeKind::Image {
        return Err("视频节点需要图片节点结果".into());
    }
    validate_output(&NodeKind::Image, &image_artifact.value)?;
    let artifact_id = image_artifact.value["storyboardArtifactId"]
        .as_str()
        .ok_or("分镜产物 ID 无效")?;
    let frames = image_artifact.value["frames"]
        .as_array()
        .ok_or("首帧列表无效")?;
    let mut clips = Vec::with_capacity(frames.len());
    let mut missing = Vec::new();
    for frame in frames {
        let shot_id = frame["shotId"].as_str().ok_or("镜头 ID 无效")?;
        let frame_version = frame["versionId"].as_str().ok_or("首帧版本无效")?;
        let selected: Option<String> = state.store.db()?.query_row(
            "SELECT version_id FROM selected_videos WHERE workflow_id=?1 AND node_id=?2 AND artifact_id=?3 AND shot_id=?4",
            params![workflow_id, storyboard_node_id, artifact_id, shot_id],
            |row| row.get(0),
        ).optional().map_err(|e| e.to_string())?;
        if let Some(version_id) = selected {
            if let Ok(entry) = load_asset(state, &version_id) {
                if entry.first_frame_version_id == frame_version
                    && state
                        .directory
                        .join("assets")
                        .join(&entry.file_name)
                        .is_file()
                {
                    clips.push(json!({
                        "shotId": shot_id,
                        "assetId": entry.asset_id,
                        "versionId": entry.version_id,
                        "firstFrameVersionId": entry.first_frame_version_id,
                        "duration": entry.duration,
                        "resolution": entry.resolution,
                    }));
                    continue;
                }
            }
        }
        missing.push(shot_id.to_owned());
    }
    if !missing.is_empty() {
        return Ok(FrameCollection::Missing(missing));
    }
    Ok(FrameCollection::Complete(
        json!({"storyboardArtifactId":artifact_id,"clips":clips}),
    ))
}

fn valid_region(region: &str) -> AppResult<&'static str> {
    match region {
        "singapore" => Ok("dashscope-intl.aliyuncs.com"),
        "beijing" => Ok("dashscope.aliyuncs.com"),
        _ => Err("视频服务地区无效".into()),
    }
}
fn key_entry(region: &str) -> AppResult<keyring::Entry> {
    valid_region(region)?;
    let service =
        if cfg!(debug_assertions) && std::env::var_os("FRAME_STUDIO_TEST_DATA_DIR").is_some() {
            "com.frame-studio.desktop.videos.test"
        } else {
            "com.frame-studio.desktop.videos"
        };
    keyring::Entry::new(service, region).map_err(|_| "无法访问系统凭据库".into())
}
fn get_key(region: &str) -> AppResult<Option<String>> {
    match key_entry(region)?.get_password() {
        Ok(key) => Ok(Some(key)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Err("无法读取视频 API Key".into()),
    }
}
#[tauri::command]
pub fn video_key_status(region: String) -> AppResult<bool> {
    Ok(get_key(&region)?.is_some())
}
#[tauri::command]
pub fn save_video_key(region: String, api_key: String) -> AppResult<()> {
    if api_key.trim().is_empty() || api_key.len() > 4096 || api_key.contains(['\r', '\n']) {
        return Err("API Key 无效".into());
    }
    key_entry(&region)?
        .set_password(api_key.trim())
        .map_err(|_| "系统凭据库保存失败".into())
}
#[tauri::command]
pub fn clear_video_key(region: String) -> AppResult<()> {
    match key_entry(&region)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(_) => Err("系统凭据库删除失败".into()),
    }
}
fn validate_request(state: &WorkflowState, request: &VideoRequest) -> AppResult<ImageAsset> {
    valid_region(&request.region)?;
    validate_context(state, &request.context)?;
    if request.prompt.trim().is_empty()
        || request.prompt.chars().count() > 5000
        || request.negative_prompt.chars().count() > 500
        || !(2..=15).contains(&request.duration)
        || !["720P", "1080P"].contains(&request.resolution.as_str())
    {
        return Err("请检查视频提示词、时长和分辨率".into());
    }
    let selected: Option<String> = state.store.db()?.query_row(
        "SELECT version_id FROM first_frames WHERE workflow_id=?1 AND node_id=?2 AND artifact_id=?3 AND shot_id=?4",
        params![request.context.workflow_id, request.context.node_id, request.context.artifact_id, request.context.shot_id],
        |row| row.get(0),
    ).optional().map_err(|e| e.to_string())?;
    if selected.as_deref() != Some(&request.first_frame_version_id) {
        return Err("首帧版本已变化，请重新选择后提交视频".into());
    }
    let entry = asset(state, &request.first_frame_version_id)?;
    if entry.width < 240
        || entry.height < 240
        || entry.width > 8000
        || entry.height > 8000
        || u64::from(entry.width) > u64::from(entry.height) * 8
        || u64::from(entry.height) > u64::from(entry.width) * 8
    {
        return Err("万相首帧要求宽高 240–8000 像素、宽高比在 1:8–8:1".into());
    }
    if !state
        .directory
        .join("assets")
        .join(&entry.file_name)
        .is_file()
    {
        return Err("首帧原图已丢失".into());
    }
    Ok(entry)
}
fn save_job(state: &WorkflowState, job: &VideoJob) -> AppResult<()> {
    state.store.db()?.execute(
        "INSERT INTO video_jobs VALUES (?1,?2,?3,?4) ON CONFLICT(id) DO UPDATE SET json=excluded.json",
        params![job.id, job.request.context.workflow_id, serde_json::to_string(job).map_err(|e| e.to_string())?, job.created_at],
    ).map_err(|e| e.to_string())?;
    Ok(())
}
fn load_job(state: &WorkflowState, id: &str) -> AppResult<VideoJob> {
    let data: String = state
        .store
        .db()?
        .query_row("SELECT json FROM video_jobs WHERE id=?1", [id], |row| {
            row.get(0)
        })
        .map_err(|_| "视频任务不存在")?;
    serde_json::from_str(&data).map_err(|e| e.to_string())
}
fn save_asset(state: &WorkflowState, entry: &VideoAsset) -> AppResult<()> {
    state
        .store
        .db()?
        .execute(
            "INSERT INTO video_assets VALUES (?1,?2,?3) ON CONFLICT(id) DO NOTHING",
            params![
                entry.version_id,
                serde_json::to_string(entry).map_err(|e| e.to_string())?,
                entry.created_at
            ],
        )
        .map_err(|e| e.to_string())?;
    Ok(())
}
fn load_asset(state: &WorkflowState, id: &str) -> AppResult<VideoAsset> {
    let data: String = state
        .store
        .db()?
        .query_row("SELECT json FROM video_assets WHERE id=?1", [id], |row| {
            row.get(0)
        })
        .map_err(|_| "视频素材不存在")?;
    serde_json::from_str(&data).map_err(|e| e.to_string())
}
pub fn recover(state: &WorkflowState) -> AppResult<()> {
    let jobs: Vec<VideoJob> = {
        let db = state.store.db()?;
        let mut query = db
            .prepare("SELECT json FROM video_jobs")
            .map_err(|e| e.to_string())?;
        let rows = query
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        rows.map(|row| {
            serde_json::from_str(&row.map_err(|e| e.to_string())?).map_err(|e| e.to_string())
        })
        .collect::<AppResult<_>>()?
    };
    for mut job in jobs {
        if matches!(
            job.status.as_str(),
            "submitting" | "queued" | "running" | "downloading"
        ) {
            let id = format!("{}-0", job.id);
            if load_asset(state, &id).is_ok_and(|entry| {
                state
                    .directory
                    .join("assets")
                    .join(entry.file_name)
                    .is_file()
            }) {
                job.asset_id = Some(id);
                job.status = "succeeded".into();
                job.message = "已找回保存到本地的视频片段".into();
            } else if job.task_id.is_some() {
                job.status = "paused".into();
                job.message = "应用重启；点击继续查询原任务，不会重新提交".into();
            } else {
                job.status = "unknown".into();
                job.message = "提交结果未知；请核对服务商用量，避免重复计费".into();
            }
            job.updated_at = now();
            save_job(state, &job)?;
        }
    }
    Ok(())
}
#[tauri::command]
pub fn list_video_jobs(
    state: tauri::State<WorkflowState>,
    workflow_id: String,
) -> AppResult<Vec<VideoJob>> {
    let db = state.store.db()?;
    let mut query = db
        .prepare(
            "SELECT json FROM video_jobs WHERE workflow_id=?1 ORDER BY created_at DESC LIMIT 100",
        )
        .map_err(|e| e.to_string())?;
    let rows = query
        .query_map([workflow_id], |row| row.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    rows.map(|row| {
        serde_json::from_str(&row.map_err(|e| e.to_string())?).map_err(|e| e.to_string())
    })
    .collect()
}
#[tauri::command]
pub fn list_video_assets(
    state: tauri::State<WorkflowState>,
    workflow_id: String,
) -> AppResult<Vec<VideoAsset>> {
    let db = state.store.db()?;
    let mut query = db
        .prepare("SELECT json FROM video_assets WHERE json_extract(json, '$.context.workflowId')=?1 ORDER BY created_at DESC LIMIT 500")
        .map_err(|e| e.to_string())?;
    let rows = query
        .query_map([workflow_id], |row| row.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    rows.map(|row| {
        serde_json::from_str::<VideoAsset>(&row.map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())
    })
    .collect()
}
#[tauri::command]
pub fn list_selected_videos(
    state: tauri::State<WorkflowState>,
    workflow_id: String,
) -> AppResult<Vec<SelectedVideo>> {
    let db = state.store.db()?;
    let mut query = db.prepare("SELECT node_id,artifact_id,shot_id,version_id FROM selected_videos WHERE workflow_id=?1").map_err(|e| e.to_string())?;
    let rows = query
        .query_map([&workflow_id], |row| {
            Ok(SelectedVideo {
                context: ShotContext {
                    workflow_id: workflow_id.clone(),
                    node_id: row.get(0)?,
                    artifact_id: row.get(1)?,
                    shot_id: row.get(2)?,
                },
                version_id: row.get(3)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.map(|row| row.map_err(|e| e.to_string())).collect()
}
#[tauri::command]
pub fn select_video(
    state: tauri::State<WorkflowState>,
    context: ShotContext,
    version_id: String,
) -> AppResult<()> {
    validate_context(&state, &context)?;
    let entry = load_asset(&state, &version_id)?;
    let first_frame: Option<String> = state.store.db()?.query_row(
        "SELECT version_id FROM first_frames WHERE workflow_id=?1 AND node_id=?2 AND artifact_id=?3 AND shot_id=?4",
        params![context.workflow_id, context.node_id, context.artifact_id, context.shot_id],
        |row| row.get(0),
    ).optional().map_err(|e| e.to_string())?;
    if first_frame.as_deref() != Some(&entry.first_frame_version_id) {
        return Err("视频的源首帧已变化，请使用当前首帧重新生成".into());
    }
    if entry.context != context
        || !state
            .directory
            .join("assets")
            .join(entry.file_name)
            .is_file()
    {
        return Err("视频版本不属于当前分镜或文件已丢失".into());
    }
    state.store.db()?.execute(
        "INSERT INTO selected_videos VALUES (?1,?2,?3,?4,?5) ON CONFLICT(workflow_id,node_id,artifact_id,shot_id) DO UPDATE SET version_id=excluded.version_id",
        params![context.workflow_id,context.node_id,context.artifact_id,context.shot_id,version_id],
    ).map_err(|e| e.to_string())?;
    Ok(())
}
#[tauri::command]
pub async fn video_preview(app: tauri::AppHandle, version_id: String) -> AppResult<String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<WorkflowState>();
        let entry = load_asset(&state, &version_id)?;
        if entry.bytes > MAX_PREVIEW_BYTES {
            return Err("片段超过 64 MB，当前预览上限无法播放".into());
        }
        let path = state.directory.join("assets").join(entry.file_name);
        if std::fs::metadata(&path)
            .map_err(|_| "视频文件已丢失")?
            .len()
            > MAX_PREVIEW_BYTES
        {
            return Err("片段超过 64 MB 预览上限".into());
        }
        let bytes = std::fs::read(path).map_err(|_| "视频文件已丢失")?;
        if bytes.len() as u64 > MAX_PREVIEW_BYTES {
            return Err("片段超过 64 MB，当前预览上限无法播放".into());
        }
        Ok(format!("data:video/mp4;base64,{}", STANDARD.encode(bytes)))
    })
    .await
    .map_err(|_| "无法读取视频预览")?
}
fn reserve(state: &WorkflowState, job: &VideoJob) -> AppResult<Arc<AtomicBool>> {
    let mut active = state.video_active.lock().map_err(|_| "视频任务锁不可用")?;
    if active.len() >= 3 {
        return Err("最多同时查询 3 个视频任务".into());
    }
    let running_same_shot = active
        .values()
        .any(|other| other.context == job.request.context);
    if running_same_shot {
        return Err("这个镜头已有视频任务正在执行".into());
    }
    let cancel = Arc::new(AtomicBool::new(false));
    active.insert(
        job.id.clone(),
        ActiveVideo {
            context: job.request.context.clone(),
            cancel: cancel.clone(),
        },
    );
    Ok(cancel)
}
fn launch(app: tauri::AppHandle, mut job: VideoJob, key: String, cancel: Arc<AtomicBool>) {
    tauri::async_runtime::spawn(async move {
        let state = app.state::<WorkflowState>();
        let result = execute(&state, &mut job, &key, &cancel).await;
        if let Err(error) = result {
            if !matches!(job.status.as_str(), "failed" | "paused" | "unknown") {
                job.status = if job.task_id.is_some() {
                    "paused"
                } else {
                    "unknown"
                }
                .into();
            }
            job.message = error;
        }
        job.updated_at = now();
        if let Err(error) = save_job(&state, &job) {
            eprintln!("Could not persist video job: {error}");
        }
        if let Ok(mut active) = state.video_active.lock() {
            active.remove(&job.id);
        };
    });
}
#[tauri::command]
pub fn start_video_job(
    app: tauri::AppHandle,
    state: tauri::State<WorkflowState>,
    request: VideoRequest,
) -> AppResult<VideoJob> {
    validate_request(&state, &request)?;
    let key = get_key(&request.region)?.ok_or("请先保存对应地区的万相 API Key")?;
    let mut job = VideoJob {
        id: uid(),
        request,
        task_id: None,
        status: "submitting".into(),
        message: "正在提交图生视频任务".into(),
        created_at: now(),
        updated_at: now(),
        asset_id: None,
    };
    let cancel = reserve(&state, &job)?;
    if let Err(error) = save_job(&state, &job) {
        state
            .video_active
            .lock()
            .map_err(|_| "视频任务锁不可用")?
            .remove(&job.id);
        return Err(error);
    }
    let response = job.clone();
    job.updated_at = now();
    launch(app, job, key, cancel);
    Ok(response)
}
#[tauri::command]
pub fn pause_video_job(state: tauri::State<WorkflowState>, id: String) -> AppResult<()> {
    let active = state.video_active.lock().map_err(|_| "视频任务锁不可用")?;
    let cancel = active.get(&id).ok_or("任务当前没有在查询")?;
    cancel.cancel.store(true, Ordering::SeqCst);
    Ok(())
}
#[tauri::command]
pub fn resume_video_job(
    app: tauri::AppHandle,
    state: tauri::State<WorkflowState>,
    id: String,
) -> AppResult<()> {
    let mut job = load_job(&state, &id)?;
    if job.status != "paused" || job.task_id.is_none() {
        return Err("只有已取得远程任务 ID 的暂停任务可以继续查询".into());
    }
    let key = get_key(&job.request.region)?.ok_or("请先保存对应地区的万相 API Key")?;
    let cancel = reserve(&state, &job)?;
    job.status = "running".into();
    job.message = "正在查询原视频任务".into();
    job.updated_at = now();
    if let Err(error) = save_job(&state, &job) {
        state
            .video_active
            .lock()
            .map_err(|_| "视频任务锁不可用")?
            .remove(&job.id);
        return Err(error);
    }
    launch(app, job, key, cancel);
    Ok(())
}
fn api_url(region: &str, task_id: Option<&str>) -> AppResult<Url> {
    let host = valid_region(region)?;
    let mut url = Url::parse(&format!("https://{host}/")).map_err(|_| "视频服务地址无效")?;
    if cfg!(debug_assertions) && std::env::var_os("FRAME_STUDIO_TEST_DATA_DIR").is_some() {
        if let Ok(value) = std::env::var("FRAME_STUDIO_TEST_WAN_URL") {
            let test = Url::parse(&value).map_err(|_| "测试视频接口地址无效")?;
            if test.scheme() != "http"
                || !matches!(test.host_str(), Some("127.0.0.1" | "localhost" | "[::1]"))
                || test.path() != "/api/v1/services/aigc/video-generation/video-synthesis"
                || !test.username().is_empty()
                || test.password().is_some()
                || test.query().is_some()
                || test.fragment().is_some()
            {
                return Err("测试视频接口仅允许本机固定路径".into());
            }
            url = test;
        }
    }
    if let Some(id) = task_id {
        if id.is_empty()
            || id.len() > 128
            || !id
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        {
            return Err("远程视频任务 ID 无效".into());
        }
        url.set_path(&format!("/api/v1/tasks/{id}"));
    } else {
        url.set_path("/api/v1/services/aigc/video-generation/video-synthesis");
    }
    Ok(url)
}
async fn response_json(mut response: reqwest::Response) -> AppResult<Value> {
    if response
        .content_length()
        .is_some_and(|size| size > API_LIMIT as u64)
    {
        return Err("视频服务响应过大".into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| "视频服务响应中断")? {
        if bytes.len() + chunk.len() > API_LIMIT {
            return Err("视频服务响应过大".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| "视频服务响应格式无效".into())
}
fn client() -> AppResult<Client> {
    Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(180))
        .build()
        .map_err(|_| "无法初始化视频服务连接".into())
}
fn request_body(state: &WorkflowState, request: &VideoRequest) -> AppResult<Value> {
    let entry = validate_request(state, request)?;
    let bytes = std::fs::read(state.directory.join("assets").join(entry.file_name))
        .map_err(|_| "首帧原图已丢失")?;
    let (decoded, _) = super::decode(&bytes)?;
    let (width, height) = decoded.dimensions();
    if width < 240 || height < 240 {
        return Err("万相首帧最短边不能小于 240 像素".into());
    }
    let mut jpeg = Cursor::new(Vec::new());
    JpegEncoder::new_with_quality(&mut jpeg, 90)
        .encode_image(&decoded.to_rgb8())
        .map_err(|_| "无法处理首帧图片")?;
    let jpeg = jpeg.into_inner();
    if jpeg.len() > MAX_IMAGE_BYTES {
        return Err("首帧转码后超过 20 MB 限制".into());
    }
    Ok(json!({
        "model": MODEL,
        "input": {
            "prompt": request.prompt,
            "negative_prompt": request.negative_prompt,
            "media": [{"type":"first_frame","url":format!("data:image/jpeg;base64,{}", STANDARD.encode(jpeg))}]
        },
        "parameters": {
            "resolution": request.resolution,
            "duration": request.duration,
            "prompt_extend": false,
            "watermark": false
        }
    }))
}
async fn execute(
    state: &WorkflowState,
    job: &mut VideoJob,
    key: &str,
    cancel: &AtomicBool,
) -> AppResult<()> {
    // Local preparation failures are definite failures; only a sent request can
    // have an uncertain remote outcome.
    if job.task_id.is_none() {
        job.status = "failed".into();
    }
    let client = client()?;
    if job.task_id.is_none() {
        let body = request_body(state, &job.request)?;
        if cancel.load(Ordering::SeqCst) {
            return Err("提交前已停止；没有创建远程视频任务".into());
        }
        let url = api_url(&job.request.region, None)?;
        job.status = "submitting".into();
        let response = client
            .post(url)
            .bearer_auth(key)
            .header("X-DashScope-Async", "enable")
            .json(&body)
            .send()
            .await
            .map_err(|_| "提交结果未知；请核对服务商用量，避免重复计费")?;
        let status = response.status();
        let data = response_json(response).await?;
        if !status.is_success()
            || data
                .get("code")
                .and_then(Value::as_str)
                .is_some_and(|s| !s.is_empty())
        {
            if status.is_client_error() {
                job.status = "failed".into();
            }
            return Err(format!(
                "万相拒绝视频任务（HTTP {}）：{}",
                status.as_u16(),
                data["message"]
                    .as_str()
                    .unwrap_or("请检查密钥、地区与模型权限")
                    .chars()
                    .take(200)
                    .collect::<String>()
            ));
        }
        let task_id = data
            .pointer("/output/task_id")
            .and_then(Value::as_str)
            .ok_or("提交响应缺少任务 ID；结果未知，请核对服务商用量")?;
        api_url(&job.request.region, Some(task_id))?;
        job.task_id = Some(task_id.to_owned());
        job.status = "queued".into();
        job.message = "远程任务已创建，正在等待结果".into();
        job.updated_at = now();
        save_job(state, job)?;
    }
    loop {
        if cancel.load(Ordering::SeqCst) {
            job.status = "paused".into();
            return Err("已停止本地查询；远程任务可能继续运行，可继续查询原任务".into());
        }
        let id = job.task_id.as_deref().ok_or("远程任务 ID 丢失")?;
        let response = client
            .get(api_url(&job.request.region, Some(id))?)
            .bearer_auth(key)
            .send()
            .await
            .map_err(|_| "查询中断；可继续查询原任务")?;
        let status = response.status();
        let data = response_json(response).await?;
        if !status.is_success() {
            return Err(format!(
                "查询任务返回 HTTP {}；可继续查询原任务",
                status.as_u16()
            ));
        }
        let output = data.get("output").ok_or("查询响应缺少任务结果")?;
        match output["task_status"].as_str().unwrap_or("") {
            "PENDING" | "RUNNING" => {
                job.status = if output["task_status"] == "PENDING" {
                    "queued"
                } else {
                    "running"
                }
                .into();
                job.message = if job.status == "queued" {
                    "远程任务排队中"
                } else {
                    "远程正在生成视频"
                }
                .into();
                job.updated_at = now();
                save_job(state, job)?;
                tokio::time::sleep(Duration::from_secs(
                    if cfg!(debug_assertions)
                        && std::env::var_os("FRAME_STUDIO_TEST_WAN_URL").is_some()
                    {
                        1
                    } else {
                        15
                    },
                ))
                .await;
            }
            "SUCCEEDED" => {
                let url = output["video_url"]
                    .as_str()
                    .ok_or("视频任务已完成但未返回下载地址")?;
                job.status = "downloading".into();
                job.message = "远程视频已完成，正在保存片段".into();
                job.updated_at = now();
                save_job(state, job)?;
                let asset = download(state, &client, job, url).await?;
                job.asset_id = Some(asset.version_id);
                job.status = "succeeded".into();
                job.message = "视频片段已保存，请确认要使用的版本".into();
                return Ok(());
            }
            "FAILED" | "CANCELED" => {
                job.status = "failed".into();
                return Err(format!(
                    "远程视频任务失败：{}",
                    output["message"]
                        .as_str()
                        .unwrap_or("服务商没有提供详情")
                        .chars()
                        .take(200)
                        .collect::<String>()
                ));
            }
            "UNKNOWN" => {
                job.status = "unknown".into();
                return Err("远程任务状态未知或已过期；请核对服务商用量".into());
            }
            _ => return Err("远程视频任务状态无法识别；可继续查询原任务".into()),
        }
    }
}
fn valid_download_url(value: &str) -> AppResult<Url> {
    let url = Url::parse(value).map_err(|_| "视频下载地址无效")?;
    let trusted = url.scheme() == "https"
        && url
            .host_str()
            .is_some_and(|host| host.ends_with(".aliyuncs.com"));
    let fixture = cfg!(debug_assertions)
        && std::env::var_os("FRAME_STUDIO_TEST_DATA_DIR").is_some()
        && url.scheme() == "http"
        && matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "[::1]"));
    if !(trusted || fixture)
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return Err("视频下载地址不属于可信服务域名".into());
    }
    Ok(url)
}
async fn download(
    state: &WorkflowState,
    client: &Client,
    job: &VideoJob,
    value: &str,
) -> AppResult<VideoAsset> {
    let version_id = format!("{}-0", job.id);
    if let Ok(entry) = load_asset(state, &version_id) {
        if state
            .directory
            .join("assets")
            .join(&entry.file_name)
            .is_file()
        {
            return Ok(entry);
        }
    }
    let response = client
        .get(valid_download_url(value)?)
        .send()
        .await
        .map_err(|_| "视频下载中断；可继续查询原任务")?;
    if !response.status().is_success() {
        return Err(format!(
            "下载视频返回 HTTP {}；可继续查询原任务",
            response.status().as_u16()
        ));
    }
    if response
        .content_length()
        .is_some_and(|size| size > MAX_VIDEO_BYTES)
    {
        return Err("视频超过 256 MB 上限".into());
    }
    let directory = state.directory.join("assets");
    tokio::fs::create_dir_all(&directory)
        .await
        .map_err(|_| "无法创建素材目录")?;
    let file_name = format!("{version_id}.mp4");
    let temporary = directory.join(format!("{version_id}.partial"));
    let mut file = tokio::fs::File::create(&temporary)
        .await
        .map_err(|_| "无法创建视频临时文件")?;
    let mut response = response;
    let mut length = 0u64;
    let mut prefix = Vec::new();
    let result: AppResult<()> = async {
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| "视频下载中断；可继续查询原任务")?
        {
            length += chunk.len() as u64;
            if length > MAX_VIDEO_BYTES {
                return Err("视频超过 256 MB 上限".into());
            }
            if prefix.len() < 12 {
                prefix.extend_from_slice(&chunk[..chunk.len().min(12 - prefix.len())]);
            }
            file.write_all(&chunk).await.map_err(|_| "视频写入失败")?;
        }
        file.flush().await.map_err(|_| "视频写入失败")?;
        if length < 12 || &prefix[4..8] != b"ftyp" {
            return Err("服务未返回有效 MP4 视频".into());
        }
        Ok(())
    }
    .await;
    drop(file);
    if let Err(error) = result {
        let _ = tokio::fs::remove_file(&temporary).await;
        return Err(error);
    }
    tokio::fs::rename(&temporary, directory.join(&file_name))
        .await
        .map_err(|_| "无法保存视频原件")?;
    let entry = VideoAsset {
        asset_id: format!(
            "{}:{}:{}",
            job.request.context.workflow_id,
            job.request.context.node_id,
            job.request.context.shot_id
        ),
        version_id,
        context: job.request.context.clone(),
        first_frame_version_id: job.request.first_frame_version_id.clone(),
        job_id: job.id.clone(),
        duration: job.request.duration,
        resolution: job.request.resolution.clone(),
        bytes: length,
        created_at: now(),
        file_name,
    };
    save_asset(state, &entry)?;
    Ok(entry)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn restart_only_resumes_jobs_with_remote_ids() {
        let directory = std::env::temp_dir().join(format!("frame-video-test-{}", uid()));
        std::fs::create_dir(&directory).unwrap();
        let state = WorkflowState {
            store: crate::workflow::storage::Store::open(&directory.join("test.sqlite")).unwrap(),
            active: std::sync::Mutex::new(None),
            media_active: std::sync::Mutex::new(None),
            video_active: std::sync::Mutex::new(std::collections::HashMap::new()),
            export_active: std::sync::Mutex::new(None),
            model_pull: std::sync::Mutex::new(None),
            directory: directory.clone(),
        };
        let request = VideoRequest {
            context: ShotContext {
                workflow_id: "w".into(),
                node_id: "n".into(),
                artifact_id: "v".into(),
                shot_id: "s".into(),
            },
            first_frame_version_id: "frame".into(),
            region: "singapore".into(),
            prompt: "cat moves".into(),
            negative_prompt: String::new(),
            duration: 5,
            resolution: "720P".into(),
        };
        let known = VideoJob {
            id: "known".into(),
            request: request.clone(),
            task_id: Some("remote-id".into()),
            status: "running".into(),
            message: String::new(),
            created_at: now(),
            updated_at: now(),
            asset_id: None,
        };
        let uncertain = VideoJob {
            id: "uncertain".into(),
            request,
            task_id: None,
            status: "submitting".into(),
            message: String::new(),
            created_at: now(),
            updated_at: now(),
            asset_id: None,
        };
        // Reservation must exclude the same shot even before its row is saved.
        reserve(&state, &known).unwrap();
        assert!(reserve(&state, &uncertain).is_err());
        state.video_active.lock().unwrap().clear();
        save_job(&state, &known).unwrap();
        save_job(&state, &uncertain).unwrap();
        recover(&state).unwrap();
        assert_eq!(load_job(&state, "known").unwrap().status, "paused");
        assert_eq!(load_job(&state, "uncertain").unwrap().status, "unknown");
        drop(state);
        std::fs::remove_dir_all(directory).unwrap();
    }
}
