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

# 工作区 DocumentsProvider：MT 管理器 / 系统文件管理器经 SAF 读写工作区。
if ! grep -q "WorkspaceDocumentsProvider" "$MANIFEST"; then
    # <provider> 是 <application> 的子元素，且 uses-permission 要在 application 之前
    sed -i 's#</application>#        <provider\n            android:name="com.zmair.kivio.WorkspaceDocumentsProvider"\n            android:authorities="com.zmair.kivio.documents"\n            android:grantUriPermissions="true"\n            android:exported="true"\n            android:permission="android.permission.MANAGE_DOCUMENTS">\n            <intent-filter>\n                <action android:name="android.content.action.DOCUMENTS_PROVIDER" />\n            </intent-filter>\n        </provider>\n    </application>#' "$MANIFEST"
    sed -i '0,/<application/s#<application#<application\n        <uses-permission android:name="android.permission.MANAGE_DOCUMENTS" />/' "$MANIFEST"
    echo "→ manifest: WorkspaceDocumentsProvider + MANAGE_DOCUMENTS"
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
import androidx.activity.result.ActivityResult
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
# ── 工作区 DocumentsProvider（参考 RikkaHub）──────────────────────────────
# 应用私有目录（/data/user/0/<pkg>）别的应用读不到，MT 管理器等文件管理器
# 想浏览/编辑工作区只能走 SAF：注册一个 DocumentsProvider 把 rootfs 与
# Kivio 工作区以「文档根」暴露出去，系统文件管理器和支持 SAF 的工具都能挂载。
cat > "$KOTLIN_DIR/WorkspaceDocumentsProvider.kt" <<'KOTLIN'
package com.zmair.kivio

import android.database.Cursor
import android.database.MatrixCursor
import android.os.CancellationSignal
import android.os.ParcelFileDescriptor
import android.provider.DocumentsContract
import android.provider.DocumentsProvider
import java.io.File
import java.io.FileNotFoundException
import java.io.IOException

/**
 * 把应用私有目录里的工作区（rootfs 与 ~/Kivio）经 SAF 暴露给其它应用
 * （MT 管理器、系统文件管理器等）。documentId 直接用绝对路径，简单可靠。
 */
class WorkspaceDocumentsProvider : DocumentsProvider() {
  companion object {
    const val ROOT_DOC = "workspace-root"
    const val AUTHORITY = "com.zmair.kivio.documents"

    private val DEFAULT_ROOT_PROJECTION = arrayOf(
      DocumentsContract.Root.COLUMN_ROOT_ID,
      DocumentsContract.Root.COLUMN_ICON,
      DocumentsContract.Root.COLUMN_TITLE,
      DocumentsContract.Root.COLUMN_SUMMARY,
      DocumentsContract.Root.COLUMN_FLAGS,
      DocumentsContract.Root.COLUMN_DOCUMENT_ID,
    )
    private val DEFAULT_DOCUMENT_PROJECTION = arrayOf(
      DocumentsContract.Document.COLUMN_DOCUMENT_ID,
      DocumentsContract.Document.COLUMN_DISPLAY_NAME,
      DocumentsContract.Document.COLUMN_MIME_TYPE,
      DocumentsContract.Document.COLUMN_FLAGS,
      DocumentsContract.Document.COLUMN_SIZE,
      DocumentsContract.Document.COLUMN_LAST_MODIFIED,
    )
    /** 根目录下只暴露工作区相关的两棵树，避免把 settings.json（含密钥）等一并晒出去。 */
    private val EXPOSED_ROOT_ENTRIES = arrayOf("rootfs", "Kivio")
  }

  private lateinit var dataDir: File

  override fun onCreate(): Boolean {
    // 应用私有数据根 /data/user/0/<pkg>（rootfs 与 ~/Kivio 都在这里）
    dataDir = File(context!!.applicationInfo.dataDir)
    return true
  }

  private fun rootFileFor(name: String): File = File(dataDir, name)

  override fun queryRoots(projection: Array<out String>?): Cursor {
    val result = MatrixCursor(resolveRootProjection(projection))
    result.newRow().apply {
      add(DocumentsContract.Root.COLUMN_ROOT_ID, ROOT_DOC)
      add(DocumentsContract.Root.COLUMN_ICON, android.R.drawable.sym_def_app_icon)
      add(DocumentsContract.Root.COLUMN_TITLE, "Kivio 工作区")
      add(DocumentsContract.Root.COLUMN_SUMMARY, "rootfs 与 Kivio 工作区文件")
      add(DocumentsContract.Root.COLUMN_FLAGS,
        DocumentsContract.Root.FLAG_SUPPORTS_IS_CHILD or DocumentsContract.Root.FLAG_LOCAL_ONLY)
      add(DocumentsContract.Root.COLUMN_DOCUMENT_ID, ROOT_DOC)
    }
    return result
  }

  override fun isChildDocument(parentDocumentId: String?, documentId: String?): Boolean =
    documentId!!.startsWith(parentDocumentId!!)

  override fun queryDocument(documentId: String?, projection: Array<out String>?): Cursor {
    val result = MatrixCursor(resolveDocumentProjection(projection))
    if (documentId == ROOT_DOC) {
      result.newRow().apply {
        add(DocumentsContract.Document.COLUMN_DOCUMENT_ID, ROOT_DOC)
        add(DocumentsContract.Document.COLUMN_DISPLAY_NAME, "Kivio 工作区")
        add(DocumentsContract.Document.COLUMN_MIME_TYPE, DocumentsContract.Document.MIME_TYPE_DIR)
        add(DocumentsContract.Document.COLUMN_FLAGS, DocumentsContract.Document.FLAG_DIR_PREFERS_GRID)
      }
    } else {
      includeFile(result, documentId ?: ROOT_DOC)
    }
    return result
  }

  override fun queryChildDocuments(
    parentDocumentId: String?,
    projection: Array<out String>?,
    sortOrder: String?,
  ): Cursor {
    val result = MatrixCursor(resolveDocumentProjection(projection))
    if (parentDocumentId == ROOT_DOC) {
      // 根下只挂工作区两棵树
      for (name in EXPOSED_ROOT_ENTRIES) {
        val dir = rootFileFor(name)
        if (!dir.exists()) dir.mkdirs()
        includeFile(result, dir.absolutePath)
      }
      return result
    }
    val parent = getFileForDocId(parentDocumentId ?: ROOT_DOC)
    val children = parent.listFiles() ?: throw FileNotFoundException(parent.canonicalPath)
    for (file in children.sortedBy { it.name.lowercase() }) {
      includeFile(result, file.absolutePath)
    }
    return result
  }

  override fun openDocument(
    documentId: String?,
    mode: String?,
    signal: CancellationSignal?,
  ): ParcelFileDescriptor {
    val file = getFileForDocId(documentId ?: ROOT_DOC)
    val accessMode = ParcelFileDescriptor.parseMode(mode)
    val isWrite = mode!!.indexOf('w') != -1
    if (isWrite) {
      // 附件写入时先确保父目录存在
      file.parentFile?.mkdirs()
    }
    return ParcelFileDescriptor.open(file, accessMode)
  }

  override fun createDocument(parentDocumentId: String?, mimeType: String, displayName: String): String {
    val parent = getFileForDocId(parentDocumentId ?: ROOT_DOC)
    var name = displayName
    var target = File(parent, name)
    var noConflict = 0
    while (target.exists()) {
      noConflict++
      val dot = displayName.lastIndexOf('.')
      name = if (dot > 0) {
        displayName.substring(0, dot) + " ($noConflict)" + displayName.substring(dot)
      } else {
        "$displayName ($noConflict)"
      }
      target = File(parent, name)
    }
    try {
      val ok = if (mimeType == DocumentsContract.Document.MIME_TYPE_DIR) target.mkdirs() else target.createNewFile()
      if (!ok) throw IOException("create failed: ${target.canonicalPath}")
    } catch (e: IOException) {
      throw FileNotFoundException("create ${target.canonicalPath}: ${e.message}")
    }
    return target.absolutePath
  }

  override fun deleteDocument(documentId: String?) {
    val file = getFileForDocId(documentId ?: ROOT_DOC)
    file.deleteRecursively()
  }

  override fun renameDocument(documentId: String?, displayName: String): String {
    val file = getFileForDocId(documentId ?: ROOT_DOC)
    val target = File(file.parentFile, displayName)
    if (!file.renameTo(target)) throw FileNotFoundException("rename ${file.canonicalPath} failed")
    return target.absolutePath
  }

  private fun getFileForDocId(documentId: String): File {
    if (documentId == ROOT_DOC) throw FileNotFoundException("root is virtual")
    val file = File(documentId)
    if (!file.exists()) throw FileNotFoundException(documentId)
    // 防目录穿越：只允许暴露两棵工作区树
    val allowed = EXPOSED_ROOT_ENTRIES.any { name ->
      val root = rootFileFor(name).canonicalPath + File.separator
      file.canonicalPath.startsWith(root)
    }
    if (!allowed) throw FileNotFoundException("outside workspace: $documentId")
    return file
  }

  private fun includeFile(result: MatrixCursor, documentId: String) {
    val file = getFileForDocId(documentId)
    result.newRow().apply {
      add(DocumentsContract.Document.COLUMN_DOCUMENT_ID, file.absolutePath)
      add(DocumentsContract.Document.COLUMN_DISPLAY_NAME, file.name)
      add(DocumentsContract.Document.COLUMN_LAST_MODIFIED, file.lastModified())
      add(DocumentsContract.Document.COLUMN_SIZE, if (file.isDirectory) null else file.length())
      if (file.isDirectory) {
        add(DocumentsContract.Document.COLUMN_MIME_TYPE, DocumentsContract.Document.MIME_TYPE_DIR)
        add(DocumentsContract.Document.COLUMN_FLAGS,
          DocumentsContract.Document.FLAG_DIR_SUPPORTS_CREATE or
            DocumentsContract.Document.FLAG_SUPPORTS_DELETE or
            DocumentsContract.Document.FLAG_SUPPORTS_RENAME or
            DocumentsContract.Document.FLAG_SUPPORTS_WRITE)
      } else {
        val name = file.name
        val dot = name.lastIndexOf('.')
        val mime = if (dot > 0) {
          val ext = name.substring(dot + 1).lowercase()
          android.webkit.MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext) ?: "application/octet-stream"
        } else {
          "application/octet-stream"
        }
        add(DocumentsContract.Document.COLUMN_MIME_TYPE, mime)
        add(DocumentsContract.Document.COLUMN_FLAGS,
          DocumentsContract.Document.FLAG_SUPPORTS_WRITE or
            DocumentsContract.Document.FLAG_SUPPORTS_DELETE or
            DocumentsContract.Document.FLAG_SUPPORTS_RENAME)
      }
    }
  }

  private fun resolveRootProjection(projection: Array<out String>?): Array<out String> =
    projection ?: DEFAULT_ROOT_PROJECTION

  private fun resolveDocumentProjection(projection: Array<out String>?): Array<out String> =
    projection ?: DEFAULT_DOCUMENT_PROJECTION
}
KOTLIN
echo "→ Kotlin: WorkspaceDocumentsProvider.kt"


# 外部存储权限（MANAGE_EXTERNAL_STORAGE 走设置页授权；≤32 的运行时权限一并声明）。
# AGP 校验元素顺序：uses-permission 必须在 <application> 之前。
if ! grep -q "MANAGE_EXTERNAL_STORAGE" "$MANIFEST"; then
    sed -i '0,/<application/s#<application#<application\n        <!-- om:external-storage -->\n        <uses-permission android:name="android.permission.READ_EXTERNAL_STORAGE" android:maxSdkVersion="32" />\n        <uses-permission android:name="android.permission.WRITE_EXTERNAL_STORAGE" android:maxSdkVersion="32" />\n        <uses-permission android:name="android.permission.MANAGE_EXTERNAL_STORAGE" />#' "$MANIFEST"
    echo "→ manifest: 外部存储权限"
fi

echo "已就绪（jniLibs/arm64-v8a）："
ls -l "$JNILIBS"
