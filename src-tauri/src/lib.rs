//! Native side of DS1 Studio: folder configuration and file access for the webview.
//!
//! Reads are only allowed inside the configured folders (game, mods, WinDS1); writes only go to the save folder
//! (the first mod folder unless `saveDir` is set), only for the file kinds `writable` allows, keeping the original
//! as `<name>.bak`.

use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::{AppHandle, Manager, State};

#[derive(Default, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Config {
    game_dir: Option<String>,
    #[serde(default)]
    mod_dirs: Vec<String>,
    #[serde(default)]
    mod_mpqs: bool,
    winds1_dir: Option<String>,
    save_dir: Option<String>,
}

impl Config {
    fn read_roots(&self) -> Vec<PathBuf> {
        let mut roots: Vec<PathBuf> = self.mod_dirs.iter().map(PathBuf::from).collect();
        roots.extend(self.game_dir.iter().map(PathBuf::from));
        roots.extend(self.winds1_dir.iter().map(PathBuf::from));
        roots.extend(self.save_dir.iter().map(PathBuf::from));
        roots
    }

    fn save_root(&self) -> Option<PathBuf> {
        self.save_dir.clone().or_else(|| self.mod_dirs.first().cloned()).map(PathBuf::from)
    }
}

struct AppState {
    config: Mutex<Config>,
}

fn config_file(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    Ok(dir.join("ds1studio.json"))
}

/// Resolves `path` and checks it lies inside one of the configured folders.
fn allowed(state: &State<AppState>, path: &str) -> Result<PathBuf, String> {
    let canon = Path::new(path).canonicalize().map_err(|e| format!("{path}: {e}"))?;
    let roots = state.config.lock().unwrap().read_roots();
    if roots.iter().filter_map(|r| r.canonicalize().ok()).any(|r| canon.starts_with(r)) {
        Ok(canon)
    } else {
        Err(format!("{path} is outside the configured folders"))
    }
}

#[tauri::command]
fn get_config(state: State<AppState>) -> Config {
    state.config.lock().unwrap().clone()
}

#[tauri::command]
fn set_config(app: AppHandle, state: State<AppState>, config: Config) -> Result<(), String> {
    let file = config_file(&app)?;
    if let Some(dir) = file.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
    fs::write(&file, json).map_err(|e| e.to_string())?;
    *state.config.lock().unwrap() = config;
    Ok(())
}

fn is_relevant(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    [".ds1", ".dt1", ".dat", ".txt", ".json", ".bin"].iter().any(|ext| lower.ends_with(ext))
}

fn walk(dir: &Path, base: &Path, out: &mut Vec<String>) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            walk(&path, base, out);
        } else if is_relevant(&entry.file_name().to_string_lossy()) {
            if let Ok(rel) = path.strip_prefix(base) {
                out.push(rel.to_string_lossy().replace('\\', "/"));
            }
        }
    }
}

/// Relevant files of `<root>/data`, as paths relative to `root` ("data/global/...").
#[tauri::command]
fn list_data_files(state: State<AppState>, root: String) -> Result<Vec<String>, String> {
    let root = allowed(&state, &root)?;
    let mut out = Vec::new();
    let data = fs::read_dir(&root)
        .map_err(|e| e.to_string())?
        .flatten()
        .find(|e| e.path().is_dir() && e.file_name().to_string_lossy().eq_ignore_ascii_case("data"));
    if let Some(data) = data {
        walk(&data.path(), &root, &mut out);
    }
    Ok(out)
}

/// .mpq file names directly inside `dir`.
#[tauri::command]
fn list_mpqs(state: State<AppState>, dir: String) -> Result<Vec<String>, String> {
    let dir = allowed(&state, &dir)?;
    Ok(fs::read_dir(dir)
        .map_err(|e| e.to_string())?
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| n.to_ascii_lowercase().ends_with(".mpq"))
        .collect())
}

#[tauri::command]
fn file_size(state: State<AppState>, path: String) -> Result<u64, String> {
    let path = allowed(&state, &path)?;
    fs::metadata(path).map(|m| m.len()).map_err(|e| e.to_string())
}

/// Random-access read (MPQs are read piecemeal, never loaded whole).
#[tauri::command]
fn read_range(state: State<AppState>, path: String, offset: u64, length: u64) -> Result<Response, String> {
    let path = allowed(&state, &path)?;
    let mut f = fs::File::open(path).map_err(|e| e.to_string())?;
    f.seek(SeekFrom::Start(offset)).map_err(|e| e.to_string())?;
    let mut buf = Vec::with_capacity(length as usize);
    f.take(length).read_to_end(&mut buf).map_err(|e| e.to_string())?;
    Ok(Response::new(buf))
}

#[tauri::command]
fn read_file(state: State<AppState>, path: String) -> Result<Response, String> {
    let path = allowed(&state, &path)?;
    fs::read(path).map(Response::new).map_err(|e| e.to_string())
}

/// What the editor may write, and where: maps, tiles and sprites under data/global, tables under data/global/excel,
/// and the studio's own files (presets) under data/ds1studio.
fn writable(rel: &str) -> bool {
    let p = rel.replace('\\', "/").to_ascii_lowercase();
    let ext = |exts: &[&str]| exts.iter().any(|e| p.ends_with(e));
    (p.starts_with("data/global/") && ext(&[".ds1", ".dt1", ".cof", ".dcc", ".dc6"]))
        || (p.starts_with("data/global/excel/") && ext(&[".txt"]))
        || (p.starts_with("data/ds1studio/") && ext(&[".json"]))
}

#[derive(Serialize)]
struct SaveResult {
    written: String,
    backup: Option<String>,
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Writes a file (see `writable`) under the save folder. The body is the file; header `x-path` is the percent-encoded game path.
#[tauri::command]
fn save_file(state: State<AppState>, request: Request) -> Result<SaveResult, String> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("expected a binary body".into());
    };
    let rel = request
        .headers()
        .get("x-path")
        .and_then(|v| v.to_str().ok())
        .map(percent_decode)
        .ok_or("missing x-path header")?;
    let rel_path = Path::new(&rel);
    let safe = rel_path.components().all(|c| matches!(c, Component::Normal(_)));
    if !safe || !writable(&rel) {
        return Err(format!("refusing to write {rel}"));
    }
    let root = state
        .config
        .lock()
        .unwrap()
        .save_root()
        .ok_or("no mod folder configured to save into")?;
    let file = root.join(rel_path);
    if let Some(dir) = file.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let mut backup = None;
    let bak = PathBuf::from(format!("{}.bak", file.display()));
    if file.exists() && !bak.exists() {
        fs::copy(&file, &bak).map_err(|e| e.to_string())?;
        backup = Some(bak.display().to_string());
    }
    fs::write(&file, bytes).map_err(|e| e.to_string())?;
    Ok(SaveResult { written: file.display().to_string(), backup })
}

/// Saves bytes to a location the user picks in a native "Save as" dialog (exports: zips, .ds1 copies).
/// Header `x-name` suggests a file name. Returns the chosen path, or null if cancelled.
#[tauri::command]
async fn export_file(app: AppHandle, request: Request<'_>) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("expected a binary body".into());
    };
    let name = request.headers().get("x-name").and_then(|v| v.to_str().ok()).map(percent_decode).unwrap_or_else(|| "export.bin".into());
    let Some(path) = app.dialog().file().set_file_name(&name).blocking_save_file() else {
        return Ok(None);
    };
    let path = path.into_path().map_err(|e| e.to_string())?;
    fs::write(&path, bytes).map_err(|e| e.to_string())?;
    Ok(Some(path.display().to_string()))
}

/// Reads a file the user picks in a native "Open" dialog (imports). An empty response means cancelled.
#[tauri::command]
async fn import_file(app: AppHandle, extension: String) -> Result<Response, String> {
    use tauri_plugin_dialog::DialogExt;
    let Some(path) = app.dialog().file().add_filter(&extension, &[extension.as_str()]).blocking_pick_file() else {
        return Ok(Response::new(Vec::new()));
    };
    let path = path.into_path().map_err(|e| e.to_string())?;
    fs::read(path).map(Response::new).map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let config = config_file(app.handle())
                .ok()
                .and_then(|f| fs::read_to_string(f).ok())
                .and_then(|s| serde_json::from_str(&s).ok())
                .unwrap_or_default();
            app.manage(AppState { config: Mutex::new(config) });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_config,
            set_config,
            list_data_files,
            list_mpqs,
            file_size,
            read_range,
            read_file,
            save_file,
            export_file,
            import_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running DS1 Studio");
}
