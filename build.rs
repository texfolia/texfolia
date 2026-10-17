//! Fetch a platform Pdfium dylib and copy it next to the built binary.
//!
//! At runtime the app loads that library via `Pdfium::bind_to_library`.
//! Skip with `PDFIUM_SKIP_DOWNLOAD=1` when you already ship the library.

use std::env;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Command;

/// Pinned bblanchon/pdfium-binaries release for reproducible builds.
const PDFIUM_RELEASE: &str = "chromium/8100";

fn main() {
    let target_os = env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    let target_arch = env::var("CARGO_CFG_TARGET_ARCH").unwrap_or_default();

    println!("cargo:rerun-if-env-changed=PDFIUM_SKIP_DOWNLOAD");
    println!("cargo:rerun-if-env-changed=PDFIUM_LIB_PATH");
    println!("cargo:rerun-if-changed=build.rs");

    let Some(lib_name) = library_name(&target_os) else {
        println!(
            "cargo:warning=Pdfium auto-fetch is not configured for {target_os}/{target_arch}; place the library next to the binary manually"
        );
        return;
    };

    let profile = env::var("PROFILE").unwrap_or_else(|_| "debug".into());
    let target_dir = env::var_os("CARGO_TARGET_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("target"));
    let out_dir = target_dir.join(&profile);
    let dest = out_dir.join(lib_name);

    if let Ok(explicit) = env::var("PDFIUM_LIB_PATH") {
        let src = PathBuf::from(explicit);
        copy_library(&src, &dest);
        return;
    }

    if env::var_os("PDFIUM_SKIP_DOWNLOAD").is_some() {
        if !dest.exists() {
            println!(
                "cargo:warning=PDFIUM_SKIP_DOWNLOAD set and {} is missing; PDF preview will fail until you provide it",
                dest.display()
            );
        }
        return;
    }

    let Some(archive) = archive_name(&target_os, &target_arch) else {
        println!(
            "cargo:warning=no Pdfium archive mapped for {target_os}/{target_arch}; place {lib_name} next to the binary"
        );
        return;
    };

    let cache = target_dir.join("pdfium-cache").join(PDFIUM_RELEASE.replace('/', "_"));
    fs::create_dir_all(&cache).expect("create pdfium cache");
    let archive_path = cache.join(archive);
    let extracted_lib = cache.join(lib_name);

    // Re-run when the shipped copy is deleted so `cargo build` restores it.
    println!("cargo:rerun-if-changed={}", dest.display());

    if !extracted_lib.exists() {
        if !archive_path.exists() {
            let url = format!(
                "https://github.com/bblanchon/pdfium-binaries/releases/download/{PDFIUM_RELEASE}/{archive}"
            );
            eprintln!("Downloading Pdfium from {url}");
            download(&url, &archive_path);
        }
        extract_library(&archive_path, &cache, lib_name);
    }

    fs::create_dir_all(&out_dir).expect("create target profile dir");
    if !dest.exists() {
        copy_library(&extracted_lib, &dest);
        eprintln!("Bundled Pdfium at {}", dest.display());
    }
}

fn library_name(os: &str) -> Option<&'static str> {
    match os {
        "macos" => Some("libpdfium.dylib"),
        "linux" => Some("libpdfium.so"),
        "windows" => Some("pdfium.dll"),
        _ => None,
    }
}

fn archive_name(os: &str, arch: &str) -> Option<&'static str> {
    match (os, arch) {
        ("macos", "aarch64") => Some("pdfium-mac-arm64.tgz"),
        ("macos", "x86_64") => Some("pdfium-mac-x64.tgz"),
        ("linux", "aarch64") => Some("pdfium-linux-arm64.tgz"),
        ("linux", "x86_64") => Some("pdfium-linux-x64.tgz"),
        ("windows", "aarch64") => Some("pdfium-win-arm64.tgz"),
        ("windows", "x86_64") => Some("pdfium-win-x64.tgz"),
        _ => None,
    }
}

fn download(url: &str, dest: &Path) {
    let tmp = dest.with_extension("download");
    let status = Command::new("curl")
        .args(["-fL", "--retry", "3", "-o"])
        .arg(&tmp)
        .arg(url)
        .status()
        .unwrap_or_else(|err| panic!("failed to run curl (install curl or set PDFIUM_LIB_PATH): {err}"));
    if !status.success() {
        let _ = fs::remove_file(&tmp);
        panic!("curl failed downloading {url} (status {status})");
    }
    fs::rename(&tmp, dest).expect("finalize Pdfium download");
}

fn extract_library(archive: &Path, dest_dir: &Path, lib_name: &str) {
    // Archives contain lib/<name>; extract only that member.
    let member = format!("lib/{lib_name}");
    let status = Command::new("tar")
        .args(["-xzf"])
        .arg(archive)
        .arg("-C")
        .arg(dest_dir)
        .arg(&member)
        .status()
        .unwrap_or_else(|err| panic!("failed to run tar: {err}"));
    if !status.success() {
        panic!("tar failed extracting {member} from {}", archive.display());
    }
    let nested = dest_dir.join("lib").join(lib_name);
    let flat = dest_dir.join(lib_name);
    if nested.exists() {
        fs::rename(&nested, &flat).expect("move extracted Pdfium library");
        let _ = fs::remove_dir(dest_dir.join("lib"));
    }
    if !flat.exists() {
        panic!("expected {} after extract", flat.display());
    }
}

fn copy_library(src: &Path, dest: &Path) {
    if !src.exists() {
        panic!("Pdfium library not found at {}", src.display());
    }
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).expect("create Pdfium destination dir");
    }
    // Skip rewrite when identical size already present.
    if dest.exists()
        && let (Ok(a), Ok(b)) = (fs::metadata(src), fs::metadata(dest))
        && a.len() == b.len()
    {
        return;
    }
    fs::copy(src, dest).unwrap_or_else(|err| {
        panic!(
            "failed to copy Pdfium from {} to {}: {err}",
            src.display(),
            dest.display()
        )
    });
    // Touch so cargo doesn't treat a no-op oddly; also verify readable.
    let mut probe = fs::File::open(dest).expect("open bundled Pdfium");
    let mut buf = [0u8; 4];
    let _ = probe.read(&mut buf);
}
