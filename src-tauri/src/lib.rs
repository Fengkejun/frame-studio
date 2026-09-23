mod commands;
mod workflow;

pub fn run() {
    tauri::Builder::default()
        .setup(workflow::init)
        .invoke_handler(tauri::generate_handler![
            commands::get_app_info,
            workflow::list_workflows,
            workflow::save_workflow,
            workflow::list_providers,
            workflow::save_provider,
            workflow::remove_provider,
            workflow::test_provider,
            workflow::list_runs,
            workflow::get_run,
            workflow::start_run,
            workflow::cancel_run,
            workflow::validate_artifact
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Frame Studio");
}
