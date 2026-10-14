use super::*;
use serde_json::Value;

/// Change only identity fields and media references, preserving text, captions,
/// shot/node/artifact IDs (scoped to a workflow), and all version relationships.
pub(super) fn copy_ids(manifest: &mut Manifest) -> AppResult<()> {
    let snapshot = &mut manifest.snapshot;
    let workflow_id = uid();
    let versions: HashMap<_, _> = snapshot
        .images
        .iter()
        .map(|a| &a.version_id)
        .chain(snapshot.videos.iter().map(|a| &a.version_id))
        .chain(snapshot.audios.iter().map(|a| &a.version_id))
        .chain(snapshot.subtitles.iter().map(|a| &a.version_id))
        .map(|id| (id.clone(), uid()))
        .collect();
    let assets: HashMap<_, _> = snapshot
        .images
        .iter()
        .map(|a| &a.asset_id)
        .chain(snapshot.videos.iter().map(|a| &a.asset_id))
        .map(|id| (id.clone(), uid()))
        .collect();
    let exports: HashMap<_, _> = snapshot
        .exports
        .iter()
        .map(|job| (job.id.clone(), uid()))
        .collect();
    let mut names = HashMap::new();
    let version = |id: &mut String| {
        if let Some(new) = versions.get(id) {
            *id = new.clone();
        }
    };
    let filename =
        |name: &mut String, id: &str, names: &mut HashMap<String, String>| -> AppResult<()> {
            let extension = Path::new(name)
                .extension()
                .and_then(|v| v.to_str())
                .ok_or("素材扩展名无效")?;
            let new = format!("{id}.{extension}");
            names.insert(format!("assets/{name}"), format!("assets/{new}"));
            *name = new;
            Ok(())
        };
    for image in &mut snapshot.images {
        let old = image.version_id.clone();
        version(&mut image.version_id);
        image.asset_id = assets[&image.asset_id].clone();
        filename(&mut image.file_name, &image.version_id, &mut names)?;
        names.insert(
            format!("assets/{old}.thumb.png"),
            format!("assets/{}.thumb.png", image.version_id),
        );
        if let Some(context) = &mut image.context {
            context.workflow_id = workflow_id.clone();
        }
        image.job_id = None;
    }
    for video in &mut snapshot.videos {
        version(&mut video.version_id);
        version(&mut video.first_frame_version_id);
        video.asset_id = assets[&video.asset_id].clone();
        video.context.workflow_id = workflow_id.clone();
        video.job_id.clear();
        filename(&mut video.file_name, &video.version_id, &mut names)?;
    }
    for audio in &mut snapshot.audios {
        version(&mut audio.version_id);
        audio.workflow_id = workflow_id.clone();
        filename(&mut audio.file_name, &audio.version_id, &mut names)?;
    }
    for subtitle in &mut snapshot.subtitles {
        version(&mut subtitle.version_id);
        version(&mut subtitle.source_audio_version_id);
        if let Some(parent) = &mut subtitle.parent_version_id {
            version(parent);
        }
        subtitle.workflow_id = workflow_id.clone();
    }
    for binding in snapshot
        .first_frames
        .iter_mut()
        .chain(&mut snapshot.selected_videos)
    {
        binding.context.workflow_id = workflow_id.clone();
        version(&mut binding.version_id);
    }
    for binding in &mut snapshot.role_references {
        version(&mut binding.version_id);
    }
    let composition = |draft: &mut Composition| {
        draft.workflow_id = workflow_id.clone();
        for clip in &mut draft.clips {
            version(&mut clip.version_id);
        }
        for id in [
            &mut draft.music_version_id,
            &mut draft.voice_version_id,
            &mut draft.subtitle_version_id,
        ]
        .into_iter()
        .flatten()
        {
            version(id);
        }
    };
    if let Some(draft) = &mut snapshot.composition {
        composition(draft);
    }
    for job in &mut snapshot.exports {
        let old = job.id.clone();
        job.id = exports[&old].clone();
        job.workflow_id = workflow_id.clone();
        composition(&mut job.draft);
        for suffix in ["mp4", "cover.jpg"] {
            names.insert(
                format!("exports/{old}.{suffix}"),
                format!("exports/{}.{suffix}", job.id),
            );
        }
        job.output_path = format!("exports/{}.mp4", job.id);
        job.cover_path = job
            .cover_path
            .as_ref()
            .map(|_| format!("exports/{}.cover.jpg", job.id));
    }
    fn output(
        value: &mut Value,
        versions: &HashMap<String, String>,
        assets: &HashMap<String, String>,
        exports: &HashMap<String, String>,
    ) {
        match value {
            Value::Array(items) => {
                for item in items {
                    output(item, versions, assets, exports);
                }
            }
            Value::Object(fields) => {
                for (key, value) in fields {
                    let map = match key.as_str() {
                        "assetId" => Some(assets),
                        "versionId"
                        | "firstFrameVersionId"
                        | "videoVersionId"
                        | "subtitleVersionId"
                        | "sourceAudioVersionId" => Some(versions),
                        "exportId" => Some(exports),
                        _ => None,
                    };
                    if key == "clipVersionIds" || key == "imageVersionIds" {
                        if let Value::Array(ids) = value {
                            for id in ids {
                                if let Some(new) = id.as_str().and_then(|id| versions.get(id)) {
                                    *id = Value::String(new.clone());
                                }
                            }
                        }
                        continue;
                    }
                    if let Some(new) = map.and_then(|map| value.as_str().and_then(|id| map.get(id)))
                    {
                        *value = Value::String(new.clone());
                    } else {
                        output(value, versions, assets, exports);
                    }
                }
            }
            _ => (),
        }
    }
    for node in &mut snapshot.workflow.nodes {
        if matches!(
            node.kind,
            NodeKind::Image | NodeKind::Video | NodeKind::Timeline
        ) {
            if let Some(artifact) = &mut node.output {
                output(&mut artifact.value, &versions, &assets, &exports);
            }
        }
    }
    snapshot.workflow.id = workflow_id;
    snapshot.workflow.name = format!(
        "{} · 恢复副本",
        snapshot.workflow.name.chars().take(90).collect::<String>()
    );
    snapshot.workflow.updated_at = now();
    let paths = snapshot
        .exports
        .iter()
        .map(|job| (job.id.clone(), job.output_path.clone()))
        .collect();
    rewrite_canvas_paths(&mut snapshot.workflow, &paths);
    for file in &mut manifest.files {
        file.name = names.get(&file.name).ok_or("备份素材缺少恢复映射")?.clone();
    }
    validate_snapshot(snapshot)?;
    let expected = expected_files(snapshot);
    let actual: HashSet<_> = manifest.files.iter().map(|f| f.name.clone()).collect();
    if actual != expected || actual.len() != manifest.files.len() {
        return Err("恢复素材映射不完整".into());
    }
    Ok(())
}
