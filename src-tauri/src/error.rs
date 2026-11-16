//! 统一错误类型：所有 Tauri Command 与内部服务的错误出口。
//!
//! 序列化为 `{ code: String, message: String }`，`code` 为蛇形变体名
//! （`"git"` / `"io"` / `"not_found"` / `"invalid_arg"` / `"too_large"` / `"cancelled"` / `"unexpected"`），
//! 前端据此区分错误类别并展示 `message`。

use serde::ser::{Serialize, SerializeStruct, Serializer};

/// 应用统一错误类型。
#[derive(Debug, thiserror::Error)]
pub enum AppError {
    /// git2 底层操作失败（网络/SSH 除外，本项目只做本地仓库操作）。
    #[error("git error: {0}")]
    Git(String),
    /// 文件系统 IO 错误。
    #[error("io error: {0}")]
    Io(String),
    /// 目标对象（commit / blob / 引用 / 路径等）不存在。
    #[error("not found: {0}")]
    NotFound(String),
    /// 调用参数非法（如 path 为空、commit id 格式错误）。
    #[error("invalid argument: {0}")]
    InvalidArg(String),
    /// 资源超过处理阈值（大文件保护，见 docs/05 §8）。
    #[error("resource too large")]
    TooLarge,
    /// 用户主动取消的异步操作。
    #[error("操作已取消")]
    Cancelled,
    /// 未归类的内部错误。
    #[error("unexpected error: {0}")]
    Unexpected(String),
}

impl AppError {
    /// 蛇形变体名，作为序列化后的机器可读错误码。
    fn code(&self) -> &'static str {
        match self {
            AppError::Git(_) => "git",
            AppError::Io(_) => "io",
            AppError::NotFound(_) => "not_found",
            AppError::InvalidArg(_) => "invalid_arg",
            AppError::TooLarge => "too_large",
            AppError::Cancelled => "cancelled",
            AppError::Unexpected(_) => "unexpected",
        }
    }
}

impl Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let mut state = serializer.serialize_struct("AppError", 2)?;
        state.serialize_field("code", &self.code())?;
        state.serialize_field("message", &self.to_string())?;
        state.end()
    }
}

impl From<git2::Error> for AppError {
    fn from(err: git2::Error) -> Self {
        match err.code() {
            // 对象/引用不存在 → NotFound，其余统一归入 Git。
            git2::ErrorCode::NotFound => AppError::NotFound(err.message().to_string()),
            _ => AppError::Git(err.message().to_string()),
        }
    }
}

impl From<std::io::Error> for AppError {
    fn from(err: std::io::Error) -> Self {
        AppError::Io(err.to_string())
    }
}

/// 全局 Result 别名。
pub type AppResult<T> = Result<T, AppError>;
