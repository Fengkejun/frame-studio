//! Wulusai v2 video protocol. Settings travel with a job; credentials stay in
//! the system vault. This module only accepts documented generation modes.
use super::*;

#[derive(Clone, Default, Serialize, Deserialize, PartialEq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    #[default]
    Text,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Settings {
    pub base_url: String,
    pub model: String,
    #[serde(default)]
    pub mode: Mode,
    pub ratio: Option<String>,
    pub budget_reservation_micro_usd: u64,
}

fn base(value: &str) -> AppResult<Url> {
    if value.len() > 512 || value.trim() != value {
        return Err("视频 API 根地址无效".into());
    }
    let mut url = Url::parse(value).map_err(|_| "视频 API 根地址无效")?;
    let fixture = cfg!(debug_assertions)
        && std::env::var_os("FRAME_STUDIO_TEST_DATA_DIR").is_some()
        && url.scheme() == "http"
        && matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "[::1]"));
    if !(url.scheme() == "https" || fixture)
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || !["", "/v2"].contains(&url.path().trim_end_matches('/'))
    {
        return Err("视频 API 根地址须为 HTTPS 服务根地址或 /v2 地址".into());
    }
    url.set_path("/");
    Ok(url)
}

pub(super) fn endpoint(settings: &Settings, task_id: Option<&str>) -> AppResult<Url> {
    let mut url = base(&settings.base_url)?;
    if let Some(id) = task_id {
        super::valid_task_id(id)?;
        url.set_path(&format!("/v2/query/video_generation/{id}"));
    } else {
        url.set_path("/v2/video_generation");
    }
    Ok(url)
}

pub(super) fn validate(settings: &Settings, request: &VideoRequest) -> AppResult<()> {
    base(&settings.base_url)?;
    if !["minimax-h3", "MiniMax-H3"].contains(&settings.model.as_str())
        || !(4..=15).contains(&request.duration)
        || !["480P", "768P", "1080P", "2K"].contains(&request.resolution.as_str())
        || settings
            .ratio
            .as_deref()
            .is_some_and(|r| !["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"].contains(&r))
        || !(10_000..=1_000_000_000).contains(&settings.budget_reservation_micro_usd)
    {
        return Err("请检查 Wulusai 模型、分辨率、比例和本次预算预留（0.01–1000 美元）".into());
    }
    Ok(())
}

pub(super) fn body(settings: &Settings, request: &VideoRequest) -> Value {
    let prompt = if request.negative_prompt.trim().is_empty() {
        request.prompt.clone()
    } else {
        format!(
            "{}\n\nAvoid these visual elements: {}",
            request.prompt, request.negative_prompt
        )
    };
    let mut body = json!({"model":settings.model,"content":[{"type":"text","text":prompt}],
        "resolution":request.resolution,"duration":request.duration});
    if let Some(ratio) = &settings.ratio {
        body["ratio"] = json!(ratio);
    }
    body
}

pub(super) fn output(data: &Value, expected_id: &str) -> AppResult<Value> {
    let task = data.get("task").unwrap_or(data);
    if task
        .get("id")
        .or_else(|| task.get("task_id"))
        .and_then(Value::as_str)
        != Some(expected_id)
    {
        return Err("视频查询返回了其他任务的结果".into());
    }
    let status = match task["status"]
        .as_str()
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "pending" | "queued" | "submitted" => "PENDING",
        "running" | "processing" => "RUNNING",
        "success" | "succeeded" | "completed" => "SUCCEEDED",
        "failed" | "canceled" | "cancelled" => "FAILED",
        "unknown" | "expired" => "UNKNOWN",
        _ => return Err("Wulusai 视频状态暂未识别，可继续查询原任务".into()),
    };
    let url = task
        .pointer("/content/url")
        .or_else(|| task.get("file_url"));
    if status == "SUCCEEDED" && url.and_then(Value::as_str).is_none() {
        return Err("视频任务已完成但未返回下载地址，可继续查询原任务".into());
    }
    Ok(json!({"task_status":status,"video_url":url,
        "message":task.pointer("/error/message").or_else(|| task.get("error")).and_then(Value::as_str).unwrap_or("请查看服务商任务详情")}))
}

pub(super) fn trusted_download(value: &Url, settings: &Settings) -> AppResult<bool> {
    let api = base(&settings.base_url)?;
    let host = value.host_str().unwrap_or("");
    let allowed = value.scheme() == "https"
        && (Some(host) == api.host_str()
            || host == "wulusai.com"
            || host.ends_with(".wulusai.com"));
    Ok(allowed)
}

fn entry(base_url: &str) -> AppResult<keyring::Entry> {
    let canonical = base(base_url)?.to_string();
    let service =
        if cfg!(debug_assertions) && std::env::var_os("FRAME_STUDIO_TEST_DATA_DIR").is_some() {
            "com.frame-studio.desktop.wulusai-video.test"
        } else {
            "com.frame-studio.desktop.wulusai-video"
        };
    keyring::Entry::new(service, &canonical).map_err(|_| "系统凭据库不可用".into())
}

pub(super) fn key(base_url: &str) -> AppResult<Option<String>> {
    match entry(base_url)?.get_password() {
        Ok(key) => Ok(Some(key)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Err("视频密钥读取失败".into()),
    }
}

#[tauri::command]
pub fn wulusai_video_key_status(base_url: String) -> AppResult<bool> {
    Ok(key(&base_url)?.is_some())
}

#[tauri::command]
pub fn save_wulusai_video_key(base_url: String, api_key: String) -> AppResult<()> {
    if api_key.trim().is_empty() || api_key.len() > 4096 || api_key.contains(['\r', '\n']) {
        return Err("API Key 无效".into());
    }
    entry(&base_url)?
        .set_password(api_key.trim())
        .map_err(|_| "系统凭据库保存失败".into())
}

#[tauri::command]
pub fn clear_wulusai_video_key(base_url: String) -> AppResult<()> {
    match entry(&base_url)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(_) => Err("系统凭据库删除失败".into()),
    }
}

#[tauri::command]
pub async fn check_wulusai_video_connection(
    base_url: String,
    model: String,
) -> AppResult<ConnectionCheck> {
    if model.is_empty() || model.len() > 128 {
        return Err("模型 ID 无效".into());
    }
    let key = key(&base_url)?.ok_or("请先保存当前视频服务的 API Key")?;
    let mut url = base(&base_url)?;
    url.set_path("/v1/models");
    check_catalog(url, &key, &model, "openai").await
}

#[cfg(test)]
mod tests {
    use super::*;
    fn settings() -> Settings {
        Settings {
            base_url: "https://api.wulusai.com".into(),
            model: "minimax-h3".into(),
            mode: Mode::Text,
            ratio: None,
            budget_reservation_micro_usd: 675_000,
        }
    }
    #[test]
    fn query_preserves_task_identity_and_normalizes_real_results() {
        let data = json!({"task":{"id":"test-id","status":"succeeded","content":{"url":"https://ai.wulusai.com/workflow/files/test.mp4"}}});
        let value = output(&data, "test-id").unwrap();
        assert_eq!(value["task_status"], "SUCCEEDED");
        assert_eq!(value["video_url"], data["task"]["content"]["url"]);
        let documented = output(&json!({"task_id":"test-id","status":"Success","file_url":"https://ai.wulusai.com/workflow/files/test.mp4"}),"test-id").unwrap();
        assert_eq!(documented["task_status"], "SUCCEEDED");
        assert_eq!(documented["video_url"], value["video_url"]);
        assert!(output(&data, "other-id").is_err());
        assert!(output(
            &json!({"task":{"id":"test-id","status":"succeeded"}}),
            "test-id"
        )
        .is_err());
        assert_eq!(
            output(
                &json!({"task":{"id":"test-id","status":"running"}}),
                "test-id"
            )
            .unwrap()["task_status"],
            "RUNNING"
        );
        assert_eq!(
            output(
                &json!({"task":{"id":"test-id","status":"failed","error":{"message":"rejected"}}}),
                "test-id"
            )
            .unwrap()["message"],
            "rejected"
        );
    }
    #[test]
    fn endpoints_and_downloads_keep_credentials_on_the_selected_service() {
        let settings = settings();
        assert_eq!(
            endpoint(&settings, None).unwrap().as_str(),
            "https://api.wulusai.com/v2/video_generation"
        );
        assert!(endpoint(&settings, Some("../tasks")).is_err());
        assert!(base("http://api.wulusai.com").is_err());
        assert!(base("https://user:secret@api.wulusai.com").is_err());
        assert!(trusted_download(
            &Url::parse("https://ai.wulusai.com/workflow/files/a.mp4").unwrap(),
            &settings
        )
        .unwrap());
        assert!(!trusted_download(
            &Url::parse("https://wulusai.com.example.com/a.mp4").unwrap(),
            &settings
        )
        .unwrap());
    }
    #[test]
    fn documented_request_bounds_and_omitted_ratio_are_preserved() {
        let mut request:VideoRequest=serde_json::from_value(json!({"context":{"workflowId":"w","nodeId":"n","artifactId":"a","shotId":"s"},
            "firstFrameVersionId":"frame","region":"singapore","prompt":"A red paper boat on a quiet lake.","negativePrompt":"", "duration":5,"resolution":"1080P"})).unwrap();
        assert!(request.wulusai.is_none());
        let mut settings = settings();
        request.wulusai = Some(settings.clone());
        assert!(validate(&settings, &request).is_ok());
        let payload = body(&settings, &request);
        assert_eq!(
            payload,
            json!({"model":"minimax-h3","content":[{"type":"text","text":"A red paper boat on a quiet lake."}],"resolution":"1080P","duration":5})
        );
        settings.ratio = Some("16:9".into());
        assert_eq!(body(&settings, &request)["ratio"], "16:9");
        request.duration = 3;
        assert!(validate(&settings, &request).is_err());
        request.duration = 16;
        assert!(validate(&settings, &request).is_err());
        request.duration = 4;
        for resolution in ["480P", "768P", "1080P", "2K"] {
            request.resolution = resolution.into();
            assert!(validate(&settings, &request).is_ok());
        }
        settings.budget_reservation_micro_usd = 0;
        assert!(validate(&settings, &request).is_err());
        request.wulusai = Some(settings);
        let mut unknown = serde_json::to_value(&request).unwrap();
        unknown["wulusai"]["mode"] = json!("frame");
        assert!(serde_json::from_value::<VideoRequest>(unknown).is_err());
    }
}
