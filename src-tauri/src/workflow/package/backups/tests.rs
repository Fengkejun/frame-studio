use super::*;
use crate::workflow::package::tests::fixture;

pub(in crate::workflow::package) fn check_full_media_copy(
    store: &Store,
    directory: &Path,
    workflow: &Workflow,
) {
    let parent = std::env::temp_dir().join(format!("frame-backup-test-{}", uid()));
    fs::create_dir(&parent).unwrap();
    let root = initialize(&parent, directory).unwrap();
    let point = create(store, directory, &workflow.id, &root).unwrap();
    let original = snapshot(store, &workflow.id).unwrap();
    let restored = restore(store, directory, &root, &point.id).unwrap();
    let copy = snapshot(store, &restored.id).unwrap();
    assert_eq!(
        copy.videos[0].first_frame_version_id,
        copy.images[0].version_id
    );
    assert_eq!(copy.first_frames[0].version_id, copy.images[0].version_id);
    assert_eq!(
        copy.role_references[0].version_id,
        copy.images[0].version_id
    );
    assert_eq!(
        copy.selected_videos[0].version_id,
        copy.videos[0].version_id
    );
    assert_eq!(
        copy.subtitles[0].source_audio_version_id,
        copy.audios[0].version_id
    );
    assert_eq!(copy.subtitles[0].cues, original.subtitles[0].cues);
    let draft = copy.composition.as_ref().unwrap();
    assert_eq!(draft.clips[0].version_id, copy.videos[0].version_id);
    assert_eq!(
        draft.voice_version_id.as_ref(),
        Some(&copy.audios[0].version_id)
    );
    assert_eq!(
        draft.subtitle_version_id.as_ref(),
        Some(&copy.subtitles[0].version_id)
    );
    assert_eq!(draft.voice_start_ms, 200);
    assert_eq!(draft.effects.music_fade_in_ms, 100);
    let output = &restored.nodes[1].output.as_ref().unwrap().value;
    assert_eq!(output["clipVersionIds"][0], copy.videos[0].version_id);
    assert_eq!(output["exportId"], copy.exports[0].id);
    assert_eq!(output["outputPath"], copy.exports[0].output_path);
    assert_ne!(copy.exports[0].id, original.exports[0].id);
    assert!(Path::new(&copy.exports[0].output_path).is_file());
    let latest = snapshot(store, &workflow.id).unwrap();
    assert_eq!(latest.images[0].version_id, original.images[0].version_id);
    assert_eq!(latest.exports[0].id, original.exports[0].id);
    fs::remove_dir_all(parent).unwrap();
}

fn image(store: &Store, directory: &Path, workflow: &Workflow, bytes: &[u8]) -> ImageAsset {
    let id = uid();
    let asset = ImageAsset {
        asset_id: uid(),
        version_id: id.clone(),
        name: "角色".into(),
        width: 1,
        height: 1,
        bytes: bytes.len(),
        created_at: now(),
        source: "import".into(),
        context: Some(ShotContext {
            workflow_id: workflow.id.clone(),
            node_id: workflow.nodes[0].id.clone(),
            artifact_id: uid(),
            shot_id: uid(),
        }),
        job_id: None,
        file_name: format!("{id}.png"),
    };
    let db = store.db().unwrap();
    db.execute(
        "INSERT INTO image_assets(id,json,created_at) VALUES (?1,?2,?3)",
        params![id, serde_json::to_string(&asset).unwrap(), asset.created_at],
    )
    .unwrap();
    fs::write(directory.join("assets").join(&asset.file_name), bytes).unwrap();
    fs::write(
        directory.join("assets").join(format!("{id}.thumb.png")),
        bytes,
    )
    .unwrap();
    asset
}

#[test]
fn repeated_backups_share_objects_and_restore_independent_copies() {
    let (directory, store, workflow) = fixture();
    let parent = std::env::temp_dir().join(format!("frame-backup-test-{}", uid()));
    fs::create_dir(&parent).unwrap();
    let root = initialize(&parent, &directory).unwrap();
    let original = image(&store, &directory, &workflow, b"original");
    let first = create(&store, &directory, &workflow.id, &root).unwrap();
    assert_eq!(first.total_bytes, 16);
    assert_eq!(first.new_bytes, 8); // Identical thumbnail is shared within a point, too.
    assert_eq!(fs::read_dir(root.join("objects")).unwrap().count(), 1);
    let second = create(&store, &directory, &workflow.id, &root).unwrap();
    assert_eq!(second.new_bytes, 0);
    assert_eq!(second.reused_bytes, 16);
    image(&store, &directory, &workflow, b"next");
    let third = create(&store, &directory, &workflow.id, &root).unwrap();
    assert_eq!(third.new_bytes, 4);
    assert_eq!(third.total_bytes, 24);
    // No chronological chain: deleting an intermediate point leaves older/newer points restorable.
    fs::remove_file(root.join("snapshots").join(format!("{}.json", second.id))).unwrap();
    let restored = restore(&store, &directory, &root, &first.id).unwrap();
    assert_ne!(restored.id, workflow.id);
    let copy = snapshot(&store, &restored.id).unwrap();
    assert_eq!(copy.images.len(), 1);
    assert_ne!(copy.images[0].version_id, original.version_id);
    assert_eq!(
        fs::read(directory.join("assets").join(&copy.images[0].file_name)).unwrap(),
        b"original"
    );
    assert_eq!(snapshot(&store, &workflow.id).unwrap().images.len(), 2);
    let again = restore(&store, &directory, &root, &first.id).unwrap();
    assert_ne!(restored.id, again.id);
    let newest = restore(&store, &directory, &root, &third.id).unwrap();
    assert_eq!(snapshot(&store, &newest.id).unwrap().images.len(), 2);
    assert_eq!(list(&root).unwrap().points.len(), 2);
    drop(store);
    fs::remove_dir_all(directory).unwrap();
    fs::remove_dir_all(parent).unwrap();
}

#[test]
fn corruption_and_untrusted_manifests_leave_current_project_untouched() {
    let (directory, store, workflow) = fixture();
    let parent = std::env::temp_dir().join(format!("frame-backup-test-{}", uid()));
    fs::create_dir(&parent).unwrap();
    let root = initialize(&parent, &directory).unwrap();
    image(&store, &directory, &workflow, b"original");
    let point = create(&store, &directory, &workflow.id, &root).unwrap();
    let data = read(&root, &point.id).unwrap();
    fs::write(
        root.join("objects").join(&data.manifest.files[0].sha256),
        b"tampered",
    )
    .unwrap();
    assert!(restore(&store, &directory, &root, &point.id)
        .unwrap_err()
        .contains("校验"));
    assert!(create(&store, &directory, &workflow.id, &root).is_err());
    assert_eq!(store.workflows().unwrap().len(), 1);
    assert_eq!(fs::read_dir(directory.join("assets")).unwrap().count(), 2);
    assert_eq!(list(&root).unwrap().points.len(), 1);
    assert!(restore(&store, &directory, &root, "../../outside").is_err());
    let mut malicious = data;
    malicious.manifest.snapshot.images[0].bytes += 1;
    assert!(validate_backup(&malicious, &point.id)
        .unwrap_err()
        .contains("大小"));
    malicious.manifest.snapshot.images[0].bytes -= 1;
    malicious.manifest.files[0].name = "../outside".into();
    fs::write(
        root.join("snapshots").join(format!("{}.json", point.id)),
        serde_json::to_vec(&malicious).unwrap(),
    )
    .unwrap();
    assert!(restore(&store, &directory, &root, &point.id).is_err());
    let report = list(&root).unwrap();
    assert!(report.points.is_empty());
    assert_eq!(report.warnings.len(), 1);
    assert!(!fs::read_dir(&directory).unwrap().any(|e| e
        .unwrap()
        .file_name()
        .to_string_lossy()
        .starts_with(".restore-")));
    drop(store);
    fs::remove_dir_all(directory).unwrap();
    fs::remove_dir_all(parent).unwrap();
}

#[test]
fn backup_location_rejects_app_data_and_unrecognized_folders() {
    let (directory, store, _) = fixture();
    assert!(initialize(&directory, &directory).is_err());
    let parent = std::env::temp_dir().join(format!("frame-backup-test-{}", uid()));
    fs::create_dir_all(parent.join("FrameStudioBackups")).unwrap();
    fs::write(parent.join("FrameStudioBackups/keep.txt"), b"keep").unwrap();
    assert!(initialize(&parent, &directory).is_err());
    assert_eq!(
        fs::read(parent.join("FrameStudioBackups/keep.txt")).unwrap(),
        b"keep"
    );
    drop(store);
    fs::remove_dir_all(directory).unwrap();
    fs::remove_dir_all(parent).unwrap();
}
