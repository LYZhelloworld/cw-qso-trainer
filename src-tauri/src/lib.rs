// The desktop shell. It does exactly one thing: open a native window and load
// the built web app into the system WebView. All logic lives in `src/` — see
// `doc/ROADMAP.md` for why the core stays portable.

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .run(tauri::generate_context!())
    .expect("error while building tauri application");
}
