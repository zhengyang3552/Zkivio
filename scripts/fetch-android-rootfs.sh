#!/usr/bin/env bash
#
# 拉取 Android 端 rootfs **运行时** 素材到 src-tauri/android-assets/。
#
# 注意：工作区本体（Alpine minirootfs，约 4MB）不在这里 —— 它按需下载，
# 由应用在用户点「下载」时从固定 URL 拉取并校验 sha256（见
# src-tauri/src/android_rootfs.rs）。这里只有 proot 及其动态库（约 300KB），
# 随包编译进去；它们是运行时，不是工作区。
#
# 这些文件是二进制，因此不入库：CI 在构建前跑这个脚本，本地要出 APK 也先跑一次。
# 版本全部固定，保证同一份源码每次构建拿到同一批二进制。
#
# 素材与用途（见 src-tauri/src/android_rootfs.rs）：
#   proot / proot-loader        ptrace 方式在应用私有目录里伪造 Linux root
#   libtalloc.so.2              上面两者的动态依赖
#   libandroid-shmem.so         同上（Android 上 proot 的 SysV shm 替代）
set -euo pipefail

TERMUX_REPO="${TERMUX_REPO:-https://packages.termux.dev/apt/termux-main}"
# Termux 的 pool 只保留当前版本，旧版本会被删掉（5.1.107.96 / .98 / .100 都已 404，
# 固定版本号隔三差五就把构建打挂）。因此默认从索引自动解析现版本；
# 需要可复现构建时用环境变量覆盖（如 PROOT_VERSION=5.1.107.101）。
# 手动查索引：
#   curl -fsSL "$TERMUX_REPO/dists/stable/main/binary-aarch64/Packages.gz" | gzip -d | grep -A3 '^Package: proot$'
resolve_pool_version() {
    local pkg="$1"
    # 不能在 awk 里提前 exit：pipefail 下 awk 提前退出会给 gzip 发 SIGPIPE，
    # 整条管道被判失败（gzip: stdout: Broken pipe）。只停打印、读完全量。
    curl -fsSL --retry 3 --connect-timeout 20 \
        "$TERMUX_REPO/dists/stable/main/binary-aarch64/Packages.gz" \
        | gzip -d \
        | awk -v want="Package: $pkg" '$0 == want {f=1; next} f && /^Version:/ && !done {print $2; done=1} f && /^$/ {f=0}'
}

PROOT_VERSION="${PROOT_VERSION:-$(resolve_pool_version proot)}"
TALLOC_VERSION="${TALLOC_VERSION:-$(resolve_pool_version libtalloc)}"
ANDROID_SHMEM_VERSION="${ANDROID_SHMEM_VERSION:-$(resolve_pool_version libandroid-shmem)}"
if [ -z "$PROOT_VERSION" ] || [ -z "$TALLOC_VERSION" ] || [ -z "$ANDROID_SHMEM_VERSION" ]; then
    echo "✗ 无法从 Termux 索引解析包版本（proot=$PROOT_VERSION talloc=$TALLOC_VERSION shmem=$ANDROID_SHMEM_VERSION）" >&2
    exit 1
fi
echo "→ 版本: proot=$PROOT_VERSION libtalloc=$TALLOC_VERSION libandroid-shmem=$ANDROID_SHMEM_VERSION"

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

# jniLibs 只解包 lib*.so 命名的文件，而 proot 的 DT_NEEDED 写死 libtalloc.so.2。
# 两者只能活一个：把 DT_NEEDED 原地补成 libtalloc.so（等长，NUL 补齐），
# jniLibs 侧的文件名就叫 libtalloc.so。补完自检，没改到就炸在构建期。
perl -0777 -pi -e 's/libtalloc\.so\.2\x00/libtalloc.so\x00\x00\x00/g' "$OUT/proot"
if grep -qa "libtalloc.so.2" "$OUT/proot"; then
    echo "✗ proot 的 DT_NEEDED 打补丁失败（仍引用 libtalloc.so.2）" >&2
    exit 1
fi
echo "→ proot DT_NEEDED 已改为 libtalloc.so（jniLibs 命名约束）"
install -m 0644 \
    "$WORK/talloc/$PREFIX/lib/libtalloc.so.${TALLOC_VERSION}" "$OUT/libtalloc.so.2"
install -m 0644 "$WORK/shmem/$PREFIX/lib/libandroid-shmem.so" "$OUT/libandroid-shmem.so"

echo "→ 运行时素材就绪，校验中…"
# 校验：错了要在构建前就炸，而不是等 APK 装到手机上才发现。
#
# 注意别写成 `xxx | grep -q`：脚本开了 pipefail，grep 命中就退出会让上游收到
# SIGPIPE(141)，整条管道被判失败 —— 明明校验通过却报「不通过」。先落成变量再比。
PROOT_TYPE="$(file -b "$OUT/proot" 2>/dev/null || true)"
case "$PROOT_TYPE" in
    *aarch64*) ;;
    *) echo "✗ proot 不是 aarch64 ELF（file: ${PROOT_TYPE:-无 file 命令}）" >&2; exit 1 ;;
esac

# busybox 必须单独塞进 jniLibs：targetSdk>=29 的真机禁止 exec/dlopen 应用私有目录
# 里的文件（rootfs 里那份 /bin/busybox 因此跑不起来 —— 「ls Permission denied」）。
# jniLibs 里的库会被系统解包到 nativeLibraryDir（允许 exec），Rust 侧再用 proot
# 的绑定把它挂到 rootfs 的 /bin/busybox 上（见 android_rootfs.rs::proot_command）。
# tar 包与 Rust 侧同一份（sha256 见 android_rootfs.rs::ROOTFS_SHA256）。
ROOTFS_SHA256="9bf70a7f18ea44094cbb5f70c58f9af129c8214745743db0e68e5502cc2ce773"
ROOTFS_NAME="alpine-minirootfs-3.24.2-aarch64.tar.gz"
ROOTFS_URLS=(
    "https://dl-cdn.alpinelinux.org/alpine/v3.24/releases/aarch64/$ROOTFS_NAME"
    "https://mirrors.tuna.tsinghua.edu.cn/alpine/v3.24/releases/aarch64/$ROOTFS_NAME"
    "https://mirrors.ustc.edu.cn/alpine/v3.24/releases/aarch64/$ROOTFS_NAME"
    "https://mirrors.aliyun.com/alpine/v3.24/releases/aarch64/$ROOTFS_NAME"
)
rootfs_ok=""
for url in "${ROOTFS_URLS[@]}"; do
    if fetch "$url" "$WORK/rootfs.tar.gz"; then
        if echo "$ROOTFS_SHA256  $WORK/rootfs.tar.gz" | sha256sum -c - >/dev/null 2>&1; then
            rootfs_ok="$url"
            break
        fi
        echo "  …sha256 不符，换源: $url" >&2
    fi
done
if [ -z "$rootfs_ok" ]; then
    echo "✗ 所有镜像的 rootfs 都拉不到或校验失败" >&2
    exit 1
fi
mkdir -p "$WORK/rootfs"
tar -xzf "$WORK/rootfs.tar.gz" -C "$WORK/rootfs" bin/busybox
install -m 0755 "$WORK/rootfs/bin/busybox" "$OUT/busybox"

echo
echo "已就绪（src-tauri/android-assets/）："
ls -l "$OUT"
