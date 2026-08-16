//! Native file access commands.
//!
//! These are the only sanctioned way the frontend obtains a real path or the
//! bytes behind one. The frontend never sees `File`/`Blob`; it wraps whatever
//! these return in the `FileHandle` abstraction (`src/files/handle.ts`), which
//! is what viewer plugins and the persistence layer depend on.
//!
//! Deliberately *not* done here: MIME type detection. A native path carries no
//! MIME type, and guessing one in Rust would make the guess indistinguishable
//! from an authoritative type supplied by, say, a drag-and-drop event. The
//! registry resolves by MIME first and falls back to extension, so leaving
//! `mimeType` absent for native paths keeps that fallback honest.

use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::{Deserialize, Serialize};
use tauri_plugin_dialog::DialogExt;

/// Everything the shell needs to describe a file without reading its contents.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileDescriptor {
    /// Absolute path on disk.
    pub path: String,
    /// File name including extension.
    pub name: String,
    /// Lowercased extension without the leading dot, if any.
    pub extension: Option<String>,
    /// Size in bytes.
    pub size: u64,
    /// Last-modified time in milliseconds since the Unix epoch, if the platform
    /// reports one.
    pub modified_at: Option<u64>,
}

/// A file-type filter for the native open dialog, e.g. `{ name: "PDF",
/// extensions: ["pdf"] }`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DialogFilter {
    pub name: String,
    pub extensions: Vec<String>,
}

fn describe(path: &Path) -> Result<FileDescriptor, String> {
    let metadata = std::fs::metadata(path)
        .map_err(|e| format!("cannot stat {}: {e}", path.display()))?;

    if !metadata.is_file() {
        return Err(format!("{} is not a regular file", path.display()));
    }

    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .ok_or_else(|| format!("{} has no file name", path.display()))?;

    let extension = path
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .filter(|e| !e.is_empty());

    let modified_at = metadata
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64);

    Ok(FileDescriptor {
        path: path.to_string_lossy().into_owned(),
        name,
        extension,
        size: metadata.len(),
        modified_at,
    })
}

/// Open the OS-native file picker and describe whatever the user chose.
///
/// Returns an empty vector when the dialog is dismissed, which the frontend
/// treats as "no selection" rather than an error.
#[tauri::command]
pub async fn open_file_dialog(
    app: tauri::AppHandle,
    multiple: bool,
    filters: Vec<DialogFilter>,
) -> Result<Vec<FileDescriptor>, String> {
    // The blocking dialog API dispatches to the platform's main thread and
    // waits, so it must be called from somewhere that is not the main thread.
    let picked: Vec<PathBuf> = tauri::async_runtime::spawn_blocking(move || {
        let mut builder = app.dialog().file();
        for filter in &filters {
            let extensions: Vec<&str> = filter.extensions.iter().map(String::as_str).collect();
            builder = builder.add_filter(&filter.name, &extensions);
        }

        let selection = if multiple {
            builder.blocking_pick_files()
        } else {
            builder.blocking_pick_file().map(|file| vec![file])
        };

        selection
            .unwrap_or_default()
            .into_iter()
            .filter_map(|file| file.into_path().ok())
            .collect::<Vec<PathBuf>>()
    })
    .await
    .map_err(|e| format!("file dialog task failed: {e}"))?;

    picked.iter().map(|path| describe(path)).collect()
}

/// Describe a file the frontend already has a path for: a drag-and-drop payload
/// or a path restored from a previous session.
#[tauri::command]
pub fn describe_file(path: String) -> Result<FileDescriptor, String> {
    describe(Path::new(&path))
}

/// Read a file's full contents as raw bytes.
///
/// Returns a [`tauri::ipc::Response`] so the payload crosses the IPC boundary
/// as binary and arrives in JS as an `ArrayBuffer`, rather than being expanded
/// into a JSON array of numbers.
#[tauri::command]
pub fn read_file_bytes(path: String) -> Result<tauri::ipc::Response, String> {
    let bytes = std::fs::read(&path).map_err(|e| format!("cannot read {path}: {e}"))?;
    Ok(tauri::ipc::Response::new(bytes))
}

// ---------------------------------------------------------------------------
// Ranged reads — phase 04b's container parsing
// ---------------------------------------------------------------------------

/// Which bytes a requested range actually covers, given the file's size.
///
/// Separated from the command because it is the only part with a decision in
/// it, and it is wrong in ways that look right. A range whose start is past the
/// end must come back *empty*, not clamped to the last byte: a container parser
/// following a box offset into a truncated file would otherwise be handed a few
/// plausible bytes from the wrong place and would parse them. The arithmetic is
/// saturating throughout for the same reason — `offset + length` overflows for a
/// caller that asks for `u64::MAX`, and a wrapped length reads the whole file.
///
/// Negative or fractional numbers cannot arrive here: the IPC layer rejects them
/// against the `u64` signature before this is reached.
fn clamp_range(size: u64, offset: u64, length: u64) -> (u64, u64) {
    if offset >= size {
        return (offset, 0);
    }
    (offset, length.min(size - offset))
}

/// Read `length` bytes of a file starting at `offset`.
///
/// [`read_file_bytes`] is the right call for a format that needs all of its
/// bytes (pdf.js) and the wrong one for media: a video is played by the webview
/// straight from a `streamUrl`, and the only thing the app itself has to read is
/// the container header — a few hundred kilobytes at each end of a file that may
/// be several gigabytes. Reading the whole thing to find a duration would spend
/// the file's size in memory to answer a question the first `moov` box already
/// answers.
///
/// A range that starts past the end of the file yields an empty response rather
/// than an error: "there is nothing there" is the answer a parser walking an
/// index needs, and it is not a failure.
#[tauri::command]
pub fn read_file_range(
    path: String,
    offset: u64,
    length: u64,
) -> Result<tauri::ipc::Response, String> {
    use std::io::{Read, Seek, SeekFrom};

    let mut file = std::fs::File::open(&path).map_err(|e| format!("cannot read {path}: {e}"))?;
    let size = file
        .metadata()
        .map_err(|e| format!("cannot stat {path}: {e}"))?
        .len();

    let (start, count) = clamp_range(size, offset, length);
    if count == 0 {
        return Ok(tauri::ipc::Response::new(Vec::new()));
    }

    file.seek(SeekFrom::Start(start))
        .map_err(|e| format!("cannot seek {path} to {start}: {e}"))?;

    // Sized from the clamped length, which cannot exceed the file, so a caller
    // asking for `u64::MAX` allocates the file's size rather than the request's.
    let mut bytes = vec![0u8; count as usize];
    file.read_exact(&mut bytes)
        .map_err(|e| format!("cannot read {count} bytes of {path} at {start}: {e}"))?;
    Ok(tauri::ipc::Response::new(bytes))
}

// ---------------------------------------------------------------------------
// Sibling listing — phase 04a's folder browsing
// ---------------------------------------------------------------------------

/// Compare two file names the way a file manager does: digit runs compare as
/// numbers, everything else case-insensitively.
///
/// Plain lexicographic ordering puts `IMG_10.jpg` before `IMG_9.jpg`, which is
/// wrong in the one place this ordering is used — stepping through a camera
/// roll with the next/previous keys. Getting that wrong is not cosmetic: it
/// makes the ordering disagree with every other application showing the same
/// directory.
fn natural_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    use std::cmp::Ordering;

    let mut left = a.chars().peekable();
    let mut right = b.chars().peekable();

    // Differences that must not decide the comparison until everything else has
    // compared equal: letter case, and zero-padding within a digit run.
    //
    // Acting on either one where it is found is the bug this deferral exists to
    // prevent, and it is not hypothetical — it sorted `Screenshot 10.png` before
    // `screenshot 2.png`, because the capital S differed at the first character
    // and returned before the digits were ever reached. A user whose files are
    // named inconsistently, which is every user with screenshots, would see an
    // order no other application produces.
    let mut deferred = Ordering::Equal;
    let mut remember = |order: Ordering| {
        if deferred == Ordering::Equal {
            deferred = order;
        }
    };

    loop {
        match (left.peek().copied(), right.peek().copied()) {
            (None, None) => return deferred,
            (None, Some(_)) => return Ordering::Less,
            (Some(_), None) => return Ordering::Greater,
            (Some(x), Some(y)) => {
                if x.is_ascii_digit() && y.is_ascii_digit() {
                    // Consume both digit runs whole and compare them by value:
                    // fewer significant digits is a smaller number, and equal
                    // lengths compare lexicographically, which for digits is the
                    // same as numerically and needs no parsing (so a 40-digit
                    // run cannot overflow anything).
                    let mut xs = String::new();
                    while left.peek().is_some_and(|c| c.is_ascii_digit()) {
                        xs.push(left.next().unwrap());
                    }
                    let mut ys = String::new();
                    while right.peek().is_some_and(|c| c.is_ascii_digit()) {
                        ys.push(right.next().unwrap());
                    }
                    let xt = xs.trim_start_matches('0');
                    let yt = ys.trim_start_matches('0');
                    let order = xt.len().cmp(&yt.len()).then_with(|| xt.cmp(yt));
                    if order != Ordering::Equal {
                        return order;
                    }
                    // Same value, different padding: `007` and `7`.
                    remember(xs.len().cmp(&ys.len()));
                } else {
                    left.next();
                    right.next();
                    let order = x.to_lowercase().cmp(y.to_lowercase());
                    if order != Ordering::Equal {
                        return order;
                    }
                    remember(x.cmp(&y));
                }
            }
        }
    }
}

/// List the files in `directory` whose extension is in `extensions`.
///
/// Backs the image plugin's next/previous navigation and its slideshow. The
/// caller passes the extensions it can actually open, so the filtering rule
/// lives with the plugin that owns the format table rather than being duplicated
/// here — this command knows nothing about images.
///
/// Hidden files, subdirectories and symlinked directories are skipped, and the
/// result is ordered by [`natural_cmp`]. An unreadable directory is an error;
/// an unreadable *entry* within it is simply omitted, because one bad file
/// should not make the other twenty unreachable.
#[tauri::command]
pub fn list_directory_files(
    directory: String,
    extensions: Vec<String>,
) -> Result<Vec<FileDescriptor>, String> {
    let wanted: Vec<String> = extensions.iter().map(|e| e.to_lowercase()).collect();

    let entries = std::fs::read_dir(&directory)
        .map_err(|e| format!("cannot list {directory}: {e}"))?;

    let mut files: Vec<FileDescriptor> = entries
        .filter_map(|entry| entry.ok())
        .filter(|entry| entry.file_type().is_ok_and(|t| t.is_file()))
        .filter(|entry| !entry.file_name().to_string_lossy().starts_with('.'))
        .filter(|entry| {
            let path = entry.path();
            let extension = path
                .extension()
                .map(|e| e.to_string_lossy().to_lowercase())
                .unwrap_or_default();
            wanted.is_empty() || wanted.contains(&extension)
        })
        .filter_map(|entry| describe(&entry.path()).ok())
        .collect();

    files.sort_by(|a, b| natural_cmp(&a.name, &b.name));
    Ok(files)
}

// ---------------------------------------------------------------------------
// Saving — phase 04a's export / save-as
// ---------------------------------------------------------------------------

/// Show the native save dialog and return the chosen path.
///
/// `Ok(None)` when the user dismisses it: a cancellation is not an error, the
/// same convention [`open_file_dialog`] follows by returning an empty vector.
#[tauri::command]
pub async fn save_file_dialog(
    app: tauri::AppHandle,
    default_name: Option<String>,
    filters: Vec<DialogFilter>,
) -> Result<Option<String>, String> {
    let picked: Option<PathBuf> = tauri::async_runtime::spawn_blocking(move || {
        let mut builder = app.dialog().file();
        if let Some(name) = &default_name {
            builder = builder.set_file_name(name);
        }
        for filter in &filters {
            let extensions: Vec<&str> = filter.extensions.iter().map(String::as_str).collect();
            builder = builder.add_filter(&filter.name, &extensions);
        }
        builder
            .blocking_save_file()
            .and_then(|file| file.into_path().ok())
    })
    .await
    .map_err(|e| format!("save dialog task failed: {e}"))?;

    Ok(picked.map(|path| path.to_string_lossy().into_owned()))
}

/// Percent-decode a UTF-8 string that crossed the IPC boundary in a header.
///
/// Headers are a Latin-1 channel, and a path can contain anything the
/// filesystem allows. The frontend sends `encodeURIComponent(path)`; this is the
/// other half. Hand-rolled rather than pulling in a percent-encoding crate for
/// nine lines of work.
fn percent_decode(value: &str) -> Result<String, String> {
    let bytes = value.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[index + 1..index + 3])
                .map_err(|_| "malformed percent escape".to_string())?;
            let byte = u8::from_str_radix(hex, 16)
                .map_err(|_| "malformed percent escape".to_string())?;
            out.push(byte);
            index += 3;
        } else {
            out.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(out).map_err(|_| "path is not valid UTF-8".to_string())
}

#[cfg(test)]
mod tests {
    //! Unit tests for the three pieces of pure logic in this file.
    //!
    //! Everything else here is a thin wrapper over `std::fs` or the dialog
    //! plugin and is verified by running the app. These three are not: the
    //! ordering decides what "next image" means, the percent decoder sits
    //! between a header and a filesystem write, and the range clamp decides
    //! which bytes a container parser is handed. All three are wrong in ways
    //! that look right — an ordering that disagrees with the file manager, a
    //! path that silently loses its non-ASCII characters, a range that returns
    //! plausible bytes from the wrong offset — so they are checked here rather
    //! than by eye.
    //!
    //! This is the only `cargo test` in the project. The frontend's self-tests
    //! run inside the real webview because what they check (canvas behaviour,
    //! keyboard handling) only exists there; none of that applies to a
    //! comparison function.

    use super::*;
    use std::cmp::Ordering;

    #[test]
    fn digit_runs_compare_as_numbers() {
        // The case the whole function exists for. Lexicographically "IMG_10"
        // precedes "IMG_9", which is wrong in the one place this ordering is
        // used: stepping through a camera roll.
        assert_eq!(natural_cmp("IMG_9.jpg", "IMG_10.jpg"), Ordering::Less);
        assert_eq!(natural_cmp("IMG_100.jpg", "IMG_99.jpg"), Ordering::Greater);
        assert_eq!(natural_cmp("a2b", "a10b"), Ordering::Less);
    }

    #[test]
    fn comparison_is_case_insensitive_but_still_total() {
        assert_eq!(natural_cmp("Photo.png", "photo.png"), Ordering::Less);
        assert_eq!(natural_cmp("apple", "Banana"), Ordering::Less);
        assert_eq!(natural_cmp("same", "same"), Ordering::Equal);
    }

    #[test]
    fn leading_zeros_do_not_change_the_value() {
        assert_eq!(natural_cmp("img007", "img7"), Ordering::Greater); // equal value, longer run
        assert_eq!(natural_cmp("img007", "img8"), Ordering::Less); // 7 < 8 regardless
    }

    #[test]
    fn a_prefix_sorts_before_what_extends_it() {
        assert_eq!(natural_cmp("scan", "scan-2"), Ordering::Less);
        assert_eq!(natural_cmp("", "a"), Ordering::Less);
    }

    #[test]
    fn sorting_a_real_looking_directory() {
        let mut names = vec![
            "Screenshot 10.png",
            "IMG_2.jpg",
            "screenshot 2.png",
            "IMG_10.jpg",
            "IMG_1.jpg",
        ];
        names.sort_by(|a, b| natural_cmp(a, b));
        assert_eq!(
            names,
            vec![
                "IMG_1.jpg",
                "IMG_2.jpg",
                "IMG_10.jpg",
                "screenshot 2.png",
                "Screenshot 10.png",
            ]
        );
    }

    #[test]
    fn percent_decoding_round_trips_a_real_path() {
        // What `encodeURIComponent` produces for a path with a space and
        // non-ASCII characters. Decoding it as Latin-1 rather than UTF-8 is the
        // failure mode: it would write to a differently-named file.
        assert_eq!(
            percent_decode("/home/ab/My%20Photos/%C3%A9t%C3%A9.png").unwrap(),
            "/home/ab/My Photos/été.png"
        );
        assert_eq!(percent_decode("/plain/path.png").unwrap(), "/plain/path.png");
    }

    #[test]
    fn percent_decoding_rejects_rubbish_rather_than_guessing() {
        assert!(percent_decode("/bad/%zz/path").is_err());
    }

    #[test]
    fn a_range_inside_the_file_is_returned_whole() {
        assert_eq!(clamp_range(1000, 0, 100), (0, 100));
        assert_eq!(clamp_range(1000, 900, 100), (900, 100));
    }

    #[test]
    fn a_range_running_off_the_end_is_truncated_not_moved() {
        // Truncating is right; sliding the window back to fit is not. A parser
        // that asked for 100 bytes at 950 is following an offset, and bytes
        // from 900 would be silently misattributed to it.
        assert_eq!(clamp_range(1000, 950, 100), (950, 50));
    }

    #[test]
    fn a_range_starting_past_the_end_is_empty_rather_than_clamped() {
        // The case that matters for a truncated container: "there is nothing
        // there" has to be distinguishable from "here are the last few bytes".
        assert_eq!(clamp_range(1000, 1000, 100), (1000, 0));
        assert_eq!(clamp_range(1000, 5000, 100), (5000, 0));
        assert_eq!(clamp_range(0, 0, 100), (0, 0));
    }

    #[test]
    fn an_absurd_length_cannot_overflow_into_a_small_read() {
        // `offset + length` wraps for these, and a wrapped length would read
        // the whole file into a buffer sized for a header.
        assert_eq!(clamp_range(1000, 10, u64::MAX), (10, 990));
        assert_eq!(clamp_range(1000, u64::MAX, u64::MAX), (u64::MAX, 0));
    }

    #[test]
    fn listing_a_directory_filters_and_orders() {
        let directory = std::env::temp_dir().join("workspace-app-list-test");
        let _ = std::fs::remove_dir_all(&directory);
        std::fs::create_dir_all(&directory).unwrap();

        for name in ["b10.png", "b2.png", "notes.txt", ".hidden.png"] {
            std::fs::write(directory.join(name), b"x").unwrap();
        }
        std::fs::create_dir_all(directory.join("subdir.png")).unwrap();

        let listed = list_directory_files(
            directory.to_string_lossy().into_owned(),
            vec!["png".to_string()],
        )
        .unwrap();

        let names: Vec<&str> = listed.iter().map(|file| file.name.as_str()).collect();
        // Filtered by extension, hidden files skipped, a directory named `.png`
        // skipped, and ordered numerically rather than lexicographically.
        assert_eq!(names, vec!["b2.png", "b10.png"]);

        std::fs::remove_dir_all(&directory).unwrap();
    }
}

/// Write raw bytes to a path.
///
/// The bytes arrive as the request's raw body rather than as a command
/// argument, for the reason [`read_file_bytes`] returns a
/// [`tauri::ipc::Response`]: a `Vec<u8>` argument crosses the IPC boundary as a
/// JSON array of numbers, which for an exported image means megabytes of decimal
/// text. A raw body cannot carry named arguments alongside it, so the
/// destination travels in a header — see [`percent_decode`].
#[tauri::command]
pub fn write_file_bytes(request: tauri::ipc::Request<'_>) -> Result<(), String> {
    let path = request
        .headers()
        .get("x-target-path")
        .ok_or_else(|| "no destination path was supplied".to_string())?
        .to_str()
        .map_err(|_| "destination path is not a valid header value".to_string())?;
    let path = percent_decode(path)?;

    let bytes = match request.body() {
        tauri::ipc::InvokeBody::Raw(bytes) => bytes,
        tauri::ipc::InvokeBody::Json(_) => {
            return Err("expected a raw body, not JSON".to_string())
        }
    };

    std::fs::write(&path, bytes).map_err(|e| format!("cannot write {path}: {e}"))
}
