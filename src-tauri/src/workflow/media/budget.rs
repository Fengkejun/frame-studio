//! Local planning limits for billable media submissions. These are estimates,
//! not provider billing records or a provider-enforced spending cap.
use super::*;
use rusqlite::{Connection, OptionalExtension};

const MAX_BUDGET_MICRO_USD: u64 = 1_000_000_000_000;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaBudget {
    pub limit_micro_usd: Option<u64>,
    pub reserved_micro_usd: u64,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BudgetSetting {
    limit_micro_usd: Option<u64>,
}

pub enum BillableJob {
    CloudImage,
    Video,
    Speech,
}

fn setting_id(workflow_id: &str) -> String {
    format!("budget:{workflow_id}")
}

fn exists(db: &Connection, workflow_id: &str) -> AppResult<()> {
    let found: bool = db
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM workflows WHERE id=?1)",
            [workflow_id],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    if found {
        Ok(())
    } else {
        Err("工作流不存在，请先保存".into())
    }
}

fn read(db: &Connection, workflow_id: &str) -> AppResult<MediaBudget> {
    exists(db, workflow_id)?;
    let json: Option<String> = db
        .query_row(
            "SELECT json FROM media_settings WHERE id=?1",
            [setting_id(workflow_id)],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let limit_micro_usd = json
        .map(|value| {
            serde_json::from_str::<BudgetSetting>(&value).map(|setting| setting.limit_micro_usd)
        })
        .transpose()
        .map_err(|_| "项目预算设置已损坏")?
        .flatten();
    let mut reserved_micro_usd = 0_u64;
    for table in ["cloud_image_jobs", "video_jobs", "speech_jobs"] {
        let sql = format!(
            "SELECT COALESCE(SUM(COALESCE(json_extract(json, '$.estimatedCostMicroUsd'), 0)), 0) FROM {table} WHERE workflow_id=?1"
        );
        let amount: i64 = db
            .query_row(&sql, [workflow_id], |row| row.get(0))
            .map_err(|e| e.to_string())?;
        reserved_micro_usd = reserved_micro_usd
            .checked_add(u64::try_from(amount).map_err(|_| "预算记录金额无效")?)
            .ok_or("预算记录金额溢出")?;
    }
    Ok(MediaBudget {
        limit_micro_usd,
        reserved_micro_usd,
    })
}

#[tauri::command]
pub fn get_media_budget(
    state: tauri::State<WorkflowState>,
    workflow_id: String,
) -> AppResult<MediaBudget> {
    let db = state.store.db()?;
    read(&db, &workflow_id)
}

#[tauri::command]
pub fn set_media_budget(
    state: tauri::State<WorkflowState>,
    workflow_id: String,
    limit_micro_usd: Option<u64>,
) -> AppResult<MediaBudget> {
    if limit_micro_usd.is_some_and(|limit| limit > MAX_BUDGET_MICRO_USD) {
        return Err("项目预算上限过大".into());
    }
    let db = state.store.db()?;
    exists(&db, &workflow_id)?;
    db.execute(
        "INSERT INTO media_settings(id,json) VALUES (?1,?2) ON CONFLICT(id) DO UPDATE SET json=excluded.json",
        params![setting_id(&workflow_id), serde_json::to_string(&BudgetSetting { limit_micro_usd }).map_err(|e| e.to_string())?],
    ).map_err(|e| e.to_string())?;
    read(&db, &workflow_id)
}

pub fn reserve_job<T: Serialize>(
    state: &WorkflowState,
    kind: BillableJob,
    workflow_id: &str,
    id: &str,
    created_at: u64,
    estimated_cost_micro_usd: u64,
    job: &T,
) -> AppResult<()> {
    let db = state.store.db()?;
    reserve_in_db(
        &db,
        kind,
        workflow_id,
        id,
        created_at,
        estimated_cost_micro_usd,
        job,
    )
}

fn reserve_in_db<T: Serialize>(
    db: &Connection,
    kind: BillableJob,
    workflow_id: &str,
    id: &str,
    created_at: u64,
    estimated_cost_micro_usd: u64,
    job: &T,
) -> AppResult<()> {
    if estimated_cost_micro_usd == 0 || estimated_cost_micro_usd > MAX_BUDGET_MICRO_USD {
        return Err("本次预算预留金额无效".into());
    }
    let budget = read(db, workflow_id)?;
    let next = budget
        .reserved_micro_usd
        .checked_add(estimated_cost_micro_usd)
        .ok_or("预算记录金额溢出")?;
    if budget.limit_micro_usd.is_some_and(|limit| next > limit) {
        return Err("本次提交会超过项目预算上限；请调整预算或生成参数".into());
    }
    let sql = match kind {
        BillableJob::CloudImage => "INSERT INTO cloud_image_jobs VALUES (?1,?2,?3,?4)",
        BillableJob::Video => "INSERT INTO video_jobs VALUES (?1,?2,?3,?4)",
        BillableJob::Speech => "INSERT INTO speech_jobs VALUES (?1,?2,?3,?4)",
    };
    db.execute(
        sql,
        params![
            id,
            workflow_id,
            serde_json::to_string(job).map_err(|e| e.to_string())?,
            created_at
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn video_estimate_micro_usd(region: &str, duration: u8, resolution: &str) -> AppResult<u64> {
    // Public Model Studio price table for wan2.7-i2v-2026-04-25, checked 2026-09-28.
    // Keep the UI preview rates in mediaApi.ts in sync with this guard.
    let per_second = match (region, resolution) {
        ("beijing", "720P") => 86_012,
        ("beijing", "1080P") => 143_353,
        ("singapore", "720P") => 100_000,
        ("singapore", "1080P") => 150_000,
        _ => return Err("视频地区或分辨率无效".into()),
    };
    if !(2..=15).contains(&duration) {
        return Err("视频时长无效".into());
    }
    Ok(per_second * u64::from(duration))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn video_tariffs_match_snapshot_and_duration() {
        assert_eq!(
            video_estimate_micro_usd("beijing", 5, "720P").unwrap(),
            430_060
        );
        assert_eq!(
            video_estimate_micro_usd("singapore", 5, "1080P").unwrap(),
            750_000
        );
        assert!(video_estimate_micro_usd("singapore", 16, "720P").is_err());
    }

    #[test]
    fn budget_counts_all_media_types_and_blocks_before_insertion() {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch(
            "CREATE TABLE workflows(id TEXT PRIMARY KEY);
             CREATE TABLE media_settings(id TEXT PRIMARY KEY, json TEXT NOT NULL);
             CREATE TABLE cloud_image_jobs(id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL, json TEXT NOT NULL, created_at INTEGER NOT NULL);
             CREATE TABLE video_jobs(id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL, json TEXT NOT NULL, created_at INTEGER NOT NULL);
             CREATE TABLE speech_jobs(id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL, json TEXT NOT NULL, created_at INTEGER NOT NULL);
             INSERT INTO workflows VALUES ('project');
             INSERT INTO media_settings VALUES ('budget:project', '{\"limitMicroUsd\":700000}');",
        ).unwrap();
        let image = serde_json::json!({"estimatedCostMicroUsd":250000});
        reserve_in_db(
            &db,
            BillableJob::CloudImage,
            "project",
            "image",
            1,
            250_000,
            &image,
        )
        .unwrap();
        let video = serde_json::json!({"estimatedCostMicroUsd":430060});
        reserve_in_db(
            &db,
            BillableJob::Video,
            "project",
            "video",
            2,
            430_060,
            &video,
        )
        .unwrap();
        assert_eq!(read(&db, "project").unwrap().reserved_micro_usd, 680_060);
        reserve_in_db(
            &db,
            BillableJob::Speech,
            "project",
            "speech",
            3,
            1000,
            &serde_json::json!({"estimatedCostMicroUsd":1000}),
        )
        .unwrap();
        assert_eq!(read(&db, "project").unwrap().reserved_micro_usd, 681_060);
        let extra = serde_json::json!({"estimatedCostMicroUsd":20000});
        assert!(reserve_in_db(
            &db,
            BillableJob::CloudImage,
            "project",
            "extra",
            3,
            20_000,
            &extra
        )
        .is_err());
        let count: i64 = db
            .query_row("SELECT COUNT(*) FROM cloud_image_jobs", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(count, 1);
    }
}
