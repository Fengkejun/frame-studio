use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet, VecDeque};

pub type AppResult<T> = Result<T, String>;

pub fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
pub fn uid() -> String {
    uuid::Uuid::new_v4().to_string()
}

#[derive(Clone, Serialize, Deserialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum NodeKind {
    Brief,
    Story,
    Storyboard,
    Prompt,
    Image,
    Video,
}

#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NodeConfig {
    pub text: String,
    pub provider_id: String,
    pub instructions: String,
    pub temperature: f64,
    pub shot_count: u32,
    pub duration: u32,
}
#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(deny_unknown_fields)]
pub struct Position {
    pub x: f64,
    pub y: f64,
}
#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Artifact {
    pub id: String,
    pub kind: NodeKind,
    pub value: Value,
    pub created_at: u64,
    pub source: String,
}
#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(deny_unknown_fields)]
pub struct WorkflowNode {
    pub id: String,
    pub kind: NodeKind,
    pub label: String,
    pub position: Position,
    pub config: NodeConfig,
    pub output: Option<Artifact>,
    pub stale: bool,
}
#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(deny_unknown_fields)]
pub struct WorkflowEdge {
    pub id: String,
    pub source: String,
    pub target: String,
}
#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(deny_unknown_fields)]
pub struct Viewport {
    pub x: f64,
    pub y: f64,
    pub zoom: f64,
}
#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Workflow {
    pub schema_version: u32,
    pub id: String,
    pub name: String,
    pub nodes: Vec<WorkflowNode>,
    pub edges: Vec<WorkflowEdge>,
    pub viewport: Viewport,
    pub updated_at: u64,
}

#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Provider {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub base_url: String,
    pub model: String,
    pub has_key: bool,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeRun {
    pub node_id: String,
    pub status: String,
    pub message: String,
    pub output: Option<Artifact>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunRecord {
    pub id: String,
    pub workflow_id: String,
    pub started_at: u64,
    pub finished_at: Option<u64>,
    pub status: String,
    pub snapshot: Workflow,
    pub providers: Vec<Provider>,
    pub nodes: Vec<NodeRun>,
}

pub fn compatible(source: &NodeKind, target: &NodeKind) -> bool {
    match target {
        NodeKind::Brief => false,
        NodeKind::Story => matches!(source, NodeKind::Brief | NodeKind::Prompt),
        NodeKind::Storyboard => *source == NodeKind::Story,
        NodeKind::Prompt => matches!(
            source,
            NodeKind::Brief | NodeKind::Story | NodeKind::Storyboard
        ),
        NodeKind::Image => *source == NodeKind::Storyboard,
        NodeKind::Video => *source == NodeKind::Image,
    }
}

/// Saving allows an unfinished graph; execution additionally requires every input.
pub fn validate_graph(w: &Workflow, executable: bool) -> AppResult<Vec<String>> {
    if w.schema_version != 1
        || w.id.is_empty()
        || w.id.len() > 128
        || w.name.trim().is_empty()
        || w.name.len() > 300
    {
        return Err("工作流版本或名称无效".into());
    }
    if w.nodes.is_empty()
        || w.nodes.len() > 100
        || w.edges.len() > 200
        || serde_json::to_vec(w).map_err(|_| "工作流无法序列化")?.len() > 4_000_000
    {
        return Err("工作流需包含 1–100 个节点，文件不能超过 4 MB".into());
    }
    let nodes: HashMap<_, _> = w.nodes.iter().map(|n| (n.id.as_str(), n)).collect();
    if nodes.len() != w.nodes.len() {
        return Err("节点 ID 重复".into());
    }
    for n in &w.nodes {
        if n.id.is_empty()
            || n.id.len() > 128
            || n.label.len() > 200
            || n.config.text.len() > 32_000
            || n.config.instructions.len() > 12_000
            || !(0.0..=2.0).contains(&n.config.temperature)
            || !(1..=24).contains(&n.config.shot_count)
            || !(1..=600).contains(&n.config.duration)
            || !n.position.x.is_finite()
            || !n.position.y.is_finite()
        {
            return Err(format!("节点「{}」参数无效或超过限制", n.label));
        }
        if let Some(a) = &n.output {
            validate_output(&n.kind, &a.value)?;
        }
    }
    let mut degree: HashMap<&str, usize> = nodes.keys().map(|&id| (id, 0)).collect();
    let mut edge_ids = HashSet::new();
    for e in &w.edges {
        let s = nodes.get(e.source.as_str()).ok_or("连线起点不存在")?;
        let t = nodes.get(e.target.as_str()).ok_or("连线终点不存在")?;
        if !edge_ids.insert(&e.id) || e.source == e.target || !compatible(&s.kind, &t.kind) {
            return Err("连线重复、循环或端口类型不兼容".into());
        }
        let d = degree.get_mut(e.target.as_str()).ok_or("连线终点不存在")?;
        *d += 1;
        if *d > 1 {
            return Err("每个节点目前只能连接一个上游输入".into());
        }
    }
    if executable {
        for n in &w.nodes {
            if n.kind != NodeKind::Brief && degree[n.id.as_str()] == 0 {
                return Err(format!("请连接「{}」的输入", n.label));
            }
            if n.kind == NodeKind::Brief && n.config.text.trim().is_empty() {
                return Err("请填写创作需求".into());
            }
        }
    }
    let mut queue: VecDeque<&str> = w
        .nodes
        .iter()
        .filter(|n| degree[n.id.as_str()] == 0)
        .map(|n| n.id.as_str())
        .collect();
    let mut order = vec![];
    while let Some(id) = queue.pop_front() {
        order.push(id.to_string());
        for e in w.edges.iter().filter(|e| e.source == id) {
            let d = degree.get_mut(e.target.as_str()).ok_or("连线终点不存在")?;
            *d -= 1;
            if *d == 0 {
                queue.push_back(&e.target);
            }
        }
    }
    if order.len() != w.nodes.len() {
        return Err("工作流中存在循环，请断开循环连线".into());
    }
    Ok(order)
}

fn required_text(v: &Value, key: &str) -> bool {
    v.get(key)
        .and_then(Value::as_str)
        .is_some_and(|s| !s.trim().is_empty())
}
pub fn validate_output(kind: &NodeKind, value: &Value) -> AppResult<()> {
    if serde_json::to_vec(value).map_err(|_| "输出无法解析")?.len() > 250_000 {
        return Err("模型输出过大".into());
    }
    let valid = match kind {
        NodeKind::Brief => required_text(value, "text"),
        NodeKind::Story => {
            required_text(value, "title")
                && required_text(value, "content")
                && required_text(value, "logline")
                && value["characters"]
                    .as_array()
                    .is_some_and(|a| a.iter().all(Value::is_string))
        }
        NodeKind::Prompt => required_text(value, "text") && value["negativePrompt"].is_string(),
        NodeKind::Storyboard => value["shots"].as_array().is_some_and(|shots| {
            let mut ids = HashSet::new();
            !shots.is_empty()
                && shots.len() <= 24
                && shots.iter().all(|s| {
                    [
                        "id",
                        "title",
                        "description",
                        "camera",
                        "imagePrompt",
                        "videoPrompt",
                    ]
                    .iter()
                    .all(|key| required_text(s, key))
                        && s["duration"]
                            .as_f64()
                            .is_some_and(|d| d > 0.0 && d <= 600.0)
                        && s["dialogue"].is_string()
                        && s["characters"]
                            .as_array()
                            .is_some_and(|a| a.iter().all(Value::is_string))
                        && ids.insert(s["id"].as_str().unwrap_or_default())
                })
        }),
        NodeKind::Image => {
            required_text(value, "storyboardArtifactId")
                && value["frames"].as_array().is_some_and(|frames| {
                    let mut ids = HashSet::new();
                    !frames.is_empty()
                        && frames.len() <= 24
                        && frames.iter().all(|frame| {
                            required_text(frame, "shotId")
                                && required_text(frame, "assetId")
                                && required_text(frame, "versionId")
                                && frame["width"].as_u64().is_some_and(|n| n > 0 && n <= 8192)
                                && frame["height"].as_u64().is_some_and(|n| n > 0 && n <= 8192)
                                && ids.insert(frame["shotId"].as_str().unwrap_or_default())
                        })
                })
        }
        NodeKind::Video => {
            required_text(value, "storyboardArtifactId")
                && value["clips"].as_array().is_some_and(|clips| {
                    let mut ids = HashSet::new();
                    !clips.is_empty()
                        && clips.len() <= 24
                        && clips.iter().all(|clip| {
                            required_text(clip, "shotId")
                                && required_text(clip, "assetId")
                                && required_text(clip, "versionId")
                                && required_text(clip, "firstFrameVersionId")
                                && clip["duration"]
                                    .as_u64()
                                    .is_some_and(|n| (2..=15).contains(&n))
                                && matches!(clip["resolution"].as_str(), Some("720P" | "1080P"))
                                && ids.insert(clip["shotId"].as_str().unwrap_or_default())
                        })
                })
        }
    };
    if valid {
        Ok(())
    } else {
        Err("输出不符合节点结构，请检查必填字段、镜头 ID 和时长；可手动修正后继续".into())
    }
}
