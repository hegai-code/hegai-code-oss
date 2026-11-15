//! `GET /api/public-config` — what the sign-in screen may know before anyone
//! is signed in: which edition this is, what to call it, and which ways in are
//! switched on. Nothing secret and nothing per-person; the web fetches it once
//! at boot and draws only the buttons that work.

use super::*;

/// Which ways in this hub offers.
pub(crate) struct AuthMethods {
    pub local: bool,
    pub google: bool,
    pub github: bool,
    pub telegram: bool,
    pub apple: bool,
    /// The configured OIDC provider's display name.
    pub oidc: Option<String>,
    pub hegai_sso: bool,
}

/// Whether this hub's install commands can hand out the desktop app: ours
/// always (it serves `/dl`), a self-hosted one only when its operator set
/// `CC_REMOTE_APP_DL` (it has no `/dl`, and the public snapshot does not name
/// ours). The web offers the app only when this is true.
pub(crate) fn desktop_apps(edition: &str, app_dl_set: bool) -> bool {
    edition == "internal" || app_dl_set
}

/// The wire shape (`PublicConfig` in shared/src/web-protocol.ts). Optional
/// fields are absent, never null.
pub(crate) fn build(
    edition: &str,
    brand_name: &str,
    public_url: &str,
    methods: &AuthMethods,
) -> Value {
    let mut auth = json!({
        "local": methods.local,
        "google": methods.google,
        "github": methods.github,
        "telegram": methods.telegram,
        "apple": methods.apple,
        "hegaiSso": methods.hegai_sso,
    });
    if let Some(name) = &methods.oidc {
        auth["oidc"] = json!({"name": name});
    }
    json!({
        "edition": edition,
        "brandName": brand_name,
        "publicUrl": public_url,
        "auth": auth,
        "desktopApps": desktop_apps(edition, crate::selfhost::app_download_base().is_some()),
    })
}

pub(crate) async fn api_public_config(State(st): State<AppState>) -> Response {
    let methods = AuthMethods {
        local: local_login::enabled(),
        google: st.google_auth.is_some(),
        github: st.github_auth.is_some(),
        telegram: st.tg_login.is_some(),
        apple: st.apple_auth.is_some(),
        oidc: st.oidc_auth.as_ref().map(|o| o.name.clone()),
        hegai_sso: st.sso_secret.is_some(),
    };
    let mut response = Json(build(
        edition::current().as_str(),
        &local_login::brand_name(),
        st.public_url.trim_end_matches('/'),
        &methods,
    ))
    .into_response();
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
    response
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::account::tests::{app_state, cleanup, temp_db};

    fn none() -> AuthMethods {
        AuthMethods {
            local: false,
            google: false,
            github: false,
            telegram: false,
            apple: false,
            oidc: None,
            hegai_sso: false,
        }
    }

    #[test]
    fn the_shape_has_no_nulls_and_oidc_is_absent_when_unconfigured() {
        let v = build("external", "Acme Code", "https://code.acme.test", &none());
        assert_eq!(v["edition"], "external");
        assert_eq!(v["brandName"], "Acme Code");
        assert_eq!(v["publicUrl"], "https://code.acme.test");
        assert_eq!(v["auth"]["local"], false);
        assert!(v["auth"].get("oidc").is_none());
        let with = AuthMethods {
            local: true,
            oidc: Some("Acme SSO".into()),
            ..none()
        };
        let v = build("external", "Acme Code", "https://code.acme.test", &with);
        assert_eq!(v["auth"]["local"], true);
        assert_eq!(v["auth"]["oidc"], json!({"name": "Acme SSO"}));
        assert!(!v.to_string().contains("null"));
    }

    #[tokio::test]
    async fn the_endpoint_needs_no_session_and_reports_the_hub() {
        let db = temp_db();
        let st = app_state(WorkspaceStore::open(&db).unwrap(), &db);
        let res = api_public_config(State(st)).await;
        assert_eq!(res.status(), StatusCode::OK);
        let body: Value = serde_json::from_slice(
            &axum::body::to_bytes(res.into_body(), 1 << 16)
                .await
                .unwrap(),
        )
        .unwrap();
        assert_eq!(body["edition"], "internal");
        assert_eq!(body["publicUrl"], "http://127.0.0.1:4319");
        assert_eq!(body["auth"]["google"], false);
        assert_eq!(body["auth"]["github"], false);
        assert_eq!(body["auth"]["hegaiSso"], false);
        cleanup(&db);
    }

    #[test]
    fn desktop_apps_only_where_the_hub_can_hand_them_out() {
        assert!(desktop_apps("internal", false));
        assert!(!desktop_apps("external", false));
        assert!(desktop_apps("external", true));
    }
}
