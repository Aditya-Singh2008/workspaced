//! Which desktop OS this binary was built for.
//!
//! The frontend needs this to pick keyboard modifier conventions (Cmd on
//! macOS, Ctrl on Windows and Linux). It comes from Rust rather than from
//! `navigator.userAgent` because the compile target is a fact, while a webview
//! user-agent string is a heuristic that varies by webview version and distro.

use serde::Serialize;

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "lowercase")]
// Only the variant matching the current target is ever constructed, so the
// other two look dead to the compiler on any given build. They are not: each
// is live on its own platform.
#[allow(dead_code)]
pub enum HostPlatform {
    Windows,
    Macos,
    Linux,
}

/// The OS this build targets.
///
/// Only the three desktop targets exist; mobile is out of scope (AGENTS.md,
/// "Platform targets"). An unrecognized target fails the build rather than
/// silently defaulting, so adding a platform is a deliberate decision.
#[tauri::command]
pub fn host_platform() -> HostPlatform {
    #[cfg(target_os = "windows")]
    {
        HostPlatform::Windows
    }
    #[cfg(target_os = "macos")]
    {
        HostPlatform::Macos
    }
    #[cfg(target_os = "linux")]
    {
        HostPlatform::Linux
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        compile_error!(
            "unsupported target OS: this app builds for Windows, macOS and Linux only \
             (see AGENTS.md, \"Platform targets\")"
        )
    }
}
