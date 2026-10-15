//! Relay content v2, videos v1 and Ark v3 protocols. Settings travel with a job; credentials stay in
//! the system vault. This module only accepts documented generation modes.
pub use super::models::Mode;
use super::models::{Model, Protocol};
use super::*;

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
impl Settings {
    pub(super) fn profile(&self) -> AppResult<&'static Model> {
        let profile = models::find(&self.model)?;
        if profile.protocol == Protocol::Wan {
            return Err("请在万相视频服务中选择该模型".into());
        }
        Ok(profile)
    }
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
        || !["", "/v1", "/v2", "/api/v3"].contains(&url.path().trim_end_matches('/'))
    {
        return Err("视频 API 根地址须为 HTTPS 服务根地址、/v1、/v2 或 /api/v3 地址".into());
    }
    url.set_path("/");
    Ok(url)
}

pub(super) fn endpoint(settings: &Settings, task_id: Option<&str>) -> AppResult<Url> {
    let mut url = base(&settings.base_url)?;
    let protocol = settings.profile()?.protocol;
    let path = match protocol {
        Protocol::RelayVideosV1 | Protocol::RelaySdVideosV1 => "/v1/videos",
        Protocol::RelayContentV2 => {
            if task_id.is_some() {
                "/v2/query/video_generation"
            } else {
                "/v2/video_generation"
            }
        }
        Protocol::RelayArkV3 => "/api/v3/contents/generations/tasks",
        Protocol::Wan => return Err("视频协议与当前服务不匹配".into()),
    };
    if let Some(id) = task_id {
        super::valid_task_id(id)?;
        url.set_path(&format!("{path}/{id}"));
    } else {
        url.set_path(path);
    }
    Ok(url)
}

pub(super) fn validate(settings: &Settings, request: &VideoRequest) -> AppResult<()> {
    base(&settings.base_url)?;
    settings.profile()?.validate(
        request.duration,
        &request.resolution,
        settings.mode,
        settings.ratio.as_deref(),
    )?;
    if settings.profile()?.prompt_required(settings.mode) && request.prompt.trim().is_empty() {
        return Err("当前生成方式需要视频提示词".into());
    }
    if !(10_000..=1_000_000_000).contains(&settings.budget_reservation_micro_usd) {
        return Err("请检查本次视频预算预留（0.01–1000 美元）".into());
    }
    Ok(())
}

pub(super) fn submitted_task_id(settings: &Settings, data: &Value) -> AppResult<String> {
    let field = match settings.profile()?.protocol {
        Protocol::RelayVideosV1 | Protocol::RelayArkV3 | Protocol::RelaySdVideosV1 => "id",
        Protocol::RelayContentV2 => "task_id",
        Protocol::Wan => return Err("视频协议与当前服务不匹配".into()),
    };
    let id = data
        .get(field)
        .and_then(Value::as_str)
        .ok_or("响应未返回任务 ID，请核对服务商用量")?;
    super::valid_task_id(id)?;
    Ok(id.to_owned())
}

pub(super) fn body(
    settings: &Settings,
    request: &VideoRequest,
    reference: Option<&str>,
) -> AppResult<Value> {
    validate(settings, request)?;
    let prompt = if request.negative_prompt.trim().is_empty() {
        request.prompt.clone()
    } else {
        format!(
            "{}\n\nAvoid these visual elements: {}",
            request.prompt, request.negative_prompt
        )
    };
    let protocol = settings.profile()?.protocol;
    if protocol == Protocol::RelaySdVideosV1 {
        let mut payload = json!({"model":settings.model,"seconds":request.duration.to_string(),"size":request.resolution.to_ascii_lowercase()});
        if !prompt.trim().is_empty() {
            payload["prompt"] = json!(prompt);
        }
        if settings.mode == Mode::Frame {
            payload["content"] = json!([{"type":"image_url","image_url":{"url":reference.ok_or("图生视频缺少首帧图片")?},"role":"first_frame"}]);
        }
        if let Some(ratio) = &settings.ratio {
            payload["ratio"] = json!(ratio);
        }
        return Ok(payload);
    }
    if protocol == Protocol::RelayArkV3 {
        let mut content = Vec::new();
        if !prompt.trim().is_empty() {
            content.push(json!({"type":"text", "text": prompt}));
        }
        if settings.mode == Mode::Frame {
            content.push(json!({"type":"image_url", "image_url":{"url":reference.ok_or("图生视频缺少首帧图片")?}, "role":"first_frame"}));
        }
        let mut payload = json!({"model":settings.model, "content":content, "duration":request.duration, "resolution":request.resolution.to_ascii_lowercase()});
        if let Some(ratio) = &settings.ratio {
            payload["ratio"] = json!(ratio);
        }
        return Ok(payload);
    }
    if protocol == Protocol::RelayVideosV1 {
        let mut body = json!({"model":settings.model,"prompt":prompt,"seconds":request.duration.to_string(),"size":request.resolution.to_ascii_lowercase()});
        if settings.mode == Mode::Frame {
            // The relay's observed JSON schema uses a string, unlike OpenAI's object.
            body["input_reference"] = json!(reference.ok_or("图生视频缺少首帧图片")?);
        }
        return Ok(body);
    }
    let mut body = json!({"model":settings.model,"content":[{"type":"text","text":prompt}],
        "resolution":request.resolution,"duration":request.duration});
    if let Some(ratio) = &settings.ratio {
        body["ratio"] = json!(ratio);
    }
    Ok(body)
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
        "running" | "processing" | "in_progress" => "RUNNING",
        "success" | "succeeded" | "completed" => "SUCCEEDED",
        "failed" | "canceled" | "cancelled" => "FAILED",
        "unknown" => return Err("视频服务尚未确认原任务状态；可继续查询原任务".into()),
        "expired" => "UNKNOWN",
        _ => return Err("Wulusai 视频状态暂未识别，可继续查询原任务".into()),
    };
    let url = [
        task.pointer("/content/video_url"),
        task.pointer("/content/url"),
        task.get("file_url"),
        task.pointer("/metadata/url"),
    ]
    .into_iter()
    .flatten()
    .find(|value| value.as_str().is_some_and(|s| !s.is_empty()));
    if status == "SUCCEEDED" && url.and_then(Value::as_str).is_none() {
        return Err("视频任务已完成但未返回下载地址，可继续查询原任务".into());
    }
    Ok(json!({"task_status":status,"video_url":url,
        "message":task.pointer("/error/message").or_else(|| task.get("error")).and_then(Value::as_str).unwrap_or("请查看服务商任务详情")}))
}
pub(super) fn parse_output(settings: &Settings, data: &Value, id: &str) -> AppResult<Value> {
    if settings.profile()?.protocol == Protocol::RelayVideosV1
        && data["status"] == "completed"
        && [
            data.get("file_url"),
            data.pointer("/content/url"),
            data.pointer("/metadata/url"),
        ]
        .iter()
        .all(|value| !value.is_some_and(|v| v.as_str().is_some_and(|s| !s.is_empty())))
    {
        let mut data = data.clone();
        data["file_url"] = json!(format!("https://ai.wulusai.com/workflow/files/{id}.mp4"));
        output(&data, id)
    } else {
        output(data, id)
    }
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
            submitted_task_id(&settings, &json!({"task_id":"minimax-task"})).unwrap(),
            "minimax-task"
        );
        assert!(submitted_task_id(&settings, &json!({"id":"wrong-protocol"})).is_err());
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
        let payload = body(&settings, &request, None).unwrap();
        assert_eq!(
            payload,
            json!({"model":"minimax-h3","content":[{"type":"text","text":"A red paper boat on a quiet lake."}],"resolution":"1080P","duration":5})
        );
        settings.ratio = Some("16:9".into());
        assert_eq!(body(&settings, &request, None).unwrap()["ratio"], "16:9");
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
        settings.budget_reservation_micro_usd = 675_000;
        request.wulusai = Some(settings);
        let mut unknown = serde_json::to_value(&request).unwrap();
        unknown["wulusai"]["mode"] = json!("frame");
        let unsupported = serde_json::from_value::<VideoRequest>(unknown).unwrap();
        assert!(validate(unsupported.wulusai.as_ref().unwrap(), &unsupported).is_err());
    }
    #[test]
    fn grok_frame_uses_json_reference_and_its_own_limits_and_endpoints() {
        let mut settings = settings();
        settings.model = "grok-imagine-video-1.5-lite".into();
        assert_eq!(
            submitted_task_id(&settings, &json!({"id":"grok-task"})).unwrap(),
            "grok-task"
        );
        assert!(submitted_task_id(&settings, &json!({"task_id":"wrong-protocol"})).is_err());
        assert!(submitted_task_id(&settings, &json!({"id":"../tasks"})).is_err());
        settings.mode = Mode::Frame;
        let mut request: VideoRequest = serde_json::from_value(json!({
            "context":{"workflowId":"w","nodeId":"n","artifactId":"a","shotId":"s"},
            "firstFrameVersionId":"frame","region":"singapore","prompt":"Animate the boat.",
            "negativePrompt":"", "duration":1,"resolution":"480P"
        }))
        .unwrap();
        assert!(validate(&settings, &request).is_ok());
        assert!(body(&settings, &request, None).is_err());
        let reference = "data:image/jpeg;base64,example";
        assert_eq!(
            body(&settings, &request, Some(reference)).unwrap(),
            json!({
                "model":"grok-imagine-video-1.5-lite","prompt":"Animate the boat.",
                "seconds":"1","size":"480p","input_reference":reference
            })
        );
        assert_eq!(endpoint(&settings, None).unwrap().path(), "/v1/videos");
        assert_eq!(
            endpoint(&settings, Some("video-test")).unwrap().path(),
            "/v1/videos/video-test"
        );
        for resolution in ["480P", "720P", "1080P"] {
            request.resolution = resolution.into();
            assert!(validate(&settings, &request).is_ok());
        }
        request.resolution = "768P".into();
        assert!(validate(&settings, &request).is_err());
        request.resolution = "480P".into();
        request.duration = 0;
        assert!(validate(&settings, &request).is_err());
        request.duration = 15;
        settings.ratio = Some("16:9".into());
        assert!(validate(&settings, &request).is_err());
        settings.ratio = None;
        settings.mode = Mode::Text;
        assert!(parse_output(
            &settings,
            &json!({"id":"video-test","status":"unknown"}),
            "video-test"
        )
        .is_err());
        assert_eq!(parse_output(&settings, &json!({"id":"video-test","status":"completed", "metadata":{"url":"https://ai.wulusai.com/workflow/files/actual.mp4"}}), "video-test").unwrap()["video_url"], "https://ai.wulusai.com/workflow/files/actual.mp4");
        assert!(body(&settings, &request, None)
            .unwrap()
            .get("input_reference")
            .is_none());
        let result = parse_output(
            &settings,
            &json!({"id":"video-test","status":"completed"}),
            "video-test",
        )
        .unwrap();
        assert_eq!(
            result["video_url"],
            "https://ai.wulusai.com/workflow/files/video-test.mp4"
        );
        assert!(parse_output(
            &settings,
            &json!({"id":"other","status":"completed"}),
            "video-test"
        )
        .is_err());
    }

    #[test]
    fn sd_models_use_available_v1_route_and_only_returned_download_addresses() {
        let mut settings = settings();
        settings.base_url = "https://api.wulusai.com/api/v3".into();
        let mut request: VideoRequest = serde_json::from_value(json!({
            "context":{"workflowId":"w","nodeId":"n","artifactId":"a","shotId":"s"},
            "firstFrameVersionId":"frame","region":"singapore","prompt":"a red circle", "negativePrompt":"",
            "duration":4,"resolution":"720P"
        })).unwrap();
        for model in ["sd2.0", "sd2.0-fast", "sd2.0-mini", "sd2.5"] {
            settings.model = model.into();
            assert!(validate(&settings, &request).is_ok());
            assert_eq!(
                body(&settings, &request, None).unwrap(),
                json!({
                    "model":model, "prompt":"a red circle", "seconds":"4","size":"720p"
                })
            );
            assert_eq!(endpoint(&settings, None).unwrap().path(), "/v1/videos");
            assert_eq!(
                endpoint(&settings, Some("task_test")).unwrap().path(),
                "/v1/videos/task_test"
            );
            assert_eq!(
                submitted_task_id(&settings, &json!({"id":"task_test"})).unwrap(),
                "task_test"
            );
            request.duration = 3;
            assert!(validate(&settings, &request).is_err());
            request.duration = 16;
            assert!(validate(&settings, &request).is_err());
            request.duration = 4;
            for resolution in ["480P", "720P", "1080P", "4K"] {
                request.resolution = resolution.into();
                assert!(validate(&settings, &request).is_ok());
                assert_eq!(
                    body(&settings, &request, None).unwrap()["size"],
                    resolution.to_ascii_lowercase()
                );
            }
            request.resolution = "720P".into();
            assert!(parse_output(
                &settings,
                &json!({"id":"task_test","status":"succeeded"}),
                "task_test"
            )
            .is_err());
            assert_eq!(parse_output(&settings, &json!({"id":"task_test","status":"succeeded","content":{"video_url":"https://ai.wulusai.com/workflow/files/actual.mp4"},"file_url":null}), "task_test").unwrap()["video_url"], "https://ai.wulusai.com/workflow/files/actual.mp4");
        }
        settings.mode = Mode::Frame;
        settings.ratio = Some("16:9".into());
        assert!(validate(&settings, &request).is_err());
        settings.ratio = None;
        request.prompt.clear();
        assert!(validate(&settings, &request).is_ok());
        assert!(body(&settings, &request, None).is_err());
        let payload = body(&settings, &request, Some("data:image/jpeg;base64,image")).unwrap();
        assert_eq!(
            payload,
            json!({"model":"sd2.5", "seconds":"4","size":"720p", "content":[
                {"type":"image_url","image_url":{"url":"data:image/jpeg;base64,image"},"role":"first_frame"}
            ]})
        );
        settings.ratio = Some("adaptive".into());
        assert!(validate(&settings, &request).is_ok());
        settings.mode = Mode::Text;
        assert!(validate(&settings, &request).is_err());
    }
}
