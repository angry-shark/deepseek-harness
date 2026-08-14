//! Server-launch logic for the desktop shell, kept free of Tauri imports so
//! unit tests can exercise it under plain `cargo test`.
//!
//! The shell never opens the browser itself: it spawns the built `dsh` CLI
//! with a bundled Node binary (`--expose-internals`), with `--port 0` so the
//! OS picks a free port, and treats the `dsh web:` stdout line as the
//! readiness signal. The harness prints that line only after its Loader tree
//! settles, so the URL never announces a half-mounted server.

use std::path::{Path, PathBuf};

/// The `dsh web:` readiness line, as the web-app bundle prints it.
pub const SERVER_URL_PATTERN: &str = "dsh web: ";

/// How long a server may take to print its URL line before the shell gives up.
pub const SERVER_READY_TIMEOUT_MS: u64 = 45_000;

/// Grace period after SIGTERM before the shell force-kills a stuck server.
pub const FORCE_KILL_DELAY_MS: u64 = 5_000;

/// The harness engine floor, mirroring the repo's Node engine range.
const NODE_ENGINE_FLOOR_MAJOR: u32 = 22;
const NODE_ENGINE_FLOOR_MINOR: u32 = 19;
const NODE_ENGINE_MAJOR_FLOOR: u32 = 24;

/// The dsh CLI invocation the shell spawns.
pub struct ServerInvocation {
    /// The Node binary to spawn: the bundled runtime in a packaged app, `node` from PATH in dev.
    pub executable: String,
    /// Arguments: the built dsh bin, the web profile, and an OS-assigned port.
    pub args: Vec<String>,
}

/// Where the assembled dsh runtime lands on a source checkout.
const DEV_RUNTIME_DIR: &str = "build/dsh-runtime";

/// The runtime directory name inside the bundle resources.
pub const PACKAGED_RUNTIME_DIR: &str = "dsh-runtime";

/// The bundled Node binary name inside the bundle resources.
#[cfg(windows)]
pub const PACKAGED_NODE_BIN: &str = "node.exe";
#[cfg(not(windows))]
pub const PACKAGED_NODE_BIN: &str = "node";

/// Resolve the root of the assembled dsh runtime: `Resources/dsh-runtime` in a
/// packaged app, `<crate>/../build/dsh-runtime` on a source checkout.
/// @param resource_dir - `app.path().resource_dir()` in a packaged app; `None` in dev.
pub fn runtime_root(resource_dir: Option<&Path>) -> PathBuf {
    match resource_dir {
        Some(dir) => dir.join(PACKAGED_RUNTIME_DIR),
        None => {
            let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
            manifest.join("..").join(DEV_RUNTIME_DIR)
        }
    }
}

/// Resolve the built dsh CLI entry inside an assembled runtime root. The dsh
/// package and its closure nest under a `dsh/` directory.
pub fn resolve_dsh_bin(runtime_root: &Path) -> PathBuf {
    runtime_root.join("dsh").join("lib").join("bin.js")
}

/// Build the child-process invocation that boots the harness Web server.
pub fn server_invocation(node_bin: &str, dsh_bin: &Path) -> ServerInvocation {
    ServerInvocation {
        executable: node_bin.to_string(),
        // --expose-internals: the harness's config-watch HMR service requires
        // Node internals access, so the shell passes the flag explicitly.
        args: vec![
            "--expose-internals".into(),
            dsh_bin.to_string_lossy().into_owned(),
            "--profile".into(),
            "web".into(),
            "--port".into(),
            "0".into(),
        ],
    }
}

/// Extract the harness URL from one line of server stdout.
/// @returns the ready URL, or `None` when the line is not the URL line.
pub fn parse_server_url(line: &str) -> Option<String> {
    let idx = line.find(SERVER_URL_PATTERN)?;
    let rest = line[idx + SERVER_URL_PATTERN.len()..].trim_start();
    let url = rest.split_whitespace().next()?;
    (url.starts_with("http://") || url.starts_with("https://")).then(|| url.to_string())
}

/// Whether a Node version satisfies the harness engine floor (^22.19 || >=24).
/// @param version - a `node --version` string such as `v24.14.0`.
pub fn satisfies_node_engine(version: &str) -> bool {
    let Some(trimmed) = version.trim().strip_prefix('v') else {
        return false
    };
    let mut parts = trimmed.split('.');
    let Some(major) = parts.next().and_then(|p| p.parse::<u32>().ok()) else {
        return false
    };
    let Some(minor) = parts.next().and_then(|p| p.parse::<u32>().ok()) else {
        return false
    };
    if major == NODE_ENGINE_FLOOR_MAJOR {
        minor >= NODE_ENGINE_FLOOR_MINOR
    } else {
        major >= NODE_ENGINE_MAJOR_FLOOR
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_url_line() {
        assert_eq!(
            parse_server_url("dsh web: http://127.0.0.1:65131"),
            Some("http://127.0.0.1:65131".into())
        );
    }

    #[test]
    fn ignores_prefix_and_suffix_on_the_url_line() {
        assert_eq!(
            parse_server_url("[boot] dsh web: https://localhost:8080/something trailing"),
            Some("https://localhost:8080/something".into())
        );
    }

    #[test]
    fn rejects_non_url_lines() {
        assert_eq!(parse_server_url("dsh web: not a url"), None);
        assert_eq!(parse_server_url("dsh web: ftp://x"), None);
        assert_eq!(parse_server_url("dsh boot: http://x"), None);
        assert_eq!(parse_server_url(""), None);
    }

    #[test]
    fn engine_floor_boundaries() {
        assert!(!satisfies_node_engine("v22.18.9"));
        assert!(satisfies_node_engine("v22.19.0"));
        assert!(satisfies_node_engine("v22.19.1"));
        assert!(!satisfies_node_engine("v23.0.0"));
        assert!(satisfies_node_engine("v24.0.0"));
        assert!(satisfies_node_engine("v24.14.0"));
        assert!(!satisfies_node_engine("garbage"));
        assert!(!satisfies_node_engine(""));
    }

    #[test]
    fn builds_the_spawn_invocation() {
        let invocation = server_invocation("/opt/node", Path::new("/rt/dsh/lib/bin.js"));
        assert_eq!(invocation.executable, "/opt/node");
        assert_eq!(
            invocation.args,
            vec![
                "--expose-internals",
                "/rt/dsh/lib/bin.js",
                "--profile",
                "web",
                "--port",
                "0"
            ]
        );
    }

    #[test]
    fn resolves_runtime_roots() {
        assert_eq!(
            runtime_root(Some(Path::new("/Resources"))),
            PathBuf::from("/Resources/dsh-runtime")
        );
        let dev = runtime_root(None);
        assert_eq!(dev, PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../build/dsh-runtime"));
        assert_eq!(resolve_dsh_bin(&dev), dev.join("dsh/lib/bin.js"));
    }
}
