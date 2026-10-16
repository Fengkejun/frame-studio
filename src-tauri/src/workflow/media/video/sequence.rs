//! One provider job covering the current ordered storyboard. No per-shot POST loop.
use super::*;
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Sequence {
    pub shot_ids: Vec<String>,
}
pub(crate) fn collect(
    state: &WorkflowState,
    workflow_id: &str,
    node_id: &str,
    storyboard: &Artifact,
) -> AppResult<FrameCollection> {
    let shots = storyboard.value["shots"].as_array().ok_or("分镜列表无效")?;
    let first = shots
        .first()
        .and_then(|s| s["id"].as_str())
        .ok_or("分镜为空")?;
    let id:Option<String>=state.store.db()?.query_row("SELECT version_id FROM selected_videos WHERE workflow_id=?1 AND node_id=?2 AND artifact_id=?3 AND shot_id=?4",params![workflow_id,node_id,storyboard.id,first],|r|r.get(0)).optional().map_err(|e|e.to_string())?;
    if let Some(entry) = id
        .and_then(|id| load_asset(state, &id).ok())
        .filter(|v| v.sequence.is_some())
    {
        if entry.context.workflow_id != workflow_id
            || entry.context.node_id != node_id
            || entry.context.artifact_id != storyboard.id
            || entry.context.shot_id != first
        {
            return Err("整段视频不属于当前分镜".into());
        }
        validate(
            state,
            &entry.context,
            entry.sequence.as_ref().unwrap(),
            entry.duration,
        )?;
        if !entry.first_frame_version_id.is_empty() {
            let current:Option<String> = state.store.db()?.query_row("SELECT version_id FROM first_frames WHERE workflow_id=?1 AND node_id=?2 AND artifact_id=?3 AND shot_id=?4",params![workflow_id,node_id,storyboard.id,first],|r|r.get(0)).optional().map_err(|e|e.to_string())?;
            if current.as_deref() != Some(&entry.first_frame_version_id) {
                return Err("整段视频的源首帧已变化，请重新确认视频版本".into());
            }
        }
        if state
            .directory
            .join("assets")
            .join(&entry.file_name)
            .is_file()
        {
            return Ok(FrameCollection::Complete(
                json!({"storyboardArtifactId":storyboard.id,"clips":[{"shotId":first,"assetId":entry.asset_id,"versionId":entry.version_id,"firstFrameVersionId":entry.first_frame_version_id,"sequenceShotIds":entry.sequence.unwrap().shot_ids,"duration":entry.metadata.as_ref().map(|m|m.duration_ms as f64/1000.0).unwrap_or(f64::from(entry.duration)),"resolution":entry.metadata.map(|m|format!("{}x{}",m.width,m.height)).unwrap_or(entry.resolution)}]}),
            ));
        }
    }
    Ok(FrameCollection::Missing(vec!["整段分镜视频".into()]))
}
pub(crate) fn validate(
    state: &WorkflowState,
    context: &ShotContext,
    plan: &Sequence,
    duration: u8,
) -> AppResult<()> {
    let data: String = state
        .store
        .db()?
        .query_row(
            "SELECT json FROM workflows WHERE id=?1",
            [&context.workflow_id],
            |r| r.get(0),
        )
        .map_err(|_| "项目不存在")?;
    let workflow: Workflow = serde_json::from_str(&data).map_err(|_| "项目格式无效")?;
    let node = workflow
        .nodes
        .iter()
        .find(|n| n.id == context.node_id && n.kind == NodeKind::Storyboard && !n.stale)
        .ok_or("分镜已失效")?;
    let artifact = node
        .output
        .as_ref()
        .filter(|a| a.id == context.artifact_id)
        .ok_or("分镜版本已变化")?;
    let shots = artifact.value["shots"].as_array().ok_or("分镜列表无效")?;
    let ids: Vec<_> = shots.iter().filter_map(|s| s["id"].as_str()).collect();
    if ids.is_empty()
        || ids.len() > 24
        || plan.shot_ids.iter().map(String::as_str).collect::<Vec<_>>() != ids
        || ids[0] != context.shot_id
    {
        return Err("整段任务必须按顺序覆盖当前分镜，且绑定第一个镜头".into());
    }
    let seconds: f64 = shots.iter().filter_map(|s| s["duration"].as_f64()).sum();
    if !seconds.is_finite() || (seconds - f64::from(duration)).abs() > 0.001 {
        return Err("整段视频时长须等于分镜总时长；请先调整分镜或选择支持该时长的服务".into());
    }
    Ok(())
}
