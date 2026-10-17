use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};

use gpui_kit::{Image, ImageFormat};
use pdfium_render::prelude::*;

static PDFIUM: OnceLock<Result<Pdfium, String>> = OnceLock::new();

fn pdfium() -> Result<&'static Pdfium, String> {
    PDFIUM
        .get_or_init(|| {
            let name = Pdfium::pdfium_platform_library_name();
            let name = name.to_string_lossy();
            let candidates = pdfium_candidates(name.as_ref());
            let mut last_err = None;
            for path in &candidates {
                match Pdfium::bind_to_library(path) {
                    Ok(bindings) => return Ok(Pdfium::new(bindings)),
                    Err(err) => last_err = Some((path.clone(), err)),
                }
            }
            match Pdfium::bind_to_system_library() {
                Ok(bindings) => Ok(Pdfium::new(bindings)),
                Err(system_err) => {
                    let tried = candidates
                        .iter()
                        .map(|path| path.display().to_string())
                        .collect::<Vec<_>>()
                        .join(", ");
                    let detail = last_err
                        .map(|(path, err)| format!("{path}: {err}", path = path.display()))
                        .unwrap_or_else(|| system_err.to_string());
                    Err(format!(
                        "failed to load Pdfium ({detail}). Tried: [{tried}]. \
                         Rebuild so build.rs can fetch {name}, or set PDFIUM_LIB_PATH / place {name} next to the binary \
                         (or in Contents/Frameworks for a macOS .app)."
                    ))
                }
            }
        })
        .as_ref()
        .map_err(|err| err.clone())
}

/// Search order for the shipped dynamic library.
///
/// 1. `PDFIUM_LIB_PATH` if set
/// 2. Next to the executable (cargo build + simple packaging)
/// 3. `../Frameworks/` relative to the executable (macOS `.app` layout)
/// 4. Current working directory
fn pdfium_candidates(lib_name: &str) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    if let Ok(explicit) = std::env::var("PDFIUM_LIB_PATH") {
        paths.push(PathBuf::from(explicit));
    }
    if let Ok(exe) = std::env::current_exe()
        && let Some(dir) = exe.parent()
    {
        paths.push(dir.join(lib_name));
        // MyApp.app/Contents/MacOS/app → MyApp.app/Contents/Frameworks/libpdfium.dylib
        paths.push(dir.join("..").join("Frameworks").join(lib_name));
    }
    paths.push(Path::new(".").join(lib_name));
    paths
}

/// Render each PDF page to a GPUI image (PNG bytes).
pub fn render_pdf_pages(pdf_bytes: Vec<u8>, target_width: i32) -> Result<Vec<Arc<Image>>, String> {
    let pdfium = pdfium()?;
    let document = pdfium
        .load_pdf_from_byte_vec(pdf_bytes, None)
        .map_err(|err| format!("failed to open PDF: {err}"))?;

    let config = PdfRenderConfig::new()
        .set_target_width(target_width)
        .set_maximum_height(target_width * 2);

    let mut pages = Vec::with_capacity(document.pages().len() as usize);
    for (index, page) in document.pages().iter().enumerate() {
        let image = page
            .render_with_config(&config)
            .map_err(|err| format!("failed to render page {}: {err}", index + 1))?
            .as_image()
            .map_err(|err| format!("failed to convert page {}: {err}", index + 1))?;

        let mut png = Vec::new();
        image
            .write_to(&mut Cursor::new(&mut png), image::ImageFormat::Png)
            .map_err(|err| format!("failed to encode page {}: {err}", index + 1))?;
        pages.push(Arc::new(Image::from_bytes(ImageFormat::Png, png)));
    }

    if pages.is_empty() {
        return Err("PDF has no pages".into());
    }
    Ok(pages)
}
