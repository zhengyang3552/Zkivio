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
//! - **文件工具**直接按 host 路径读写 `{app_data}/workspace/...`（agent 侧显示为
//!   `/workspace`，见 `map_guest_path` / `guest_display_path`），不经过 proot。
//!   这是应用私有目录，读写权限齐全；没下载时它就是个空目录，照样能写。
//! - **执行命令**（agent 的 shell 工具，以后 Dock 里的 git / 终端）走
//!   `proot_command()`，进去以后 `/` 是 rootfs、`/workspace` 是用户文件区。
//!   没下载时回退宿主 sh。
//!
//! 下载源与校验值固定在这里（官方 CDN + 清华镜像，两者 sha256 已核对一致）：
//! 校验不通过就换下一个源，全部失败则状态置为 failed，绝不解包来历不明的字节。

use std::fs;
use std::path::{Component, Path, PathBuf};
use std::process::Command;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

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
/// 用户文件区目录（host）。proot 把它挂到 guest 的 [`GUEST_WORKSPACE_DIR`]。
const WORKSPACE_DIR: &str = "workspace";
const RUNTIME_DIR: &str = "rootfs-runtime";
/// 就绪标记放在 runtime 目录，不要放进 rootfs 里 —— 那会出现在 agent 看到的 `/`。
const READY_MARKER: &str = "rootfs-ready";
const DOWNLOAD_CACHE: &str = "rootfs-download.tar.gz";

/// guest 内用户文件区的挂载点。提示词、文件工具的路径翻译都用这一个常量。
pub const GUEST_WORKSPACE_DIR: &str = "/workspace";

/// 前端订阅的进度事件名。
pub const PROGRESS_EVENT: &str = "android-rootfs-progress";

/// 进度上报的最小间隔。原来按「累计 256KB 才报一次」节流，在手机慢网下第一段
/// 256KB 可能要走十几秒，界面就一直停在 0%；改成按时间节流，第一个分片就能把
/// 进度条推动起来。
const PROGRESS_INTERVAL: Duration = Duration::from_millis(120);

/// 单次读取允许的最长静默。源站在握手之后不再吐数据时，不该让用户对着 0% 等到
/// 客户端的总超时（15 分钟）才换源：15 秒没新分片就判这次尝试失败，换下一个镜像。
const CHUNK_IDLE_TIMEOUT: Duration = Duration::from_secs(15);
const CHUNK_IDLE_TIMEOUT_SECS: u64 = 15;

/// rootfs 用到的路径。构造本身不做 IO。
#[derive(Clone, Debug)]
pub struct RootfsLayout {
    pub root: PathBuf,
    /// 用户文件区（host 路径），proot 里挂载为 `/workspace`。
    /// 与 rootfs 分离：重装系统不动用户文件，agent 也不能借 shell 改坏发行版本体。
    pub workspace: PathBuf,
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
        workspace: base.join(WORKSPACE_DIR),
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
    let _ = fs::create_dir_all(&layout.workspace);
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
    layout.marker().is_file() && has_shell(&layout.root)
}

/// rootfs 里的 `bin/sh` 是指向 `/bin/busybox` 的**绝对**软链，指向 guest 的 `/`。
/// `Path::exists()` 会跟随软链、按宿主根解析，在 Android 上 `/bin` 不存在 → 永远判为缺失，
/// 于是「下载成功、解包成功」也会被当成失败。这里只看链接本身在不在。
fn has_shell(root: &Path) -> bool {
    fs::symlink_metadata(root.join("bin/sh")).is_ok()
}

/// 工作区根（host 路径）＝**用户文件区**，proot 里挂载为 `/workspace`。
/// **不会触发下载**：没下载时它就是个空目录，agent 照样有 cwd 可写。
/// Android 上不考虑项目根 —— 没有目录选择器可用。
///
/// 与 `rootfs/`（发行版本体）分离：重装系统、卸载都不碰这里，agent 写的文件
/// （报告、脚本、导出物）只落在这个目录，SAF 也按这个目录暴露。
pub fn workspace_root(app: &AppHandle) -> Result<PathBuf, String> {
    let layout = layout(app)?;
    fs::create_dir_all(&layout.workspace)
        .map_err(|e| format!("create workspace: {e}"))?;
    Ok(layout.workspace)
}

/// init 之后可用的用户文件区（host 路径）。桌面端 / 未 setup 时为 None，
/// 调用方（native_tools 的路径翻译）据此整体跳过。
pub fn cached_workspace_root() -> Option<&'static Path> {
    LAYOUT.get().map(|layout| layout.workspace.as_path())
}

/// guest 的 `/workspace[/相对路径]` → host 用户文件区里的真实路径。
/// 不是工作区路径（`/etc`、`/root`、任意绝对路径）返回 None，调用方按原逻辑处理。
pub fn map_guest_path(raw: &str) -> Option<PathBuf> {
    map_guest_path_with(cached_workspace_root()?, raw)
}

fn map_guest_path_with(root: &Path, raw: &str) -> Option<PathBuf> {
    let rest = raw.trim().strip_prefix(GUEST_WORKSPACE_DIR)?;
    if !rest.is_empty() && !rest.starts_with('/') {
        return None; // "/workspacefoo" 这类前缀混淆，按非工作区路径处理
    }
    let relative = rest.trim_start_matches('/');
    if relative.split('/').any(|segment| segment == "..") {
        return None; // 越界交给调用方按原逻辑报错
    }
    Some(if relative.is_empty() {
        root.to_path_buf()
    } else {
        root.join(relative)
    })
}

/// host 路径 → guest 显示路径（`/workspace/...`）。不在文件区内返回 None。
pub fn guest_display_path(path: &Path) -> Option<String> {
    guest_display_path_with(cached_workspace_root()?, path)
}

fn guest_display_path_with(root: &Path, path: &Path) -> Option<String> {
    let relative = path.strip_prefix(root).ok()?.to_string_lossy().into_owned();
    Some(if relative.is_empty() {
        GUEST_WORKSPACE_DIR.to_string()
    } else {
        format!("{GUEST_WORKSPACE_DIR}/{relative}")
    })
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

/// 卸载：只清发行版本体（rootfs/，连同 apk 装进去的包），用户文件区
/// `workspace/` **保留** —— 那是 agent 写的报告 / 脚本 / 导出物。proot 运行时
/// 不属于工作区，也保留（下次下载即可用）。
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
    let client = crate::http::client_builder()
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
    let total = response
        .content_length()
        .filter(|value| *value > 0)
        .unwrap_or(ROOTFS_SIZE);

    // 每个源都从 0 重新计：上一源的部分字节留在条上会让「换源」看起来像卡死在 100%。
    update(app, |state| {
        state.status = "downloading".to_string();
        state.received = 0;
        state.total = total;
    });

    let mut file = tokio::fs::File::create(&layout.download)
        .await
        .map_err(|e| format!("create download: {e}"))?;
    let mut hasher = Sha256::new();
    let mut received: u64 = 0;
    let mut reported: u64 = 0;
    let mut last_emit = Instant::now();
    loop {
        // 读分片本身也要有上限，否则源站挂住时整个下载会一直停在原地。
        let chunk = match tokio::time::timeout(CHUNK_IDLE_TIMEOUT, response.chunk()).await {
            Err(_) => {
                return Err(format!(
                    "{host}: {CHUNK_IDLE_TIMEOUT_SECS} 秒没有收到数据（网络停滞）"
                ))
            }
            Ok(Err(e)) => return Err(format!("{host}: 下载中断（{e}）")),
            Ok(Ok(None)) => break,
            Ok(Ok(Some(chunk))) => chunk,
        };
        hasher.update(&chunk);
        file.write_all(&chunk)
            .await
            .map_err(|e| format!("write download: {e}"))?;
        received += chunk.len() as u64;
        // 时间到了就报一次；下完最后一个分片也报，保证能走到 100%。
        if received >= total || last_emit.elapsed() >= PROGRESS_INTERVAL {
            last_emit = Instant::now();
            reported = received;
            let app = app.clone();
            update(&app, |state| {
                state.received = received;
                state.total = total;
            });
        }
    }
    if reported != received {
        let app = app.clone();
        update(&app, |state| {
            state.received = received;
            state.total = total;
        });
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

    if !has_shell(&staging) {
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

// ===== rootfs /etc 补丁 =====

/// 视为「本地 resolver」：Android/Ubuntu 的 stub（127.0.0.53）或 loopback，
/// guest 里没有对应的监听者，写进 resolv.conf 只会让解析失败。
const LOCAL_RESOLVERS: [&str; 3] = ["127.0.0.1", "127.0.0.53", "::1"];
/// 兜底公共 DNS。musl 的 resolver 按顺序尝试，国内网络下 223.5.5.5 往往比 8.8.8.8 稳。
const FALLBACK_DNS: [&str; 3] = ["1.1.1.1", "8.8.8.8", "223.5.5.5"];
/// guest 内的 HOME。Alpine minirootfs 自带 /root；不存在时由 ensure_tmp_dirs 兜底。
const GUEST_HOME: &str = "/root";

/// 每次进 proot 前给 rootfs 打 /etc 补丁（幂等）。
///
/// Alpine minirootfs 里**没有** `/etc/resolv.conf`，而 Android 不向应用暴露系统
/// DNS（netd 管着，/etc 里什么都没有）→ guest 里 `apk` / `curl` 全部
/// "Could not resolve host"。这里补齐：
///
/// - `resolv.conf`：缺失 / 是软链 / 只有本地 resolver 时重写；手工覆盖（见
///   `discover_nameservers`）存在时强制重写
/// - `hosts`：补齐 `127.0.0.1 localhost` 与 `::1 localhost`（minirootfs 自带，
///   防用户删过）
/// - `default/locale`：`LANG=C.UTF-8`
/// - `group`：把 Android 的附加 GID 补成组，`id` / `groups` 不报错
/// - `tmp`、`var/tmp`、`root`：存在且权限正确
///
/// 绝大多数时候只是读几个小文件的时间；真正写盘只发生在「刚装好 rootfs」「
/// resolv.conf 被破坏」或「用户改了手工覆盖」时。所有进 guest 的入口都经过
/// `proot_command()`，补丁挂在那里。
pub fn patch_rootfs(layout: &RootfsLayout) {
    if !layout.root.join("etc").is_dir() {
        return; // 没安装：不在空目录上乱写
    }
    let steps: [(&str, fn(&RootfsLayout) -> Result<(), String>); 4] = [
        ("resolv.conf", patch_resolv_conf),
        ("hosts", patch_hosts),
        ("locale", patch_locale),
        ("group", patch_group),
    ];
    for (name, step) in steps {
        if let Err(err) = step(layout) {
            eprintln!("[rootfs] /etc/{name} 补丁失败: {err}");
        }
    }
    ensure_tmp_dirs(layout);
}

fn patch_resolv_conf(layout: &RootfsLayout) -> Result<(), String> {
    let path = layout.root.join("etc/resolv.conf");
    // symlink_metadata 而不是 exists()：resolv.conf 若是指向 /proc/... 的软链，
    // 宿主上必然解析不到，要按「需要重写」处理而不是写穿软链。
    let meta = fs::symlink_metadata(&path).ok();
    let usable = meta.as_ref().is_some_and(|m| m.is_file())
        && fs::read_to_string(&path)
            .map(|text| has_usable_nameserver(&text))
            .unwrap_or(false);
    let (servers, forced) = discover_nameservers(layout);
    if usable && !forced {
        return Ok(());
    }
    let mut text = String::from("# Generated by Kivio rootfs workspace.\n");
    for server in servers {
        text.push_str("nameserver ");
        text.push_str(&server);
        text.push('\n');
    }
    text.push_str("options edns0 trust-ad\n");
    let _ = fs::remove_file(&path);
    fs::write(&path, text).map_err(|e| format!("write {}: {e}", path.display()))
}

/// 收集可用的 nameserver，按优先级：
/// 手工覆盖（环境变量 `KIVIO_ROOTFS_DNS` 或 `{runtime}/dns` 文件，每行一个）
/// → Android 系统属性 `net.dns1..4`（ROM 不一定导出，取到算赚到）
/// → 默认网关（家庭/公司 Wi-Fi 下多半就是解析器，比公共 DNS 更贴近本网络）
/// → 公共 DNS 兜底。
///
/// 有手工覆盖时**只用**覆盖里的那几条并返回 `forced = true`：用户显式指定 DNS
/// （内网解析、分流）就是要走那条，再混进公共 DNS 会让查询在超时后泄漏到别处，
/// 结果不可预期。带 getprop 有 spawn 开销，但本函数只在需要重写时调用，
/// 日常执行不进这里。网络切换（Wi-Fi ↔ 流量）后属性值会变——下次重写时生效；
/// 急用时写 `{runtime}/dns` 覆盖即可立刻生效。
fn discover_nameservers(layout: &RootfsLayout) -> (Vec<String>, bool) {
    let mut servers: Vec<String> = Vec::new();

    // 1) 手工覆盖：内网 DNS / 分流场景下用这个立刻生效，且只用它。
    let mut forced = false;
    if let Ok(list) = std::env::var("KIVIO_ROOTFS_DNS") {
        for server in list.split(|c: char| c == ',' || c.is_whitespace()) {
            push_server(&mut servers, server);
        }
        forced = true;
    }
    if let Ok(text) = fs::read_to_string(layout.runtime.join("dns")) {
        for line in text.lines() {
            push_server(&mut servers, line);
        }
        forced = true;
    }
    if forced && !servers.is_empty() {
        return (servers, true);
    }

    // 2) Android 系统属性
    for index in 1..=4 {
        if let Some(server) = system_prop(&format!("net.dns{index}")) {
            push_server(&mut servers, &server);
        }
    }
    // 3) 默认网关
    if let Some(server) = default_gateway() {
        push_server(&mut servers, &server);
    }
    // 4) 公共兜底
    for server in FALLBACK_DNS {
        push_server(&mut servers, server);
    }
    // resolver 逐条尝试、超时是叠加的：写太多条反而拖慢失败路径。
    servers.truncate(3);
    (servers, forced)
}

/// 去重 + 过滤本地 stub 后追加一条 nameserver。
fn push_server(servers: &mut Vec<String>, server: &str) {
    let server = server.trim();
    if server.is_empty() || is_local_resolver(server) {
        return;
    }
    if servers.iter().any(|known| known.eq_ignore_ascii_case(server)) {
        return;
    }
    servers.push(server.to_string());
}

fn is_local_resolver(server: &str) -> bool {
    LOCAL_RESOLVERS
        .iter()
        .any(|local| local.eq_ignore_ascii_case(server))
}

/// 读 Android 系统属性。桌面 / 模拟器上没有 getprop，直接 None。
fn system_prop(name: &str) -> Option<String> {
    let getprop = Path::new("/system/bin/getprop");
    if !getprop.is_file() {
        return None;
    }
    let output = Command::new(getprop).arg(name).output().ok()?;
    let value = String::from_utf8_lossy(&output.stdout).trim().to_string();
    (!value.is_empty()).then_some(value)
}

/// `/proc/net/route` 里找默认路由的网关（点分十进制，字段是小端十六进制）。
/// Android 10+ 对 /proc/net 有访问限制，读不到就放弃（后续用公共 DNS）。
fn default_gateway() -> Option<String> {
    let text = fs::read_to_string("/proc/net/route").ok()?;
    for line in text.lines().skip(1) {
        let fields: Vec<&str> = line.split_whitespace().collect();
        if fields.len() < 3 || fields[1] != "00000000" {
            continue;
        }
        let raw = u32::from_str_radix(fields[2], 16).ok()?;
        if raw == 0 {
            continue; // 没有「默认网关」行（纯流量网络等），交给兜底列表
        }
        return Some(format!(
            "{}.{}.{}.{}",
            raw & 0xff,
            (raw >> 8) & 0xff,
            (raw >> 16) & 0xff,
            (raw >> 24) & 0xff
        ));
    }
    None
}

fn has_usable_nameserver(text: &str) -> bool {
    text.lines().any(|line| {
        let Some(server) = line.trim().strip_prefix("nameserver") else {
            return false;
        };
        let server = server.trim();
        !server.is_empty() && !is_local_resolver(server)
    })
}

fn patch_hosts(layout: &RootfsLayout) -> Result<(), String> {
    let path = layout.root.join("etc/hosts");
    let text = fs::read_to_string(&path).unwrap_or_default();
    let mut has_v4 = false;
    let mut has_v6 = false;
    for line in text.lines() {
        // 去掉注释再按空白拆；格式：IP 主机名…（minirootfs 自带 localdomain 别名）
        let fields: Vec<&str> = line
            .split('#')
            .next()
            .unwrap_or("")
            .split_whitespace()
            .collect();
        let Some(first) = fields.first() else {
            continue;
        };
        if fields.iter().any(|field| *field == "localhost") {
            has_v4 |= *first == "127.0.0.1";
            has_v6 |= *first == "::1";
        }
    }
    if has_v4 && has_v6 {
        return Ok(());
    }
    let mut updated = text;
    if !updated.is_empty() && !updated.ends_with('\n') {
        updated.push('\n');
    }
    if !has_v4 {
        updated.push_str("127.0.0.1 localhost\n");
    }
    if !has_v6 {
        updated.push_str("::1 localhost ip6-localhost ip6-loopback\n");
    }
    fs::write(&path, updated).map_err(|e| format!("write {}: {e}", path.display()))
}

fn patch_locale(layout: &RootfsLayout) -> Result<(), String> {
    let dir = layout.root.join("etc/default");
    fs::create_dir_all(&dir).map_err(|e| format!("create etc/default: {e}"))?;
    let path = dir.join("locale");
    let text = fs::read_to_string(&path).unwrap_or_default();
    if text.lines().any(|line| line.trim_start().starts_with("LANG=")) {
        return Ok(());
    }
    let mut updated = text;
    if !updated.is_empty() && !updated.ends_with('\n') {
        updated.push('\n');
    }
    updated.push_str("LANG=C.UTF-8\n");
    fs::write(&path, updated).map_err(|e| format!("write {}: {e}", path.display()))
}

fn patch_group(layout: &RootfsLayout) -> Result<(), String> {
    let path = layout.root.join("etc/group");
    if !path.is_file() {
        fs::write(&path, "root:x:0:\n").map_err(|e| format!("write {}: {e}", path.display()))?;
        return Ok(());
    }
    let text = fs::read_to_string(&path).unwrap_or_default();
    let existing_ids: Vec<u32> = text
        .lines()
        .filter_map(|line| line.split(':').nth(2).and_then(|id| id.parse().ok()))
        .collect();
    let additions: Vec<String> = android_group_ids()
        .into_iter()
        .filter(|id| !existing_ids.contains(id))
        .map(|id| format!("android_gid_{id}:x:{id}:\n"))
        .collect();
    if additions.is_empty() {
        return Ok(());
    }
    let mut updated = text;
    if !updated.ends_with('\n') {
        updated.push('\n');
    }
    for line in additions {
        updated.push_str(&line);
    }
    fs::write(&path, updated).map_err(|e| format!("write {}: {e}", path.display()))
}

/// Android 应用的附加 GID（`/proc/self/status` 的 `Groups:`）。
/// rootfs 的 /etc/group 里没有它们，`id` / `groups` 会报 unknown 或显示空。
fn android_group_ids() -> Vec<u32> {
    let Ok(status) = fs::read_to_string("/proc/self/status") else {
        return Vec::new();
    };
    let Some(line) = status.lines().find(|line| line.starts_with("Groups:")) else {
        return Vec::new();
    };
    line["Groups:".len()..]
        .split_whitespace()
        .filter_map(|id| id.parse().ok())
        .collect()
}

/// guest 的 /tmp、/var/tmp（1777）与 /root：minirootfs 自带，用户可能整目录删过，幂等兜底。
fn ensure_tmp_dirs(layout: &RootfsLayout) {
    use std::os::unix::fs::PermissionsExt;
    for path in ["tmp", "var/tmp"] {
        let dir = layout.root.join(path);
        if dir.is_dir() {
            continue;
        }
        if fs::create_dir_all(&dir).is_ok() {
            let _ = fs::set_permissions(&dir, fs::Permissions::from_mode(0o1777));
        }
    }
    let home = layout.root.join("root");
    if !home.is_dir() {
        let _ = fs::create_dir_all(&home);
    }
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
///
/// **W^X 与 jniLibs**：targetSdk>=29 的真机禁止 exec/dlopen 应用私有目录里的文件
/// （shell 一调用就报 "Permission denied"）。CI 把 proot / loader / busybox /
/// 动态库塞进 jniLibs（`scripts/install-android-jni-libs.sh`），系统解包到
/// nativeLibraryDir —— 那里允许 exec；本函数从 /proc/self/maps 解析该目录并优先
/// 使用。解析不到（老模拟器 ROM 未 enforce，或布局未就绪）则回退私有目录布局。
/// busybox 同时被 proot 绑定到 rootfs 的 /bin/busybox —— rootfs 里那份同样在
/// 私有目录里，`/bin/ls`（指向 /bin/busybox 的符号链接）的最终 execve 落点
/// 必须落在 nativeLibraryDir 才能通过。
///
/// **环境隔离**：guest 环境用 `/usr/bin/env -i` 从零重建（HOME/PATH/TERM/LANG…），
/// 不能靠 `.env()` 往 proot 进程上补 —— 那会把宿主变量原样漏进 guest，尤其
/// `LD_LIBRARY_PATH`（proot 自己要用它找 libtalloc）会让 musl 的动态链接器去
/// runtime/lib 找 libc，出现「busybox 能跑、别的程序段错误」的玄学。
pub fn proot_command(layout: &RootfsLayout, script: &str) -> Command {
    // 进 guest 前补 /etc。放在这里而不是各个调用点：所有入口（shell 工具、
    // Dock 终端、后台任务）都经过本函数，补丁幂等，不会重复写。
    patch_rootfs(layout);

    let native = native_lib_dir();
    let (proot, loader, lib_dir) = match &native {
        Some(dir) => (
            dir.join("libproot.so"),
            dir.join("libproot_loader.so"),
            dir.clone(),
        ),
        None => (
            layout.proot.clone(),
            layout.loader.clone(),
            layout.lib_dir.clone(),
        ),
    };
    let mut command = Command::new(&proot);
    // proot 进程只认 PROOT_* 与 LD_LIBRARY_PATH，其余一律不给。
    command.env_clear();
    command
        .env("PROOT_TMP_DIR", &layout.tmp)
        .env("PROOT_NO_SECCOMP", "1")
        .env("PROOT_LOADER", &loader)
        .env("LD_LIBRARY_PATH", &lib_dir)
        // proot 进程自己的 PATH（与 guest 无关），够它找到宿主侧工具即可。
        .env("PATH", "/system/bin:/system/xbin:/vendor/bin:/sbin");

    command
        .arg(format!("--rootfs={}", layout.root.display()))
        .arg("-0")
        .arg("-b")
        .arg("/dev")
        .arg("-b")
        .arg("/proc")
        .arg("-b")
        .arg("/sys")
        // 用户文件区：host 的 workspace/ 挂为 guest 的 /workspace。与 rootfs 分离，
        // 重装系统 / 卸载都不碰用户文件；agent 的 cwd（调用方设的 current_dir）
        // 落在这棵树里时 proot 会自动翻译成 /workspace/...。
        .arg("-b")
        .arg(format!(
            "{}:{}",
            layout.workspace.display(),
            GUEST_WORKSPACE_DIR
        ));
    if let Some(dir) = &native {
        command
            .arg("-b")
            .arg(format!("{}/libbusybox.so:/bin/busybox", dir.display()));
    }
    command
        .arg("--kill-on-exit")
        // guest 环境从零重建。/usr/bin/env 是指向 /bin/busybox 的绝对软链：
        // native 布局下 busybox 已被 -b 到允许 exec 的 nativeLibraryDir，这一步
        // execve 才过得去；模拟器回退布局下与 /bin/sh 同进退。
        .arg("/usr/bin/env")
        .arg("-i")
        .arg(format!("HOME={GUEST_HOME}"))
        .arg("PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin")
        .arg("TERM=xterm-256color")
        .arg("LANG=C.UTF-8")
        .arg("LC_ALL=C.UTF-8")
        .arg("TMPDIR=/tmp")
        // 降噪：与 shell 工具的 apply_shell_tool_env 同一套值（NO_COLOR / FORCE_COLOR /
        // PAGER），刻意不设 CI=1 —— 那边已定过规则：CI 会改变部分工具行为。TERM 用
        // xterm-256color 而不是 dumb，因为 proot_command 也是 Dock 终端的启动路径；
        // 输出走管道时不产生转义序列，颜色由 NO_COLOR 兜住。
        .arg("NO_COLOR=1")
        .arg("FORCE_COLOR=0")
        .arg("PAGER=cat")
        .arg("/bin/sh")
        .arg("-c")
        .arg(script);
    command
}

/// Android 上可 exec 的本机库目录（nativeLibraryDir）。
///
/// 没法走 JNI：linker 把主 so 从 nativeLibraryDir 映射进进程，/proc/self/maps
/// 里必然有 `<dir>/libkivio.so` 这样的行，取目录即可。要求 CI 侧
/// extractNativeLibs=true（见 scripts/install-android-jni-libs.sh），否则原生库
/// 直接从 APK 里映射，路径带 `base.apk!/`，不是真目录。
#[cfg(target_os = "android")]
fn native_lib_dir() -> Option<PathBuf> {
    static CACHE: OnceLock<Option<PathBuf>> = OnceLock::new();
    CACHE
        .get_or_init(|| {
            let maps = fs::read_to_string("/proc/self/maps").ok()?;
            for line in maps.lines() {
                let Some(path) = line.split_whitespace().last() else {
                    continue;
                };
                if !path.ends_with(".so") {
                    continue;
                }
                let Some(idx) = path.find("/lib/arm64/") else {
                    continue;
                };
                let dir = PathBuf::from(&path[..idx]).join("lib").join("arm64");
                if dir.join("libproot.so").is_file() {
                    return Some(dir);
                }
            }
            None
        })
        .clone()
}

#[cfg(not(target_os = "android"))]
fn native_lib_dir() -> Option<PathBuf> {
    None
}

/// 系统提示里的 `<workspace>` 段：告诉模型它在 proot 的 Alpine 里、文件区在
/// `/workspace`、文件工具收什么路径。rootfs 未就绪时返回 None（调用方整段跳过，
/// 与 shell 工具的注入条件一致）。桌面端 LAYOUT 未初始化，恒 None。
pub fn workspace_prompt_segment() -> Option<String> {
    let layout = LAYOUT.get()?;
    if !is_installed(layout) {
        return None;
    }
    let distro = read_distro_name(layout)
        .unwrap_or_else(|| "Alpine Linux".to_string());
    Some(format!(
        "<workspace>\n\
         You are running inside a sandboxed {distro} rootfs (proot) on Android.\n\
         - The user's file area is mounted at {GUEST_WORKSPACE_DIR}. Create and edit all\n\
           user-facing files there; files persist for this conversation.\n\
         - File tools accept absolute paths under {GUEST_WORKSPACE_DIR} (for example\n\
           {GUEST_WORKSPACE_DIR}/notes.md) and report paths in the same form.\n\
         - Shell commands run inside the rootfs as root. The shell is BusyBox /bin/sh,\n\
           not bash: avoid bash-only syntax (arrays, here-strings, brace expansion).\n\
         - Install extra tooling with `apk add <package>` when needed.\n\
         - /root is HOME; treat /etc and /usr as system files and do not modify them.\n\
         </workspace>"
    ))
}

/// 发行版名：读 rootfs 里的 os-release（`/etc/os-release` 是指向
/// `../usr/lib/os-release` 的**相对**软链，宿主侧解析不会跑出 rootfs）。
fn read_distro_name(layout: &RootfsLayout) -> Option<String> {
    for path in ["etc/os-release", "usr/lib/os-release"] {
        let Ok(text) = fs::read_to_string(layout.root.join(path)) else {
            continue;
        };
        let values: std::collections::HashMap<&str, &str> = text
            .lines()
            .filter_map(|line| {
                let line = line.trim();
                if line.starts_with('#') {
                    return None;
                }
                let (key, value) = line.split_once('=')?;
                Some((key, value.trim().trim_matches(['"', '\''])))
            })
            .collect();
        let name = values
            .get("PRETTY_NAME")
            .filter(|name| !name.is_empty())
            .map(|name| name.to_string())
            .or_else(|| {
                match (values.get("NAME"), values.get("VERSION_ID")) {
                    (Some(name), Some(version)) => Some(format!("{name} {version}")),
                    (Some(name), None) => Some(name.to_string()),
                    _ => None,
                }
            })?;
        let name: String = name.chars().filter(|c| !c.is_control()).collect();
        let name = name.trim().to_string();
        if !name.is_empty() {
            return Some(name.chars().take(80).collect());
        }
    }
    None
}

#[cfg(test)]
mod guest_path_tests {
    use super::*;

    fn root() -> PathBuf {
        PathBuf::from("/data/user/0/com.zmair.kivio/files/workspace")
    }

    #[test]
    fn guest_paths_map_into_the_workspace_dir() {
        assert_eq!(map_guest_path_with(&root(), "/workspace"), Some(root()));
        assert_eq!(
            map_guest_path_with(&root(), "/workspace/notes.md"),
            Some(root().join("notes.md"))
        );
        assert_eq!(
            map_guest_path_with(&root(), "/workspace/a/b/c.txt"),
            Some(root().join("a/b/c.txt"))
        );
    }

    #[test]
    fn non_workspace_and_unsafe_paths_are_rejected() {
        assert_eq!(map_guest_path_with(&root(), "/etc/passwd"), None);
        assert_eq!(map_guest_path_with(&root(), "/workspacefoo/x"), None);
        assert_eq!(map_guest_path_with(&root(), "/workspace/../etc/passwd"), None);
        assert_eq!(map_guest_path_with(&root(), "notes.md"), None);
    }

    #[test]
    fn display_paths_round_trip() {
        assert_eq!(
            guest_display_path_with(&root(), &root()),
            Some("/workspace".to_string())
        );
        assert_eq!(
            guest_display_path_with(&root(), &root().join("out/deck.pptx")),
            Some("/workspace/out/deck.pptx".to_string())
        );
        assert_eq!(guest_display_path_with(&root(), Path::new("/etc/passwd")), None);
    }
}
