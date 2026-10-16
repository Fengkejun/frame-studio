//! Model-specific official voice catalogs; never send relay credentials to documentation hosts.
use super::*;
use std::{
    collections::{BTreeMap, HashSet},
    sync::{Mutex, OnceLock},
};

const MAI_DOC: &str =
    "https://learn.microsoft.com/en-us/azure/ai-services/speech-service/mai-voices";
const OPENAI_DOC: &str = "https://developers.openai.com/api/reference/resources/audio/subresources/speech/methods/create";
const GEMINI_DOC: &str = "https://ai.google.dev/gemini-api/docs/speech-generation#voice-options";
const TTL: u64 = 15 * 60 * 1000;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeechVoice {
    pub id: String,
    pub name: String,
    pub locale: String,
    pub gender: String,
    #[serde(default)]
    pub description: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceCatalog {
    pub id: String,
    pub base_url: String,
    pub model: String,
    pub source: String,
    pub source_url: String,
    pub checked_at: String,
    pub expires_at: u64,
    pub voices: Vec<SpeechVoice>,
}
static CATALOGS: OnceLock<Mutex<BTreeMap<String, VoiceCatalog>>> = OnceLock::new();
fn catalogs() -> &'static Mutex<BTreeMap<String, VoiceCatalog>> {
    CATALOGS.get_or_init(Default::default)
}

fn mai_voices(markdown: &str) -> AppResult<Vec<SpeechVoice>> {
    let mut voices = Vec::new();
    let mut ids = HashSet::new();
    for line in markdown.lines().filter(|line| line.starts_with('|')) {
        let cells: Vec<_> = line
            .trim_matches('|')
            .split('|')
            .map(|c| c.trim().trim_matches('`'))
            .collect();
        if cells.len() != 6 || !cells[4].contains("MAI-Voice-2.1") {
            continue;
        }
        let id = cells[0];
        let locale = cells[1];
        if id.len() > 128
            || !id.starts_with(&format!("{locale}-"))
            || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
            || !ids.insert(id.to_owned())
        {
            return Err("官方音色目录格式有变化，请稍后刷新或更新应用".into());
        }
        voices.push(SpeechVoice {
            id: id.into(),
            name: id[locale.len() + 1..].into(),
            locale: locale.into(),
            gender: cells[3].into(),
            description: String::new(),
        });
    }
    if voices.is_empty() || voices.len() > 500 {
        return Err("官方音色目录为空或格式有变化，尚未提交配音".into());
    }
    voices.sort_by_key(|v| {
        (
            !v.locale.starts_with("zh"),
            v.locale.clone(),
            v.name.clone(),
        )
    });
    Ok(voices)
}

fn openai_voices(model: &str) -> AppResult<Vec<SpeechVoice>> {
    let names: &[&str] = if matches!(model, "tts-1" | "tts-1-hd") {
        &["alloy", "echo", "fable", "onyx", "nova", "shimmer"]
    } else if model == "gpt-4o-mini-tts" || model == "gpt-4o-mini-tts-2025-12-15" {
        &[
            "alloy", "ash", "ballad", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer",
            "verse", "marin", "cedar",
        ]
    } else {
        return Err("尚未接入此模型的官方音色目录，请选择已适配模型".into());
    };
    Ok(names
        .iter()
        .map(|id| SpeechVoice {
            id: (*id).into(),
            name: (*id).into(),
            locale: "multilingual".into(),
            gender: String::new(),
            description: String::new(),
        })
        .collect())
}

fn gemini_voices() -> Vec<SpeechVoice> {
    // Official featured voices, checked 2026-10-16. Labels translate Google's traits,
    // not relay-specific personas or guessed gender assignments.
    [
        ("Zephyr", "明亮"),
        ("Puck", "欢快"),
        ("Charon", "讲解感"),
        ("Kore", "坚定"),
        ("Fenrir", "兴奋"),
        ("Leda", "年轻感"),
        ("Orus", "坚定"),
        ("Aoede", "轻快"),
        ("Callirrhoe", "随和"),
        ("Autonoe", "明亮"),
        ("Enceladus", "气声"),
        ("Iapetus", "清晰"),
        ("Umbriel", "随和"),
        ("Algieba", "顺滑"),
        ("Despina", "顺滑"),
        ("Erinome", "清晰"),
        ("Algenib", "沙哑"),
        ("Rasalgethi", "讲解感"),
        ("Laomedeia", "欢快"),
        ("Achernar", "柔和"),
        ("Alnilam", "坚定"),
        ("Schedar", "平稳"),
        ("Gacrux", "成熟感"),
        ("Pulcherrima", "直率"),
        ("Achird", "亲切"),
        ("Zubenelgenubi", "随性"),
        ("Vindemiatrix", "温柔"),
        ("Sadachbia", "活泼"),
        ("Sadaltager", "知性感"),
        ("Sulafat", "温暖"),
    ]
    .into_iter()
    .map(|(id, description)| SpeechVoice {
        id: id.into(),
        name: id.into(),
        locale: "multilingual".into(),
        gender: String::new(),
        description: description.into(),
    })
    .collect()
}

#[tauri::command]
pub async fn list_speech_voices(base_url: String, model: String) -> AppResult<VoiceCatalog> {
    let base_url = cloud::api_base(&base_url)?
        .to_string()
        .trim_end_matches('/')
        .to_owned();
    let (voices, source, source_url, checked_at) =
        if matches!(model.as_str(), "mai-voice-2.1" | "mai-voice-2.1-flash") {
            let fixture = if cfg!(debug_assertions) {
                std::env::var_os("FRAME_STUDIO_TEST_DATA_DIR")
                    .map(|p| std::path::PathBuf::from(p).join("mai-voices.md"))
            } else {
                None
            };
            let text = if let Some(path) = fixture {
                std::fs::read_to_string(path).map_err(|_| "测试音色目录缺失")?
            } else {
                let client = Client::builder()
                    .redirect(reqwest::redirect::Policy::none())
                    .connect_timeout(Duration::from_secs(10))
                    .timeout(Duration::from_secs(25))
                    .build()
                    .map_err(|_| "创建官方目录连接失败")?;
                let mut response = client
                    .get(format!("{MAI_DOC}?accept=text/markdown"))
                    .send()
                    .await
                    .map_err(|_| "读取微软官方音色目录失败，请检查网络后刷新；尚未提交配音")?;
                if !response.status().is_success() {
                    return Err(format!(
                        "官方音色目录返回 HTTP {}，请稍后刷新；尚未提交配音",
                        response.status().as_u16()
                    ));
                }
                let mut bytes = Vec::new();
                while let Some(chunk) = response
                    .chunk()
                    .await
                    .map_err(|_| "官方音色目录读取中断，请刷新")?
                {
                    if bytes.len() + chunk.len() > 512 * 1024 {
                        return Err("官方音色目录响应超过限制".into());
                    }
                    bytes.extend_from_slice(&chunk);
                }
                String::from_utf8(bytes).map_err(|_| "官方音色目录编码无效")?
            };
            (
                mai_voices(&text)?,
                "official_live",
                MAI_DOC,
                now().to_string(),
            )
        } else if matches!(
            model.as_str(),
            "gemini-3.8-flash-lite-tts" | "gemini-3.8-flash-tts"
        ) {
            (
                gemini_voices(),
                "official_documentation_snapshot",
                GEMINI_DOC,
                "2026-10-16".into(),
            )
        } else {
            (
                openai_voices(&model)?,
                "official_documentation_snapshot",
                OPENAI_DOC,
                "2026-10-16".into(),
            )
        };
    let catalog = VoiceCatalog {
        id: uid(),
        base_url,
        model,
        source: source.into(),
        source_url: source_url.into(),
        checked_at,
        expires_at: now() + TTL,
        voices,
    };
    let mut values = catalogs().lock().map_err(|_| "音色目录锁不可用")?;
    values.retain(|_, value| value.expires_at > now());
    if values.len() >= 100 {
        values.clear();
    }
    values.insert(catalog.id.clone(), catalog.clone());
    Ok(catalog)
}

pub(super) fn validate_selection(request: &SpeechRequest) -> AppResult<()> {
    let values = catalogs().lock().map_err(|_| "音色目录锁不可用")?;
    let catalog = request
        .voice_catalog_id
        .as_ref()
        .and_then(|id| values.get(id))
        .ok_or("请先获取当前模型的音色列表，再选择音色生成配音")?;
    let base = cloud::api_base(&request.base_url)?.to_string();
    if catalog.expires_at <= now()
        || catalog.base_url != base.trim_end_matches('/')
        || catalog.model != request.model
        || !catalog.voices.iter().any(|v| v.id == request.voice)
    {
        return Err("音色不在当前模型目录中，或目录已过期；请刷新音色列表并重新选择".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn gemini_has_distinct_official_names_and_traits() {
        let voices = gemini_voices();
        assert_eq!(voices.len(), 30);
        assert_eq!(
            voices.iter().map(|v| &v.id).collect::<HashSet<_>>().len(),
            30
        );
        assert_eq!(
            voices.iter().find(|v| v.id == "Kore").unwrap().description,
            "坚定"
        );
        assert!(!voices.iter().any(|v| v.id == "alloy"));
    }
    #[test]
    fn parses_official_mai_table_without_openai_or_azure_neural_mixups() {
        let text="| Voice ID | Locale | Language | Gender | Supported models | Supported styles |\n| `zh-CN-Harper` | `zh-CN` | Chinese | Female | `MAI-Voice-2.1`, `MAI-Voice-2.1-Flash` | `neutral` |\n| `en-US-Harper` | `en-US` | English | Female | `MAI-Voice-2.1` | `neutral` |";
        let voices = mai_voices(text).unwrap();
        assert_eq!(voices.len(), 2);
        assert_eq!(voices[0].id, "zh-CN-Harper");
        assert!(mai_voices("<html>blocked</html>").is_err());
        assert!(!openai_voices("gpt-4o-mini-tts")
            .unwrap()
            .iter()
            .any(|v| v.id == "en-US-Harper"));
        assert!(openai_voices("unknown").is_err());
    }
    #[test]
    fn submission_requires_fresh_catalog_for_this_service_model_and_voice() {
        let mut request = super::super::tests::request();
        assert!(validate_selection(&request).is_err());
        let id = uid();
        let catalog = VoiceCatalog {
            id: id.clone(),
            base_url: request.base_url.clone(),
            model: request.model.clone(),
            source: "test".into(),
            source_url: String::new(),
            checked_at: String::new(),
            expires_at: now() + TTL,
            voices: openai_voices(&request.model).unwrap(),
        };
        catalogs().lock().unwrap().insert(id.clone(), catalog);
        request.voice_catalog_id = Some(id.clone());
        assert!(validate_selection(&request).is_ok());
        request.voice = "en-US-Harper".into();
        assert!(validate_selection(&request).is_err());
        request.voice = "coral".into();
        request.model = "mai-voice-2.1".into();
        assert!(validate_selection(&request).is_err());
        request.model = "gpt-4o-mini-tts".into();
        request.base_url = "https://other.example/v1".into();
        assert!(validate_selection(&request).is_err());
        request.base_url = "http://127.0.0.1:8188/v1".into();
        catalogs().lock().unwrap().get_mut(&id).unwrap().expires_at = 0;
        assert!(validate_selection(&request).is_err());
    }
}
