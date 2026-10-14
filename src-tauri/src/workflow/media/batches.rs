//! Persist intent before dispatch. An uncertain child is never submitted twice.
use super::*;
use std::{
    collections::HashSet,
    sync::atomic::{AtomicBool, Ordering},
    time::Duration,
};
use tauri::Manager;

#[derive(Clone, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    content = "request",
    rename_all = "lowercase",
    deny_unknown_fields
)]
pub enum BatchRequest {
    Cloud(cloud::CloudImageRequest),
    Comfy(comfy::ImageRequest),
}
impl BatchRequest {
    fn context(&self) -> &ShotContext {
        match self {
            Self::Cloud(r) => &r.context,
            Self::Comfy(r) => &r.context,
        }
    }
    fn table(&self) -> &str {
        match self {
            Self::Cloud(_) => "cloud_image_jobs",
            Self::Comfy(_) => "image_jobs",
        }
    }
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchItem {
    pub request: BatchRequest,
    pub job_id: String,
    pub previous_job_ids: Vec<String>,
    pub status: String,
    pub message: String,
    pub asset_ids: Vec<String>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageBatch {
    pub id: String,
    pub workflow_id: String,
    pub items: Vec<BatchItem>,
    pub status: String,
    pub created_at: u64,
    pub updated_at: u64,
}
fn read(db: &rusqlite::Connection, id: &str) -> AppResult<ImageBatch> {
    let value: String = db
        .query_row("SELECT json FROM image_batches WHERE id=?1", [id], |r| {
            r.get(0)
        })
        .map_err(|_| "批量队列不存在")?;
    serde_json::from_str(&value).map_err(|e| e.to_string())
}
fn write(db: &rusqlite::Connection, batch: &ImageBatch) -> AppResult<()> {
    db.execute("INSERT INTO image_batches VALUES (?1,?2,?3,?4) ON CONFLICT(id) DO UPDATE SET json=excluded.json",
        params![batch.id, batch.workflow_id, serde_json::to_string(batch).map_err(|e| e.to_string())?, batch.created_at])
        .map_err(|e| e.to_string())?;
    Ok(())
}
fn update(
    state: &WorkflowState,
    id: &str,
    change: impl FnOnce(&rusqlite::Connection, &mut ImageBatch) -> AppResult<()>,
) -> AppResult<ImageBatch> {
    // Read/modify/write under the same connection mutex prevents pause/worker lost updates.
    let db = state.store.db()?;
    let mut batch = read(&db, id)?;
    change(&db, &mut batch)?;
    batch.updated_at = now();
    write(&db, &batch)?;
    Ok(batch)
}
fn child(db: &rusqlite::Connection, item: &BatchItem) -> AppResult<Option<serde_json::Value>> {
    let value: Option<String> = db
        .query_row(
            &format!("SELECT json FROM {} WHERE id=?1", item.request.table()),
            [&item.job_id],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    value
        .map(|v| serde_json::from_str(&v).map_err(|e| e.to_string()))
        .transpose()
}
fn running(db: &rusqlite::Connection) -> AppResult<Option<String>> {
    db.query_row("SELECT id FROM image_batches WHERE json_extract(json,'$.status')='running' ORDER BY created_at LIMIT 1",
        [], |r| r.get(0)).optional().map_err(|e| e.to_string())
}
fn reconcile(item: &mut BatchItem, value: Option<&serde_json::Value>) {
    match value.and_then(|v| v["status"].as_str()) {
        Some("succeeded" | "failed" | "unknown" | "paused") => {
            let value = value.unwrap();
            item.status = value["status"].as_str().unwrap().into();
            item.message = value["message"].as_str().unwrap_or_default().into();
            item.asset_ids = value["assetIds"]
                .as_array()
                .map(|a| {
                    a.iter()
                        .filter_map(|v| v.as_str().map(str::to_owned))
                        .collect()
                })
                .unwrap_or_default();
        }
        None => {
            item.status = "unknown".into();
            item.message = "提交时应用退出，结果待核实；不会自动重发".into();
        }
        _ => {}
    }
}
fn retry(item: &mut BatchItem) -> AppResult<()> {
    if item.status != "failed" {
        return Err("只有已知失败的镜头可以重跑".into());
    }
    item.previous_job_ids.push(item.job_id.clone());
    item.job_id = uid();
    item.status = "queued".into();
    item.message = "等待手动继续队列；重新提交可能计费".into();
    Ok(())
}
pub fn recover(state: &WorkflowState) -> AppResult<()> {
    let db = state.store.db()?;
    let ids: Vec<String> = db
        .prepare("SELECT id FROM image_batches")
        .map_err(|e| e.to_string())?
        .query_map([], |r| r.get(0))
        .map_err(|e| e.to_string())?
        .collect::<Result<_, _>>()
        .map_err(|e| e.to_string())?;
    for id in ids {
        let mut batch = read(&db, &id)?;
        for item in batch.items.iter_mut().filter(|i| i.status == "running") {
            let value = child(&db, item)?;
            reconcile(item, value.as_ref());
        }
        if batch.status == "running" {
            batch.status = "paused".into();
        }
        batch.updated_at = now();
        write(&db, &batch)?;
    }
    Ok(())
}
#[tauri::command]
pub fn list_image_batches(
    state: tauri::State<WorkflowState>,
    workflow_id: String,
) -> AppResult<Vec<ImageBatch>> {
    let db = state.store.db()?;
    let mut query = db
        .prepare(
            "SELECT json FROM image_batches WHERE workflow_id=?1 ORDER BY created_at DESC LIMIT 50",
        )
        .map_err(|e| e.to_string())?;
    let rows = query
        .query_map([workflow_id], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    rows.map(|r| serde_json::from_str(&r.map_err(|e| e.to_string())?).map_err(|e| e.to_string()))
        .collect()
}
#[tauri::command]
pub fn start_image_batch(
    app: tauri::AppHandle,
    requests: Vec<BatchRequest>,
) -> AppResult<ImageBatch> {
    if requests.is_empty()
        || requests.len() > 24
        || serde_json::to_vec(&requests)
            .map_err(|e| e.to_string())?
            .len()
            > 8_000_000
    {
        return Err("批量队列须包含 1–24 个镜头".into());
    }
    let state = app.state::<WorkflowState>();
    let workflow_id = requests[0].context().workflow_id.clone();
    let mut contexts = HashSet::new();
    let mut estimate = 0u64;
    for request in &requests {
        let context = request.context();
        if context.workflow_id != workflow_id
            || !contexts.insert((
                context.node_id.clone(),
                context.artifact_id.clone(),
                context.shot_id.clone(),
            ))
        {
            return Err("批量镜头须属于同一项目，且不能重复".into());
        }
        validate_context(&state, context)?;
        match request {
            BatchRequest::Cloud(r) => {
                cloud::validate(r)?;
                estimate += r.budget_reservation_micro_usd;
            }
            BatchRequest::Comfy(r) => comfy::validate(r)?,
        }
    }
    let budget = budget::get_media_budget(app.state(), workflow_id.clone())?;
    if budget
        .limit_micro_usd
        .is_some_and(|limit| budget.reserved_micro_usd.saturating_add(estimate) > limit)
    {
        return Err("批量预留金额超过项目剩余预算，请减少镜头或调整预算".into());
    }
    let batch = ImageBatch {
        id: uid(),
        workflow_id,
        status: "running".into(),
        created_at: now(),
        updated_at: now(),
        items: requests
            .into_iter()
            .map(|request| BatchItem {
                request,
                job_id: uid(),
                previous_job_ids: vec![],
                status: "queued".into(),
                message: "等待提交".into(),
                asset_ids: vec![],
            })
            .collect(),
    };
    {
        let db = state.store.db()?;
        if running(&db)?.is_some() {
            return Err("已有批量队列运行，请先暂停或等待完成".into());
        }
        write(&db, &batch)?;
    }
    kick(app.clone());
    Ok(batch)
}
#[tauri::command]
pub fn pause_image_batch(state: tauri::State<WorkflowState>, id: String) -> AppResult<()> {
    update(&state, &id, |_, batch| {
        if batch.status == "running" {
            batch.status = "paused".into();
        }
        Ok(())
    })?;
    Ok(())
}
#[tauri::command]
pub fn resume_image_batch(app: tauri::AppHandle, id: String) -> AppResult<()> {
    let state = app.state::<WorkflowState>();
    let paused = {
        let db = state.store.db()?;
        if running(&db)?.is_some() {
            return Err("已有批量队列运行".into());
        }
        let mut batch = read(&db, &id)?;
        for item in batch.items.iter_mut().filter(|i| i.status == "running") {
            let value = child(&db, item)?;
            reconcile(item, value.as_ref());
        }
        if batch.items.iter().any(|i| i.status == "unknown") {
            return Err("先核对服务商结果，再跳过未知项".into());
        }
        write(&db, &batch)?;
        batch
    }
    .items
    .into_iter()
    .filter(|i| i.status == "paused")
    .collect::<Vec<_>>();
    for item in paused {
        if let BatchRequest::Comfy(_) = item.request {
            comfy::resume_image_job(app.clone(), app.state(), item.job_id)?;
        }
    }
    {
        let db = state.store.db()?;
        if running(&db)?.is_some() {
            return Err("已有批量队列运行".into());
        }
        let mut batch = read(&db, &id)?;
        if batch.items.iter().any(|i| i.status == "unknown") {
            return Err("先核对服务商结果，再跳过未知项；此处不会重提未知请求".into());
        }
        for item in &mut batch.items {
            if item.status == "paused" {
                item.status = "running".into();
            }
        }
        batch.status = "running".into();
        batch.updated_at = now();
        write(&db, &batch)?;
    }
    kick(app.clone());
    Ok(())
}
#[tauri::command]
pub fn retry_image_batch_item(
    state: tauri::State<WorkflowState>,
    id: String,
    index: usize,
) -> AppResult<()> {
    update(&state, &id, |_, batch| {
        if batch.status == "running" {
            return Err("请先暂停队列，再重跑失败镜头".into());
        }
        let item = batch.items.get_mut(index).ok_or("镜头不存在")?;
        retry(item)?;
        batch.status = "paused".into();
        Ok(())
    })?;
    Ok(())
}
#[tauri::command]
pub fn skip_unknown_image_batch_item(
    state: tauri::State<WorkflowState>,
    id: String,
    index: usize,
) -> AppResult<()> {
    update(&state, &id, |_, batch| {
        let item = batch.items.get_mut(index).ok_or("镜头不存在")?;
        if item.status != "unknown" {
            return Err("此操作只跳过已核对的未知项".into());
        }
        item.status = "skipped".into();
        item.message = "已手动跳过，不会再次提交；原任务及预算记录保留".into();
        Ok(())
    })?;
    Ok(())
}
static WORKER: AtomicBool = AtomicBool::new(false);
fn kick(app: tauri::AppHandle) {
    if WORKER
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return;
    }
    tauri::async_runtime::spawn(async move {
        let mut failed = false;
        loop {
            let result = tick(&app);
            match result {
                Ok(true) => tokio::time::sleep(Duration::from_millis(700)).await,
                Err(error) => {
                    failed = true;
                    eprintln!("Image batch stopped: {error}");
                    break;
                }
                Ok(false) => break,
            }
        }
        WORKER.store(false, Ordering::SeqCst);
        // Close the enqueue/worker-exit race without creating another active worker.
        if !failed
            && app
                .state::<WorkflowState>()
                .store
                .db()
                .and_then(|db| running(&db))
                .ok()
                .flatten()
                .is_some()
        {
            kick(app.clone());
        }
    });
}
fn tick(app: &tauri::AppHandle) -> AppResult<bool> {
    let state = app.state::<WorkflowState>();
    let Some(id) = running(&*state.store.db()?)? else {
        return Ok(false);
    };
    let mut dispatch = None;
    let media_busy = state
        .media_active
        .lock()
        .map_err(|_| "图片任务锁不可用")?
        .is_some();
    update(&state, &id, |db, batch| {
        if batch.status != "running" {
            return Ok(());
        }
        if let Some(item) = batch
            .items
            .iter_mut()
            .find(|i| matches!(i.status.as_str(), "running" | "paused"))
        {
            let value = child(db, item)?;
            reconcile(item, value.as_ref());
            if item.status == "running" && !media_busy {
                item.status = "unknown".into();
                item.message = "本地任务已停止但结果未确认，请核对后再继续".into();
            }
            if matches!(item.status.as_str(), "unknown" | "paused") {
                batch.status = "paused".into();
            }
            return Ok(());
        }
        if media_busy {
            return Ok(());
        }
        if let Some(item) = batch.items.iter_mut().find(|i| i.status == "queued") {
            item.status = "running".into();
            item.message = "正在提交".into();
            dispatch = Some((item.job_id.clone(), item.request.clone()));
        } else {
            batch.status = if batch.items.iter().any(|i| i.status == "failed") {
                "failed"
            } else {
                "succeeded"
            }
            .into();
        }
        Ok(())
    })?;
    if let Some((job_id, request)) = dispatch {
        let result = match request {
            BatchRequest::Cloud(r) => {
                cloud::start_with_id(app.clone(), app.state(), r, job_id.clone()).map(|_| ())
            }
            BatchRequest::Comfy(r) => {
                comfy::start_with_id(app.clone(), app.state(), r, job_id.clone()).map(|_| ())
            }
        };
        if let Err(error) = result {
            update(&state, &id, |_, batch| {
                if let Some(item) = batch.items.iter_mut().find(|i| i.job_id == job_id) {
                    item.status = "failed".into();
                    item.message = error;
                }
                Ok(())
            })?;
        }
    }
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn restart_preserves_intent_and_never_requeues_unknown_submissions() {
        let directory = std::env::temp_dir().join(format!("frame-batch-{}", uid()));
        std::fs::create_dir(&directory).unwrap();
        let state = WorkflowState {
            store: crate::workflow::storage::Store::open(&directory.join("test.sqlite")).unwrap(),
            active: std::sync::Mutex::new(None),
            media_active: std::sync::Mutex::new(None),
            video_active: std::sync::Mutex::new(std::collections::HashMap::new()),
            export_active: std::sync::Mutex::new(None),
            speech_active: std::sync::Mutex::new(None),
            transcription_active: std::sync::Mutex::new(None),
            model_pull: std::sync::Mutex::new(None),
            comfy_download: std::sync::Mutex::new(None),
            directory: directory.clone(),
        };
        let request = BatchRequest::Cloud(cloud::CloudImageRequest {
            context: ShotContext {
                workflow_id: "w".into(),
                node_id: "n".into(),
                artifact_id: "a".into(),
                shot_id: "s".into(),
            },
            base_url: "https://example.com/v1".into(),
            model: "gpt-image-2".into(),
            positive: "cat".into(),
            negative: String::new(),
            size: "1024x1024".into(),
            quality: "low".into(),
            budget_reservation_micro_usd: 250000,
            reference_version_id: None,
        });
        let item = BatchItem {
            request,
            job_id: "uncertain".into(),
            previous_job_ids: vec![],
            status: "running".into(),
            message: String::new(),
            asset_ids: vec![],
        };
        let mut waiting = item.clone();
        waiting.job_id = "not-dispatched".into();
        waiting.status = "queued".into();
        let mut saved = item.clone();
        saved.job_id = "saved".into();
        let batch = ImageBatch {
            id: "batch".into(),
            workflow_id: "w".into(),
            items: vec![item, waiting, saved],
            status: "running".into(),
            created_at: now(),
            updated_at: now(),
        };
        {
            let db = state.store.db().unwrap();
            write(&db, &batch).unwrap();
            db.execute(
                "INSERT INTO cloud_image_jobs VALUES ('saved','w',?1,1)",
                [r#"{"status":"succeeded","message":"saved","assetIds":["image"]}"#],
            )
            .unwrap();
        }
        recover(&state).unwrap();
        let mut recovered = read(&state.store.db().unwrap(), "batch").unwrap();
        assert_eq!(recovered.status, "paused");
        assert_eq!(recovered.items[0].status, "unknown");
        assert!(retry(&mut recovered.items[0]).is_err());
        assert_eq!(recovered.items[0].job_id, "uncertain");
        assert_eq!(recovered.items[1].status, "queued");
        assert_eq!(recovered.items[1].job_id, "not-dispatched");
        assert_eq!(recovered.items[2].asset_ids, ["image"]);
        recovered.items[2].status = "failed".into();
        retry(&mut recovered.items[2]).unwrap();
        assert_ne!(recovered.items[2].job_id, "saved");
        assert_eq!(recovered.items[2].previous_job_ids, ["saved"]);
        drop(state);
        std::fs::remove_dir_all(directory).unwrap();
    }
}
