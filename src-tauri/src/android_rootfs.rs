//! Android 自带的 rootfs 工作区。
//!
//! 桌面端的工作区是「用户挑一个目录」（项目根，或没有项目时的每会话 scratch 目录）；
//! Android 上没有可挑的目录，能写的地方只有应用私有目录。所以这里自带一套 rootfs：
//!
//! ```text
//! {app_data}/rootfs/            ← Alpine minirootfs 解包后的 Linux 根（工作区就是这个）
//! {app_data}/rootfs-runtime/    ← proot + loader + libtalloc/libandroid-shmem + 临时目录
//! ```
//!
//! 两条路径互相配合：
//!
//! - **文件工具**直接按 host 路径读写 `{app_data}/rootfs/...`，不经过 proot。
//!   这是能真正写下去的一条路（应用私有目录，读写权限齐全）。
//! - **执行命令**（agent 的 shell 工具、Dock 里的 git、终端）走 `proot_command()`，
//!   进去以后 `/` 就是这套 rootfs —— 于是 `/bin/sh`、`apk`、`git` 这些才存在，
//!   agent 看到的目录布局和它读写文件的路径是同一套。
//!
//! 素材（`proot` / `libtalloc.so.2` / `alpine-minirootfs-*.tar.gz`）由 CI 在构建前
//! 放到 `src-tauri/android-assets/`，用 `include_bytes!` 打进 so。**不入库**：
//! 仓库里不放二进制，也不会因为 ABI/版本变化留下陈旧副本。本地构建请先跑
//! `scripts/fetch-android-rootfs.sh`。

use std::fs;
use std::io::Cursor;
use std::path::{Component, Path, PathBuf};
use std::process::Command;
use std::sync::OnceLock;

use flate2::read::GzDecoder;
use tauri::{AppHandle, Manager};

/// proot 本体（aarch64）。Termux 的构建：动态链接 `libtalloc` / `libandroid-shmem`，
/// 并且需要一个独立的 loader 进程做 ptrace 注入（见 PROOT_LOADER）。
const PROOT_BIN: &[u8] = include_bytes!("../android-assets/proot");
/// proot 的 ptrace loader。按 /proc/self/exe 的相对布局放在 libexec/proot/ 下，
/// 同时显式设 PROOT_LOADER，避免某些机型上相对查找落空。
const PROOT_LOADER: &[u8] = include_bytes!("../android-assets/proot-loader");
/// proot 的运行时依赖（Termux 里是 libtalloc / libandroid-shmem 两个包）。
const PROOT_LIBTALLOC: &[u8] = include_bytes!("../android-assets/libtalloc.so.2");
const PROOT_LIBANDROID_SHMEM: &[u8] = include_bytes!("../android-assets/libandroid-shmem.so");
/// Alpine minirootfs：约 4MB 的 gz，解包后 ~10MB，自带 busybox / apk。
const ROOTFS_TARBALL: &[u8] = include_bytes!("../android-assets/alpine-minirootfs.tar.gz");

const ROOT_DIR: &str = "rootfs";
const RUNTIME_DIR: &str = "rootfs-runtime";
/// 就绪标记放在 runtime 目录，不要放进 rootfs 里 —— 那会出现在 agent 看到的 `/`。
const READY_MARKER: &str = "rootfs-ready";

/// rootfs 工作区用到的路径。构造本身不做 IO。
#[derive(Clone, Debug)]
pub struct RootfsLayout {
    pub root: PathBuf,
    pub runtime: PathBuf,
    pub proot: PathBuf,
    pub loader: PathBuf,
    pub lib_dir: PathBuf,
    pub tmp: PathBuf,
}

impl RootfsLayout {
    fn marker(&self) -> PathBuf {
        self.runtime.join(READY_MARKER)
    }
}

/// 全局缓存：`build_shell_command()` 拿不到 `AppHandle`，但它的调用点遍布
/// 命令工具与后台任务，所以路径在 setup 时缓存一次（纯路径计算，无 IO）。
static LAYOUT: OnceLock<RootfsLayout> = OnceLock::new();

pub fn layout(app: &AppHandle) -> Result<RootfsLayout, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir unavailable: {e}"))?;
    let runtime = base.join(RUNTIME_DIR);
    // 目录按 Termux 的布局摆：proot 会按 /proc/self/exe 去 ../libexec/proot/loader
    // 找 loader；lib 放自家目录，靠 LD_LIBRARY_PATH 命中。
    Ok(RootfsLayout {
        root: base.join(ROOT_DIR),
        proot: runtime.join("bin").join("proot"),
        loader: runtime.join("libexec").join("proot").join("loader"),
        lib_dir: runtime.join("lib"),
        tmp: runtime.join("proot-tmp"),
        runtime,
    })
}

/// setup 时调用：缓存路径并起后台解包。解包本身不在这里做，避免拖住启动。
pub fn init(app: &AppHandle) {
    match layout(app) {
        Ok(layout) => {
            let _ = LAYOUT.set(layout);
        }
        Err(err) => eprintln!("[rootfs] 无法解析数据目录: {err}"),
    }
}

pub fn cached_layout() -> Option<&'static RootfsLayout> {
    LAYOUT.get()
}

/// 后台准备（首次约几秒：解包 + 落地 proot）。重复调用是幂等的。
pub fn spawn_prepare(app: AppHandle) {
    tauri::async_runtime::spawn_blocking(move || {
        if let Err(err) = ensure(&app) {
            eprintln!("[rootfs] 准备失败: {err}");
        }
    });
}

/// 工作区根（host 路径）。Android 上不考虑项目根 —— 没有目录选择器可用，
/// 工作区固定就是这套 rootfs，与「工作区改为 rootfs」这个决定一致。
pub fn workspace_root(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(ensure(app)?.root)
}

pub fn is_ready(layout: &RootfsLayout) -> bool {
    layout.marker().is_file() && layout.root.join("bin/sh").exists() && layout.proot.is_file()
}

/// 幂等准备：`is_ready` 成立时只做一次 stat。
pub fn ensure(app: &AppHandle) -> Result<RootfsLayout, String> {
    if let Some(layout) = LAYOUT.get() {
        if is_ready(layout) {
            return Ok(layout.clone());
        }
        prepare(layout)?;
        return Ok(layout.clone());
    }
    let layout = layout(app)?;
    if is_ready(&layout) {
        let _ = LAYOUT.set(layout.clone());
        return Ok(layout);
    }
    prepare(&layout)?;
    let _ = LAYOUT.set(layout.clone());
    Ok(layout)
}

fn prepare(layout: &RootfsLayout) -> Result<(), String> {
    fs::create_dir_all(&layout.runtime).map_err(|e| format!("create rootfs runtime: {e}"))?;
    fs::create_dir_all(&layout.tmp).map_err(|e| format!("create proot tmp: {e}"))?;
    if let Some(parent) = layout.loader.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("create loader dir: {e}"))?;
    }
    fs::create_dir_all(&layout.lib_dir).map_err(|e| format!("create lib dir: {e}"))?;
    write_executable(&layout.proot, PROOT_BIN)?;
    write_executable(&layout.loader, PROOT_LOADER)?;
    write_bytes(&layout.lib_dir.join("libtalloc.so.2"), PROOT_LIBTALLOC)?;
    write_bytes(
        &layout.lib_dir.join("libandroid-shmem.so"),
        PROOT_LIBANDROID_SHMEM,
    )?;
    if !(layout.marker().is_file() && layout.root.join("bin/sh").exists()) {
        extract_rootfs(layout)?;
    }
    fs::write(layout.marker(), b"1").map_err(|e| format!("write rootfs marker: {e}"))?;
    Ok(())
}

fn write_bytes(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if fs::read(path).map(|existing| existing == bytes).unwrap_or(false) {
        return Ok(());
    }
    fs::write(path, bytes).map_err(|e| format!("write {}: {e}", path.display()))
}

fn write_executable(path: &Path, bytes: &[u8]) -> Result<(), String> {
    write_bytes(path, bytes)?;
    use std::os::unix::fs::PermissionsExt;
    let mut perms = fs::metadata(path)
        .map_err(|e| format!("stat {}: {e}", path.display()))?
        .permissions();
    perms.set_mode(0o755);
    fs::set_permissions(path, perms).map_err(|e| format!("chmod {}: {e}", path.display()))
}

/// 解包到临时目录再整体改名，避免中途失败留下半个 rootfs。
fn extract_rootfs(layout: &RootfsLayout) -> Result<(), String> {
    let staging = layout
        .root
        .parent()
        .ok_or_else(|| "rootfs parent unavailable".to_string())?
        .join(format!("{ROOT_DIR}-staging"));
    let _ = fs::remove_dir_all(&staging);
    fs::create_dir_all(&staging).map_err(|e| format!("create staging: {e}"))?;

    let mut archive = tar::Archive::new(GzDecoder::new(Cursor::new(ROOTFS_TARBALL)));
    archive.set_preserve_permissions(true);
    archive.set_overwrite(true);

    let mut skipped = 0usize;
    let entries = archive.entries().map_err(|e| format!("read rootfs archive: {e}"))?;
    for entry in entries {
        let mut entry = match entry {
            Ok(entry) => entry,
            Err(err) => {
                skipped += 1;
                eprintln!("[rootfs] 跳过损坏条目: {err}");
                continue;
            }
        };
        let relative = match entry.path() {
            Ok(path) => path.into_owned(),
            Err(err) => {
                skipped += 1;
                eprintln!("[rootfs] 跳过无路径条目: {err}");
                continue;
            }
        };
        // 挡住 ../ 逃逸（tarball 来自上游，仍然不信任它的路径）。
        if relative
            .components()
            .any(|c| matches!(c, Component::ParentDir | Component::RootDir))
        {
            skipped += 1;
            continue;
        }
        let destination = staging.join(&relative);
        let entry_type = entry.header().entry_type();
        if entry_type.is_dir() {
            if let Err(err) = fs::create_dir_all(&destination) {
                skipped += 1;
                eprintln!("[rootfs] 建目录失败 {}: {err}", relative.display());
            }
            continue;
        }
        if entry_type.is_file() || entry_type.is_symlink() || entry_type.is_hard_link() {
            if let Some(parent) = destination.parent() {
                let _ = fs::create_dir_all(parent);
            }
            if let Err(err) = entry.unpack(&destination) {
                skipped += 1;
                eprintln!("[rootfs] 解包失败 {}: {err}", relative.display());
            }
            continue;
        }
        // 设备节点 / FIFO / 其它：应用进程建不了，rootfs 里也不需要（运行时由 -b /dev 提供）。
        skipped += 1;
    }

    if !staging.join("bin/sh").exists() {
        let _ = fs::remove_dir_all(&staging);
        return Err(format!("rootfs 解包不完整（缺少 bin/sh，跳过 {skipped} 条）"));
    }
    if let Err(err) = fs::remove_dir_all(&layout.root) {
        if err.kind() != std::io::ErrorKind::NotFound {
            eprintln!("[rootfs] 清理旧 rootfs 失败: {err}");
        }
    }
    fs::rename(&staging, &layout.root).map_err(|e| format!("promote rootfs: {e}"))?;
    if skipped > 0 {
        eprintln!("[rootfs] 解包完成，跳过 {skipped} 条");
    }
    Ok(())
}

/// 把一个 shell 脚本包进 proot，在 rootfs 里执行。
///
/// - `-0`：在 guest 内伪造成 uid 0（rootfs 里的文件本来就是我们自己的 uid）。
/// - `-b /dev /proc /sys`：把宿主这几处接进去，否则 rootfs 里没有 `/dev/null`、
///   没有 `/proc`，几乎什么都跑不了。
/// - 不传 `-w`：proot 会把继承来的 host cwd 翻译成 guest 路径；工作区根就是
///   rootfs 根，调用方设的 cwd 一定在这棵树里。
/// - `PROOT_NO_SECCOMP=1`：Android 的 seccomp 过滤器会让 ptrace 型 proot 在某些
///   机型上直接失败，关掉这条优化换取能跑。
pub fn proot_command(layout: &RootfsLayout, script: &str) -> Command {
    let mut command = Command::new(&layout.proot);
    command
        .arg(format!("--rootfs={}", layout.root.display()))
        .arg("-0")
        .arg("-b")
        .arg("/dev")
        .arg("-b")
        .arg("/proc")
        .arg("-b")
        .arg("/sys")
        .arg("--kill-on-exit")
        .arg("/bin/sh")
        .arg("-c")
        .arg(script)
        .env("PROOT_TMP_DIR", &layout.tmp)
        .env("PROOT_NO_SECCOMP", "1")
        .env("PROOT_LOADER", &layout.loader)
        .env("LD_LIBRARY_PATH", &layout.lib_dir)
        .env("HOME", "/root")
        .env("TERM", "xterm-256color")
        .env("LANG", "C.UTF-8")
        .env(
            "PATH",
            "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        );
    command
}

/// 前端用的就绪状态（设置页 / 首屏提示用）。
#[tauri::command]
pub fn android_rootfs_status(app: AppHandle) -> Result<serde_json::Value, String> {
    let layout = layout(&app)?;
    Ok(serde_json::json!({
        "ready": is_ready(&layout),
        "root": layout.root.to_string_lossy(),
    }))
}

/// 手动触发一次准备（首次进入聊天页时前端可以调，避免第一条命令等解包）。
#[tauri::command]
pub async fn android_rootfs_prepare(app: AppHandle) -> Result<serde_json::Value, String> {
    let layout = ensure(&app)?;
    Ok(serde_json::json!({
        "ready": true,
        "root": layout.root.to_string_lossy(),
    }))
}
