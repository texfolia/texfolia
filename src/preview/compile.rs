use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

/// When a compile may be requested. Extend this enum to add new triggers.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CompileEvent {
    Manual,
    Save,
}

/// Gate for compile requests. Flip or extend this to change when compiles run.
pub fn should_compile(event: CompileEvent) -> bool {
    matches!(event, CompileEvent::Manual | CompileEvent::Save)
}

/// How to invoke Tectonic for this session.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TectonicBackend {
    /// Local `tectonic` binary (absolute or PATH name).
    Cli(PathBuf),
    /// Run Tectonic inside Docker.
    Docker,
}

pub enum CompileMessage {
    Log(String),
    Done(Result<Vec<u8>, String>),
}

const DOCKER_IMAGE: &str = "dxjoke/tectonic-docker";

const TECTONIC_CANDIDATES: &[&str] = &[
    "tectonic",
    "/opt/homebrew/bin/tectonic",
    "/usr/local/bin/tectonic",
    "/home/linuxbrew/.linuxbrew/bin/tectonic",
];

const DOCKER_CANDIDATES: &[&str] = &[
    "docker",
    "/usr/local/bin/docker",
    "/opt/homebrew/bin/docker",
    "/Applications/Docker.app/Contents/Resources/bin/docker",
];

/// Locate a usable `tectonic` binary on this machine.
pub fn find_tectonic() -> Option<PathBuf> {
    for candidate in TECTONIC_CANDIDATES {
        if tectonic_works(Path::new(candidate)) {
            return Some(PathBuf::from(candidate));
        }
    }
    None
}

/// Locate the Docker CLI. Does not require the daemon to be running — GUI apps
/// often lack Homebrew/Docker in PATH, and `docker version` fails when the
/// engine is stopped even though the CLI is installed.
pub fn find_docker() -> Option<PathBuf> {
    for candidate in DOCKER_CANDIDATES {
        let path = PathBuf::from(candidate);
        if docker_cli_present(&path) {
            return Some(path);
        }
    }
    if let Some(home) = std::env::var_os("HOME") {
        let user_bin = PathBuf::from(home).join(".docker/bin/docker");
        if docker_cli_present(&user_bin) {
            return Some(user_bin);
        }
    }
    None
}

pub fn docker_available() -> bool {
    find_docker().is_some()
}

fn docker_cli_present(path: &Path) -> bool {
    // `--help` only needs the client binary; unlike `version` / `info` it does
    // not fail when Docker Desktop is installed but the daemon is stopped.
    Command::new(path)
        .arg("--help")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

/// Prefer a live CLI install; otherwise honor a remembered Docker preference.
pub fn resolve_backend(preferred: Option<&TectonicBackend>) -> Option<TectonicBackend> {
    if let Some(path) = find_tectonic() {
        return Some(TectonicBackend::Cli(path));
    }
    match preferred {
        Some(TectonicBackend::Docker) if docker_available() => Some(TectonicBackend::Docker),
        Some(TectonicBackend::Cli(path)) if tectonic_works(path) => {
            Some(TectonicBackend::Cli(path.clone()))
        }
        _ => None,
    }
}

fn tectonic_works(path: &Path) -> bool {
    Command::new(path)
        .arg("--version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

/// Install Tectonic with the platform package manager (currently Homebrew).
pub fn install_tectonic(tx: &async_channel::Sender<CompileMessage>) -> Result<PathBuf, String> {
    let brew = find_brew().ok_or_else(|| {
        "Homebrew was not found. Install Tectonic from https://tectonic-typesetting.github.io or choose Docker."
            .to_owned()
    })?;

    let _ = tx.send_blocking(CompileMessage::Log(format!(
        "Installing tectonic with `{} install tectonic`…",
        brew.display()
    )));

    let output = Command::new(&brew)
        .args(["install", "tectonic"])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|err| format!("failed to run brew: {err}"))?;

    push_output(tx, "brew stdout", &output.stdout);
    push_output(tx, "brew stderr", &output.stderr);

    if !output.status.success() {
        return Err("brew install tectonic failed".into());
    }

    find_tectonic().ok_or_else(|| {
        "tectonic installed but was not found on PATH. Restart Texfolia or choose Docker.".into()
    })
}

fn find_brew() -> Option<PathBuf> {
    for candidate in [
        "brew",
        "/opt/homebrew/bin/brew",
        "/usr/local/bin/brew",
        "/home/linuxbrew/.linuxbrew/bin/brew",
    ] {
        if Command::new(candidate)
            .arg("--version")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|status| status.success())
            .unwrap_or(false)
        {
            return Some(PathBuf::from(candidate));
        }
    }
    None
}

/// Compile LaTeX source to PDF bytes via the chosen Tectonic backend.
pub fn compile_latex(
    source: &str,
    backend: &TectonicBackend,
    tx: async_channel::Sender<CompileMessage>,
) {
    let result = compile_latex_inner(source, backend, &tx);
    let _ = tx.send_blocking(CompileMessage::Done(result));
}

fn compile_latex_inner(
    source: &str,
    backend: &TectonicBackend,
    tx: &async_channel::Sender<CompileMessage>,
) -> Result<Vec<u8>, String> {
    match backend {
        TectonicBackend::Cli(path) => {
            let _ = tx.send_blocking(CompileMessage::Log(format!(
                "Running `{}`…",
                path.display()
            )));
        }
        TectonicBackend::Docker => {
            let docker = find_docker().ok_or_else(|| {
                "Docker CLI was not found. Install Docker Desktop or ensure `docker` is on PATH."
                    .to_owned()
            })?;
            let _ = tx.send_blocking(CompileMessage::Log(format!(
                "Running tectonic via Docker (`{}`, image `{DOCKER_IMAGE}`, platform linux/amd64)…\nIf this fails, start Docker Desktop and retry.",
                docker.display()
            )));
        }
    }

    let work = tempfile::tempdir().map_err(|err| format!("temp dir: {err}"))?;
    let tex_path = work.path().join("texput.tex");
    {
        let mut file =
            std::fs::File::create(&tex_path).map_err(|err| format!("write source: {err}"))?;
        file.write_all(source.as_bytes())
            .map_err(|err| format!("write source: {err}"))?;
    }

    let output = match backend {
        TectonicBackend::Cli(path) => Command::new(path)
            .arg("--outdir")
            .arg(work.path())
            .arg("--keep-logs")
            .arg(&tex_path)
            .current_dir(work.path())
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .output()
            .map_err(|err| format!("failed to run tectonic: {err}"))?,
        TectonicBackend::Docker => {
            let docker = find_docker().ok_or_else(|| {
                "Docker CLI was not found. Install Docker Desktop or ensure `docker` is on PATH."
                    .to_owned()
            })?;
            let mount = format!("{}:/work", work.path().display());
            // dxjoke/tectonic-docker is amd64-only; without --platform, Apple Silicon
            // fails with exit 125 ("no matching manifest for linux/arm64").
            Command::new(&docker)
                .args([
                    "run",
                    "--rm",
                    "--platform",
                    "linux/amd64",
                    "-v",
                    &mount,
                    "-w",
                    "/work",
                    DOCKER_IMAGE,
                    "tectonic",
                    "--outdir",
                    "/work",
                    "--keep-logs",
                    "texput.tex",
                ])
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .output()
                .map_err(|err| {
                    format!(
                        "failed to run docker: {err}. Is Docker Desktop / the daemon running?"
                    )
                })?
        }
    };

    push_output(tx, "stdout", &output.stdout);
    push_output(tx, "stderr", &output.stderr);

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        if stderr.contains("docker.sock")
            || stderr.contains("Cannot connect to the Docker daemon")
            || stderr.contains("failed to connect to the docker API")
        {
            return Err(
                "Docker CLI is installed, but the daemon is not running. Start Docker Desktop and try again."
                    .into(),
            );
        }
        if stderr.contains("no matching manifest") || stderr.contains("platform")
        {
            return Err(format!(
                "Docker could not run `{DOCKER_IMAGE}` for this platform. Ensure Docker Desktop is running and can pull linux/amd64 images.\n{stderr}"
            ));
        }
        let code = output
            .status
            .code()
            .map(|c| c.to_string())
            .unwrap_or_else(|| "signal".into());
        let detail = stderr.trim();
        if detail.is_empty() {
            return Err(format!("tectonic exited with status {code}"));
        }
        return Err(format!("tectonic exited with status {code}: {detail}"));
    }

    let pdf_path = work.path().join("texput.pdf");
    std::fs::read(&pdf_path).map_err(|err| format!("read PDF {}: {err}", pdf_path.display()))
}

fn push_output(tx: &async_channel::Sender<CompileMessage>, label: &str, bytes: &[u8]) {
    if bytes.is_empty() {
        return;
    }
    let text = String::from_utf8_lossy(bytes);
    let _ = tx.send_blocking(CompileMessage::Log(format!("----- {label} -----")));
    for line in text.lines() {
        let _ = tx.send_blocking(CompileMessage::Log(line.to_owned()));
    }
}

#[cfg(test)]
mod tests {
    use super::{CompileEvent, TectonicBackend, should_compile};

    #[test]
    fn manual_and_save_compile_by_default() {
        assert!(should_compile(CompileEvent::Manual));
        assert!(should_compile(CompileEvent::Save));
    }

    #[test]
    fn docker_backend_is_distinct_from_cli() {
        assert_ne!(
            TectonicBackend::Docker,
            TectonicBackend::Cli("tectonic".into())
        );
    }

    #[test]
    fn docker_cli_detection_does_not_require_daemon() {
        // On CI without Docker this is fine either way; the important property is
        // that we never treat a stopped daemon as "CLI missing" when the binary exists.
        if std::path::Path::new("/usr/local/bin/docker").exists()
            || std::path::Path::new("/Applications/Docker.app/Contents/Resources/bin/docker")
                .exists()
        {
            assert!(
                super::find_docker().is_some(),
                "Docker CLI is on disk but was not detected"
            );
        }
    }
}
