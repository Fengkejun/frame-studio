//! Non-streamed OpenAI-compatible speech. An uncertain submission is never retried.
use super::budget::{reserve_job, BillableJob};
use super::composition::{audio, store_audio, MAX_AUDIO_BYTES};
use super::connection::{check_catalog, ConnectionCheck};
use super::*;
use reqwest::Client;
use serde_json::json;
use std::time::Duration;
use tauri::Manager;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SpeechRequest {
    pub workflow_id: String,
    pub base_url: String,
    pub model: String,
    pub input: String,
    pub voice: String,
    pub speed: f64,
    pub budget_reservation_micro_usd: u64,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeechJob {
    pub id: String,
    pub request: SpeechRequest,
    pub status: String,
    pub message: String,
    pub created_at: u64,
    pub updated_at: u64,
    pub asset_id: Option<String>,
    pub estimated_cost_micro_usd: u64,
}

fn validate(request: &SpeechRequest) -> AppResult<()> {
    cloud::api_base(&request.base_url)?;
    if request.workflow_id.is_empty()
        || request.workflow_id.len() > 128
        || request.model.trim().is_empty()
        || request.model.len() > 128
        || request.model.chars().any(char::is_control)
        || request.input.trim().is_empty()
        || request.input.chars().count() > 4096
        || ![
            "alloy", "ash", "ballad", "coral", "echo", "sage", "shimmer", "verse", "marin", "cedar",
        ]
        .contains(&request.voice.as_str())
        || !request.speed.is_finite()
        || !(0.25..=4.0).contains(&request.speed)
    {
        return Err("请检查配音模型、音色、语速和旁白（最多 4096 字）".into());
    }
    if !(1_000..=1_000_000_000).contains(&request.budget_reservation_micro_usd) {
        return Err("本次配音预算预留金额须在 0.001–1000 美元之间".into());
    }
    Ok(())
}

fn key_entry(base_url: &str) -> AppResult<keyring::Entry> {
    let canonical = cloud::api_base(base_url)?.to_string();
    let service =
        if cfg!(debug_assertions) && std::env::var_os("FRAME_STUDIO_TEST_DATA_DIR").is_some() {
            "com.frame-studio.desktop.speech.test"
        } else {
            "com.frame-studio.desktop.speech"
        };
    keyring::Entry::new(service, canonical.trim_end_matches('/'))
        .map_err(|_| "访问系统凭据库失败".into())
}

fn get_key(base_url: &str) -> AppResult<Option<String>> {
    match key_entry(base_url)?.get_password() {
        Ok(key) => Ok(Some(key)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Err("读取配音服务密钥失败".into()),
    }
}

#[tauri::command]
pub fn speech_key_status(base_url: String) -> AppResult<bool> {
    Ok(get_key(&base_url)?.is_some())
}

#[tauri::command]
pub fn save_speech_key(base_url: String, api_key: String) -> AppResult<()> {
    if api_key.trim().is_empty() || api_key.len() > 4096 || api_key.contains(['\r', '\n']) {
        return Err("API Key 无效".into());
    }
    key_entry(&base_url)?
        .set_password(api_key.trim())
        .map_err(|_| "系统凭据库保存失败".into())
}

#[tauri::command]
pub fn clear_speech_key(base_url: String) -> AppResult<()> {
    match key_entry(&base_url)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(_) => Err("系统凭据库删除失败".into()),
    }
}

#[tauri::command]
pub async fn check_speech_connection(
    base_url: String,
    model: String,
) -> AppResult<ConnectionCheck> {
    if model.trim().is_empty() || model.len() > 128 {
        return Err("请填写配音模型 ID".into());
    }
    let key = get_key(&base_url)?.ok_or("请先保存当前配音服务的 API Key")?;
    check_catalog(
        cloud::endpoint(&base_url, "models")?,
        &key,
        &model,
        "openai",
    )
    .await
}

fn save(state: &WorkflowState, job: &SpeechJob) -> AppResult<()> {
    state.store.db()?.execute(
        "INSERT INTO speech_jobs VALUES (?1,?2,?3,?4) ON CONFLICT(id) DO UPDATE SET json=excluded.json",
        params![job.id, job.request.workflow_id, serde_json::to_string(job).map_err(|e|e.to_string())?, job.created_at],
    ).map_err(|e|e.to_string())?;
    Ok(())
}

fn jobs(state: &WorkflowState, workflow_id: Option<&str>) -> AppResult<Vec<SpeechJob>> {
    let db = state.store.db()?;
    let mut query = db.prepare(
        "SELECT json FROM speech_jobs WHERE (?1 IS NOT NULL AND workflow_id=?1) OR (?1 IS NULL AND json_extract(json,'$.status') IN ('submitting','saving')) ORDER BY created_at DESC, rowid DESC LIMIT ?2",
    ).map_err(|e|e.to_string())?;
    let rows = query
        .query_map(
            params![
                workflow_id,
                if workflow_id.is_some() { 100_i64 } else { -1 }
            ],
            |row| row.get::<_, String>(0),
        )
        .map_err(|e| e.to_string())?;
    rows.map(|row| {
        serde_json::from_str(&row.map_err(|e| e.to_string())?).map_err(|e| e.to_string())
    })
    .collect()
}

#[tauri::command]
pub fn list_speech_jobs(
    state: tauri::State<WorkflowState>,
    workflow_id: String,
) -> AppResult<Vec<SpeechJob>> {
    let mut result = jobs(&state, Some(&workflow_id))?;
    result.truncate(100);
    Ok(result)
}

pub fn recover(state: &WorkflowState) -> AppResult<()> {
    for mut job in jobs(state, None)? {
        if matches!(job.status.as_str(), "submitting" | "saving") {
            let saved = audio(state, &job.id).is_ok_and(|asset| {
                asset.workflow_id == job.request.workflow_id
                    && state
                        .directory
                        .join("assets")
                        .join(asset.file_name)
                        .is_file()
            });
            if saved {
                job.status = "succeeded".into();
                job.asset_id = Some(job.id.clone());
                job.message = "已找回保存到本地的配音版本".into();
            } else {
                job.status = "unknown".into();
                job.message = "应用退出，配音结果待核实；请核对服务商用量后再手动生成".into();
            }
            job.updated_at = now();
            save(state, &job)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request() -> SpeechRequest {
        SpeechRequest {
            workflow_id: "project".into(),
            base_url: "http://127.0.0.1:8188/v1".into(),
            model: "gpt-4o-mini-tts".into(),
            input: "你好，镜头开始。".into(),
            voice: "coral".into(),
            speed: 1.0,
            budget_reservation_micro_usd: 50_000,
        }
    }

    #[test]
    fn rejects_invalid_speech_before_submission() {
        let mut value = request();
        assert!(validate(&value).is_ok());
        value.input = "字".repeat(4096);
        assert!(validate(&value).is_ok());
        value.input.push('字');
        assert!(validate(&value).is_err());
        value = request();
        value.speed = f64::NAN;
        assert!(validate(&value).is_err());
        value = request();
        value.base_url = "http://remote.example/v1".into();
        assert!(validate(&value).is_err());
        value = request();
        value.budget_reservation_micro_usd = 0;
        assert!(validate(&value).is_err());
    }

    #[test]
    fn restart_recovers_saved_audio_and_marks_uncertain_jobs_without_resubmission() {
        let directory = std::env::temp_dir().join(format!("frame-speech-test-{}", uid()));
        std::fs::create_dir_all(directory.join("assets")).unwrap();
        let state = WorkflowState {
            store: crate::workflow::storage::Store::open(&directory.join("test.sqlite")).unwrap(),
            active: std::sync::Mutex::new(None),
            media_active: std::sync::Mutex::new(None),
            video_active: std::sync::Mutex::new(std::collections::HashMap::new()),
            export_active: std::sync::Mutex::new(None),
            speech_active: std::sync::Mutex::new(None),
            transcription_active: std::sync::Mutex::new(None),
            model_pull: std::sync::Mutex::new(None),
            comfy_download: std::sync::Mutex::new(None),
            directory: directory.clone(),
        };
        let saved = SpeechJob {
            id: uid(),
            request: request(),
            status: "saving".into(),
            message: String::new(),
            created_at: 1,
            updated_at: 1,
            asset_id: None,
            estimated_cost_micro_usd: 50_000,
        };
        let pending = SpeechJob {
            id: uid(),
            status: "submitting".into(),
            ..saved.clone()
        };
        save(&state, &saved).unwrap();
        save(&state, &pending).unwrap();
        let asset = composition::AudioAsset {
            version_id: saved.id.clone(),
            workflow_id: "project".into(),
            name: "voice.wav".into(),
            file_name: format!("{}.wav", saved.id),
            bytes: 12,
            duration_ms: 1000,
            created_at: 1,
        };
        std::fs::write(
            directory.join("assets").join(&asset.file_name),
            b"RIFFtestWAVE",
        )
        .unwrap();
        state
            .store
            .db()
            .unwrap()
            .execute(
                "INSERT INTO audio_assets VALUES (?1,?2,?3,1)",
                params![
                    asset.version_id,
                    asset.workflow_id,
                    serde_json::to_string(&asset).unwrap()
                ],
            )
            .unwrap();
        recover(&state).unwrap();
        recover(&state).unwrap();
        let result = jobs(&state, Some("project")).unwrap();
        assert_eq!(result.len(), 2);
        assert_eq!(
            result
                .iter()
                .find(|j| j.id == saved.id)
                .unwrap()
                .asset_id
                .as_ref(),
            Some(&saved.id)
        );
        assert_eq!(
            result.iter().find(|j| j.id == pending.id).unwrap().status,
            "unknown"
        );
        assert!(state.speech_active.lock().unwrap().is_none());
        drop(state);
        std::fs::remove_dir_all(directory).unwrap();
    }
}

#[tauri::command]
pub fn start_speech_job(
    app: tauri::AppHandle,
    state: tauri::State<WorkflowState>,
    request: SpeechRequest,
) -> AppResult<SpeechJob> {
    validate(&request)?;
    let key = get_key(&request.base_url)?.ok_or("请先保存当前配音服务的 API Key")?;
    let mut active = state.speech_active.lock().map_err(|_| "配音任务锁不可用")?;
    if active.is_some() {
        return Err("已有配音正在生成，请等待完成".into());
    }
    let job = SpeechJob {
        id: uid(),
        estimated_cost_micro_usd: request.budget_reservation_micro_usd,
        request,
        status: "submitting".into(),
        message: "正在提交配音请求".into(),
        created_at: now(),
        updated_at: now(),
        asset_id: None,
    };
    reserve_job(
        &state,
        BillableJob::Speech,
        &job.request.workflow_id,
        &job.id,
        job.created_at,
        job.estimated_cost_micro_usd,
        &job,
    )?;
    *active = Some(job.id.clone());
    let task = job.clone();
    tauri::async_runtime::spawn(async move {
        let state = app.state::<WorkflowState>();
        let mut task = task;
        if let Err(error) = execute(&app, &state, &mut task, &key).await {
            if task.status != "failed" {
                task.status = "unknown".into();
            }
            task.message = error;
        }
        task.updated_at = now();
        if save(&state, &task).is_err() {
            eprintln!("Could not persist final speech job state");
        }
        if let Ok(mut active) = state.speech_active.lock() {
            *active = None;
        };
    });
    Ok(job)
}

async fn execute(
    app: &tauri::AppHandle,
    state: &WorkflowState,
    job: &mut SpeechJob,
    key: &str,
) -> AppResult<()> {
    let client = Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(180))
        .build()
        .map_err(|_| "创建配音连接失败")?;
    let request = &job.request;
    let mut response = client
        .post(cloud::endpoint(&request.base_url, "audio/speech")?)
        .bearer_auth(key)
        .json(&json!({
            "model":request.model, "input":request.input, "voice":request.voice,
            "speed":request.speed, "response_format":"wav"
        }))
        .send()
        .await
        .map_err(|_| "配音请求中断，结果待核实；请核对服务商用量后再手动生成")?;
    if !response.status().is_success() {
        job.status = "failed".into();
        return Err(format!(
            "配音服务返回 HTTP {}；请检查密钥、模型权限和服务状态",
            response.status().as_u16()
        ));
    }
    if response
        .content_length()
        .is_some_and(|length| length > MAX_AUDIO_BYTES as u64)
    {
        return Err("配音响应超过 20 MB；请核对服务商用量".into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "配音下载中断，结果待核实；请核对服务商用量")?
    {
        if bytes.len() + chunk.len() > MAX_AUDIO_BYTES {
            return Err("配音响应超过 20 MB；请核对服务商用量".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    // WAV is requested explicitly; reject JSON/HTML or provider format mismatches.
    if bytes.get(..4) != Some(b"RIFF") || bytes.get(8..12) != Some(b"WAVE") {
        return Err("配音响应不是 WAV 音频；请检查接口兼容性及服务商用量".into());
    }
    job.status = "saving".into();
    job.message = "正在保存配音素材".into();
    job.updated_at = now();
    save(state, job)?;
    let handle = app.clone();
    let id = job.id.clone();
    let workflow_id = job.request.workflow_id.clone();
    let name = format!("AI 配音-{}.wav", &id[..8]);
    let asset = tauri::async_runtime::spawn_blocking(move || {
        store_audio(
            &handle.state::<WorkflowState>(),
            workflow_id,
            name,
            bytes,
            id,
        )
    })
    .await
    .map_err(|_| "配音素材保存中断，请核对本地素材和服务商用量")??;
    job.status = "succeeded".into();
    job.asset_id = Some(asset.version_id);
    job.message = "配音已保存，可试听后选入时间线".into();
    Ok(())
}
