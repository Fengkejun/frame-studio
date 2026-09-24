pub mod media;
mod providers;
mod storage;
mod types;
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use storage::Store;
use tauri::Manager;
pub use types::*;

pub struct ActiveRun {
    id: String,
    cancel: Arc<AtomicBool>,
}
pub struct WorkflowState {
    store: Store,
    active: Mutex<Option<ActiveRun>>,
    media_active: Mutex<Option<ActiveRun>>,
    directory: std::path::PathBuf,
}

pub fn init(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let mut directory = app.path().app_data_dir()?;
    // Native smoke tests use a separate DB, never the user's projects.
    if cfg!(debug_assertions) {
        if let Some(path) = std::env::var_os("FRAME_STUDIO_TEST_DATA_DIR") {
            directory = path.into();
        }
    }
    std::fs::create_dir_all(&directory)?;
    app.manage(WorkflowState {
        store: Store::open(&directory.join("studio.sqlite"))?,
        active: Mutex::new(None),
        media_active: Mutex::new(None),
        directory,
    });
    media::comfy::recover(&app.state::<WorkflowState>())?;
    media::cloud::recover(&app.state::<WorkflowState>())?;
    Ok(())
}
fn idle(state: &WorkflowState) -> AppResult<()> {
    if state.active.lock().map_err(|_| "任务锁不可用")?.is_some() {
        Err("有任务正在执行，请先停止或等待完成".into())
    } else {
        Ok(())
    }
}
#[tauri::command]
pub fn list_workflows(state: tauri::State<WorkflowState>) -> AppResult<Vec<Workflow>> {
    state.store.workflows()
}
#[tauri::command]
pub fn save_workflow(state: tauri::State<WorkflowState>, workflow: Workflow) -> AppResult<()> {
    state.store.save_workflow(&workflow)
}
#[tauri::command]
pub fn list_providers(state: tauri::State<WorkflowState>) -> AppResult<Vec<Provider>> {
    state.store.providers()
}
#[tauri::command]
pub fn save_provider(
    state: tauri::State<WorkflowState>,
    mut provider: Provider,
    api_key: Option<String>,
    clear_key: bool,
) -> AppResult<Provider> {
    idle(&state)?;
    providers::validate_provider(&provider)?;
    let previous = state
        .store
        .providers()?
        .into_iter()
        .find(|p| p.id == provider.id);
    // A saved key must never silently move to a different endpoint.
    if let Some(old) = &previous {
        if old.has_key
            && old.base_url.trim_end_matches('/') != provider.base_url.trim_end_matches('/')
            && api_key.is_none()
            && !clear_key
        {
            return Err("修改服务地址时请重新输入密钥，或勾选移除旧密钥".into());
        }
    }
    provider.has_key = previous.is_some_and(|p| p.has_key);
    if clear_key {
        providers::delete_key(&provider)?;
        provider.has_key = false;
    }
    if let Some(key) = api_key {
        providers::save_key(&provider, &key)?;
        provider.has_key = true;
    }
    state.store.save_provider(&provider)?;
    Ok(provider)
}
#[tauri::command]
pub fn remove_provider(state: tauri::State<WorkflowState>, id: String) -> AppResult<()> {
    idle(&state)?;
    let p = state.store.provider(&id)?;
    if p.has_key {
        providers::delete_key(&p)?;
    }
    state
        .store
        .db()?
        .execute("DELETE FROM providers WHERE id=?1", [id])
        .map_err(|e| e.to_string())?;
    Ok(())
}
#[tauri::command]
pub async fn test_provider(
    state: tauri::State<'_, WorkflowState>,
    id: String,
) -> AppResult<String> {
    providers::test(&state.store.provider(&id)?).await
}
#[tauri::command]
pub fn list_runs(
    state: tauri::State<WorkflowState>,
    workflow_id: String,
) -> AppResult<Vec<RunRecord>> {
    state
        .store
        .runs(Some(&workflow_id))
        .map(|r| r.into_iter().take(30).collect())
}
#[tauri::command]
pub fn get_run(state: tauri::State<WorkflowState>, id: String) -> AppResult<RunRecord> {
    state.store.run(&id)
}
#[tauri::command]
pub fn cancel_run(state: tauri::State<WorkflowState>, id: String) -> AppResult<()> {
    let active = state.active.lock().map_err(|_| "任务锁不可用")?;
    if let Some(a) = active.as_ref().filter(|a| a.id == id) {
        a.cancel.store(true, Ordering::SeqCst);
        Ok(())
    } else {
        Err("任务已经结束".into())
    }
}
#[tauri::command]
pub fn validate_artifact(kind: NodeKind, value: serde_json::Value) -> AppResult<Artifact> {
    validate_output(&kind, &value)?;
    Ok(Artifact {
        id: uid(),
        kind,
        value,
        created_at: now(),
        source: "manual".into(),
    })
}

#[tauri::command]
pub fn start_run(
    app: tauri::AppHandle,
    state: tauri::State<WorkflowState>,
    workflow: Workflow,
    target: Option<String>,
) -> AppResult<RunRecord> {
    let order = validate_graph(&workflow, target.is_none())?;
    let selected = if let Some(id) = &target {
        if !order.contains(id) {
            return Err("节点不存在".into());
        }
        let selected = workflow
            .nodes
            .iter()
            .find(|n| &n.id == id)
            .ok_or("节点不存在")?;
        if selected.kind == NodeKind::Brief && selected.config.text.trim().is_empty() {
            return Err("请填写创作需求".into());
        }
        if selected.kind != NodeKind::Brief && !workflow.edges.iter().any(|e| &e.target == id) {
            return Err("请连接节点输入".into());
        }
        if let Some(edge) = workflow.edges.iter().find(|e| &e.target == id) {
            let parent = workflow
                .nodes
                .iter()
                .find(|n| n.id == edge.source)
                .ok_or("上游不存在")?;
            if parent.kind != NodeKind::Brief && (parent.stale || parent.output.is_none()) {
                return Err("请先运行或确认上游节点的最新结果".into());
            }
        }
        vec![id.clone()]
    } else {
        order
    };
    let all_providers = state.store.providers()?;
    let mut used = vec![];
    for n in workflow
        .nodes
        .iter()
        .filter(|n| selected.contains(&n.id) && n.kind != NodeKind::Brief)
    {
        let provider = all_providers
            .iter()
            .find(|p| p.id == n.config.provider_id)
            .ok_or_else(|| format!("请为「{}」选择可用的模型连接", n.label))?;
        if !used.iter().any(|p: &Provider| p.id == provider.id) {
            used.push(provider.clone());
        }
    }
    let mut active = state.active.lock().map_err(|_| "任务锁不可用")?;
    if active.is_some() {
        return Err("已有工作流正在执行".into());
    }
    let run = RunRecord {
        id: uid(),
        workflow_id: workflow.id.clone(),
        started_at: now(),
        finished_at: None,
        status: "running".into(),
        snapshot: workflow,
        providers: used,
        nodes: selected
            .iter()
            .map(|id| NodeRun {
                node_id: id.clone(),
                status: "pending".into(),
                message: String::new(),
                output: None,
            })
            .collect(),
    };
    state.store.save_workflow(&run.snapshot)?;
    state.store.save_run(&run)?;
    let cancel = Arc::new(AtomicBool::new(false));
    *active = Some(ActiveRun {
        id: run.id.clone(),
        cancel: cancel.clone(),
    });
    let execution = run.clone();
    tauri::async_runtime::spawn(async move {
        let state = app.state::<WorkflowState>();
        let mut execution = execution;
        if let Err(error) = execute(&state, &mut execution, cancel).await {
            execution.status = "failed".into();
            if let Some(n) = execution.nodes.iter_mut().find(|n| n.status == "running") {
                n.status = "failed".into();
                n.message = error;
            }
        }
        for n in &mut execution.nodes {
            if n.status == "pending" {
                n.status = "skipped".into();
            }
        }
        execution.finished_at = Some(now());
        if state.store.save_run(&execution).is_err() {
            eprintln!("Could not persist final workflow state");
        }
        if let Ok(mut a) = state.active.lock() {
            *a = None;
        };
    });
    Ok(run)
}

async fn cancelled(cancel: Arc<AtomicBool>) {
    while !cancel.load(Ordering::SeqCst) {
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}
async fn execute(
    state: &WorkflowState,
    run: &mut RunRecord,
    cancel: Arc<AtomicBool>,
) -> AppResult<()> {
    let mut values: HashMap<String, serde_json::Value> = run
        .snapshot
        .nodes
        .iter()
        .filter_map(|n| {
            if n.kind == NodeKind::Brief {
                Some((n.id.clone(), serde_json::json!({"text":n.config.text})))
            } else if !n.stale {
                n.output.as_ref().map(|a| (n.id.clone(), a.value.clone()))
            } else {
                None
            }
        })
        .collect();
    for index in 0..run.nodes.len() {
        if cancel.load(Ordering::SeqCst) {
            run.status = "cancelled".into();
            return Ok(());
        }
        let node = run
            .snapshot
            .nodes
            .iter()
            .find(|n| n.id == run.nodes[index].node_id)
            .ok_or("节点不存在")?
            .clone();
        run.nodes[index].status = "running".into();
        state.store.save_run(run)?;
        let value = if node.kind == NodeKind::Brief {
            serde_json::json!({"text":node.config.text})
        } else {
            let edge = run
                .snapshot
                .edges
                .iter()
                .find(|e| e.target == node.id)
                .ok_or("缺少输入")?;
            let input = values.get(&edge.source).ok_or("上游结果不可用")?;
            let provider = run
                .providers
                .iter()
                .find(|p| p.id == node.config.provider_id)
                .ok_or("模型配置不存在")?;
            tokio::select! {
                result=providers::generate(provider,&node,input)=>result?,
                ()=cancelled(cancel.clone())=> {
                    run.nodes[index].status="cancelled".into();
                    run.nodes[index].message="已停止等待与后续调度；服务端可能仍在生成或计费".into();
                    run.status="cancelled".into();return Ok(());
                }
            }
        };
        values.insert(node.id.clone(), value.clone());
        run.nodes[index].output = Some(Artifact {
            id: uid(),
            kind: node.kind,
            value,
            created_at: now(),
            source: "model".into(),
        });
        run.nodes[index].status = "succeeded".into();
        state.store.save_run(run)?;
    }
    run.status = "succeeded".into();
    Ok(())
}
