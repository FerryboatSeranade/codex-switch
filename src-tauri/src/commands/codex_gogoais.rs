use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::time::Duration;

const DEFAULT_LOGIN_BASE_URL: &str = "https://totp.gogoais.com/api";
const DEFAULT_CODE_BASE_URL: &str = "https://code.gogoais.com";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexGogoaisLoginInput {
    account: String,
    password: String,
    login_base_url: Option<String>,
    code_base_url: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexGogoaisLoginResult {
    api_key: String,
    base_url: String,
    login_base_url: String,
}

#[tauri::command]
pub async fn codex_gogoais_login(
    input: CodexGogoaisLoginInput,
) -> Result<CodexGogoaisLoginResult, String> {
    let account = input.account.trim();
    if account.is_empty() {
        return Err("请输入账号".to_string());
    }
    if input.password.is_empty() {
        return Err("请输入密码".to_string());
    }

    let login_base_url = normalize_base_url(
        input
            .login_base_url
            .as_deref()
            .unwrap_or(DEFAULT_LOGIN_BASE_URL),
    );
    let code_base_url = normalize_base_url(
        input
            .code_base_url
            .as_deref()
            .unwrap_or(DEFAULT_CODE_BASE_URL),
    );

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|err| format!("创建登录客户端失败: {err}"))?;

    let api_key = request_gogoais_api_key(&client, &login_base_url, account, &input.password)
        .await
        .map_err(|err| format!("GogoAI 登录失败: {err}"))?;

    Ok(CodexGogoaisLoginResult {
        api_key,
        base_url: codex_openai_base_url(&code_base_url),
        login_base_url,
    })
}

async fn request_gogoais_api_key(
    client: &reqwest::Client,
    login_base_url: &str,
    account: &str,
    password: &str,
) -> Result<String, String> {
    let payloads = [
        json!({ "username": account, "password": password }),
        json!({ "account": account, "password": password }),
        json!({ "email": account, "password": password }),
    ];
    let mut attempts = Vec::new();

    for endpoint in login_endpoint_candidates(login_base_url) {
        for payload in &payloads {
            let response = client
                .post(&endpoint)
                .header(reqwest::header::ACCEPT, "application/json")
                .json(payload)
                .send()
                .await;

            match response {
                Ok(response) => {
                    let status = response.status();
                    let text = response.text().await.unwrap_or_else(|_| String::new());

                    if !status.is_success() {
                        attempts.push(format!(
                            "{} -> HTTP {} {}",
                            endpoint,
                            status.as_u16(),
                            sanitize_response_excerpt(&text),
                        ));
                        continue;
                    }

                    let json: Value = serde_json::from_str(&text).map_err(|_| {
                        format!(
                            "{} 返回非 JSON: {}",
                            endpoint,
                            sanitize_response_excerpt(&text)
                        )
                    })?;

                    if api_response_is_error(&json) {
                        attempts.push(format!(
                            "{} -> {}",
                            endpoint,
                            api_error_message(&json)
                                .unwrap_or_else(|| "接口返回登录失败".to_string())
                        ));
                        continue;
                    }

                    if let Some(api_key) = extract_api_key(&json) {
                        return Ok(api_key);
                    }

                    if let Some(token) = extract_auth_token(&json) {
                        match request_bound_service_api_key(client, login_base_url, &token).await {
                            Ok(api_key) => return Ok(api_key),
                            Err(err) => attempts.push(format!("{endpoint} -> {err}")),
                        }
                    }

                    attempts.push(format!("{endpoint} -> 响应里没有找到 API Key"));
                }
                Err(err) => {
                    attempts.push(format!("{endpoint} -> {err}"));
                }
            }
        }
    }

    Err(if attempts.is_empty() {
        "没有可用登录接口".to_string()
    } else {
        attempts.join("; ")
    })
}

async fn request_bound_service_api_key(
    client: &reqwest::Client,
    login_base_url: &str,
    token: &str,
) -> Result<String, String> {
    let mut attempts = Vec::new();

    for endpoint in bind_list_endpoint_candidates(login_base_url) {
        let response = client
            .get(&endpoint)
            .header(reqwest::header::ACCEPT, "application/json")
            .bearer_auth(token)
            .send()
            .await;

        match response {
            Ok(response) => {
                let status = response.status();
                let text = response.text().await.unwrap_or_else(|_| String::new());

                if !status.is_success() {
                    attempts.push(format!(
                        "{} -> HTTP {} {}",
                        endpoint,
                        status.as_u16(),
                        sanitize_response_excerpt(&text),
                    ));
                    continue;
                }

                let json: Value = serde_json::from_str(&text).map_err(|_| {
                    format!(
                        "{} 返回非 JSON: {}",
                        endpoint,
                        sanitize_response_excerpt(&text)
                    )
                })?;

                if api_response_is_error(&json) {
                    attempts.push(format!(
                        "{} -> {}",
                        endpoint,
                        api_error_message(&json)
                            .unwrap_or_else(|| "接口返回服务绑定查询失败".to_string())
                    ));
                    continue;
                }

                if let Some(api_key) = extract_bound_service_api_key(&json) {
                    return Ok(api_key);
                }

                attempts.push(format!("{endpoint} -> 绑定服务里没有找到 API Key"));
            }
            Err(err) => attempts.push(format!("{endpoint} -> {err}")),
        }
    }

    Err(if attempts.is_empty() {
        "登录成功，但没有可用绑定服务接口".to_string()
    } else {
        format!("登录成功，但绑定服务查询失败: {}", attempts.join("; "))
    })
}

fn login_endpoint_candidates(login_base_url: &str) -> Vec<String> {
    let base = login_base_url.trim_end_matches('/');
    let mut urls = vec![join_url(base, "central/login")];
    urls.extend(
        ["api/central/login", "login", "api/login", "api/auth/login"]
            .iter()
            .map(|path| join_url(base, path)),
    );
    urls.dedup();
    urls
}

fn bind_list_endpoint_candidates(login_base_url: &str) -> Vec<String> {
    let base = login_base_url.trim_end_matches('/');
    let mut urls = vec![join_url(base, "bind/list")];
    urls.extend(
        ["api/bind/list", "user/bind/list", "central/bind/list"]
            .iter()
            .map(|path| join_url(base, path)),
    );
    urls.dedup();
    urls
}

fn join_url(base: &str, path: &str) -> String {
    format!(
        "{}/{}",
        base.trim_end_matches('/'),
        path.trim_start_matches('/')
    )
}

fn normalize_base_url(raw: &str) -> String {
    raw.trim()
        .trim_end_matches('/')
        .replace("https://code/gogoais.com", DEFAULT_CODE_BASE_URL)
}

fn codex_openai_base_url(raw: &str) -> String {
    let base = raw
        .trim_end_matches('/')
        .strip_suffix("/v1")
        .unwrap_or(raw.trim_end_matches('/'));
    format!("{base}/v1")
}

fn api_response_is_error(value: &Value) -> bool {
    let code = value
        .get("code")
        .or_else(|| value.pointer("/error/code"))
        .and_then(|code| {
            code.as_i64()
                .or_else(|| code.as_str().and_then(|text| text.parse::<i64>().ok()))
        });

    matches!(code, Some(code) if !matches!(code, 0 | 200 | 1000))
        || value.get("success").and_then(Value::as_bool) == Some(false)
}

fn api_error_message(value: &Value) -> Option<String> {
    [
        "/message",
        "/msg",
        "/error",
        "/error/message",
        "/data/message",
        "/data/error",
    ]
    .iter()
    .find_map(|pointer| value.pointer(pointer).and_then(Value::as_str))
    .map(|message| message.trim().to_string())
    .filter(|message| !message.is_empty())
}

fn extract_api_key(value: &Value) -> Option<String> {
    const KEY_NAMES: &[&str] = &[
        "OPENAI_API_KEY",
        "openai_api_key",
        "api_key",
        "apiKey",
        "key",
    ];

    match value {
        Value::Object(map) => {
            if let Some(service_type) = object_service_type(map) {
                if !is_supported_api_service_type(&service_type) {
                    return None;
                }
            }

            for key_name in KEY_NAMES {
                if let Some(text) = map.get(*key_name).and_then(Value::as_str) {
                    let trimmed = text.trim();
                    if is_usable_key(trimmed) {
                        return Some(trimmed.to_string());
                    }
                }
            }

            for child in map.values() {
                if let Some(api_key) = extract_api_key(child) {
                    return Some(api_key);
                }
            }
            None
        }
        Value::Array(items) => items.iter().find_map(extract_api_key),
        Value::String(_) => None,
        _ => None,
    }
}

fn extract_auth_token(value: &Value) -> Option<String> {
    const TOKEN_NAMES: &[&str] = &[
        "token",
        "access_token",
        "accessToken",
        "auth_token",
        "authToken",
        "jwt",
    ];

    match value {
        Value::Object(map) => {
            for key_name in TOKEN_NAMES {
                if let Some(text) = map.get(*key_name).and_then(Value::as_str) {
                    let trimmed = text.trim();
                    if is_usable_key(trimmed) {
                        return Some(trimmed.to_string());
                    }
                }
            }

            for child in map.values() {
                if let Some(token) = extract_auth_token(child) {
                    return Some(token);
                }
            }
            None
        }
        Value::Array(items) => items.iter().find_map(extract_auth_token),
        _ => None,
    }
}

fn extract_bound_service_api_key(value: &Value) -> Option<String> {
    match value {
        Value::Object(map) => {
            if object_service_type(map)
                .as_deref()
                .map(is_supported_api_service_type)
                .unwrap_or(false)
            {
                if let Some(api_key) = extract_api_key(value) {
                    return Some(api_key);
                }
            }

            for child in map.values() {
                if let Some(api_key) = extract_bound_service_api_key(child) {
                    return Some(api_key);
                }
            }
            None
        }
        Value::Array(items) => items.iter().find_map(extract_bound_service_api_key),
        _ => None,
    }
}

fn object_service_type(map: &serde_json::Map<String, Value>) -> Option<String> {
    map.get("service_type")
        .or_else(|| map.get("serviceType"))
        .and_then(Value::as_str)
        .map(|service_type| service_type.to_ascii_lowercase())
}

fn is_supported_api_service_type(service_type: &str) -> bool {
    matches!(
        service_type,
        "gpt" | "codex" | "openai" | "openai_api" | "gpt_api" | "code"
    )
}

fn is_usable_key(value: &str) -> bool {
    let lowered = value.to_ascii_lowercase();
    value.len() >= 16
        && !value.contains(char::is_whitespace)
        && !matches!(
            lowered.as_str(),
            "true" | "false" | "success" | "ok" | "null" | "undefined"
        )
}

fn sanitize_response_excerpt(text: &str) -> String {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    let mut excerpt = trimmed.chars().take(240).collect::<String>();
    if trimmed.chars().count() > 240 {
        excerpt.push_str("...");
    }
    mask_secret_like_values(&excerpt)
}

fn mask_secret_like_values(text: &str) -> String {
    text.split_whitespace()
        .map(|part| {
            if is_usable_key(part.trim_matches(['"', '\'', ',', ':', '{', '}'])) {
                "***".to_string()
            } else {
                part.to_string()
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codex_openai_base_url_appends_v1_once() {
        assert_eq!(
            codex_openai_base_url("https://code.gogoais.com"),
            "https://code.gogoais.com/v1"
        );
        assert_eq!(
            codex_openai_base_url("https://code.gogoais.com/v1"),
            "https://code.gogoais.com/v1"
        );
    }

    #[test]
    fn extract_api_key_reads_nested_common_fields() {
        let value = json!({
            "code": 200,
            "data": {
                "user": { "username": "demo" },
                "apiKey": "sk-gogoais-test-token"
            }
        });
        assert_eq!(
            extract_api_key(&value),
            Some("sk-gogoais-test-token".to_string())
        );
    }

    #[test]
    fn login_token_is_not_treated_as_api_key() {
        let value = json!({
            "code": 200,
            "token": "login-token-value-with-enough-length"
        });
        assert_eq!(extract_api_key(&value), None);
        assert_eq!(
            extract_auth_token(&value),
            Some("login-token-value-with-enough-length".to_string())
        );
    }

    #[test]
    fn api_key_extraction_ignores_unsupported_services() {
        let value = json!({
            "data": {
                "service_bindings": [
                    {
                        "service_type": "ads",
                        "service_detail": { "api_key": "sk-ignore-this-key" }
                    },
                    {
                        "service_type": "gpt",
                        "service_detail": { "api_key": "sk-use-this-gpt-key" }
                    }
                ]
            }
        });
        assert_eq!(
            extract_api_key(&value),
            Some("sk-use-this-gpt-key".to_string())
        );
    }

    #[test]
    fn bound_service_api_key_prefers_supported_services() {
        let value = json!({
            "data": {
                "service_bindings": [
                    {
                        "service_type": "ads",
                        "service_detail": { "api_key": "sk-ignore-this-key" }
                    },
                    {
                        "service_type": "gpt",
                        "service_detail": { "api_key": "sk-use-this-gpt-key" }
                    }
                ]
            }
        });
        assert_eq!(
            extract_bound_service_api_key(&value),
            Some("sk-use-this-gpt-key".to_string())
        );
    }
}
