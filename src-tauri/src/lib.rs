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
            workflow::validate_artifact,
            workflow::media::import_image,
            workflow::media::list_image_assets,
            workflow::media::image_preview,
            workflow::media::select_first_frame,
            workflow::media::list_first_frames,
            workflow::media::comfy::test_comfy,
            workflow::media::comfy::image_settings,
            workflow::media::comfy::list_image_jobs,
            workflow::media::comfy::start_image_job,
            workflow::media::comfy::resume_image_job,
            workflow::media::comfy::pause_image_job,
            workflow::media::cloud::cloud_image_key_status,
            workflow::media::cloud::save_cloud_image_key,
            workflow::media::cloud::clear_cloud_image_key,
            workflow::media::cloud::list_cloud_image_jobs,
            workflow::media::cloud::start_cloud_image_job
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Frame Studio");
}
