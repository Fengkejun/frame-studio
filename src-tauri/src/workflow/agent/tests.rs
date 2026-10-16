use super::*;
fn fixture() -> (Plan, Session) {
    let config:Config=serde_json::from_value(json!({"providerId":"p","video":{"region":"singapore","resolution":"480P","wulusai":{"baseUrl":"https://example.com","model":"grok-imagine-video-1.5-lite","mode":"text","ratio":null,"budgetReservationMicroUsd":500000}},"image":null,"budgetMicroUsd":1000000,"autoSearchSkills":false})).unwrap();
    let plan:Plan=serde_json::from_value(json!({"title":"短片","summary":"连续叙事","duration":12,"storyDuration":12,"shotCount":3,"production":{"style":"二维","characters":"同一小猫","scene":"屋顶","rules":"雨夜不变"},"steps":["write_story","write_storyboard","generate_video"],"skillIds":["anime-story"],"skillSearchQuery":"","generationMode":"text"})).unwrap();
    let s = Session {
        id: "session".into(),
        workflow_id: "workflow".into(),
        request: Request {
            goal: "创作短片".into(),
            config,
            reference_version_id: None,
            parent_id: None,
            script_only: false,
        },
        provider: Provider {
            id: "p".into(),
            name: "p".into(),
            kind: "openai".into(),
            base_url: "https://example.com/v1".into(),
            model: "chat".into(),
            has_key: false,
        },
        status: "running".into(),
        message: String::new(),
        plan: None,
        events: vec![],
        cursor: 0,
        image_job_id: None,
        video_job_id: None,
        video_version_id: None,
        reference_version_id: None,
        output_path: None,
        created_at: now(),
        updated_at: now(),
    };
    (plan, s)
}
#[test]
fn tool_plan_respects_dependencies_model_limits_and_budget_before_media() {
    let (p, mut s) = fixture();
    assert!(validate_plan(&p, &s).is_ok());
    let mut bad = p.clone();
    bad.steps.swap(0, 1);
    assert!(validate_plan(&bad, &s).is_err());
    bad = p.clone();
    bad.duration = 16;
    bad.story_duration = 16;
    assert!(validate_plan(&bad, &s).is_err());
    s.request.config.budget_micro_usd = 10000;
    assert!(validate_plan(&p, &s).unwrap_err().contains("预算"));
    let (mut p, mut s) = fixture();
    p.generation_mode = "frame".into();
    p.steps.insert(2, "generate_image".into());
    assert!(validate_plan(&p, &s).is_err());
    p.steps.remove(2);
    s.reference_version_id = Some("reference".into());
    assert!(validate_plan(&p, &s).is_ok());
}
#[test]
fn script_only_plans_do_not_request_media_and_keep_a_valid_advanced_graph() {
    let (mut p, mut s) = fixture();
    s.request.script_only = true;
    s.request.config.video = None;
    p.steps.pop();
    assert!(validate_plan(&p, &s).is_ok());
    let workflow = make_workflow(&s, &p);
    assert!(validate_graph(&workflow, true).is_ok());
    s.request.script_only = false;
    assert!(validate_plan(&p, &s).is_ok());
    s.request.script_only = true;
    p.steps.push("generate_video".into());
    assert!(validate_plan(&p, &s).is_err());
}
#[test]
fn rounding_drift_is_aligned_without_another_model_request() {
    let mut value = json!({"shots":[{"id":"1","title":"镜头","description":"动作","duration":4.1,"characters":[],"dialogue":"","camera":"推进","imagePrompt":"首帧","videoPrompt":"动作"},{"id":"2","title":"镜头","description":"动作","duration":4.1,"characters":[],"dialogue":"","camera":"推进","imagePrompt":"首帧","videoPrompt":"动作"},{"id":"3","title":"镜头","description":"动作","duration":4.1,"characters":[],"dialogue":"","camera":"推进","imagePrompt":"首帧","videoPrompt":"动作"}]});
    align_storyboard(&mut value, 12).unwrap();
    let total: f64 = value["shots"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s["duration"].as_f64().unwrap())
        .sum();
    assert!((total - 12.0).abs() < 0.001);
    assert!(align_storyboard(&mut value, 15).is_err());
}
