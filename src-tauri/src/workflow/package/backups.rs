//! Content-addressed external backups. Every point contains a complete manifest;
//! immutable objects are shared, so restoring does not depend on earlier points.
use super::*;
use std::sync::Mutex;

mod commands;
#[cfg(test)]
pub(super) mod tests;
pub use commands::*;

static OPERATION: Mutex<()> = Mutex::new(());
const MARKER: &[u8] = b"{\"format\":\"frame-studio-backups\",\"schemaVersion\":1}";

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Backup {
    id: String,
    created_at: u64,
    new_bytes: u64,
    manifest: Manifest,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupPoint {
    id: String,
    workflow_id: String,
    project_name: String,
    created_at: u64,
    file_count: usize,
    total_bytes: u64,
    new_bytes: u64,
    reused_bytes: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupReport {
    directory: Option<String>,
    points: Vec<BackupPoint>,
    warnings: Vec<String>,
}

impl Backup {
    fn summary(&self) -> BackupPoint {
        let total_bytes = self.manifest.files.iter().map(|f| f.bytes).sum();
        BackupPoint {
            id: self.id.clone(),
            workflow_id: self.manifest.snapshot.workflow.id.clone(),
            project_name: self.manifest.snapshot.workflow.name.clone(),
            created_at: self.created_at,
            file_count: self.manifest.files.len(),
            total_bytes,
            new_bytes: self.new_bytes,
            reused_bytes: total_bytes - self.new_bytes,
        }
    }
}

fn ordinary(path: &Path, directory: bool) -> AppResult<()> {
    let metadata = fs::symlink_metadata(path).map_err(|e| format!("备份文件缺失：{e}"))?;
    if metadata.file_type().is_symlink()
        || (directory && !metadata.is_dir())
        || (!directory && !metadata.is_file())
    {
        return Err("备份路径类型异常，请选择普通文件夹".into());
    }
    Ok(())
}

fn repository(root: &Path) -> AppResult<()> {
    ordinary(root, true)?;
    ordinary(&root.join("repository.json"), false)?;
    if fs::metadata(root.join("repository.json"))
        .map_err(|e| e.to_string())?
        .len()
        > 1024
        || fs::read(root.join("repository.json")).map_err(|e| e.to_string())? != MARKER
    {
        return Err("备份文件夹格式不受支持".into());
    }
    for name in ["objects", "snapshots"] {
        ordinary(&root.join(name), true)?;
        if root
            .join(name)
            .canonicalize()
            .map_err(|e| e.to_string())?
            .parent()
            != Some(root.canonicalize().map_err(|e| e.to_string())?.as_path())
        {
            return Err("备份子目录指向了其他位置".into());
        }
    }
    Ok(())
}

fn initialize(parent: &Path, app_directory: &Path) -> AppResult<PathBuf> {
    let parent = parent.canonicalize().map_err(|e| e.to_string())?;
    let app_directory = app_directory.canonicalize().map_err(|e| e.to_string())?;
    if parent.starts_with(&app_directory) {
        return Err("请把备份保存在应用数据目录之外".into());
    }
    let root = parent.join("FrameStudioBackups");
    if !root.exists() {
        fs::create_dir(&root).map_err(|e| e.to_string())?;
        let result = (|| {
            fs::create_dir(root.join("objects")).map_err(|e| e.to_string())?;
            fs::create_dir(root.join("snapshots")).map_err(|e| e.to_string())?;
            let mut marker = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(root.join("repository.json"))
                .map_err(|e| e.to_string())?;
            marker.write_all(MARKER).map_err(|e| e.to_string())?;
            marker.sync_all().map_err(|e| e.to_string())
        })();
        if result.is_err() {
            // Only remove the empty directories and marker created by this call.
            let _ = fs::remove_file(root.join("repository.json"));
            let _ = fs::remove_dir(root.join("objects"));
            let _ = fs::remove_dir(root.join("snapshots"));
            let _ = fs::remove_dir(&root);
        }
        result?;
    }
    repository(&root)?;
    let root = root.canonicalize().map_err(|e| e.to_string())?;
    if root.starts_with(&app_directory) {
        return Err("请把备份保存在应用数据目录之外".into());
    }
    Ok(root)
}

fn digest(path: &Path, mut output: Option<&mut File>) -> AppResult<(u64, String)> {
    ordinary(path, false)?;
    let mut input = File::open(path).map_err(|e| e.to_string())?;
    let length = input.metadata().map_err(|e| e.to_string())?.len();
    if length > MAX_FILE {
        return Err("备份素材超过 4 GB".into());
    }
    let mut hash = Sha256::new();
    let mut bytes = 0;
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let count = input.read(&mut buffer).map_err(|e| e.to_string())?;
        if count == 0 {
            break;
        }
        bytes += count as u64;
        if bytes > MAX_FILE {
            return Err("备份素材读取时超过大小限制".into());
        }
        hash.update(&buffer[..count]);
        if let Some(file) = output.as_mut() {
            file.write_all(&buffer[..count])
                .map_err(|e| e.to_string())?;
        }
    }
    if bytes != length {
        return Err("素材读取时发生变化，请重试".into());
    }
    Ok((bytes, format!("{:x}", hash.finalize())))
}

fn verified_copy(source: &Path, target: &Path, file: &BundledFile) -> AppResult<()> {
    let mut output = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(target)
        .map_err(|e| e.to_string())?;
    let (bytes, hash) = digest(source, Some(&mut output))?;
    if bytes != file.bytes || hash != file.sha256 {
        return Err(format!("备份素材校验失败：{}", file.name));
    }
    output.sync_all().map_err(|e| e.to_string())
}

fn create(
    store: &Store,
    directory: &Path,
    workflow_id: &str,
    root: &Path,
) -> AppResult<BackupPoint> {
    repository(root)?;
    let mut snapshot = snapshot(store, workflow_id)?;
    let inventory = inventory(&snapshot, directory)?;
    let export_paths: HashMap<_, _> = snapshot
        .exports
        .iter_mut()
        .map(|job| {
            job.output_path = format!("exports/{}.mp4", job.id);
            job.cover_path = job
                .cover_path
                .as_ref()
                .map(|_| format!("exports/{}.cover.jpg", job.id));
            (job.id.clone(), job.output_path.clone())
        })
        .collect();
    rewrite_canvas_paths(&mut snapshot.workflow, &export_paths);
    let mut files = Vec::new();
    let mut new_bytes = 0;
    for (name, source) in inventory {
        let (bytes, sha256) = digest(&source, None)?;
        let file = BundledFile {
            name,
            bytes,
            sha256,
        };
        let target = root.join("objects").join(&file.sha256);
        if target.exists() {
            let actual = digest(&target, None)?;
            if actual != (file.bytes, file.sha256.clone()) {
                return Err("已有备份素材损坏，请先检查备份磁盘".into());
            }
        } else {
            let temporary = root.join("objects").join(format!(".{}.partial", uid()));
            let result = (|| {
                verified_copy(&source, &temporary, &file)?;
                if target.exists() {
                    return Err("备份目录正在被其他程序写入，请重试".into());
                }
                fs::rename(&temporary, &target).map_err(|e| e.to_string())
            })();
            let _ = fs::remove_file(&temporary);
            result?;
            new_bytes += bytes;
        }
        files.push(file);
    }
    let backup = Backup {
        id: uid(),
        created_at: now(),
        new_bytes,
        manifest: Manifest {
            schema_version: 2,
            snapshot,
            files,
        },
    };
    validate_backup(&backup, &backup.id)?;
    let data = serde_json::to_vec(&backup).map_err(|e| e.to_string())?;
    if data.len() as u64 > MAX_MANIFEST {
        return Err("备份项目元数据过大".into());
    }
    let temporary = root
        .join("snapshots")
        .join(format!(".{}.partial", backup.id));
    let result = (|| {
        let mut output = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|e| e.to_string())?;
        output.write_all(&data).map_err(|e| e.to_string())?;
        output.sync_all().map_err(|e| e.to_string())?;
        fs::rename(
            &temporary,
            root.join("snapshots").join(format!("{}.json", backup.id)),
        )
        .map_err(|e| e.to_string())
    })();
    let _ = fs::remove_file(&temporary);
    result.map(|_| backup.summary())
}

fn read(root: &Path, id: &str) -> AppResult<Backup> {
    if !safe_id(id) {
        return Err("备份标识无效".into());
    }
    let path = root.join("snapshots").join(format!("{id}.json"));
    ordinary(&path, false)?;
    if fs::metadata(&path).map_err(|e| e.to_string())?.len() > MAX_MANIFEST {
        return Err("备份记录过大".into());
    }
    let data = File::open(&path).map_err(|e| e.to_string())?;
    let backup: Backup =
        serde_json::from_reader(data.take(MAX_MANIFEST + 1)).map_err(|_| "备份记录格式错误")?;
    validate_backup(&backup, id)?;
    Ok(backup)
}

fn validate_backup(backup: &Backup, id: &str) -> AppResult<()> {
    if backup.id != id || backup.manifest.schema_version != 2 {
        return Err("备份记录版本或标识错误".into());
    }
    validate_snapshot(&backup.manifest.snapshot)?;
    let expected = expected_files(&backup.manifest.snapshot);
    let listed: HashSet<_> = backup
        .manifest
        .files
        .iter()
        .map(|f| f.name.clone())
        .collect();
    if expected != listed
        || expected.len() != backup.manifest.files.len()
        || expected.len() > MAX_FILES
        || backup.manifest.files.iter().any(|f| {
            f.bytes > MAX_FILE
                || f.sha256.len() != 64
                || !f
                    .sha256
                    .bytes()
                    .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
        })
        || backup.new_bytes > backup.manifest.files.iter().map(|f| f.bytes).sum::<u64>()
    {
        return Err("备份文件清单或校验值无效".into());
    }
    let lengths: HashMap<_, _> = backup
        .manifest
        .files
        .iter()
        .map(|f| (f.name.as_str(), f.bytes))
        .collect();
    let snapshot = &backup.manifest.snapshot;
    for (name, bytes) in snapshot
        .images
        .iter()
        .map(|a| (&a.file_name, a.bytes as u64))
        .chain(snapshot.videos.iter().map(|a| (&a.file_name, a.bytes)))
        .chain(
            snapshot
                .audios
                .iter()
                .map(|a| (&a.file_name, a.bytes as u64)),
        )
    {
        if lengths.get(format!("assets/{name}").as_str()) != Some(&bytes) {
            return Err("备份素材大小与版本记录不符".into());
        }
    }
    Ok(())
}

fn list(root: &Path) -> AppResult<BackupReport> {
    repository(root)?;
    let mut points = Vec::new();
    let mut warnings = Vec::new();
    for entry in fs::read_dir(root.join("snapshots")).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if path.extension().and_then(|v| v.to_str()) != Some("json") {
            continue;
        }
        let id = path
            .file_stem()
            .and_then(|v| v.to_str())
            .ok_or("备份记录名称无效")?;
        match read(root, id) {
            Ok(backup) => points.push(backup.summary()),
            Err(error) => warnings.push(format!("记录 {id}：{error}")),
        }
    }
    points.sort_by_key(|p| std::cmp::Reverse(p.created_at));
    Ok(BackupReport {
        directory: Some(root.to_string_lossy().into_owned()),
        points,
        warnings,
    })
}

fn restore(store: &Store, directory: &Path, root: &Path, id: &str) -> AppResult<Workflow> {
    repository(root)?;
    let mut backup = read(root, id)?;
    let staging = directory.join(format!(".restore-{}", uid()));
    fs::create_dir(&staging).map_err(|e| e.to_string())?;
    let result = (|| {
        remap::copy_ids(&mut backup.manifest)?;
        for file in &backup.manifest.files {
            let target = staging.join(&file.name);
            fs::create_dir_all(target.parent().ok_or("恢复路径无效")?)
                .map_err(|e| e.to_string())?;
            verified_copy(&root.join("objects").join(&file.sha256), &target, file)?;
        }
        for name in ["assets", "exports"] {
            let path = directory.join(name);
            if !path.exists() {
                fs::create_dir(&path).map_err(|e| e.to_string())?;
            }
            ordinary(&path, true)?;
            if path.canonicalize().map_err(|e| e.to_string())?.parent()
                != Some(
                    directory
                        .canonicalize()
                        .map_err(|e| e.to_string())?
                        .as_path(),
                )
            {
                return Err("恢复素材目录指向了其他位置".into());
            }
        }
        apply_staged(store, directory, &staging, &mut backup.manifest)
    })();
    let _ = fs::remove_dir_all(&staging);
    result.map(|_| backup.manifest.snapshot.workflow)
}

mod remap;
