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
    Video(video::VideoRequest),
}
impl BatchRequest {
    fn context(&self) -> &ShotContext {
        match self {
            Self::Cloud(r) => &r.context,
            Self::Comfy(r) => &r.context,
            Self::Video(r) => &r.context,
        }
    }
    fn table(&self) -> &str {
        match self {
            Self::Cloud(_) => "cloud_image_jobs",
            Self::Comfy(_) => "image_jobs",
            Self::Video(_) => "video_jobs",
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
                .unwrap_or_else(|| {
                    value["assetId"]
                        .as_str()
                        .map(str::to_owned)
                        .into_iter()
                        .collect()
                });
        }
        None => {
            item.status = "unknown".into();
            item.message = "提交时应用退出，结果待核实；不会自动重发".into();
        }
        Some("submitting" | "queued" | "running" | "waiting" | "downloading")
            if item.status == "paused" =>
        {
            // A child may be resumed directly from its individual task history.
            item.status = "running".into();
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
        for item in batch
            .items
            .iter_mut()
            .filter(|i| matches!(i.status.as_str(), "running" | "paused"))
        {
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
    let mut batches: Vec<ImageBatch> = rows
        .map(|r| serde_json::from_str(&r.map_err(|e| e.to_string())?).map_err(|e| e.to_string()))
        .collect::<AppResult<_>>()?;
    drop(query);
    for batch in batches.iter_mut().filter(|b| b.status != "running") {
        let before = serde_json::to_string(batch).map_err(|e| e.to_string())?;
        for item in batch
            .items
            .iter_mut()
            .filter(|i| matches!(i.status.as_str(), "running" | "paused"))
        {
            if let Some(value) = child(&db, item)? {
                reconcile(item, Some(&value));
            }
        }
        if serde_json::to_string(batch).map_err(|e| e.to_string())? != before {
            batch.updated_at = now();
            write(&db, batch)?;
        }
    }
    Ok(batches)
}
#[tauri::command]
pub fn start_image_batch(
    app: tauri::AppHandle,
    requests: Vec<BatchRequest>,
) -> AppResult<ImageBatch> {
    if requests.iter().any(|r| matches!(r, BatchRequest::Video(_))) {
        return Err("请从视频批量入口提交视频任务".into());
    }
    start_batch(app, requests)
}
#[tauri::command]
pub fn start_video_batch(
    app: tauri::AppHandle,
    requests: Vec<video::VideoRequest>,
) -> AppResult<ImageBatch> {
    start_batch(app, requests.into_iter().map(BatchRequest::Video).collect())
}
fn start_batch(app: tauri::AppHandle, requests: Vec<BatchRequest>) -> AppResult<ImageBatch> {
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
        let amount = match request {
            BatchRequest::Cloud(r) => {
                cloud::validate(r)?;
                r.budget_reservation_micro_usd
            }
            BatchRequest::Comfy(r) => {
                comfy::validate(r)?;
                0
            }
            BatchRequest::Video(r) => {
                video::validate_request(&state, r)?;
                budget::video_estimate_micro_usd(&r.region, r.duration, &r.resolution)?
            }
        };
        estimate = estimate.checked_add(amount).ok_or("批量预算金额溢出")?;
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
        for item in batch
            .items
            .iter_mut()
            .filter(|i| matches!(i.status.as_str(), "running" | "paused"))
        {
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
        match item.request {
            BatchRequest::Comfy(_) => {
                comfy::resume_image_job(app.clone(), app.state(), item.job_id)?
            }
            BatchRequest::Video(_) => {
                video::resume_video_job(app.clone(), app.state(), item.job_id)?
            }
            BatchRequest::Cloud(_) => return Err("云端图片暂停结果须先核对".into()),
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
                    eprintln!("Media batch stopped: {error}");
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
    // Sample provider locks before taking the store lock, matching provider start order.
    let video_ids: HashSet<String> = state
        .video_active
        .lock()
        .map_err(|_| "视频任务锁不可用")?
        .keys()
        .cloned()
        .collect();
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
            let active = match item.request {
                BatchRequest::Video(_) => video_ids.contains(&item.job_id),
                _ => media_busy,
            };
            if item.status == "running" && !active {
                item.status = if matches!(item.request, BatchRequest::Video(_))
                    && value.as_ref().and_then(|v| v["taskId"].as_str()).is_some()
                {
                    "paused"
                } else {
                    "unknown"
                }
                .into();
                item.message = "本地任务已停止但结果未确认，请核对后再继续".into();
                if item.status == "paused" {
                    // Persist the pollable child state as well, so the provider's resume gate agrees.
                    if let Some(mut value) = value {
                        value["status"] = "paused".into();
                        value["message"] = item.message.clone().into();
                        value["updatedAt"] = now().into();
                        db.execute(
                            "UPDATE video_jobs SET json=?1 WHERE id=?2",
                            params![
                                serde_json::to_string(&value).map_err(|e| e.to_string())?,
                                item.job_id
                            ],
                        )
                        .map_err(|e| e.to_string())?;
                    }
                }
            }
            if matches!(item.status.as_str(), "unknown" | "paused") {
                batch.status = "paused".into();
            }
            return Ok(());
        }
        if let Some(item) = batch.items.iter_mut().find(|i| i.status == "queued") {
            let busy = match item.request {
                BatchRequest::Video(_) => !video_ids.is_empty(),
                _ => media_busy,
            };
            if busy {
                return Ok(());
            }
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
            BatchRequest::Video(r) => {
                video::start_with_id(app.clone(), app.state(), r, job_id.clone()).map(|_| ())
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
        let mut video_item = saved.clone();
        video_item.job_id = "video-saved".into();
        video_item.request = BatchRequest::Video(video::VideoRequest {
            context: video_item.request.context().clone(),
            first_frame_version_id: "frame-v1".into(),
            region: "singapore".into(),
            prompt: "camera pans".into(),
            negative_prompt: String::new(),
            duration: 5,
            resolution: "720P".into(),
        });
        let mut paused_video = video_item.clone();
        paused_video.job_id = "video-paused".into();
        let batch = ImageBatch {
            id: "batch".into(),
            workflow_id: "w".into(),
            items: vec![item, waiting, saved, video_item, paused_video],
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
            db.execute(
                "INSERT INTO video_jobs VALUES ('video-saved','w',?1,1)",
                [r#"{"status":"succeeded","message":"saved","assetId":"video"}"#],
            )
            .unwrap();
            db.execute(
                "INSERT INTO video_jobs VALUES ('video-paused','w',?1,1)",
                [r#"{"status":"paused","message":"resume original","taskId":"remote-1"}"#],
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
        assert_eq!(recovered.items[3].asset_ids, ["video"]);
        assert_eq!(recovered.items[4].status, "paused");
        assert_eq!(recovered.items[4].job_id, "video-paused");
        assert!(retry(&mut recovered.items[4]).is_err());
        let child = child(&state.store.db().unwrap(), &recovered.items[4])
            .unwrap()
            .unwrap();
        assert_eq!(child["taskId"], "remote-1");
        reconcile(
            &mut recovered.items[4],
            Some(&serde_json::json!({"status":"running"})),
        );
        assert_eq!(recovered.items[4].status, "running");
        reconcile(
            &mut recovered.items[4],
            Some(&serde_json::json!({"status":"succeeded","assetId":"resumed-video"})),
        );
        assert_eq!(recovered.items[4].asset_ids, ["resumed-video"]);
        recovered.items[2].status = "failed".into();
        retry(&mut recovered.items[2]).unwrap();
        assert_ne!(recovered.items[2].job_id, "saved");
        assert_eq!(recovered.items[2].previous_job_ids, ["saved"]);
        drop(state);
        std::fs::remove_dir_all(directory).unwrap();
    }
}
