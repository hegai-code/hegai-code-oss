//! Optional Android push backend. Credentials stay on the hub, never in APKs.
use crate::{hub::HubCmd, notify::PushEvent, workspace::now_ms};
use jsonwebtoken::{encode, Algorithm, EncodingKey, Header};
use serde::Deserialize;
use serde_json::{json, Value};
use std::time::{Duration, Instant};
use tokio::sync::mpsc::UnboundedSender;

#[derive(Deserialize)]
struct ServiceAccount {
    project_id: String,
    client_email: String,
    private_key: String,
}
pub struct Fcm {
    project: String,
    email: String,
    key: EncodingKey,
    access: Option<(String, Instant)>,
}
impl Fcm {
    pub fn from_env() -> Option<Self> {
        let path = std::env::var("FCM_SERVICE_ACCOUNT_PATH")
            .ok()
            .filter(|s| !s.is_empty())?;
        let load = || -> Option<Self> {
            let data = std::fs::read(path).ok()?;
            let account: ServiceAccount = serde_json::from_slice(&data).ok()?;
            if account.project_id.is_empty()
                || !account
                    .project_id
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-')
            {
                return None;
            }
            Some(Self {
                project: account.project_id,
                email: account.client_email,
                key: EncodingKey::from_rsa_pem(account.private_key.as_bytes()).ok()?,
                access: None,
            })
        };
        let value = load();
        if value.is_none() {
            eprintln!("[notify] FCM configuration could not be loaded");
        }
        value
    }
    async fn access_token(&mut self, http: &reqwest::Client) -> Option<String> {
        if let Some((token, until)) = &self.access {
            if Instant::now() < *until {
                return Some(token.clone());
            }
        }
        let now = now_ms() / 1000;
        let claims = json!({"iss":self.email,"scope":"https://www.googleapis.com/auth/firebase.messaging",
            "aud":"https://oauth2.googleapis.com/token","iat":now,"exp":now + 3600});
        let assertion = encode(&Header::new(Algorithm::RS256), &claims, &self.key).ok()?;
        let response = http
            .post("https://oauth2.googleapis.com/token")
            .form(&[
                ("grant_type", "urn:ietf:params:oauth:grant-type:jwt-bearer"),
                ("assertion", assertion.as_str()),
            ])
            .send()
            .await
            .ok()?;
        if !response.status().is_success() {
            eprintln!(
                "[notify] FCM credential exchange failed: HTTP {}",
                response.status()
            );
            return None;
        }
        let value: Value = response.json().await.ok()?;
        let token = value.get("access_token")?.as_str()?.to_string();
        let ttl = value
            .get("expires_in")
            .and_then(Value::as_u64)
            .unwrap_or(3600)
            .clamp(60, 3600)
            - 30;
        self.access = Some((token.clone(), Instant::now() + Duration::from_secs(ttl)));
        Some(token)
    }
    pub async fn send(
        &mut self,
        http: &reqwest::Client,
        event: &PushEvent,
        hub: &UnboundedSender<HubCmd>,
    ) {
        let tokens: Vec<&String> = event
            .device_tokens
            .iter()
            .filter(|t| t.starts_with("fcm:"))
            .collect();
        if tokens.is_empty() {
            return;
        }
        let Some(owner) = event.owner_user_id.as_ref() else {
            return;
        };
        for registered in tokens {
            let token = registered.trim_start_matches("fcm:");
            let sent_at = now_ms();
            if self.post_message(http, &payload(event, owner, token)).await
                == FcmOutcome::Unregistered
            {
                let _ = hub.send(HubCmd::PrunePushToken {
                    token: registered.clone(),
                    invalidated_at_ms: Some(sent_at),
                });
            }
        }
    }

    /// POST one fully built FCM message. Shared by the hub's own pushes and by
    /// the push relay (`push_relay.rs`), which builds a content-free message.
    pub async fn post_message(&mut self, http: &reqwest::Client, message: &Value) -> FcmOutcome {
        let Some(access) = self.access_token(http).await else {
            return FcmOutcome::Failed;
        };
        let response = http
            .post(format!(
                "https://fcm.googleapis.com/v1/projects/{}/messages:send",
                self.project
            ))
            .bearer_auth(&access)
            .json(message)
            .send()
            .await;
        match response {
            Ok(response) if response.status().is_success() => FcmOutcome::Sent,
            Ok(response) => {
                let status = response.status();
                if status == reqwest::StatusCode::UNAUTHORIZED {
                    self.access = None;
                }
                let value = response.json::<Value>().await.unwrap_or(Value::Null);
                let unregistered = value
                    .pointer("/error/details")
                    .and_then(Value::as_array)
                    .is_some_and(|rows| {
                        rows.iter().any(|row| {
                            row.get("errorCode").and_then(Value::as_str) == Some("UNREGISTERED")
                        })
                    });
                if unregistered {
                    FcmOutcome::Unregistered
                } else {
                    eprintln!("[notify] FCM send failed: HTTP {status}");
                    FcmOutcome::Failed
                }
            }
            Err(_) => {
                eprintln!("[notify] FCM request failed (network/timeout)");
                FcmOutcome::Failed
            }
        }
    }
}

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum FcmOutcome {
    Sent,
    Unregistered,
    Failed,
}
fn payload(event: &PushEvent, owner: &str, token: &str) -> Value {
    // Data-only delivery lets the app reject a stale account before displaying it.
    // Never send message bodies or tool inputs to the notification provider.
    json!({"message":{"token":token,"android":{"priority":"high","ttl":"300s"},"data":{
        "workspaceId":event.workspace_id.clone().unwrap_or_default(),"userId":owner,"runId":event.run_id,"machineId":event.machine_id,"sessionId":event.session_id,
        "title":event.title.chars().take(180).collect::<String>(),"state":event.state,
        "requestId":event.request_id.clone().unwrap_or_default(),"tool":event.tool.clone().unwrap_or_default(),
        // A private machine's decisions are sealed: the phone offers no one-tap action for it (docs/E2EE.md).
        "private":if event.content.private { "true" } else { "false" }
    }}})
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn notification_is_data_only_and_contains_no_conversation_or_tool_input() {
        let event = PushEvent {
            run_id: "r".into(),
            title: "я".repeat(300),
            machine: "Mac".into(),
            machine_id: "m".into(),
            session_id: "s".into(),
            state: "needs_attention".into(),
            request_id: Some("q".into()),
            tool: Some("Bash".into()),
            device_tokens: vec![],
            owner_user_id: Some("u".into()),
            workspace_id: Some("w".into()),
            content: Default::default(),
        };
        let value = payload(&event, "u", "t");
        assert!(value["message"].get("notification").is_none());
        let data = &value["message"]["data"];
        assert_eq!(data["userId"], "u");
        assert_eq!(data["workspaceId"], "w");
        assert_eq!(data["title"].as_str().unwrap().chars().count(), 180);
        assert!(data.get("input").is_none());
        assert!(data.get("text").is_none());
        assert!(data.as_object().unwrap().values().all(Value::is_string));
        assert_eq!(data["private"], "false");
        let mut private = event.clone();
        private.content.private = true;
        assert_eq!(
            payload(&private, "u", "t")["message"]["data"]["private"],
            "true"
        );
    }
}
