//! Immutable local image versions and explicit, version-scoped shot selections.
pub mod cloud;
pub mod comfy;
use super::{types::*, WorkflowState};
use base64::{engine::general_purpose::STANDARD, Engine};
use image::{GenericImageView, ImageFormat, ImageReader};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::io::Cursor;

pub const MAX_IMAGE_BYTES: usize = 20 * 1024 * 1024;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ShotContext {
    pub workflow_id: String,
    pub node_id: String,
    pub artifact_id: String,
    pub shot_id: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageAsset {
    pub asset_id: String,
    pub version_id: String,
    pub name: String,
    pub width: u32,
    pub height: u32,
    pub bytes: usize,
    pub created_at: u64,
    pub source: String,
    pub context: Option<ShotContext>,
    pub job_id: Option<String>,
    pub file_name: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FirstFrame {
    pub context: ShotContext,
    pub version_id: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoleReference {
    pub workflow_id: String,
    pub role_name: String,
    pub version_id: String,
}

#[tauri::command]
pub fn list_role_references(
    state: tauri::State<WorkflowState>,
    workflow_id: String,
) -> AppResult<Vec<RoleReference>> {
    let db = state.store.db()?;
    let mut query = db
        .prepare("SELECT role_name,version_id FROM role_references WHERE workflow_id=?1 ORDER BY role_name")
        .map_err(|e| e.to_string())?;
    let rows = query
        .query_map([&workflow_id], |row| {
            Ok(RoleReference {
                workflow_id: workflow_id.clone(),
                role_name: row.get(0)?,
                version_id: row.get(1)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.map(|row| row.map_err(|e| e.to_string())).collect()
}

#[tauri::command]
pub fn set_role_reference(
    state: tauri::State<WorkflowState>,
    workflow_id: String,
    role_name: String,
    version_id: String,
) -> AppResult<()> {
    let role_name = role_name.trim();
    if role_name.is_empty()
        || role_name.chars().count() > 80
        || role_name.chars().any(char::is_control)
    {
        return Err("角色名称需为 1–80 个可见字符".into());
    }
    let exists: bool = state
        .store
        .db()?
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM workflows WHERE id=?1)",
            [&workflow_id],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    if !exists {
        return Err("工作流不存在".into());
    }
    let entry = asset(&state, &version_id)?;
    if !state
        .directory
        .join("assets")
        .join(entry.file_name)
        .is_file()
    {
        return Err("原图文件已丢失，请重新导入".into());
    }
    state.store.db()?.execute(
        "INSERT INTO role_references VALUES (?1,?2,?3) ON CONFLICT(workflow_id,role_name) DO UPDATE SET version_id=excluded.version_id",
        params![workflow_id, role_name, version_id],
    ).map_err(|e| e.to_string())?;
    Ok(())
}

pub enum FrameCollection {
    Complete(serde_json::Value),
    Missing(Vec<String>),
}

/// Resolve selections against the exact storyboard artifact used by this run.
pub fn collect_first_frames(
    state: &WorkflowState,
    workflow_id: &str,
    node_id: &str,
    artifact: &Artifact,
) -> AppResult<FrameCollection> {
    if artifact.kind != NodeKind::Storyboard {
        return Err("图片节点需要分镜结果".into());
    }
    validate_output(&NodeKind::Storyboard, &artifact.value)?;
    let shots = artifact.value["shots"].as_array().ok_or("分镜结果无效")?;
    let mut frames = Vec::with_capacity(shots.len());
    let mut missing = Vec::new();
    for shot in shots {
        let shot_id = shot["id"].as_str().ok_or("镜头 ID 无效")?;
        let selected: Option<String> = {
            let db = state.store.db()?;
            db.query_row(
                    "SELECT version_id FROM first_frames WHERE workflow_id=?1 AND node_id=?2 AND artifact_id=?3 AND shot_id=?4",
                    params![workflow_id, node_id, artifact.id, shot_id],
                    |row| row.get(0),
                )
                .optional()
                .map_err(|e| e.to_string())?
        };
        if let Some(version_id) = selected {
            if let Ok(entry) = asset(state, &version_id) {
                if state
                    .directory
                    .join("assets")
                    .join(&entry.file_name)
                    .is_file()
                {
                    frames.push(serde_json::json!({
                        "shotId": shot_id,
                        "assetId": entry.asset_id,
                        "versionId": entry.version_id,
                        "width": entry.width,
                        "height": entry.height,
                    }));
                } else {
                    missing.push(shot_id.to_string());
                }
            } else {
                missing.push(shot_id.to_string());
            }
        } else {
            missing.push(shot_id.to_string());
        }
    }
    if !missing.is_empty() {
        return Ok(FrameCollection::Missing(missing));
    }
    Ok(FrameCollection::Complete(serde_json::json!({
        "storyboardArtifactId": artifact.id,
        "frames": frames,
    })))
}

pub fn validate_context(state: &WorkflowState, context: &ShotContext) -> AppResult<()> {
    let workflow = state
        .store
        .workflows()?
        .into_iter()
        .find(|w| w.id == context.workflow_id)
        .ok_or("工作流不存在，请先保存")?;
    let node = workflow
        .nodes
        .iter()
        .find(|n| n.id == context.node_id)
        .ok_or("分镜节点不存在")?;
    let output = node
        .output
        .as_ref()
        .filter(|a| a.id == context.artifact_id && a.kind == NodeKind::Storyboard && !node.stale)
        .ok_or("分镜已变化，请先确认最新分镜，再制作首帧")?;
    if !output.value["shots"].as_array().is_some_and(|shots| {
        shots
            .iter()
            .any(|s| s["id"].as_str() == Some(&context.shot_id))
    }) {
        return Err("镜头不存在".into());
    }
    Ok(())
}

pub fn asset(state: &WorkflowState, id: &str) -> AppResult<ImageAsset> {
    let json: String = state
        .store
        .db()?
        .query_row("SELECT json FROM image_assets WHERE id=?1", [id], |r| {
            r.get(0)
        })
        .map_err(|_| "素材不存在，可能来自另一台设备")?;
    serde_json::from_str(&json).map_err(|e| e.to_string())
}

/// Decode with bounded dimensions and allocation; do not trust extensions or MIME.
fn decode(bytes: &[u8]) -> AppResult<(image::DynamicImage, ImageFormat)> {
    if bytes.is_empty() || bytes.len() > MAX_IMAGE_BYTES {
        return Err("图片必须在 20 MB 以内".into());
    }
    let format = image::guess_format(bytes).map_err(|_| "仅支持 PNG、JPEG、WebP 图片")?;
    if !matches!(
        format,
        ImageFormat::Png | ImageFormat::Jpeg | ImageFormat::WebP
    ) {
        return Err("仅支持 PNG、JPEG、WebP 图片".into());
    }
    let (width, height) = ImageReader::with_format(Cursor::new(bytes), format)
        .into_dimensions()
        .map_err(|_| "无法读取图片尺寸")?;
    if u64::from(width) * u64::from(height) > 16_777_216 {
        return Err("图片不能超过 1677 万像素".into());
    }
    let mut reader = ImageReader::with_format(Cursor::new(bytes), format);
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(8192);
    limits.max_image_height = Some(8192);
    limits.max_alloc = Some(128 * 1024 * 1024);
    reader.limits(limits);
    let decoded = reader
        .decode()
        .map_err(|_| "图片损坏或像素尺寸过大（最长边 8192）")?;
    Ok((decoded, format))
}

pub fn store_image(
    state: &WorkflowState,
    bytes: &[u8],
    mut entry: ImageAsset,
) -> AppResult<ImageAsset> {
    // All identifiers reaching paths are generated here or by our job worker.
    if entry.version_id.is_empty()
        || !entry
            .version_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-')
    {
        return Err("素材版本 ID 无效".into());
    }
    if let Ok(existing) = asset(state, &entry.version_id) {
        return Ok(existing);
    }
    let (decoded, format) = decode(bytes)?;
    (entry.width, entry.height) = decoded.dimensions();
    entry.bytes = bytes.len();
    entry.file_name = format!(
        "{}.{}",
        entry.version_id,
        match format {
            ImageFormat::Jpeg => "jpg",
            ImageFormat::WebP => "webp",
            _ => "png",
        }
    );
    let directory = state.directory.join("assets");
    std::fs::create_dir_all(&directory).map_err(|_| "无法创建素材目录")?;
    let mut thumbnail = Cursor::new(Vec::new());
    decoded
        .thumbnail(640, 640)
        .write_to(&mut thumbnail, ImageFormat::Png)
        .map_err(|_| "无法生成预览")?;
    std::fs::write(directory.join(&entry.file_name), bytes)
        .map_err(|_| "无法保存原始图片，请检查磁盘空间")?;
    std::fs::write(
        directory.join(format!("{}.thumb.png", entry.version_id)),
        thumbnail.into_inner(),
    )
    .map_err(|_| "无法保存预览")?;
    state
        .store
        .db()?
        .execute(
            "INSERT INTO image_assets VALUES (?1,?2,?3)",
            params![
                entry.version_id,
                serde_json::to_string(&entry).map_err(|e| e.to_string())?,
                entry.created_at
            ],
        )
        .map_err(|e| e.to_string())?;
    Ok(entry)
}

#[tauri::command]
pub async fn import_image(
    app: tauri::AppHandle,
    name: String,
    bytes: Vec<u8>,
) -> AppResult<ImageAsset> {
    use tauri::Manager;
    // CPU decoding and filesystem IO must not block the UI/main thread.
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<WorkflowState>();
        let id = uid();
        let entry = ImageAsset {
            asset_id: id.clone(),
            version_id: id,
            name: name.chars().take(200).collect(),
            width: 0,
            height: 0,
            bytes: 0,
            created_at: now(),
            source: "import".into(),
            context: None,
            job_id: None,
            file_name: String::new(),
        };
        store_image(&state, &bytes, entry)
    })
    .await
    .map_err(|_| "图片导入任务失败")?
}
#[tauri::command]
pub fn list_image_assets(state: tauri::State<WorkflowState>) -> AppResult<Vec<ImageAsset>> {
    let db = state.store.db()?;
    let mut query = db
        .prepare("SELECT json FROM image_assets ORDER BY created_at DESC LIMIT 500")
        .map_err(|e| e.to_string())?;
    let rows = query
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    rows.map(|r| serde_json::from_str(&r.map_err(|e| e.to_string())?).map_err(|e| e.to_string()))
        .collect()
}
#[tauri::command]
pub async fn image_preview(app: tauri::AppHandle, version_id: String) -> AppResult<String> {
    use tauri::Manager;
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<WorkflowState>();
        let entry = asset(&state, &version_id)?;
        let bytes = std::fs::read(
            state
                .directory
                .join("assets")
                .join(format!("{}.thumb.png", entry.version_id)),
        )
        .map_err(|_| "预览文件丢失")?;
        Ok(format!("data:image/png;base64,{}", STANDARD.encode(bytes)))
    })
    .await
    .map_err(|_| "无法读取预览")?
}
#[tauri::command]
pub fn select_first_frame(
    state: tauri::State<WorkflowState>,
    context: ShotContext,
    version_id: String,
) -> AppResult<()> {
    validate_context(&state, &context)?;
    let entry = asset(&state, &version_id)?;
    if !state
        .directory
        .join("assets")
        .join(entry.file_name)
        .is_file()
    {
        return Err("原图文件已丢失，请重新导入".into());
    }
    state.store.db()?.execute("INSERT INTO first_frames VALUES (?1,?2,?3,?4,?5) ON CONFLICT(workflow_id,node_id,artifact_id,shot_id) DO UPDATE SET version_id=excluded.version_id", params![context.workflow_id,context.node_id,context.artifact_id,context.shot_id,version_id]).map_err(|e| e.to_string())?;
    Ok(())
}
#[tauri::command]
pub fn list_first_frames(
    state: tauri::State<WorkflowState>,
    workflow_id: String,
) -> AppResult<Vec<FirstFrame>> {
    let db = state.store.db()?;
    let mut query = db
        .prepare(
            "SELECT node_id,artifact_id,shot_id,version_id FROM first_frames WHERE workflow_id=?1",
        )
        .map_err(|e| e.to_string())?;
    let rows = query
        .query_map([&workflow_id], |r| {
            Ok(FirstFrame {
                context: ShotContext {
                    workflow_id: workflow_id.clone(),
                    node_id: r.get(0)?,
                    artifact_id: r.get(1)?,
                    shot_id: r.get(2)?,
                },
                version_id: r.get(3)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.map(|r| r.map_err(|e| e.to_string())).collect()
}

pub fn setting(state: &WorkflowState) -> AppResult<Option<String>> {
    state
        .store
        .db()?
        .query_row(
            "SELECT json FROM media_settings WHERE id='comfy'",
            [],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_non_images_and_truncated_images() {
        assert!(decode(b"<svg></svg>").is_err());
        assert!(decode(b"\x89PNG\r\n\x1a\n").is_err());
        assert!(decode(&[]).is_err());
    }
}
