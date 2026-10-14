//! Actual video stream information, independent of provider request parameters.
use super::composition::binary;
use crate::workflow::types::AppResult;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{path::Path, process::Stdio, time::Duration};

#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VideoMetadata {
    pub duration_ms: u32,
    pub width: u32,
    pub height: u32,
    pub fps: f64,
    pub codec: String,
}

fn parse(value: &Value) -> AppResult<VideoMetadata> {
    let stream = value["streams"]
        .as_array()
        .and_then(|s| s.first())
        .ok_or("文件没有有效视频流")?;
    let duration = stream["duration"]
        .as_str()
        .and_then(|v| v.parse::<f64>().ok())
        .filter(|v| v.is_finite() && *v > 0.0)
        .or_else(|| {
            value["format"]["duration"]
                .as_str()
                .and_then(|v| v.parse().ok())
        })
        .ok_or("视频时长读取失败")?;
    let width = stream["width"].as_u64().unwrap_or(0);
    let height = stream["height"].as_u64().unwrap_or(0);
    let (numerator, denominator) = stream["avg_frame_rate"]
        .as_str()
        .and_then(|v| v.split_once('/'))
        .unwrap_or(("0", "1"));
    let fps = numerator.parse::<f64>().unwrap_or(0.0) / denominator.parse::<f64>().unwrap_or(0.0);
    if !duration.is_finite()
        || !(0.1..=3600.0).contains(&duration)
        || !(1..=8192).contains(&width)
        || !(1..=8192).contains(&height)
        || !fps.is_finite()
        || !(0.0..=1000.0).contains(&fps)
    {
        return Err("视频信息无效：时长须为 0.1 秒–1 小时，宽高不超过 8192".into());
    }
    let codec = stream["codec_name"]
        .as_str()
        .filter(|s| !s.is_empty() && s.len() <= 64)
        .ok_or("视频编码信息无效")?;
    Ok(VideoMetadata {
        duration_ms: (duration * 1000.0).round() as u32,
        width: width as u32,
        height: height as u32,
        fps,
        codec: codec.into(),
    })
}

pub async fn probe(path: &Path) -> AppResult<VideoMetadata> {
    let mut command = tokio::process::Command::new(binary("ffprobe"));
    command
        .args([
            "-v",
            "error",
            "-protocol_whitelist",
            "file,pipe",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=codec_name,width,height,duration,avg_frame_rate:format=duration",
            "-of",
            "json",
            "-i",
        ])
        .arg(path)
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let output = tokio::time::timeout(Duration::from_secs(20), command.output())
        .await
        .map_err(|_| "读取视频信息超时")?
        .map_err(|_| "未找到 FFprobe，请使用包含媒体工具的安装包")?;
    if !output.status.success() || output.stdout.len() > 64 * 1024 {
        return Err("视频文件损坏或没有可读取的视频流".into());
    }
    parse(&serde_json::from_slice(&output.stdout).map_err(|_| "视频信息格式无效")?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn uses_video_duration_and_rejects_audio_only_or_invalid_streams() {
        let mut data = json!({"streams":[{"codec_name":"h264", "width":1920,"height":1080,
            "duration":"1.234", "avg_frame_rate":"30000/1001"}], "format":{"duration":"5.0"}});
        let video = parse(&data).unwrap();
        assert_eq!(video.duration_ms, 1234);
        assert!((video.fps - 29.97).abs() < 0.01);
        let output = json!({"storyboardArtifactId":"storyboard", "clips":[{
            "shotId":"shot", "assetId":"asset", "versionId":"version",
            "firstFrameVersionId":"frame", "duration":1.234, "resolution":"1920x1080"}]});
        assert!(crate::workflow::types::validate_output(
            &crate::workflow::types::NodeKind::Video,
            &output
        )
        .is_ok());
        data["streams"][0]["duration"] = json!("N/A");
        assert_eq!(parse(&data).unwrap().duration_ms, 5000);
        data["streams"][0]["width"] = json!(0);
        assert!(parse(&data).is_err());
        assert!(parse(&json!({"streams":[],"format":{"duration":"1"}})).is_err());
    }
}
