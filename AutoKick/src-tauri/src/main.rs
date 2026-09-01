#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::Deserialize;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use tauri::{Emitter, Manager, State};

struct SessionProcess(Mutex<Option<Child>>);
struct BackendProcess(Mutex<Option<Child>>);

fn terminate_child(mut child: Child) -> Result<(), String> {
    let pid = child.id().to_string();

    // Node.jsはワーカーやBedrock接続用の子プロセスを持つ場合があるため、
    // Windowsではプロセスツリー全体を終了させる。
    #[cfg(windows)]
    {
        let status = Command::new("taskkill")
            .args(["/PID", &pid, "/T", "/F"])
            .status()
            .map_err(|e| format!("Node.jsのプロセスツリーを停止できません: {e}"))?;
        if !status.success() && child.try_wait().map_err(|e| e.to_string())?.is_none() {
            child.kill().map_err(|e| format!("Node.jsを停止できません: {e}"))?;
        }
    }

    #[cfg(not(windows))]
    child.kill().map_err(|e| format!("Node.jsを停止できません: {e}"))?;

    child.wait().map_err(|e| format!("Node.jsの終了を待機できません: {e}"))?;
    Ok(())
}

impl Drop for SessionProcess {
    fn drop(&mut self) {
        if let Ok(mut current) = self.0.lock() {
            if let Some(child) = current.take() {
                let _ = terminate_child(child);
            }
        }
    }
}

impl Drop for BackendProcess {
    fn drop(&mut self) {
        if let Ok(mut current) = self.0.lock() {
            if let Some(child) = current.take() {
                let _ = terminate_child(child);
            }
        }
    }
}

fn bundled_backend_paths(app: &tauri::AppHandle) -> Result<(PathBuf, PathBuf), String> {
    if cfg!(debug_assertions) {
        let root = std::env::current_dir().map_err(|e| e.to_string())?;
        return Ok((PathBuf::from("node"), root));
    }
    let resources = app
        .path()
        .resource_dir()
        .map_err(|e| format!("リソースフォルダを取得できません: {e}"))?;
    let node = resources.join("node-runtime").join("node.exe");
    let backend = resources.join("backend");
    if !node.is_file() || !backend.join("src").join("backend").join("server.ts").is_file() {
        return Err("同梱された Node.js バックエンドが見つかりません。ビルドスクリプトを実行してください。".into());
    }
    Ok((node, backend))
}

#[derive(Debug, Deserialize)]
struct BackendRequest {
    port: u16,
}

#[tauri::command]
fn start_backend(
    app: tauri::AppHandle,
    state: State<'_, BackendProcess>,
    request: BackendRequest,
) -> Result<(), String> {
    let mut current = state.0.lock().map_err(|_| "バックエンド状態を取得できません")?;
    if current.is_some() { return Ok(()); }
    let data_dir = dirs::document_dir().ok_or("Documentsフォルダを取得できません")?.join("PEXData").join("AutoKick");
    std::fs::create_dir_all(data_dir.join("plugins")).map_err(|e| format!("設定フォルダを作成できません: {e}"))?;
    let (node, backend) = bundled_backend_paths(&app)?;
    let mut child = Command::new(node)
        .args(["--experimental-strip-types", "src/backend/server.ts", &request.port.to_string()])
        .current_dir(&backend)
        .env("AUTOKICK_DATA_DIR", data_dir.to_string_lossy().to_string())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Node.jsを起動できません。Node.js 20以降をインストールしてください: {e}"))?;
    if let Some(stdout) = child.stdout.take() {
        let app_handle = app.clone();
        std::thread::spawn(move || { for line in BufReader::new(stdout).lines().flatten() { let _ = app_handle.emit("backend-log", line); } });
    }
    if let Some(stderr) = child.stderr.take() {
        let app_handle = app.clone();
        std::thread::spawn(move || { for line in BufReader::new(stderr).lines().flatten() { let _ = app_handle.emit("backend-error", line); } });
    }
    *current = Some(child);
    let _ = app.emit("backend-state", "starting");
    Ok(())
}

#[tauri::command]
fn stop_backend(state: State<'_, BackendProcess>) -> Result<(), String> {
    let mut current = state.0.lock().map_err(|_| "バックエンド状態を取得できません")?;
    current.take().map(terminate_child).unwrap_or(Ok(()))
}

#[derive(Debug, Deserialize)]
struct SessionRequest {
    world_index: usize,
    count: u32,
    message: String,
    action_type: String,
}

#[tauri::command]
fn start_session(
    app: tauri::AppHandle,
    state: State<'_, SessionProcess>,
    request: SessionRequest,
) -> Result<(), String> {
    let mut current = state.0.lock().map_err(|_| "セッション状態を取得できません")?;
    if current.is_some() {
        return Err("すでにセッションが実行中です".into());
    }

    let (node, backend) = bundled_backend_paths(&app)?;
    let mut child = Command::new(node)
        .args(["--experimental-strip-types", "src/backend/server.ts"])
        .current_dir(backend)
        .env("AUTOKICK_ACTION", "join")
        .env("AUTOKICK_SESSION_INDEX", request.world_index.to_string())
        .env("AUTOKICK_ACTION_TYPE", request.action_type)
        .env("AUTOKICK_ACTION_MESSAGE", request.message)
        .env("AUTOKICK_ACTION_COUNT", request.count.to_string())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("バックエンドを起動できません: {e}"))?;

    if let Some(stdout) = child.stdout.take() {
        let app_handle = app.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines().flatten() {
                let _ = app_handle.emit("session-log", line);
            }
        });
    }
    let _ = app.emit("session-log", "バックエンド接続を開始しました。");
    *current = Some(child);
    Ok(())
}

#[tauri::command]
fn stop_session(state: State<'_, SessionProcess>) -> Result<(), String> {
    let mut current = state.0.lock().map_err(|_| "セッション状態を取得できません")?;
    current.take().map(terminate_child).unwrap_or(Ok(()))
}

fn main() {
    tauri::Builder::default()
        .manage(SessionProcess(Mutex::new(None)))
        .manage(BackendProcess(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![start_backend, stop_backend, start_session, stop_session])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
