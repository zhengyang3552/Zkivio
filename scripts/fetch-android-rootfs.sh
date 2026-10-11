#!/usr/bin/env bash
#
# 拉取 Android 端 rootfs 工作区所需素材到 src-tauri/android-assets/。
#
# 这些文件是二进制、且体积不小（Alpine rootfs 约 4MB），因此不入库：
# CI 在构建前跑这个脚本，本地要出 APK 也先跑一次。
# 版本全部固定，保证同一份源码每次构建拿到同一批二进制。
#
# 素材与用途（见 src-tauri/src/android_rootfs.rs）：
#   proot / proot-loader        ptrace 方式在应用私有目录里伪造 Linux root
#   libtalloc.so.2              上面两者的动态依赖
#   libandroid-shmem.so         同上（Android 上 proot 的 SysV shm 替代）
#   alpine-minirootfs.tar.gz    工作区本体，首次启动解包到 {app_data}/rootfs
set -euo pipefail

TERMUX_REPO="${TERMUX_REPO:-https://packages.termux.dev/apt/termux-main}"
PROOT_VERSION="5.1.107.96"
TALLOC_VERSION="2.5.0"
ANDROID_SHMEM_VERSION="0.7"
ALPINE_VERSION="3.24.2"
ALPINE_BASE="https://dl-cdn.alpinelinux.org/alpine/v${ALPINE_VERSION%.*}/releases/aarch64"

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$REPO_ROOT/src-tauri/android-assets"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$OUT"

# 网络抖动（含 TLS 中途断开）不该让整次构建失败，这里自己重试。
fetch() {
    local url="$1" out="$2" attempt
    for attempt in 1 2 3 4 5; do
        if curl -fsSL --retry 3 --retry-connrefused --connect-timeout 20 -o "$out" "$url"; then
            return 0
        fi
        echo "  …下载失败，第 $attempt 次重试: $url" >&2
        sleep $((attempt * 5))
    done
    echo "✗ 下载失败: $url" >&2
    return 1
}

# Termux 的 .deb：解出 data.tar.xz 后按 Termux 前缀取需要的文件。
fetch_deb() {
    local pool_path="$1" destination="$2" archive
    archive="$WORK/$(basename "$pool_path")"
    echo "→ $TERMUX_REPO/$pool_path"
    fetch "$TERMUX_REPO/$pool_path" "$archive"
    mkdir -p "$destination/deb"
    ( cd "$destination/deb" && ar x "$archive" )
    tar -xJf "$destination/deb/data.tar.xz" -C "$destination"
}

PREFIX="data/data/com.termux/files/usr"

fetch_deb "pool/main/p/proot/proot_${PROOT_VERSION}_aarch64.deb" "$WORK/proot"
fetch_deb "pool/main/libt/libtalloc/libtalloc_${TALLOC_VERSION}_aarch64.deb" "$WORK/talloc"
fetch_deb "pool/main/liba/libandroid-shmem/libandroid-shmem_${ANDROID_SHMEM_VERSION}_aarch64.deb" "$WORK/shmem"

install -m 0755 "$WORK/proot/$PREFIX/bin/proot" "$OUT/proot"
install -m 0755 "$WORK/proot/$PREFIX/libexec/proot/loader" "$OUT/proot-loader"
install -m 0644 \
    "$WORK/talloc/$PREFIX/lib/libtalloc.so.${TALLOC_VERSION}" "$OUT/libtalloc.so.2"
install -m 0644 "$WORK/shmem/$PREFIX/lib/libandroid-shmem.so" "$OUT/libandroid-shmem.so"

echo "→ $ALPINE_BASE/alpine-minirootfs-${ALPINE_VERSION}-aarch64.tar.gz"
fetch "$ALPINE_BASE/alpine-minirootfs-${ALPINE_VERSION}-aarch64.tar.gz" \
    "$OUT/alpine-minirootfs.tar.gz"

# 校验：错了要在构建前就炸，而不是等 APK 装到手机上才发现。
#
# 注意别写成 `xxx | grep -q`：脚本开了 pipefail，grep 命中就退出会让上游收到
# SIGPIPE(141)，整条管道被判失败 —— 明明校验通过却报「不通过」。先落成变量再比。
PROOT_TYPE="$(file -b "$OUT/proot" 2>/dev/null || true)"
case "$PROOT_TYPE" in
    *aarch64*) ;;
    *) echo "✗ proot 不是 aarch64 ELF（file: ${PROOT_TYPE:-无 file 命令}）" >&2; exit 1 ;;
esac

ROOTFS_LISTING="$(tar tzf "$OUT/alpine-minirootfs.tar.gz")"
case "$ROOTFS_LISTING" in
    *"./bin/sh"*) ;;
    *) echo "✗ rootfs 里没有 bin/sh" >&2; exit 1 ;;
esac

echo
echo "已就绪（src-tauri/android-assets/）："
ls -l "$OUT"
