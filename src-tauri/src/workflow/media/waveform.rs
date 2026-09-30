//! Bounded, local waveform envelopes derived from immutable audio versions.
use super::{
    composition::{audio, binary, MAX_AUDIO_BYTES},
    *,
};
use std::{process::Stdio, time::Duration};
use tokio::io::AsyncReadExt;

const RATE: usize = 8000;
const BINS: usize = 512;
static ANALYSES: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(2);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioWaveform {
    version_id: String,
    duration_ms: u32,
    peaks: Vec<f32>,
}

struct Envelope {
    peaks: Vec<f32>,
    expected_samples: usize,
    samples: usize,
    pending: Option<u8>,
}

impl Envelope {
    fn new(duration_ms: u32) -> Self {
        Self {
            peaks: vec![0.0; BINS],
            expected_samples: (duration_ms as usize * RATE / 1000).max(1),
            samples: 0,
            pending: None,
        }
    }
    fn consume(&mut self, bytes: &[u8]) -> AppResult<()> {
        for &byte in bytes {
            if let Some(first) = self.pending.take() {
                if self.samples >= 3601 * RATE {
                    return Err("波形解码超过时长限制".into());
                }
                let value = f32::from(i16::from_le_bytes([first, byte])).abs() / 32768.0;
                let index = (self.samples * BINS / self.expected_samples).min(BINS - 1);
                self.peaks[index] = self.peaks[index].max(value);
                self.samples += 1;
            } else {
                self.pending = Some(byte);
            }
        }
        Ok(())
    }
}

#[tauri::command]
pub async fn get_audio_waveform(
    state: tauri::State<'_, WorkflowState>,
    version_id: String,
) -> AppResult<AudioWaveform> {
    let _permit = ANALYSES
        .try_acquire()
        .map_err(|_| "正在分析其他音频，请稍后重试")?;
    let source = audio(&state, &version_id)?;
    if source.duration_ms == 0 || source.duration_ms > 3_600_000 {
        return Err("音频时长超过波形分析限制".into());
    }
    let path = state.directory.join("assets").join(&source.file_name);
    let metadata = tokio::fs::metadata(&path)
        .await
        .map_err(|_| "音频原文件已丢失")?;
    if metadata.len() > MAX_AUDIO_BYTES as u64 {
        return Err("音频超过波形分析大小限制".into());
    }
    let mut command = tokio::process::Command::new(binary("ffmpeg"));
    command
        .args(["-v", "error", "-nostdin", "-i"])
        .arg(path)
        .args(["-map", "0:a:0", "-vn", "-ac", "1", "-ar", "8000", "-t"])
        .arg(format!("{:.3}", f64::from(source.duration_ms) / 1000.0))
        .args(["-c:a", "pcm_s16le", "-f", "s16le", "pipe:1"])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let mut child = command
        .spawn()
        .map_err(|_| "请安装 FFmpeg 或使用包含它的安装包")?;
    let mut output = child.stdout.take().ok_or("读取波形数据失败")?;
    let result = tokio::time::timeout(Duration::from_secs(30), async {
        let mut envelope = Envelope::new(source.duration_ms);
        let mut buffer = [0u8; 8192];
        loop {
            let size = output.read(&mut buffer).await.map_err(|_| "波形解码中断")?;
            if size == 0 {
                break;
            }
            envelope.consume(&buffer[..size])?;
        }
        let status = child.wait().await.map_err(|_| "波形分析进程中断")?;
        if !status.success() || envelope.samples == 0 || envelope.pending.is_some() {
            return Err("音频解码失败，请检查原文件或 FFmpeg".into());
        }
        Ok(AudioWaveform {
            version_id,
            duration_ms: source.duration_ms,
            peaks: envelope.peaks,
        })
    })
    .await
    .map_err(|_| "波形分析超时，请稍后重试")?;
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn streaming_pcm_keeps_silence_peaks_and_split_sample_boundaries() {
        let mut envelope = Envelope::new(1000);
        let bytes: Vec<u8> = (0..RATE)
            .flat_map(|i| if i < RATE / 2 { 0i16 } else { -16384i16 }.to_le_bytes())
            .collect();
        for part in bytes.chunks(7) {
            envelope.consume(part).unwrap();
        }
        assert_eq!(envelope.samples, RATE);
        assert_eq!(envelope.peaks.len(), BINS);
        assert!(envelope.peaks[..BINS / 2].iter().all(|x| *x == 0.0));
        assert!(envelope.peaks[BINS / 2..].iter().all(|x| *x == 0.5));
        assert!(envelope.pending.is_none());
    }
}
