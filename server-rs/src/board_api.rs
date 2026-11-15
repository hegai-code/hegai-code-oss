//! HTTP for the task board: `GET /api/board`, `POST /api/board/cards/{id}`.
//! Same gates as every other endpoint — a signed-in, ACTIVE viewer; a hand
//! edit is same-origin too. What a viewer sees is the store's business
//! (`board_scope`), never a flag in the web.

use super::*;
use crate::board::{BoardError, BoardFilter, BoardPatch};

const DEFAULT_SINCE_DAYS: i64 = 14;
const MAX_SINCE_DAYS: i64 = 366;

/// `since=7d` / `since=14` (days) / `since=<epoch ms>` → the earliest
/// `lastActivity` to show. Anything unparsable is the default fortnight.
fn since_ms(raw: Option<&str>, now: i64) -> i64 {
    let day = 86_400_000;
    let days = |n: i64| now - n.clamp(1, MAX_SINCE_DAYS) * day;
    let Some(raw) = raw.map(str::trim).filter(|s| !s.is_empty()) else {
        return days(DEFAULT_SINCE_DAYS);
    };
    if let Some(n) = raw.strip_suffix('d').and_then(|d| d.parse::<i64>().ok()) {
        return days(n);
    }
    match raw.parse::<i64>() {
        // A count of days, or an absolute instant (anything past a year's worth
        // of days) — clamped to the same year, so `since=367` cannot read as
        // «367 ms after the epoch» and pull the whole table.
        Ok(n) if n <= MAX_SINCE_DAYS => days(n),
        Ok(n) => n.max(days(MAX_SINCE_DAYS)),
        Err(_) => days(DEFAULT_SINCE_DAYS),
    }
}

pub(crate) async fn api_board(
    State(st): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<HashMap<String, String>>,
) -> Response {
    let user = gate!(authenticated_user(&headers, &st));
    gate!(require_active(&st, &user));
    let admin = st.platform_admins.contains(&user) || st.bootstrap_user_id == user;
    let scope = match st.workspaces.board_scope(&user, admin) {
        Ok(scope) => scope,
        Err(error) => return store_failure(error),
    };
    let owner = params
        .get("owner")
        .map(|o| if o == "me" { user.clone() } else { o.clone() });
    let filter = BoardFilter {
        since_ms: since_ms(params.get("since").map(String::as_str), now_ms()),
        owner: owner.filter(|o| !o.trim().is_empty()),
        project: params
            .get("project")
            .cloned()
            .filter(|p| !p.trim().is_empty()),
        statuses: params.get("status").map(|s| {
            s.split(',')
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
                .collect::<Vec<_>>()
        }),
        archived: matches!(
            params.get("archived").map(String::as_str),
            Some("1" | "true")
        ),
    };
    match st.workspaces.board(&scope, &filter, &st.roadmap) {
        Ok(body) => Json(body).into_response(),
        Err(error) => store_failure(error),
    }
}

pub(crate) async fn api_board_patch_card(
    AxumPath(card_id): AxumPath<String>,
    State(st): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    let user = gate!(mutation_user(&headers, &st));
    gate!(require_active(&st, &user));
    let Some(obj) = body.as_object() else {
        return api_error(StatusCode::BAD_REQUEST, "body must be an object");
    };
    for key in obj.keys() {
        if !matches!(
            key.as_str(),
            "status" | "attention" | "title" | "archived" | "note"
        ) {
            return api_error(StatusCode::BAD_REQUEST, format!("unknown field: {key}"));
        }
    }
    let str_field = |k: &str| -> Result<Option<String>, Response> {
        match obj.get(k) {
            None => Ok(None),
            Some(Value::String(s)) => Ok(Some(s.clone())),
            Some(_) => Err(api_error(
                StatusCode::BAD_REQUEST,
                format!("{k} must be a string"),
            )),
        }
    };
    let patch = BoardPatch {
        status: match str_field("status") {
            Ok(v) => v,
            Err(e) => return e,
        },
        attention: match str_field("attention") {
            Ok(v) => v,
            Err(e) => return e,
        },
        title: match str_field("title") {
            Ok(v) => v,
            Err(e) => return e,
        },
        archived: match obj.get("archived") {
            None => None,
            Some(Value::Bool(b)) => Some(*b),
            Some(_) => return api_error(StatusCode::BAD_REQUEST, "archived must be a boolean"),
        },
        note: match str_field("note") {
            Ok(v) => v.unwrap_or_default(),
            Err(e) => return e,
        },
    };
    let admin = st.platform_admins.contains(&user) || st.bootstrap_user_id == user;
    let scope = match st.workspaces.board_scope(&user, admin) {
        Ok(scope) => scope,
        Err(error) => return store_failure(error),
    };
    // The audit row lands in the actor's own (first) workspace — the same
    // place `session.stage` moves are recorded for that person.
    let workspace_id = match st.workspaces.ui_access(&user, None, admin) {
        Ok(access) => access.workspace_id,
        Err(error) => return store_failure(error),
    };
    match st
        .workspaces
        .board_patch_card(&scope, &workspace_id, &card_id, &patch, &st.roadmap)
    {
        Ok(card) => Json(card).into_response(),
        Err(BoardError::NotFound) => api_error(StatusCode::NOT_FOUND, "card not found"),
        Err(BoardError::Forbidden) => api_error(StatusCode::FORBIDDEN, "forbidden"),
        Err(BoardError::Invalid(message)) => refusal(StatusCode::BAD_REQUEST, message),
        Err(BoardError::Db(message)) => store_failure(message),
    }
}

#[cfg(test)]
mod tests {
    use super::since_ms;

    #[test]
    fn since_accepts_days_suffixed_days_and_instants() {
        let now = 10_000 * 86_400_000;
        assert_eq!(since_ms(None, now), now - 14 * 86_400_000);
        assert_eq!(since_ms(Some("7d"), now), now - 7 * 86_400_000);
        assert_eq!(since_ms(Some("30"), now), now - 30 * 86_400_000);
        assert_eq!(since_ms(Some("junk"), now), now - 14 * 86_400_000);
        assert_eq!(since_ms(Some("1790000000000"), now - 1), 1_790_000_000_000);
        assert_eq!(since_ms(Some("9999d"), now), now - 366 * 86_400_000);
        // An "instant" older than a year is clamped, not honoured.
        assert_eq!(since_ms(Some("367"), now), now - 366 * 86_400_000);
    }
}
