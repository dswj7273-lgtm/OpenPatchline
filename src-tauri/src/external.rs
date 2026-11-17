//! 外部编辑器 / Finder 打开（v0.6 / 6.7）。
//!
//! 编辑器命令模板来自应用设置（`{path}` / `{line}` 占位符），
//! 例如 `code --goto {path}:{line}`。解析支持双引号包裹的参数；
//! 未提供 `{path}` 时把文件绝对路径追加为最后一个参数。

use std::path::Path;
use std::process::{Command, Stdio};

use crate::error::{AppError, AppResult};

/// 把命令模板按空白拆分为参数（支持双引号包裹含空格的路径）。
fn split_command(template: &str) -> Vec<String> {
    let mut parts: Vec<String> = Vec::new();
    let mut cur = String::new();
    let mut in_quote = false;
    for ch in template.chars() {
        match ch {
            '"' => in_quote = !in_quote,
            c if c.is_whitespace() && !in_quote => {
                if !cur.is_empty() {
                    parts.push(std::mem::take(&mut cur));
                }
            }
            c => cur.push(c),
        }
    }
    if !cur.is_empty() {
        parts.push(cur);
    }
    parts
}

/// 由模板构建外部编辑器参数列表；`line` 仅为存在 `{line}` 占位符时代入。
pub fn build_editor_args(
    template: &str,
    abs_path: &str,
    line: Option<u32>,
) -> AppResult<Vec<String>> {
    let parts = split_command(template);
    if parts.is_empty() {
        return Err(AppError::InvalidArg(
            "外部编辑器命令为空，请在设置中配置".to_string(),
        ));
    }
    let mut out: Vec<String> = Vec::with_capacity(parts.len() + 1);
    let mut has_path = false;
    for part in parts {
        if part.contains("{path}") {
            has_path = true;
        }
        // 同一参数可同时包含 {path} 与 {line}（如 `--goto {path}:{line}`）。
        let mut arg = part.replace("{path}", abs_path);
        if arg.contains("{line}") {
            let n = line.unwrap_or(1);
            arg = arg.replace("{line}", &n.to_string());
        }
        out.push(arg);
    }
    if !has_path {
        out.push(abs_path.to_string());
    }
    Ok(out)
}

/// 以独立进程组启动外部编辑器（不等待、不阻塞 UI；失败如实上报）。
pub fn spawn_detached(args: &[String], workdir: &Path) -> AppResult<()> {
    let Some((program, rest)) = args.split_first() else {
        return Err(AppError::InvalidArg("外部编辑器命令为空".to_string()));
    };
    let mut cmd = Command::new(program);
    cmd.args(rest)
        .current_dir(workdir)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    cmd.spawn().map_err(|e| {
        AppError::Io(format!(
            "启动外部编辑器 {program} 失败: {e}；请检查设置中的编辑器命令"
        ))
    })?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_and_substitutes() {
        let args = build_editor_args("code --goto {path}:{line}", "/tmp/a b.ts", Some(42)).unwrap();
        assert_eq!(args, vec!["code", "--goto", "/tmp/a b.ts:42"]);

        let plain = build_editor_args("idea", "/tmp/x.rs", None).unwrap();
        assert_eq!(plain, vec!["idea", "/tmp/x.rs"]);

        let quoted = build_editor_args(
            "\"/Apps/My Editor.app/Contents/MacOS/app\" {path}",
            "/f.ts",
            None,
        )
        .unwrap();
        assert_eq!(
            quoted,
            vec![
                "/Apps/My Editor.app/Contents/MacOS/app".to_string(),
                "/f.ts".to_string()
            ]
        );

        // 无 {line} 占位符时行号被忽略
        let noline = build_editor_args("vim {path}", "/a.txt", Some(9)).unwrap();
        assert_eq!(noline, vec!["vim", "/a.txt"]);
    }

    #[test]
    fn rejects_empty_template() {
        assert!(build_editor_args("   ", "/a", None).is_err());
        assert!(split_command("  \"\"  ").is_empty());
    }
}
