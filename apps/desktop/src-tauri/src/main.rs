// Tauri requires this attribute on the Windows target so the app does not
// open a console window alongside the main window.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// Only used by the `.setup()` devtools hook below, which is itself
// `#[cfg(debug_assertions)]`-gated - so this import is genuinely unused (and
// would warn) in a release build.
#[cfg(debug_assertions)]
use tauri::Manager;

/// IPC command: open a native folder picker and return the chosen path.
///
/// Called by the web layer when the user clicks "Open vault folder". Returns
/// `None` when the user dismisses the dialog without choosing.
///
/// This is the bridge between the Tauri `StorageAdapter` shim (Milestone 16)
/// and the existing `StorageAdapter` interface defined in
/// `apps/web/lib/vault/storage/index.ts`.  The web layer calls:
///
/// ```ts
/// import { invoke } from '@tauri-apps/api/core';
/// const folderPath: string | null = await invoke('pick_vault_folder');
/// ```
#[tauri::command]
async fn pick_vault_folder(app: tauri::AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    use tauri_plugin_fs::FsExt;

    // `pick_folder()` is callback-based, not `Future`-returning, in
    // tauri-plugin-dialog 2.x - it never had an `.await` to give (this command
    // never actually compiled until this fix). `blocking_pick_folder()` is the
    // crate's own documented way to call it from an `async fn` Tauri command
    // (Tauri commands run off the main thread by default, so blocking here is
    // safe, per the crate's own doc example for this exact pattern).
    let path = app
        .dialog()
        .file()
        .set_title("Open GraphVault folder")
        .blocking_pick_folder();

    // `blocking_pick_folder` returns `FilePath`, not `PathBuf` - it can be a
    // plain path OR a `file://`/Android `content://` URI depending on the
    // platform's native dialog. `.into_path()` normalizes both to a real OS
    // path (converting a `file://` URL via `Url::to_file_path()`); a bare
    // `Display`/`to_string()` would have left a URI unconverted for the Url
    // variant, which the caller (plain filesystem read/write) cannot use.
    let Some(p) = path else {
        return Ok(None);
    };
    let path_buf = p
        .into_path()
        .map_err(|e| format!("Could not resolve picked folder to a path: {e}"))?;

    // The fs plugin's *static* scope (`tauri.conf.json` → `plugins.fs.scope`)
    // is deliberately empty - no path is pre-approved at build time. This is
    // the one and only place a path is ever granted: the folder the user just
    // explicitly chose, via the native picker, moments ago. Without this call
    // every subsequent `@tauri-apps/plugin-fs` read/write the web layer makes
    // (via `TauriStorageAdapter`) is denied by the scope check, even though
    // the `fs:read-all`/`fs:write-all` capability permits the *commands* -
    // permission (which commands) and scope (which paths) are independent
    // gates, and this is the scope one.
    app.fs_scope()
        .allow_directory(&path_buf, true)
        .map_err(|e| format!("Could not grant filesystem access to the picked folder: {e}"))?;

    Ok(Some(path_buf.to_string_lossy().into_owned()))
}

/// IPC command: return the Tauri app version from the bundle metadata.
/// Exposed to the web layer for display in Settings → About.
#[tauri::command]
fn app_version(app: tauri::AppHandle) -> String {
    app.package_info().version.to_string()
}

fn main() {
    tauri::Builder::default()
        // File-system plugin: exposes read/write/watch commands to the webview.
        // The scope is intentionally empty here - the web layer uses
        // `pick_vault_folder` to get the path, then fs operations are scoped to
        // that directory by the configuration in `tauri.conf.json`.
        .plugin(tauri_plugin_fs::init())
        // Dialog plugin: used by `pick_vault_folder` above.
        .plugin(tauri_plugin_dialog::init())
        // Register our custom IPC commands.
        .invoke_handler(tauri::generate_handler![pick_vault_folder, app_version])
        .setup(|_app| {
            // In development, open the devtools so errors are visible.
            #[cfg(debug_assertions)]
            {
                if let Some(window) = _app.get_webview_window("main") {
                    window.open_devtools();
                }
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running GraphVault desktop app");
}
