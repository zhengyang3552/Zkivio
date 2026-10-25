//! Android 目录选择器（ACTION_OPEN_DOCUMENT_TREE）。
//!
//! tauri-plugin-dialog 在移动端没有实现目录选择（open({directory:true}) 直接报
//! "Folder picker is not implemented on mobile"，2.8.3 依然如此），这里补一个
//! 自有插件：Kotlin 侧 `FolderPickerPlugin`（由 CI 写进 gen/android，见
//! scripts/install-android-jni-libs.sh）拉起系统目录树选择器，把 primary 存储
//! 的 tree URI 映射回真实文件路径返回；桌面端注册的是空实现（前端走 dialog
//! 插件，不会调用这里）。
//!
//! 原始路径写入外部存储需要「所有文件访问」（MANAGE_EXTERNAL_STORAGE）：
//! Kotlin 侧未授权时会跳系统设置页让用户开启，本次调用以错误收场、重选即可。

use serde::Deserialize;
use tauri::{
    plugin::{Builder, PluginApi, PluginHandle},
    AppHandle, Manager, Runtime, TauriPlugin,
};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PickFolderResult {
    #[serde(default)]
    path: Option<String>,
}

#[cfg(target_os = "android")]
mod imp {
    use super::*;
    use serde::{de::DeserializeOwned, Serialize};

    /// Kotlin 类的包名（与 gen/android 里 FolderPickerPlugin.kt 的 package 一致）。
    const IDENTIFIER: &str = "com.zmair.kivio";

    pub fn init<R: Runtime, C: DeserializeOwned>(
        _app: &AppHandle<R>,
        api: PluginApi<R, C>,
    ) -> FolderPicker<R> {
        let handle = api.register_android_plugin(IDENTIFIER, "FolderPickerPlugin")?;
        FolderPicker(handle)
    }

    pub struct FolderPicker<R: Runtime>(PluginHandle<R>);

    impl<R: Runtime> FolderPicker<R> {
        pub fn pick_folder(&self) -> Result<Option<String>, String> {
            self.0
                .run_mobile_plugin::<PickFolderResult>("pickFolder", ())
                .map(|result| result.path)
                .map_err(|err| format!("pick folder: {err}"))
        }
    }
}

#[cfg(not(target_os = "android"))]
mod imp {
    use super::*;
    use serde::de::DeserializeOwned;
    use std::marker::PhantomData;

    pub fn init<R: Runtime, C: DeserializeOwned>(
        _app: &AppHandle<R>,
        _api: PluginApi<R, C>,
    ) -> FolderPicker<R> {
        FolderPicker(PhantomData)
    }

    pub struct FolderPicker<R: Runtime>(PhantomData<R>);

    impl<R: Runtime> FolderPicker<R> {
        pub fn pick_folder(&self) -> Result<Option<String>, String> {
            Err("folder picker: 桌面端请使用 dialog 插件".into())
        }
    }
}

#[cfg(target_os = "android")]
pub use imp::FolderPicker;
#[cfg(not(target_os = "android"))]
pub use imp::FolderPicker;

/// 弹系统目录选择器，返回用户选择的真实路径（取消返回 None）。
#[tauri::command]
pub async fn pick_folder(
    state: tauri::State<'_, FolderPicker<tauri::Wry>>,
) -> Result<Option<String>, String> {
    state.inner().pick_folder()
}

/// 插件注册：Kotlin 侧注册 + `pick_folder` 命令。
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("folder-picker")
        .setup(|app, api| {
            let picker = imp::init(app.handle(), api)?;
            app.manage(picker);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![pick_folder])
        .build()
}
