mod devlog;
mod files;
mod media;
mod menu;
mod platform;

/// Desktop entry point. The scaffold's `#[cfg_attr(mobile, ...)]` mobile
/// entry point is removed: this app targets Windows, macOS and Linux only
/// (AGENTS.md, "Platform targets").
pub fn run() {
    // `mut` only on macOS, where the menu is installed below.
    #[allow(unused_mut)]
    let mut builder = tauri::Builder::default()
        // Native file dialogs returning real paths.
        .plugin(tauri_plugin_dialog::init())
        // Real filesystem access for viewer plugins.
        .plugin(tauri_plugin_fs::init())
        // Session/layout persistence (unused until phase 07, enabled from the start).
        .plugin(tauri_plugin_store::Builder::new().build());

    // macOS installs a default menu when the builder is given none, and four of
    // its key equivalents are accelerators this app binds — see `menu.rs`.
    // Windows and Linux get no menu, which is what they had before.
    #[cfg(target_os = "macos")]
    {
        builder = builder.menu(|app| menu::build(app));
    }

    builder
        .invoke_handler(tauri::generate_handler![
            files::open_file_dialog,
            files::describe_file,
            files::read_file_bytes,
            files::read_file_range,
            files::list_directory_files,
            files::save_file_dialog,
            files::write_file_bytes,
            media::media_stream_url,
            media::media_release,
            platform::host_platform,
            devlog::dev_log,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
