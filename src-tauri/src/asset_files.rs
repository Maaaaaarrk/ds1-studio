//! Recoverable asset cleanup. Every operation stores the original before changing a source file.
use super::{resolve_case_insensitive, AppState};
use serde::{Deserialize, Serialize};
use std::{collections::HashSet, fs, io::Write, path::{Component, Path, PathBuf}, time::{SystemTime, UNIX_EPOCH}};
use tauri::{AppHandle, Manager, State};

#[derive(Clone, Serialize, Deserialize)]
pub struct ManagedAsset { root: String, path: String }
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecycledAsset {
    id: String, root: String, path: String, created: u64, partial: bool,
    action: String, unused_path: Option<String>, restored: bool,
}

fn safe_relative(path: &str) -> Result<PathBuf, String> {
    let p = PathBuf::from(path.replace('\\', "/"));
    if path.contains(':') || p.as_os_str().is_empty() || !p.components().all(|c| matches!(c, Component::Normal(_))) {
        return Err("The asset path must stay inside its source folder.".into());
    }
    let lower = path.to_ascii_lowercase();
    if !lower.ends_with(".dt1") && !lower.ends_with(".ds1") { return Err("Only DS1 and DT1 assets can be recycled.".into()); }
    Ok(p)
}

/// Also checks existing parents, so a junction cannot redirect a write outside the root.
fn contained(root: &Path, rel: &Path) -> Result<PathBuf, String> {
    let root = root.canonicalize().map_err(|e| e.to_string())?;
    let file = resolve_case_insensitive(&root, rel);
    let mut ancestor = file.as_path();
    while !ancestor.exists() { ancestor = ancestor.parent().ok_or("Invalid destination")?; }
    if !ancestor.canonicalize().map_err(|e| e.to_string())?.starts_with(&root) {
        return Err("A directory link takes this asset outside its source folder.".into());
    }
    Ok(file)
}

fn configured_root(state: &State<AppState>, root: &str) -> Result<PathBuf, String> {
    let root = Path::new(root).canonicalize().map_err(|e| e.to_string())?;
    // Only the mod and save folders: the game install is never changed.
    if !state.config.lock().unwrap().write_roots().iter().filter_map(|r| r.canonicalize().ok()).any(|r| r == root) {
        return Err("The asset's source folder is not one of your mod folders (the game install is never changed).".into());
    }
    Ok(root)
}

fn inventory(dir: &Path, root: &Path, out: &mut Vec<ManagedAsset>, seen: &mut HashSet<PathBuf>) {
    let Ok(canon) = dir.canonicalize() else { return };
    if !canon.starts_with(root) || !seen.insert(canon) { return; }
    let Ok(entries) = fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let p = entry.path();
        if p.is_dir() { inventory(&p, root, out, seen); }
        else if p.extension().is_some_and(|e| e.eq_ignore_ascii_case("dt1") || e.eq_ignore_ascii_case("ds1")) {
            if let Ok(rel) = p.strip_prefix(root) {
                if contained(root, rel).is_ok() {
                    out.push(ManagedAsset { root: root.to_string_lossy().into_owned(), path: rel.to_string_lossy().replace('\\', "/") });
                }
            }
        }
    }
}

#[tauri::command]
pub fn list_managed_assets(state: State<AppState>) -> Vec<ManagedAsset> {
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    for root in state.config.lock().unwrap().write_roots() {
        if let Ok(root) = root.canonicalize() {
            let data = resolve_case_insensitive(&root, Path::new("data"));
            inventory(&data, &root, &mut out, &mut seen);
        }
    }
    out
}

fn executable_dir() -> Result<PathBuf, String> {
    std::env::current_exe().map_err(|e| e.to_string())?.parent().map(Path::to_path_buf).ok_or("Cannot find the app folder.".into())
}
/// Where new backups go: the app's data folder (writable even when DS1 Studio is installed under Program Files).
fn backup_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_data_dir().map_err(|e| e.to_string())?.join("Asset backups"))
}
/// Every place backups may be: the data folder, then beside the app (where earlier versions kept them).
fn backup_dirs(app: &AppHandle) -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = backup_dir(app).into_iter().collect();
    if let Ok(exe) = executable_dir() { if !dirs.contains(&exe) { dirs.push(exe); } }
    dirs
}
fn bucket(exe: &Path, path: &str) -> PathBuf {
    exe.join(if path.to_ascii_lowercase().ends_with(".dt1") { "Deleted DT1s" } else { "Deleted DS1s" })
}
fn write_new(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let mut f = fs::OpenOptions::new().write(true).create_new(true).open(path).map_err(|e| e.to_string())?;
    f.write_all(bytes).and_then(|_| f.sync_all()).map_err(|e| e.to_string())
}
fn replace(path: &Path, bytes: &[u8], id: &str) -> Result<(), String> {
    let tmp = path.with_extension(format!("studio-{}.tmp", id));
    write_new(&tmp, bytes)?;
    if let Err(e) = fs::rename(&tmp, path) { let _ = fs::remove_file(&tmp); return Err(e.to_string()); }
    Ok(())
}
fn write_record(dir: &Path, entry: &RecycledAsset) -> Result<(), String> {
    replace(&dir.join("record.json"), &serde_json::to_vec_pretty(entry).map_err(|e| e.to_string())?, "record")
}

fn archive_at(exe: &Path, root: &Path, path: &str, expected: &[u8], action: &str, remaining: Option<&[u8]>, removed: &[u8]) -> Result<RecycledAsset, String> {
    if action != "delete" && action != "unused" { return Err("Unknown cleanup action.".into()); }
    if remaining.is_some() && !path.to_ascii_lowercase().ends_with(".dt1") { return Err("Only DT1s can be split.".into()); }
    let rel = safe_relative(path)?;
    let file = contained(root, &rel)?;
    let original = fs::read(&file).map_err(|e| e.to_string())?;
    if original != expected { return Err("This file changed after the scan. Scan again before removing it.".into()); }
    let now = SystemTime::now().duration_since(UNIX_EPOCH).map_err(|e| e.to_string())?;
    let id = format!("{}-{}", now.as_nanos(), std::process::id());
    let store = bucket(exe, path);
    fs::create_dir_all(&store).map_err(|e| format!("Cannot create the backup folder {}: {e}. The source has not been changed.", store.display()))?;
    let dir = store.join(&id);
    fs::create_dir(&dir).map_err(|e| e.to_string())?;
    fs::create_dir(dir.join("original")).map_err(|e| e.to_string())?;
    write_new(&dir.join("original").join(rel.file_name().ok_or("Missing file name")?), &original)?;
    write_new(&dir.join("removed.dt1"), removed)?;
    if let Some(bytes) = remaining { write_new(&dir.join("remaining.dt1"), bytes)?; }
    let unused = if action == "unused" {
        let name = root.file_name().unwrap_or_default().to_string_lossy().replace(' ', "").to_ascii_lowercase();
        let sub = if name == "pd2assets" { PathBuf::from("unused") } else { PathBuf::from("data/global/tiles/PD2assets/unused") };
        let target = contained(root, &sub.join(&id).join(rel.file_name().ok_or("Missing file name")?))?;
        fs::create_dir_all(target.parent().ok_or("Missing folder")?).map_err(|e| e.to_string())?;
        write_new(&target, removed)?;
        Some(target.to_string_lossy().into_owned())
    } else { None };
    let entry = RecycledAsset {
        id, root: root.to_string_lossy().into_owned(), path: path.into(), created: now.as_millis() as u64,
        partial: remaining.is_some(), action: action.into(), unused_path: unused, restored: false,
    };
    // A prepared record can recover the original even if the process stops during the final operation.
    write_record(&dir, &entry)?;
    if let Some(bytes) = remaining { replace(&file, bytes, &entry.id)?; }
    else { fs::remove_file(&file).map_err(|e| e.to_string())?; }
    Ok(entry)
}

#[tauri::command]
pub fn archive_asset(app: AppHandle, state: State<AppState>, root: String, path: String, expected: Vec<u8>, action: String, remaining: Option<Vec<u8>>, removed: Vec<u8>) -> Result<RecycledAsset, String> {
    let root = configured_root(&state, &root)?;
    archive_at(&backup_dir(&app)?, &root, &path, &expected, &action, remaining.as_deref(), &removed)
}

fn records(exe: &Path) -> Vec<RecycledAsset> {
    let mut out = Vec::new();
    for name in ["Deleted DT1s", "Deleted DS1s"] {
        let store = exe.join(name);
        let Ok(entries) = fs::read_dir(&store) else { continue };
        for e in entries.flatten() {
            let dir = e.path();
            if !dir.canonicalize().is_ok_and(|p| store.canonicalize().is_ok_and(|s| p.starts_with(s))) { continue; }
            if let Ok(bytes) = fs::read(dir.join("record.json")) {
                if let Ok(entry) = serde_json::from_slice::<RecycledAsset>(&bytes) {
                    if !entry.restored && e.file_name().to_string_lossy() == entry.id { out.push(entry); }
                }
            }
        }
    }
    out.sort_by(|a, b| b.created.cmp(&a.created));
    out
}
#[tauri::command]
pub fn list_recycled_assets(app: AppHandle) -> Result<Vec<RecycledAsset>, String> {
    let mut out: Vec<RecycledAsset> = backup_dirs(&app).iter().flat_map(|d| records(d)).collect();
    out.sort_by(|a, b| b.created.cmp(&a.created));
    Ok(out)
}

fn restore_at(exe: &Path, root: &Path, entry: &mut RecycledAsset) -> Result<String, String> {
    let file = contained(root, &safe_relative(&entry.path)?)?;
    let store = bucket(exe, &entry.path);
    let dir = contained(&store, Path::new(&entry.id))?;
    let original = fs::read(dir.join("original").join(safe_relative(&entry.path)?.file_name().ok_or("Missing file name")?)).map_err(|e| e.to_string())?;
    if file.exists() {
        let current = fs::read(&file).map_err(|e| e.to_string())?;
        let remaining = fs::read(dir.join("remaining.dt1")).ok();
        if current != original && (!entry.partial || remaining.as_ref() != Some(&current)) {
            return Err("The original location contains a different/newer file. Move it aside before restoring; nothing was overwritten.".into());
        }
    }
    fs::create_dir_all(file.parent().ok_or("Invalid source folder")?).map_err(|e| e.to_string())?;
    replace(&file, &original, &entry.id)?;
    if let Some(unused) = &entry.unused_path {
        let p = Path::new(unused);
        // Do not delete a moved copy that the user has edited or moved outside the configured root.
        if p.canonicalize().is_ok_and(|p| root.canonicalize().is_ok_and(|r| p.starts_with(r))) {
            if let (Ok(a), Ok(b)) = (fs::read(p), fs::read(dir.join("removed.dt1"))) {
                if a == b { fs::remove_file(p).map_err(|e| e.to_string())?; }
            }
        }
    }
    entry.restored = true;
    write_record(&dir, entry)?;
    Ok(format!("Restored {}", file.display()))
}

#[tauri::command]
pub fn restore_asset(app: AppHandle, state: State<AppState>, id: String) -> Result<String, String> {
    for dir in backup_dirs(&app) {
        if let Some(mut entry) = records(&dir).into_iter().find(|r| r.id == id) {
            let root = configured_root(&state, &entry.root)?;
            return restore_at(&dir, &root, &mut entry);
        }
    }
    Err("Backup not found.".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (PathBuf, PathBuf) {
        let p = std::env::temp_dir().join(format!("ds1-recycle-test-{}", SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()));
        let root = p.join("mod");
        fs::create_dir_all(root.join("data/global/tiles")).unwrap();
        (p, root)
    }
    #[test]
    fn delete_restore_and_collision() {
        let (p, root) = fixture(); let path = "data/global/tiles/a.dt1"; let file = root.join(path);
        fs::write(&file, b"original").unwrap();
        let mut entry = archive_at(&p, &root, path, b"original", "delete", None, b"original").unwrap();
        assert!(!file.exists()); assert_eq!(records(&p).len(), 1);
        fs::write(&file, b"newer").unwrap();
        assert!(restore_at(&p, &root, &mut entry).is_err());
        assert_eq!(fs::read(&file).unwrap(), b"newer");
        fs::remove_file(&file).unwrap();
        restore_at(&p, &root, &mut entry).unwrap();
        assert_eq!(fs::read(&file).unwrap(), b"original"); assert!(records(&p).is_empty());
        fs::remove_dir_all(p).unwrap();
    }
    #[test]
    fn partial_move_preserves_and_restores_original() {
        let (p, root) = fixture(); let path = "data/global/tiles/a.dt1"; let file = root.join(path);
        fs::write(&file, b"both").unwrap();
        let mut entry = archive_at(&p, &root, path, b"both", "unused", Some(b"used"), b"unused").unwrap();
        assert_eq!(fs::read(&file).unwrap(), b"used");
        assert_eq!(fs::read(entry.unused_path.as_ref().unwrap()).unwrap(), b"unused");
        restore_at(&p, &root, &mut entry).unwrap();
        assert_eq!(fs::read(&file).unwrap(), b"both");
        assert!(!Path::new(entry.unused_path.as_ref().unwrap()).exists());
        fs::remove_dir_all(p).unwrap();
    }
    #[test]
    fn refuses_stale_scan_and_traversal() {
        let (p, root) = fixture(); let path = "data/global/tiles/a.dt1";
        fs::write(root.join(path), b"newer").unwrap();
        assert!(archive_at(&p, &root, path, b"older", "delete", None, b"older").is_err());
        assert!(safe_relative("../a.dt1").is_err()); assert!(safe_relative("C:/a.dt1").is_err());
        assert_eq!(fs::read(root.join(path)).unwrap(), b"newer"); assert!(records(&p).is_empty());
        fs::remove_dir_all(p).unwrap();
    }
    #[test]
    fn failed_backup_leaves_source_untouched() {
        let (p, root) = fixture(); let path = "data/global/tiles/a.dt1";
        fs::write(root.join(path), b"original").unwrap();
        fs::write(p.join("Deleted DT1s"), b"cannot be a directory").unwrap();
        assert!(archive_at(&p, &root, path, b"original", "delete", None, b"original").is_err());
        assert_eq!(fs::read(root.join(path)).unwrap(), b"original");
        fs::remove_dir_all(p).unwrap();
    }
    #[test]
    fn ds1_and_reserved_backup_names_restore() {
        let (p, root) = fixture();
        for path in ["data/global/tiles/a.ds1", "data/global/tiles/removed.dt1", "data/global/tiles/remaining.dt1"] {
            fs::write(root.join(path), b"original").unwrap();
            let mut entry = archive_at(&p, &root, path, b"original", "delete", None, b"original").unwrap();
            assert!(!root.join(path).exists());
            restore_at(&p, &root, &mut entry).unwrap();
            assert_eq!(fs::read(root.join(path)).unwrap(), b"original");
        }
        assert!(records(&p).is_empty());
        fs::remove_dir_all(p).unwrap();
    }
}
