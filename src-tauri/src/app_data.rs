//! 无 Tauri handle 的 per-app data 目录解析。
//!
//! 部分模块(plugins、skills 的 headless 发现)需要在没有
//! `AppHandle` 的情况下定位 Kivio 的 per-app data 目录。这里提供与 Tauri
//! `app_data_dir` 完全一致的纯函数实现。

use std::path::PathBuf;
use std::sync::OnceLock;
use tauri::AppHandle;

/// Tauri bundle identifier(须与 `tauri.conf.json` 一致)。
pub const APP_IDENTIFIER: &str = "com.zmair.kivio";

/// setup 阶段由 Tauri 解析一次的真实目录。没有 `AppHandle` 的调用方(插件目录、
/// 技能发现、市场清单)优先用它，避免各自猜路径。
static RESOLVED: OnceLock<PathBuf> = OnceLock::new();
static HANDLE: OnceLock<AppHandle> = OnceLock::new();

/// setup 时调用一次：记住 Tauri 解析出的 per-app data 目录。
pub fn remember_app_data_dir(dir: PathBuf) {
    let _ = RESOLVED.set(dir);
}

/// setup 时调用一次：留住 AppHandle，供没有 handle 的调用方读打包资源（AssetResolver）。
pub fn remember_app_handle(handle: AppHandle) {
    let _ = HANDLE.set(handle);
}

/// 供 headless 调用方读取打包资源用；setup 之前是 None。
pub fn app_handle() -> Option<&'static AppHandle> {
    HANDLE.get()
}

/// 与 Tauri `app_data_dir` = `dirs::data_dir()/<identifier>` 完全一致:
///   Windows: `%APPDATA%\com.zmair.kivio`(Roaming,无 `\data` 子目录)
///   macOS:   `~/Library/Application Support/com.zmair.kivio`
///   Linux:   `$XDG_DATA_HOME/com.zmair.kivio`(或 `~/.local/share/...`)
///
/// 注意:必须用 `BaseDirs::data_dir()`,不能用 `ProjectDirs::data_dir()`——
/// 后者在 Windows 会多追加一层 `\data`,导致读到错误路径。
/// 无法确定 home/data 目录时返回 `None`。
pub fn app_data_dir() -> Option<PathBuf> {
    if let Some(dir) = RESOLVED.get() {
        return Some(dir.clone());
    }
    // Android 没有 XDG / 已知文件夹，`directories` 在手机上返回 None，
    // 于是插件目录、市场清单这些 headless 路径全部报 "Application data directory
    // unavailable"。Android 进程的 HOME 就是应用私有目录（= Tauri 的 app_data_dir，
    // 形如 /data/user/0/com.zmair.kivio），直接用它。
    #[cfg(target_os = "android")]
    let resolved = std::env::var("HOME")
        .ok()
        .filter(|home| !home.is_empty())
        .map(PathBuf::from);
    #[cfg(not(target_os = "android"))]
    let resolved = directories::BaseDirs::new().map(|base| base.data_dir().join(APP_IDENTIFIER));
    resolved
}
