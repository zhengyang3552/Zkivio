#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::process::ExitCode;

fn main() -> ExitCode {
    let mut args = std::env::args_os();
    let _program = args.next();
    // RapidOCR 子进程入口只在桌面端存在（Android 关闭整个离线 OCR）。
    #[cfg(not(target_os = "android"))]
    if let Some(first) = args.next() {
        if first == kivio::rapidocr::RAPIDOCR_WORKER_ARG {
            return kivio::rapidocr::run_worker_entry(args);
        }
    }

    kivio::run();
    ExitCode::SUCCESS
}
