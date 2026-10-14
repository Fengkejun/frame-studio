use super::*;

fn selected(store: &Store) -> AppResult<Option<PathBuf>> {
    let json: Option<String> = store
        .db()?
        .query_row(
            "SELECT json FROM media_settings WHERE id='backup-directory'",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    json.map(|value| {
        serde_json::from_str::<String>(&value)
            .map(PathBuf::from)
            .map_err(|e| e.to_string())
    })
    .transpose()
}

#[tauri::command]
pub async fn choose_backup_directory(app: tauri::AppHandle) -> AppResult<Option<String>> {
    let path = if cfg!(debug_assertions) && std::env::var_os("FRAME_STUDIO_TEST_DATA_DIR").is_some()
    {
        std::env::var_os("FRAME_STUDIO_TEST_BACKUP_DIRECTORY").map(PathBuf::from)
    } else {
        let window = app.get_webview_window("main").ok_or("窗口不可用")?;
        tauri::async_runtime::spawn_blocking(move || {
            rfd::FileDialog::new()
                .set_parent(&window)
                .set_title("选择备份保存位置")
                .pick_folder()
        })
        .await
        .map_err(|_| "文件夹选择中断")?
    };
    let Some(path) = path else {
        return Ok(None);
    };
    tauri::async_runtime::spawn_blocking(move || {
        let _operation = OPERATION.try_lock().map_err(|_| "备份操作正在进行，请稍后再试")?;
        let state = app.state::<WorkflowState>();
        let root = initialize(&path, &state.directory)?;
        let display = root.to_string_lossy().into_owned();
        state.store.db()?.execute(
            "INSERT INTO media_settings(id,json) VALUES ('backup-directory',?1) ON CONFLICT(id) DO UPDATE SET json=excluded.json",
            [serde_json::to_string(&display).map_err(|e| e.to_string())?]).map_err(|e| e.to_string())?;
        Ok(Some(display))
    }).await.map_err(|_| "备份目录设置中断")?
}

#[tauri::command]
pub async fn list_project_backups(app: tauri::AppHandle) -> AppResult<BackupReport> {
    tauri::async_runtime::spawn_blocking(move || {
        let _operation = OPERATION
            .try_lock()
            .map_err(|_| "备份操作正在进行，请稍后刷新")?;
        let state = app.state::<WorkflowState>();
        match selected(&state.store)? {
            Some(root) => list(&root),
            None => Ok(BackupReport {
                directory: None,
                points: vec![],
                warnings: vec![],
            }),
        }
    })
    .await
    .map_err(|_| "备份记录读取中断")?
}

#[tauri::command]
pub async fn create_project_backup(
    app: tauri::AppHandle,
    workflow_id: String,
) -> AppResult<BackupPoint> {
    tauri::async_runtime::spawn_blocking(move || {
        let _operation = OPERATION
            .try_lock()
            .map_err(|_| "备份操作正在进行，请稍后再试")?;
        let state = app.state::<WorkflowState>();
        no_active_tasks(&state)?;
        let root = selected(&state.store)?.ok_or("请先选择备份位置")?;
        create(&state.store, &state.directory, &workflow_id, &root)
    })
    .await
    .map_err(|_| "项目备份中断")?
}

#[tauri::command]
pub async fn restore_project_backup(
    app: tauri::AppHandle,
    backup_id: String,
) -> AppResult<Workflow> {
    tauri::async_runtime::spawn_blocking(move || {
        let _operation = OPERATION
            .try_lock()
            .map_err(|_| "备份操作正在进行，请稍后再试")?;
        let state = app.state::<WorkflowState>();
        no_active_tasks(&state)?;
        let root = selected(&state.store)?.ok_or("请先选择备份位置")?;
        restore(&state.store, &state.directory, &root, &backup_id)
    })
    .await
    .map_err(|_| "项目恢复中断")?
}
