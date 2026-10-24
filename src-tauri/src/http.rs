//! 出站 HTTP 客户端的唯一构造入口。
//!
//! 为什么需要它：reqwest 0.13 的 `rustls` feature 把证书校验交给
//! `rustls-platform-verifier`，而这个 crate 在 Android 上要求应用自带一个 Kotlin
//! 组件并在 JNI 层显式初始化（见其文档的 Android 一节）。本仓库的 Android 工程由
//! CI 用 `tauri android init` 现生成，挂不上那个 AAR，于是任何
//! `reqwest::Client::builder().build()` 都会在
//! `Expect rustls-platform-verifier to be initialized` 处 panic —— 表现为所有联网
//! 功能（对话、市场、更新检查、工作区下载）全部失败。
//!
//! 移动端因此改用内置的 Mozilla 根证书（webpki-roots）：这些是公开站点证书链的
//! 根，足够覆盖供应商 API；代价是不再信任用户自行安装的企业根证书。桌面端保持
//! reqwest 默认行为（系统证书库），这样企业内网的中间人代理仍可用。
//!
//! 新增 HTTP 调用点时统一从这里拿 builder，不要直接写 `reqwest::Client::builder()`。

/// 与 `reqwest::Client::builder()` 等价，但按平台选好 TLS 根证书来源。
pub fn client_builder() -> reqwest::ClientBuilder {
    #[cfg(target_os = "android")]
    {
        reqwest::Client::builder().tls_backend_preconfigured(android_rustls_config())
    }
    #[cfg(not(target_os = "android"))]
    {
        reqwest::Client::builder()
    }
}

/// Android 专用的 rustls 配置：内置根证书 + HTTP/1.1 与 HTTP/2 的 ALPN 声明。
#[cfg(target_os = "android")]
fn android_rustls_config() -> rustls::ClientConfig {
    let mut roots = rustls::RootCertStore::empty();
    roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    let mut config = rustls::ClientConfig::builder()
        .with_root_certificates(roots)
        .with_no_client_auth();
    // 预置 TLS 后端时 ALPN 由我们自己负责；漏了它就只能退回 HTTP/1.1。
    config.alpn_protocols = vec![b"h2".to_vec(), b"http/1.1".to_vec()];
    config
}
