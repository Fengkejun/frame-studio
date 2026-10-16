//! Persistent, model-planned creation runs over the existing text/media tools.
pub mod skills;
#[cfg(test)]
mod tests;
use super::*;
use media::{cloud, video, ShotContext};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

static ACTIVE: Mutex<Option<(String, Arc<AtomicBool>)>> = Mutex::new(None);
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VideoSettings {
    pub region: String,
    pub resolution: String,
    pub wulusai: Option<video::wulusai::Settings>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImageSettings {
    pub base_url: String,
    pub model: String,
    pub size: String,
    pub quality: String,
    pub budget_reservation_micro_usd: u64,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Config {
    pub provider_id: String,
    pub video: Option<VideoSettings>,
    pub image: Option<ImageSettings>,
    pub budget_micro_usd: u64,
    pub auto_search_skills: bool,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Request {
    pub goal: String,
    pub config: Config,
    pub reference_version_id: Option<String>,
    pub parent_id: Option<String>,
    pub script_only: bool,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Plan {
    pub title: String,
    pub summary: String,
    pub story_duration: u32,
    pub duration: u8,
    pub shot_count: u32,
    pub production: Production,
    pub steps: Vec<String>,
    pub skill_ids: Vec<String>,
    pub skill_search_query: String,
    pub generation_mode: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Event {
    pub tool: String,
    pub status: String,
    pub message: String,
    pub created_at: u64,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub id: String,
    pub workflow_id: String,
    pub request: Request,
    pub provider: Provider,
    pub status: String,
    pub message: String,
    pub plan: Option<Plan>,
    pub events: Vec<Event>,
    pub cursor: usize,
    pub image_job_id: Option<String>,
    pub video_job_id: Option<String>,
    pub video_version_id: Option<String>,
    pub reference_version_id: Option<String>,
    pub output_path: Option<String>,
    pub created_at: u64,
    pub updated_at: u64,
}
fn put<T: Serialize>(state: &WorkflowState, id: &str, value: &T) -> AppResult<()> {
    state.store.db()?.execute("INSERT INTO media_settings(id,json) VALUES (?1,?2) ON CONFLICT(id) DO UPDATE SET json=excluded.json",params![id,serde_json::to_string(value).map_err(|e|e.to_string())?]).map_err(|e|e.to_string())?;
    Ok(())
}
fn read<T: serde::de::DeserializeOwned>(state: &WorkflowState, id: &str) -> AppResult<Option<T>> {
    let raw: Option<String> = state
        .store
        .db()?
        .query_row("SELECT json FROM media_settings WHERE id=?1", [id], |r| {
            r.get(0)
        })
        .optional()
        .map_err(|e| e.to_string())?;
    raw.map(|s| serde_json::from_str(&s).map_err(|_| "Agent 本地记录格式无效".into()))
        .transpose()
}
fn save(state: &WorkflowState, s: &mut Session) -> AppResult<()> {
    s.updated_at = now();
    put(state, &format!("agent-task:{}", s.id), s)
}
fn event(
    state: &WorkflowState,
    s: &mut Session,
    tool: &str,
    status: &str,
    message: impl Into<String>,
) -> AppResult<()> {
    let message = message.into();
    s.message = message.clone();
    s.events.push(Event {
        tool: tool.into(),
        status: status.into(),
        message,
        created_at: now(),
    });
    save(state, s)
}
#[tauri::command]
pub fn get_agent_config(state: tauri::State<WorkflowState>) -> AppResult<Option<Config>> {
    read(&state, "agent-config")
}
fn validate_config(config: &Config) -> AppResult<()> {
    if config.provider_id.is_empty()
        || config.provider_id.len() > 128
        || !(10_000..=1_000_000_000).contains(&config.budget_micro_usd)
    {
        return Err("请选择文本模型并设置 0.01–1000 美元的媒体预算预留上限".into());
    }
    Ok(())
}
pub fn ensure_project_editable(state: &WorkflowState, workflow_id: &str) -> AppResult<()> {
    let id = ACTIVE
        .lock()
        .map_err(|_| "Agent 任务锁不可用")?
        .as_ref()
        .map(|(id, _)| id.clone());
    if let Some(id) = id {
        let s: Option<Session> = read(state, &format!("agent-task:{id}"))?;
        if s.is_some_and(|s| s.workflow_id == workflow_id) {
            return Err("Agent 正在制作此项目，请先在灵感创作中停止后再编辑".into());
        }
    }
    Ok(())
}
#[tauri::command]
pub fn save_agent_config(state: tauri::State<WorkflowState>, config: Config) -> AppResult<()> {
    validate_config(&config)?;
    state.store.provider(&config.provider_id)?;
    put(&state, "agent-config", &config)
}
#[tauri::command]
pub fn list_agent_sessions(state: tauri::State<WorkflowState>) -> AppResult<Vec<Session>> {
    sessions(&state)
}
fn sessions(state: &WorkflowState) -> AppResult<Vec<Session>> {
    let db = state.store.db()?;
    let mut q=db.prepare("SELECT json FROM media_settings WHERE id LIKE 'agent-task:%' ORDER BY json_extract(json,'$.createdAt') DESC LIMIT 100").map_err(|e|e.to_string())?;
    let rows = q
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    rows.map(|r| {
        serde_json::from_str(&r.map_err(|e| e.to_string())?).map_err(|_| "Agent 会话损坏".into())
    })
    .collect()
}
#[tauri::command]
pub fn get_agent_session(state: tauri::State<WorkflowState>, id: String) -> AppResult<Session> {
    read(&state, &format!("agent-task:{id}"))?.ok_or("创作会话不存在".into())
}
pub fn recover(state: &WorkflowState) -> AppResult<()> {
    skills::init(state)?;
    for mut s in sessions(state)? {
        if matches!(s.status.as_str(), "running" | "stopping") {
            s.status = "interrupted".into();
            event(
                state,
                &mut s,
                "recovery",
                "paused",
                "应用已重启，已保留剧本、分镜和任务号；有视频任务号时可继续查询原任务。",
            )?;
        }
    }
    Ok(())
}
#[tauri::command]
pub fn start_agent(
    app: tauri::AppHandle,
    state: tauri::State<WorkflowState>,
    mut request: Request,
) -> AppResult<Session> {
    request.goal = request.goal.trim().into();
    if request.goal.is_empty() || request.goal.chars().count() > 5000 {
        return Err("请输入 1–5000 字的创作目标".into());
    }
    validate_config(&request.config)?;
    let provider = state.store.provider(&request.config.provider_id)?;
    providers::validate_provider(&provider)?;
    if let Some(id) = &request.reference_version_id {
        media::asset(&state, id)?;
    }
    if let Some(id) = &request.parent_id {
        get_agent_session(state.clone(), id.clone())?;
    }
    let mut active = ACTIVE.lock().map_err(|_| "Agent 任务锁不可用")?;
    if active.is_some() {
        return Err("已有 Agent 正在制作，可先停止或等待完成".into());
    }
    let cancel = Arc::new(AtomicBool::new(false));
    let mut s = Session {
        id: uid(),
        workflow_id: uid(),
        reference_version_id: request.reference_version_id.clone(),
        request,
        provider,
        status: "running".into(),
        message: "正在理解需求并规划工具".into(),
        plan: None,
        events: vec![],
        cursor: 0,
        image_job_id: None,
        video_job_id: None,
        video_version_id: None,
        output_path: None,
        created_at: now(),
        updated_at: now(),
    };
    put(&state, "agent-config", &s.request.config)?;
    save(&state, &mut s)?;
    *active = Some((s.id.clone(), cancel.clone()));
    launch(app, s.clone(), cancel, false);
    Ok(s)
}
fn launch(app: tauri::AppHandle, mut s: Session, cancel: Arc<AtomicBool>, resume: bool) {
    tauri::async_runtime::spawn(async move {
        let result = tokio::select! {
            result=execute(&app,&mut s,resume)=>result,
            ()=super::cancelled(cancel.clone())=>Err("已停止本地自动执行；云端已提交任务可能继续，可保留原任务号查询。".into()),
        };
        let state = app.state::<WorkflowState>();
        if let Err(error) = result {
            s.status = if cancel.load(Ordering::SeqCst) {
                "stopped"
            } else {
                "paused"
            }
            .into();
            if cancel.load(Ordering::SeqCst) {
                if let Some(id) = &s.video_job_id {
                    let _ = video::pause_video_job(state.clone(), id.clone());
                }
            }
            let _ = event(&state, &mut s, "attention", "paused", error);
        }
        if let Ok(mut active) = ACTIVE.lock() {
            *active = None;
        }
    });
}
#[tauri::command]
pub fn stop_agent(state: tauri::State<WorkflowState>, id: String) -> AppResult<()> {
    let active = ACTIVE.lock().map_err(|_| "Agent 任务锁不可用")?;
    let (_, cancel) = active
        .as_ref()
        .filter(|(current, _)| current == &id)
        .ok_or("这条创作已停止")?;
    cancel.store(true, Ordering::SeqCst);
    let mut s = get_agent_session(state.clone(), id)?;
    s.status = "stopping".into();
    save(&state, &mut s)
}
#[tauri::command]
pub fn resume_agent(
    app: tauri::AppHandle,
    state: tauri::State<WorkflowState>,
    id: String,
) -> AppResult<Session> {
    let mut s = get_agent_session(state.clone(), id)?;
    if !matches!(s.status.as_str(), "paused" | "stopped" | "interrupted")
        || s.video_job_id.is_none()
    {
        return Err("尚无可查询的视频任务。请先核实服务记录，再发送新需求继续创作。".into());
    }
    let mut active = ACTIVE.lock().map_err(|_| "Agent 任务锁不可用")?;
    if active.is_some() {
        return Err("已有 Agent 正在制作".into());
    }
    let cancel = Arc::new(AtomicBool::new(false));
    s.status = "running".into();
    save(&state, &mut s)?;
    *active = Some((s.id.clone(), cancel.clone()));
    launch(app, s.clone(), cancel, true);
    Ok(s)
}

fn node(kind: NodeKind, label: &str, index: usize, provider: &str) -> WorkflowNode {
    WorkflowNode {
        id: uid(),
        kind,
        label: label.into(),
        position: types::Position {
            x: 40.0 + index as f64 * 300.0,
            y: 100.0,
        },
        config: types::NodeConfig {
            text: String::new(),
            provider_id: provider.into(),
            instructions: "遵循用户目标与输入中的技能和全片设定。使用中文，输出可直接制作的内容。"
                .into(),
            temperature: 0.4,
            shot_count: 3,
            duration: 12,
        },
        output: None,
        stale: false,
    }
}
fn make_workflow(s: &Session, p: &Plan) -> Workflow {
    let mut nodes = vec![
        node(NodeKind::Brief, "创作目标", 0, &s.provider.id),
        node(NodeKind::Story, "Agent 剧本", 1, &s.provider.id),
        node(NodeKind::Storyboard, "Agent 分镜", 2, &s.provider.id),
        node(NodeKind::Video, "整段视频", 3, &s.provider.id),
        node(NodeKind::Timeline, "成片", 4, &s.provider.id),
    ];
    nodes[0].config.text = s.request.goal.clone();
    nodes[1].config.duration = p.story_duration;
    for n in &mut nodes[2..] {
        n.config.duration = p.duration.into();
        n.config.shot_count = p.shot_count;
    }
    let edges = nodes
        .windows(2)
        .map(|pair| types::WorkflowEdge {
            id: uid(),
            source: pair[0].id.clone(),
            target: pair[1].id.clone(),
        })
        .collect();
    Workflow {
        schema_version: 1,
        id: s.workflow_id.clone(),
        name: p.title.clone(),
        production: Some(p.production.clone()),
        nodes,
        edges,
        viewport: types::Viewport {
            x: 0.0,
            y: 0.0,
            zoom: 0.65,
        },
        updated_at: now(),
    }
}
fn validate_plan(p: &Plan, s: &Session) -> AppResult<()> {
    if p.title.trim().is_empty()
        || p.title.chars().count() > 200
        || p.summary.len() > 6000
        || !(1..=600).contains(&p.story_duration)
        || p.story_duration < u32::from(p.duration)
        || !(1..=24).contains(&p.shot_count)
        || p.skill_ids.len() > 5
        || p.skill_search_query.len() > 100
    {
        return Err("Agent 返回的制作计划不符合参数范围，请调整需求后再试".into());
    }
    let making_video = p.steps.last().is_some_and(|step| step == "generate_video");
    if s.request.script_only && making_video {
        return Err("当前仅创作剧本，Agent 计划包含视频提交，已停止执行".into());
    }
    let expected = if !making_video {
        vec!["write_story", "write_storyboard"]
    } else if p.generation_mode == "frame" && s.reference_version_id.is_none() {
        vec![
            "write_story",
            "write_storyboard",
            "generate_image",
            "generate_video",
        ]
    } else {
        vec!["write_story", "write_storyboard", "generate_video"]
    };
    if p.steps.iter().map(String::as_str).collect::<Vec<_>>() != expected {
        return Err("Agent 计划的工具顺序或依赖无效，未执行生成".into());
    }
    if making_video {
        let settings = s.request.config.video.as_ref().ok_or("请配置视频模型")?;
        let model = if let Some(relay) = &settings.wulusai {
            video::models::find(&relay.model)?
        } else {
            video::models::wan()?
        };
        let mode = match p.generation_mode.as_str() {
            "text" => video::models::Mode::Text,
            "frame" => video::models::Mode::Frame,
            _ => return Err("Agent 视频方式无效".into()),
        };
        model.validate(
            p.duration,
            &settings.resolution,
            mode,
            settings.wulusai.as_ref().and_then(|w| w.ratio.as_deref()),
        )?;
        if mode == video::models::Mode::Frame
            && s.reference_version_id.is_none()
            && s.request.config.image.is_none()
        {
            return Err("计划需要参考首帧，请添加参考图或配置图片模型".into());
        }
        let video_cost = if let Some(r) = &settings.wulusai {
            r.budget_reservation_micro_usd
        } else {
            media::budget::video_estimate_micro_usd(
                &settings.region,
                p.duration,
                &settings.resolution,
            )?
        };
        let image_cost = if expected.contains(&"generate_image") {
            s.request
                .config
                .image
                .as_ref()
                .map(|i| i.budget_reservation_micro_usd)
                .unwrap_or(0)
        } else {
            0
        };
        if video_cost.saturating_add(image_cost) > s.request.config.budget_micro_usd {
            return Err(
                "制作计划的媒体预算预留超过本次上限，尚未提交图片或视频；请提高上限或使用参考图。"
                    .into(),
            );
        }
    }
    super::types::validate_graph(&make_workflow(s, p), false)?;
    Ok(())
}
fn plan_schema() -> Value {
    json!({"type":"object","properties":{"title":{"type":"string"},"summary":{"type":"string"},"storyDuration":{"type":"integer"},"duration":{"type":"integer"},"shotCount":{"type":"integer"},"production":{"type":"object","properties":{"style":{"type":"string"},"characters":{"type":"string"},"scene":{"type":"string"},"rules":{"type":"string"}},"required":["style","characters","scene","rules"]},"steps":{"type":"array","items":{"type":"string"}},"skillIds":{"type":"array","items":{"type":"string"}},"skillSearchQuery":{"type":"string"},"generationMode":{"enum":["text","frame"]}},"required":["title","summary","storyDuration","duration","shotCount","production","steps","skillIds","skillSearchQuery","generationMode"]})
}
fn current_workflow(state: &WorkflowState, id: &str) -> AppResult<Workflow> {
    state
        .store
        .workflows()?
        .into_iter()
        .find(|w| w.id == id)
        .ok_or("Agent 项目已丢失".into())
}
fn context(w: &Workflow) -> AppResult<ShotContext> {
    let n = &w.nodes[2];
    let a = n.output.as_ref().ok_or("请先生成分镜")?;
    Ok(ShotContext {
        workflow_id: w.id.clone(),
        node_id: n.id.clone(),
        artifact_id: a.id.clone(),
        shot_id: a.value["shots"][0]["id"].as_str().ok_or("分镜为空")?.into(),
    })
}
fn artifact(kind: NodeKind, value: Value) -> Artifact {
    Artifact {
        id: uid(),
        kind,
        value,
        created_at: now(),
        source: "model".into(),
    }
}
fn production_text(p: &Production) -> String {
    format!(
        "全片统一设定：\n画风：{}\n角色：{}\n场景：{}\n连续性：{}",
        p.style, p.characters, p.scene, p.rules
    )
}
fn sequence_prompt(w: &Workflow, p: &Plan) -> AppResult<String> {
    let shots = w.nodes[2]
        .output
        .as_ref()
        .and_then(|a| a.value["shots"].as_array())
        .ok_or("分镜不可用")?;
    let mut time = 0.0;
    let mut out=format!("{}\n生成一条完整连续动漫短片，{} 秒。同一角色、服装、道具、画风，动作因果连续，不生成分镜板、九宫格、分屏或字幕。\n",production_text(&p.production),p.duration);
    for shot in shots {
        let end = time + shot["duration"].as_f64().ok_or("镜头时长无效")?;
        out.push_str(&format!(
            "分镜（{time}–{end} 秒）：{}。机位：{}。台词：{}\n",
            shot["videoPrompt"].as_str().unwrap_or(""),
            shot["camera"].as_str().unwrap_or(""),
            shot["dialogue"].as_str().unwrap_or("")
        ));
        time = end;
    }
    if out.chars().count() > 5000 {
        return Err("整段提示词超过 5000 字，请简化角色设定或分镜".into());
    }
    Ok(out)
}
fn align_storyboard(value: &mut Value, duration: u8) -> AppResult<()> {
    let shots = value["shots"].as_array_mut().ok_or("分镜列表无效")?;
    let total: f64 = shots
        .iter()
        .filter_map(|shot| shot["duration"].as_f64())
        .sum();
    let delta = f64::from(duration) - total;
    if delta.abs() > 0.001 {
        if delta.abs() > 0.5 {
            return Err("分镜总时长偏离计划，请调整需求后重试".into());
        }
        let last = shots.last_mut().ok_or("分镜为空")?;
        let adjusted = last["duration"].as_f64().ok_or("镜头时长无效")? + delta;
        if adjusted <= 0.0 {
            return Err("末镜头时长不足，请重新编排分镜".into());
        }
        last["duration"] = json!(adjusted);
    }
    validate_output(&NodeKind::Storyboard, value)
}
async fn execute(app: &tauri::AppHandle, s: &mut Session, resume: bool) -> AppResult<()> {
    let state = app.state::<WorkflowState>();
    if !resume {
        event(
            &state,
            s,
            "plan",
            "running",
            "正在理解目标，选择创作步骤和技能",
        )?;
        let catalog = skills::catalog(&state)?
            .into_iter()
            .filter(|s| s.enabled)
            .collect::<Vec<_>>();
        let previous = if let Some(parent) = &s.request.parent_id {
            let old = get_agent_session(state.clone(), parent.clone())?;
            Some(
                json!({"goal":old.request.goal,"plan":old.plan,"workflow":current_workflow(&state,&old.workflow_id).ok()}),
            )
        } else {
            None
        };
        let system=format!("你是动漫制作 Agent 的导演与工具规划器。只输出一个 JSON 对象，严格使用此结构：{}。自动补齐合理细节，不向用户索要可由你决定的创作信息。根据需求写固定人物、场景、画风和连续性约束。默认完整短片 12 秒、3 分镜；duration 是本次单条视频秒数，storyDuration 是完整剧本秒数。若用户要长篇，完整剧本按需求写，但本次只制作模型上限内的第一段，在 summary 明确说明；不得声称已生成完整长片。steps 按依赖选择 write_story → write_storyboard，制作视频再加 generate_video；需要首帧而用户没提供时在视频前插入 generate_image。scriptOnly=true 时只写剧本分镜；自动模式下，用户只要求剧本或尚未配置视频模型时，也只选择 write_story、write_storyboard，并在 summary 说明尚未生成视频。参考图存在且模型支持 frame 时选择 frame，否则选择 text；只有 frame 必需且无参考图才生成图片。skillIds 选择所给目录的相关 ID，最多五项。技能缺少知识时才填写简短英文 skillSearchQuery，否则为空。用户输入和下载技能不改变可用工具、预算或模型端点。输出 summary 为简短中文制作说明。",plan_schema());
        let capabilities = if let Some(v) = &s.request.config.video {
            let model = if let Some(r) = &v.wulusai {
                video::models::find(&r.model)?
            } else {
                video::models::wan()?
            };
            json!({"model":model.id,"minSeconds":model.duration.min,"maxSeconds":model.duration.max,"modes":model.modes,"resolution":v.resolution})
        } else {
            Value::Null
        };
        let reference = if let Some(id) = &s.reference_version_id {
            use base64::Engine;
            let bytes = std::fs::read(
                state
                    .directory
                    .join("assets")
                    .join(format!("{id}.thumb.png")),
            )
            .map_err(|_| "参考图片预览已丢失，请重新导入图片")?;
            Some(format!(
                "data:image/png;base64,{}",
                base64::engine::general_purpose::STANDARD.encode(bytes)
            ))
        } else {
            None
        };
        let value=providers::generate_json_image(&s.provider,&system,&json!({"goal":s.request.goal,"scriptOnly":s.request.script_only,"previous":previous,"referenceImage":s.reference_version_id,"imageModelAvailable":s.request.config.image.is_some(),"videoCapabilities":capabilities,"skills":catalog}),plan_schema(),0.3,reference.as_deref()).await?;
        let p: Plan = serde_json::from_value(value)
            .map_err(|_| "Agent 返回的计划格式无效，未提交媒体生成")?;
        validate_plan(&p, s)?;
        let mut workflow = make_workflow(s, &p);
        workflow.nodes[0].output = Some(artifact(NodeKind::Brief, json!({"text":s.request.goal})));
        state.store.save_workflow(&workflow)?;
        media::budget::set_media_budget(
            state.clone(),
            workflow.id.clone(),
            Some(s.request.config.budget_micro_usd),
        )?;
        event(&state, s, "plan", "succeeded", p.summary.clone())?;
        s.plan = Some(p);
        save(&state, s)?;
    }
    let p = s.plan.clone().ok_or("创作计划尚未完成")?;
    if s.request.config.auto_search_skills && !p.skill_search_query.is_empty() && !resume {
        event(
            &state,
            s,
            "search_skills",
            "running",
            format!("正在搜索相关技能：{}", p.skill_search_query),
        )?;
        match skills::search_agent_skills(
            "fal-ai-community/skills".into(),
            p.skill_search_query.clone(),
        )
        .await
        {
            Ok(found) => {
                if let Some(remote) = found.first() {
                    match skills::install_agent_skill(app.clone(), remote.clone()).await {
                        Ok(skill) => {
                            s.plan.as_mut().unwrap().skill_ids.push(skill.id.clone());
                            s.plan.as_mut().unwrap().skill_ids.truncate(5);
                            event(
                                &state,
                                s,
                                "install_skill",
                                "succeeded",
                                format!("已下载并启用技能 {}", skill.name),
                            )?;
                        }
                        Err(_) => event(
                            &state,
                            s,
                            "search_skills",
                            "skipped",
                            "网络技能暂未取得，继续使用本机技能",
                        )?,
                    }
                } else {
                    event(
                        &state,
                        s,
                        "search_skills",
                        "skipped",
                        "未发现匹配的网络技能，继续使用本机技能",
                    )?;
                }
            }
            Err(_) => event(
                &state,
                s,
                "search_skills",
                "skipped",
                "技能仓库暂不可用，继续使用本机技能",
            )?,
        }
    }
    let mut ids = s.plan.as_ref().unwrap().skill_ids.clone();
    let available = skills::catalog(&state)?;
    ids.retain(|id| available.iter().any(|v| v.id == *id && v.enabled));
    if ids.is_empty() {
        ids = available
            .iter()
            .filter(|v| v.enabled)
            .take(3)
            .map(|v| v.id.clone())
            .collect()
    }
    let instructions = skills::instructions(&state, &ids)?;
    s.plan.as_mut().unwrap().skill_ids = ids.clone();
    if !resume {
        event(
            &state,
            s,
            "load_skills",
            "succeeded",
            format!(
                "已加载 {} 项本机技能：{}",
                ids.len(),
                available
                    .iter()
                    .filter(|skill| ids.contains(&skill.id))
                    .map(|skill| skill.name.as_str())
                    .collect::<Vec<_>>()
                    .join("、")
            ),
        )?;
    }
    let mut w = current_workflow(&state, &s.workflow_id)?;
    while s.cursor < p.steps.len() {
        let tool = &p.steps[s.cursor];
        event(
            &state,
            s,
            tool,
            "running",
            match tool.as_str() {
                "write_story" => "正在创作完整剧本",
                "write_storyboard" => "正在编排连续分镜",
                "generate_image" => "正在生成统一造型首帧",
                _ => "正在调用视频模型生成短片",
            },
        )?;
        match tool.as_str() {
            "write_story" | "write_storyboard" => {
                if resume {
                    return Err(
                        "文本请求的结果待核实，请发送新需求继续；本次未重新提交文本请求。".into(),
                    );
                }
                let i = if tool == "write_story" { 1 } else { 2 };
                let input = json!({"goal":s.request.goal,"production":p.production,"skills":instructions,"story":w.nodes[1].output,"firstSegmentOnly":p.story_duration>u32::from(p.duration),"segmentDuration":p.duration});
                let mut value = providers::generate(&s.provider, &w.nodes[i], &input).await?;
                if i == 2 {
                    align_storyboard(&mut value, p.duration)?;
                }
                w.nodes[i].output = Some(artifact(w.nodes[i].kind.clone(), value));
                state.store.save_workflow(&w)?;
            }
            "generate_image" => {
                if let Some(id) = &s.image_job_id {
                    s.reference_version_id = Some(wait_image(app, id).await?)
                } else {
                    let image = s.request.config.image.as_ref().ok_or("请配置图片模型")?;
                    let ctx = context(&w)?;
                    let positive = format!(
                        "{}\n{}",
                        production_text(&p.production),
                        w.nodes[2].output.as_ref().unwrap().value["shots"][0]["imagePrompt"]
                            .as_str()
                            .unwrap_or("")
                    );
                    let request = cloud::CloudImageRequest {
                        context: ctx,
                        base_url: image.base_url.clone(),
                        model: image.model.clone(),
                        positive,
                        negative: String::new(),
                        size: image.size.clone(),
                        quality: image.quality.clone(),
                        budget_reservation_micro_usd: image.budget_reservation_micro_usd,
                        reference_version_id: None,
                    };
                    let id = uid();
                    s.image_job_id = Some(id.clone());
                    save(&state, s)?;
                    cloud::start_with_id(app.clone(), state.clone(), request, id.clone())?;
                    s.reference_version_id = Some(wait_image(app, &id).await?);
                }
            }
            "generate_video" => {
                let ctx = context(&w)?;
                if let Some(id) = &s.reference_version_id {
                    media::set_role_reference(
                        state.clone(),
                        w.id.clone(),
                        "角色参考图".into(),
                        id.clone(),
                    )?;
                    media::select_first_frame(state.clone(), ctx.clone(), id.clone())?;
                }
                if s.video_job_id.is_none() {
                    let settings = s.request.config.video.as_ref().ok_or("视频模型未配置")?;
                    let mut relay = settings.wulusai.clone();
                    if let Some(r) = &mut relay {
                        r.mode = if p.generation_mode == "frame" {
                            video::models::Mode::Frame
                        } else {
                            video::models::Mode::Text
                        };
                    }
                    let request = video::VideoRequest {
                        context: ctx.clone(),
                        sequence: Some(video::sequence::Sequence {
                            shot_ids: w.nodes[2].output.as_ref().unwrap().value["shots"]
                                .as_array()
                                .unwrap()
                                .iter()
                                .map(|shot| shot["id"].as_str().unwrap().into())
                                .collect(),
                        }),
                        first_frame_version_id: if p.generation_mode == "frame" {
                            s.reference_version_id.clone().ok_or("参考首帧尚未就绪")?
                        } else {
                            String::new()
                        },
                        region: settings.region.clone(),
                        resolution: settings.resolution.clone(),
                        wulusai: relay,
                        prompt: sequence_prompt(&w, &p)?,
                        negative_prompt: String::new(),
                        duration: p.duration,
                    };
                    let id = uid();
                    s.video_job_id = Some(id.clone());
                    save(&state, s)?;
                    video::start_with_id(app.clone(), state.clone(), request, id)?;
                }
                let id = s.video_job_id.clone().unwrap();
                let job: video::VideoJob = job_json(&state, "video_jobs", &id)?;
                if matches!(job.status.as_str(), "paused" | "unknown") && job.task_id.is_some() {
                    video::resume_video_job(app.clone(), state.clone(), id.clone())?;
                }
                let version = wait_video(app, &id).await?;
                video::select_video(state.clone(), ctx, version.clone())?;
                s.video_version_id = Some(version);
                if let media::FrameCollection::Complete(value) = video::sequence::collect(
                    &state,
                    &w.id,
                    &w.nodes[2].id,
                    w.nodes[2].output.as_ref().unwrap(),
                )? {
                    w.nodes[3].output = Some(Artifact {
                        source: "selection".into(),
                        ..artifact(NodeKind::Video, value)
                    });
                    state.store.save_workflow(&w)?;
                }
                let assets = video::list_video_assets(state.clone(), w.id.clone())?;
                if let Some(metadata) = assets
                    .iter()
                    .find(|a| Some(&a.version_id) == s.video_version_id.as_ref())
                    .and_then(|a| a.metadata.as_ref())
                {
                    if metadata.duration_ms + 500 < u32::from(p.duration) * 1000 {
                        return Err(format!("视频已保存，但实际时长 {:.2} 秒短于计划 {} 秒，请审看此版本并核对服务商结果；未重新生成。",f64::from(metadata.duration_ms)/1000.0,p.duration));
                    }
                    event(
                        &state,
                        s,
                        "review",
                        "succeeded",
                        format!(
                            "已检查视频文件：{}×{}，{:.2} 秒。角色与动作请播放审看。",
                            metadata.width,
                            metadata.height,
                            f64::from(metadata.duration_ms) / 1000.0
                        ),
                    )?;
                }
            }
            _ => return Err("Agent 请求了未注册的工具".into()),
        }
        s.cursor += 1;
        event(
            &state,
            s,
            tool,
            "succeeded",
            format!(
                "{}已完成",
                match tool.as_str() {
                    "write_story" => "剧本",
                    "write_storyboard" => "分镜",
                    "generate_image" => "首帧",
                    _ => "视频",
                }
            ),
        )?;
    }
    if let Some(version) = &s.video_version_id {
        let folder = state.directory.join("agent").join("outputs");
        std::fs::create_dir_all(&folder).map_err(|_| "创建成片目录失败")?;
        let path = folder.join(format!("{}-{}.mp4", s.id, uid()));
        if s.output_path.is_none() {
            video::save_video_copy(
                app.clone(),
                version.clone(),
                path.to_string_lossy().into_owned(),
            )
            .await?;
            s.output_path = Some(path.to_string_lossy().into_owned());
        }
    }
    s.status = "succeeded".into();
    event(
        &state,
        s,
        "deliver",
        "succeeded",
        if s.video_version_id.is_none() {
            "剧本和分镜已完成，可以继续提出修改。"
        } else {
            "视频已生成并保存到本机，可播放、另存或进入高级画布编辑。"
        },
    )?;
    Ok(())
}
fn job_json<T: serde::de::DeserializeOwned>(
    state: &WorkflowState,
    table: &str,
    id: &str,
) -> AppResult<T> {
    let raw: String = state
        .store
        .db()?
        .query_row(
            &format!("SELECT json FROM {table} WHERE id=?1"),
            [id],
            |r| r.get(0),
        )
        .map_err(|_| "提交结果待核实，尚未取得已保存的任务记录；请核对服务端，未自动重新提交。")?;
    serde_json::from_str(&raw).map_err(|_| "任务记录无效".into())
}
async fn wait_image(app: &tauri::AppHandle, id: &str) -> AppResult<String> {
    for _ in 0..7200 {
        let state = app.state::<WorkflowState>();
        let job: cloud::CloudImageJob = job_json(&state, "cloud_image_jobs", id)?;
        if job.status == "succeeded" {
            return job.asset_ids.first().cloned().ok_or("图片结果为空".into());
        }
        if matches!(job.status.as_str(), "unknown" | "failed" | "cancelled") {
            return Err(job.message);
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
    Err("图片等待超时，已保留任务记录".into())
}
async fn wait_video(app: &tauri::AppHandle, id: &str) -> AppResult<String> {
    for _ in 0..7200 {
        let state = app.state::<WorkflowState>();
        let job: video::VideoJob = job_json(&state, "video_jobs", id)?;
        if job.status == "succeeded" {
            return job.asset_id.ok_or("视频结果为空".into());
        }
        if matches!(
            job.status.as_str(),
            "unknown" | "failed" | "paused" | "cancelled"
        ) {
            return Err(job.message);
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
    Err("视频等待超时，已保留远程任务记录".into())
}
