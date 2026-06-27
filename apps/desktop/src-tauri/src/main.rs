// Tauri requires this attribute on the Windows target so the app does not
// open a console window alongside the main window.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

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

    let path = app
        .dialog()
        .file()
        .set_title("Open GraphVault folder")
        .pick_folder()
        .await;

    Ok(path.map(|p| p.to_string_lossy().into_owned()))
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
        .setup(|app| {
            // In development, open the devtools so errors are visible.
            #[cfg(debug_assertions)]
            {
                if let Some(window) = app.get_webview_window("main") {
                    window.open_devtools();
                }
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running GraphVault desktop app");
}
