use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::time::Duration;

const DEFAULT_KEY_ENDPOINT: &str = "https://x-api.gogoais.com/api/public/codex-key";
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

#[derive(Debug, Clone, PartialEq, Eq)]
struct GogoaisCodexKey {
    api_key: String,
    base_url: Option<String>,
    openai_base_url: Option<String>,
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

    let key_endpoint = resolve_key_endpoint(input.login_base_url.as_deref());
    let fallback_code_base_url = normalize_base_url(
        input
            .code_base_url
            .as_deref()
            .unwrap_or(DEFAULT_CODE_BASE_URL),
    );

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|err| format!("创建登录客户端失败: {err}"))?;

    let key = request_gogoais_codex_key(&client, &key_endpoint, account, &input.password)
        .await
        .map_err(|err| format!("GogoAI 登录失败: {err}"))?;

    let code_base_url = key
        .base_url
        .or(key.openai_base_url)
        .map(|base_url| normalize_base_url(&base_url))
        .unwrap_or(fallback_code_base_url);

    Ok(CodexGogoaisLoginResult {
        api_key: key.api_key,
        base_url: codex_openai_base_url(&code_base_url),
        login_base_url: key_endpoint,
    })
}

async fn request_gogoais_codex_key(
    client: &reqwest::Client,
    endpoint: &str,
    account: &str,
    password: &str,
) -> Result<GogoaisCodexKey, String> {
    let response = client
        .get(endpoint)
        .query(&[("username", account), ("password", password)])
        .header(reqwest::header::ACCEPT, "application/json")
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .send()
        .await
        .map_err(|err| format!("{endpoint} -> {err}"))?;

    let status = response.status();
    let text = response.text().await.unwrap_or_else(|_| String::new());
    let parsed_body = serde_json::from_str::<Value>(&text).ok();

    if !status.is_success() {
        return Err(format!(
            "{} -> {}",
            endpoint,
            gogoais_error_message(status, parsed_body.as_ref()),
        ));
    }

    let value = parsed_body.ok_or_else(|| {
        format!(
            "{} 返回非 JSON: {}",
            endpoint,
            sanitize_response_excerpt(&text)
        )
    })?;

    if value
        .get("success")
        .and_then(Value::as_bool)
        .is_some_and(|success| !success)
    {
        return Err(format!(
            "{} -> {}",
            endpoint,
            gogoais_error_message(status, Some(&value)),
        ));
    }

    let api_key = string_at(&value, &["data", "codex", "api_key"])
        .or_else(|| string_at(&value, &["data", "codex", "sk"]))
        .ok_or_else(|| format!("{endpoint} -> gogoais 响应里没有 data.codex.api_key"))?;

    if api_key.trim().is_empty() {
        return Err(format!("{endpoint} -> gogoais 返回了空 API Key"));
    }

    Ok(GogoaisCodexKey {
        api_key,
        base_url: string_at(&value, &["data", "codex", "base_url"]),
        openai_base_url: string_at(&value, &["data", "codex", "openai_base_url"]),
    })
}

fn resolve_key_endpoint(raw: Option<&str>) -> String {
    let Some(raw) = raw.map(str::trim).filter(|value| !value.is_empty()) else {
        return DEFAULT_KEY_ENDPOINT.to_string();
    };

    if raw.contains("x-api.gogoais.com") || raw.ends_with("/codex-key") {
        raw.trim_end_matches('/').to_string()
    } else {
        DEFAULT_KEY_ENDPOINT.to_string()
    }
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

fn string_at(value: &Value, path: &[&str]) -> Option<String> {
    let mut current = value;
    for key in path {
        current = current.get(*key)?;
    }
    current
        .as_str()
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(ToString::to_string)
}

fn gogoais_error_message(status: reqwest::StatusCode, value: Option<&Value>) -> String {
    let message = value
        .and_then(|parsed| {
            string_at(parsed, &["error"])
                .or_else(|| string_at(parsed, &["message"]))
                .or_else(|| string_at(parsed, &["detail"]))
                .or_else(|| string_at(parsed, &["data", "error"]))
                .or_else(|| string_at(parsed, &["data", "message"]))
        })
        .unwrap_or_else(|| status.to_string());

    let lower = message.to_ascii_lowercase();
    if status == reqwest::StatusCode::UNAUTHORIZED || lower.contains("invalid username or password")
    {
        "gogoais 账号或密码不正确，请检查后重试。".to_string()
    } else {
        format!("gogoais 获取失败：{}", sanitize_response_excerpt(&message))
    }
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

fn is_usable_key(value: &str) -> bool {
    let lowered = value.to_ascii_lowercase();
    value.len() >= 16
        && !value.contains(char::is_whitespace)
        && !matches!(
            lowered.as_str(),
            "true" | "false" | "success" | "ok" | "null" | "undefined"
        )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

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
    fn resolve_key_endpoint_ignores_legacy_login_url() {
        assert_eq!(
            resolve_key_endpoint(Some("https://totp.gogoais.com/api")),
            DEFAULT_KEY_ENDPOINT
        );
        assert_eq!(
            resolve_key_endpoint(Some("https://x-api.gogoais.com/api/public/codex-key/")),
            DEFAULT_KEY_ENDPOINT
        );
    }

    #[test]
    fn string_at_reads_nested_text() {
        let value = json!({
            "data": {
                "codex": {
                    "api_key": " sk-gogoais-test-token "
                }
            }
        });
        assert_eq!(
            string_at(&value, &["data", "codex", "api_key"]),
            Some("sk-gogoais-test-token".to_string())
        );
    }

    #[test]
    fn gogoais_error_message_handles_bad_credentials() {
        let value = json!({ "error": "invalid username or password" });
        assert_eq!(
            gogoais_error_message(reqwest::StatusCode::BAD_REQUEST, Some(&value)),
            "gogoais 账号或密码不正确，请检查后重试。"
        );
    }

    #[test]
    fn gogoais_error_message_reads_api_message() {
        let value = json!({ "message": "service unavailable" });
        assert_eq!(
            gogoais_error_message(reqwest::StatusCode::OK, Some(&value)),
            "gogoais 获取失败：service unavailable"
        );
    }

    #[test]
    fn sanitize_response_excerpt_masks_keys() {
        assert_eq!(
            sanitize_response_excerpt(r#"{"api_key":"sk-secret-value-1234567890"}"#),
            "***"
        );
    }
}
