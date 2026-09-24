use super::types::*;
use reqwest::{Client, Url};
use serde::Serialize;
use serde_json::{json, Value};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::time::Duration;
use tauri::Emitter;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OllamaModel {
    name: String,
    size: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PullProgress {
    pub model: String,
    pub status: String,
    pub completed: u64,
    pub total: u64,
}

fn ollama_provider(base_url: &str, model: &str) -> AppResult<Provider> {
    let provider = Provider {
        id: "local-discovery".into(),
        name: "Ollama".into(),
        kind: "ollama".into(),
        base_url: base_url.trim().into(),
        model: model.into(),
        has_key: false,
    };
    validate_provider(&provider)?;
    if !provider.base_url.trim_end_matches('/').ends_with("/api") {
        return Err("Ollama 地址须以 /api 结尾".into());
    }
    Ok(provider)
}

pub async fn list_ollama_models(base_url: &str) -> AppResult<Vec<OllamaModel>> {
    let provider = ollama_provider(base_url, "list")?;
    let response = client(15)?
        .get(endpoint(&provider, "tags"))
        .send()
        .await
        .map_err(|_| "无法连接 Ollama，请检查服务是否启动")?;
    let data = response_json(response).await?;
    let models = data["models"].as_array().ok_or("Ollama 模型列表格式无效")?;
    Ok(models
        .iter()
        .filter_map(|item| {
            Some(OllamaModel {
                name: item["name"].as_str()?.to_owned(),
                size: item["size"].as_u64().unwrap_or(0),
            })
        })
        .collect())
}

pub async fn pull_ollama_model(
    app: &tauri::AppHandle,
    base_url: &str,
    model: &str,
    cancel: Arc<AtomicBool>,
    progress_state: Arc<Mutex<PullProgress>>,
) -> AppResult<()> {
    let model = model.trim();
    if model.is_empty() || model.len() > 200 || model.chars().any(char::is_whitespace) {
        return Err("模型 ID 无效，请填写 Ollama 模型名称".into());
    }
    let provider = ollama_provider(base_url, model)?;
    let mut response = Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(10))
        .build()
        .map_err(|_| "无法创建模型连接")?
        .post(endpoint(&provider, "pull"))
        .json(&json!({"model": model, "stream": true}))
        .send()
        .await
        .map_err(|_| "无法连接 Ollama，请检查服务是否启动")?;
    if !response.status().is_success() {
        return Err(format!(
            "Ollama 下载请求返回 HTTP {}",
            response.status().as_u16()
        ));
    }
    let mut buffer = Vec::new();
    let mut succeeded = false;
    loop {
        if cancel.load(Ordering::Relaxed) {
            return Err("已停止模型下载；已获取的数据可能由 Ollama 保留".into());
        }
        let chunk = tokio::select! {
            result = response.chunk() => result.map_err(|_| "模型下载连接中断，请刷新已安装列表核实")?,
            _ = tokio::time::sleep(Duration::from_millis(250)) => continue,
        };
        let Some(chunk) = chunk else { break };
        buffer.extend_from_slice(&chunk);
        if buffer.len() > 64 * 1024 {
            return Err("模型下载状态过长".into());
        }
        while let Some(end) = buffer.iter().position(|byte| *byte == b'\n') {
            let line: Vec<u8> = buffer.drain(..=end).collect();
            let data: Value =
                serde_json::from_slice(&line).map_err(|_| "Ollama 下载状态格式无效")?;
            if let Some(error) = data["error"].as_str() {
                return Err(format!("Ollama 下载失败：{error}"));
            }
            let status = data["status"].as_str().unwrap_or("下载中").to_owned();
            succeeded |= status == "success";
            let progress = PullProgress {
                model: model.into(),
                status,
                completed: data["completed"].as_u64().unwrap_or(0),
                total: data["total"].as_u64().unwrap_or(0),
            };
            *progress_state.lock().map_err(|_| "模型状态锁不可用")? = progress.clone();
            let _ = app.emit("ollama-pull-progress", progress);
        }
    }
    if !succeeded {
        return Err("下载连接结束但未确认成功，请刷新已安装列表核实".into());
    }
    Ok(())
}

pub fn validate_provider(p: &Provider) -> AppResult<Url> {
    if p.id.is_empty()
        || p.id.len() > 128
        || p.name.trim().is_empty()
        || p.name.len() > 200
        || p.model.trim().is_empty()
        || p.model.len() > 200
        || !["ollama", "openai"].contains(&p.kind.as_str())
    {
        return Err("请填写连接名称、服务类型和模型 ID".into());
    }
    let url = Url::parse(&p.base_url).map_err(|_| "服务地址无效")?;
    let local = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
    if !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || !(url.scheme() == "https" || (url.scheme() == "http" && local))
    {
        return Err(
            "云端地址必须使用 HTTPS；本机可使用 HTTP。地址不能包含密码、查询参数或片段".into(),
        );
    }
    Ok(url)
}

fn entry(p: &Provider) -> AppResult<keyring::Entry> {
    keyring::Entry::new("com.frame-studio.desktop.models", &p.id)
        .map_err(|_| "无法访问系统凭据库".into())
}
pub fn save_key(p: &Provider, secret: &str) -> AppResult<()> {
    if secret.len() > 4096 || secret.trim().is_empty() || secret.contains(['\r', '\n']) {
        return Err("API Key 无效".into());
    }
    entry(p)?
        .set_password(secret.trim())
        .map_err(|_| "系统凭据库保存失败，密钥未写入普通文件".into())
}
pub fn delete_key(p: &Provider) -> AppResult<()> {
    match entry(p)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(_) => Err("系统凭据库删除失败".into()),
    }
}
fn get_key(p: &Provider) -> AppResult<Option<String>> {
    if !p.has_key {
        return Ok(None);
    }
    entry(p)?
        .get_password()
        .map(Some)
        .map_err(|_| "无法读取 API Key，请在模型连接中重新保存密钥".into())
}
fn client(timeout: u64) -> AppResult<Client> {
    Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(timeout))
        .build()
        .map_err(|_| "无法创建模型连接".into())
}
fn endpoint(p: &Provider, suffix: &str) -> String {
    format!("{}/{}", p.base_url.trim_end_matches('/'), suffix)
}
async fn response_json(mut response: reqwest::Response) -> AppResult<Value> {
    if !response.status().is_success() {
        let status = response.status().as_u16();
        return Err(match status {
            401 | 403 => "认证失败，请检查 API Key 与模型权限".into(),
            429 => "服务限流或额度不足，请稍后手动重试".into(),
            300..=399 => "服务发生重定向，请填写最终 API 地址".into(),
            _ => format!("模型服务返回 HTTP {status}，请检查服务地址与模型配置"),
        });
    }
    let mut data = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "响应中断，结果未知；请核实服务端后再重试")?
    {
        if data.len() + chunk.len() > 1_000_000 {
            return Err("模型服务响应超过 1 MB 限制".into());
        }
        data.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&data).map_err(|_| "服务返回的内容不是有效 JSON".into())
}
pub async fn test(p: &Provider) -> AppResult<String> {
    validate_provider(p)?;
    let suffix = if p.kind == "ollama" { "tags" } else { "models" };
    let mut request = client(15)?.get(endpoint(p, suffix));
    if let Some(key) = get_key(p)? {
        request = request.bearer_auth(key);
    }
    let data = response_json(
        request
            .send()
            .await
            .map_err(|_| "无法连接服务，请检查地址、服务是否启动和网络")?,
    )
    .await?;
    let models = if p.kind == "ollama" {
        data["models"].as_array().map(|a| {
            a.iter()
                .filter_map(|m| m["name"].as_str())
                .collect::<Vec<_>>()
        })
    } else {
        data["data"].as_array().map(|a| {
            a.iter()
                .filter_map(|m| m["id"].as_str())
                .collect::<Vec<_>>()
        })
    };
    let models = models.ok_or("服务响应不符合模型列表协议；请检查 API 根地址")?;
    let found = models
        .iter()
        .any(|m| *m == p.model || (p.kind == "ollama" && *m == format!("{}:latest", p.model)));
    Ok(if found {
        "连接正常，已找到配置的模型。此检查未发起生成请求。".into()
    } else {
        "服务可连接，但列表未包含该模型；请核对模型 ID 或服务商文档。".into()
    })
}

pub fn system_prompt(node: &WorkflowNode) -> String {
    let schema = match node.kind {
        NodeKind::Story => {
            r#"{"title":"故事标题","logline":"一句话梗概","content":"完整故事脚本，包含起承转合和结尾","characters":["角色名称与外观设定"]}"#
        }
        NodeKind::Storyboard => {
            r#"{"shots":[{"id":"shot-01","title":"镜头标题","description":"场景与人物动作","duration":5,"characters":["角色名称"],"dialogue":"台词，可为空","camera":"景别与运镜","imagePrompt":"用于生成该镜头首帧的提示词","videoPrompt":"动作、运镜与时间变化的提示词"}]}"#
        }
        NodeKind::Prompt => r#"{"text":"优化后的正面提示词","negativePrompt":"负面提示词"}"#,
        NodeKind::Image | NodeKind::Video | NodeKind::Timeline => "{}",
        NodeKind::Brief => "{}",
    };
    format!("你是专业的短视频创作助手。只输出一个 JSON 对象，不要 Markdown 代码围栏。使用中文。严格遵循此结构：{schema}\n目标总时长 {} 秒。如生成分镜，必须恰好 {} 个镜头，镜头 ID 不重复，时长总和等于目标时长。\n用户定义的任务要求：{}",node.config.duration,node.config.shot_count,node.config.instructions)
}
pub async fn generate(p: &Provider, node: &WorkflowNode, input: &Value) -> AppResult<Value> {
    validate_provider(p)?;
    let messages = json!([{"role":"system","content":system_prompt(node)},{"role":"user","content":serde_json::to_string(input).map_err(|_|"输入无法序列化")?}]);
    let (suffix, body) = if p.kind == "ollama" {
        (
            "chat",
            json!({"model":p.model,"messages":messages,"stream":false,"format":"json","options":{"temperature":node.config.temperature}}),
        )
    } else {
        (
            "chat/completions",
            json!({"model":p.model,"messages":messages,"stream":false,"temperature":node.config.temperature}),
        )
    };
    let mut request = client(180)?.post(endpoint(p, suffix)).json(&body);
    if let Some(key) = get_key(p)? {
        request = request.bearer_auth(key);
    }
    let data = response_json(
        request
            .send()
            .await
            .map_err(|_| "连接中断或超时，提交结果未知；请核实服务端后手动重试")?,
    )
    .await?;
    let content = if p.kind == "ollama" {
        data["message"]["content"].as_str()
    } else {
        data["choices"][0]["message"]["content"].as_str()
    }
    .ok_or("服务未返回文本结果，请确认模型支持当前聊天协议")?;
    let trimmed = content.trim();
    let clean = trimmed
        .strip_prefix("```json")
        .or_else(|| trimmed.strip_prefix("```"))
        .and_then(|s| s.trim().strip_suffix("```"))
        .unwrap_or(trimmed)
        .trim();
    let value: Value = serde_json::from_str(clean)
        .map_err(|_| "模型未返回有效 JSON。请调整模型或任务要求后重跑；未自动重试")?;
    validate_output(&node.kind, &value)?;
    if node.kind == NodeKind::Storyboard {
        let shots = value["shots"].as_array().ok_or("分镜结构无效")?;
        let total: f64 = shots.iter().filter_map(|s| s["duration"].as_f64()).sum();
        if shots.len() != node.config.shot_count as usize
            || (total - f64::from(node.config.duration)).abs() > 0.5
        {
            return Err("分镜数量或总时长不符合配置，请调整任务要求后重跑；未自动重试".into());
        }
    }
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};

    #[tokio::test]
    async fn discovers_ollama_model_ids_from_tags() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0; 2048];
            let count = stream.read(&mut request).unwrap();
            assert!(String::from_utf8_lossy(&request[..count]).starts_with("GET /api/tags "));
            let body = r#"{"models":[{"name":"gemma4:latest","size":1234}]}"#;
            write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
        });
        let models = list_ollama_models(&format!("http://127.0.0.1:{port}/api"))
            .await
            .unwrap();
        server.join().unwrap();
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].name, "gemma4:latest");
        assert_eq!(models[0].size, 1234);
    }
}
