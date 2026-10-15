//! Built-in model capabilities shared verbatim with the frontend. Protocols are
//! implemented in code; listing a model never grants it an arbitrary endpoint.
use super::*;
use std::{
    collections::{HashMap, HashSet},
    sync::OnceLock,
};

#[derive(Clone, Copy, Deserialize, PartialEq, Debug)]
#[serde(rename_all = "kebab-case")]
pub enum Protocol {
    Wan,
    RelayContentV2,
    RelayVideosV1,
}
impl Protocol {
    fn supports_mode(self, mode: Mode) -> bool {
        match self {
            Self::Wan => mode == Mode::Frame,
            Self::RelayContentV2 => mode == Mode::Text,
            Self::RelayVideosV1 => true,
        }
    }
}

#[derive(Clone, Copy, Default, Serialize, Deserialize, PartialEq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    #[default]
    Text,
    Frame,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DurationRange {
    pub min: u8,
    pub max: u8,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Model {
    pub id: String,
    pub name: String,
    pub aliases: Vec<String>,
    pub protocol: Protocol,
    pub modes: Vec<Mode>,
    pub default_mode: Mode,
    pub duration: DurationRange,
    pub resolutions: Vec<String>,
    pub default_resolution: String,
    pub ratios: Vec<String>,
    pub frame_sizes: HashMap<String, [u32; 2]>,
}
impl Model {
    pub fn validate(
        &self,
        duration: u8,
        resolution: &str,
        mode: Mode,
        ratio: Option<&str>,
    ) -> AppResult<()> {
        if !(self.duration.min..=self.duration.max).contains(&duration)
            || !self.resolutions.iter().any(|r| r == resolution)
            || !self.modes.contains(&mode)
            || ratio.is_some_and(|r| !self.ratios.iter().any(|v| v == r))
        {
            return Err(format!(
                "请检查 {} 的生成方式、时长、分辨率和比例",
                self.name
            ));
        }
        Ok(())
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Catalog {
    schema_version: u8,
    default_wan_model: String,
    default_relay_model: String,
    models: Vec<Model>,
}
const SOURCE: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../src/shared/video-models.json"
));

fn parse(source: &str) -> AppResult<Catalog> {
    let catalog: Catalog = serde_json::from_str(source).map_err(|_| "视频模型能力配置格式无效")?;
    let mut ids = HashSet::new();
    if catalog.schema_version != 1 || catalog.models.is_empty() {
        return Err("视频模型能力配置版本无效".into());
    }
    for model in &catalog.models {
        for id in std::iter::once(&model.id).chain(&model.aliases) {
            if id.is_empty() || !ids.insert(id) {
                return Err("视频模型 ID 或别名重复".into());
            }
        }
        if model.name.is_empty()
            || model.duration.min == 0
            || model.duration.min > model.duration.max
            || !model.modes.contains(&model.default_mode)
            || model
                .modes
                .iter()
                .any(|m| !model.protocol.supports_mode(*m))
            || (model.protocol != Protocol::RelayContentV2 && !model.ratios.is_empty())
            || !model.resolutions.contains(&model.default_resolution)
            || model.resolutions.is_empty()
            || model.frame_sizes.iter().any(|(r, size)| {
                !model.resolutions.contains(r) || size.iter().any(|n| !(1..=8000).contains(n))
            })
            || (model.protocol == Protocol::RelayVideosV1
                && model.modes.contains(&Mode::Frame)
                && model
                    .resolutions
                    .iter()
                    .any(|r| !model.frame_sizes.contains_key(r)))
        {
            return Err("视频模型能力配置不完整".into());
        }
    }
    let wan = catalog
        .models
        .iter()
        .find(|m| m.id == catalog.default_wan_model);
    let relay = catalog
        .models
        .iter()
        .find(|m| m.id == catalog.default_relay_model);
    if !wan.is_some_and(|m| m.protocol == Protocol::Wan)
        || !relay.is_some_and(|m| m.protocol != Protocol::Wan)
    {
        return Err("默认视频模型配置无效".into());
    }
    Ok(catalog)
}
fn catalog() -> AppResult<&'static Catalog> {
    static CATALOG: OnceLock<AppResult<Catalog>> = OnceLock::new();
    CATALOG
        .get_or_init(|| parse(SOURCE))
        .as_ref()
        .map_err(Clone::clone)
}
pub fn find(id: &str) -> AppResult<&'static Model> {
    catalog()?
        .models
        .iter()
        .find(|m| m.id == id || m.aliases.iter().any(|a| a == id))
        .ok_or_else(|| "视频模型尚未适配，请选择已支持的模型".into())
}
pub fn wan() -> AppResult<&'static Model> {
    find(&catalog()?.default_wan_model)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn shared_catalog_is_complete_and_aliases_preserve_old_requests() {
        let catalog = parse(SOURCE).unwrap();
        assert_eq!(find("MiniMax-H3").unwrap().id, "minimax-h3");
        assert!(find("person-substitution").is_err());
        assert!(find("unlisted-model").is_err());
        assert_eq!(wan().unwrap().protocol, Protocol::Wan);
        for m in &catalog.models {
            assert!(m
                .validate(m.duration.min, &m.default_resolution, m.default_mode, None)
                .is_ok());
            assert!(m
                .validate(
                    m.duration.min - 1,
                    &m.default_resolution,
                    m.default_mode,
                    None
                )
                .is_err());
            assert!(m
                .validate(
                    m.duration.max + 1,
                    &m.default_resolution,
                    m.default_mode,
                    None
                )
                .is_err());
        }
    }
    #[test]
    fn invalid_capabilities_are_rejected_instead_of_silently_using_another_protocol() {
        let mut value: Value = serde_json::from_str(SOURCE).unwrap();
        value["models"][1]["id"] = value["models"][0]["id"].clone();
        assert!(parse(&value.to_string()).is_err());
        let mut value: Value = serde_json::from_str(SOURCE).unwrap();
        value["models"][2]["frameSizes"] = json!({});
        assert!(parse(&value.to_string()).is_err());
        let mut value: Value = serde_json::from_str(SOURCE).unwrap();
        value["models"][2]["protocol"] = json!("unimplemented-protocol");
        assert!(parse(&value.to_string()).is_err());
        let mut value: Value = serde_json::from_str(SOURCE).unwrap();
        value["models"][1]["modes"] = json!(["frame"]);
        value["models"][1]["defaultMode"] = json!("frame");
        assert!(parse(&value.to_string()).is_err());
    }
}
