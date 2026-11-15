fn main() {
    // The app's own commands, declared so each gets an `allow-*` permission and
    // nothing is invocable unless a capability grants it. The three are the
    // page menu bar's (`src/appmenu.rs`), granted by `capabilities/app-menu.json`
    // to the hub's origin on Windows only. `shell_set_hub` is the tray's «Сервер»
    // window's (`hubconf.rs`, `capabilities/server-window.json`), local only.
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&["shell_quit", "shell_update_row", "shell_update", "shell_set_hub"]),
    ))
    .expect("tauri build script failed");
}
