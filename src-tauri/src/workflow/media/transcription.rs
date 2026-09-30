//! Non-streamed OpenAI-compatible transcription. An uncertain submission is never retried.
use super::budget::{reserve_job, BillableJob};
use super::composition::{audio, MAX_AUDIO_BYTES};
use super::connection::{check_catalog, ConnectionCheck};
use super::subtitles::{self, SubtitleCue};
use super::*;
use reqwest::Client;
use serde_json::Value;
use std::time::Duration;
use tauri::Manager;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TranscriptionRequest {
    pub workflow_id: String,
    pub base_url: String,
    pub model: String,
    pub source_audio_version_id: String,
    pub budget_reservation_micro_usd: u64,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptionJob {
    pub id: String,
    pub request: TranscriptionRequest,
    pub status: String,
    pub message: String,
    pub created_at: u64,
    pub updated_at: u64,
    pub asset_id: Option<String>,
    pub estimated_cost_micro_usd: u64,
}

fn validate(request: &TranscriptionRequest) -> AppResult<()> {
    cloud::api_base(&request.base_url)?;
    if request.workflow_id.is_empty()
        || request.workflow_id.len() > 128
        || request.model.trim().is_empty()
        || request.model.len() > 128
        || request.model.chars().any(char::is_control)
        || uuid::Uuid::parse_str(&request.source_audio_version_id).is_err()
    {
        return Err("请检查转写模型和配音版本".into());
    }
    if !(1_000..=1_000_000_000).contains(&request.budget_reservation_micro_usd) {
        return Err("本次转写预算预留金额须在 0.001–1000 美元之间".into());
    }
    Ok(())
}

fn key_entry(base_url: &str) -> AppResult<keyring::Entry> {
    let canonical = cloud::api_base(base_url)?.to_string();
    let service =
        if cfg!(debug_assertions) && std::env::var_os("FRAME_STUDIO_TEST_DATA_DIR").is_some() {
            "com.frame-studio.desktop.transcription.test"
        } else {
            "com.frame-studio.desktop.transcription"
        };
    keyring::Entry::new(service, canonical.trim_end_matches('/'))
        .map_err(|_| "访问系统凭据库失败".into())
}

fn get_key(base_url: &str) -> AppResult<Option<String>> {
    match key_entry(base_url)?.get_password() {
        Ok(key) => Ok(Some(key)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Err("读取转写服务密钥失败".into()),
    }
}

#[tauri::command]
pub fn transcription_key_status(base_url: String) -> AppResult<bool> {
    Ok(get_key(&base_url)?.is_some())
}

#[tauri::command]
pub fn save_transcription_key(base_url: String, api_key: String) -> AppResult<()> {
    if api_key.trim().is_empty() || api_key.len() > 4096 || api_key.contains(['\r', '\n']) {
        return Err("API Key 无效".into());
    }
    key_entry(&base_url)?
        .set_password(api_key.trim())
        .map_err(|_| "系统凭据库保存失败".into())
}

#[tauri::command]
pub fn clear_transcription_key(base_url: String) -> AppResult<()> {
    match key_entry(&base_url)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(_) => Err("系统凭据库删除失败".into()),
    }
}

#[tauri::command]
pub async fn check_transcription_connection(
    base_url: String,
    model: String,
) -> AppResult<ConnectionCheck> {
    if model.trim().is_empty() || model.len() > 128 {
        return Err("请填写转写模型 ID".into());
    }
    let key = get_key(&base_url)?.ok_or("请先保存当前转写服务的 API Key")?;
    check_catalog(
        cloud::endpoint(&base_url, "models")?,
        &key,
        &model,
        "openai",
    )
    .await
}

fn save(state: &WorkflowState, job: &TranscriptionJob) -> AppResult<()> {
    state.store.db()?.execute(
        "INSERT INTO transcription_jobs VALUES (?1,?2,?3,?4) ON CONFLICT(id) DO UPDATE SET json=excluded.json",
        params![job.id, job.request.workflow_id, serde_json::to_string(job).map_err(|e|e.to_string())?, job.created_at],
    ).map_err(|e|e.to_string())?;
    Ok(())
}

fn jobs(state: &WorkflowState, workflow_id: Option<&str>) -> AppResult<Vec<TranscriptionJob>> {
    let db = state.store.db()?;
    let mut query = db.prepare(
        "SELECT json FROM transcription_jobs WHERE (?1 IS NOT NULL AND workflow_id=?1) OR (?1 IS NULL AND json_extract(json,'$.status') IN ('submitting','saving')) ORDER BY created_at DESC, rowid DESC LIMIT ?2",
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
pub fn list_transcription_jobs(
    state: tauri::State<WorkflowState>,
    workflow_id: String,
) -> AppResult<Vec<TranscriptionJob>> {
    let mut result = jobs(&state, Some(&workflow_id))?;
    result.truncate(100);
    Ok(result)
}

pub fn recover(state: &WorkflowState) -> AppResult<()> {
    for mut job in jobs(state, None)? {
        if matches!(job.status.as_str(), "submitting" | "saving") {
            let saved = subtitles::asset(state, &job.id).is_ok_and(|asset| {
                asset.workflow_id == job.request.workflow_id
                    && asset.source_audio_version_id == job.request.source_audio_version_id
            });
            if saved {
                job.status = "succeeded".into();
                job.asset_id = Some(job.id.clone());
                job.message = "已找回保存到本地的字幕版本".into();
            } else {
                job.status = "unknown".into();
                job.message = "应用退出，转写结果待核实；请核对服务商用量后再手动生成".into();
            }
            job.updated_at = now();
            save(state, &job)?;
        }
    }
    Ok(())
}

#[tauri::command]
pub fn start_transcription_job(
    app: tauri::AppHandle,
    state: tauri::State<WorkflowState>,
    request: TranscriptionRequest,
) -> AppResult<TranscriptionJob> {
    validate(&request)?;
    let source = audio(&state, &request.source_audio_version_id)?;
    if source.workflow_id != request.workflow_id {
        return Err("配音素材不属于当前项目".into());
    }
    let path = state.directory.join("assets").join(&source.file_name);
    let size = std::fs::metadata(&path)
        .map_err(|_| "配音原文件已丢失")?
        .len();
    if size == 0 || size > MAX_AUDIO_BYTES as u64 {
        return Err("转写音频须在 20 MB 以内".into());
    }
    // AAC import is supported by the mixer but is not a supported transcription upload format.
    if source.file_name.ends_with(".aac") {
        return Err("请导入 WAV、MP3、M4A、FLAC 或 OGG 配音后再转写".into());
    }
    let bytes = std::fs::read(path).map_err(|_| "读取配音文件失败")?;
    if bytes.len() > MAX_AUDIO_BYTES {
        return Err("转写音频超过 20 MB".into());
    }
    let key = get_key(&request.base_url)?.ok_or("请先保存当前转写服务的 API Key")?;
    let mut active = state
        .transcription_active
        .lock()
        .map_err(|_| "转写任务锁不可用")?;
    if active.is_some() {
        return Err("已有转写正在生成，请等待完成".into());
    }
    let job = TranscriptionJob {
        id: uid(),
        estimated_cost_micro_usd: request.budget_reservation_micro_usd,
        request,
        status: "submitting".into(),
        message: "正在提交转写请求".into(),
        created_at: now(),
        updated_at: now(),
        asset_id: None,
    };
    reserve_job(
        &state,
        BillableJob::Transcription,
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
        if let Err(error) = execute(
            &state,
            &mut task,
            &key,
            bytes,
            source.file_name,
            source.duration_ms,
        )
        .await
        {
            if task.status != "failed" {
                task.status = "unknown".into();
            }
            task.message = error;
        }
        task.updated_at = now();
        if save(&state, &task).is_err() {
            eprintln!("Could not persist final transcription job state");
        }
        if let Ok(mut active) = state.transcription_active.lock() {
            *active = None;
        };
    });
    Ok(job)
}

async fn execute(
    state: &WorkflowState,
    job: &mut TranscriptionJob,
    key: &str,
    bytes: Vec<u8>,
    file_name: String,
    duration_ms: u32,
) -> AppResult<()> {
    let client = Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(180))
        .build()
        .map_err(|_| "创建转写连接失败")?;
    let request = &job.request;
    let form = reqwest::multipart::Form::new()
        .part(
            "file",
            reqwest::multipart::Part::bytes(bytes).file_name(file_name),
        )
        .text("model", request.model.clone())
        .text("response_format", "verbose_json")
        .text("timestamp_granularities[]", "segment");
    let mut response = client
        .post(cloud::endpoint(&request.base_url, "audio/transcriptions")?)
        .bearer_auth(key)
        .multipart(form)
        .send()
        .await
        .map_err(|_| "转写请求中断，结果待核实；请核对服务商用量后再手动生成")?;
    if !response.status().is_success() {
        job.status = "failed".into();
        return Err(format!(
            "转写服务返回 HTTP {}；请检查密钥、模型权限和服务状态",
            response.status().as_u16()
        ));
    }
    const MAX_RESPONSE: usize = 2 * 1024 * 1024;
    if response
        .content_length()
        .is_some_and(|n| n > MAX_RESPONSE as u64)
    {
        return Err("转写响应超过 2 MB；请核对服务商用量".into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "转写响应中断；请核对服务商用量")?
    {
        if bytes.len() + chunk.len() > MAX_RESPONSE {
            return Err("转写响应超过 2 MB；请核对服务商用量".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    let value: Value =
        serde_json::from_slice(&bytes).map_err(|_| "转写响应不是 JSON；请检查接口及服务商用量")?;
    let cues = parse_segments(&value, duration_ms)?;
    job.status = "saving".into();
    job.message = "正在保存字幕版本".into();
    job.updated_at = now();
    save(state, job)?;
    let asset = subtitles::store(
        state,
        job.request.workflow_id.clone(),
        job.request.source_audio_version_id.clone(),
        cues,
        job.id.clone(),
        None,
    )?;
    job.status = "succeeded".into();
    job.asset_id = Some(asset.version_id);
    job.message = "字幕已保存，请预览校对后应用到时间线".into();
    Ok(())
}

fn parse_segments(value: &Value, duration_ms: u32) -> AppResult<Vec<SubtitleCue>> {
    let segments = value["segments"].as_array().ok_or(
        "服务未返回分段时间戳；请使用 whisper-1 或兼容 verbose_json 的模型，并核对服务商用量",
    )?;
    if segments.len() > 1000 {
        return Err("转写片段超过 1000 段".into());
    }
    let milliseconds = |v: &Value| -> AppResult<u32> {
        let seconds = v.as_f64().ok_or("字幕时间戳缺失")?;
        if !seconds.is_finite() || seconds < 0.0 || seconds * 1000.0 > f64::from(duration_ms) {
            return Err("字幕时间戳超出配音时长".into());
        }
        Ok((seconds * 1000.0).round() as u32)
    };
    let cues = segments
        .iter()
        .map(|segment| {
            Ok(SubtitleCue {
                start_ms: milliseconds(&segment["start"])?,
                end_ms: milliseconds(&segment["end"])?,
                text: segment["text"]
                    .as_str()
                    .ok_or("字幕文本缺失")?
                    .trim()
                    .to_owned(),
            })
        })
        .collect::<AppResult<Vec<_>>>()?;
    subtitles::validate_cues(&cues, duration_ms)?;
    Ok(cues)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn restart_recovers_saved_subtitle_without_repeating_submission() {
        let directory = std::env::temp_dir().join(format!("frame-transcription-test-{}", uid()));
        std::fs::create_dir_all(&directory).unwrap();
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
        let saved = TranscriptionJob {
            id: uid(),
            request: TranscriptionRequest {
                workflow_id: "project".into(),
                source_audio_version_id: uid(),
                base_url: "http://127.0.0.1:8188/v1".into(),
                model: "whisper-1".into(),
                budget_reservation_micro_usd: 1000,
            },
            status: "saving".into(),
            message: String::new(),
            created_at: 1,
            updated_at: 1,
            asset_id: None,
            estimated_cost_micro_usd: 1000,
        };
        let pending = TranscriptionJob {
            id: uid(),
            status: "submitting".into(),
            ..saved.clone()
        };
        save(&state, &saved).unwrap();
        save(&state, &pending).unwrap();
        let asset = subtitles::SubtitleAsset {
            version_id: saved.id.clone(),
            workflow_id: "project".into(),
            source_audio_version_id: saved.request.source_audio_version_id.clone(),
            parent_version_id: None,
            cues: vec![SubtitleCue {
                start_ms: 0,
                end_ms: 500,
                text: "Hello".into(),
            }],
            created_at: 1,
        };
        state
            .store
            .db()
            .unwrap()
            .execute(
                "INSERT INTO subtitle_assets VALUES (?1,?2,?3,1)",
                params![
                    asset.version_id,
                    asset.workflow_id,
                    serde_json::to_string(&asset).unwrap()
                ],
            )
            .unwrap();
        let audio = composition::AudioAsset {
            version_id: asset.source_audio_version_id.clone(),
            workflow_id: "project".into(),
            name: "voice.wav".into(),
            file_name: "voice.wav".into(),
            bytes: 12,
            duration_ms: 700,
            created_at: 1,
        };
        state
            .store
            .db()
            .unwrap()
            .execute(
                "INSERT INTO audio_assets VALUES (?1,?2,?3,1)",
                params![
                    audio.version_id,
                    audio.workflow_id,
                    serde_json::to_string(&audio).unwrap()
                ],
            )
            .unwrap();
        let mut draft = composition::Composition {
            workflow_id: "project".into(),
            clips: vec![],
            aspect: "1:1".into(),
            resolution: 720,
            music_version_id: None,
            voice_version_id: Some(audio.version_id.clone()),
            voice_start_ms: 0,
            music_volume: 50,
            subtitle_version_id: Some(asset.version_id.clone()),
            subtitle_format: "srt".into(),
            subtitle_text: subtitles::to_srt(&asset.cues),
        };
        assert!(subtitles::validate_binding(&state, &draft).is_ok());
        draft.voice_version_id = Some(uid());
        assert!(subtitles::validate_binding(&state, &draft).is_err());
        draft.voice_version_id = Some(audio.version_id);
        draft.subtitle_text.push('x');
        assert!(subtitles::validate_binding(&state, &draft).is_err());
        draft.subtitle_text = subtitles::to_srt(&asset.cues);
        draft.workflow_id = "other-project".into();
        assert!(subtitles::validate_binding(&state, &draft).is_err());
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
        assert!(state.transcription_active.lock().unwrap().is_none());
        drop(state);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn requires_real_valid_segment_timestamps() {
        use serde_json::json;
        assert!(parse_segments(&json!({"text":"hello"}), 1000).is_err());
        let value = json!({"segments":[{"start":0.05,"end":0.65,"text":" Hello "}]});
        let cues = parse_segments(&value, 700).unwrap();
        assert_eq!(cues[0].start_ms, 50);
        assert_eq!(cues[0].text, "Hello");
        for segment in [
            json!({"start":-1,"end":0.5,"text":"x"}),
            json!({"start":0,"end":2,"text":"x"}),
            json!({"start":0.6,"end":0.5,"text":"x"}),
            json!({"start":0,"text":"x"}),
        ] {
            assert!(parse_segments(&json!({"segments":[segment]}), 700).is_err());
        }
    }
}
