//! A loopback HTTP server that streams media files by byte range.
//!
//! ## Why this exists
//!
//! A video player must never read the file it is playing. mpv opens a
//! four-gigabyte film instantly because it reads a few hundred kilobytes of
//! header, then pulls the rest on demand and seeks by moving the file pointer.
//! Anything that reads first and plays second is not a player, it is a loader
//! with a picture at the end of it.
//!
//! The webview knows how to do this — `<video>` fetches by range natively — but
//! only for a URL its media stack can resolve. That is where the app's own
//! `asset://` scheme fails on Linux: webkit2gtk hands every media stream to
//! GStreamer, which resolves the URI itself and has never heard of `asset://`.
//! Measured on this machine against real H.264, VP9 and Theora files, all three
//! failed instantly through `asset://`, all three failed through `file://`
//! (cross-origin from the app's own origin), and all three played from a blob.
//!
//! The blob was the previous answer and it is the thing that made loading slow:
//! it pulled the entire file through the IPC boundary in eight-megabyte chunks
//! *before the first frame could be shown*, and held the whole film in memory
//! for as long as the tile was open. A 700 MB file meant ninety round trips and
//! a several-second wait staring at nothing.
//!
//! GStreamer does know `http://`. So this serves the file over loopback with
//! `Accept-Ranges`, and the media stack goes back to doing what it is good at:
//! reading the header, showing a frame, and fetching the rest as it needs it.
//! Time-to-first-frame stops depending on the size of the file, and memory
//! stops depending on it too.
//!
//! ## Why it is hand written
//!
//! One route, loopback only, `GET` and `HEAD`, `Range` and nothing else. A
//! general HTTP crate would be a dependency and a supply chain for a surface
//! this small, and the parts of HTTP that are genuinely hard to get right —
//! routing, TLS, keep-alive pipelining, chunked request bodies, compression —
//! are all parts this does not implement. The response side is the part that
//! matters and it is a handful of well-specified headers (RFC 9110 §14).
//!
//! ## What stops other programs reading your files
//!
//! Binding to `127.0.0.1` keeps it off the network, but every process on the
//! machine can still reach loopback, so the port alone guards nothing. The
//! guard is the token: a path is not servable until the app hands out a URL for
//! it, the token in that URL is 128 random bits, and the map holds only files
//! actually opened in a tile. Guessing one is not feasible and enumerating is
//! not possible — there is no index route. A grant is dropped when its tile
//! closes.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::net::{Ipv4Addr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock, RwLock};

/// How much is moved per `write`. Large enough that a gigabyte does not cost a
/// million syscalls, small enough that seeking away from a position abandons
/// only a little work.
const COPY_BUFFER_BYTES: usize = 256 * 1024;

/// A cap on the request head, so a client that opens a socket and sends header
/// lines forever cannot grow this process's memory.
const MAX_REQUEST_BYTES: usize = 16 * 1024;

type Grants = Arc<RwLock<HashMap<String, PathBuf>>>;

struct MediaServer {
    port: u16,
    grants: Grants,
}

/// Started once, on the first file that asks for a URL.
///
/// The error is remembered as well as the success: a loopback bind that failed
/// once failed for a reason that will not resolve itself, and retrying it per
/// video would add a syscall and a failure to every open. The caller falls back
/// when this is `Err`.
static SERVER: OnceLock<Result<MediaServer, String>> = OnceLock::new();

fn server() -> Result<&'static MediaServer, String> {
    match SERVER.get_or_init(start) {
        Ok(server) => Ok(server),
        Err(reason) => Err(reason.clone()),
    }
}

fn start() -> Result<MediaServer, String> {
    // Port 0: the OS picks a free one. A fixed port would collide with a second
    // copy of the app, and with whatever else on the machine had the same idea.
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
        .map_err(|e| format!("cannot open a loopback media port: {e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("cannot read the media port: {e}"))?
        .port();

    let grants: Grants = Arc::new(RwLock::new(HashMap::new()));
    let accepting = Arc::clone(&grants);

    std::thread::Builder::new()
        .name("media-server".into())
        .spawn(move || {
            for stream in listener.incoming() {
                let Ok(stream) = stream else { continue };
                let grants = Arc::clone(&accepting);
                // A thread per connection. A media element opens one or two at a
                // time and a session has a handful of tiles, so the pool this
                // would otherwise need would be managing single digits.
                let _ = std::thread::Builder::new()
                    .name("media-stream".into())
                    .spawn(move || serve(stream, &grants));
            }
        })
        .map_err(|e| format!("cannot start the media server: {e}"))?;

    Ok(MediaServer { port, grants })
}

/// 128 random bits, hex encoded.
///
/// `RandomState` is seeded by the OS and is the one source of real entropy in
/// `std` — no `rand` dependency for two `u64`s. It is a hash seed rather than a
/// CSPRNG, which is the right strength for a local capability that names one
/// file for the lifetime of one tile.
fn mint_token() -> String {
    use std::collections::hash_map::RandomState;
    use std::hash::{BuildHasher, Hasher};

    let mut token = String::with_capacity(32);
    for salt in 0..2u64 {
        let mut hasher = RandomState::new().build_hasher();
        hasher.write_u64(salt);
        hasher.write_u64(
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos() as u64)
                .unwrap_or(0),
        );
        token.push_str(&format!("{:016x}", hasher.finish()));
    }
    token
}

/// Grants a URL for one file and returns it.
///
/// Called once per opened video. The returned URL is good until
/// [`media_release`] revokes it or the process exits.
#[tauri::command]
pub fn media_stream_url(path: String) -> Result<String, String> {
    let file = PathBuf::from(&path);
    // Refusing here rather than at request time turns "the file is gone" into a
    // load error the viewer can describe, instead of a 404 that reaches the
    // media element as an opaque decode failure.
    if !file.is_file() {
        return Err(format!("{path} is not a file"));
    }

    let server = server()?;
    let token = mint_token();
    server
        .grants
        .write()
        .map_err(|_| "the media grant table is poisoned".to_string())?
        .insert(token.clone(), file);

    Ok(format!("http://127.0.0.1:{}/m/{token}", server.port))
}

/// Revokes a grant. Idempotent, and harmless for a token that was never issued.
#[tauri::command]
pub fn media_release(token: String) -> Result<(), String> {
    // No `server()` call: if the server never started there is nothing to
    // revoke, and starting one during teardown would be absurd.
    if let Some(Ok(server)) = SERVER.get() {
        if let Ok(mut grants) = server.grants.write() {
            grants.remove(&token);
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// The connection
// ---------------------------------------------------------------------------

fn serve(stream: TcpStream, grants: &Grants) {
    // Nagle batches small writes waiting for more, which for a stream of large
    // buffers only adds latency to the first frame.
    let _ = stream.set_nodelay(true);

    let Ok(peer) = stream.try_clone() else { return };
    let mut reader = BufReader::new(peer);
    let mut writer = stream;

    let Some(request) = read_request(&mut reader) else {
        let _ = respond_status(&mut writer, 400, "Bad Request");
        return;
    };

    if request.method != "GET" && request.method != "HEAD" {
        let _ = respond_status(&mut writer, 405, "Method Not Allowed");
        return;
    }

    let Some(token) = request.target.strip_prefix("/m/") else {
        let _ = respond_status(&mut writer, 404, "Not Found");
        return;
    };

    let path = grants
        .read()
        .ok()
        .and_then(|table| table.get(token).cloned());
    let Some(path) = path else {
        // The same answer for a revoked token and a guessed one: a distinct
        // "revoked" would confirm that the token had once been real.
        let _ = respond_status(&mut writer, 404, "Not Found");
        return;
    };

    let _ = send_file(&mut writer, &path, &request);
}

struct Request {
    method: String,
    target: String,
    range: Option<String>,
}

fn read_request(reader: &mut BufReader<TcpStream>) -> Option<Request> {
    let mut line = String::new();
    let mut consumed = 0usize;

    consumed += reader.read_line(&mut line).ok()?;
    if consumed == 0 || consumed > MAX_REQUEST_BYTES {
        return None;
    }

    let mut parts = line.split_whitespace();
    let method = parts.next()?.to_string();
    let target = parts.next()?.to_string();

    let mut range = None;
    loop {
        let mut header = String::new();
        let read = reader.read_line(&mut header).ok()?;
        consumed += read;
        if read == 0 || consumed > MAX_REQUEST_BYTES {
            return None;
        }
        let header = header.trim_end();
        if header.is_empty() {
            break;
        }
        if let Some((name, value)) = header.split_once(':') {
            if name.eq_ignore_ascii_case("range") {
                range = Some(value.trim().to_string());
            }
        }
    }

    Some(Request {
        method,
        target,
        range,
    })
}

/// Parses `Range: bytes=…` into an inclusive `[start, end]` within `size`.
///
/// Only the single-range forms are handled. A multi-range request would need a
/// `multipart/byteranges` body, no media element sends one, and the specified
/// answer for a range header that cannot be satisfied is to ignore it and send
/// the whole representation — which is what returning `None` does here.
fn parse_range(raw: &str, size: u64) -> Option<(u64, u64)> {
    let spec = raw.strip_prefix("bytes=")?.trim();
    if spec.contains(',') {
        return None;
    }
    let (from, to) = spec.split_once('-')?;
    let last = size.checked_sub(1)?;

    if from.is_empty() {
        // `bytes=-500`: the final 500 bytes. Media stacks use this to find a
        // trailing index — the Matroska cues, an AVI index, an MP4 whose `moov`
        // is at the end.
        let length: u64 = to.trim().parse().ok()?;
        if length == 0 {
            return None;
        }
        return Some((size.saturating_sub(length), last));
    }

    let start: u64 = from.trim().parse().ok()?;
    if start > last {
        return None;
    }
    let end = if to.trim().is_empty() {
        last
    } else {
        to.trim().parse::<u64>().ok()?.min(last)
    };
    if end < start {
        return None;
    }
    Some((start, end))
}

fn send_file(writer: &mut TcpStream, path: &Path, request: &Request) -> std::io::Result<()> {
    let mut file = match std::fs::File::open(path) {
        Ok(file) => file,
        Err(_) => return respond_status(writer, 404, "Not Found"),
    };
    let size = file.metadata()?.len();

    let unsatisfiable = request
        .range
        .as_deref()
        .is_some_and(|raw| raw.starts_with("bytes=") && parse_range(raw, size).is_none() && size > 0);

    let requested = request
        .range
        .as_deref()
        .and_then(|raw| parse_range(raw, size));

    let (start, end, status, phrase) = match requested {
        Some((start, end)) => (start, end, 206, "Partial Content"),
        None if unsatisfiable => {
            // 416 carries the real size so the client can ask again correctly.
            let head = format!(
                "HTTP/1.1 416 Range Not Satisfiable\r\n\
                 Content-Range: bytes */{size}\r\n\
                 Content-Length: 0\r\n\
                 Access-Control-Allow-Origin: *\r\n\
                 Connection: close\r\n\r\n"
            );
            writer.write_all(head.as_bytes())?;
            return writer.flush();
        }
        None if size == 0 => (0, 0, 200, "OK"),
        None => (0, size - 1, 200, "OK"),
    };

    let length = if size == 0 { 0 } else { end - start + 1 };

    let mut head = String::with_capacity(320);
    head.push_str(&format!("HTTP/1.1 {status} {phrase}\r\n"));
    head.push_str(&format!("Content-Type: {}\r\n", content_type(path)));
    head.push_str(&format!("Content-Length: {length}\r\n"));
    // Without this the media stack assumes the stream is not seekable and
    // disables the scrubber — the whole point of serving it this way.
    head.push_str("Accept-Ranges: bytes\r\n");
    if status == 206 {
        head.push_str(&format!("Content-Range: bytes {start}-{end}/{size}\r\n"));
    }
    // The webview's origin (`tauri://localhost`, or `http://tauri.localhost` on
    // Windows) is not this one, so without CORS the canvas that frame capture
    // and the scrubber preview draw into would be tainted and unreadable. The
    // token, not the origin check, is what guards the file.
    head.push_str("Access-Control-Allow-Origin: *\r\n");
    head.push_str("Cache-Control: no-store\r\n");
    // Keep-alive would be a small win and needs the request side to be parsed
    // far more carefully than this does. One request per connection is honest
    // and costs a socket per seek.
    head.push_str("Connection: close\r\n\r\n");
    writer.write_all(head.as_bytes())?;

    if request.method == "HEAD" || length == 0 {
        return writer.flush();
    }

    file.seek(SeekFrom::Start(start))?;
    let mut remaining = length;
    let mut buffer = vec![0u8; COPY_BUFFER_BYTES];

    while remaining > 0 {
        let want = remaining.min(COPY_BUFFER_BYTES as u64) as usize;
        let read = file.read(&mut buffer[..want])?;
        if read == 0 {
            // The file shrank under us. The header already promised a length,
            // so there is nothing to say; closing is the only honest move.
            break;
        }
        if let Err(error) = writer.write_all(&buffer[..read]) {
            // A media element that seeks closes the connection mid-body, which
            // arrives here as a broken pipe. It is the normal case, not a
            // failure, and must not be logged per seek.
            return match error.kind() {
                std::io::ErrorKind::BrokenPipe | std::io::ErrorKind::ConnectionReset => Ok(()),
                _ => Err(error),
            };
        }
        remaining -= read as u64;
    }

    writer.flush()
}

fn respond_status(writer: &mut TcpStream, status: u16, phrase: &str) -> std::io::Result<()> {
    let head = format!(
        "HTTP/1.1 {status} {phrase}\r\n\
         Content-Length: 0\r\n\
         Access-Control-Allow-Origin: *\r\n\
         Connection: close\r\n\r\n"
    );
    writer.write_all(head.as_bytes())?;
    writer.flush()
}

/// A media type from the extension.
///
/// The container is sniffed by the decoder either way, so this only has to be
/// close enough not to mislead: WebKit checks it before opening a pipeline and
/// declines a `video/*` type it has no decoder registered for.
fn content_type(path: &Path) -> &'static str {
    let extension = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();

    match extension.as_str() {
        "mp4" | "m4v" => "video/mp4",
        "mov" | "qt" => "video/quicktime",
        "webm" => "video/webm",
        "mkv" => "video/x-matroska",
        "avi" => "video/x-msvideo",
        "ogv" | "ogg" => "video/ogg",
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_range_forms_a_media_element_sends() {
        // The opening probe: everything from zero.
        assert_eq!(parse_range("bytes=0-", 1000), Some((0, 999)));
        // A bounded read, which is what a seek turns into.
        assert_eq!(parse_range("bytes=200-399", 1000), Some((200, 399)));
        // A tail read, used to find a trailing index.
        assert_eq!(parse_range("bytes=-100", 1000), Some((900, 999)));
        // An end past the file is clamped rather than refused: the client asked
        // for "the rest" in the only way it knew the size at the time.
        assert_eq!(parse_range("bytes=900-5000", 1000), Some((900, 999)));
    }

    #[test]
    fn rejects_ranges_that_cannot_be_served() {
        assert_eq!(parse_range("bytes=1000-", 1000), None);
        assert_eq!(parse_range("bytes=500-400", 1000), None);
        assert_eq!(parse_range("bytes=0-10, 20-30", 1000), None);
        assert_eq!(parse_range("seconds=0-10", 1000), None);
        assert_eq!(parse_range("bytes=-0", 1000), None);
    }

    #[test]
    fn tokens_do_not_repeat() {
        let mut seen = std::collections::HashSet::new();
        for _ in 0..256 {
            assert!(seen.insert(mint_token()), "a token was minted twice");
        }
        assert_eq!(mint_token().len(), 32);
    }

    #[test]
    fn serves_a_real_file_by_range() {
        // End to end over a real socket: the header contract the media element
        // depends on is the thing worth testing, and it is cheap to test for
        // real rather than by inspecting a formatted string.
        let mut path = std::env::temp_dir();
        path.push(format!("workspace-media-test-{}.mp4", mint_token()));
        std::fs::write(&path, (0u8..=255).collect::<Vec<u8>>()).expect("write fixture");

        let url = media_stream_url(path.to_string_lossy().into_owned()).expect("grant a url");
        let token = url.rsplit('/').next().expect("a token").to_string();
        let port: u16 = url
            .trim_start_matches("http://127.0.0.1:")
            .split('/')
            .next()
            .and_then(|p| p.parse().ok())
            .expect("a port");

        let request = |head: &str| -> (String, Vec<u8>) {
            use std::net::TcpStream;
            let mut socket = TcpStream::connect((Ipv4Addr::LOCALHOST, port)).expect("connect");
            socket.write_all(head.as_bytes()).expect("send");
            let mut raw = Vec::new();
            socket.read_to_end(&mut raw).expect("read");
            let split = raw
                .windows(4)
                .position(|w| w == b"\r\n\r\n")
                .expect("a header terminator");
            (
                String::from_utf8_lossy(&raw[..split]).into_owned(),
                raw[split + 4..].to_vec(),
            )
        };

        let (headers, body) = request(&format!(
            "GET /m/{token} HTTP/1.1\r\nHost: 127.0.0.1\r\nRange: bytes=10-19\r\n\r\n"
        ));
        assert!(headers.starts_with("HTTP/1.1 206 Partial Content"), "{headers}");
        assert!(headers.contains("Content-Range: bytes 10-19/256"), "{headers}");
        assert!(headers.contains("Accept-Ranges: bytes"), "{headers}");
        assert_eq!(body, (10u8..20).collect::<Vec<u8>>());

        let (headers, body) =
            request(&format!("GET /m/{token} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n"));
        assert!(headers.starts_with("HTTP/1.1 200 OK"), "{headers}");
        assert!(headers.contains("Content-Type: video/mp4"), "{headers}");
        assert_eq!(body.len(), 256);

        // A revoked grant stops serving, which is what closing a tile relies on.
        media_release(token.clone()).expect("release");
        let (headers, _) = request(&format!("GET /m/{token} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n"));
        assert!(headers.starts_with("HTTP/1.1 404"), "{headers}");

        let (headers, _) = request("GET /nope HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n");
        assert!(headers.starts_with("HTTP/1.1 404"), "{headers}");

        let _ = std::fs::remove_file(&path);
    }
}

