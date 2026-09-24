//! Local ComfyUI adapter. Resume only polls an existing prompt; never resubmits it.
use super::*;
use crate::workflow::ActiveRun;
use reqwest::{Client, Url};
use serde_json::{json, Value};
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};
use tauri::Manager;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImageRequest {
    pub context: ShotContext,
    pub base_url: String,
    pub checkpoint: String,
    pub positive: String,
    pub negative: String,
    pub width: u32,
    pub height: u32,
    pub steps: u32,
    pub seed: u64,
    pub count: u32,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageJob {
    pub id: String,
    pub request: ImageRequest,
    pub prompt_id: Option<String>,
    pub status: String,
    pub message: String,
    pub created_at: u64,
    pub updated_at: u64,
    pub asset_ids: Vec<String>,
}

fn endpoint(base: &str, path: &str) -> AppResult<Url> {
    let mut url = Url::parse(base.trim()).map_err(|_| "ComfyUI 地址无效")?;
    // This first adapter is explicitly for local ComfyUI. It never sends API keys.
    if !matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "[::1]"))
        || !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.path() != "/"
    {
        return Err("请填写本机 ComfyUI 根地址，例如 http://127.0.0.1:8188".into());
    }
    url.set_path(path);
    Ok(url)
}
fn client() -> AppResult<Client> {
    Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|_| "无法初始化连接".into())
}
async fn limited(mut response: reqwest::Response, cap: usize) -> AppResult<Vec<u8>> {
    if !response.status().is_success() {
        return Err(format!(
            "ComfyUI 返回 HTTP {}，请检查服务端日志",
            response.status().as_u16()
        ));
    }
    if response.content_length().is_some_and(|n| n > cap as u64) {
        return Err("服务端响应超过大小限制".into());
    }
    let mut data = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "读取 ComfyUI 响应失败")?
    {
        if data.len() + chunk.len() > cap {
            return Err("服务端响应超过大小限制".into());
        }
        data.extend_from_slice(&chunk);
    }
    Ok(data)
}
async fn get_json(client: &Client, url: Url) -> AppResult<Value> {
    let response = client
        .get(url)
        .send()
        .await
        .map_err(|_| "无法连接 ComfyUI，请确认服务已启动")?;
    serde_json::from_slice(&limited(response, 4_000_000).await?)
        .map_err(|_| "ComfyUI 响应格式无效".into())
}
fn validate(request: &ImageRequest) -> AppResult<()> {
    endpoint(&request.base_url, "/")?;
    if request.checkpoint.trim().is_empty()
        || request.checkpoint.len() > 500
        || request.positive.trim().is_empty()
        || request.positive.len() > 16_000
        || request.negative.len() > 16_000
        || !(256..=2048).contains(&request.width)
        || !(256..=2048).contains(&request.height)
        || request.width % 64 != 0
        || request.height % 64 != 0
        || !(1..=60).contains(&request.steps)
        || !(1..=4).contains(&request.count)
        || request.seed > 9_007_199_254_740_991
    {
        return Err(
            "请检查模型、提示词、尺寸（256–2048，64 的倍数）、步数（1–60）与候选数（1–4）".into(),
        );
    }
    Ok(())
}
fn graph(r: &ImageRequest, id: &str) -> Value {
    json!({
        "3":{"class_type":"KSampler","inputs":{"cfg":7,"denoise":1,"latent_image":["5",0],"model":["4",0],"negative":["7",0],"positive":["6",0],"sampler_name":"euler","scheduler":"normal","seed":r.seed,"steps":r.steps}},
        "4":{"class_type":"CheckpointLoaderSimple","inputs":{"ckpt_name":r.checkpoint}},
        "5":{"class_type":"EmptyLatentImage","inputs":{"batch_size":r.count,"height":r.height,"width":r.width}},
        "6":{"class_type":"CLIPTextEncode","inputs":{"clip":["4",1],"text":r.positive}},
        "7":{"class_type":"CLIPTextEncode","inputs":{"clip":["4",1],"text":r.negative}},
        "8":{"class_type":"VAEDecode","inputs":{"samples":["3",0],"vae":["4",2]}},
        "9":{"class_type":"SaveImage","inputs":{"filename_prefix":format!("FrameStudio/{id}"),"images":["8",0]}}
    })
}
fn save(state: &WorkflowState, job: &ImageJob) -> AppResult<()> {
    state.store.db()?.execute("INSERT INTO image_jobs VALUES (?1,?2,?3,?4) ON CONFLICT(id) DO UPDATE SET json=excluded.json", params![job.id,job.request.context.workflow_id,serde_json::to_string(job).map_err(|e|e.to_string())?,job.created_at]).map_err(|e|e.to_string())?;
    Ok(())
}
fn load(state: &WorkflowState, id: &str) -> AppResult<ImageJob> {
    let json: String = state
        .store
        .db()?
        .query_row("SELECT json FROM image_jobs WHERE id=?1", [id], |r| {
            r.get(0)
        })
        .map_err(|_| "图片任务不存在")?;
    serde_json::from_str(&json).map_err(|e| e.to_string())
}
pub fn recover(state: &WorkflowState) -> AppResult<()> {
    let jobs: Vec<ImageJob> = {
        let db = state.store.db()?;
        let mut query = db
            .prepare("SELECT json FROM image_jobs")
            .map_err(|e| e.to_string())?;
        let rows = query
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        rows.map(|r| {
            serde_json::from_str(&r.map_err(|e| e.to_string())?).map_err(|e| e.to_string())
        })
        .collect::<AppResult<_>>()?
    };
    for mut job in jobs {
        if matches!(
            job.status.as_str(),
            "submitting" | "waiting" | "downloading"
        ) {
            job.status = if job.prompt_id.is_some() {
                "paused"
            } else {
                "unknown"
            }
            .into();
            job.message = if job.prompt_id.is_some() {
                "应用曾退出；可查询原任务结果，不会重新提交"
            } else {
                "提交时应用退出，无法确认服务端是否接受；请检查 ComfyUI 队列"
            }
            .into();
            job.updated_at = now();
            save(state, &job)?;
        }
    }
    Ok(())
}
#[tauri::command]
pub async fn test_comfy(base_url: String) -> AppResult<Vec<String>> {
    let data = get_json(
        &client()?,
        endpoint(&base_url, "/object_info/CheckpointLoaderSimple")?,
    )
    .await?;
    let names = data
        .pointer("/CheckpointLoaderSimple/input/required/ckpt_name/0")
        .and_then(Value::as_array)
        .ok_or("服务未提供标准 CheckpointLoaderSimple 节点")?;
    Ok(names
        .iter()
        .filter_map(|v| v.as_str().map(str::to_owned))
        .collect())
}
#[tauri::command]
pub fn image_settings(state: tauri::State<WorkflowState>) -> AppResult<Option<ImageRequest>> {
    setting(&state)?
        .map(|s| serde_json::from_str(&s).map_err(|e| e.to_string()))
        .transpose()
}
#[tauri::command]
pub fn list_image_jobs(
    state: tauri::State<WorkflowState>,
    workflow_id: String,
) -> AppResult<Vec<ImageJob>> {
    let db = state.store.db()?;
    let mut query = db
        .prepare(
            "SELECT json FROM image_jobs WHERE workflow_id=?1 ORDER BY created_at DESC LIMIT 100",
        )
        .map_err(|e| e.to_string())?;
    let rows = query
        .query_map([workflow_id], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    rows.map(|r| serde_json::from_str(&r.map_err(|e| e.to_string())?).map_err(|e| e.to_string()))
        .collect()
}
#[tauri::command]
pub fn start_image_job(
    app: tauri::AppHandle,
    state: tauri::State<WorkflowState>,
    request: ImageRequest,
) -> AppResult<ImageJob> {
    validate(&request)?;
    validate_context(&state, &request.context)?;
    let mut active = state.media_active.lock().map_err(|_| "图片任务锁不可用")?;
    if active.is_some() {
        return Err("已有图片任务正在执行，请等待或停止等待".into());
    }
    let job = ImageJob {
        id: uid(),
        request,
        prompt_id: None,
        status: "submitting".into(),
        message: "正在提交到本机 ComfyUI".into(),
        created_at: now(),
        updated_at: now(),
        asset_ids: vec![],
    };
    save(&state, &job)?;
    state.store.db()?.execute("INSERT INTO media_settings VALUES ('comfy',?1) ON CONFLICT(id) DO UPDATE SET json=excluded.json", [serde_json::to_string(&job.request).map_err(|e|e.to_string())?]).map_err(|e|e.to_string())?;
    let cancel = Arc::new(AtomicBool::new(false));
    *active = Some(ActiveRun {
        id: job.id.clone(),
        cancel: cancel.clone(),
    });
    launch(app, job.clone(), cancel, true);
    Ok(job)
}
#[tauri::command]
pub fn resume_image_job(
    app: tauri::AppHandle,
    state: tauri::State<WorkflowState>,
    id: String,
) -> AppResult<()> {
    let mut active = state.media_active.lock().map_err(|_| "图片任务锁不可用")?;
    if active.is_some() {
        return Err("已有图片任务正在执行".into());
    }
    let mut job = load(&state, &id)?;
    if job.prompt_id.is_none() || job.status != "paused" {
        return Err("此任务不能恢复查询".into());
    }
    job.status = "waiting".into();
    job.message = "正在查询原任务".into();
    save(&state, &job)?;
    let cancel = Arc::new(AtomicBool::new(false));
    *active = Some(ActiveRun {
        id,
        cancel: cancel.clone(),
    });
    launch(app, job, cancel, false);
    Ok(())
}
#[tauri::command]
pub fn pause_image_job(state: tauri::State<WorkflowState>, id: String) -> AppResult<()> {
    let active = state.media_active.lock().map_err(|_| "图片任务锁不可用")?;
    if let Some(run) = active.as_ref().filter(|a| a.id == id) {
        run.cancel.store(true, Ordering::SeqCst);
        Ok(())
    } else {
        Err("图片任务已经结束".into())
    }
}
fn launch(app: tauri::AppHandle, mut job: ImageJob, cancel: Arc<AtomicBool>, submit: bool) {
    tauri::async_runtime::spawn(async move {
        let state = app.state::<WorkflowState>();
        if let Err(error) = execute(&app, &state, &mut job, cancel, submit).await {
            if job.status != "failed" {
                job.status = if job.prompt_id.is_some() {
                    "paused"
                } else {
                    "unknown"
                }
                .into();
            }
            job.message = error;
        }
        job.updated_at = now();
        if save(&state, &job).is_err() {
            eprintln!("Could not persist final image job state");
        }
        if let Ok(mut active) = state.media_active.lock() {
            *active = None;
        };
    });
}
async fn execute(
    app: &tauri::AppHandle,
    state: &WorkflowState,
    job: &mut ImageJob,
    cancel: Arc<AtomicBool>,
    submit: bool,
) -> AppResult<()> {
    let client = client()?;
    if submit {
        // Persisted before POST. A lost response becomes unknown, never an automatic retry.
        let response = client
            .post(endpoint(&job.request.base_url, "/prompt")?)
            .json(&json!({"prompt":graph(&job.request,&job.id),"client_id":job.id}))
            .send()
            .await
            .map_err(|_| "提交响应未收到，结果未知；请检查 ComfyUI 队列，避免重复生成")?;
        if response.status().is_client_error() {
            job.status = "failed".into();
        }
        let body: Value = serde_json::from_slice(&limited(response, 4_000_000).await?)
            .map_err(|_| "提交响应无效，结果未知，请检查 ComfyUI 队列")?;
        let prompt = body["prompt_id"]
            .as_str()
            .filter(|id| {
                !id.is_empty()
                    && id.len() <= 128
                    && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
            })
            .ok_or("缺少有效任务 ID，结果未知，请检查 ComfyUI 队列")?;
        job.prompt_id = Some(prompt.into());
        job.status = "waiting".into();
        job.message = "已提交，等待 ComfyUI 完成".into();
        job.updated_at = now();
        save(state, job)?;
    }
    let prompt = job.prompt_id.clone().ok_or("缺少任务 ID")?;
    let deadline = std::time::Instant::now() + Duration::from_secs(1800);
    loop {
        if cancel.load(Ordering::SeqCst) || std::time::Instant::now() >= deadline {
            job.status = "paused".into();
            job.message = "已停止等待，服务端可能继续生成；可查询原任务结果".into();
            return Ok(());
        }
        let history = get_json(
            &client,
            endpoint(&job.request.base_url, &format!("/history/{prompt}"))?,
        )
        .await?;
        if let Some(result) = history.get(&prompt) {
            if result.pointer("/status/status_str").and_then(Value::as_str) == Some("error") {
                job.status = "failed".into();
                return Err(
                    "ComfyUI 执行失败，请查看服务端日志（模型兼容性、显存或节点错误）".into(),
                );
            }
            if result.pointer("/status/completed").and_then(Value::as_bool) == Some(true) {
                let outputs = result
                    .pointer("/outputs/9/images")
                    .and_then(Value::as_array)
                    .ok_or("任务完成但没有图片输出")?;
                if outputs.is_empty() || outputs.len() != job.request.count as usize {
                    return Err("图片数量与请求不一致，请检查 ComfyUI 输出".into());
                }
                job.status = "downloading".into();
                job.message = "正在将候选图保存到本机素材库".into();
                save(state, job)?;
                for (index, output) in outputs.iter().enumerate() {
                    let id = format!("{}-{index}", job.id);
                    if !job.asset_ids.contains(&id) {
                        let filename = output["filename"].as_str().ok_or("输出文件名无效")?;
                        let subfolder = output["subfolder"].as_str().unwrap_or("");
                        if output["type"].as_str() != Some("output") {
                            return Err("服务端输出不是持久化图片".into());
                        }
                        let mut url = endpoint(&job.request.base_url, "/view")?;
                        url.query_pairs_mut()
                            .append_pair("filename", filename)
                            .append_pair("subfolder", subfolder)
                            .append_pair("type", "output");
                        let bytes = limited(
                            client
                                .get(url)
                                .send()
                                .await
                                .map_err(|_| "图片下载失败，可继续查询原任务")?,
                            MAX_IMAGE_BYTES,
                        )
                        .await?;
                        let entry = ImageAsset {
                            asset_id: format!(
                                "{}:{}:{}",
                                job.request.context.workflow_id,
                                job.request.context.node_id,
                                job.request.context.shot_id
                            ),
                            version_id: id.clone(),
                            name: format!("{} · 候选 {}", job.request.context.shot_id, index + 1),
                            width: 0,
                            height: 0,
                            bytes: 0,
                            created_at: now(),
                            source: "comfyui".into(),
                            context: Some(job.request.context.clone()),
                            job_id: Some(job.id.clone()),
                            file_name: String::new(),
                        };
                        let handle = app.clone();
                        tauri::async_runtime::spawn_blocking(move || {
                            store_image(&handle.state::<WorkflowState>(), &bytes, entry)
                        })
                        .await
                        .map_err(|_| "图片保存任务失败")??;
                        job.asset_ids.push(id);
                        save(state, job)?;
                    }
                }
                job.status = "succeeded".into();
                job.message = "候选图已保存，请选择一张作为镜头首帧".into();
                return Ok(());
            }
        }
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn restart_recovers_pollable_jobs_without_resubmission() {
        let directory = std::env::temp_dir().join(format!("frame-media-test-{}", uid()));
        std::fs::create_dir(&directory).unwrap();
        let state = WorkflowState {
            store: crate::workflow::storage::Store::open(&directory.join("test.sqlite")).unwrap(),
            active: std::sync::Mutex::new(None),
            media_active: std::sync::Mutex::new(None),
            video_active: std::sync::Mutex::new(std::collections::HashMap::new()),
            export_active: std::sync::Mutex::new(None),
            directory: directory.clone(),
        };
        let request = ImageRequest {
            context: ShotContext {
                workflow_id: "w".into(),
                node_id: "n".into(),
                artifact_id: "v".into(),
                shot_id: "s".into(),
            },
            base_url: "http://127.0.0.1:8188".into(),
            checkpoint: "model".into(),
            positive: "cat".into(),
            negative: String::new(),
            width: 512,
            height: 512,
            steps: 20,
            seed: 1,
            count: 1,
        };
        let mut job = ImageJob {
            id: "known".into(),
            request,
            prompt_id: Some("server-id".into()),
            status: "downloading".into(),
            message: String::new(),
            created_at: now(),
            updated_at: now(),
            asset_ids: vec!["existing-version".into()],
        };
        save(&state, &job).unwrap();
        job.id = "uncertain".into();
        job.prompt_id = None;
        job.status = "submitting".into();
        save(&state, &job).unwrap();
        recover(&state).unwrap();
        let known = load(&state, "known").unwrap();
        assert_eq!(known.status, "paused");
        assert_eq!(known.prompt_id.as_deref(), Some("server-id"));
        assert_eq!(known.asset_ids, vec!["existing-version"]);
        assert_eq!(load(&state, "uncertain").unwrap().status, "unknown");
        drop(state);
        std::fs::remove_file(directory.join("test.sqlite")).unwrap();
        // SQLite may leave WAL sidecars; only remove this uniquely created test directory.
        for name in ["test.sqlite-wal", "test.sqlite-shm"] {
            let _ = std::fs::remove_file(directory.join(name));
        }
        std::fs::remove_dir(directory).unwrap();
    }
    #[test]
    fn endpoint_is_local_and_has_no_credentials() {
        assert!(endpoint("http://127.0.0.1:8188", "/prompt").is_ok());
        for base in [
            "http://example.com",
            "http://localhost.evil.com",
            "http://user:secret@localhost:8188",
            "http://127.0.0.1:8188/api",
            "http://127.0.0.1:8188?token=x",
        ] {
            assert!(endpoint(base, "/prompt").is_err());
        }
    }
}
