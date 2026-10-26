// The desktop shell. It opens a native window, loads the built web app into the
// system WebView, and does one thing the browser cannot: hand the web app the
// operator's own message file from next to the executable. All logic lives in
// `src/` — see `doc/ROADMAP.md` for why the core stays portable.

use tauri::Manager;

/// The bundled default (`data/messages/DX.msg`), written next to the executable
/// on first run so there is a copy for the operator to edit. Compiled in, so the
/// file on disk and the fallback in `src/data/modeMessages.ts` are one text.
const DEFAULT_DX: &str = include_str!("../../data/messages/DX.msg");

/// Read `messages/<name>` from the app's data directory.
///
/// `None` means "no such file" (the web app then keeps its bundled default).
/// The first run writes the bundled DX file out first, because an empty folder
/// with a documented-but-missing file is a worse introduction than a file with
/// comments in it. An existing file is never touched or rewritten.
#[tauri::command]
fn read_mode_file(app: tauri::AppHandle, name: String) -> Result<Option<String>, String> {
    // A mode file, not anything on the disk: a plain name, no separators, no `..`.
    let plain = !name.is_empty()
        && name.len() <= 32
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-')
        && !name.contains("..");
    if !plain {
        return Err(format!("invalid mode file name: {name}"));
    }

    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("messages");
    let path = dir.join(&name);

    if !path.exists() {
        if name == "DX.msg" {
            std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
            std::fs::write(&path, DEFAULT_DX).map_err(|e| e.to_string())?;
        } else {
            return Ok(None);
        }
    }

    std::fs::read_to_string(&path)
        .map(Some)
        .map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![read_mode_file])
        .run(tauri::generate_context!())
        .expect("error while building tauri application");
}
