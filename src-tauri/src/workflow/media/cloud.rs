//! OpenAI Images API adapter. Cloud requests have no resumable task ID, so an
//! uncertain response is recorded and never submitted again automatically.
use super::*;
use crate::workflow::ActiveRun;
use reqwest::{Client, Url};
use serde_json::{json, Value};
use std::{
    sync::{atomic::AtomicBool, Arc},
    time::Duration,
};
use tauri::Manager;

const API_URL: &str = "https://api.openai.com/v1/images/generations";
const RESPONSE_LIMIT: usize = 32 * 1024 * 1024;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CloudImageRequest {
    pub context: ShotContext,
    pub model: String,
    pub positive: String,
    pub negative: String,
    pub size: String,
    pub quality: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudImageJob {
    pub id: String,
    pub request: CloudImageRequest,
    pub status: String,
    pub message: String,
    pub created_at: u64,
    pub updated_at: u64,
    pub asset_ids: Vec<String>,
}

fn validate(request: &CloudImageRequest) -> AppResult<()> {
    if ![
        "gpt-image-2",
        "gpt-image-2.5-flare",
        "gpt-image-2.5-sunburst",
    ]
    .contains(&request.model.as_str())
        || !["1024x1024", "1024x1536", "1536x1024"].contains(&request.size.as_str())
        || !["low", "medium", "high"].contains(&request.quality.as_str())
        || request.positive.trim().is_empty()
        || request.positive.len() > 16_000
        || request.negative.len() > 4_000
    {
        return Err("请检查云端模型、提示词、画幅和画质".into());
    }
    Ok(())
}

fn key_entry() -> AppResult<keyring::Entry> {
    let service =
        if cfg!(debug_assertions) && std::env::var_os("FRAME_STUDIO_TEST_DATA_DIR").is_some() {
            "com.frame-studio.desktop.images.test"
        } else {
            "com.frame-studio.desktop.images"
        };
    keyring::Entry::new(service, "openai").map_err(|_| "无法访问系统凭据库".into())
}

fn get_key() -> AppResult<Option<String>> {
    match key_entry()?.get_password() {
        Ok(key) => Ok(Some(key)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Err("无法读取云端图片 API Key".into()),
    }
}

#[tauri::command]
pub fn cloud_image_key_status() -> AppResult<bool> {
    Ok(get_key()?.is_some())
}

#[tauri::command]
pub fn save_cloud_image_key(api_key: String) -> AppResult<()> {
    if api_key.trim().is_empty() || api_key.len() > 4096 || api_key.contains(['\r', '\n']) {
        return Err("API Key 无效".into());
    }
    key_entry()?
        .set_password(api_key.trim())
        .map_err(|_| "系统凭据库保存失败，密钥未写入项目文件".into())
}

#[tauri::command]
pub fn clear_cloud_image_key() -> AppResult<()> {
    match key_entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(_) => Err("系统凭据库删除失败".into()),
    }
}

fn save(state: &WorkflowState, job: &CloudImageJob) -> AppResult<()> {
    state.store.db()?.execute(
        "INSERT INTO cloud_image_jobs VALUES (?1,?2,?3,?4) ON CONFLICT(id) DO UPDATE SET json=excluded.json",
        params![job.id, job.request.context.workflow_id, serde_json::to_string(job).map_err(|e| e.to_string())?, job.created_at],
    ).map_err(|e| e.to_string())?;
    Ok(())
}

pub fn recover(state: &WorkflowState) -> AppResult<()> {
    let jobs: Vec<CloudImageJob> = {
        let db = state.store.db()?;
        let mut query = db
            .prepare("SELECT json FROM cloud_image_jobs")
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
        if matches!(job.status.as_str(), "submitting" | "saving") {
            let candidate_id = format!("{}-0", job.id);
            let saved = asset(state, &candidate_id)
                .map(|entry| {
                    state
                        .directory
                        .join("assets")
                        .join(entry.file_name)
                        .is_file()
                })
                .unwrap_or(false);
            if saved {
                job.asset_ids = vec![candidate_id];
                job.status = "succeeded".into();
                job.message = "已找回保存到本地的云端候选图".into();
            } else {
                job.status = "unknown".into();
                job.message =
                    "应用退出，无法确认云端结果；请核对服务商用量，再决定是否重新生成".into();
            }
            job.updated_at = now();
            save(state, &job)?;
        }
    }
    Ok(())
}

#[tauri::command]
pub fn list_cloud_image_jobs(
    state: tauri::State<WorkflowState>,
    workflow_id: String,
) -> AppResult<Vec<CloudImageJob>> {
    let db = state.store.db()?;
    let mut query = db.prepare(
        "SELECT json FROM cloud_image_jobs WHERE workflow_id=?1 ORDER BY created_at DESC LIMIT 100",
    ).map_err(|e| e.to_string())?;
    let rows = query
        .query_map([workflow_id], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    rows.map(|r| serde_json::from_str(&r.map_err(|e| e.to_string())?).map_err(|e| e.to_string()))
        .collect()
}

#[tauri::command]
pub fn start_cloud_image_job(
    app: tauri::AppHandle,
    state: tauri::State<WorkflowState>,
    request: CloudImageRequest,
) -> AppResult<CloudImageJob> {
    validate(&request)?;
    validate_context(&state, &request.context)?;
    let key = get_key()?.ok_or("请先保存 OpenAI 图片 API Key")?;
    let mut active = state.media_active.lock().map_err(|_| "图片任务锁不可用")?;
    if active.is_some() {
        return Err("已有图片任务正在执行，请等待完成".into());
    }
    let job = CloudImageJob {
        id: uid(),
        request,
        status: "submitting".into(),
        message: "正在提交云端图片请求".into(),
        created_at: now(),
        updated_at: now(),
        asset_ids: vec![],
    };
    save(&state, &job)?;
    *active = Some(ActiveRun {
        id: job.id.clone(),
        cancel: Arc::new(AtomicBool::new(false)),
    });
    let response_job = job.clone();
    tauri::async_runtime::spawn(async move {
        let state = app.state::<WorkflowState>();
        let mut job = job;
        if let Err(error) = execute(&app, &state, &mut job, &key).await {
            if job.status != "failed" {
                job.status = "unknown".into();
            }
            job.message = error;
        }
        job.updated_at = now();
        if save(&state, &job).is_err() {
            eprintln!("Could not persist final cloud image job state");
        }
        if let Ok(mut active) = state.media_active.lock() {
            *active = None;
        };
    });
    Ok(response_job)
}

fn request_body(request: &CloudImageRequest) -> Value {
    let prompt = if request.negative.trim().is_empty() {
        request.positive.clone()
    } else {
        format!(
            "{}\n\nAvoid these visual elements: {}",
            request.positive, request.negative
        )
    };
    json!({
        "model": request.model,
        "prompt": prompt,
        "n": 1,
        "size": request.size,
        "quality": request.quality,
        "output_format": "png"
    })
}

fn endpoint() -> AppResult<Url> {
    if cfg!(debug_assertions) && std::env::var_os("FRAME_STUDIO_TEST_DATA_DIR").is_some() {
        if let Ok(override_url) = std::env::var("FRAME_STUDIO_TEST_OPENAI_IMAGE_URL") {
            let url = Url::parse(&override_url).map_err(|_| "测试图片接口地址无效")?;
            if url.scheme() == "http"
                && matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "[::1]"))
                && url.path() == "/v1/images/generations"
                && url.username().is_empty()
                && url.password().is_none()
                && url.query().is_none()
                && url.fragment().is_none()
            {
                return Ok(url);
            }
            return Err("测试图片接口仅允许本机固定路径".into());
        }
    }
    Url::parse(API_URL).map_err(|_| "云端图片接口地址无效".into())
}

async fn response_bytes(mut response: reqwest::Response) -> AppResult<Vec<u8>> {
    if response
        .content_length()
        .is_some_and(|n| n > RESPONSE_LIMIT as u64)
    {
        return Err("云端图片响应超过大小限制；请核对服务商用量".into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "云端图片响应中断；请核对服务商用量")?
    {
        if bytes.len() + chunk.len() > RESPONSE_LIMIT {
            return Err("云端图片响应超过大小限制；请核对服务商用量".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

async fn execute(
    app: &tauri::AppHandle,
    state: &WorkflowState,
    job: &mut CloudImageJob,
    key: &str,
) -> AppResult<()> {
    let client = Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(300))
        .build()
        .map_err(|_| "无法初始化云端图片连接")?;
    let response = client
        .post(endpoint()?)
        .bearer_auth(key)
        .json(&request_body(&job.request))
        .send()
        .await
        .map_err(|_| "提交结果未知；请核对服务商用量，避免重复计费")?;
    if !response.status().is_success() {
        let status = response.status().as_u16();
        if response.status().is_client_error() || response.status().is_redirection() {
            job.status = "failed".into();
        }
        return Err(match status {
            401 | 403 => "认证失败，请检查 API Key 与模型权限".into(),
            429 => "服务限流或额度不足；请求未生成图片".into(),
            300..=399 => "服务重定向，图片请求没有继续发送".into(),
            _ => format!("图片服务返回 HTTP {status}；请核对服务商用量"),
        });
    }
    let data: Value = serde_json::from_slice(&response_bytes(response).await?)
        .map_err(|_| "图片响应格式无效；请核对服务商用量")?;
    let encoded = data
        .pointer("/data/0/b64_json")
        .and_then(Value::as_str)
        .ok_or("服务未返回图片数据；请核对服务商用量")?;
    let bytes = STANDARD
        .decode(encoded)
        .map_err(|_| "图片编码无效；请核对服务商用量")?;
    if bytes.len() > MAX_IMAGE_BYTES {
        return Err("返回的图片超过 20 MB 限制；请核对服务商用量".into());
    }
    job.status = "saving".into();
    job.message = "云端图片已返回，正在保存到本地素材库".into();
    save(state, job)?;
    let id = format!("{}-0", job.id);
    let entry = ImageAsset {
        asset_id: format!(
            "{}:{}:{}",
            job.request.context.workflow_id,
            job.request.context.node_id,
            job.request.context.shot_id
        ),
        version_id: id.clone(),
        name: format!("{} · 云端候选", job.request.context.shot_id),
        width: 0,
        height: 0,
        bytes: 0,
        created_at: now(),
        source: "openai".into(),
        context: Some(job.request.context.clone()),
        job_id: Some(job.id.clone()),
        file_name: String::new(),
    };
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        store_image(&handle.state::<WorkflowState>(), &bytes, entry)
    })
    .await
    .map_err(|_| "云端图片保存任务失败")??;
    job.asset_ids.push(id);
    job.status = "succeeded".into();
    job.message = "图片已保存，请确认是否选为镜头首帧".into();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn request_uses_supported_fields_without_key() {
        let request = CloudImageRequest {
            context: ShotContext {
                workflow_id: "w".into(),
                node_id: "n".into(),
                artifact_id: "v".into(),
                shot_id: "s".into(),
            },
            model: "gpt-image-2".into(),
            positive: "a cat".into(),
            negative: "blur".into(),
            size: "1024x1024".into(),
            quality: "low".into(),
        };
        assert!(validate(&request).is_ok());
        let body = request_body(&request);
        assert_eq!(body["n"], 1);
        assert_eq!(body["prompt"], "a cat\n\nAvoid these visual elements: blur");
        assert!(body.get("api_key").is_none());
    }
}
