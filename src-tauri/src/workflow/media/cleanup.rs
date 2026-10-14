//! Explicit quarantine of unreferenced versions. Journal intent survives interruption.
use super::*;
use rusqlite::Connection;
use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
};
use tauri::Manager;

#[derive(Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
enum Kind {
    Image,
    Video,
    Audio,
}
impl Kind {
    fn table(self) -> &'static str {
        match self {
            Self::Image => "image_assets",
            Self::Video => "video_assets",
            Self::Audio => "audio_assets",
        }
    }
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Version {
    id: String,
    kind: Kind,
    json: serde_json::Value,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MovedFile {
    name: String,
    stored_name: String,
    bytes: u64,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Journal {
    id: String,
    version: Version,
    files: Vec<MovedFile>,
    status: String,
    created_at: u64,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageItem {
    id: String,
    kind: Kind,
    name: String,
    bytes: u64,
    status: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageGroup {
    kind: Kind,
    count: usize,
    bytes: u64,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageReport {
    asset_bytes: u64,
    database_bytes: u64,
    other_bytes: u64,
    trash_bytes: u64,
    protected_count: usize,
    cleanable_count: usize,
    cleanable_bytes: u64,
    groups: Vec<StorageGroup>,
    candidates: Vec<StorageItem>,
    trash: Vec<StorageItem>,
    busy: bool,
}
fn values(db: &Connection, table: &str) -> AppResult<Vec<serde_json::Value>> {
    let mut q = db
        .prepare(&format!("SELECT json FROM {table}"))
        .map_err(|e| e.to_string())?;
    let rows = q
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    rows.map(|r| serde_json::from_str(&r.map_err(|e| e.to_string())?).map_err(|e| e.to_string()))
        .collect()
}
fn journals(db: &Connection) -> AppResult<Vec<Journal>> {
    values(db, "asset_trash")?
        .into_iter()
        .map(|v| serde_json::from_value(v).map_err(|e| e.to_string()))
        .collect()
}
fn versions(db: &Connection) -> AppResult<Vec<Version>> {
    let mut result = vec![];
    for kind in [Kind::Image, Kind::Video, Kind::Audio] {
        let mut q = db
            .prepare(&format!("SELECT id,json FROM {}", kind.table()))
            .map_err(|e| e.to_string())?;
        let rows = q
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
            .map_err(|e| e.to_string())?;
        for row in rows {
            let (id, json) = row.map_err(|e| e.to_string())?;
            result.push(Version {
                id,
                kind,
                json: serde_json::from_str(&json).map_err(|e| e.to_string())?,
            });
        }
    }
    Ok(result)
}
fn strings(value: &serde_json::Value, result: &mut HashSet<String>) {
    match value {
        serde_json::Value::String(s) => {
            result.insert(s.clone());
        }
        serde_json::Value::Array(a) => a.iter().for_each(|v| strings(v, result)),
        serde_json::Value::Object(o) => o.values().for_each(|v| strings(v, result)),
        _ => {}
    }
}
fn roots(db: &Connection) -> AppResult<(HashSet<String>, bool)> {
    let mut refs = HashSet::new();
    let mut busy = false;
    for table in [
        "workflows",
        "runs",
        "compositions",
        "export_jobs",
        "media_settings",
    ] {
        for v in values(db, table)? {
            busy |= active(&v);
            strings(&v, &mut refs);
        }
    }
    for table in ["first_frames", "role_references", "selected_videos"] {
        let mut q = db
            .prepare(&format!("SELECT version_id FROM {table}"))
            .map_err(|e| e.to_string())?;
        let rows = q
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        for r in rows {
            refs.insert(r.map_err(|e| e.to_string())?);
        }
    }
    for table in [
        "image_jobs",
        "cloud_image_jobs",
        "video_jobs",
        "speech_jobs",
        "transcription_jobs",
        "image_batches",
    ] {
        for v in values(db, table)? {
            busy |= active(&v);
            strings(&v["request"], &mut refs);
            if let Some(items) = v["items"].as_array() {
                for item in items {
                    strings(&item["request"], &mut refs);
                }
            }
            if active(&v) {
                strings(&v, &mut refs);
            }
        }
    }
    // Retain dependencies of both available and recoverable candidate versions.
    for v in values(db, "video_assets")?
        .into_iter()
        .chain(values(db, "subtitle_assets")?)
        .chain(journals(db)?.into_iter().map(|j| j.version.json))
    {
        for key in ["firstFrameVersionId", "sourceAudioVersionId"] {
            strings(&v[key], &mut refs);
        }
    }
    Ok((refs, busy))
}
fn active(v: &serde_json::Value) -> bool {
    matches!(
        v["status"].as_str(),
        Some("running" | "queued" | "submitting" | "waiting" | "downloading")
    )
}
fn protected(v: &Version, refs: &HashSet<String>) -> bool {
    refs.contains(&v.id) || v.json["assetId"].as_str().is_some_and(|s| refs.contains(s))
}
fn folder(base: &Path, name: &str) -> AppResult<PathBuf> {
    let canonical = base.canonicalize().map_err(|e| e.to_string())?;
    let path = canonical.join(name);
    fs::create_dir_all(&path).map_err(|e| e.to_string())?;
    let actual = path.canonicalize().map_err(|e| e.to_string())?;
    if actual != path
        || fs::symlink_metadata(&path)
            .map_err(|e| e.to_string())?
            .file_type()
            .is_symlink()
    {
        return Err("素材目录存在外部链接，已停止清理".into());
    }
    Ok(path)
}
fn file(directory: &Path, name: &str) -> AppResult<PathBuf> {
    if name.is_empty() || name == "." || name == ".." || name.contains(['/', '\\', ':']) {
        return Err("素材文件名无效".into());
    }
    let path = directory.join(name);
    match fs::symlink_metadata(&path) {
        Ok(m) if !m.file_type().is_file() || m.file_type().is_symlink() => {
            return Err("素材包含链接或特殊文件，已停止操作".into())
        }
        Ok(_) => {
            if path.canonicalize().map_err(|e| e.to_string())?.parent() != Some(directory) {
                return Err("素材文件超出素材目录".into());
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(e.to_string()),
    }
    Ok(path)
}
fn names(v: &Version) -> AppResult<Vec<String>> {
    let name = v.json["fileName"].as_str().ok_or("素材缺少文件名")?;
    let mut names = vec![name.to_owned()];
    if matches!(v.kind, Kind::Image) {
        names.push(format!("{}.thumb.png", v.id));
    }
    Ok(names)
}
fn version_files(directory: &Path, v: &Version, id: &str) -> AppResult<Vec<MovedFile>> {
    let mut files = vec![];
    for (index, name) in names(v)?.into_iter().enumerate() {
        let path = file(directory, &name)?;
        if path.is_file() {
            files.push(MovedFile {
                name,
                stored_name: format!("{id}-{index}.bin"),
                bytes: fs::metadata(path).map_err(|e| e.to_string())?.len(),
            });
        }
    }
    Ok(files)
}
fn item(v: &Version, id: String, bytes: u64, status: &str) -> StorageItem {
    StorageItem {
        id,
        kind: v.kind,
        name: v.json["name"]
            .as_str()
            .or_else(|| v.json.pointer("/context/shotId").and_then(|v| v.as_str()))
            .unwrap_or(&v.id)
            .into(),
        bytes,
        status: status.into(),
    }
}
fn save(db: &Connection, j: &Journal) -> AppResult<()> {
    db.execute(
        "INSERT INTO asset_trash VALUES (?1,?2) ON CONFLICT(id) DO UPDATE SET json=excluded.json",
        params![j.id, serde_json::to_string(j).map_err(|e| e.to_string())?],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}
fn load(db: &Connection, id: &str) -> AppResult<Journal> {
    let json: String = db
        .query_row("SELECT json FROM asset_trash WHERE id=?1", [id], |r| {
            r.get(0)
        })
        .map_err(|_| "回收记录不存在")?;
    serde_json::from_str(&json).map_err(|e| e.to_string())
}
fn atomic(db: &Connection, change: impl FnOnce() -> AppResult<()>) -> AppResult<()> {
    db.execute_batch("SAVEPOINT asset_cleanup")
        .map_err(|e| e.to_string())?;
    let result = change().and_then(|_| {
        db.execute_batch("RELEASE asset_cleanup")
            .map_err(|e| e.to_string())
    });
    if result.is_err() {
        let _ = db.execute_batch("ROLLBACK TO asset_cleanup; RELEASE asset_cleanup");
    }
    result
}
fn finish_restore(db: &Connection, directory: &Path, j: &Journal) -> AppResult<()> {
    let assets = folder(directory, "assets")?;
    let trash = folder(directory, "asset-trash")?;
    for f in &j.files {
        let source = file(&trash, &f.stored_name)?;
        let target = file(&assets, &f.name)?;
        if source.exists() {
            if target.exists() {
                return Err("原位置已有文件，恢复已停止，未覆盖文件".into());
            }
            fs::rename(source, target).map_err(|e| e.to_string())?;
        } else if !target.exists() {
            return Err("回收文件已丢失，请检查备份".into());
        }
    }
    atomic(db, || {
        let existing: Option<String> = db
            .query_row(
                &format!("SELECT json FROM {} WHERE id=?1", j.version.kind.table()),
                [&j.version.id],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        if let Some(json) = existing {
            if serde_json::from_str::<serde_json::Value>(&json).map_err(|e| e.to_string())?
                != j.version.json
            {
                return Err("素材版本已存在且内容不同".into());
            }
        } else {
            let json = serde_json::to_string(&j.version.json).map_err(|e| e.to_string())?;
            let created = j.version.json["createdAt"].as_u64().ok_or("素材时间无效")?;
            if matches!(j.version.kind, Kind::Audio) {
                let workflow = j.version.json["workflowId"]
                    .as_str()
                    .ok_or("音频项目无效")?;
                db.execute(
                    "INSERT INTO audio_assets VALUES (?1,?2,?3,?4)",
                    params![j.version.id, workflow, json, created],
                )
                .map_err(|e| e.to_string())?;
            } else {
                db.execute(
                    &format!("INSERT INTO {} VALUES (?1,?2,?3)", j.version.kind.table()),
                    params![j.version.id, json, created],
                )
                .map_err(|e| e.to_string())?;
            }
        }
        db.execute("DELETE FROM asset_trash WHERE id=?1", [&j.id])
            .map_err(|e| e.to_string())?;
        Ok(())
    })
}
fn finish_purge(db: &Connection, directory: &Path, j: &Journal) -> AppResult<()> {
    let (refs, busy) = roots(db)?;
    if busy || protected(&j.version, &refs) {
        return Err("素材正被项目或任务引用，请先恢复并检查引用".into());
    }
    let trash = folder(directory, "asset-trash")?;
    for f in &j.files {
        let path = file(&trash, &f.stored_name)?;
        if path.exists() {
            fs::remove_file(path).map_err(|e| e.to_string())?;
        }
    }
    db.execute("DELETE FROM asset_trash WHERE id=?1", [&j.id])
        .map_err(|e| e.to_string())?;
    Ok(())
}
pub fn recover(state: &WorkflowState) -> AppResult<()> {
    let db = state.store.db()?;
    for j in journals(&db)? {
        let result = match j.status.as_str() {
            "moving" | "restoring" => finish_restore(&db, &state.directory, &j),
            "purging" => finish_purge(&db, &state.directory, &j),
            _ => Ok(()),
        };
        if let Err(e) = result {
            eprintln!("Asset recovery pending: {e}");
        }
    }
    Ok(())
}
fn report(state: &WorkflowState) -> AppResult<StorageReport> {
    let db = state.store.db()?;
    let assets = folder(&state.directory, "assets")?;
    let trash_dir = folder(&state.directory, "asset-trash")?;
    let (refs, busy) = roots(&db)?;
    let versions = versions(&db)?;
    let journal = journals(&db)?;
    let held: HashSet<_> = journal.iter().map(|j| j.version.id.as_str()).collect();
    let mut groups: Vec<StorageGroup> = vec![];
    let mut candidates = vec![];
    let mut protected_count = 0;
    let mut cleanable_bytes = 0;
    let mut cleanable_count = 0;
    for v in &versions {
        let files = version_files(&assets, v, "scan")?;
        let bytes = files.iter().map(|f| f.bytes).sum();
        let group = groups.iter_mut().find(|g| g.kind.table() == v.kind.table());
        if let Some(g) = group {
            g.count += 1;
            g.bytes += bytes;
        } else {
            groups.push(StorageGroup {
                kind: v.kind,
                count: 1,
                bytes,
            });
        }
        if protected(v, &refs) || held.contains(v.id.as_str()) {
            protected_count += 1;
        } else {
            cleanable_count += 1;
            cleanable_bytes += bytes;
            if candidates.len() < 500 {
                candidates.push(item(v, v.id.clone(), bytes, "available"));
            }
        }
    }
    let sum_directory = |directory: &Path| -> AppResult<u64> {
        let mut bytes = 0;
        for entry in fs::read_dir(directory).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let m = entry.metadata().map_err(|e| e.to_string())?;
            if m.is_file() && !entry.file_type().map_err(|e| e.to_string())?.is_symlink() {
                bytes += m.len();
            }
        }
        Ok(bytes)
    };
    let asset_bytes = sum_directory(&assets)?;
    let registered_bytes: u64 = groups.iter().map(|g| g.bytes).sum();
    let database_bytes = ["studio.sqlite", "studio.sqlite-wal", "studio.sqlite-shm"]
        .iter()
        .map(|n| {
            fs::metadata(state.directory.join(n))
                .map(|m| m.len())
                .unwrap_or(0)
        })
        .sum();
    let mut trash: Vec<_> = journal
        .iter()
        .take(500)
        .map(|j| {
            item(
                &j.version,
                j.id.clone(),
                j.files.iter().map(|f| f.bytes).sum(),
                &j.status,
            )
        })
        .collect();
    trash.reverse();
    Ok(StorageReport {
        asset_bytes,
        database_bytes,
        other_bytes: asset_bytes.saturating_sub(registered_bytes),
        trash_bytes: sum_directory(&trash_dir)?,
        protected_count,
        cleanable_count,
        cleanable_bytes,
        groups,
        candidates,
        trash,
        busy,
    })
}
fn move_versions(state: &WorkflowState, ids: Vec<String>) -> AppResult<()> {
    if ids.is_empty() || ids.len() > 100 || ids.iter().collect::<HashSet<_>>().len() != ids.len() {
        return Err("每次请选择 1–100 个不同素材".into());
    }
    let db = state.store.db()?;
    let (refs, busy) = roots(&db)?;
    if busy {
        return Err("任务正在运行，请等待完成或暂停后清理".into());
    }
    let all = versions(&db)?;
    let held: HashSet<_> = journals(&db)?.into_iter().map(|j| j.version.id).collect();
    let selected: Vec<_> = ids
        .iter()
        .map(|id| {
            all.iter()
                .find(|v| &v.id == id)
                .cloned()
                .ok_or_else(|| "素材已变化，请刷新清理预览".into())
        })
        .collect::<AppResult<_>>()?;
    if selected
        .iter()
        .any(|v| protected(v, &refs) || held.contains(&v.id))
    {
        return Err("所选素材已有引用，请刷新清理预览".into());
    }
    let assets = folder(&state.directory, "assets")?;
    let trash = folder(&state.directory, "asset-trash")?;
    // Validate the complete selection before recording or moving the first file.
    let pending: Vec<_> = selected
        .into_iter()
        .map(|version| {
            let id = uid();
            let files = version_files(&assets, &version, &id)?;
            if files.is_empty() {
                return Err("素材文件缺失，请检查原文件".into());
            }
            Ok(Journal {
                id,
                version,
                files,
                status: "moving".into(),
                created_at: now(),
            })
        })
        .collect::<AppResult<_>>()?;
    for mut j in pending {
        save(&db, &j)?;
        for f in &j.files {
            let target = file(&trash, &f.stored_name)?;
            if target.exists() {
                return Err("回收区文件已存在".into());
            }
            fs::rename(file(&assets, &f.name)?, target).map_err(|e| e.to_string())?;
        }
        atomic(&db, || {
            db.execute(
                &format!("DELETE FROM {} WHERE id=?1", j.version.kind.table()),
                [&j.version.id],
            )
            .map_err(|e| e.to_string())?;
            j.status = "trashed".into();
            save(&db, &j)
        })?;
    }
    Ok(())
}
#[tauri::command]
pub async fn get_storage_report(app: tauri::AppHandle) -> AppResult<StorageReport> {
    tauri::async_runtime::spawn_blocking(move || report(&app.state::<WorkflowState>()))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn trash_assets(app: tauri::AppHandle, ids: Vec<String>) -> AppResult<()> {
    tauri::async_runtime::spawn_blocking(move || move_versions(&app.state::<WorkflowState>(), ids))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn restore_trash(app: tauri::AppHandle, id: String) -> AppResult<()> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<WorkflowState>();
        let db = state.store.db()?;
        let mut j = load(&db, &id)?;
        if j.status == "purging" {
            return Err("永久删除已经开始，请完成删除".into());
        }
        j.status = "restoring".into();
        save(&db, &j)?;
        finish_restore(&db, &state.directory, &j)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn purge_trash(app: tauri::AppHandle, id: String, confirmed: bool) -> AppResult<()> {
    if !confirmed {
        return Err("请先确认永久删除".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<WorkflowState>();
        let db = state.store.db()?;
        let mut j = load(&db, &id)?;
        if !matches!(j.status.as_str(), "trashed" | "purging") {
            return Err("请先恢复未完成的清理".into());
        }
        let (refs, busy) = roots(&db)?;
        if busy || protected(&j.version, &refs) {
            return Err("素材已有引用或任务正在运行".into());
        }
        j.status = "purging".into();
        save(&db, &j)?;
        finish_purge(&db, &state.directory, &j)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Reference creation and cleanup share the store mutex, closing the selection/cleanup race.
pub(super) fn require_version(db: &Connection, table: &str, id: &str) -> AppResult<()> {
    let exists: bool = db
        .query_row(
            &format!("SELECT EXISTS(SELECT 1 FROM {table} WHERE id=?1) AND NOT EXISTS(SELECT 1 FROM asset_trash WHERE json_extract(json,'$.version.id')=?1)"),
            [id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if !exists {
        return Err("素材已进入回收区或不存在，请刷新素材列表".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn state(directory: &Path) -> WorkflowState {
        fs::create_dir_all(directory).unwrap();
        WorkflowState {
            store: crate::workflow::storage::Store::open(&directory.join("studio.sqlite")).unwrap(),
            active: std::sync::Mutex::new(None),
            media_active: std::sync::Mutex::new(None),
            video_active: std::sync::Mutex::new(std::collections::HashMap::new()),
            export_active: std::sync::Mutex::new(None),
            speech_active: std::sync::Mutex::new(None),
            transcription_active: std::sync::Mutex::new(None),
            model_pull: std::sync::Mutex::new(None),
            comfy_download: std::sync::Mutex::new(None),
            directory: directory.into(),
        }
    }
    fn image(state: &WorkflowState, id: &str) -> Version {
        let assets = folder(&state.directory, "assets").unwrap();
        fs::write(assets.join(format!("{id}.png")), b"original image").unwrap();
        fs::write(assets.join(format!("{id}.thumb.png")), b"thumbnail").unwrap();
        let v = Version {
            id: id.into(),
            kind: Kind::Image,
            json: serde_json::json!({"versionId":id,"assetId":id,"name":id,"fileName":format!("{id}.png"),"createdAt":1}),
        };
        state
            .store
            .db()
            .unwrap()
            .execute(
                "INSERT INTO image_assets VALUES (?1,?2,1)",
                params![id, v.json.to_string()],
            )
            .unwrap();
        v
    }
    #[test]
    fn references_are_rechecked_and_quarantine_is_restorable() {
        let directory = std::env::temp_dir().join(format!("frame-cleanup-{}", uid()));
        let state = state(&directory);
        image(&state, "chosen");
        image(&state, "unused");
        image(&state, "source");
        {
            let db = state.store.db().unwrap();
            db.execute(
                "INSERT INTO first_frames VALUES ('w','n','a','s','chosen')",
                [],
            )
            .unwrap();
            db.execute("INSERT INTO cloud_image_jobs VALUES ('job','w',?1,1)",[r#"{"status":"succeeded","request":{"referenceVersionId":"source"},"assetIds":["unused"]}"#]).unwrap();
        }
        let stats = report(&state).unwrap();
        assert_eq!(stats.protected_count, 2);
        assert_eq!(stats.cleanable_count, 1);
        assert!(move_versions(&state, vec!["chosen".into()]).is_err());
        move_versions(&state, vec!["unused".into()]).unwrap();
        let stats = report(&state).unwrap();
        assert_eq!(stats.trash.len(), 1);
        assert!(!directory.join("assets/unused.png").exists());
        let mut j = journals(&state.store.db().unwrap()).unwrap().pop().unwrap();
        {
            let db = state.store.db().unwrap();
            assert!(require_version(&db, "image_assets", "unused").is_err());
            db.execute(
                "INSERT INTO media_settings VALUES ('future-ref',?1)",
                [r#"{"versionId":"unused"}"#],
            )
            .unwrap();
            assert!(finish_purge(&db, &directory, &j).is_err());
            db.execute("DELETE FROM media_settings WHERE id='future-ref'", [])
                .unwrap();
            j.status = "restoring".into();
            save(&db, &j).unwrap();
        }
        recover(&state).unwrap();
        assert_eq!(
            fs::read(directory.join("assets/unused.png")).unwrap(),
            b"original image"
        );
        assert_eq!(
            fs::read(directory.join("assets/unused.thumb.png")).unwrap(),
            b"thumbnail"
        );
        assert_eq!(report(&state).unwrap().trash.len(), 0);
        move_versions(&state, vec!["unused".into()]).unwrap();
        let db = state.store.db().unwrap();
        let j = journals(&db).unwrap().pop().unwrap();
        finish_purge(&db, &directory, &j).unwrap();
        assert!(journals(&db).unwrap().is_empty());
        assert!(fs::read_dir(directory.join("asset-trash"))
            .unwrap()
            .next()
            .is_none());
        drop(db);
        drop(state);
        fs::remove_dir_all(directory).unwrap();
    }
    #[test]
    fn interrupted_move_restores_files_after_database_reopen_and_rejects_unsafe_paths() {
        let directory = std::env::temp_dir().join(format!("frame-cleanup-crash-{}", uid()));
        let first = state(&directory);
        let version = image(&first, "pending");
        let assets = folder(&directory, "assets").unwrap();
        let trash = folder(&directory, "asset-trash").unwrap();
        let j = Journal {
            id: uid(),
            files: version_files(&assets, &version, "crash").unwrap(),
            version,
            status: "moving".into(),
            created_at: now(),
        };
        save(&first.store.db().unwrap(), &j).unwrap();
        fs::rename(
            assets.join(&j.files[0].name),
            trash.join(&j.files[0].stored_name),
        )
        .unwrap();
        drop(first);
        let reopened = state(&directory);
        recover(&reopened).unwrap();
        assert!(journals(&reopened.store.db().unwrap()).unwrap().is_empty());
        require_version(&reopened.store.db().unwrap(), "image_assets", "pending").unwrap();
        assert_eq!(
            fs::read(assets.join("pending.png")).unwrap(),
            b"original image"
        );
        assert!(file(&assets, "../outside.png").is_err());
        assert!(file(&assets, "..\\outside.png").is_err());
        assert!(file(&assets, "C:outside.png").is_err());
        drop(reopened);
        fs::remove_dir_all(directory).unwrap();
    }
    #[test]
    fn migration_preserves_v9_queue_intent() {
        let directory = std::env::temp_dir().join(format!("frame-cleanup-migrate-{}", uid()));
        let first = state(&directory);
        first.store.db().unwrap().execute_batch("INSERT INTO image_batches VALUES ('batch','w','{}',1); DROP TABLE asset_trash; PRAGMA user_version=9;").unwrap();
        drop(first);
        let reopened = state(&directory);
        let db = reopened.store.db().unwrap();
        assert_eq!(
            db.pragma_query_value(None, "user_version", |r| r.get::<_, u32>(0))
                .unwrap(),
            10
        );
        assert_eq!(
            db.query_row("SELECT count(*) FROM image_batches", [], |r| r
                .get::<_, u32>(0))
                .unwrap(),
            1
        );
        drop(db);
        drop(reopened);
        fs::remove_dir_all(directory).unwrap();
    }
}
