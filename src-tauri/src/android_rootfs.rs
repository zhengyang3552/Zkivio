//! Android 的 rootfs 工作区：按需下载、可卸载。
//!
//! 桌面端的工作区是「用户挑一个目录」；Android 上没有可挑的目录，能写的地方只有
//! 应用私有目录，所以工作区是一套自带的 Linux rootfs：
//!
//! ```text
//! {app_data}/rootfs/            ← 工作区本体（Alpine），用户点了下载才有内容
//! {app_data}/rootfs-runtime/    ← proot + loader + libtalloc/libandroid-shmem + 缓存
//! ```
//!
//! **工作区按需下载**：Alpine rootfs 约 4MB，不放进 APK。用户在「工作区」页面点
//! 下载才拉，拉完校验 SHA-256 再解包；同一个按钮在就绪后变成「卸载（格式化）」，
//! 会把工作区连同里面 agent 写过的文件一起清掉。proot 及其动态库（约 300KB）
//! 仍然随包编译进去 —— 它们是运行时，不是工作区，缺了连回退路径都跑不起来。
//!
//! 两条路径互相配合：
//!
//! - **文件工具**直接按 host 路径读写 `{app_data}/rootfs/...`，不经过 proot。
//!   这是应用私有目录，读写权限齐全；没下载时它就是个空目录，照样能写。
//! - **执行命令**（agent 的 shell 工具，以后 Dock 里的 git / 终端）走
//!   `proot_command()`，进去以后 `/` 就是这套 rootfs。没下载时回退宿主 sh。
//!
//! 下载源与校验值固定在这里（官方 CDN + 清华镜像，两者 sha256 已核对一致）：
//! 校验不通过就换下一个源，全部失败则状态置为 failed，绝不解包来历不明的字节。

use std::fs;
use std::path::{Component, Path, PathBuf};
use std::process::Command;
use std::sync::{Mutex, OnceLock};

use flate2::read::GzDecoder;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager};

/// proot 本体（aarch64）。Termux 的构建：动态链接 `libtalloc` / `libandroid-shmem`，
/// 并且需要一个独立的 loader 进程做 ptrace 注入（见 PROOT_LOADER）。
const PROOT_BIN: &[u8] = include_bytes!("../android-assets/proot");
/// proot 的 ptrace loader。按 /proc/self/exe 的相对布局放在 libexec/proot/ 下，
/// 同时显式设 PROOT_LOADER，避免某些机型上相对查找落空。
const PROOT_LOADER: &[u8] = include_bytes!("../android-assets/proot-loader");
/// proot 的运行时依赖（Termux 里是 libtalloc / libandroid-shmem 两个包）。
const PROOT_LIBTALLOC: &[u8] = include_bytes!("../android-assets/libtalloc.so.2");
const PROOT_LIBANDROID_SHMEM: &[u8] = include_bytes!("../android-assets/libandroid-shmem.so");

/// 工作区版本：改这里就要同步改下面的文件名、大小与 sha256。
pub const ROOTFS_VERSION: &str = "3.24.2";
const ROOTFS_SIZE: u64 = 4_028_030;
const ROOTFS_SHA256: &str = "9bf70a7f18ea44094cbb5f70c58f9af129c8214745743db0e68e5502cc2ce773";
const ROOTFS_FILE: &str = "alpine-minirootfs-3.24.2-aarch64.tar.gz";
/// 官方源在前，国内镜像在后：国内网络下官方 CDN 常慢或不通，失败即换。
/// 多个镜像互为备份（清华 / 中科大 / 阿里云），手机网络下总有一个能通。
const ROOTFS_SOURCES: &[&str] = &[
    "https://dl-cdn.alpinelinux.org/alpine/v3.24/releases/aarch64/alpine-minirootfs-3.24.2-aarch64.tar.gz",
    "https://mirrors.tuna.tsinghua.edu.cn/alpine/v3.24/releases/aarch64/alpine-minirootfs-3.24.2-aarch64.tar.gz",
    "https://mirrors.ustc.edu.cn/alpine/v3.24/releases/aarch64/alpine-minirootfs-3.24.2-aarch64.tar.gz",
    "https://mirrors.aliyun.com/alpine/v3.24/releases/aarch64/alpine-minirootfs-3.24.2-aarch64.tar.gz",
];

/// 从下载 URL 取主机名，用于失败信息（完整 URL 太长，前端展示不下）。
fn source_host(url: &str) -> String {
    url.split("//")
        .nth(1)
        .and_then(|rest| rest.split('/').next())
        .unwrap_or(url)
        .to_string()
}

const ROOT_DIR: &str = "rootfs";
const RUNTIME_DIR: &str = "rootfs-runtime";
/// 就绪标记放在 runtime 目录，不要放进 rootfs 里 —— 那会出现在 agent 看到的 `/`。
const READY_MARKER: &str = "rootfs-ready";
const DOWNLOAD_CACHE: &str = "rootfs-download.tar.gz";

/// 前端订阅的进度事件名。
pub const PROGRESS_EVENT: &str = "android-rootfs-progress";

/// rootfs 用到的路径。构造本身不做 IO。
#[derive(Clone, Debug)]
pub struct RootfsLayout {
    pub root: PathBuf,
    pub runtime: PathBuf,
    pub proot: PathBuf,
    pub loader: PathBuf,
    pub lib_dir: PathBuf,
    pub tmp: PathBuf,
    pub download: PathBuf,
}

impl RootfsLayout {
    fn marker(&self) -> PathBuf {
        self.runtime.join(READY_MARKER)
    }
}

/// 全局缓存：`build_shell_command()` 拿不到 `AppHandle`，它的调用点遍布命令工具与
/// 后台任务，所以路径在 setup 时缓存一次（纯路径计算，无 IO）。
static LAYOUT: OnceLock<RootfsLayout> = OnceLock::new();
/// 下载 / 解包状态。锁只在读写这几个字段时短暂持有，不跨 await。
static STATE: OnceLock<Mutex<RootfsState>> = OnceLock::new();

/// 工作区状态快照（直接给前端用）。
#[derive(Clone, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RootfsState {
    /// `absent` | `downloading` | `extracting` | `ready` | `failed`
    pub status: String,
    pub received: u64,
    pub total: u64,
    pub message: Option<String>,
    pub root: String,
    pub version: String,
}

fn state_cell() -> &'static Mutex<RootfsState> {
    STATE.get_or_init(|| Mutex::new(RootfsState::default()))
}

fn snapshot() -> RootfsState {
    state_cell().lock().unwrap().clone()
}

fn update(app: &AppHandle, edit: impl FnOnce(&mut RootfsState)) {
    {
        let mut state = state_cell().lock().unwrap();
        edit(&mut state);
    }
    let _ = app.emit(PROGRESS_EVENT, snapshot());
}

fn busy() -> bool {
    matches!(
        state_cell().lock().unwrap().status.as_str(),
        "downloading" | "extracting"
    )
}

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
        download: runtime.join(DOWNLOAD_CACHE),
        runtime,
    })
}

/// setup 时调用：缓存路径 + 落地 proot 运行时（约 300KB 的写盘，不碰工作区）。
pub fn init(app: &AppHandle) {
    let layout = match layout(app) {
        Ok(layout) => layout,
        Err(err) => {
            eprintln!("[rootfs] 无法解析数据目录: {err}");
            return;
        }
    };
    let _ = LAYOUT.set(layout.clone());
    // 工作区目录先建出来：没下载时它就是个空目录，agent 照样有 cwd 可写。
    let _ = fs::create_dir_all(&layout.root);
    {
        let mut state = state_cell().lock().unwrap();
        state.root = layout.root.to_string_lossy().to_string();
        state.version = ROOTFS_VERSION.to_string();
        state.status = if is_installed(&layout) {
            "ready".to_string()
        } else {
            "absent".to_string()
        };
    }
    if let Err(err) = prepare_runtime(&layout) {
        eprintln!("[rootfs] 运行时落地失败: {err}");
    }
}

pub fn cached_layout() -> Option<&'static RootfsLayout> {
    LAYOUT.get()
}

/// 工作区已就绪（用户下载过且解包完整）。
pub fn is_installed(layout: &RootfsLayout) -> bool {
    layout.marker().is_file() && layout.root.join("bin/sh").exists()
}

/// 工作区根（host 路径）。**不会触发下载**：没下载时返回空目录。Android 上不考虑
/// 项目根 —— 没有目录选择器可用，「工作区 = rootfs 根」是定下来的唯一形态。
pub fn workspace_root(app: &AppHandle) -> Result<PathBuf, String> {
    let layout = layout(app)?;
    fs::create_dir_all(&layout.root).map_err(|e| format!("create workspace: {e}"))?;
    Ok(layout.root)
}

/// 把 proot / loader / 动态库落到 runtime 目录。幂等，内容不一致才重写。
fn prepare_runtime(layout: &RootfsLayout) -> Result<(), String> {
    fs::create_dir_all(&layout.runtime).map_err(|e| format!("create rootfs runtime: {e}"))?;
    fs::create_dir_all(&layout.tmp).map_err(|e| format!("create proot tmp: {e}"))?;
    if let Some(parent) = layout.loader.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("create loader dir: {e}"))?;
    }
    if let Some(parent) = layout.proot.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("create proot bin dir: {e}"))?;
    }
    fs::create_dir_all(&layout.lib_dir).map_err(|e| format!("create lib dir: {e}"))?;
    write_executable(&layout.proot, PROOT_BIN)?;
    write_executable(&layout.loader, PROOT_LOADER)?;
    write_bytes(&layout.lib_dir.join("libtalloc.so.2"), PROOT_LIBTALLOC)?;
    write_bytes(
        &layout.lib_dir.join("libandroid-shmem.so"),
        PROOT_LIBANDROID_SHMEM,
    )?;
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

// ===== 命令：状态 / 下载 / 卸载 =====

#[tauri::command]
pub fn android_rootfs_state(app: AppHandle) -> RootfsState {
    let layout = layout(&app).ok();
    let mut state = snapshot();
    if let Some(layout) = layout {
        state.root = layout.root.to_string_lossy().to_string();
        // 没在下载/解包时以磁盘为准：用户可能在文件管理器里删过目录。
        if !busy() {
            state.status = if is_installed(&layout) {
                "ready".to_string()
            } else {
                "absent".to_string()
            };
        }
    }
    state
}

/// 下载并解包工作区。可重复调用：已就绪时直接返回。
#[tauri::command]
pub async fn android_rootfs_install(app: AppHandle) -> Result<RootfsState, String> {
    let layout = layout(&app)?;
    prepare_runtime(&layout)?;
    if is_installed(&layout) {
        update(&app, |state| {
            state.status = "ready".to_string();
            state.message = None;
        });
        return Ok(snapshot());
    }
    if busy() {
        return Err("工作区正在处理中".to_string());
    }

    update(&app, |state| {
        state.status = "downloading".to_string();
        state.received = 0;
        state.total = ROOTFS_SIZE;
        state.message = None;
    });

    // 下载：逐源尝试，边下边算 sha256，下完立即校验。失败原因全部累积，
    // 便于区分「网络不通」还是「校验失败」。
    let mut failures: Vec<String> = Vec::new();
    let mut verified = false;
    for source in ROOTFS_SOURCES {
        match download(&app, &layout, source).await {
            Ok(()) => {
                verified = true;
                break;
            }
            Err(err) => {
                failures.push(err);
                update(&app, |state| {
                    state.message = Some(format!("下载失败，正在换源重试…\n{}", failures.join("；")));
                });
            }
        }
    }
    if !verified {
        let _ = fs::remove_file(&layout.download);
        let summary = format!("下载失败：{}", failures.join("；"));
        update(&app, |state| {
            state.status = "failed".to_string();
            state.message = Some(summary.clone());
        });
        return Err(summary);
    }

    update(&app, |state| {
        state.status = "extracting".to_string();
        state.message = None;
    });

    // 解包在阻塞线程里做（几千个文件），并且只删工作区内容、不动 runtime。
    let unpack_layout = layout.clone();
    let unpacked = tauri::async_runtime::spawn_blocking(move || {
        extract_rootfs(&unpack_layout)?;
        fs::write(unpack_layout.marker(), b"1")
            .map_err(|e| format!("write rootfs marker: {e}"))
    })
    .await
    .map_err(|e| format!("rootfs 解包任务失败: {e}"))?;

    let _ = fs::remove_file(&layout.download);
    match unpacked {
        Ok(()) => {
            update(&app, |state| {
                state.status = "ready".to_string();
                state.message = None;
                state.received = state.total;
            });
            Ok(snapshot())
        }
        Err(err) => {
            update(&app, |state| {
                state.status = "failed".to_string();
                state.message = Some(err.clone());
            });
            Err(err)
        }
    }
}

/// 卸载（格式化）：清掉工作区里的全部内容，连同 agent 写过的文件。
/// proot 运行时不属于工作区，保留（下次下载即可用）。
#[tauri::command]
pub async fn android_rootfs_uninstall(app: AppHandle) -> Result<RootfsState, String> {
    if busy() {
        return Err("工作区正在处理中".to_string());
    }
    let layout = layout(&app)?;
    let root = layout.root.clone();
    let marker = layout.marker();
    tauri::async_runtime::spawn_blocking(move || {
        match fs::remove_dir_all(&root) {
            Ok(()) => Ok(()),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(err) => Err(format!("清空工作区失败: {err}")),
        }?;
        fs::create_dir_all(&root).map_err(|e| format!("create workspace: {e}"))?;
        Ok::<_, String>(())
    })
    .await
    .map_err(|e| format!("卸载任务失败: {e}"))??;
    let _ = fs::remove_file(&marker);
    let _ = fs::remove_file(&layout.download);

    update(&app, |state| {
        state.status = "absent".to_string();
        state.received = 0;
        state.message = None;
    });
    Ok(snapshot())
}

/// 下载到 runtime 目录并校验 sha256。返回 Ok 表示字节可信（已落盘等解包）。
async fn download(app: &AppHandle, layout: &RootfsLayout, source: &str) -> Result<(), String> {
    use tokio::io::AsyncWriteExt;

    let host = source_host(source);
    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(20))
        .timeout(std::time::Duration::from_secs(900))
        .build()
        .map_err(|e| format!("http client: {e}"))?;
    let mut response = client
        .get(source)
        .send()
        .await
        .map_err(|e| format!("{host}: 连接失败（{e}）"))?;
    if !response.status().is_success() {
        return Err(format!("{host}: HTTP {}", response.status()));
    }
    let total = response.content_length().unwrap_or(ROOTFS_SIZE);

    let mut file = tokio::fs::File::create(&layout.download)
        .await
        .map_err(|e| format!("create download: {e}"))?;
    let mut hasher = Sha256::new();
    let mut received: u64 = 0;
    let mut last_emit: u64 = 0;
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|e| format!("{host}: 下载中断（{e}）"))?
    {
        hasher.update(&chunk);
        file.write_all(&chunk)
            .await
            .map_err(|e| format!("write download: {e}"))?;
        received += chunk.len() as u64;
        // 每 256KB 或每 2% 报一次，别把事件通道刷爆。
        if received - last_emit >= 262_144 || received >= total {
            last_emit = received;
            let app = app.clone();
            update(&app, |state| {
                state.received = received;
                state.total = total;
            });
        }
    }
    file.flush().await.map_err(|e| format!("flush download: {e}"))?;
    drop(file);

    let digest = heap_hex(hasher.finalize().as_slice());
    if digest != ROOTFS_SHA256 {
        return Err(format!(
            "{host}: 校验不通过（期望 {}，实际 {digest}）",
            &ROOTFS_SHA256[..16]
        ));
    }
    Ok(())
}

fn heap_hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

/// 从已下载的文件解包到工作区。
///
/// 与下载不同，这里做的是「写进工作区」：先解到临时目录再整体改名，避免中途失败
/// 留下半个 rootfs；同时挡住 `../` 逃逸，跳过应用进程建不了的条目（设备节点等）。
fn extract_rootfs(layout: &RootfsLayout) -> Result<(), String> {
    let file = fs::File::open(&layout.download).map_err(|e| format!("open download: {e}"))?;
    let staging = layout
        .root
        .parent()
        .ok_or_else(|| "rootfs parent unavailable".to_string())?
        .join(format!("{ROOT_DIR}-staging"));
    let _ = fs::remove_dir_all(&staging);
    fs::create_dir_all(&staging).map_err(|e| format!("create staging: {e}"))?;

    let mut archive = tar::Archive::new(GzDecoder::new(file));
    archive.set_preserve_permissions(true);
    archive.set_overwrite(true);

    let mut skipped = 0usize;
    let entries = archive
        .entries()
        .map_err(|e| format!("read rootfs archive: {e}"))?;
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
            eprintln!("[rootfs] 清理旧工作区失败: {err}");
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
