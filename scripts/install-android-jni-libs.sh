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
if ! grep -q "windowSoftInputMode" "$MANIFEST"; then
    sed -i '0,/<activity/s/<activity /<activity\n            android:windowSoftInputMode="adjustResize" /' "$MANIFEST"
    echo "→ manifest: windowSoftInputMode=adjustResize"
fi

echo "已就绪（jniLibs/arm64-v8a）："
ls -l "$JNILIBS"
