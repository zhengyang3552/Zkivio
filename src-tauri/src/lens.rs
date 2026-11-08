// Lens 模式：枚举屏幕上可见应用窗口（hover 高亮 + 标签）+ 整窗截图。
// macOS：CGWindowListCopyWindowInfo（Quartz）；Windows MVP：返回空列表，整窗截图返回 Err。

use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    },
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};

const LENS_OPEN_GRACE: Duration = Duration::from_secs(2);

/// Lens-owned runtime state.
///
/// `AppState` keeps a single instance of this handle, while all transitions stay here so
/// callers cannot separately mutate busy/session/payload fields and violate their ordering.
#[derive(Debug, Default)]
pub(crate) struct LensRuntimeState {
    lifecycle: Mutex<LensLifecycleState>,
    stream_generation: AtomicU64,
    pending_selection: Mutex<Option<String>>,
    freeze_frame_image_id: Mutex<Option<String>>,
    pending_reset: Mutex<Option<String>>,
}

#[derive(Debug, Default)]
struct LensSessionState {
    busy: bool,
    open_seq: u64,
    opened_at: Option<Instant>,
}

#[derive(Debug, Default)]
struct LensLifecycleState {
    session: LensSessionState,
    images: HashMap<String, PathBuf>,
    current_id: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct LensSessionBusy;

impl LensRuntimeState {
    pub(crate) fn register_image(&self, image_id: String, path: PathBuf) {
        self.lifecycle
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .images
            .insert(image_id, path);
    }

    pub(crate) fn register_current_image(
        &self,
        expected_session_seq: u64,
        image_id: String,
        path: PathBuf,
    ) -> Result<Option<String>, PathBuf> {
        let mut lifecycle = self.lifecycle.lock().unwrap_or_else(|e| e.into_inner());
        if !lifecycle.session.busy || lifecycle.session.open_seq != expected_session_seq {
            return Err(path);
        }
        lifecycle.images.insert(image_id.clone(), path);
        Ok(lifecycle.current_id.replace(image_id))
    }

    pub(crate) fn image_path(&self, image_id: &str) -> Option<PathBuf> {
        self.lifecycle
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .images
            .get(image_id)
            .cloned()
    }

    pub(crate) fn current_image_id(&self) -> Option<String> {
        self.lifecycle
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .current_id
            .clone()
    }

    pub(crate) fn remove_image(&self, image_id: &str) -> Option<PathBuf> {
        self.lifecycle
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .images
            .remove(image_id)
    }

    pub(crate) fn remove_image_and_clear_current(&self, image_id: &str) -> Option<PathBuf> {
        let mut lifecycle = self.lifecycle.lock().unwrap_or_else(|e| e.into_inner());
        let path = lifecycle.images.remove(image_id);
        if lifecycle.current_id.as_deref() == Some(image_id) {
            lifecycle.current_id = None;
        }
        path
    }

    pub(crate) fn begin_stream(&self) -> u64 {
        self.stream_generation.fetch_add(1, Ordering::SeqCst) + 1
    }

    pub(crate) fn cancel_stream(&self) {
        self.stream_generation.fetch_add(1, Ordering::SeqCst);
    }

    pub(crate) fn is_stream_current(&self, generation: u64) -> bool {
        self.stream_generation.load(Ordering::SeqCst) == generation
    }

    /// Acquire the single Lens session slot, repairing a stale busy marker only when no overlay
    /// is visible and the just-opened grace period has elapsed. On success this also advances the
    /// watchdog sequence and starts a new grace period as one transition.
    pub(crate) fn begin_session(&self, overlay_visible: bool) -> Result<u64, LensSessionBusy> {
        let mut lifecycle = self.lifecycle.lock().unwrap_or_else(|e| e.into_inner());
        let session = &mut lifecycle.session;
        if session.busy && !overlay_visible && !Self::open_in_grace(&session) {
            session.busy = false;
        }
        if session.busy {
            return Err(LensSessionBusy);
        }

        session.busy = true;
        session.open_seq = session.open_seq.wrapping_add(1);
        session.opened_at = Some(Instant::now());
        Ok(session.open_seq)
    }

    pub(crate) fn release_session(&self) {
        self.lifecycle
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .session
            .busy = false;
    }

    pub(crate) fn close_session_and_take_current(&self) -> Option<(String, PathBuf)> {
        let mut lifecycle = self.lifecycle.lock().unwrap_or_else(|e| e.into_inner());
        lifecycle.session.busy = false;
        let image_id = lifecycle.current_id.take()?;
        lifecycle
            .images
            .remove(&image_id)
            .map(|path| (image_id, path))
    }

    /// Probe whether Lens is active, preserving the existing opening-window semantics: a busy
    /// marker inside the grace period is retained but is not reported active until a window is
    /// visible. A stale marker outside the grace period is repaired.
    pub(crate) fn is_active_or_recover(&self, mut overlay_visible: impl FnMut() -> bool) -> bool {
        let visible = overlay_visible();
        let mut lifecycle = self.lifecycle.lock().unwrap_or_else(|e| e.into_inner());
        let session = &mut lifecycle.session;
        if session.busy {
            if visible {
                return true;
            }
            if Self::open_in_grace(&session) {
                return false;
            }
            session.busy = false;
        }
        visible
    }

    pub(crate) fn session_seq(&self) -> u64 {
        self.lifecycle
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .session
            .open_seq
    }

    pub(crate) fn is_session_current(&self, seq: u64) -> bool {
        self.session_seq() == seq
    }

    fn open_in_grace(session: &LensSessionState) -> bool {
        session
            .opened_at
            .map(|at| at.elapsed() < LENS_OPEN_GRACE)
            .unwrap_or(false)
    }

    /// Replace the selection captured for the current opening. Selection is intentionally a peek,
    /// not a take: React StrictMode and cold mounts may request it twice for one Lens session.
    pub(crate) fn replace_selection(&self, selection: Option<String>) {
        if let Ok(mut pending) = self.pending_selection.lock() {
            *pending = selection;
        }
    }

    pub(crate) fn selection(&self) -> Option<String> {
        self.pending_selection
            .lock()
            .ok()
            .and_then(|pending| pending.clone())
    }

    pub(crate) fn replace_reset_payload(&self, payload: String) {
        *self.pending_reset.lock().unwrap_or_else(|e| e.into_inner()) = Some(payload);
    }

    pub(crate) fn take_reset_payload(&self) -> Option<String> {
        self.pending_reset
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take()
    }

    pub(crate) fn replace_freeze_frame(&self, image_id: String) -> Option<String> {
        self.freeze_frame_image_id
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .replace(image_id)
    }

    pub(crate) fn is_current_freeze_frame(&self, image_id: &str) -> bool {
        self.freeze_frame_image_id
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_deref()
            == Some(image_id)
    }

    pub(crate) fn take_freeze_frame(&self) -> Option<String> {
        self.freeze_frame_image_id
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take()
    }

    pub(crate) fn take_freeze_frame_if_current(&self, image_id: &str) -> bool {
        let mut current = self
            .freeze_frame_image_id
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if current.as_deref() != Some(image_id) {
            return false;
        }
        *current = None;
        true
    }
}

/// 屏幕上一个应用窗口的元信息。坐标为全局逻辑坐标（macOS Quartz：原点左上，含 menubar，跨 monitor 全局）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowInfo {
    pub id: u32,
    pub owner: String,
    pub title: String,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[cfg(target_os = "macos")]
pub fn list_windows() -> Vec<WindowInfo> {
    use core_foundation::array::{CFArray, CFArrayRef};
    use core_foundation::base::{CFType, TCFType};
    use core_foundation::dictionary::{CFDictionary, CFDictionaryRef};
    use core_graphics::window::{
        kCGNullWindowID, kCGWindowListExcludeDesktopElements, kCGWindowListOptionOnScreenOnly,
        CGWindowListCopyWindowInfo,
    };

    let info_ref: CFArrayRef = unsafe {
        CGWindowListCopyWindowInfo(
            kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements,
            kCGNullWindowID,
        )
    };
    if info_ref.is_null() {
        return Vec::new();
    }
    // 数组元素类型为 untyped CFType；每个元素本身是一个 CFDictionary。
    let array: CFArray<CFType> = unsafe { CFArray::wrap_under_create_rule(info_ref) };

    let mut out = Vec::new();
    for item in array.iter() {
        let dict_ref = item.as_CFTypeRef() as CFDictionaryRef;
        if dict_ref.is_null() {
            continue;
        }
        let dict: CFDictionary = unsafe { CFDictionary::wrap_under_get_rule(dict_ref) };

        let layer = read_dict_i64(&dict, "kCGWindowLayer").unwrap_or(-1);
        let alpha = read_dict_f64(&dict, "kCGWindowAlpha").unwrap_or(1.0);
        let id = read_dict_i64(&dict, "kCGWindowNumber").unwrap_or(0);
        let owner = read_dict_string(&dict, "kCGWindowOwnerName").unwrap_or_default();
        let title = read_dict_string(&dict, "kCGWindowName").unwrap_or_default();

        let bounds_dict = read_dict_subdict(&dict, "kCGWindowBounds");
        let (bx, by, bw, bh) = if let Some(b) = bounds_dict {
            (
                read_dict_f64(&b, "X").unwrap_or(0.0),
                read_dict_f64(&b, "Y").unwrap_or(0.0),
                read_dict_f64(&b, "Width").unwrap_or(0.0),
                read_dict_f64(&b, "Height").unwrap_or(0.0),
            )
        } else {
            (0.0, 0.0, 0.0, 0.0)
        };

        let mut reason: Option<&str> = None;
        if id <= 0 {
            reason = Some("no-id");
        } else if layer != 0 {
            reason = Some("layer!=0");
        } else if alpha < 0.05 {
            reason = Some("alpha~0");
        } else if is_kivio_auxiliary_window(&owner, &title, bw, bh) {
            reason = Some("self-helper");
        } else if bw < 60.0 || bh < 40.0 {
            reason = Some("too-small");
        }

        if reason.is_some() {
            continue;
        }
        out.push(WindowInfo {
            id: id as u32,
            owner,
            title,
            x: bx,
            y: by,
            width: bw,
            height: bh,
        });
    }
    out
}

#[cfg(target_os = "macos")]
const KIVIO_SELECTABLE_MIN_WIDTH: f64 = 360.0;
#[cfg(target_os = "macos")]
const KIVIO_SELECTABLE_MIN_HEIGHT: f64 = 360.0;

#[cfg(target_os = "macos")]
fn is_kivio_owner(owner: &str) -> bool {
    matches!(
        owner,
        "Kivio Dev" | "Kivio Desktop" | "Kivio" | "kivio" | "KeyLingo" | "keylingo"
    )
}

#[cfg(target_os = "macos")]
fn is_kivio_primary_window(title: &str, width: f64, height: f64) -> bool {
    matches!(
        title.trim(),
        "Kivio Dev" | "Kivio Desktop" | "Kivio" | "KeyLingo"
    ) && width >= KIVIO_SELECTABLE_MIN_WIDTH
        && height >= KIVIO_SELECTABLE_MIN_HEIGHT
}

#[cfg(target_os = "macos")]
fn is_kivio_auxiliary_window(owner: &str, title: &str, width: f64, height: f64) -> bool {
    if !is_kivio_owner(owner) {
        return false;
    }

    // Chat is now Kivio's primary desktop window, so Lens must be able to
    // select it. Keep filtering Lens/translator helper surfaces owned by us.
    !is_kivio_primary_window(title, width, height)
}

#[cfg(target_os = "macos")]
fn read_dict_value(
    dict: &core_foundation::dictionary::CFDictionary,
    key: &str,
) -> Option<core_foundation::base::CFType> {
    use core_foundation::base::{CFType, TCFType};
    use core_foundation::string::CFString;
    let cfk = CFString::new(key);
    unsafe {
        let raw = dict.find(cfk.as_CFTypeRef() as *const _);
        raw.map(|r| CFType::wrap_under_get_rule(*r))
    }
}

#[cfg(target_os = "macos")]
fn read_dict_i64(dict: &core_foundation::dictionary::CFDictionary, key: &str) -> Option<i64> {
    use core_foundation::number::CFNumber;
    read_dict_value(dict, key)
        .and_then(|v| v.downcast::<CFNumber>())
        .and_then(|n| n.to_i64())
}

#[cfg(target_os = "macos")]
fn read_dict_f64(dict: &core_foundation::dictionary::CFDictionary, key: &str) -> Option<f64> {
    use core_foundation::number::CFNumber;
    read_dict_value(dict, key)
        .and_then(|v| v.downcast::<CFNumber>())
        .and_then(|n| n.to_f64())
}

#[cfg(target_os = "macos")]
fn read_dict_string(dict: &core_foundation::dictionary::CFDictionary, key: &str) -> Option<String> {
    use core_foundation::string::CFString;
    read_dict_value(dict, key)
        .and_then(|v| v.downcast::<CFString>())
        .map(|s| s.to_string())
}

#[cfg(target_os = "macos")]
fn read_dict_subdict(
    dict: &core_foundation::dictionary::CFDictionary,
    key: &str,
) -> Option<core_foundation::dictionary::CFDictionary> {
    use core_foundation::base::TCFType;
    use core_foundation::dictionary::{CFDictionary, CFDictionaryRef};
    let v = read_dict_value(dict, key)?;
    let r = v.as_CFTypeRef() as CFDictionaryRef;
    if r.is_null() {
        return None;
    }
    Some(unsafe { CFDictionary::wrap_under_get_rule(r) })
}

#[cfg(target_os = "linux")]
pub fn list_windows() -> Vec<WindowInfo> {
    // Wayland 合成器不对外提供窗口列表，只能返回空（前端退化为拖动选区）；
    // X11 会话走 XCB 枚举。
    if crate::linux_portal::is_wayland_session() {
        return Vec::new();
    }
    list_windows_x11().unwrap_or_default()
}

#[cfg(target_os = "linux")]
fn list_windows_x11() -> Result<Vec<WindowInfo>, String> {
    use x11rb::connection::Connection;
    use x11rb::protocol::xproto::{AtomEnum, ConnectionExt, MapState};
    use x11rb::rust_connection::RustConnection;

    let (conn, screen_idx) =
        RustConnection::connect(None).map_err(|e| format!("无法连接 X server: {e}"))?;
    let root = conn.setup().roots[screen_idx].root;

    let intern = |name: &str| -> Result<u32, String> {
        let reply = conn
            .intern_atom(false, name.as_bytes())
            .map_err(|e| e.to_string())?
            .reply()
            .map_err(|e| e.to_string())?;
        Ok(reply.atom)
    };

    let net_client_list = intern("_NET_CLIENT_LIST")?;
    let net_wm_name = intern("_NET_WM_NAME")?;
    let utf8_string = intern("UTF8_STRING")?;
    let wm_name = intern("WM_NAME")?;
    let wm_class = intern("WM_CLASS")?;
    let net_wm_state = intern("_NET_WM_STATE")?;
    let net_wm_state_hidden = intern("_NET_WM_STATE_HIDDEN")?;
    let net_wm_window_type = intern("_NET_WM_WINDOW_TYPE")?;
    let skip_types: Vec<u32> = [
        "_NET_WM_WINDOW_TYPE_DOCK",
        "_NET_WM_WINDOW_TYPE_DESKTOP",
        "_NET_WM_WINDOW_TYPE_PANEL",
        "_NET_WM_WINDOW_TYPE_NOTIFICATION",
        "_NET_WM_WINDOW_TYPE_SPLASH",
        "_NET_WM_WINDOW_TYPE_COMBO",
    ]
    .iter()
    .map(|name| intern(name))
    .collect::<Result<Vec<_>, _>>()?;

    // 读 atom 数组属性（32 位值）
    let atom_list_prop = |window: u32, atom: u32| -> Vec<u32> {
        conn.get_property(false, window, atom, AtomEnum::ATOM, 0, 64)
            .ok()
            .and_then(|cookie| cookie.reply().ok())
            .and_then(|reply| reply.value32().map(|values| values.collect()))
            .unwrap_or_default()
    };
    // 读文本属性（UTF8_STRING / STRING）
    let text_prop = |window: u32, atom: u32, prop_type: u32| -> Option<String> {
        let reply = conn
            .get_property(false, window, atom, prop_type, 0, 1024)
            .ok()?
            .reply()
            .ok()?;
        if reply.value.is_empty() {
            return None;
        }
        let text = String::from_utf8_lossy(&reply.value)
            .trim_end_matches('\0')
            .trim()
            .to_string();
        if text.is_empty() {
            None
        } else {
            Some(text)
        }
    };

    let list_reply = conn
        .get_property(false, root, net_client_list, AtomEnum::ATOM, 0, 4096)
        .map_err(|e| e.to_string())?
        .reply()
        .map_err(|e| e.to_string())?;
    let Some(window_ids) = list_reply.value32() else {
        return Ok(Vec::new());
    };

    let mut windows: Vec<WindowInfo> = Vec::new();
    for window in window_ids {
        // 窗口可能中途被销毁：逐项失败都跳过
        let Ok(attrs_cookie) = conn.get_window_attributes(window) else {
            continue;
        };
        let Ok(attrs) = attrs_cookie.reply() else {
            continue;
        };
        if attrs.map_state != MapState::VIEWABLE {
            continue;
        }
        if atom_list_prop(window, net_wm_state).contains(&net_wm_state_hidden) {
            continue; // 最小化
        }
        let types = atom_list_prop(window, net_wm_window_type);
        if types.iter().any(|t| skip_types.contains(t)) {
            continue; // 任务栏/桌面/通知类窗口不作为截图目标
        }
        let Ok(geom_cookie) = conn.get_geometry(window) else {
            continue;
        };
        let Ok(geom) = geom_cookie.reply() else {
            continue;
        };
        if geom.width < 16 || geom.height < 16 {
            continue;
        }
        let Ok(tr_cookie) = conn.translate_coordinates(window, root, 0, 0) else {
            continue;
        };
        let Ok(tr) = tr_cookie.reply() else {
            continue;
        };
        let x = i32::from(tr.dst_x);
        let y = i32::from(tr.dst_y);

        // 排除本应用自身浮窗，避免 Lens 遮罩窗口出现在待选列表里
        let class_raw = conn
            .get_property(false, window, wm_class, AtomEnum::STRING, 0, 512)
            .ok()
            .and_then(|cookie| cookie.reply().ok())
            .map(|reply| reply.value)
            .unwrap_or_default();
        let class_text = String::from_utf8_lossy(&class_raw);
        if class_text.to_ascii_lowercase().contains("kivio") {
            continue;
        }
        // WM_CLASS = "instance\0class\0"，习惯用 class 作为应用名
        let class_parts: Vec<&str> = class_text.split('\0').filter(|s| !s.is_empty()).collect();
        let owner = class_parts
            .get(1)
            .or_else(|| class_parts.first())
            .map(|s| s.to_string())
            .unwrap_or_default();

        let title = text_prop(window, net_wm_name, utf8_string)
            .or_else(|| text_prop(window, wm_name, AtomEnum::STRING.into()))
            .unwrap_or_default();

        windows.push(WindowInfo {
            id: window,
            owner: if owner.is_empty() {
                title.clone()
            } else {
                owner
            },
            title,
            x: f64::from(x),
            y: f64::from(y),
            width: f64::from(geom.width),
            height: f64::from(geom.height),
        });
    }
    Ok(windows)
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
pub fn list_windows() -> Vec<WindowInfo> {
    Vec::new()
}

/// 单窗口截图（macOS 14+）：走 ScreenCaptureKit (SCScreenshotManager)。
/// 取代旧的 `screencapture -l` CLI 调用：消除几十–几百 ms 子进程冷启动 + 消除屏幕白闪。
#[cfg(target_os = "macos")]
pub fn capture_window(window_id: u32) -> Result<std::path::PathBuf, String> {
    crate::sck::capture_window(window_id)
}

#[cfg(not(target_os = "macos"))]
pub fn capture_window(_window_id: u32) -> Result<std::path::PathBuf, String> {
    Err("Window capture not supported on this platform".to_string())
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;

    #[test]
    fn kivio_chat_window_is_selectable() {
        assert!(!is_kivio_auxiliary_window(
            "Kivio Desktop",
            "Kivio Desktop",
            1060.0,
            746.0
        ));
        assert!(!is_kivio_auxiliary_window("kivio", "Kivio", 1060.0, 746.0));
        assert!(!is_kivio_auxiliary_window("Kivio", "Kivio", 400.0, 400.0));
    }

    #[test]
    fn kivio_helper_windows_are_filtered() {
        assert!(is_kivio_auxiliary_window(
            "Kivio Desktop",
            "Lens",
            1728.0,
            1117.0
        ));
        assert!(is_kivio_auxiliary_window("kivio", "Lens", 1728.0, 1117.0));
        assert!(is_kivio_auxiliary_window("kivio", "Kivio", 392.0, 152.0));
        assert!(is_kivio_auxiliary_window("KeyLingo", "", 600.0, 72.0));
    }

    #[test]
    fn other_apps_are_not_self_filtered() {
        assert!(!is_kivio_auxiliary_window("Safari", "Kivio", 392.0, 152.0));
    }
}

#[cfg(test)]
mod runtime_state_tests {
    use super::*;
    use std::sync::{Arc, Barrier};
    use std::time::{Duration, Instant};

    fn expire_open_grace(state: &LensRuntimeState) {
        state.lifecycle.lock().unwrap().session.opened_at =
            Some(Instant::now() - Duration::from_secs(3));
    }

    #[test]
    fn session_busy_recovers_only_after_open_grace_expires() {
        let state = LensRuntimeState::default();
        assert_eq!(state.begin_session(false), Ok(1));
        assert_eq!(state.begin_session(false), Err(LensSessionBusy));

        expire_open_grace(&state);
        assert_eq!(state.begin_session(false), Ok(2));
    }

    #[test]
    fn visible_session_stays_busy_even_after_open_grace_expires() {
        let state = LensRuntimeState::default();
        assert_eq!(state.begin_session(false), Ok(1));
        expire_open_grace(&state);

        assert_eq!(state.begin_session(true), Err(LensSessionBusy));
        assert!(state.is_session_current(1));
    }

    #[test]
    fn active_probe_preserves_opening_session_and_repairs_stale_busy() {
        let state = LensRuntimeState::default();
        assert_eq!(state.begin_session(false), Ok(1));
        assert!(!state.is_active_or_recover(|| false));
        assert_eq!(state.begin_session(false), Err(LensSessionBusy));

        expire_open_grace(&state);
        assert!(!state.is_active_or_recover(|| false));
        assert_eq!(state.begin_session(false), Ok(2));
        assert!(state.is_active_or_recover(|| true));
    }

    #[test]
    fn selection_is_replaced_per_session_and_can_be_peeked_repeatedly() {
        let state = LensRuntimeState::default();
        state.replace_selection(Some("selected".to_string()));
        assert_eq!(state.selection().as_deref(), Some("selected"));
        assert_eq!(state.selection().as_deref(), Some("selected"));

        state.replace_selection(None);
        assert_eq!(state.selection(), None);
    }

    #[test]
    fn reset_payload_is_consumed_once() {
        let state = LensRuntimeState::default();
        state.replace_reset_payload("reset-1".to_string());
        state.replace_reset_payload("reset-2".to_string());

        assert_eq!(state.take_reset_payload().as_deref(), Some("reset-2"));
        assert_eq!(state.take_reset_payload(), None);
    }

    #[test]
    fn freeze_frame_replace_current_and_conditional_take_are_atomic() {
        let state = LensRuntimeState::default();
        assert_eq!(state.replace_freeze_frame("frame-1".to_string()), None);
        assert!(state.is_current_freeze_frame("frame-1"));
        assert!(!state.is_current_freeze_frame("frame-2"));

        assert_eq!(
            state.replace_freeze_frame("frame-2".to_string()).as_deref(),
            Some("frame-1")
        );
        assert!(!state.take_freeze_frame_if_current("frame-1"));
        assert!(state.take_freeze_frame_if_current("frame-2"));
        assert_eq!(state.take_freeze_frame(), None);
    }

    #[test]
    fn image_identity_and_stream_generation_stay_inside_lens_owner() {
        let state = LensRuntimeState::default();
        let first_path = PathBuf::from("first.png");
        let second_path = PathBuf::from("second.png");
        assert_eq!(state.begin_session(false), Ok(1));

        assert_eq!(
            state.register_current_image(1, "first".to_string(), first_path.clone()),
            Ok(None)
        );
        assert_eq!(state.image_path("first"), Some(first_path));
        assert_eq!(state.current_image_id().as_deref(), Some("first"));
        assert_eq!(
            state.register_current_image(1, "second".to_string(), second_path),
            Ok(Some("first".to_string()))
        );
        assert_eq!(
            state.remove_image_and_clear_current("second"),
            Some(PathBuf::from("second.png"))
        );
        assert_eq!(state.current_image_id(), None);

        let generation = state.begin_stream();
        assert!(state.is_stream_current(generation));
        state.cancel_stream();
        assert!(!state.is_stream_current(generation));
    }

    #[test]
    fn close_atomically_rejects_a_late_capture_and_removes_the_current_image() {
        let state = LensRuntimeState::default();
        assert_eq!(state.begin_session(false), Ok(1));
        assert_eq!(
            state.register_current_image(1, "current".to_string(), PathBuf::from("current.png")),
            Ok(None)
        );

        assert_eq!(
            state.close_session_and_take_current(),
            Some(("current".to_string(), PathBuf::from("current.png")))
        );
        assert_eq!(state.current_image_id(), None);
        assert_eq!(state.image_path("current"), None);
        assert_eq!(
            state.register_current_image(1, "late".to_string(), PathBuf::from("late.png")),
            Err(PathBuf::from("late.png"))
        );
        assert_eq!(state.current_image_id(), None);
        assert_eq!(state.image_path("late"), None);
    }

    #[test]
    fn reopening_rejects_a_capture_from_the_previous_session() {
        let state = LensRuntimeState::default();
        let stale_session = state.begin_session(false).expect("first session");
        assert_eq!(state.close_session_and_take_current(), None);
        let current_session = state.begin_session(false).expect("reopened session");
        assert_ne!(stale_session, current_session);

        assert_eq!(
            state.register_current_image(
                stale_session,
                "stale".to_string(),
                PathBuf::from("stale.png"),
            ),
            Err(PathBuf::from("stale.png"))
        );
        assert_eq!(state.current_image_id(), None);
        assert_eq!(state.image_path("stale"), None);

        assert_eq!(
            state.register_current_image(
                current_session,
                "current".to_string(),
                PathBuf::from("current.png"),
            ),
            Ok(None)
        );
        assert_eq!(state.current_image_id().as_deref(), Some("current"));
    }

    #[test]
    fn concurrent_session_starts_publish_busy_grace_and_sequence_atomically() {
        const CONTENDERS: usize = 16;
        let state = Arc::new(LensRuntimeState::default());
        let start = Arc::new(Barrier::new(CONTENDERS));
        let handles = (0..CONTENDERS)
            .map(|_| {
                let state = Arc::clone(&state);
                let start = Arc::clone(&start);
                std::thread::spawn(move || {
                    start.wait();
                    state.begin_session(false)
                })
            })
            .collect::<Vec<_>>();

        let results = handles
            .into_iter()
            .map(|handle| handle.join().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
        assert_eq!(state.session_seq(), 1);
        assert!(!state.is_active_or_recover(|| false));
        assert_eq!(state.begin_session(false), Err(LensSessionBusy));
    }
}
