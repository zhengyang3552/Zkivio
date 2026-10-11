//! Android 兼容层。
//!
//! 桌面端的主窗口、托盘、全局热键、多窗口开关窗分别落在 `windows.rs` 与
//! `shortcuts.rs`，这两块依赖 macOS / Windows / X11 原生 API，在 Android 上
//! 整块关闭（见 `lib.rs` 的模块声明）。本模块给出移动端需要的最小等价实现，
//! 让 `lib.rs` 的主流程只保留一份调用点，两边不会各写一套。
//!
//! 与桌面的差异（有意为之，不是缺失）：
//! - 只有一块 WebView，标签沿用 `chat`，前端按同一个 label 走聊天布局；
//! - 没有托盘 / 全局热键 / 单实例 / 开机自启，因此不存在「关到托盘」；
//! - 窗口由 `setup` 创建一次，之后不再新建，也不做 overlay 面板。

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

/// 主窗口标签。与桌面 `windows.rs` 保持一致，前端据此选择聊天布局。
pub(crate) const CHAT_WINDOW_LABEL: &str = "chat";

/// 主窗口路由。桌面端从「上次打开的路由」恢复，移动端固定进聊天。
const CHAT_ROUTE: &str = "index.html#chat";

/// 创建主窗口。Android 上只在 `setup` 里调用一次。
pub(crate) fn create_chat_window(app: &AppHandle) -> Result<WebviewWindow, String> {
    // 不带 .title()/.inner_size()：这些是桌面专属方法，Android 的窗口尺寸由
    // Activity 决定，标题也不显示在移动端。
    WebviewWindowBuilder::new(app, CHAT_WINDOW_LABEL, WebviewUrl::App(CHAT_ROUTE.into()))
        .build()
        .map_err(|error| error.to_string())
}

/// 打开（或复用）主窗口。桌面端同名函数在 `shortcuts.rs`。
///
/// 移动端没有多窗口，已存在时直接返回：Tauri 的窗口显示/聚焦在 Android 上
/// 由系统 Activity 接管，不需要也不应该由这里干预。
pub(crate) fn open_chat_window(app: &AppHandle) -> Result<(), String> {
    if app.get_webview_window(CHAT_WINDOW_LABEL).is_some() {
        return Ok(());
    }
    create_chat_window(app).map(|_| ())
}

/// 桌面端把「关闭」拦成「藏进托盘」；移动端没有托盘，且唯一窗口被隐藏后
/// 用户无法再唤回，所以这里保持空实现——关闭就是关闭。
pub(crate) fn hide_chat_window(_app: &AppHandle, _window: &tauri::Window) {}

/// 桌面 Lens 的「图片追问」取图入口（桌面实现见
/// `lens_commands::resolve_explain_image_path`）。
///
/// 桌面的图片来源是框选截图浮层 + `lens-history` 持久副本；Android 没有浮层，
/// 因而既没有活跃图片也没有历史目录，这里保持同一签名并明确报不可用，让
/// `api.rs` 的 explain 流程两端共用一处调用点、不各写一套分支。
pub(crate) fn resolve_explain_image_path(
    _app: &AppHandle,
    _state: &tauri::State<'_, crate::state::AppState>,
    _image_id: &str,
) -> Result<std::path::PathBuf, String> {
    Err("图片追问在当前移动端不可用".to_string())
}
