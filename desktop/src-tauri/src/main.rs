//! dsh-desktop — the Tauri shell. It spawns the built dsh CLI with the bundled
//! Node binary, waits for the harness `dsh web:` readiness line, and hosts the
//! served Web GUI in a native WebView window. Closing the window stops the
//! server; the server stopping on its own reports and quits the app.

use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};

use crate::server::{
    parse_server_url, resolve_dsh_bin, runtime_root, satisfies_node_engine, server_invocation,
    FORCE_KILL_DELAY_MS, PACKAGED_NODE_BIN, PACKAGED_RUNTIME_DIR, SERVER_READY_TIMEOUT_MS,
};

mod server;

/// The product name shown in window titles and error dialogs.
const PRODUCT_NAME: &str = "DeepSeek Harness";

/// How much server stderr to keep for diagnostics.
const STDERR_TAIL_BYTES: usize = 4_000;

/// The live server child and the state the shell threads share.
struct ServerState {
    pid: u32,
    child: Arc<Mutex<Option<Child>>>,
    /// Set once the shell asked the server to stop; the exit handler then stays silent.
    stopping: Arc<AtomicBool>,
    /// Set once the child exited; the force-kill timer then stays silent.
    exited: Arc<AtomicBool>,
    /// Set once the harness printed its URL.
    url: Arc<Mutex<Option<String>>>,
    stderr_tail: Arc<Mutex<String>>,
}

/// Show a blocking error dialog and quit the app.
fn fatal(handle: &AppHandle, message: &str) {
    handle
        .dialog()
        .message(message)
        .title(PRODUCT_NAME)
        .kind(MessageDialogKind::Error)
        .blocking_show();
    handle.exit(1);
}

/// Open the Web GUI once the harness printed its URL.
fn show_window(handle: &AppHandle, url: &str) {
    let Ok(parsed) = url.parse::<tauri::Url>() else {
        fatal(handle, &format!("The harness printed an unparseable URL: {url}"));
        return
    };
    let origin = parsed.origin().ascii_serialization();
    let window = WebviewWindowBuilder::new(handle, "main", WebviewUrl::External(parsed))
        .title(PRODUCT_NAME)
        // Undecorated: the custom titlebar rendered by the GUI owns the close /
        // maximize / minimize controls and the drag region (see the
        // window-controls capability).
        .decorations(false)
        .inner_size(1280.0, 820.0)
        .min_inner_size(800.0, 600.0)
        .on_navigation(move |target| {
            // Keep the window inside the harness origin: a full navigation away
            // would strand the server with no visible surface. Everything else
            // opens in the system browser.
            let same_origin = target.origin().ascii_serialization() == origin;
            if !same_origin {
                let _ = open::that_detached(target.as_str());
            }
            same_origin
        })
        .on_new_window(|target, _features| {
            let _ = open::that_detached(target.as_str());
            tauri::webview::NewWindowResponse::Deny
        })
        .build();
    if let Err(error) = window {
        fatal(handle, &format!("Failed to open the harness window: {error}"));
    }
}

/// Send SIGTERM, then SIGKILL after a grace period when the child still runs.
fn stop_server(state: &ServerState) {
    if state.stopping.swap(true, Ordering::SeqCst) {
        return
    }
    terminate(state, false);
    #[cfg(unix)]
    {
        let (exited, pid) = (state.exited.clone(), state.pid);
        thread::spawn(move || {
            thread::sleep(Duration::from_millis(FORCE_KILL_DELAY_MS));
            if !exited.load(Ordering::SeqCst) {
                unsafe {
                    libc::kill(pid as libc::pid_t, libc::SIGKILL);
                }
            }
        });
    }
}

/// Terminate the child: SIGTERM on unix (the graceful path), `Child::kill` on
/// Windows, where no signal mechanism exists and termination is immediate.
#[cfg(unix)]
fn terminate(state: &ServerState, force: bool) {
    let signal = if force { libc::SIGKILL } else { libc::SIGTERM };
    unsafe {
        libc::kill(state.pid as libc::pid_t, signal);
    }
}

#[cfg(windows)]
fn terminate(state: &ServerState, _force: bool) {
    if let Ok(mut guard) = state.child.lock() {
        if let Some(child) = guard.as_mut() {
            let _ = child.kill();
        }
    }
}

/// Report an unexpected server exit, then quit.
fn report_exit(handle: &AppHandle, state: &ServerState, status: std::process::ExitStatus) {
    let tail = state.stderr_tail.lock().expect("stderr tail lock").clone();
    let code = status.code().map(|c| format!("code {c}")).unwrap_or_else(|| "no code".into());
    let detail = format!("The harness server exited ({code}).");
    let detail = if tail.is_empty() { detail } else { format!("{detail}\n\nLast server output:\n{tail}") };
    handle
        .dialog()
        .message(detail)
        .title(PRODUCT_NAME)
        .kind(MessageDialogKind::Error)
        .blocking_show();
    handle.exit(1);
}

/// Which Node binary the shell spawns: the bundled one in a packaged app,
/// `node` from PATH (or `NODE_BIN`) in dev.
fn node_bin(handle: &AppHandle, packaged: bool) -> PathBuf {
    if packaged {
        if let Ok(dir) = handle.path().resource_dir() {
            return dir.join(PACKAGED_NODE_BIN)
        }
    }
    if let Ok(override_bin) = std::env::var("NODE_BIN") {
        return PathBuf::from(override_bin)
    }
    PathBuf::from("node")
}

/// Whether the shell runs from a packaged bundle: the assembled runtime is a
/// bundled resource only there, so its presence marks the packaged layout.
fn is_packaged(handle: &AppHandle) -> bool {
    handle
        .path()
        .resource_dir()
        .map(|dir| dir.join(PACKAGED_RUNTIME_DIR).exists())
        .unwrap_or(false)
}

/// Boot the harness server and drive the window from its readiness line.
fn start_server(app: &tauri::App) {
    let handle = app.handle().clone();
    let packaged = is_packaged(&handle);
    let node = node_bin(&handle, packaged);
    let runtime = runtime_root(handle.path().resource_dir().ok().as_deref().filter(|_| packaged));

    // Version probe: the engine floor applies to the bundled runtime too.
    match Command::new(&node).arg("--version").output() {
        Ok(output) => {
            let version = String::from_utf8_lossy(&output.stdout);
            if !satisfies_node_engine(&version) {
                fatal(
                    &handle,
                    &format!(
                        "The bundled Node runtime reports {version}, which is below the harness engine floor (^22.19 || >=24). The harness may fail at runtime."
                    ),
                );
                return
            }
        }
        Err(error) => {
            fatal(&handle, &format!("Failed to run the Node runtime ({node:?}): {error}"));
            return
        }
    }

    let invocation = server_invocation(node.to_str().expect("node path is not UTF-8"), &resolve_dsh_bin(&runtime));
    let mut child = match Command::new(&invocation.executable)
        .args(&invocation.args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .current_dir(std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE")).unwrap_or_else(|_| "/".into()))
        .spawn()
    {
        Ok(child) => child,
        Err(error) => {
            fatal(&handle, &format!("Failed to start the harness server: {error}"));
            return
        }
    };
    let pid = child.id();
    let stdout = child.stdout.take().expect("no stdout pipe");
    let stderr = child.stderr.take().expect("no stderr pipe");
    let state = Arc::new(ServerState {
        pid,
        child: Arc::new(Mutex::new(Some(child))),
        stopping: Arc::new(AtomicBool::new(false)),
        exited: Arc::new(AtomicBool::new(false)),
        url: Arc::new(Mutex::new(None)),
        stderr_tail: Arc::new(Mutex::new(String::new())),
    });
    app.manage(state.clone());

    // Readiness watcher: the URL line on stdout means the Loader tree settled.
    {
        let (state, handle) = (state.clone(), handle.clone());
        thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines().map_while(Result::ok) {
                eprintln!("[dsh] {line}");
                if let Some(url) = parse_server_url(&line) {
                    *state.url.lock().expect("url lock") = Some(url.clone());
                    let window_handle = handle.clone();
                    let _ = handle.run_on_main_thread(move || show_window(&window_handle, &url));
                    break;
                }
            }
        });
    }

    // Stderr tail: kept for the diagnostics in exit and timeout dialogs.
    {
        let state = state.clone();
        thread::spawn(move || {
            let mut tail = String::new();
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                eprintln!("[dsh] {line}");
                tail.push_str(&line);
                tail.push('\n');
                if tail.len() > STDERR_TAIL_BYTES {
                    tail = tail.chars().skip(tail.len() - STDERR_TAIL_BYTES).collect();
                }
            }
            *state.stderr_tail.lock().expect("stderr tail lock") = tail;
        });
    }

    // Exit watcher: reports an unexpected exit; the stopping flag silences it.
    {
        let (state, handle) = (state.clone(), handle.clone());
        thread::spawn(move || loop {
            let status = {
                let mut guard = state.child.lock().expect("child lock");
                match guard.as_mut().and_then(|c| c.try_wait().ok()).flatten() {
                    Some(status) => {
                        *guard = None;
                        Some(status)
                    }
                    None => None,
                }
            };
            if let Some(status) = status {
                state.exited.store(true, Ordering::SeqCst);
                if !state.stopping.load(Ordering::SeqCst) {
                    let (report_handle, report_state) = (handle.clone(), state.clone());
                    let _ = handle.run_on_main_thread(move || report_exit(&report_handle, &report_state, status));
                }
                return
            }
            thread::sleep(Duration::from_millis(200));
        });
    }

    // Readiness timeout: the server never printed its URL.
    {
        let state = state.clone();
        thread::spawn(move || {
            thread::sleep(Duration::from_millis(SERVER_READY_TIMEOUT_MS));
            if state.url.lock().expect("url lock").is_none() {
                let tail = state.stderr_tail.lock().expect("stderr tail lock").clone();
                let detail = format!(
                    "The harness server did not become ready within {} seconds.",
                    SERVER_READY_TIMEOUT_MS / 1_000
                );
                let detail = if tail.is_empty() { detail } else { format!("{detail}\n\nLast server output:\n{tail}") };
                let (dialog_handle, dialog_state) = (handle.clone(), state.clone());
                let _ = handle.run_on_main_thread(move || {
                    let tail = dialog_state.stderr_tail.lock().expect("stderr tail lock").clone();
                    let detail = if tail.is_empty() { detail } else { format!("{detail}\n\nLast server output:\n{tail}") };
                    fatal(&dialog_handle, &detail)
                });
            }
        });
    }
}

/// Quit after a graceful stop: SIGTERM, then a bounded wait, then exit; the
/// exit handler force-kills whatever still runs.
fn request_quit(app_handle: &AppHandle) {
    let deadline = Instant::now() + Duration::from_millis(FORCE_KILL_DELAY_MS);
    if let Some(state) = app_handle.try_state::<ServerState>() {
        stop_server(&state);
        while Instant::now() < deadline && !state.exited.load(Ordering::SeqCst) {
            thread::sleep(Duration::from_millis(100));
        }
    }
    app_handle.exit(0);
}

fn main() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            start_server(app);
            Ok(())
        });

    builder
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| match event {
            RunEvent::WindowEvent {
                event: WindowEvent::Destroyed,
                ..
            } => request_quit(app_handle),
            RunEvent::Exit => {
                // Whatever path quits the app, the server must not survive it:
                // a second launch would find the old port owner gone but the
                // harness still serving. SIGKILL here only reaches a child the
                // grace period already failed to stop.
                if let Some(state) = app_handle.try_state::<ServerState>() {
                    if !state.exited.load(Ordering::SeqCst) {
                        terminate(&state, true);
                    }
                }
            }
            _ => {}
        });
}
