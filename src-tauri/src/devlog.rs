//! Forwards webview diagnostics to the terminal running `npm start`.
//!
//! Webview consoles are not reachable from a script on any of the three
//! platforms: GNOME blocks scripted screenshots, WebKitGTK's inspector needs an
//! interactive client, and WebView2/WKWebView are no better. That makes
//! "does this render correctly under webkit2gtk?" — the exact question
//! AGENTS.md ("Platform targets") tells us to keep asking during phases 03 and
//! 04 — impossible to answer without a bridge.
//!
//! Debug builds only. In release the command still exists, so the frontend
//! never has to feature-detect it, but it discards its argument.

/// Prints a line from the webview to stdout, prefixed so it is distinguishable
/// from Rust's own output.
#[tauri::command]
pub fn dev_log(line: String) {
    #[cfg(debug_assertions)]
    println!("[webview] {line}");

    #[cfg(not(debug_assertions))]
    let _ = line;
}
