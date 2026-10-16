//! Explicit framing and per-shot placement of immutable source speech.
use super::*;

#[derive(Clone, Copy, Default, Serialize, Deserialize, PartialEq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum FrameFit {
    #[default]
    Contain,
    Cover,
    Blur,
}

#[derive(Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VoiceCue {
    pub clip_version_id: String,
    pub source_start_ms: u32,
    pub source_end_ms: u32,
}

pub(super) fn validate_voice_cues(draft: &Composition, duration: Option<u32>) -> AppResult<()> {
    if draft.voice_cues.is_empty() {
        return Ok(());
    }
    if draft.voice_version_id.is_none()
        || draft.voice_cues.len() > 24
        || draft.voice_start_ms != 0
        || draft.subtitle_format != "none"
        || draft.subtitle_version_id.is_some()
        || draft.effects.voice_fade_in_ms != 0
        || draft.effects.voice_fade_out_ms != 0
    {
        return Err(
            "分镜配音使用片段台词字幕，起点和配音淡入淡出须为零；请先清除其他配音/字幕对齐方式"
                .into(),
        );
    }
    let layout = editing::layout(draft)?;
    let mut ids = HashSet::new();
    for cue in &draft.voice_cues {
        let i = draft
            .clips
            .iter()
            .position(|clip| clip.version_id == cue.clip_version_id)
            .ok_or("配音分句绑定的镜头已移除，请重新对齐")?;
        let start = layout.starts_ms[i] + if i > 0 { layout.overlap_ms / 2 } else { 0 };
        let end = if i + 1 < draft.clips.len() {
            layout.starts_ms[i + 1] + layout.overlap_ms / 2
        } else {
            layout.total_ms
        };
        if !ids.insert(&cue.clip_version_id)
            || cue.source_end_ms <= cue.source_start_ms
            || cue.source_end_ms > 3_600_000
            || duration.is_some_and(|d| cue.source_end_ms > d)
            || cue.source_end_ms - cue.source_start_ms > end.saturating_sub(start)
        {
            return Err("配音分句超出源音频或镜头时长，或绑定了重复镜头；请调整分句范围".into());
        }
    }
    Ok(())
}

pub(super) fn video_filter(i: usize, w: u16, h: u16, fit: FrameFit) -> String {
    let finish = format!("setsar=1,format=yuv420p[v{i}]");
    match fit {
        FrameFit::Contain => format!("[s{i}]scale={w}:{h}:force_original_aspect_ratio=decrease:force_divisible_by=2,pad={w}:{h}:(ow-iw)/2:(oh-ih)/2,{finish}"),
        FrameFit::Cover => format!("[s{i}]scale={w}:{h}:force_original_aspect_ratio=increase:force_divisible_by=2,crop={w}:{h},{finish}"),
        FrameFit::Blur => format!("[s{i}]split=2[bg{i}][fg{i}];[bg{i}]scale={w}:{h}:force_original_aspect_ratio=increase:force_divisible_by=2,crop={w}:{h},boxblur=20:1,eq=brightness=-0.15[blur{i}];[fg{i}]scale={w}:{h}:force_original_aspect_ratio=decrease:force_divisible_by=2[front{i}];[blur{i}][front{i}]overlay=(W-w)/2:(H-h)/2,{finish}"),
    }
}

pub(super) fn voice_filters(
    draft: &Composition,
    layout: &editing::Layout,
    input: usize,
    fades: &str,
    output: &str,
) -> Vec<String> {
    if draft.voice_cues.is_empty() {
        return vec![voice_filter(
            input,
            u64::from(layout.total_ms),
            draft.voice_start_ms,
            fades,
            output,
        )];
    }
    let n = draft.voice_cues.len();
    let labels = (0..n).map(|i| format!("[speech{i}]")).collect::<String>();
    let mut filters = vec![format!("[{input}:a]asplit={n}{labels}")];
    for (i, cue) in draft.voice_cues.iter().enumerate() {
        let index = draft
            .clips
            .iter()
            .position(|c| c.version_id == cue.clip_version_id)
            .expect("validated cue");
        let start = layout.starts_ms[index] + if index > 0 { layout.overlap_ms / 2 } else { 0 };
        filters.push(format!("[speech{i}]atrim=start={:.3}:end={:.3},asetpts=PTS-STARTPTS,adelay={start}:all=1[placed{i}]",f64::from(cue.source_start_ms)/1000.0,f64::from(cue.source_end_ms)/1000.0));
    }
    let placed = (0..n).map(|i| format!("[placed{i}]")).collect::<String>();
    filters.push(format!(
        "{placed}amix=inputs={n}:duration=longest:normalize=0,apad,atrim=duration={:.3}[{output}]",
        f64::from(layout.total_ms) / 1000.0
    ));
    filters
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn legacy_framing_and_voice_defaults_and_segment_bounds() {
        let mut d:Composition=serde_json::from_value(json!({"workflowId":"w","clips":[{"versionId":"a","trimStartMs":0,"trimEndMs":4000,"caption":"Hello"}],"aspect":"9:16","resolution":720,"musicVersionId":null,"voiceVersionId":"voice","musicVolume":35,"subtitleFormat":"none","subtitleText":""})).unwrap();
        assert_eq!(d.fit, FrameFit::Contain);
        assert!(d.voice_cues.is_empty());
        d.voice_cues.push(VoiceCue {
            clip_version_id: "a".into(),
            source_start_ms: 500,
            source_end_ms: 1500,
        });
        assert!(validate_voice_cues(&d, Some(2000)).is_ok());
        assert!(
            voice_filters(&d, &editing::layout(&d).unwrap(), 1, "", "audio")
                .join(";")
                .contains("atrim=start=0.500:end=1.500")
        );
        assert!(validate_voice_cues(&d, Some(1000)).is_err());
        d.voice_cues[0].source_end_ms = 5001;
        assert!(validate_voice_cues(&d, Some(6000)).is_err());
        assert!(video_filter(0, 720, 1280, FrameFit::Blur).contains("overlay"));
        assert!(video_filter(0, 720, 1280, FrameFit::Cover).contains("crop=720:1280"));
    }
}
