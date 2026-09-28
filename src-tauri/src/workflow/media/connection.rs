//! Read-only cloud connection checks. A catalog response proves authentication,
//! but does not guarantee permission or available balance for a generation call.
use reqwest::{Client, Url};
use serde::Serialize;
use serde_json::Value;
use std::time::Duration;

use crate::workflow::types::AppResult;

const CATALOG_LIMIT: usize = 1024 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionCheck {
    pub status: &'static str,
    pub message: String,
    pub model_listed: Option<bool>,
}

fn result(
    status: &'static str,
    message: impl Into<String>,
    model_listed: Option<bool>,
) -> ConnectionCheck {
    ConnectionCheck {
        status,
        message: message.into(),
        model_listed,
    }
}

pub async fn check_catalog(
    url: Url,
    key: &str,
    model: &str,
    provider: &str,
) -> AppResult<ConnectionCheck> {
    let client = Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|_| "无法初始化云端连接")?;
    let response = match client.get(url).bearer_auth(key).send().await {
        Ok(response) => response,
        Err(error) if error.is_timeout() => {
            return Ok(result("unavailable", "连接超时，请检查网络后重试。", None))
        }
        Err(_) => {
            return Ok(result(
                "unavailable",
                "连接失败，请检查网络和服务状态。",
                None,
            ))
        }
    };
    let status = response.status().as_u16();
    if !response.status().is_success() {
        return Ok(match status {
            401 | 403 => result(
                "auth_failed",
                "认证或地区不匹配，请检查 API Key、服务地区和账户权限。",
                None,
            ),
            429 => result(
                "rate_limited",
                "服务返回限流或配额错误，请稍后重试或检查账户额度。",
                None,
            ),
            300..=399 => result("unavailable", "服务返回重定向，连接检查已停止。", None),
            _ => result(
                "unavailable",
                format!("服务返回 HTTP {status}，请稍后重试。"),
                None,
            ),
        });
    }
    if response
        .content_length()
        .is_some_and(|size| size > CATALOG_LIMIT as u64)
    {
        return Ok(result(
            "invalid_response",
            "模型目录响应过大，未完成验证。",
            None,
        ));
    }
    let mut response = response;
    let mut bytes = Vec::new();
    loop {
        match response.chunk().await {
            Ok(Some(chunk)) => {
                if bytes.len() + chunk.len() > CATALOG_LIMIT {
                    return Ok(result(
                        "invalid_response",
                        "模型目录响应过大，未完成验证。",
                        None,
                    ));
                }
                bytes.extend_from_slice(&chunk);
            }
            Ok(None) => break,
            Err(_) => return Ok(result("unavailable", "模型目录响应中断，请重试。", None)),
        }
    }
    let Ok(data) = serde_json::from_slice::<Value>(&bytes) else {
        return Ok(result(
            "invalid_response",
            "模型目录响应格式无效，未完成验证。",
            None,
        ));
    };
    let listed = match provider {
        "openai" => data.get("data").and_then(Value::as_array).map(|models| {
            models
                .iter()
                .any(|item| item.get("id").and_then(Value::as_str) == Some(model))
        }),
        "wan" => {
            if data.get("success").and_then(Value::as_bool) != Some(true) {
                return Ok(result(
                    "invalid_response",
                    "模型目录未确认成功，未完成验证。",
                    None,
                ));
            }
            data.pointer("/output/models")
                .and_then(Value::as_array)
                .map(|models| {
                    models
                        .iter()
                        .any(|item| item.get("model").and_then(Value::as_str) == Some(model))
                })
        }
        _ => None,
    };
    Ok(match listed {
        Some(true) => result("connected", "密钥认证通过，当前模型出现在目录中。生成权限与额度仍需在实际生成时确认。", Some(true)),
        Some(false) => result("model_not_listed", "密钥认证通过，但当前模型未出现在目录中。请核对模型 ID、地区和开通状态；生成权限尚未确认。", Some(false)),
        None => result("invalid_response", "模型目录缺少预期字段，未完成验证。", None),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn connection_status_serializes_without_key() {
        let value = serde_json::to_value(result("connected", "ok", Some(true))).unwrap();
        assert_eq!(value["status"], "connected");
        assert_eq!(value["modelListed"], true);
        assert!(value.get("key").is_none());
    }
}
