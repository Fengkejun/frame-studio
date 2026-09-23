use super::types::*;
use rusqlite::{params, Connection, OptionalExtension};
use std::{
    path::Path,
    sync::{Mutex, MutexGuard},
};

pub struct Store(pub Mutex<Connection>);
impl Store {
    pub fn open(path: &Path) -> AppResult<Self> {
        let c = Connection::open(path).map_err(|e| format!("无法打开项目数据库：{e}"))?;
        c.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
            CREATE TABLE IF NOT EXISTS workflows(id TEXT PRIMARY KEY, json TEXT NOT NULL, updated_at INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS providers(id TEXT PRIMARY KEY, json TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL, json TEXT NOT NULL, started_at INTEGER NOT NULL);
            ").map_err(|e| e.to_string())?;
        let version: u32 = c
            .pragma_query_value(None, "user_version", |r| r.get(0))
            .map_err(|e| e.to_string())?;
        if version > 2 {
            return Err("项目数据库版本较新，请升级应用".into());
        }
        if version < 2 {
            c.execute_batch("BEGIN IMMEDIATE;
                CREATE TABLE IF NOT EXISTS image_assets(id TEXT PRIMARY KEY, json TEXT NOT NULL, created_at INTEGER NOT NULL);
                CREATE TABLE IF NOT EXISTS image_jobs(id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL, json TEXT NOT NULL, created_at INTEGER NOT NULL);
                CREATE TABLE IF NOT EXISTS first_frames(workflow_id TEXT NOT NULL, node_id TEXT NOT NULL, artifact_id TEXT NOT NULL, shot_id TEXT NOT NULL, version_id TEXT NOT NULL, PRIMARY KEY(workflow_id,node_id,artifact_id,shot_id));
                CREATE TABLE IF NOT EXISTS media_settings(id TEXT PRIMARY KEY, json TEXT NOT NULL);
                PRAGMA user_version=2; COMMIT;").map_err(|e| e.to_string())?;
        }
        let store = Self(Mutex::new(c));
        // A text request has no pollable provider task ID. Never resubmit after a crash.
        for mut run in store.runs(None)? {
            if run.status == "running" || run.status == "queued" {
                run.status = "interrupted".into();
                run.finished_at = Some(now());
                for n in &mut run.nodes {
                    if n.status == "running" {
                        n.status = "unknown".into();
                        n.message = "应用退出，无法确认请求结果；检查服务端后再手动重跑".into();
                    } else if n.status == "pending" {
                        n.status = "skipped".into();
                    }
                }
                store.save_run(&run)?;
            }
        }
        Ok(store)
    }
    pub fn db(&self) -> AppResult<MutexGuard<'_, Connection>> {
        self.0.lock().map_err(|_| "数据库锁不可用".into())
    }
    pub fn workflows(&self) -> AppResult<Vec<Workflow>> {
        let c = self.db()?;
        let mut s = c
            .prepare("SELECT json FROM workflows ORDER BY updated_at DESC")
            .map_err(|e| e.to_string())?;
        let rows = s
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        rows.map(|r| {
            serde_json::from_str(&r.map_err(|e| e.to_string())?).map_err(|e| e.to_string())
        })
        .collect()
    }
    pub fn save_workflow(&self, w: &Workflow) -> AppResult<()> {
        validate_graph(w, false)?;
        self.db()?.execute("INSERT INTO workflows VALUES (?1,?2,?3) ON CONFLICT(id) DO UPDATE SET json=excluded.json, updated_at=excluded.updated_at", params![w.id, serde_json::to_string(w).map_err(|e|e.to_string())?, w.updated_at]).map_err(|e|e.to_string())?;
        Ok(())
    }
    pub fn providers(&self) -> AppResult<Vec<Provider>> {
        let c = self.db()?;
        let mut s = c
            .prepare("SELECT json FROM providers ORDER BY rowid")
            .map_err(|e| e.to_string())?;
        let rows = s
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        rows.map(|r| {
            serde_json::from_str(&r.map_err(|e| e.to_string())?).map_err(|e| e.to_string())
        })
        .collect()
    }
    pub fn provider(&self, id: &str) -> AppResult<Provider> {
        self.providers()?
            .into_iter()
            .find(|p| p.id == id)
            .ok_or("模型连接不存在".into())
    }
    pub fn save_provider(&self, p: &Provider) -> AppResult<()> {
        self.db()?.execute("INSERT INTO providers VALUES (?1,?2) ON CONFLICT(id) DO UPDATE SET json=excluded.json", params![p.id, serde_json::to_string(p).map_err(|e|e.to_string())?]).map_err(|e|e.to_string())?;
        Ok(())
    }
    pub fn save_run(&self, r: &RunRecord) -> AppResult<()> {
        self.db()?.execute("INSERT INTO runs VALUES (?1,?2,?3,?4) ON CONFLICT(id) DO UPDATE SET json=excluded.json",params![r.id,r.workflow_id,serde_json::to_string(r).map_err(|e|e.to_string())?,r.started_at]).map_err(|e|e.to_string())?;
        Ok(())
    }
    pub fn run(&self, id: &str) -> AppResult<RunRecord> {
        let json: Option<String> = self
            .db()?
            .query_row("SELECT json FROM runs WHERE id=?1", [id], |r| r.get(0))
            .optional()
            .map_err(|e| e.to_string())?;
        serde_json::from_str(&json.ok_or("运行记录不存在")?).map_err(|e| e.to_string())
    }
    pub fn runs(&self, workflow_id: Option<&str>) -> AppResult<Vec<RunRecord>> {
        let c = self.db()?;
        let mut s=c.prepare("SELECT json FROM runs WHERE (?1 IS NULL OR workflow_id=?1) ORDER BY started_at DESC").map_err(|e|e.to_string())?;
        let rows = s
            .query_map([workflow_id], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        rows.map(|r| {
            serde_json::from_str(&r.map_err(|e| e.to_string())?).map_err(|e| e.to_string())
        })
        .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn upgrades_v1_without_losing_existing_data() {
        let path = std::env::temp_dir().join(format!("frame-studio-migration-{}.sqlite", uid()));
        {
            let db = Connection::open(&path).unwrap();
            db.execute_batch("CREATE TABLE providers(id TEXT PRIMARY KEY,json TEXT NOT NULL); INSERT INTO providers VALUES ('existing','{\"id\":\"existing\",\"name\":\"Ollama\",\"kind\":\"ollama\",\"baseUrl\":\"http://localhost:11434\",\"model\":\"text\",\"hasKey\":false}'); PRAGMA user_version=1;").unwrap();
        }
        {
            let store = Store::open(&path).unwrap();
            assert_eq!(store.providers().unwrap()[0].id, "existing");
            assert_eq!(
                store
                    .db()
                    .unwrap()
                    .pragma_query_value(None, "user_version", |r| r.get::<_, u32>(0))
                    .unwrap(),
                2
            );
        }
        assert_eq!(Store::open(&path).unwrap().providers().unwrap().len(), 1);
        std::fs::remove_file(path).unwrap();
    }
}
