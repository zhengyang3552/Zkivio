//! Android 上的 `keyring` 替身。
//!
//! 桌面端 OAuth 凭证存在系统钥匙串（macOS Keychain / Windows Credential
//! Manager / Linux Secret Service）。Android 没有 `keyring` 支持的后端，
//! 而模块里所有 OAuth 读写都走 `keyring::Entry`，所以这里给一份同名、同签名
//! 的桩：**读=没有条目，写=凭证库不可用**。
//!
//! 有意让写入返回错误：这样「登录成功但 token 没存下来」不会发生，用户看到的是
//! provider_oauth 里已有的那句 "System credential store is unavailable"。
//! 真正的移动端实现（Android Keystore / EncryptedSharedPreferences）是独立任务。

/// 与 `keyring::Error` 对齐到调用点用到的两个分支。
#[derive(Debug)]
pub enum Error {
    /// 查无此项——与 keyring 语义一致，用于「第一次运行」的正常路径。
    NoEntry,
    /// 后端不存在（Android）。
    Platform { code: i32, message: String },
}

pub struct Entry {
    service: String,
    user: String,
}

impl Entry {
    pub fn new(service: &str, user: &str) -> Result<Self, Error> {
        Ok(Self {
            service: service.to_string(),
            user: user.to_string(),
        })
    }

    pub fn get_password(&self) -> Result<String, Error> {
        Err(Error::NoEntry)
    }

    pub fn set_password(&self, _password: &str) -> Result<(), Error> {
        Err(self.unavailable())
    }

    pub fn get_secret(&self) -> Result<Vec<u8>, Error> {
        Err(Error::NoEntry)
    }

    pub fn set_secret(&self, _secret: &[u8]) -> Result<(), Error> {
        Err(self.unavailable())
    }

    /// 删除在 Android 上视为成功：本来就没有可删的东西，删完仍是没有。
    pub fn delete_credential(&self) -> Result<(), Error> {
        Ok(())
    }

    fn unavailable(&self) -> Error {
        Error::Platform {
            code: 0,
            message: format!(
                "credential store is unavailable on Android ({} / {})",
                self.service, self.user
            ),
        }
    }
}
