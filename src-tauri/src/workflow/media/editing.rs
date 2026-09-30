//! Timeline timing shared by rendering, captions and exported node metadata.
use super::{composition::Composition, *};

#[derive(Clone, Copy, Default, Serialize, Deserialize, PartialEq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Transition {
    #[default]
    None,
    Fade,
    Fadeblack,
}

#[derive(Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TimelineEffects {
    pub transition: Transition,
    pub transition_duration_ms: u32,
    pub music_fade_in_ms: u32,
    pub music_fade_out_ms: u32,
    pub voice_fade_in_ms: u32,
    pub voice_fade_out_ms: u32,
}

impl Default for TimelineEffects {
    fn default() -> Self {
        Self {
            transition: Transition::None,
            transition_duration_ms: 300,
            music_fade_in_ms: 0,
            music_fade_out_ms: 0,
            voice_fade_in_ms: 0,
            voice_fade_out_ms: 0,
        }
    }
}

pub struct Layout {
    pub starts_ms: Vec<u32>,
    pub total_ms: u32,
    pub overlap_ms: u32,
}

pub fn validate_effects(effects: &TimelineEffects) -> AppResult<()> {
    if effects.transition_duration_ms > 2000
        || (effects.transition != Transition::None && effects.transition_duration_ms < 100)
        || [
            effects.music_fade_in_ms,
            effects.music_fade_out_ms,
            effects.voice_fade_in_ms,
            effects.voice_fade_out_ms,
        ]
        .iter()
        .any(|ms| *ms > 10_000)
    {
        return Err("转场须为 0.1–2 秒，音频淡入淡出分别最多 10 秒".into());
    }
    Ok(())
}

pub fn layout(draft: &Composition) -> AppResult<Layout> {
    validate_effects(&draft.effects)?;
    let overlap_ms = if draft.clips.len() > 1 && draft.effects.transition != Transition::None {
        draft.effects.transition_duration_ms
    } else {
        0
    };
    let mut total_ms = 0u32;
    let mut starts_ms = Vec::new();
    for (index, clip) in draft.clips.iter().enumerate() {
        let duration = clip
            .trim_end_ms
            .checked_sub(clip.trim_start_ms)
            .filter(|ms| *ms > 0)
            .ok_or("片段裁剪时间无效")?;
        if overlap_ms > duration / 2 {
            return Err("转场时长须不超过任一片段时长的一半".into());
        }
        if index > 0 {
            total_ms -= overlap_ms;
        }
        starts_ms.push(total_ms);
        total_ms = total_ms.checked_add(duration).ok_or("时间线时长超出范围")?;
    }
    Ok(Layout {
        starts_ms,
        total_ms,
        overlap_ms,
    })
}

pub fn validate_audio(
    draft: &Composition,
    total_ms: u32,
    voice_duration_ms: Option<u32>,
) -> AppResult<()> {
    let effects = &draft.effects;
    if draft.music_version_id.is_some()
        && effects.music_fade_in_ms + effects.music_fade_out_ms > total_ms
    {
        return Err("音乐淡入与淡出总时长须不超过成片时长".into());
    }
    if let Some(duration) = voice_duration_ms {
        let audible = total_ms
            .checked_sub(draft.voice_start_ms)
            .filter(|ms| *ms > 0)
            .ok_or("配音起点须早于成片结束时间；请调整起点或延长时间线")?
            .min(duration);
        if effects.voice_fade_in_ms + effects.voice_fade_out_ms > audible {
            return Err("配音淡入与淡出总时长须不超过成片中实际播放的配音时长".into());
        }
    }
    Ok(())
}

pub fn fades(start_ms: u32, length_ms: u32, fade_in_ms: u32, fade_out_ms: u32) -> String {
    let mut result = String::new();
    if fade_in_ms > 0 {
        result.push_str(&format!(
            ",afade=t=in:st={:.3}:d={:.3}:curve=tri",
            f64::from(start_ms) / 1000.0,
            f64::from(fade_in_ms) / 1000.0
        ));
    }
    if fade_out_ms > 0 {
        result.push_str(&format!(
            ",afade=t=out:st={:.3}:d={:.3}:curve=tri",
            f64::from(start_ms + length_ms - fade_out_ms) / 1000.0,
            f64::from(fade_out_ms) / 1000.0
        ));
    }
    result
}

pub fn video_join(draft: &Composition, layout: &Layout) -> Vec<String> {
    if layout.overlap_ms == 0 {
        let labels = (0..draft.clips.len())
            .map(|i| format!("[v{i}]"))
            .collect::<String>();
        return vec![format!(
            "{labels}concat=n={}:v=1:a=0[joined]",
            draft.clips.len()
        )];
    }
    let kind = match draft.effects.transition {
        Transition::Fadeblack => "fadeblack",
        _ => "fade",
    };
    (1..draft.clips.len())
        .map(|i| {
            let left = if i == 1 {
                "v0".into()
            } else {
                format!("join{}", i - 1)
            };
            let output = if i == draft.clips.len() - 1 {
                "joined".into()
            } else {
                format!("join{i}")
            };
            format!(
                "[{left}][v{i}]xfade=transition={kind}:duration={:.3}:offset={:.3}[{output}]",
                f64::from(layout.overlap_ms) / 1000.0,
                f64::from(layout.starts_ms[i]) / 1000.0
            )
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    fn draft() -> Composition {
        serde_json::from_value(serde_json::json!({"workflowId":"w", "clips":[{"versionId":"a","trimStartMs":100,"trimEndMs":1100,"caption":"One"},{"versionId":"b","trimStartMs":0,"trimEndMs":1000,"caption":"Two"},{"versionId":"c","trimStartMs":0,"trimEndMs":1000,"caption":"Three"}], "aspect":"1:1", "resolution":720, "musicVersionId":null, "voiceVersionId":null, "musicVolume":35, "subtitleFormat":"none", "subtitleText":""})).unwrap()
    }
    #[test]
    fn overlaps_compact_three_clip_timing_and_single_clips_stay_unchanged() {
        let mut d = draft();
        assert_eq!(layout(&d).unwrap().total_ms, 3000);
        assert_eq!(d.effects.transition, Transition::None);
        d.effects.transition = Transition::Fade;
        let l = layout(&d).unwrap();
        assert_eq!(l.total_ms, 2400);
        assert_eq!(l.starts_ms, vec![0, 700, 1400]);
        let filters = video_join(&d, &l);
        assert!(filters[0].contains("offset=0.700[join1]"));
        assert!(filters[1].contains("[join1][v2]"));
        assert!(filters[1].contains("offset=1.400[joined]"));
        d.effects.transition_duration_ms = 501;
        assert!(layout(&d).is_err());
        d.clips.truncate(1);
        assert_eq!(layout(&d).unwrap().total_ms, 1000);
        let mut invalid = serde_json::to_value(&d).unwrap();
        invalid["effects"]["transition"] = serde_json::json!("arbitrary-filter");
        assert!(serde_json::from_value::<Composition>(invalid).is_err());
    }
    #[test]
    fn audio_fades_use_audible_voice_end_and_reject_overlaps() {
        let mut d = draft();
        d.voice_version_id = Some("voice".into());
        d.voice_start_ms = 200;
        d.effects.voice_fade_in_ms = 100;
        d.effects.voice_fade_out_ms = 100;
        assert!(validate_audio(&d, 2000, Some(700)).is_ok());
        assert_eq!(
            fades(200, 700, 100, 100),
            ",afade=t=in:st=0.200:d=0.100:curve=tri,afade=t=out:st=0.800:d=0.100:curve=tri"
        );
        d.effects.voice_fade_out_ms = 601;
        assert!(validate_audio(&d, 2000, Some(700)).is_err());
        d.effects.voice_fade_out_ms = 0;
        d.voice_start_ms = 2000;
        assert!(validate_audio(&d, 2000, Some(700)).is_err());
        d.music_version_id = Some("music".into());
        d.effects.music_fade_out_ms = 2001;
        assert!(validate_audio(&d, 2000, None).is_err());
        d.effects.music_fade_out_ms = 10001;
        assert!(validate_effects(&d.effects).is_err());
        assert_eq!(fades(0, 700, 0, 0), "");
    }
}
