use std::collections::HashSet;

use serde::{Deserialize, Serialize};

/// Server-owned editorial grouping used by the iOS Roadmap/Map views.
/// Operators can replace the whole value with `CC_REMOTE_ROADMAP_CONFIG` JSON
/// without shipping a new mobile build.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RoadmapConfig {
    pub groups: Vec<RoadmapGroup>,
    pub unassigned: RoadmapLabel,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RoadmapGroup {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub blurb: String,
    pub projects: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RoadmapLabel {
    pub name: String,
    #[serde(default)]
    pub blurb: String,
}

impl Default for RoadmapConfig {
    fn default() -> Self {
        Self {
            groups: vec![
                group(
                    "platform",
                    "a.test — платформа",
                    "Сообщество, CRM, платежи, нетворкинг, сайт",
                    &["hegai", "hegaivc", "a.test", "www"],
                ),
                group(
                    "media",
                    "hegai.media",
                    "AI-новости: пайплайн, редакция, дистрибуция",
                    &["hegaismi", "hegaimedia"],
                ),
                group(
                    "messenger",
                    "Мессенджер",
                    "iOS · Android · macOS клиенты сообщества",
                    &["hegassenger"],
                ),
                group(
                    "ccremote",
                    "cc-remote",
                    "Пульт управления Claude-сессиями",
                    &["claudehegai"],
                ),
                group(
                    "health",
                    "Здоровье",
                    "EBM-ассистент: питание, носимые, анализы",
                    &["hegaihealth"],
                ),
                group(
                    "higgsfield",
                    "Higgsfield",
                    "Generation-UI + Instagram-тренды",
                    &["higgsfield"],
                ),
                group(
                    "transcribe",
                    "Транскрибация",
                    "голос, Zoom-транскрипты",
                    &["whisphegai", "capitan", "hegaivoice"],
                ),
                group(
                    "experiments",
                    "Эксперименты",
                    "Прототипы, вспышки, заморожённое",
                    &["meditation", "crypto", "rbtrg", "chatapp", "rental-app"],
                ),
                group(
                    "misc",
                    "Прочее",
                    "Инфраструктура и разовые сессии",
                    &["root", "scratchpad", "wsl"],
                ),
            ],
            unassigned: RoadmapLabel {
                name: "Без проекта".into(),
                blurb: "Сессии без рабочей папки (headless / cron)".into(),
            },
        }
    }
}

fn group(id: &str, name: &str, blurb: &str, projects: &[&str]) -> RoadmapGroup {
    RoadmapGroup {
        id: id.into(),
        name: name.into(),
        blurb: blurb.into(),
        projects: projects.iter().map(|project| (*project).into()).collect(),
    }
}

pub fn parse_roadmap_config(raw: &str) -> Result<RoadmapConfig, String> {
    let mut config: RoadmapConfig =
        serde_json::from_str(raw).map_err(|error| format!("invalid JSON: {error}"))?;
    normalize_and_validate(&mut config)?;
    Ok(config)
}

pub fn load_roadmap_config() -> RoadmapConfig {
    let Ok(raw) = std::env::var("CC_REMOTE_ROADMAP_CONFIG") else {
        return RoadmapConfig::default();
    };
    if raw.trim().is_empty() {
        return RoadmapConfig::default();
    }
    match parse_roadmap_config(&raw) {
        Ok(config) => config,
        Err(error) => {
            eprintln!("[server-rs] invalid CC_REMOTE_ROADMAP_CONFIG ({error}); using defaults");
            RoadmapConfig::default()
        }
    }
}

fn normalize_and_validate(config: &mut RoadmapConfig) -> Result<(), String> {
    if config.unassigned.name.trim().is_empty() {
        return Err("unassigned.name must not be empty".into());
    }
    config.unassigned.name = config.unassigned.name.trim().to_string();
    config.unassigned.blurb = config.unassigned.blurb.trim().to_string();

    let mut ids = HashSet::new();
    let mut projects = HashSet::new();
    for group in &mut config.groups {
        group.id = group.id.trim().to_lowercase();
        group.name = group.name.trim().to_string();
        group.blurb = group.blurb.trim().to_string();
        if group.id.is_empty() || group.name.is_empty() {
            return Err("every group requires a non-empty id and name".into());
        }
        if !ids.insert(group.id.clone()) {
            return Err(format!("duplicate group id: {}", group.id));
        }
        for project in &mut group.projects {
            *project = project.trim().to_lowercase();
            if project.is_empty() {
                return Err(format!(
                    "group {} contains an empty project alias",
                    group.id
                ));
            }
            if !projects.insert(project.clone()) {
                return Err(format!("duplicate project alias: {project}"));
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn custom_config_is_normalized() {
        let config = parse_roadmap_config(
            r#"{
              "groups":[{"id":" Product ","name":" Product ","projects":[" Repo "]}],
              "unassigned":{"name":" Other "}
            }"#,
        )
        .unwrap();
        assert_eq!(config.groups[0].id, "product");
        assert_eq!(config.groups[0].projects, ["repo"]);
        assert_eq!(config.unassigned.name, "Other");
    }

    #[test]
    fn duplicate_aliases_are_rejected() {
        let error = parse_roadmap_config(
            r#"{
              "groups":[
                {"id":"one","name":"One","projects":["same"]},
                {"id":"two","name":"Two","projects":["SAME"]}
              ],
              "unassigned":{"name":"Other"}
            }"#,
        )
        .unwrap_err();
        assert!(error.contains("duplicate project alias"));
    }
}
