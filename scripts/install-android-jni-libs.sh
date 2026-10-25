#!/usr/bin/env bash
#
# 把可执行素材装进 tauri android init 生成的 jniLibs，并补两处 manifest。
#
# 为什么：targetSdk>=29 的真机禁止 exec/dlopen 应用私有目录里的文件（W^X），
# proot / loader / busybox / 动态库若放在 app data，AI 一调 shell 就报
# "Permission denied"。jniLibs（lib*.so 命名）会被 AGP 解包到 nativeLibraryDir，
# 那里允许 exec —— Termux 被迫的同一招。Rust 侧从 /proc/self/maps 解析该目录
# （android_rootfs.rs::native_lib_dir），解析不到再回退私有目录布局。
#
# manifest 两处：
#   1. extractNativeLibs=true —— AGP 默认把原生库留在 APK 内不解包，
#      nativeLibraryDir 会是空目录，proot 没法 exec；
#   2. windowSoftInputMode=adjustResize —— 让 WebView 跟随输入法高度
#      （前端 useKeyboardInset 的 visualViewport 方案依赖窗口缩放）。
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ASSETS="$REPO_ROOT/src-tauri/android-assets"
GEN="$REPO_ROOT/src-tauri/gen/android"
JNILIBS="$GEN/app/src/main/jniLibs/arm64-v8a"
MANIFEST="$GEN/app/src/main/AndroidManifest.xml"

for f in proot proot-loader libtalloc.so.2 libandroid-shmem.so busybox; do
    if [ ! -f "$ASSETS/$f" ]; then
        echo "✗ 缺少 $ASSETS/$f —— 先跑 scripts/fetch-android-rootfs.sh" >&2
        exit 1
    fi
done
if [ ! -f "$MANIFEST" ]; then
    echo "✗ 缺少 $MANIFEST —— 先跑 npx tauri android init" >&2
    exit 1
fi

mkdir -p "$JNILIBS"
install -m 0755 "$ASSETS/proot" "$JNILIBS/libproot.so"
install -m 0755 "$ASSETS/proot-loader" "$JNILIBS/libproot_loader.so"
install -m 0755 "$ASSETS/busybox" "$JNILIBS/libbusybox.so"
install -m 0644 "$ASSETS/libtalloc.so.2" "$JNILIBS/libtalloc.so"
install -m 0644 "$ASSETS/libandroid-shmem.so" "$JNILIBS/libandroid-shmem.so"

# 原生库必须落盘（解包到 nativeLibraryDir）。AGP 4.2+ 已经不认 manifest 里的
# extractNativeLibs，改由 gradle 的 useLegacyPackaging 控制（默认 false =
# 库留在 APK 内不解包，nativeLibraryDir 是空目录，proot 没 exec 可言）。
GRADLE="$GEN/app/build.gradle.kts"
if [ -f "$GRADLE" ] && ! grep -q "useLegacyPackaging" "$GRADLE"; then
    sed -i '0,/^android {/s//android {\n    packaging {\n        jniLibs {\n            useLegacyPackaging = true\n        }\n    }/' "$GRADLE"
    echo "→ gradle: jniLibs.useLegacyPackaging=true"
fi

# 软输入模式：MainActivity 上补 adjustResize（已设置则跳过）。
# 注意生成出来的 <activity 标签后直接换行，不能匹配 "<activity "（带空格）。
if ! grep -q "windowSoftInputMode" "$MANIFEST"; then
    sed -i '0,/<activity/s/<activity/<activity\n            android:windowSoftInputMode="adjustResize"/' "$MANIFEST"
    echo "→ manifest: windowSoftInputMode=adjustResize"
fi

# 目录选择器插件：tauri-plugin-dialog 移动端没有实现目录选择（2.8.3 亦然），
# 这里补一个自有插件。ACTION_OPEN_DOCUMENT_TREE 返回 tree URI，映射回
# primary 存储的真实路径；写入外部存储需要「所有文件访问」，未授权时先跳设置页。
KOTLIN_DIR="$GEN/app/src/main/java/com/zmair.kivio"
mkdir -p "$KOTLIN_DIR"
cat > "$KOTLIN_DIR/FolderPickerPlugin.kt" <<'KOTLIN'
package com.zmair.kivio

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Environment
import android.provider.Settings
import app.tauri.annotation.ActivityCallback
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

@TauriPlugin
class FolderPickerPlugin(private val activity: Activity) : Plugin(activity) {

  @Command
  fun pickFolder(invoke: Invoke) {
    try {
      // 原始路径读写外部存储需要「所有文件访问」；没授权先去设置页开，回来重选。
      if (!Environment.isExternalStorageManager()) {
        val intent = Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION)
        intent.data = Uri.parse("package:com.zmair.kivio")
        activity.startActivity(intent)
        invoke.reject("请在设置中允许「所有文件访问」后重试")
        return
      }
      val intent = Intent(Intent.ACTION_OPEN_DOCUMENT_TREE)
      startActivityForResult(invoke, intent, "folderPickerResult")
    } catch (ex: Exception) {
      invoke.reject(ex.message ?: "Failed to pick folder")
    }
  }

  @ActivityCallback
  fun folderPickerResult(invoke: Invoke, result: ActivityResult) {
    try {
      when (result.resultCode) {
        Activity.RESULT_OK -> {
          val uri: Uri? = result.data?.data
          if (uri == null) {
            invoke.resolve(JSObject())
            return
          }
          try {
            val flags = Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION
            activity.contentResolver.takePersistableUriPermission(uri, flags)
          } catch (_: Exception) {
          }
          val callResult = JSObject()
          callResult.put("path", treeUriToPath(uri))
          invoke.resolve(callResult)
        }
        Activity.RESULT_CANCELED -> invoke.resolve(JSObject())
        else -> invoke.reject("Failed to pick folder")
      }
    } catch (ex: Exception) {
      invoke.reject(ex.message ?: "Failed to read folder pick result")
    }
  }

  private fun treeUriToPath(uri: Uri): String? {
    if (!uri.toString().contains("externalstorage.documents")) return null
    val path = uri.path ?: return null
    if (!path.startsWith("/tree/primary:")) return null
    val rest = path.removePrefix("/tree/primary:")
    return Environment.getExternalStorageDirectory().absolutePath + "/" + rest
  }
}
KOTLIN
echo "→ Kotlin: FolderPickerPlugin.kt"

# 外部存储权限（MANAGE_EXTERNAL_STORAGE 走设置页授权；≤32 的运行时权限一并声明）。
if ! grep -q "MANAGE_EXTERNAL_STORAGE" "$MANIFEST"; then
    sed -i 's#</manifest>#    <uses-permission android:name="android.permission.READ_EXTERNAL_STORAGE" android:maxSdkVersion="32" />\n    <uses-permission android:name="android.permission.WRITE_EXTERNAL_STORAGE" android:maxSdkVersion="32" />\n    <uses-permission android:name="android.permission.MANAGE_EXTERNAL_STORAGE" />\n</manifest>#' "$MANIFEST"
    echo "→ manifest: 外部存储权限"
fi

echo "已就绪（jniLibs/arm64-v8a）："
ls -l "$JNILIBS"
