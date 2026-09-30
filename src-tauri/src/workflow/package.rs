//! Portable, integrity-checked project bundles. Provider credentials and remote
//! task state stay on the original device; immutable media versions travel.
use super::{
    media::{
        composition::{AudioAsset, Composition, ExportJob},
        subtitles::{self, SubtitleAsset},
        video::VideoAsset,
        ImageAsset, ShotContext,
    },
    storage::Store,
    types::*,
    WorkflowState,
};
use rusqlite::{params, OptionalExtension};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
};
use tauri::Manager;
use zip::{write::SimpleFileOptions, CompressionMethod, ZipArchive, ZipWriter};

const MAX_MANIFEST: u64 = 16 * 1024 * 1024;
const MAX_FILES: usize = 10_000;
const MAX_FILE: u64 = 4 * 1024 * 1024 * 1024;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Binding {
    context: ShotContext,
    version_id: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RoleBinding {
    role_name: String,
    version_id: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Snapshot {
    workflow: Workflow,
    images: Vec<ImageAsset>,
    videos: Vec<VideoAsset>,
    audios: Vec<AudioAsset>,
    #[serde(default)]
    subtitles: Vec<SubtitleAsset>,
    first_frames: Vec<Binding>,
    role_references: Vec<RoleBinding>,
    selected_videos: Vec<Binding>,
    composition: Option<Composition>,
    exports: Vec<ExportJob>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BundledFile {
    name: String,
    bytes: u64,
    sha256: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Manifest {
    schema_version: u32,
    snapshot: Snapshot,
    files: Vec<BundledFile>,
}

fn db_rows<T: DeserializeOwned>(store: &Store, sql: &str, workflow_id: &str) -> AppResult<Vec<T>> {
    let db = store.db()?;
    let mut query = db.prepare(sql).map_err(|e| e.to_string())?;
    let rows = query
        .query_map([workflow_id], |row| row.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    rows.map(|row| {
        serde_json::from_str(&row.map_err(|e| e.to_string())?).map_err(|e| e.to_string())
    })
    .collect()
}

fn all_rows<T: DeserializeOwned>(store: &Store, sql: &str) -> AppResult<Vec<T>> {
    let db = store.db()?;
    let mut query = db.prepare(sql).map_err(|e| e.to_string())?;
    let rows = query
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    rows.map(|row| {
        serde_json::from_str(&row.map_err(|e| e.to_string())?).map_err(|e| e.to_string())
    })
    .collect()
}

fn bindings(store: &Store, table: &str, workflow_id: &str) -> AppResult<Vec<Binding>> {
    let sql =
        format!("SELECT node_id,artifact_id,shot_id,version_id FROM {table} WHERE workflow_id=?1");
    let db = store.db()?;
    let mut query = db.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = query
        .query_map([workflow_id], |row| {
            Ok(Binding {
                context: ShotContext {
                    workflow_id: workflow_id.into(),
                    node_id: row.get(0)?,
                    artifact_id: row.get(1)?,
                    shot_id: row.get(2)?,
                },
                version_id: row.get(3)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.map(|row| row.map_err(|e| e.to_string())).collect()
}

fn snapshot(store: &Store, workflow_id: &str) -> AppResult<Snapshot> {
    let json: String = store
        .db()?
        .query_row(
            "SELECT json FROM workflows WHERE id=?1",
            [workflow_id],
            |row| row.get(0),
        )
        .map_err(|_| "项目不存在，请先保存工作流")?;
    let workflow: Workflow = serde_json::from_str(&json).map_err(|e| e.to_string())?;
    let first_frames = bindings(store, "first_frames", workflow_id)?;
    let selected_videos = bindings(store, "selected_videos", workflow_id)?;
    let role_references: Vec<RoleBinding> = {
        let db = store.db()?;
        let mut query = db
            .prepare("SELECT role_name,version_id FROM role_references WHERE workflow_id=?1")
            .map_err(|e| e.to_string())?;
        let rows = query
            .query_map([workflow_id], |row| {
                Ok(RoleBinding {
                    role_name: row.get(0)?,
                    version_id: row.get(1)?,
                })
            })
            .map_err(|e| e.to_string())?;
        rows.map(|row| row.map_err(|e| e.to_string()))
            .collect::<AppResult<_>>()?
    };
    let composition: Option<Composition> = store
        .db()?
        .query_row(
            "SELECT json FROM compositions WHERE workflow_id=?1",
            [workflow_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .map(|json| serde_json::from_str(&json).map_err(|e| e.to_string()))
        .transpose()?;
    let all_images: Vec<ImageAsset> = all_rows(store, "SELECT json FROM image_assets")?;
    let all_videos: Vec<VideoAsset> = all_rows(store, "SELECT json FROM video_assets")?;
    let audios: Vec<AudioAsset> = db_rows(
        store,
        "SELECT json FROM audio_assets WHERE workflow_id=?1",
        workflow_id,
    )?;
    let mut image_ids: HashSet<String> = first_frames
        .iter()
        .map(|binding| binding.version_id.clone())
        .chain(
            role_references
                .iter()
                .map(|binding| binding.version_id.clone()),
        )
        .collect();
    let mut video_ids: HashSet<String> = selected_videos
        .iter()
        .map(|binding| binding.version_id.clone())
        .collect();
    if let Some(draft) = &composition {
        video_ids.extend(draft.clips.iter().map(|clip| clip.version_id.clone()));
    }
    for video in &all_videos {
        if video.context.workflow_id == workflow_id || video_ids.contains(&video.version_id) {
            image_ids.insert(video.first_frame_version_id.clone());
        }
    }
    let videos: Vec<_> = all_videos
        .into_iter()
        .filter(|asset| {
            asset.context.workflow_id == workflow_id || video_ids.contains(&asset.version_id)
        })
        .collect();
    let images: Vec<_> = all_images
        .into_iter()
        .filter(|asset| {
            asset
                .context
                .as_ref()
                .is_some_and(|context| context.workflow_id == workflow_id)
                || image_ids.contains(&asset.version_id)
        })
        .map(|mut asset| {
            if asset
                .context
                .as_ref()
                .is_some_and(|context| context.workflow_id != workflow_id)
            {
                asset.context = None;
            }
            asset
        })
        .collect();
    let exports: Vec<ExportJob> = db_rows::<ExportJob>(
        store,
        "SELECT json FROM export_jobs WHERE workflow_id=?1",
        workflow_id,
    )?
    .into_iter()
    .filter(|job| job.status == "succeeded" && Path::new(&job.output_path).is_file())
    .map(|mut job| {
        if job
            .cover_path
            .as_ref()
            .is_some_and(|path| !Path::new(path).is_file())
        {
            job.cover_path = None;
        }
        job
    })
    .collect();
    let mut result = Snapshot {
        workflow,
        images,
        videos,
        audios,
        subtitles: db_rows(
            store,
            "SELECT json FROM subtitle_assets WHERE workflow_id=?1",
            workflow_id,
        )?,
        first_frames,
        role_references,
        selected_videos,
        composition,
        exports,
    };
    // A stale external render must not survive as a live canvas output.
    let exported: HashSet<_> = result.exports.iter().map(|job| job.id.as_str()).collect();
    for node in &mut result.workflow.nodes {
        node.config.provider_id.clear();
        if node.kind == NodeKind::Timeline
            && node
                .output
                .as_ref()
                .and_then(|output| output.value["exportId"].as_str())
                .is_some_and(|id| !exported.contains(id))
        {
            node.output = None;
            node.stale = true;
        }
    }
    validate_snapshot(&result)?;
    Ok(result)
}

fn safe_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '-')
}

fn logical_id(value: &str) -> bool {
    !value.is_empty() && value.len() <= 512 && !value.chars().any(char::is_control)
}

fn safe_file(value: &str, id: &str, extensions: &[&str]) -> bool {
    safe_id(id)
        && extensions
            .iter()
            .any(|extension| value == format!("{id}.{extension}"))
}

fn validate_snapshot(snapshot: &Snapshot) -> AppResult<()> {
    validate_graph(&snapshot.workflow, false)?;
    let workflow_id = &snapshot.workflow.id;
    if !safe_id(workflow_id) {
        return Err("项目 ID 无效".into());
    }
    let image_ids: HashSet<_> = snapshot
        .images
        .iter()
        .map(|item| item.version_id.as_str())
        .collect();
    let video_ids: HashSet<_> = snapshot
        .videos
        .iter()
        .map(|item| item.version_id.as_str())
        .collect();
    let audio_ids: HashSet<_> = snapshot
        .audios
        .iter()
        .map(|item| item.version_id.as_str())
        .collect();
    if image_ids.len() != snapshot.images.len()
        || video_ids.len() != snapshot.videos.len()
        || audio_ids.len() != snapshot.audios.len()
        || !image_ids.is_disjoint(&video_ids)
        || !image_ids.is_disjoint(&audio_ids)
        || !video_ids.is_disjoint(&audio_ids)
    {
        return Err("项目包存在重复的素材版本 ID".into());
    }
    for image in &snapshot.images {
        if !safe_file(&image.file_name, &image.version_id, &["png", "jpg", "webp"])
            || !logical_id(&image.asset_id)
            || image.bytes as u64 > 20 * 1024 * 1024
            || image
                .context
                .as_ref()
                .is_some_and(|context| context.workflow_id != *workflow_id)
        {
            return Err("项目包的图片素材信息无效".into());
        }
    }
    for video in &snapshot.videos {
        if !safe_file(&video.file_name, &video.version_id, &["mp4"])
            || !logical_id(&video.asset_id)
            || video.context.workflow_id != *workflow_id
            || !image_ids.contains(video.first_frame_version_id.as_str())
        {
            return Err("项目包的视频素材信息无效".into());
        }
    }
    for audio in &snapshot.audios {
        if !safe_file(
            &audio.file_name,
            &audio.version_id,
            &["mp3", "wav", "m4a", "aac", "flac", "ogg"],
        ) || audio.workflow_id != *workflow_id
            || audio.bytes as u64 > 20 * 1024 * 1024
        {
            return Err("项目包的音频素材信息无效".into());
        }
    }
    let subtitle_ids: HashSet<_> = snapshot
        .subtitles
        .iter()
        .map(|item| item.version_id.as_str())
        .collect();
    if subtitle_ids.len() != snapshot.subtitles.len()
        || !subtitle_ids.is_disjoint(&audio_ids)
        || !subtitle_ids.is_disjoint(&image_ids)
        || !subtitle_ids.is_disjoint(&video_ids)
    {
        return Err("项目包字幕版本 ID 重复".into());
    }
    for subtitle in &snapshot.subtitles {
        let source = snapshot
            .audios
            .iter()
            .find(|a| a.version_id == subtitle.source_audio_version_id)
            .ok_or("项目包字幕的配音来源缺失")?;
        if !safe_id(&subtitle.version_id)
            || subtitle.workflow_id != *workflow_id
            || subtitle
                .parent_version_id
                .as_ref()
                .is_some_and(|id| !subtitle_ids.contains(id.as_str()))
        {
            return Err("项目包字幕版本引用无效".into());
        }
        subtitles::validate_cues(&subtitle.cues, source.duration_ms)?;
    }
    for binding in &snapshot.first_frames {
        if binding.context.workflow_id != *workflow_id
            || !image_ids.contains(binding.version_id.as_str())
        {
            return Err("项目包的镜头首帧引用无效".into());
        }
    }
    for binding in &snapshot.role_references {
        if !image_ids.contains(binding.version_id.as_str()) {
            return Err("项目包的角色参考图引用无效".into());
        }
    }
    for binding in &snapshot.selected_videos {
        if binding.context.workflow_id != *workflow_id
            || !video_ids.contains(binding.version_id.as_str())
        {
            return Err("项目包的视频选择引用无效".into());
        }
    }
    if let Some(draft) = &snapshot.composition {
        if draft
            .subtitle_version_id
            .as_ref()
            .is_some_and(|id| !subtitle_ids.contains(id.as_str()))
            || draft.workflow_id != *workflow_id
            || draft
                .clips
                .iter()
                .any(|clip| !video_ids.contains(clip.version_id.as_str()))
            || draft
                .music_version_id
                .as_ref()
                .is_some_and(|id| !audio_ids.contains(id.as_str()))
            || draft
                .voice_version_id
                .as_ref()
                .is_some_and(|id| !audio_ids.contains(id.as_str()))
        {
            return Err("项目包的时间线引用无效".into());
        }
    }
    let export_ids: HashSet<_> = snapshot.exports.iter().map(|job| job.id.as_str()).collect();
    if export_ids.len() != snapshot.exports.len() {
        return Err("项目包存在重复的导出 ID".into());
    }
    for job in &snapshot.exports {
        if !safe_id(&job.id)
            || job.workflow_id != *workflow_id
            || job.status != "succeeded"
            || job.draft.workflow_id != *workflow_id
        {
            return Err("项目包的成片记录无效".into());
        }
    }
    Ok(())
}

fn inventory(snapshot: &Snapshot, directory: &Path) -> AppResult<Vec<(String, PathBuf)>> {
    let mut files = Vec::new();
    let assets = directory.join("assets");
    for image in &snapshot.images {
        verify_media_length(&assets.join(&image.file_name), image.bytes as u64)?;
        files.push((
            format!("assets/{}", image.file_name),
            assets.join(&image.file_name),
        ));
        let thumb = format!("{}.thumb.png", image.version_id);
        files.push((format!("assets/{thumb}"), assets.join(thumb)));
    }
    for video in &snapshot.videos {
        verify_media_length(&assets.join(&video.file_name), video.bytes)?;
        files.push((
            format!("assets/{}", video.file_name),
            assets.join(&video.file_name),
        ));
    }
    for audio in &snapshot.audios {
        verify_media_length(&assets.join(&audio.file_name), audio.bytes as u64)?;
        files.push((
            format!("assets/{}", audio.file_name),
            assets.join(&audio.file_name),
        ));
    }
    for job in &snapshot.exports {
        files.push((
            format!("exports/{}.mp4", job.id),
            PathBuf::from(&job.output_path),
        ));
        if let Some(cover) = &job.cover_path {
            if Path::new(cover).is_file() {
                files.push((
                    format!("exports/{}.cover.jpg", job.id),
                    PathBuf::from(cover),
                ));
            }
        }
    }
    if files.len() > MAX_FILES || files.iter().any(|(_, path)| !path.is_file()) {
        return Err("项目素材文件缺失或数量过多".into());
    }
    let names: HashSet<_> = files.iter().map(|(name, _)| name.as_str()).collect();
    if names.len() != files.len() {
        return Err("项目素材文件名冲突".into());
    }
    Ok(files)
}

fn verify_media_length(path: &Path, expected: u64) -> AppResult<()> {
    let actual = fs::metadata(path)
        .map_err(|_| format!("素材文件缺失：{}", path.display()))?
        .len();
    if actual != expected {
        return Err(format!("素材文件大小与记录不符：{}", path.display()));
    }
    Ok(())
}

fn write_archive(
    store: &Store,
    directory: &Path,
    workflow_id: &str,
    target: &Path,
) -> AppResult<()> {
    if target.exists() {
        return Err("目标项目包已存在，请选择其他名称".into());
    }
    let mut snapshot = snapshot(store, workflow_id)?;
    let files = inventory(&snapshot, directory)?;
    // Keep the archive portable and avoid disclosing the source machine's paths.
    let archive_paths: HashMap<_, _> = snapshot
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
    rewrite_canvas_paths(&mut snapshot.workflow, &archive_paths);
    let temporary = target.with_file_name(format!(".frame-studio-{}.partial", uid()));
    let result = (|| {
        let output = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|e| format!("无法创建项目包：{e}"))?;
        let mut zip = ZipWriter::new(output);
        let options = SimpleFileOptions::default()
            .compression_method(CompressionMethod::Stored)
            .large_file(true);
        let mut entries = Vec::with_capacity(files.len());
        for (name, path) in files {
            let mut input =
                File::open(&path).map_err(|e| format!("无法读取素材 {}：{e}", path.display()))?;
            let len = input.metadata().map_err(|e| e.to_string())?.len();
            if len > MAX_FILE {
                return Err(format!("素材文件超过 4 GB：{}", path.display()));
            }
            zip.start_file(&name, options).map_err(|e| e.to_string())?;
            let mut hash = Sha256::new();
            let mut bytes = 0_u64;
            let mut buffer = [0_u8; 64 * 1024];
            loop {
                let count = input.read(&mut buffer).map_err(|e| e.to_string())?;
                if count == 0 {
                    break;
                }
                zip.write_all(&buffer[..count]).map_err(|e| e.to_string())?;
                hash.update(&buffer[..count]);
                bytes += count as u64;
                if bytes > MAX_FILE {
                    return Err("素材文件在打包过程中超出大小限制".into());
                }
            }
            if bytes != len {
                return Err("素材文件在打包过程中发生变化，请重试".into());
            }
            entries.push(BundledFile {
                name,
                bytes,
                sha256: format!("{:x}", hash.finalize()),
            });
        }
        let manifest = serde_json::to_vec(&Manifest {
            schema_version: 2,
            snapshot,
            files: entries,
        })
        .map_err(|e| e.to_string())?;
        if manifest.len() as u64 > MAX_MANIFEST {
            return Err("项目元数据过大".into());
        }
        zip.start_file("manifest.json", options)
            .map_err(|e| e.to_string())?;
        zip.write_all(&manifest).map_err(|e| e.to_string())?;
        let output = zip.finish().map_err(|e| e.to_string())?;
        output.sync_all().map_err(|e| e.to_string())?;
        if target.exists() {
            return Err("目标项目包已存在，请选择其他名称".into());
        }
        fs::rename(&temporary, target).map_err(|e| format!("无法保存项目包：{e}"))
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn read_manifest(zip: &mut ZipArchive<File>) -> AppResult<Manifest> {
    if zip.len() > MAX_FILES + 1 {
        return Err("项目包文件过多".into());
    }
    let entry = zip
        .by_name("manifest.json")
        .map_err(|_| "项目包缺少 manifest.json")?;
    if entry.size() > MAX_MANIFEST {
        return Err("项目元数据过大".into());
    }
    let mut data = Vec::new();
    entry
        .take(MAX_MANIFEST + 1)
        .read_to_end(&mut data)
        .map_err(|e| e.to_string())?;
    if data.len() as u64 > MAX_MANIFEST {
        return Err("项目元数据过大".into());
    }
    let manifest: Manifest = serde_json::from_slice(&data).map_err(|_| "项目包元数据格式无效")?;
    if ![1, 2].contains(&manifest.schema_version) {
        return Err("项目包版本不受支持，请升级应用".into());
    }
    Ok(manifest)
}

fn expected_files(snapshot: &Snapshot) -> HashSet<String> {
    let mut names = HashSet::new();
    for image in &snapshot.images {
        names.insert(format!("assets/{}", image.file_name));
        names.insert(format!("assets/{}.thumb.png", image.version_id));
    }
    for video in &snapshot.videos {
        names.insert(format!("assets/{}", video.file_name));
    }
    for audio in &snapshot.audios {
        names.insert(format!("assets/{}", audio.file_name));
    }
    for job in &snapshot.exports {
        names.insert(format!("exports/{}.mp4", job.id));
        if job.cover_path.is_some() {
            names.insert(format!("exports/{}.cover.jpg", job.id));
        }
    }
    names
}

fn rewrite_canvas_paths(workflow: &mut Workflow, paths: &HashMap<String, String>) {
    for node in &mut workflow.nodes {
        if node.kind == NodeKind::Timeline {
            if let Some(output) = &mut node.output {
                if let Some(id) = output.value["exportId"].as_str() {
                    if let Some(path) = paths.get(id) {
                        output.value["outputPath"] = serde_json::Value::String(path.clone());
                    }
                }
            }
        }
    }
}

fn restore_archive(store: &Store, directory: &Path, source: &Path) -> AppResult<Workflow> {
    let input = File::open(source).map_err(|e| format!("无法打开项目包：{e}"))?;
    let mut zip = ZipArchive::new(input).map_err(|_| "项目包不是有效的 ZIP 文件")?;
    let mut manifest = read_manifest(&mut zip)?;
    validate_snapshot(&manifest.snapshot)?;
    let expected = expected_files(&manifest.snapshot);
    let listed: HashSet<_> = manifest
        .files
        .iter()
        .map(|file| file.name.clone())
        .collect();
    if manifest.files.len() != expected.len()
        || listed != expected
        || zip.len() != expected.len() + 1
    {
        return Err("项目包文件清单不完整或存在重复文件".into());
    }
    let mut archive_names = HashSet::new();
    for index in 0..zip.len() {
        let entry = zip.by_index(index).map_err(|e| e.to_string())?;
        if !archive_names.insert(entry.name().to_owned())
            || (entry.name() != "manifest.json" && !expected.contains(entry.name()))
        {
            return Err("项目包包含重复或未知文件".into());
        }
    }
    let workflow_id = manifest.snapshot.workflow.id.clone();
    let exists: bool = store
        .db()?
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM workflows WHERE id=?1)",
            [&workflow_id],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    if exists {
        return Err("此项目已存在；请在另一台设备或全新数据目录恢复".into());
    }
    let staging = directory.join(format!(".restore-{}", uid()));
    fs::create_dir(&staging).map_err(|e| format!("无法创建恢复目录：{e}"))?;
    let result = (|| {
        for file in &manifest.files {
            if file.bytes > MAX_FILE
                || file.sha256.len() != 64
                || !file.sha256.bytes().all(|c| c.is_ascii_hexdigit())
            {
                return Err("项目包文件大小或校验值无效".into());
            }
            let mut entry = zip.by_name(&file.name).map_err(|_| "项目包缺少素材文件")?;
            if entry.compression() != CompressionMethod::Stored || entry.size() != file.bytes {
                return Err("项目包素材文件压缩方式或大小无效".into());
            }
            let destination = staging.join(&file.name);
            fs::create_dir_all(destination.parent().ok_or("项目包路径无效")?)
                .map_err(|e| e.to_string())?;
            let mut output = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&destination)
                .map_err(|e| e.to_string())?;
            let mut hash = Sha256::new();
            let mut bytes = 0_u64;
            let mut buffer = [0_u8; 64 * 1024];
            loop {
                let count = entry.read(&mut buffer).map_err(|e| e.to_string())?;
                if count == 0 {
                    break;
                }
                output
                    .write_all(&buffer[..count])
                    .map_err(|e| e.to_string())?;
                hash.update(&buffer[..count]);
                bytes += count as u64;
                if bytes > file.bytes {
                    return Err("项目包素材文件大小不符".into());
                }
            }
            if bytes != file.bytes || format!("{:x}", hash.finalize()) != file.sha256.to_lowercase()
            {
                return Err(format!("项目包素材文件校验失败：{}", file.name));
            }
        }
        // Export paths from the source machine are replaced with app-owned paths.
        let export_paths: HashMap<_, _> = manifest
            .snapshot
            .exports
            .iter_mut()
            .map(|job| {
                job.output_path = directory
                    .join("exports")
                    .join(format!("{}.mp4", job.id))
                    .to_string_lossy()
                    .into_owned();
                job.cover_path = job.cover_path.as_ref().map(|_| {
                    directory
                        .join("exports")
                        .join(format!("{}.cover.jpg", job.id))
                        .to_string_lossy()
                        .into_owned()
                });
                (job.id.clone(), job.output_path.clone())
            })
            .collect();
        rewrite_canvas_paths(&mut manifest.snapshot.workflow, &export_paths);
        let mut db = store.db()?;
        let transaction = db.transaction().map_err(|e| e.to_string())?;
        let already_exists: bool = transaction
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM workflows WHERE id=?1)",
                [&workflow_id],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;
        if already_exists {
            return Err("此项目已存在".into());
        }
        for image in &manifest.snapshot.images {
            ensure_free(&transaction, "image_assets", &image.version_id)?;
        }
        for video in &manifest.snapshot.videos {
            ensure_free(&transaction, "video_assets", &video.version_id)?;
        }
        for audio in &manifest.snapshot.audios {
            ensure_free(&transaction, "audio_assets", &audio.version_id)?;
        }
        for job in &manifest.snapshot.exports {
            ensure_free(&transaction, "export_jobs", &job.id)?;
        }
        let mut moved = Vec::new();
        let applied = (|| {
            for file in &manifest.files {
                let destination = directory.join(&file.name);
                fs::create_dir_all(destination.parent().ok_or("项目包路径无效")?)
                    .map_err(|e| e.to_string())?;
                if destination.exists() {
                    return Err("目标素材文件已存在，恢复已取消".into());
                }
                fs::rename(staging.join(&file.name), &destination)
                    .map_err(|e| format!("无法恢复素材：{e}"))?;
                moved.push(destination);
            }
            insert_snapshot(&transaction, &manifest.snapshot)?;
            transaction.commit().map_err(|e| e.to_string())
        })();
        if applied.is_err() {
            for path in moved {
                let _ = fs::remove_file(path);
            }
        }
        applied
    })();
    let _ = fs::remove_dir_all(&staging);
    result.map(|_| manifest.snapshot.workflow)
}

fn ensure_free(db: &rusqlite::Transaction<'_>, table: &str, id: &str) -> AppResult<()> {
    let query = format!("SELECT EXISTS(SELECT 1 FROM {table} WHERE id=?1)");
    let exists: bool = db
        .query_row(&query, [id], |row| row.get(0))
        .map_err(|e| e.to_string())?;
    if exists {
        Err("素材版本 ID 已存在，恢复已取消".into())
    } else {
        Ok(())
    }
}

fn insert_snapshot(db: &rusqlite::Transaction<'_>, snapshot: &Snapshot) -> AppResult<()> {
    let w = &snapshot.workflow;
    db.execute(
        "INSERT INTO workflows VALUES (?1,?2,?3)",
        params![
            w.id,
            serde_json::to_string(w).map_err(|e| e.to_string())?,
            w.updated_at
        ],
    )
    .map_err(|e| e.to_string())?;
    for image in &snapshot.images {
        db.execute(
            "INSERT INTO image_assets VALUES (?1,?2,?3)",
            params![
                image.version_id,
                serde_json::to_string(image).map_err(|e| e.to_string())?,
                image.created_at
            ],
        )
        .map_err(|e| e.to_string())?;
    }
    for video in &snapshot.videos {
        db.execute(
            "INSERT INTO video_assets VALUES (?1,?2,?3)",
            params![
                video.version_id,
                serde_json::to_string(video).map_err(|e| e.to_string())?,
                video.created_at
            ],
        )
        .map_err(|e| e.to_string())?;
    }
    for audio in &snapshot.audios {
        db.execute(
            "INSERT INTO audio_assets VALUES (?1,?2,?3,?4)",
            params![
                audio.version_id,
                audio.workflow_id,
                serde_json::to_string(audio).map_err(|e| e.to_string())?,
                audio.created_at
            ],
        )
        .map_err(|e| e.to_string())?;
    }
    for subtitle in &snapshot.subtitles {
        db.execute(
            "INSERT INTO subtitle_assets VALUES (?1,?2,?3,?4)",
            params![
                subtitle.version_id,
                subtitle.workflow_id,
                serde_json::to_string(subtitle).map_err(|e| e.to_string())?,
                subtitle.created_at
            ],
        )
        .map_err(|e| e.to_string())?;
    }
    for binding in &snapshot.first_frames {
        let c = &binding.context;
        db.execute(
            "INSERT INTO first_frames VALUES (?1,?2,?3,?4,?5)",
            params![
                c.workflow_id,
                c.node_id,
                c.artifact_id,
                c.shot_id,
                binding.version_id
            ],
        )
        .map_err(|e| e.to_string())?;
    }
    for binding in &snapshot.role_references {
        db.execute(
            "INSERT INTO role_references VALUES (?1,?2,?3)",
            params![w.id, binding.role_name, binding.version_id],
        )
        .map_err(|e| e.to_string())?;
    }
    for binding in &snapshot.selected_videos {
        let c = &binding.context;
        db.execute(
            "INSERT INTO selected_videos VALUES (?1,?2,?3,?4,?5)",
            params![
                c.workflow_id,
                c.node_id,
                c.artifact_id,
                c.shot_id,
                binding.version_id
            ],
        )
        .map_err(|e| e.to_string())?;
    }
    if let Some(draft) = &snapshot.composition {
        db.execute(
            "INSERT INTO compositions VALUES (?1,?2,?3)",
            params![
                w.id,
                serde_json::to_string(draft).map_err(|e| e.to_string())?,
                w.updated_at
            ],
        )
        .map_err(|e| e.to_string())?;
    }
    for job in &snapshot.exports {
        db.execute(
            "INSERT INTO export_jobs VALUES (?1,?2,?3,?4)",
            params![
                job.id,
                w.id,
                serde_json::to_string(job).map_err(|e| e.to_string())?,
                job.created_at
            ],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn no_active_tasks(state: &WorkflowState) -> AppResult<()> {
    if state
        .transcription_active
        .lock()
        .map_err(|_| "字幕任务锁不可用")?
        .is_some()
        || state.active.lock().map_err(|_| "任务锁不可用")?.is_some()
        || state
            .speech_active
            .lock()
            .map_err(|_| "配音任务锁不可用")?
            .is_some()
        || state
            .media_active
            .lock()
            .map_err(|_| "图片任务锁不可用")?
            .is_some()
        || !state
            .video_active
            .lock()
            .map_err(|_| "视频任务锁不可用")?
            .is_empty()
        || state
            .export_active
            .lock()
            .map_err(|_| "导出任务锁不可用")?
            .is_some()
    {
        return Err("有媒体任务正在执行，请等待任务完成后再使用项目包".into());
    }
    Ok(())
}

#[tauri::command]
pub async fn export_project_bundle(
    app: tauri::AppHandle,
    workflow_id: String,
) -> AppResult<Option<String>> {
    {
        let state = app.state::<WorkflowState>();
        no_active_tasks(&state)?;
    }
    let path = if cfg!(debug_assertions) && std::env::var_os("FRAME_STUDIO_TEST_DATA_DIR").is_some()
    {
        std::env::var_os("FRAME_STUDIO_TEST_PROJECT_BUNDLE_PATH").map(PathBuf::from)
    } else {
        let window = app.get_webview_window("main").ok_or("窗口不可用")?;
        tauri::async_runtime::spawn_blocking(move || {
            rfd::FileDialog::new()
                .set_parent(&window)
                .add_filter("Frame Studio 项目包", &["framepack"])
                .set_file_name("frame-studio.framepack")
                .save_file()
        })
        .await
        .map_err(|_| "保存对话框中断")?
    };
    let Some(path) = path else {
        return Ok(None);
    };
    if path.extension().and_then(|ext| ext.to_str()) != Some("framepack") {
        return Err("项目包文件需要使用 .framepack 扩展名".into());
    }
    let display = path.to_string_lossy().into_owned();
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<WorkflowState>();
        no_active_tasks(&state)?;
        write_archive(&state.store, &state.directory, &workflow_id, &path)
    })
    .await
    .map_err(|_| "项目打包任务中断")??;
    Ok(Some(display))
}

#[tauri::command]
pub async fn import_project_bundle(app: tauri::AppHandle) -> AppResult<Option<Workflow>> {
    {
        let state = app.state::<WorkflowState>();
        no_active_tasks(&state)?;
    }
    let path = if cfg!(debug_assertions) && std::env::var_os("FRAME_STUDIO_TEST_DATA_DIR").is_some()
    {
        std::env::var_os("FRAME_STUDIO_TEST_PROJECT_BUNDLE_PATH").map(PathBuf::from)
    } else {
        let window = app.get_webview_window("main").ok_or("窗口不可用")?;
        tauri::async_runtime::spawn_blocking(move || {
            rfd::FileDialog::new()
                .set_parent(&window)
                .add_filter("Frame Studio 项目包", &["framepack"])
                .pick_file()
        })
        .await
        .map_err(|_| "打开对话框中断")?
    };
    let Some(path) = path else {
        return Ok(None);
    };
    let workflow = tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<WorkflowState>();
        no_active_tasks(&state)?;
        restore_archive(&state.store, &state.directory, &path)
    })
    .await
    .map_err(|_| "项目恢复任务中断")??;
    Ok(Some(workflow))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workflow::types::{NodeConfig, Position, Viewport, WorkflowNode};

    fn fixture() -> (PathBuf, Store, Workflow) {
        let directory = std::env::temp_dir().join(format!("frame-studio-package-{}", uid()));
        fs::create_dir_all(directory.join("assets")).unwrap();
        let store = Store::open(&directory.join("studio.sqlite")).unwrap();
        let workflow = Workflow {
            schema_version: 1,
            id: uid(),
            name: "可迁移项目".into(),
            nodes: vec![WorkflowNode {
                id: uid(),
                kind: NodeKind::Brief,
                label: "创作需求".into(),
                position: Position { x: 0.0, y: 0.0 },
                config: NodeConfig {
                    text: "故事".into(),
                    provider_id: "local-provider".into(),
                    instructions: String::new(),
                    temperature: 0.7,
                    shot_count: 3,
                    duration: 30,
                },
                output: None,
                stale: false,
            }],
            edges: vec![],
            viewport: Viewport {
                x: 0.0,
                y: 0.0,
                zoom: 1.0,
            },
            updated_at: now(),
        };
        store.save_workflow(&workflow).unwrap();
        (directory, store, workflow)
    }

    #[test]
    fn restores_media_bindings_and_render_without_device_credentials() {
        let (source, store, mut workflow) = fixture();
        let image_id = uid();
        let video_id = uid();
        let audio_id = uid();
        let export_id = uid();
        let context = ShotContext {
            workflow_id: workflow.id.clone(),
            node_id: workflow.nodes[0].id.clone(),
            artifact_id: uid(),
            shot_id: uid(),
        };
        let image = ImageAsset {
            asset_id: image_id.clone(),
            version_id: image_id.clone(),
            name: "角色".into(),
            width: 1,
            height: 1,
            bytes: 3,
            created_at: now(),
            source: "import".into(),
            context: None,
            job_id: None,
            file_name: format!("{image_id}.png"),
        };
        let video = VideoAsset {
            asset_id: video_id.clone(),
            version_id: video_id.clone(),
            context: context.clone(),
            first_frame_version_id: image_id.clone(),
            job_id: uid(),
            duration: 5,
            resolution: "720p".into(),
            bytes: 3,
            created_at: now(),
            file_name: format!("{video_id}.mp4"),
        };
        let audio = AudioAsset {
            version_id: audio_id.clone(),
            workflow_id: workflow.id.clone(),
            name: "配乐".into(),
            file_name: format!("{audio_id}.mp3"),
            bytes: 3,
            duration_ms: 5000,
            created_at: now(),
        };
        let subtitle = SubtitleAsset {
            version_id: uid(),
            workflow_id: workflow.id.clone(),
            source_audio_version_id: audio_id.clone(),
            parent_version_id: None,
            cues: vec![subtitles::SubtitleCue {
                start_ms: 50,
                end_ms: 650,
                text: "Hello".into(),
            }],
            created_at: now(),
        };
        let draft = Composition {
            workflow_id: workflow.id.clone(),
            clips: vec![super::super::media::composition::TimelineClip {
                version_id: video_id.clone(),
                trim_start_ms: 0,
                trim_end_ms: 5000,
                caption: "字幕".into(),
            }],
            aspect: "16:9".into(),
            resolution: 720,
            quality: Default::default(),
            music_version_id: Some(audio_id.clone()),
            voice_version_id: Some(audio_id.clone()),
            voice_start_ms: 200,
            effects: super::super::media::editing::TimelineEffects {
                music_fade_in_ms: 100,
                voice_fade_out_ms: 100,
                ..Default::default()
            },
            music_volume: 50,
            subtitle_version_id: Some(subtitle.version_id.clone()),
            subtitle_format: "srt".into(),
            subtitle_text: subtitles::to_srt(&subtitle.cues),
        };
        let render = source.join("original.mp4");
        fs::write(&render, b"mp4").unwrap();
        let mut timeline = workflow.nodes[0].clone();
        timeline.id = uid();
        timeline.kind = NodeKind::Timeline;
        timeline.label = "成片".into();
        timeline.output = Some(Artifact {
            id: uid(),
            kind: NodeKind::Timeline,
            value: serde_json::json!({"exportId":export_id,"outputPath":render.to_string_lossy(),"durationMs":5000,"aspect":"16:9","resolution":720,"clipVersionIds":[video_id]}),
            created_at: now(),
            source: "export".into(),
        });
        workflow.nodes.push(timeline);
        store.save_workflow(&workflow).unwrap();
        let job = ExportJob {
            id: export_id.clone(),
            workflow_id: workflow.id.clone(),
            draft: draft.clone(),
            output_path: render.to_string_lossy().into_owned(),
            cover_path: None,
            status: "succeeded".into(),
            progress: 100,
            message: "ok".into(),
            created_at: now(),
            updated_at: now(),
        };
        let data = Snapshot {
            workflow: workflow.clone(),
            images: vec![image.clone()],
            videos: vec![video.clone()],
            subtitles: vec![subtitle.clone()],
            audios: vec![audio.clone()],
            first_frames: vec![Binding {
                context: context.clone(),
                version_id: image_id.clone(),
            }],
            role_references: vec![RoleBinding {
                role_name: "主角".into(),
                version_id: image_id.clone(),
            }],
            selected_videos: vec![Binding {
                context,
                version_id: video_id.clone(),
            }],
            composition: Some(draft),
            exports: vec![job],
        };
        insert_snapshot_rows_except_workflow(&store, &data);
        fs::write(source.join("assets").join(&image.file_name), b"png").unwrap();
        fs::write(
            source.join("assets").join(format!("{image_id}.thumb.png")),
            b"tnl",
        )
        .unwrap();
        fs::write(source.join("assets").join(&video.file_name), b"mp4").unwrap();
        fs::write(source.join("assets").join(&audio.file_name), b"mp3").unwrap();
        let bundle = source.join("project.framepack");
        write_archive(&store, &source, &workflow.id, &bundle).unwrap();
        let mut archived = ZipArchive::new(File::open(&bundle).unwrap()).unwrap();
        let manifest = read_manifest(&mut archived).unwrap();
        assert_eq!(
            manifest.snapshot.exports[0].output_path,
            format!("exports/{export_id}.mp4")
        );
        assert_eq!(
            manifest.snapshot.workflow.nodes[1]
                .output
                .as_ref()
                .unwrap()
                .value["outputPath"],
            format!("exports/{export_id}.mp4")
        );
        drop(archived);

        let (target, restored_store, _) = fixture();
        let restored = restore_archive(&restored_store, &target, &bundle).unwrap();
        assert_eq!(restored.id, workflow.id);
        assert_eq!(restored.nodes[0].config.provider_id, "");
        assert_eq!(
            restored.nodes[1].output.as_ref().unwrap().value["outputPath"],
            target
                .join("exports")
                .join(format!("{export_id}.mp4"))
                .to_string_lossy()
                .as_ref()
        );
        assert_eq!(restored_store.workflows().unwrap().len(), 2);
        assert_eq!(
            fs::read(target.join("assets").join(image.file_name)).unwrap(),
            b"png"
        );
        assert_eq!(
            fs::read(target.join("assets").join(video.file_name)).unwrap(),
            b"mp4"
        );
        assert_eq!(
            fs::read(target.join("assets").join(audio.file_name)).unwrap(),
            b"mp3"
        );
        assert_eq!(
            fs::read(target.join("exports").join(format!("{export_id}.mp4"))).unwrap(),
            b"mp4"
        );
        let recovered = snapshot(&restored_store, &workflow.id).unwrap();
        assert_eq!(recovered.subtitles.len(), 1);
        assert_eq!(recovered.subtitles[0].source_audio_version_id, audio_id);
        assert_eq!(recovered.subtitles[0].cues, subtitle.cues);
        assert_eq!(recovered.composition.as_ref().unwrap().voice_start_ms, 200);
        assert_eq!(
            recovered
                .composition
                .as_ref()
                .unwrap()
                .effects
                .music_fade_in_ms,
            100
        );
        assert_eq!(
            recovered
                .composition
                .as_ref()
                .unwrap()
                .effects
                .voice_fade_out_ms,
            100
        );
        assert_eq!(
            recovered
                .composition
                .as_ref()
                .unwrap()
                .subtitle_version_id
                .as_ref(),
            Some(&subtitle.version_id)
        );
        assert_eq!(recovered.first_frames.len(), 1);
        assert_eq!(recovered.role_references.len(), 1);
        assert_eq!(recovered.selected_videos.len(), 1);
        assert_eq!(recovered.composition.unwrap().clips.len(), 1);
        assert_eq!(recovered.exports.len(), 1);
        assert!(restore_archive(&restored_store, &target, &bundle)
            .unwrap_err()
            .contains("已存在"));
        drop(restored_store);
        drop(store);
        fs::remove_dir_all(source).unwrap();
        fs::remove_dir_all(target).unwrap();
    }

    fn insert_snapshot_rows_except_workflow(store: &Store, snapshot: &Snapshot) {
        let mut db = store.db().unwrap();
        let transaction = db.transaction().unwrap();
        transaction
            .execute("DELETE FROM workflows WHERE id=?1", [&snapshot.workflow.id])
            .unwrap();
        insert_snapshot(&transaction, snapshot).unwrap();
        transaction.commit().unwrap();
    }

    #[test]
    fn legacy_package_defaults_to_no_automatic_subtitles() {
        let (directory, store, workflow) = fixture();
        let data = snapshot(&store, &workflow.id).unwrap();
        let mut value = serde_json::to_value(&data).unwrap();
        value.as_object_mut().unwrap().remove("subtitles");
        let legacy: Snapshot = serde_json::from_value(value).unwrap();
        assert!(legacy.subtitles.is_empty());
        validate_snapshot(&legacy).unwrap();
        drop(store);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn corrupt_bundle_is_rejected_without_partial_restore() {
        let (source, store, workflow) = fixture();
        let id = uid();
        let image = ImageAsset {
            asset_id: id.clone(),
            version_id: id.clone(),
            name: "图片".into(),
            width: 1,
            height: 1,
            bytes: 7,
            created_at: now(),
            source: "import".into(),
            context: None,
            job_id: None,
            file_name: format!("{id}.png"),
        };
        let data = Snapshot {
            workflow: workflow.clone(),
            images: vec![image.clone()],
            videos: vec![],
            subtitles: vec![],
            audios: vec![],
            first_frames: vec![],
            role_references: vec![RoleBinding {
                role_name: "主角".into(),
                version_id: id.clone(),
            }],
            selected_videos: vec![],
            composition: None,
            exports: vec![],
        };
        insert_snapshot_rows_except_workflow(&store, &data);
        fs::write(source.join("assets").join(&image.file_name), b"payload").unwrap();
        fs::write(
            source.join("assets").join(format!("{id}.thumb.png")),
            b"thumbnail",
        )
        .unwrap();
        let bundle = source.join("intact.framepack");
        write_archive(&store, &source, &workflow.id, &bundle).unwrap();
        let mut bytes = fs::read(&bundle).unwrap();
        let position = bytes
            .windows(7)
            .position(|window| window == b"payload")
            .unwrap();
        bytes[position] ^= 1;
        let corrupt = source.join("corrupt.framepack");
        fs::write(&corrupt, bytes).unwrap();
        let (target, restored_store, _) = fixture();
        assert!(restore_archive(&restored_store, &target, &corrupt).is_err());
        assert!(restored_store
            .workflows()
            .unwrap()
            .iter()
            .all(|item| item.id != workflow.id));
        assert!(!target.join("assets").join(&image.file_name).exists());
        drop(restored_store);
        drop(store);
        fs::remove_dir_all(source).unwrap();
        fs::remove_dir_all(target).unwrap();
    }
}
