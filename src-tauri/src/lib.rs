//! Native side of DS1 Studio: folder configuration and file access for the webview.
//!
//! Reads are only allowed inside the configured folders (game, mods); writes only go to the save folder
//! (the first mod folder unless `saveDir` is set), only for the file kinds `writable` allows, keeping the original
//! as `<name>.bak`.

mod asset_files;
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
    save_dir: Option<String>,
}

impl Config {
    fn read_roots(&self) -> Vec<PathBuf> {
        let mut roots: Vec<PathBuf> = self.mod_dirs.iter().map(PathBuf::from).collect();
        roots.extend(self.game_dir.iter().map(PathBuf::from));
        roots.extend(self.save_dir.iter().map(PathBuf::from));
        roots
    }

    /// The folders DS1 Studio may change files in: the mod folders and the save folder, never the game install.
    fn write_roots(&self) -> Vec<PathBuf> {
        let mut roots: Vec<PathBuf> = self.mod_dirs.iter().map(PathBuf::from).collect();
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
    // Test hook: a separate settings file, so test runs never touch the user's own.
    if let Ok(p) = std::env::var("DS1STUDIO_CONFIG") {
        return Ok(PathBuf::from(p));
    }
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
    [".ds1", ".dt1", ".dat", ".txt", ".json", ".bin", ".cof", ".dcc", ".dc6", ".tbl"].iter().any(|ext| lower.ends_with(ext))
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

#[derive(Serialize)]
struct CrashLogFile {
    path: String,
    /// Milliseconds since 1970.
    modified: f64,
}

/// The game's daily logs (D2YYMMDD.txt, which get its crash reports) in the mod and game folders, newest first.
#[tauri::command]
fn list_crash_logs(state: State<AppState>) -> Vec<CrashLogFile> {
    let config = state.config.lock().unwrap().clone();
    let mut out = Vec::new();
    for dir in config.mod_dirs.iter().chain(config.game_dir.iter()) {
        let Ok(entries) = fs::read_dir(dir) else { continue };
        for e in entries.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            let is_log = name.len() == 12
                && name[..2].eq_ignore_ascii_case("d2")
                && name[2..8].bytes().all(|b| b.is_ascii_digit())
                && name[8..].eq_ignore_ascii_case(".txt");
            if !is_log {
                continue;
            }
            let modified = e
                .metadata()
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map_or(0.0, |d| d.as_millis() as f64);
            out.push(CrashLogFile { path: e.path().to_string_lossy().into_owned(), modified });
        }
    }
    out.sort_by(|a, b| b.modified.total_cmp(&a.modified));
    out
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

/// Joins `rel` onto `root`, reusing the real name of every folder/file that already exists with different letter case
/// (the editor works with lower-cased game paths; Linux file systems are case-sensitive, so without this a save
/// would create `lvlprest.txt` next to `LvlPrest.txt` instead of replacing it). A no-op on Windows.
fn resolve_case_insensitive(root: &Path, rel: &Path) -> PathBuf {
    let mut out = root.to_path_buf();
    for comp in rel.components() {
        let Component::Normal(name) = comp else { continue };
        let exact = out.join(name);
        if exact.exists() {
            out = exact;
            continue;
        }
        let want = name.to_string_lossy().to_lowercase();
        let found = fs::read_dir(&out).ok().and_then(|entries| {
            entries.flatten().map(|e| e.file_name()).find(|n| n.to_string_lossy().to_lowercase() == want)
        });
        out = out.join(found.unwrap_or_else(|| name.to_os_string()));
    }
    out
}

/// What the editor may write, and where: maps, tiles and sprites under data/global, tables under data/global/excel,
/// string tables under data/local/lng, and the studio's own files (presets) under data/ds1studio.
fn writable(rel: &str) -> bool {
    let p = rel.replace('\\', "/").to_ascii_lowercase();
    let ext = |exts: &[&str]| exts.iter().any(|e| p.ends_with(e));
    (p.starts_with("data/global/") && ext(&[".ds1", ".dt1", ".cof", ".dcc", ".dc6"]))
        || (p.starts_with("data/global/excel/") && ext(&[".txt"]))
        || (p.starts_with("data/local/lng/") && ext(&[".tbl"]))
        || (p.starts_with("data/local/ui/") && ext(&[".dc6"]))
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
    let file = resolve_case_insensitive(&root, rel_path);
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

/// Moves a file of the save folder aside to `<name>.bak` (`.bak2`, `.bak3`… when taken), so nothing is ever lost: what a
/// rename leaves behind. Only files `writable` allows. Returns where it went.
#[tauri::command]
fn retire_file(state: State<AppState>, path: String) -> Result<String, String> {
    let rel_path = Path::new(&path);
    let safe = rel_path.components().all(|c| matches!(c, Component::Normal(_)));
    if !safe || !writable(&path) {
        return Err(format!("refusing to move {path}"));
    }
    let root = state
        .config
        .lock()
        .unwrap()
        .save_root()
        .ok_or("no mod folder configured")?;
    let file = resolve_case_insensitive(&root, rel_path);
    if !file.is_file() {
        return Err(format!("{} is not in the mod folder", file.display()));
    }
    let mut n = 1;
    let target = loop {
        let t = PathBuf::from(format!("{}.bak{}", file.display(), if n == 1 { String::new() } else { n.to_string() }));
        if !t.exists() {
            break t;
        }
        n += 1;
    };
    fs::rename(&file, &target).map_err(|e| e.to_string())?;
    Ok(target.display().to_string())
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

// ---------------------------------------------------------------------------------------------------------------
// `ds1-studio --mcp`: a Model Context Protocol server on stdin/stdout for AI assistants (a hidden feature). The app
// starts with a hidden window that runs the same editing code as the editor (src/mcp); this side only relays the
// newline-delimited JSON-RPC messages between the standard streams and that window.

/// Lines read from stdin before the window was listening, and whether it is.
#[derive(Default)]
struct McpState {
    ready: bool,
    pending: Vec<String>,
}

fn mcp_mode() -> bool {
    std::env::args().any(|a| a == "--mcp")
}

/// This program's own path (for the MCP setup commands shown in About).
#[tauri::command]
fn app_exe() -> Result<String, String> {
    std::env::current_exe().map(|p| p.display().to_string()).map_err(|e| e.to_string())
}

#[tauri::command]
fn mcp_ready(app: AppHandle, state: State<Mutex<McpState>>) {
    use tauri::Emitter;
    let mut s = state.lock().unwrap();
    s.ready = true;
    for line in s.pending.drain(..) {
        let _ = app.emit_to("main", "mcp-in", line);
    }
}

#[tauri::command]
fn mcp_out(line: String) -> Result<(), String> {
    use std::io::Write;
    let mut out = std::io::stdout().lock();
    writeln!(out, "{}", line).and_then(|_| out.flush()).map_err(|e| e.to_string())
}

/// Reads MCP messages from stdin and hands them to the window; stdin closing (the client quit) ends the app.
fn mcp_stdin(app: AppHandle) {
    use std::io::BufRead;
    use tauri::Emitter;
    std::thread::spawn(move || {
        for line in std::io::stdin().lock().lines() {
            let Ok(line) = line else { break };
            if line.trim().is_empty() {
                continue;
            }
            let state = app.state::<Mutex<McpState>>();
            let mut s = state.lock().unwrap();
            if s.ready {
                let _ = app.emit_to("main", "mcp-in", line);
            } else {
                s.pending.push(line);
            }
        }
        app.exit(0);
    });
}

/// Files picked for importing, read one by one with `read_picked`.
#[derive(Default)]
struct PickedFile(Mutex<Vec<PathBuf>>);

/// Test hook: `DS1STUDIO_TEST_PICK_<EXT>` (e.g. `_DS1`, `_DT1`; paths separated by `;`) answers picks for that file
/// type without showing a dialog, so the import flows can be driven end to end in tests. Unset in normal use.
fn test_pick(extension: &str) -> Option<Vec<PathBuf>> {
    // "ds1,zip" (several extensions) answers with the first one's variable.
    let first = extension.split(',').next().unwrap_or(extension);
    std::env::var(format!("DS1STUDIO_TEST_PICK_{}", first.to_ascii_uppercase()))
        .ok()
        .map(|v| v.split(';').filter(|s| !s.is_empty()).map(PathBuf::from).collect())
}

/// Every file with `extension` under `dir` (subfolders included), sorted.
fn walk_files(dir: &Path, extension: &str, out: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    let mut entries: Vec<_> = entries.flatten().map(|e| e.path()).collect();
    entries.sort();
    for p in entries {
        if p.is_dir() {
            walk_files(&p, extension, out);
        } else if p.extension().is_some_and(|e| extension.split(',').any(|x| e.eq_ignore_ascii_case(x))) {
            out.push(p);
        }
    }
}

/// One picked file: its name, and its folder path relative to (and including) the picked folder it was found in.
#[derive(Serialize)]
struct PickedEntry {
    name: String,
    folder: String,
}

/// Native "Open" dialog for imports: one file, several files, or folders (every `extension` file inside them,
/// subfolders included). Returns what was found (empty = cancelled); the bytes follow with `read_picked`, raw.
#[tauri::command]
async fn pick_import(app: AppHandle, picked: State<'_, PickedFile>, extension: String, mode: Option<String>) -> Result<Vec<PickedEntry>, String> {
    use tauri_plugin_dialog::DialogExt;
    let mode = mode.unwrap_or_else(|| "file".into());
    // "ds1,zip": one filter offering every listed extension.
    let exts: Vec<&str> = extension.split(',').collect();
    let to_paths = |v: Vec<tauri_plugin_dialog::FilePath>| v.into_iter().filter_map(|p| p.into_path().ok()).collect::<Vec<_>>();
    let chosen: Vec<PathBuf> = match test_pick(&extension) {
        Some(p) => p,
        None => match mode.as_str() {
            "folders" => app.dialog().file().blocking_pick_folders().map(to_paths).unwrap_or_default(),
            "files" => app.dialog().file().add_filter(&extension, &exts).blocking_pick_files().map(to_paths).unwrap_or_default(),
            _ => app.dialog().file().add_filter(&extension, &exts).blocking_pick_file().and_then(|p| p.into_path().ok()).into_iter().collect(),
        },
    };
    let mut files: Vec<(PathBuf, String)> = Vec::new();
    for c in chosen {
        if c.is_dir() {
            let root_name = c.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
            let mut found = Vec::new();
            walk_files(&c, &extension, &mut found);
            for f in found {
                let rel_dir = f.parent().and_then(|d| d.strip_prefix(&c).ok()).map(|r| r.to_string_lossy().replace('\\', "/")).unwrap_or_default();
                let folder = if rel_dir.is_empty() { root_name.clone() } else { format!("{root_name}/{rel_dir}") };
                files.push((f, folder));
            }
        } else {
            files.push((c, String::new()));
        }
    }
    let entries = files
        .iter()
        .map(|(p, folder)| PickedEntry { name: p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default(), folder: folder.clone() })
        .collect();
    *picked.0.lock().unwrap() = files.into_iter().map(|(p, _)| p).collect();
    Ok(entries)
}

/// The bytes of picked file `index` (from the last pick_import), sent raw.
#[tauri::command]
fn read_picked(picked: State<'_, PickedFile>, index: Option<usize>) -> Result<Response, String> {
    let path = picked.0.lock().unwrap().get(index.unwrap_or(0)).cloned().ok_or("no file picked")?;
    fs::read(path).map(Response::new).map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mcp = mcp_mode();
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_opener::init())
        .setup(move |app| {
            let config = config_file(app.handle())
                .ok()
                .and_then(|f| fs::read_to_string(f).ok())
                .and_then(|s| serde_json::from_str(&s).ok())
                .unwrap_or_default();
            app.manage(AppState { config: Mutex::new(config) });
            app.manage(Mutex::new(McpState::default()));
            app.manage(PickedFile::default());
            // The window is created here (not from the config) so MCP mode can start it hidden, as the MCP server.
            let conf = app.config().app.windows.first().cloned().ok_or("no window configured")?;
            let mut window = tauri::WebviewWindowBuilder::from_config(app.handle(), &conf)?;
            if mcp {
                window = window.visible(false).initialization_script("window.__DS1_MCP__ = true;");
                mcp_stdin(app.handle().clone());
            }
            window.build()?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_config,
            set_config,
            list_data_files,
            list_mpqs,
            list_crash_logs,
            file_size,
            read_range,
            read_file,
            save_file,
            retire_file,
            export_file,
            import_file,
            mcp_ready,
            mcp_out,
            app_exe,
            pick_import,
            asset_files::list_managed_assets,
            asset_files::archive_asset,
            asset_files::list_recycled_assets,
            asset_files::restore_asset,
            read_picked
        ])
        .run(tauri::generate_context!())
        .expect("error while running DS1 Studio");
}
