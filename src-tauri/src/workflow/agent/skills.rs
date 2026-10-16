//! Portable instruction skills. Downloaded documents guide existing media tools.
use super::super::*;
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{path::Path, time::Duration};
use tauri::Manager;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Skill {
    pub id: String,
    pub name: String,
    pub description: String,
    pub source: String,
    pub sha256: String,
    pub enabled: bool,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RemoteSkill {
    pub repository: String,
    pub path: String,
    pub sha: String,
    pub name: String,
}
const BUILTINS:[(&str,&str,&str);3]=[
    ("anime-story","动漫编剧","根据用户目标创作完整中文动漫剧本。明确主人公、欲望、障碍和情绪变化，用可拍摄动作表达故事。短片减少人物与场景数量，提供清晰结尾；用户给定的设定优先。"),
    ("character-continuity","角色与场景连续性","为全片固定角色脸型、发色、服装、体型、道具和画风。相邻分镜承接动作与道具状态，不重新设计人物。参考图作为造型依据，提示词重复必要外观约束。"),
    ("cinematic-storyboard","连续分镜导演","按总时长编排分镜。每镜头明确主体、场景、动作、景别、运镜、光影、对白和衔接关系。单次视频请求使用按时间排列的连续叙事；提示词不要求九宫格或分镜板。一次短片只表现少量清楚动作。"),
];
fn directory(state: &WorkflowState) -> std::path::PathBuf {
    state.directory.join("agent").join("skills")
}
fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 100 && id.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-')
}
fn hash(body: &str) -> String {
    format!("{:x}", Sha256::digest(body.as_bytes()))
}
pub fn init(state: &WorkflowState) -> AppResult<()> {
    let root = directory(state);
    std::fs::create_dir_all(&root).map_err(|_| "创建技能目录失败")?;
    for (id, name, body) in BUILTINS {
        let folder = root.join(id);
        if folder.join("manifest.json").exists() {
            continue;
        }
        let content = format!("---\nname: {id}\ndescription: {name}\n---\n\n# {name}\n\n{body}\n");
        persist(
            &folder,
            &content,
            &Skill {
                id: id.into(),
                name: name.into(),
                description: body.into(),
                source: "Frame Studio 内置".into(),
                sha256: hash(&content),
                enabled: true,
            },
        )?;
    }
    Ok(())
}
fn persist(folder: &Path, content: &str, skill: &Skill) -> AppResult<()> {
    std::fs::create_dir_all(folder).map_err(|_| "创建技能文件夹失败")?;
    std::fs::write(folder.join("SKILL.md"), content).map_err(|_| "保存技能失败")?;
    std::fs::write(
        folder.join("manifest.json"),
        serde_json::to_vec_pretty(skill).map_err(|e| e.to_string())?,
    )
    .map_err(|_| "保存技能来源失败".into())
}
pub fn catalog(state: &WorkflowState) -> AppResult<Vec<Skill>> {
    let mut items = vec![];
    for entry in std::fs::read_dir(directory(state))
        .map_err(|_| "技能目录尚未就绪")?
        .take(200)
    {
        let entry = entry.map_err(|_| "读取技能目录失败")?;
        if !entry.file_type().map_err(|_| "技能文件类型无效")?.is_dir() {
            continue;
        }
        let bytes =
            std::fs::read(entry.path().join("manifest.json")).map_err(|_| "技能来源记录缺失")?;
        let skill: Skill = serde_json::from_slice(&bytes).map_err(|_| "技能来源记录损坏")?;
        if valid_id(&skill.id) && entry.file_name().to_string_lossy() == skill.id {
            items.push(skill)
        }
    }
    items.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(items)
}
pub fn instructions(state: &WorkflowState, ids: &[String]) -> AppResult<String> {
    if ids.len() > 5 {
        return Err("一次创作最多加载五项技能".into());
    }
    let catalog = catalog(state)?;
    let mut out = String::new();
    for id in ids {
        let skill = catalog
            .iter()
            .find(|s| s.id == *id && s.enabled)
            .ok_or("技能已停用或不存在")?;
        let bytes = std::fs::read(directory(state).join(&skill.id).join("SKILL.md"))
            .map_err(|_| "技能文档缺失")?;
        if bytes.len() > 48_000 {
            return Err("技能文档超过 48 KB".into());
        }
        let body = String::from_utf8(bytes).map_err(|_| "技能文档需为 UTF-8")?;
        if hash(&body) != skill.sha256 {
            return Err("技能内容已变化，请重新安装后使用".into());
        }
        out.push_str(&format!(
            "\n<skill name={:?}>\n{}\n</skill>\n",
            skill.name, body
        ));
    }
    if out.len() > 120_000 {
        return Err("本次技能总量过大，请减少启用数量".into());
    }
    Ok(out)
}
#[tauri::command]
pub fn list_agent_skills(state: tauri::State<WorkflowState>) -> AppResult<Vec<Skill>> {
    catalog(&state)
}
#[tauri::command]
pub fn set_agent_skill_enabled(
    state: tauri::State<WorkflowState>,
    id: String,
    enabled: bool,
) -> AppResult<()> {
    let mut skill = catalog(&state)?
        .into_iter()
        .find(|s| s.id == id)
        .ok_or("技能不存在")?;
    skill.enabled = enabled;
    std::fs::write(
        directory(&state)
            .join(skill.id.clone())
            .join("manifest.json"),
        serde_json::to_vec_pretty(&skill).map_err(|e| e.to_string())?,
    )
    .map_err(|_| "保存技能设置失败".into())
}
fn validate_repository(repo: &str) -> AppResult<()> {
    let parts: Vec<_> = repo.split('/').collect();
    if parts.len() != 2
        || parts.iter().any(|p| {
            p.is_empty()
                || *p == "."
                || *p == ".."
                || p.len() > 100
                || !p
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || b"-_ .".contains(&c) && c != b' ')
        })
    {
        return Err("仓库格式为 owner/repository".into());
    }
    Ok(())
}
async fn github(path: &str) -> AppResult<Value> {
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(25))
        .build()
        .map_err(|_| "技能连接初始化失败")?;
    let mut response = client
        .get(format!("https://api.github.com/{path}"))
        .header("User-Agent", "Frame-Studio-Agent")
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|_| "技能仓库连接失败，请稍后重试")?;
    if !response.status().is_success() {
        return Err(format!(
            "技能仓库返回 HTTP {}，可稍后重试或更换公开仓库",
            response.status().as_u16()
        ));
    }
    let mut bytes = vec![];
    while let Some(chunk) = response.chunk().await.map_err(|_| "技能下载中断")? {
        if bytes.len() + chunk.len() > 4_000_000 {
            return Err("技能索引超过大小限制".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| "技能仓库响应格式无效".into())
}
#[tauri::command]
pub async fn search_agent_skills(repository: String, query: String) -> AppResult<Vec<RemoteSkill>> {
    validate_repository(&repository)?;
    if query.len() > 120 {
        return Err("搜索词过长".into());
    }
    let data = github(&format!("repos/{repository}/git/trees/HEAD?recursive=1")).await?;
    if data["truncated"] == true {
        return Err("仓库索引过大，请使用较小的技能仓库".into());
    }
    let q = query.to_lowercase();
    let terms = match q.as_str() {
        "动漫" | "视频" => vec!["cinema", "video", "story", "image"],
        "分镜" | "运镜" => vec!["cinema", "storyboard"],
        _ => vec![q.as_str()],
    };
    Ok(data["tree"]
        .as_array()
        .ok_or("仓库树格式无效")?
        .iter()
        .filter_map(|item| {
            let path = item["path"].as_str()?;
            if item["type"] != "blob"
                || !path.ends_with("/SKILL.md")
                || !terms.iter().any(|term| path.to_lowercase().contains(term))
            {
                return None;
            }
            Some(RemoteSkill {
                repository: repository.clone(),
                path: path.into(),
                sha: item["sha"].as_str()?.into(),
                name: path
                    .trim_end_matches("/SKILL.md")
                    .rsplit('/')
                    .next()?
                    .into(),
            })
        })
        .take(30)
        .collect())
}
fn metadata(content: &str) -> AppResult<(String, String)> {
    let content = content.trim_start_matches('\u{feff}').replace("\r\n", "\n");
    let front = content
        .strip_prefix("---\n")
        .and_then(|s| s.split_once("\n---"))
        .map(|(f, _)| f)
        .ok_or("需要包含 name 和 description 的 SKILL.md 文档")?;
    let field = |key: &str| {
        let lines: Vec<_> = front.lines().collect();
        let index = lines
            .iter()
            .position(|l| l.starts_with(&format!("{key}:")))?;
        let value = lines[index]
            .strip_prefix(&format!("{key}:"))?
            .trim()
            .trim_matches(['\'', '"']);
        let value = if matches!(value, "|" | ">" | "|-" | ">-") {
            lines
                .iter()
                .skip(index + 1)
                .take_while(|l| l.starts_with(' ') || l.starts_with('\t') || l.trim().is_empty())
                .map(|l| l.trim())
                .collect::<Vec<_>>()
                .join(" ")
        } else {
            value.to_owned()
        };
        (!value.trim().is_empty()).then_some(value)
    };
    let name = field("name").ok_or("技能缺少 name")?;
    let description = field("description").ok_or("技能缺少 description")?;
    if name.len() > 160 || description.len() > 3000 {
        return Err("技能名称或描述过长".into());
    }
    Ok((name, description))
}
#[tauri::command]
pub async fn install_agent_skill(app: tauri::AppHandle, remote: RemoteSkill) -> AppResult<Skill> {
    validate_repository(&remote.repository)?;
    if remote.sha.len() != 40
        || !remote.sha.bytes().all(|c| c.is_ascii_hexdigit())
        || !remote.path.ends_with("/SKILL.md")
        || remote.path.len() > 500
        || remote.path.split('/').any(|p| p == ".." || p.is_empty())
    {
        return Err("技能来源无效".into());
    }
    let data = github(&format!(
        "repos/{}/git/blobs/{}",
        remote.repository, remote.sha
    ))
    .await?;
    if data["sha"].as_str() != Some(&remote.sha)
        || data["encoding"] != "base64"
        || data["size"].as_u64().is_none_or(|n| n > 48_000)
    {
        return Err("技能文档信息无效或过大".into());
    }
    let encoded = data["content"]
        .as_str()
        .ok_or("技能内容缺失")?
        .split_whitespace()
        .collect::<String>();
    let content = String::from_utf8(STANDARD.decode(encoded).map_err(|_| "技能内容解码失败")?)
        .map_err(|_| "技能需使用 UTF-8")?;
    if content.len() > 48_000 {
        return Err("技能文档超过 48 KB".into());
    }
    let (name, description) = metadata(&content)?;
    let sha256 = hash(&content);
    let id = format!("download-{}", &sha256[..24]);
    let skill = Skill {
        id: id.clone(),
        name,
        description,
        source: format!("{}/{} @ {}", remote.repository, remote.path, remote.sha),
        sha256,
        enabled: true,
    };
    let state = app.state::<WorkflowState>();
    persist(&directory(&state).join(id), &content, &skill)?;
    Ok(skill)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn skill_sources_are_bounded_and_document_format_is_required() {
        assert!(validate_repository("fal-ai-community/skills").is_ok());
        for repo in ["../x", "x/y/z", "https://github.com/x/y", "x/a?token=x"] {
            assert!(validate_repository(repo).is_err())
        }
        assert!(metadata("---\nname: cinema\ndescription: Planning\n---\nBody").is_ok());
        assert!(metadata("# Just arbitrary text").is_err());
        assert!(!valid_id("../x"));
    }
}
