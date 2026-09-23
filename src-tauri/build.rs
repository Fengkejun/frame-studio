fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "get_app_info",
            "list_workflows",
            "save_workflow",
            "list_providers",
            "save_provider",
            "remove_provider",
            "test_provider",
            "list_runs",
            "get_run",
            "start_run",
            "cancel_run",
            "validate_artifact",
        ]),
    ))
    .expect("failed to build Tauri application metadata");
}
