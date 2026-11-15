use super::*;

const T0: i64 = 1_793_000_000_000; // 2026-10-26 ~08:53 UTC

fn row(id: &str, ts: i64, key: &str, model: &str, status: &str, p: u64, c: u64) -> LogRow {
    LogRow {
        id: id.into(),
        ts_ms: ts,
        key_name: key.into(),
        model: model.into(),
        status: status.into(),
        prompt: p,
        completion: c,
        cached: 0,
    }
}

/// One page as its own pass (no unfinished row carried in from earlier pages).
fn ing(conn: &Connection, rows: &[LogRow], now: i64) -> Result<IngestStats, String> {
    ingest(conn, rows, now, &mut None)
}

fn mem() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    init_schema(&conn).unwrap();
    conn
}

#[test]
fn log_page_drops_bodies_and_the_embedded_key() {
    let body = r#"{"logs":[
      {"id":"a","timestamp":"2026-10-26T08:00:00.123456789Z","model":"gpt-x","status":"success",
       "virtual_key_name":"hegai:Ann@Example.com",
       "raw_request":"SECRET PROMPT TEXT","raw_response":"SECRET ANSWER TEXT",
       "virtual_key":{"value":"sk-bf-TOPSECRET","name":"hegai:ann@example.com"},
       "token_usage":{"prompt_tokens":100,"completion_tokens":20,"total_tokens":120,
                      "prompt_tokens_details":{"cached_tokens":40}}},
      {"id":"b","timestamp":"2026-10-26T08:00:01Z","status":"error","virtual_key_name":null},
      {"timestamp":"2026-10-26T08:00:02Z","status":"success"}
    ],"pagination":{"limit":200}}"#;
    let (rows, raw) = parse_logs_page(body).unwrap();
    assert_eq!(raw, 3, "a row without an id still counts for paging");
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0].prompt, 100);
    assert_eq!(rows[0].completion, 20);
    assert_eq!(rows[0].cached, 40);
    assert_eq!(rows[1].model, "unknown");
    assert_eq!(rows[1].prompt, 0);
    let dump = format!("{rows:?}");
    for leak in ["SECRET PROMPT", "SECRET ANSWER", "TOPSECRET"] {
        assert!(!dump.contains(leak), "{leak} must not be kept");
    }
    assert!(parse_logs_page("not json").is_err());
}

#[test]
fn key_names_map_to_emails_and_service_keys_stay_named() {
    assert_eq!(key_email("hegai:Ann@Example.com"), "ann@example.com");
    assert_eq!(key_email("hegai:service-shop-app"), "");
    assert_eq!(key_email("hegai:service-x@y"), "");
    assert_eq!(key_email("agent:server-codex"), "");
    assert_eq!(key_email(""), "");
}

#[test]
fn ingest_aggregates_once_per_log_id_and_keeps_the_cursor() {
    let conn = mem();
    let page = vec![
        row("1", T0, "hegai:ann@x.io", "m1", "success", 100, 10),
        row("2", T0 + 1000, "hegai:ann@x.io", "m1", "error", 0, 0),
        row("3", T0 + 2000, "hegai:ann@x.io", "m2", "success", 5, 5),
        row("4", T0 + 3000, "hegai:service-bot", "m1", "success", 7, 1),
    ];
    let s = ing(&conn, &page, T0 + 10_000).unwrap();
    assert_eq!((s.folded, s.duplicates), (4, 0));
    assert_eq!(cursor_ms(&conn), Some(T0 + 3000));

    // The look-back re-reads the same rows plus one new one: no double count.
    let mut again = page.clone();
    again.push(row("5", T0 + 4000, "hegai:ann@x.io", "m1", "success", 1, 1));
    let s = ing(&conn, &again, T0 + 10_000).unwrap();
    assert_eq!((s.folded, s.duplicates), (1, 4));
    assert_eq!(cursor_ms(&conn), Some(T0 + 4000));

    let (req, err, prompt, completion): (i64, i64, i64, i64) = conn
        .query_row(
            "SELECT requests,errors,prompt_tokens,completion_tokens FROM llm_usage_daily WHERE virtual_key_name='hegai:ann@x.io' AND model='m1'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .unwrap();
    assert_eq!((req, err, prompt, completion), (3, 1, 101, 11));
    let service: String = conn
        .query_row(
            "SELECT email FROM llm_usage_daily WHERE virtual_key_name='hegai:service-bot'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(service, "");
}

#[test]
fn a_log_still_processing_is_counted_when_it_finishes() {
    let conn = mem();
    let running = row("1", T0, "hegai:ann@x.io", "m1", "processing", 0, 0);
    ing(&conn, &[running], T0).unwrap();
    assert_eq!(cursor_ms(&conn), None, "an unfinished row moves nothing");
    let done = row("1", T0, "hegai:ann@x.io", "m1", "success", 9, 1);
    let s = ing(&conn, &[done], T0).unwrap();
    assert_eq!(s.folded, 1);
}

#[test]
fn a_late_written_log_behind_the_cursor_is_still_folded() {
    let conn = mem();
    ing(
        &conn,
        &[row(
            "new",
            T0 + 600_000,
            "hegai:a@x.io",
            "m",
            "success",
            1,
            1,
        )],
        T0 + 600_000,
    )
    .unwrap();
    // A long stream that began before the cursor and was written after it.
    let s = ing(
        &conn,
        &[row(
            "old",
            T0 + 100_000,
            "hegai:a@x.io",
            "m",
            "success",
            2,
            2,
        )],
        T0 + 600_000,
    )
    .unwrap();
    assert_eq!(s.folded, 1);
    assert_eq!(
        cursor_ms(&conn),
        Some(T0 + 600_000),
        "the cursor never moves back"
    );
}

#[test]
fn days_split_at_utc_midnight_and_old_days_are_pruned() {
    let conn = mem();
    let midnight = parse_rfc3339_ms("2026-10-27T00:00:00Z").unwrap();
    let now = midnight + 1000;
    ing(
        &conn,
        &[
            row("1", midnight - 1, "hegai:a@x.io", "m", "success", 1, 0),
            row("2", midnight, "hegai:a@x.io", "m", "success", 1, 0),
            row(
                "3",
                now - (RETENTION_DAYS + 2) * DAY_MS,
                "hegai:a@x.io",
                "m",
                "success",
                1,
                0,
            ),
        ],
        now,
    )
    .unwrap();
    let days: Vec<String> = conn
        .prepare("SELECT day FROM llm_usage_daily ORDER BY day")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .filter_map(Result::ok)
        .collect();
    assert_eq!(days, vec!["2026-10-26", "2026-10-27"]);
}

#[test]
fn subscription_samples_keep_latest_and_peak_and_flag_frequent_limits() {
    let s = WorkspaceStore::open_memory();
    let usage = |pct: f64| {
        json!({"account":"Me@X.io","updatedAt":1,"limits":[
            {"key":"session","label":"Session (5hr)","percent":pct,"resetsAt":T0+3_600_000},
            {"key":"weekly_all","label":"Weekly","percent":10.0}]})
    };
    record_subscription_sample(&s, "u1", "m1", "claude", &usage(50.0), T0).unwrap();
    record_subscription_sample(&s, "u1", "m1", "claude", &usage(95.0), T0 + 1000).unwrap();
    record_subscription_sample(&s, "u1", "m1", "claude", &usage(20.0), T0 + 2000).unwrap();
    record_subscription_sample(&s, "u1", "m1", "claude", &usage(92.0), T0 + DAY_MS).unwrap();
    let from = day_of(T0);
    let to = day_of(T0 + DAY_MS);
    let (subs, frequent) = {
        let conn = s.conn.lock().unwrap();
        subscriptions_section(&conn, "u1", &from, &to).unwrap()
    };
    assert!(frequent, "session hit 90+ on two days");
    assert_eq!(subs.len(), 1);
    assert_eq!(subs[0]["provider"], "claude");
    assert_eq!(subs[0]["account"], "me@x.io");
    let w = subs[0]["windows"].as_array().unwrap();
    assert_eq!(w[0]["key"], "session", "session sorts first");
    assert_eq!(w[0]["percent"], 92.0, "latest reading, not the peak");
    assert_eq!(w[0]["peakPercent"], 95.0);
    assert_eq!(w[0]["hitDays"], 2);
    assert_eq!(w[0]["resetsAt"], T0 + 3_600_000);
    assert_eq!(w[1]["hitDays"], 0);
    assert!(w[1].get("resetsAt").is_none(), "absent, never null");
}

#[test]
fn legacy_and_empty_usage_shapes() {
    let legacy = json!({"fiveHour":{"utilization":30.0,"resetsAt":5},"sevenDay":{"utilization":60.0},"updatedAt":1});
    let w = usage_windows(&legacy);
    assert_eq!(w.len(), 2);
    assert_eq!(w[0].0, "session");
    assert_eq!(w[1].2, 60.0);
    assert!(usage_windows(&json!({"updatedAt": 1})).is_empty());
    let s = WorkspaceStore::open_memory();
    record_subscription_sample(&s, "u", "m1", "codex", &json!({"updatedAt":1}), T0).unwrap();
}

#[test]
fn old_samples_are_dropped() {
    let s = WorkspaceStore::open_memory();
    let u = json!({"limits":[{"key":"session","label":"s","percent":1.0}]});
    record_subscription_sample(&s, "u", "m1", "claude", &u, T0 - 100 * DAY_MS).unwrap();
    record_subscription_sample(&s, "u", "m1", "claude", &u, T0).unwrap();
    let n: i64 = s
        .conn
        .lock()
        .unwrap()
        .query_row("SELECT COUNT(*) FROM sub_limit_samples", [], |r| r.get(0))
        .unwrap();
    assert_eq!(n, 1);
}

#[test]
fn an_empty_reading_retires_the_old_limit_and_a_new_one_revives_it() {
    let s = WorkspaceStore::open_memory();
    let u = json!({"limits":[{"key":"session","label":"s","percent":80.0}]});
    let (from, to) = (day_of(T0), day_of(T0 + DAY_MS));
    let subs = |s: &WorkspaceStore| {
        let conn = s.conn.lock().unwrap();
        subscriptions_section(&conn, "u", &from, &to).unwrap().0
    };
    record_subscription_sample(&s, "u", "m1", "codex", &u, T0).unwrap();
    record_subscription_sample(&s, "u", "m1", "claude", &u, T0).unwrap();
    assert_eq!(subs(&s).len(), 2);
    record_subscription_sample(&s, "u", "m1", "codex", &json!({"updatedAt":1}), T0 + 1000).unwrap();
    let left = subs(&s);
    assert_eq!(left.len(), 1, "codex limit is gone, claude stays");
    assert_eq!(left[0]["provider"], "claude");
    record_subscription_sample(&s, "u", "m1", "codex", &u, T0 + 2000).unwrap();
    assert_eq!(subs(&s).len(), 2);
}

#[test]
fn an_empty_reading_from_another_machine_keeps_this_machines_limit() {
    let s = WorkspaceStore::open_memory();
    let u = json!({"limits":[{"key":"session","label":"s","percent":80.0}]});
    let (from, to) = (day_of(T0), day_of(T0 + DAY_MS));
    let subs = |s: &WorkspaceStore| {
        let conn = s.conn.lock().unwrap();
        subscriptions_section(&conn, "u", &from, &to)
            .unwrap()
            .0
            .len()
    };
    record_subscription_sample(&s, "u", "m1", "codex", &u, T0).unwrap();
    record_subscription_sample(&s, "u", "m2", "codex", &json!({"updatedAt":1}), T0 + 1000).unwrap();
    assert_eq!(
        subs(&s),
        1,
        "m2 going to the gateway does not hide m1's limit"
    );
    record_subscription_sample(&s, "u", "m1", "codex", &json!({"updatedAt":1}), T0 + 2000).unwrap();
    assert_eq!(subs(&s), 0);
}

#[test]
fn a_log_finishing_after_erasure_does_not_bring_the_person_back() {
    let conn = mem();
    conn.execute(
        "INSERT INTO llm_usage_erased(email_sha256,erased_at) VALUES(?1,?2)",
        params![erased_key("Ann@X.io"), T0 + 5],
    )
    .unwrap();
    let s = ing(
        &conn,
        &[
            row("1", T0, "hegai:ann@x.io", "m", "success", 5, 5),
            row("2", T0, "hegai:bob@x.io", "m", "success", 5, 5),
        ],
        T0 + 10,
    )
    .unwrap();
    assert_eq!(s.folded, 1);
    let n: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM llm_usage_daily WHERE email='ann@x.io'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(n, 0);
    // A request that started after the erasure (a new account, same address) counts.
    let s = ing(
        &conn,
        &[row("3", T0 + 6, "hegai:ann@x.io", "m", "success", 1, 1)],
        T0 + 10,
    )
    .unwrap();
    assert_eq!(s.folded, 1);
}

fn team() -> (WorkspaceStore, String) {
    let s = WorkspaceStore::open_memory();
    for (id, email) in [
        ("owner", "o@x.io"),
        ("mgr", "m@x.io"),
        ("ann", "ann@x.io"),
        ("bob", "bob@x.io"),
        ("out", "out@x.io"),
    ] {
        s.ensure_user(id, email, None).unwrap();
    }
    let w = s.create_organization("owner", "Team", "owner").unwrap();
    let wid = w["workspaceId"].as_str().unwrap().to_string();
    for (id, email, role) in [
        ("mgr", "m@x.io", "manager"),
        ("ann", "ann@x.io", "member"),
        ("bob", "bob@x.io", "member"),
    ] {
        let inv = s.invite("owner", &wid, email, role).unwrap();
        s.accept_invitation(id, inv["token"].as_str().unwrap())
            .unwrap();
    }
    s.assign_manager("owner", &wid, "mgr", "member", "ann")
        .unwrap();
    (s, wid)
}

fn ids(subjects: &[Subject]) -> Vec<String> {
    let mut v: Vec<_> = subjects.iter().map(|s| s.user_id.clone()).collect();
    v.sort();
    v
}

#[test]
fn owner_sees_all_manager_sees_assigned_member_sees_self() {
    let (s, wid) = team();
    let (scope, all) = s.usage_subjects("owner", &wid).unwrap();
    assert_eq!(scope, "all");
    assert_eq!(ids(&all), ["ann", "bob", "mgr", "owner"]);
    let (scope, mine) = s.usage_subjects("mgr", &wid).unwrap();
    assert_eq!(scope, "assigned");
    assert_eq!(ids(&mine), ["ann", "mgr"], "bob is not assigned");
    let (scope, me) = s.usage_subjects("bob", &wid).unwrap();
    assert_eq!(scope, "self");
    assert_eq!(ids(&me), ["bob"]);
    assert!(
        s.usage_subjects("out", &wid).is_err(),
        "outsiders get nothing"
    );
}

#[test]
fn report_shape_merges_gateway_limits_and_samples() {
    let (s, _) = team();
    {
        let conn = s.conn.lock().unwrap();
        ing(
            &conn,
            &[
                row("1", T0, "hegai:ann@x.io", "gpt-a", "success", 1000, 200),
                row("2", T0 + 1, "hegai:ann@x.io", "gpt-b", "error", 0, 0),
                row("3", T0 + 2, "hegai:bob@x.io", "gpt-a", "success", 7, 7),
            ],
            T0 + 10,
        )
        .unwrap();
    }
    record_subscription_sample(
        &s,
        "ann",
        "m1",
        "codex",
        &json!({"limits":[{"key":"session","label":"5h","percent":40.0}]}),
        T0,
    )
    .unwrap();
    let ann = Subject {
        user_id: "ann".into(),
        email: Some("ann@x.io".into()),
        full_name: None,
        role: "member".into(),
    };
    let mut limits = HashMap::new();
    limits.insert(
        "hegai:ann@x.io".to_string(),
        SeatLimit {
            is_active: true,
            rate_limit: json!({"token_max_limit": 2000, "token_current_usage": 500, "token_reset_duration": "1d",
                               "token_last_reset": "2026-10-26T00:00:00Z"}),
        },
    );
    let r = build_report(
        &s,
        "assigned",
        &[ann],
        Some(&limits),
        &day_of(T0),
        &day_of(T0),
        T0,
    )
    .unwrap();
    assert_eq!(r["configured"], true);
    assert_eq!(r["scope"], "assigned");
    assert!(r.get("limitsUnavailable").is_none());
    assert_eq!(r["collectedAt"], T0 + 2);
    let m = &r["members"][0];
    assert_eq!(m["email"], "ann@x.io");
    assert_eq!(m["gateway"]["requests"], 2);
    assert_eq!(m["gateway"]["errors"], 1);
    assert_eq!(m["gateway"]["totalTokens"], 1200);
    assert_eq!(m["gateway"]["models"][0]["model"], "gpt-a");
    assert_eq!(m["gateway"]["days"][0]["tokens"], 1200);
    assert_eq!(m["limit"]["percent"], 25.0);
    assert_eq!(m["limit"]["active"], true);
    assert_eq!(m["subscriptions"][0]["provider"], "codex");
    assert_eq!(m["hitsLimit"], false);
    assert!(m.get("fullName").is_none(), "absent, never null");

    let none = build_report(&s, "self", &[], None, &day_of(T0), &day_of(T0), T0).unwrap();
    assert_eq!(none["limitsUnavailable"], true);
}

#[test]
fn each_window_expires_on_its_own_clock() {
    let now = parse_rfc3339_ms("2026-10-26T05:00:00Z").unwrap();
    // Tokens window reset long ago; the request window is still running.
    let seat = SeatLimit {
        is_active: true,
        rate_limit: json!({
            "token_max_limit": 1000, "token_current_usage": 900,
            "token_last_reset": "2026-10-26T00:00:00Z", "token_reset_duration": "1h",
            "request_max_limit": 10, "request_current_usage": 9,
            "request_last_reset": "2026-10-26T04:30:00Z", "request_reset_duration": "1h"}),
    };
    let v = seat_limit_value(&seat, now);
    assert_eq!(v["tokensUsed"], 0, "expired token window reads unused");
    assert_eq!(v["requestsUsed"], 9, "live request window keeps its count");
    assert_eq!(v["percent"], 90.0);
    assert_eq!(
        v["resetAt"],
        parse_rfc3339_ms("2026-10-26T01:00:00Z").unwrap()
    );
    assert_eq!(
        v["requestsResetAt"],
        parse_rfc3339_ms("2026-10-26T05:30:00Z").unwrap()
    );

    // Only the request window expired: tokens still count.
    let seat = SeatLimit {
        is_active: true,
        rate_limit: json!({
            "token_max_limit": 1000, "token_current_usage": 500,
            "token_last_reset": "2026-10-26T04:30:00Z", "token_reset_duration": "1h",
            "request_max_limit": 10, "request_current_usage": 9,
            "request_last_reset": "2026-10-26T00:00:00Z", "request_reset_duration": "1h"}),
    };
    let v = seat_limit_value(&seat, now);
    assert_eq!(v["requestsUsed"], 0);
    assert_eq!(v["tokensUsed"], 500);
    assert_eq!(v["percent"], 50.0);
}

#[test]
fn the_viewer_carries_llm_usage_only_when_a_gateway_is_configured() {
    let mut s = WorkspaceStore::open_memory();
    s.ensure_user("u", "u@x.io", None).unwrap();
    assert!(s
        .ui_access("u", None, false)
        .unwrap()
        .viewer
        .get("llmUsage")
        .is_none());
    s.enable_llm_usage();
    assert_eq!(
        s.ui_access("u", None, false).unwrap().viewer["llmUsage"],
        true
    );
}

#[test]
fn periods_validate() {
    let now = parse_rfc3339_ms("2026-10-30T12:00:00Z").unwrap();
    assert_eq!(
        parse_period(None, None, now).unwrap(),
        ("2026-10-24".into(), "2026-10-30".into())
    );
    assert!(parse_period(Some("2026-10-30"), Some("2026-10-01"), now).is_err());
    assert!(parse_period(Some("nope"), None, now).is_err());
    assert!(parse_period(Some("2026-01-01"), Some("2026-10-30"), now).is_err());
    assert!(parse_period(Some("2026-10-01"), Some("2026-10-30"), now).is_ok());
}

#[test]
fn an_unfinished_row_holds_the_cursor_until_it_finishes() {
    let conn = mem();
    // One pass, two pages: a stream still running at T0, then rows 30 min later.
    let mut hold = None;
    let now = T0 + 30 * 60_000;
    ingest(
        &conn,
        &[row("long", T0, "hegai:a@x.io", "m", "processing", 0, 0)],
        now,
        &mut hold,
    )
    .unwrap();
    ingest(
        &conn,
        &[row("later", now, "hegai:a@x.io", "m", "success", 1, 1)],
        now,
        &mut hold,
    )
    .unwrap();
    let c = cursor_ms(&conn).unwrap();
    assert!(
        c - LOOKBACK_MS <= T0,
        "the next pass must re-read the running row (cursor {c})"
    );
    // Next pass: the stream finished; the already counted row is not counted again.
    let s = ing(
        &conn,
        &[
            row("long", T0, "hegai:a@x.io", "m", "success", 5, 5),
            row("later", now, "hegai:a@x.io", "m", "success", 1, 1),
        ],
        now + 600_000,
    )
    .unwrap();
    assert_eq!((s.folded, s.duplicates), (1, 1));
    assert_eq!(
        cursor_ms(&conn),
        Some(now),
        "released once nothing is running"
    );
}

#[test]
fn a_row_stuck_unfinished_stops_holding_after_two_hours() {
    let conn = mem();
    let now = T0 + HOLD_MAX_MS + 60_000;
    ing(
        &conn,
        &[
            row("stuck", T0, "hegai:a@x.io", "m", "processing", 0, 0),
            row("fresh", now, "hegai:a@x.io", "m", "success", 1, 1),
        ],
        now,
    )
    .unwrap();
    assert_eq!(cursor_ms(&conn), Some(now));
}

#[test]
fn usage_follows_the_account_not_a_reused_address() {
    let (s, _) = team();
    {
        let conn = s.conn.lock().unwrap();
        ing(
            &conn,
            &[row("1", T0, "hegai:ann@x.io", "m", "success", 100, 0)],
            T0 + 10,
        )
        .unwrap();
        // ann leaves the address; a new account takes it.
        conn.execute(
            "UPDATE users SET email='ann-old@x.io' WHERE user_id='ann'",
            [],
        )
        .unwrap();
    }
    s.ensure_user("newcomer", "ann@x.io", None).unwrap();
    let conn = s.conn.lock().unwrap();
    let (from, to) = (day_of(T0), day_of(T0));
    let mine = gateway_section(&conn, "newcomer", &from, &to).unwrap();
    assert_eq!(
        mine["requests"], 0,
        "the newcomer does not see ann's history: {mine}"
    );
    let anns = gateway_section(&conn, "ann", &from, &to).unwrap();
    assert_eq!(anns["requests"], 1);
}
