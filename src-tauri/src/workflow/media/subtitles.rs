//! Immutable, source-bound subtitle versions. Times are relative to the voice track.
use super::composition::{audio, Composition};
use super::*;

#[derive(Clone, Serialize, Deserialize, PartialEq, Debug)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SubtitleCue {
    pub start_ms: u32,
    pub end_ms: u32,
    pub text: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SubtitleAsset {
    pub version_id: String,
    pub workflow_id: String,
    pub source_audio_version_id: String,
    pub parent_version_id: Option<String>,
    pub cues: Vec<SubtitleCue>,
    pub created_at: u64,
}

pub fn validate_cues(cues: &[SubtitleCue], duration_ms: u32) -> AppResult<()> {
    if cues.is_empty() || cues.len() > 1000 {
        return Err("字幕须包含 1–1000 个片段".into());
    }
    let mut previous_end = 0;
    for cue in cues {
        if cue.start_ms < previous_end
            || cue.start_ms >= cue.end_ms
            || cue.end_ms > duration_ms
            || cue.text.trim().is_empty()
            || cue.text.chars().count() > 1000
            || cue.text.chars().any(char::is_control)
            || cue.text.contains("-->")
            || cue.text.contains(['<', '>', '{', '}'])
        {
            return Err(
                "字幕时间须递增且不重叠、不超出配音；每段文本最多 1000 字，使用纯文本".into(),
            );
        }
        previous_end = cue.end_ms;
    }
    if to_srt(cues).len() > 100_000 {
        return Err("字幕总大小超过 100 KB".into());
    }
    Ok(())
}

fn timestamp(ms: u32) -> String {
    format!(
        "{:02}:{:02}:{:02},{:03}",
        ms / 3_600_000,
        ms / 60_000 % 60,
        ms / 1000 % 60,
        ms % 1000
    )
}

pub fn to_srt(cues: &[SubtitleCue]) -> String {
    cues.iter()
        .enumerate()
        .map(|(i, cue)| {
            format!(
                "{}\n{} --> {}\n{}\n\n",
                i + 1,
                timestamp(cue.start_ms),
                timestamp(cue.end_ms),
                cue.text.trim()
            )
        })
        .collect()
}

pub(super) fn asset(state: &WorkflowState, id: &str) -> AppResult<SubtitleAsset> {
    let json: String = state
        .store
        .db()?
        .query_row("SELECT json FROM subtitle_assets WHERE id=?1", [id], |r| {
            r.get(0)
        })
        .map_err(|_| "字幕版本不存在")?;
    serde_json::from_str(&json).map_err(|_| "字幕版本数据损坏".into())
}

pub(super) fn store(
    state: &WorkflowState,
    workflow_id: String,
    source_audio_version_id: String,
    cues: Vec<SubtitleCue>,
    version_id: String,
    parent_version_id: Option<String>,
) -> AppResult<SubtitleAsset> {
    let source = audio(state, &source_audio_version_id)?;
    if source.workflow_id != workflow_id {
        return Err("配音素材不属于当前项目".into());
    }
    validate_cues(&cues, source.duration_ms)?;
    let result = SubtitleAsset {
        version_id,
        workflow_id,
        source_audio_version_id,
        parent_version_id,
        cues,
        created_at: now(),
    };
    state
        .store
        .db()?
        .execute(
            "INSERT INTO subtitle_assets VALUES (?1,?2,?3,?4)",
            params![
                result.version_id,
                result.workflow_id,
                serde_json::to_string(&result).map_err(|e| e.to_string())?,
                result.created_at
            ],
        )
        .map_err(|e| e.to_string())?;
    Ok(result)
}

#[tauri::command]
pub fn list_subtitle_assets(
    state: tauri::State<WorkflowState>,
    workflow_id: String,
) -> AppResult<Vec<SubtitleAsset>> {
    let db = state.store.db()?;
    let mut query = db.prepare("SELECT json FROM subtitle_assets WHERE workflow_id=?1 ORDER BY created_at DESC, rowid DESC").map_err(|e|e.to_string())?;
    let rows = query
        .query_map([workflow_id], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    rows.map(|r| serde_json::from_str(&r.map_err(|e| e.to_string())?).map_err(|e| e.to_string()))
        .collect()
}

#[tauri::command]
pub fn get_subtitle_srt(
    state: tauri::State<WorkflowState>,
    version_id: String,
) -> AppResult<String> {
    let selected = asset(&state, &version_id)?;
    validate_cues(
        &selected.cues,
        audio(&state, &selected.source_audio_version_id)?.duration_ms,
    )?;
    Ok(to_srt(&selected.cues))
}

#[tauri::command]
pub fn save_subtitle_version(
    state: tauri::State<WorkflowState>,
    workflow_id: String,
    parent_version_id: String,
    cues: Vec<SubtitleCue>,
) -> AppResult<SubtitleAsset> {
    let parent = asset(&state, &parent_version_id)?;
    if parent.workflow_id != workflow_id {
        return Err("字幕版本不属于当前项目".into());
    }
    store(
        &state,
        workflow_id,
        parent.source_audio_version_id,
        cues,
        uid(),
        Some(parent_version_id),
    )
}

pub(super) fn validate_binding(state: &WorkflowState, draft: &Composition) -> AppResult<()> {
    if let Some(id) = &draft.subtitle_version_id {
        let selected = asset(state, id)?;
        if selected.workflow_id != draft.workflow_id
            || draft.voice_version_id.as_ref() != Some(&selected.source_audio_version_id)
            || draft.subtitle_format != "srt"
            || draft.subtitle_text != to_srt(&selected.cues)
        {
            return Err("字幕与当前配音或字幕文本不匹配；请重新应用匹配的字幕版本".into());
        }
        validate_cues(
            &selected.cues,
            audio(state, &selected.source_audio_version_id)?.duration_ms,
        )?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn captions_reject_overlap_overflow_and_srt_injection() {
        let cue = SubtitleCue {
            start_ms: 50,
            end_ms: 650,
            text: "你好。".into(),
        };
        assert!(validate_cues(std::slice::from_ref(&cue), 700).is_ok());
        assert_eq!(
            to_srt(std::slice::from_ref(&cue)),
            "1\n00:00:00,050 --> 00:00:00,650\n你好。\n\n"
        );
        assert!(validate_cues(&[], 700).is_err());
        assert!(validate_cues(&[cue.clone(), cue.clone()], 700).is_err());
        assert!(validate_cues(std::slice::from_ref(&cue), 600).is_err());
        for text in ["", "x\n\n2", "x --> y", "{\\an8}x", "<i>x</i>"] {
            assert!(validate_cues(
                &[SubtitleCue {
                    text: text.into(),
                    ..cue.clone()
                }],
                700
            )
            .is_err());
        }
    }
}
