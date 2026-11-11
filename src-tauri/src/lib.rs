//! PMCO desktop app. The page (src/index.html) does all the work on screen; this side keeps the
//! collection in a JSON file in the app's data folder and hands it to the page on request. It also
//! keeps the audio library: copies of the audio files people add to their CDs, which the page plays
//! through Tauri's asset protocol (allowed for the audio folder only, see tauri.conf.json).

use std::fs;
use std::path::{Component, Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use base64::Engine;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::DialogExt;
mod cd_drive;
mod storage;
mod audio_location;
mod audio_split;
static COLLECTION_IO: std::sync::Mutex<()> = std::sync::Mutex::new(());
static AUDIO_IO: std::sync::Mutex<()> = std::sync::Mutex::new(());

const DATA_FILE: &str = "collection.json";
/// The collection as it was before the last save.
const BACKUP_FILE: &str = "collection.backup.json";
/// One copy a day, "backups/collection-YYYY-MM-DD.json": the collection as it was before that
/// day's first change. The newest DAILY_BACKUPS are kept.
const BACKUPS_DIR: &str = "backups";
const DAILY_BACKUPS: usize = 14;
/// Cover pictures: <app data dir>/covers/<hash>-<size>.<jpg|png|webp>, named after their content.
const COVERS_DIR: &str = "covers";
/// Formats the app's web view can play.
const AUDIO_TYPES: [&str; 8] = ["mp3", "flac", "wav", "m4a", "aac", "ogg", "oga", "opus"];

/// The app's own data folder, created if needed.
/// Windows: %APPDATA%\com.cdc.collection   macOS: ~/Library/Application Support/com.cdc.collection
fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Could not find the data folder: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("Could not create {}: {e}", dir.display()))?;
    Ok(dir)
}

/// Load only this profile's saved collection. A new profile starts empty, even
/// when an abandoned trial exists beside it; importing that file is explicit.
fn load_collection_at(dir: &Path) -> Result<Value, String> {
    storage::read(&dir.join(DATA_FILE))
}

#[cfg(test)]
mod startup_tests {
    use super::*;

    #[test]
    fn fresh_profile_ignores_trial_and_existing_profile_is_preserved() {
        let root = std::env::temp_dir().join(format!("pmco-startup-{}-{}", std::process::id(), SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()));
        let trial = root.join("CDC");
        let current = root.join("com.cdc.collection");
        fs::create_dir_all(&trial).unwrap(); fs::create_dir_all(&current).unwrap();
        let legacy = br#"{"cds":[{"id":"old-fixture","title":"Old trial"}]}"#;
        fs::write(trial.join(DATA_FILE), legacy).unwrap();
        assert_eq!(load_collection_at(&current).unwrap()["cds"], json!([]));
        assert!(!current.join(DATA_FILE).exists());
        assert_eq!(fs::read(trial.join(DATA_FILE)).unwrap(), legacy);
        let saved = json!({"cds":[{"id":"keep-fixture","title":"Keep saved music"}],"meta":{"playlists":[]},"sync":{"account":"fixture"},"legacy":{"keep":true}});
        fs::write(current.join(DATA_FILE), serde_json::to_vec(&saved).unwrap()).unwrap();
        assert_eq!(load_collection_at(&current).unwrap(), saved);
        fs::write(current.join(DATA_FILE), b"broken").unwrap();
        assert!(load_collection_at(&current).is_err());
        assert_eq!(fs::read(trial.join(DATA_FILE)).unwrap(), legacy);
        fs::remove_dir_all(root).unwrap();
    }
}

fn user_name() -> String {
    for key in ["USERNAME", "USER"] {
        if let Ok(v) = std::env::var(key) {
            if !v.is_empty() {
                return v;
            }
        }
    }
    String::new()
}

/// Return the saved collection: { cds: [...], meta: {...}, user: "..." }.
#[tauri::command]
async fn load_data(app: AppHandle) -> Result<Value, String> {
    let _guard = COLLECTION_IO.lock().map_err(|_| "Could not load the collection.")?;
    let mut doc = load_collection_at(&data_dir(&app)?)?;
    doc["user"] = Value::String(user_name());
    Ok(doc)
}

/// Save the whole collection. The previous file is kept as a backup, and the new one is written
/// to a temporary file first so a crash mid-save cannot leave a half-written collection.
#[tauri::command]
async fn save_data(app: AppHandle, data: Value) -> Result<(), String> {
    let _guard = COLLECTION_IO.lock().map_err(|_| "Could not save the collection.")?;
    let cds_ok = data.get("cds").map(|v| v.is_array()).unwrap_or(false);
    if !data.is_object() || !cds_ok {
        return Err("The collection is not in the expected shape.".into());
    }
    let dir = data_dir(&app)?;
    let path = dir.join(DATA_FILE);
    // Refuse writes over an unreadable collection, including calls outside the recovery UI.
    storage::read(&path)?;
    if path.is_file() {
        fs::copy(&path, dir.join(BACKUP_FILE)).map_err(|_| "Could not preserve the previous save.")?;
        daily_backup(&dir, &path);
    }
    storage::atomic_write(&path, &data)
}

#[tauri::command]
async fn recover_collection(app: AppHandle, backup: Option<String>) -> Result<(), String> {
    let _guard = COLLECTION_IO.lock().map_err(|_| "Could not recover the collection.")?;
    let dir = data_dir(&app)?;
    let doc = match backup {
        Some(name) => {
            let path = if name == BACKUP_FILE { dir.join(BACKUP_FILE) }
                else if is_daily_backup_name(&name) { dir.join(BACKUPS_DIR).join(name) }
                else { return Err("That is not a backup.".into()); };
            let bytes = fs::read(&path).map_err(|_| "The backup could not be read.")?;
            storage::validate(serde_json::from_slice(&bytes).map_err(|_| "The backup could not be read.")?)?
        },
        None => json!({"cds": [], "meta": {}}),
    };
    storage::recover(&dir.join(DATA_FILE), &doc)
}

fn preserved_collections(dir: &Path) -> Result<Vec<PathBuf>, String> {
    fs::read_dir(dir).map_err(|_| "Could not inspect preserved collections.")?
        .map(|entry| entry.map(|e| e.path()).map_err(|_| "Could not inspect preserved collections.".to_string()))
        .filter(|path| match path {
            Ok(path) => path.file_name().and_then(|n| n.to_str()).map(|n| n.starts_with("collection.unreadable-") && n.ends_with(".json")).unwrap_or(false),
            Err(_) => true,
        }).collect()
}

/// Year, month and day of a count of days since 1970-01-01 (Howard Hinnant's civil_from_days).
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = (if z >= 0 { z } else { z - 146_096 }) / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = (if mp < 10 { mp + 3 } else { mp - 9 }) as u32;
    let year = yoe as i64 + era * 400 + if month <= 2 { 1 } else { 0 };
    (year, month, day)
}

/// "YYYY-MM-DD" (UTC) of a moment.
fn date_of(t: SystemTime) -> String {
    let secs = t.duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0) as i64;
    let (y, m, d) = civil_from_days(secs.div_euclid(86_400));
    format!("{y:04}-{m:02}-{d:02}")
}

/// The day's first save copies the collection as it was into backups/, and old copies are dropped.
fn daily_backup(dir: &Path, current: &Path) {
    let folder = dir.join(BACKUPS_DIR);
    if fs::create_dir_all(&folder).is_err() {
        return;
    }
    let today = folder.join(format!("collection-{}.json", date_of(SystemTime::now())));
    if !today.exists() {
        let _ = fs::copy(current, &today);
    }
    let mut names: Vec<String> = fs::read_dir(&folder)
        .map(|entries| {
            entries
                .flatten()
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .filter(|n| is_daily_backup_name(n))
                .collect()
        })
        .unwrap_or_default();
    names.sort();
    names.reverse();
    for old in names.iter().skip(DAILY_BACKUPS) {
        let _ = fs::remove_file(folder.join(old));
    }
}

/// "collection-YYYY-MM-DD.json"
fn is_daily_backup_name(name: &str) -> bool {
    name.len() == 26
        && name.starts_with("collection-")
        && name.ends_with(".json")
        && name[11..21].chars().all(|c| c.is_ascii_digit() || c == '-')
}

/// A backup the person can go back to.
#[derive(serde::Serialize)]
struct BackupInfo {
    /// File name, to ask read_backup for it.
    name: String,
    /// "YYYY-MM-DD" (UTC).
    date: String,
    /// "daily" (as it was before that day's first change) or "previous" (before the last change).
    kind: &'static str,
    cds: usize,
}

fn count_cds(path: &Path) -> Option<usize> {
    let text = fs::read_to_string(path).ok()?;
    let doc: Value = serde_json::from_str(&text).ok()?;
    Some(doc.get("cds")?.as_array()?.len())
}

/// The backups on this computer, newest first.
#[tauri::command]
async fn list_backups(app: AppHandle) -> Result<Vec<BackupInfo>, String> {
    let dir = data_dir(&app)?;
    let mut out = Vec::new();
    let previous = dir.join(BACKUP_FILE);
    if let (Some(cds), Ok(meta)) = (count_cds(&previous), fs::metadata(&previous)) {
        let date = meta.modified().map(date_of).unwrap_or_default();
        out.push(BackupInfo { name: BACKUP_FILE.into(), date, kind: "previous", cds });
    }
    let mut daily: Vec<BackupInfo> = fs::read_dir(dir.join(BACKUPS_DIR))
        .map(|entries| {
            entries
                .flatten()
                .filter_map(|e| {
                    let name = e.file_name().to_string_lossy().into_owned();
                    if !is_daily_backup_name(&name) {
                        return None;
                    }
                    let cds = count_cds(&e.path())?;
                    Some(BackupInfo { date: name[11..21].to_string(), name, kind: "daily", cds })
                })
                .collect()
        })
        .unwrap_or_default();
    daily.sort_by(|a, b| b.name.cmp(&a.name));
    out.extend(daily);
    Ok(out)
}

/// One backup's contents, by a name list_backups gave.
#[tauri::command]
async fn read_backup(app: AppHandle, name: String) -> Result<Value, String> {
    let dir = data_dir(&app)?;
    let path = if name == BACKUP_FILE {
        dir.join(BACKUP_FILE)
    } else if is_daily_backup_name(&name) {
        dir.join(BACKUPS_DIR).join(&name)
    } else {
        return Err("That is not a backup.".into());
    };
    let text = fs::read_to_string(&path).map_err(|e| format!("Could not read the backup: {e}"))?;
    serde_json::from_str(&text).map_err(|_| "The backup could not be read.".to_string())
}

fn covers_root(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = data_dir(app)?.join(COVERS_DIR);
    fs::create_dir_all(&dir).map_err(|e| format!("Could not create {}: {e}", dir.display()))?;
    Ok(dir)
}

/// Cover file names are made by save_cover; anything else is refused.
fn cover_path(app: &AppHandle, file: &str) -> Result<PathBuf, String> {
    let ok = !file.is_empty()
        && file.len() <= 64
        && file.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '.')
        && !file.contains("..")
        && (file.ends_with(".jpg") || file.ends_with(".png") || file.ends_with(".webp"));
    if !ok {
        return Err("That is not a cover file.".into());
    }
    Ok(covers_root(app)?.join(file))
}

/// 64-bit FNV-1a, for naming cover files after their content.
fn fnv1a(bytes: &[u8]) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in bytes {
        h ^= *b as u64;
        h = h.wrapping_mul(0x0100_0000_01b3);
    }
    h
}

/// The covers folder, so the page can show cover files through the asset protocol.
#[tauri::command]
async fn covers_root_dir(app: AppHandle) -> Result<String, String> {
    Ok(covers_root(&app)?.to_string_lossy().into_owned())
}

/// Keep a cover picture (a data URL from the page) as a file and return its name. The same picture
/// always gets the same name, so saving it again writes nothing.
#[tauri::command]
async fn save_cover(app: AppHandle, data: String) -> Result<String, String> {
    let (head, body) = data.split_once(',').ok_or("That is not a picture.")?;
    let ext = match head {
        "data:image/jpeg;base64" | "data:image/jpg;base64" => "jpg",
        "data:image/png;base64" => "png",
        "data:image/webp;base64" => "webp",
        _ => return Err("That is not a picture.".into()),
    };
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(body.trim())
        .map_err(|_| "That is not a picture.".to_string())?;
    if bytes.is_empty() || bytes.len() as u64 > MAX_COVER_BYTES {
        return Err("The picture is too large.".into());
    }
    let name = format!("{:016x}-{}.{ext}", fnv1a(&bytes), bytes.len());
    let path = cover_path(&app, &name)?;
    if !path.is_file() {
        let tmp = path.with_extension("tmp");
        fs::write(&tmp, &bytes).map_err(|e| format!("Could not save the cover: {e}"))?;
        fs::rename(&tmp, &path).map_err(|e| format!("Could not save the cover: {e}"))?;
    }
    Ok(name)
}

/// A cover file as a data URL (for sync, exports and the cover cropper).
#[tauri::command]
async fn cover_data(app: AppHandle, file: String) -> Result<String, String> {
    let path = cover_path(&app, &file)?;
    let bytes = fs::read(&path).map_err(|e| format!("Could not read the cover: {e}"))?;
    let mime = if file.ends_with(".png") {
        "image/png"
    } else if file.ends_with(".webp") {
        "image/webp"
    } else {
        "image/jpeg"
    };
    Ok(format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes)))
}

/// Delete cover files that neither the collection nor any backup mentions. Does nothing unless the
/// collection itself can be read. Returns how many were deleted.
#[tauri::command]
async fn tidy_covers(app: AppHandle) -> Result<u32, String> {
    let dir = data_dir(&app)?;
    let Ok(main) = fs::read_to_string(dir.join(DATA_FILE)) else { return Ok(0) };
    if serde_json::from_str::<Value>(&main).is_err() {
        return Ok(0);
    }
    let mut texts = vec![main];
    // A damaged archive can contain the only remaining reference to a cover. Be conservative.
    let Ok(preserved) = preserved_collections(&dir) else { return Ok(0) };
    for path in preserved {
        let Ok(text) = fs::read_to_string(path) else { return Ok(0) };
        if storage::validate(serde_json::from_str(&text).unwrap_or(Value::Null)).is_err() { return Ok(0); }
        texts.push(text);
    }
    if let Ok(t) = fs::read_to_string(dir.join(BACKUP_FILE)) {
        texts.push(t);
    }
    if let Ok(entries) = fs::read_dir(dir.join(BACKUPS_DIR)) {
        for e in entries.flatten() {
            if let Ok(t) = fs::read_to_string(e.path()) {
                texts.push(t);
            }
        }
    }
    let mut removed = 0;
    if let Ok(entries) = fs::read_dir(covers_root(&app)?) {
        for e in entries.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            if !texts.iter().any(|t| t.contains(&name)) && fs::remove_file(e.path()).is_ok() {
                removed += 1;
            }
        }
    }
    Ok(removed)
}

/// Open CDC's download page on GitHub in the default browser. Only this fixed address is opened.
#[tauri::command]
async fn open_releases() -> Result<(), String> {
    let url = "https://github.com/Yuritnos/PMCO/releases";
    #[cfg(target_os = "windows")]
    let result = std::process::Command::new("rundll32").args(["url.dll,FileProtocolHandler", url]).spawn();
    #[cfg(target_os = "macos")]
    let result = std::process::Command::new("open").arg(url).spawn();
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    let result = std::process::Command::new("xdg-open").arg(url).spawn();
    result.map(|_| ()).map_err(|e| format!("Could not open the page: {e}"))
}

/// Largest cover picture fetch_cover will download.
const MAX_COVER_BYTES: u64 = 5 * 1024 * 1024;

/// Download a release's cover picture for "Find this CD online". Discogs does not let web pages load
/// its pictures, so the app fetches them here and hands the bytes to the page. Only https addresses
/// on Discogs' picture server are accepted, and only pictures up to MAX_COVER_BYTES.
#[tauri::command]
async fn fetch_cover(url: String) -> Result<tauri::ipc::Response, String> {
    let address = reqwest::Url::parse(&url).map_err(|_| "That is not a web address.".to_string())?;
    let host = address.host_str().unwrap_or("");
    if address.scheme() != "https" || !(host == "i.discogs.com" || host == "img.discogs.com") {
        return Err("Only Discogs cover pictures can be downloaded.".into());
    }
    let client = reqwest::Client::builder()
        .user_agent(concat!("PMCO/", env!("CARGO_PKG_VERSION"), " +https://github.com/Yuritnos/PMCO"))
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())?;
    let reply = client
        .get(address)
        .send()
        .await
        .map_err(|e| format!("Could not download the cover: {e}"))?;
    if !reply.status().is_success() {
        return Err(format!("Could not download the cover ({}).", reply.status()));
    }
    let is_picture = reply
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(|v| v.starts_with("image/"))
        .unwrap_or(false);
    if !is_picture {
        return Err("That address is not a picture.".into());
    }
    if reply.content_length().unwrap_or(0) > MAX_COVER_BYTES {
        return Err("The picture is too large.".into());
    }
    let bytes = reply
        .bytes()
        .await
        .map_err(|e| format!("Could not download the cover: {e}"))?;
    if bytes.len() as u64 > MAX_COVER_BYTES {
        return Err("The picture is too large.".into());
    }
    Ok(tauri::ipc::Response::new(bytes.to_vec()))
}

/// An audio file in the library, as the page stores it with its CD.
#[derive(serde::Serialize)]
struct AudioFile {
    /// Path inside the audio library, "<CD id>/<file name>".
    file: String,
    /// The original file name, for showing.
    name: String,
    size: u64,
}

fn audio_root(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = audio_location::root(&data_dir(app)?)?;
    app.asset_protocol_scope().allow_directory(&dir, true).map_err(|_| "Could not allow the audio folder.")?;
    Ok(dir)
}

/// CD ids are made by the page from letters and digits; anything else is refused.
fn check_cd_id(id: &str) -> Result<(), String> {
    let ok = !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if ok { Ok(()) } else { Err("That is not a CD id.".into()) }
}

/// The full path of a library file, refusing anything that would point outside the library.
fn library_path(app: &AppHandle, file: &str) -> Result<PathBuf, String> {
    let rel = Path::new(file);
    let plain = !rel.as_os_str().is_empty() && rel.components().all(|c| matches!(c, Component::Normal(_)));
    if !plain {
        return Err("That is not a file in the audio library.".into());
    }
    audio_location::join(&audio_root(app)?, file)
}

fn audio_item_dir(app: &AppHandle, id: &str) -> Result<PathBuf, String> {
    check_cd_id(id)?;
    audio_location::join(&audio_root(app)?, id)
}

/// A file name that is safe on Windows and not yet used in `dir`.
fn free_name(dir: &Path, original: &str) -> String {
    let cleaned: String = original
        .chars()
        .map(|c| if c.is_control() || "<>:\"/\\|?*".contains(c) { '_' } else { c })
        .collect();
    let cleaned = cleaned.trim().trim_end_matches('.').to_string();
    let base = if cleaned.is_empty() { "audio".to_string() } else { cleaned };
    let (stem, ext) = match base.rfind('.') {
        Some(i) if i > 0 => (base[..i].to_string(), base[i..].to_string()),
        _ => (base.clone(), String::new()),
    };
    let mut name = base.clone();
    let mut n = 2;
    while dir.join(&name).exists() {
        name = format!("{stem} ({n}){ext}");
        n += 1;
    }
    name
}

/// The audio library's folder, so the page can turn library paths into playable addresses.
#[tauri::command]
async fn audio_root_dir(app: AppHandle) -> Result<String, String> {
    Ok(audio_root(&app)?.to_string_lossy().into_owned())
}

#[tauri::command]
async fn choose_audio_location(app: AppHandle, prompt: String, yes: String, no: String, cancel: String) -> Result<Option<String>, String> {
    let Some(picked) = app.dialog().file().blocking_pick_folder() else { return Ok(None) };
    let parent = picked.into_path().map_err(|_| "Choose a local folder.")?;
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = AUDIO_IO.try_lock().map_err(|_| "Audio storage is busy.")?;
        let dir = data_dir(&app)?;
        let merge = if audio_location::has_files(&dir)? && audio_location::root(&dir)? != parent.canonicalize().map_err(|_| "Choose an available folder.")? {
            use tauri_plugin_dialog::{MessageDialogButtons, MessageDialogResult};
            match app.dialog().message(prompt).title("PMCO").buttons(MessageDialogButtons::YesNoCancelCustom(yes.clone(), no.clone(), cancel)).blocking_show_with_result() {
                MessageDialogResult::Custom(value) if value == yes => true,
                MessageDialogResult::Custom(value) if value == no => false,
                _ => return Ok(None),
            }
        } else { false };
        let target = audio_location::relocate(&dir, &parent, merge, |target| {
            app.asset_protocol_scope().allow_directory(target, true).map_err(|_| "Could not allow the audio folder.".into())
        })?;
        Ok(Some(target.to_string_lossy().into_owned()))
    }).await.map_err(|_| "Could not change the audio folder.")?
}

const MAX_AUDIO_FILES: usize = 5000;

fn supported_audio(path: &Path) -> bool {
    path.extension().and_then(|e| e.to_str())
        .map(|e| AUDIO_TYPES.iter().any(|kind| e.eq_ignore_ascii_case(kind))).unwrap_or(false)
}

fn linked_entry(meta: &fs::Metadata) -> bool {
    if meta.file_type().is_symlink() { return true; }
    #[cfg(windows)] {
        use std::os::windows::fs::MetadataExt;
        if meta.is_dir() && meta.file_attributes() & 0x400 != 0 { return true; }
    }
    false
}

/// A batch owns only newly-created copies. Never overwrite library files, even on failure.
fn copy_audio_sources(sources: &[(PathBuf, String)], dir: &Path, cd_id: &str) -> Result<Vec<AudioFile>, String> {
    check_cd_id(cd_id)?;
    if sources.len() > MAX_AUDIO_FILES { return Err("Choose at most 5,000 audio files at a time.".into()); }
    fs::create_dir_all(dir).map_err(|e| format!("Could not create {}: {e}", dir.display()))?;
    let mut added = Vec::new();
    let mut copied = Vec::new();
    let result = (|| -> Result<(), String> {
        for (source, name) in sources {
            let meta = fs::symlink_metadata(source).map_err(|e| format!("Could not read {name}: {e}"))?;
            if linked_entry(&meta) || !meta.is_file() || !supported_audio(source) { return Err("Choose supported regular audio files.".into()); }
            let original = source.file_name().and_then(|n| n.to_str()).unwrap_or("audio");
            let (target, mut output) = loop {
                let target = free_name(dir, original);
                match fs::OpenOptions::new().write(true).create_new(true).open(dir.join(&target)) {
                    Ok(output) => break (target, output),
                    Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
                    Err(e) => return Err(format!("Could not create audio copy: {e}")),
                }
            };
            copied.push(dir.join(&target));
            let mut input = fs::File::open(source).map_err(|e| format!("Could not read {name}: {e}"))?;
            let size = std::io::copy(&mut input, &mut output).map_err(|e| format!("Could not copy {name}: {e}"))?;
            output.sync_all().map_err(|e| format!("Could not finish audio copy: {e}"))?;
            added.push(AudioFile { file: format!("{cd_id}/{target}"), name: name.clone(), size });
        }
        Ok(())
    })();
    if let Err(error) = result {
        for file in copied { let _ = fs::remove_file(file); }
        return Err(error);
    }
    Ok(added)
}

/// Copy chosen audio files into any physical item's draft.
#[tauri::command]
async fn add_audio(app: AppHandle, cd_id: String) -> Result<Vec<AudioFile>, String> {
    check_cd_id(&cd_id)?;
    let Some(picked) = app.dialog().file().add_filter("Audio", &AUDIO_TYPES).blocking_pick_files() else { return Ok(Vec::new()) };
    let sources = picked.into_iter().map(|chosen| {
        let source = chosen.into_path().map_err(|e| format!("Could not read that file: {e}"))?;
        let name = source.file_name().and_then(|n| n.to_str()).unwrap_or("audio").to_string();
        Ok((source, name))
    }).collect::<Result<Vec<_>, String>>()?;
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = AUDIO_IO.lock().map_err(|_| "Audio storage is busy.")?;
        let dir = audio_item_dir(&app, &cd_id)?;
        copy_audio_sources(&sources, &dir, &cd_id)
    }).await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod audio_import_tests {
    use super::*;
    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
            let root = std::env::temp_dir().join(format!("pmco-audio-fixture-{}-{stamp}", std::process::id()));
            fs::create_dir_all(&root).unwrap(); Self(root)
        }
    }
    impl Drop for Fixture { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); } }
    #[test]
    fn copy_batch_preserves_originals_and_assigns_unique_local_names() {
        let f = Fixture::new(); let output = f.0.join("library"); fs::create_dir_all(&output).unwrap();
        let source = f.0.join("track.wav"); fs::write(&source, b"new audio").unwrap();
        fs::write(output.join("track.wav"), b"saved audio").unwrap();
        let added = copy_audio_sources(&[(source.clone(), "Side A/track.wav".into()), (source.clone(), "Side B/track.wav".into())], &output, "fixture").unwrap();
        assert_eq!(added.len(), 2); assert_ne!(added[0].file, added[1].file);
        assert_eq!(added[0].name, "Side A/track.wav"); assert_eq!(added[0].size, 9);
        assert_eq!(fs::read(output.join("track.wav")).unwrap(), b"saved audio");
        assert_eq!(fs::read(source).unwrap(), b"new audio");
    }
    #[test]
    fn failed_batch_removes_only_new_copies() {
        let f = Fixture::new(); let output = f.0.join("library"); fs::create_dir_all(&output).unwrap();
        let source = f.0.join("track.wav"); fs::write(&source, b"source").unwrap();
        fs::write(output.join("saved.flac"), b"keep").unwrap();
        let sources = vec![(source.clone(), "track.wav".into()), (f.0.join("missing.wav"), "missing.wav".into())];
        assert!(copy_audio_sources(&sources, &output, "fixture").is_err());
        assert_eq!(fs::read_dir(&output).unwrap().count(), 1);
        assert_eq!(fs::read(output.join("saved.flac")).unwrap(), b"keep"); assert!(source.exists());
    }
    #[test]
    fn invalid_sources_and_excessive_nesting_are_rejected() {
        let f = Fixture::new(); let library = f.0.join("library"); fs::create_dir_all(&library).unwrap();
        let invalid = f.0.join("picture.png"); fs::write(&invalid, b"picture").unwrap();
        assert!(copy_audio_sources(&[(invalid.clone(), "picture.png".into())], &library, "fixture").is_err());
        assert!(copy_audio_sources(&[], &library, "../escape").is_err());
        assert!(copy_audio_sources(&vec![(invalid, "picture.png".into()); MAX_AUDIO_FILES+1], &library, "fixture").is_err());

    }
}

/// Which of these library files are on this computer (audio is not synced between computers).
#[tauri::command]
async fn audio_present(app: AppHandle, files: Vec<String>) -> Result<Vec<bool>, String> {
    Ok(files.iter().map(|f| library_path(&app, f).map(|p| p.is_file()).unwrap_or(false)).collect())
}

/// Delete library copies. Files already gone are fine.
#[tauri::command]
async fn remove_audio(app: AppHandle, files: Vec<String>) -> Result<(), String> {
    let _guard = AUDIO_IO.lock().map_err(|_| "Audio storage is busy.")?;
    for f in &files {
        let path = library_path(&app, f)?;
        if let Err(e) = fs::remove_file(&path) {
            if e.kind() != std::io::ErrorKind::NotFound {
                return Err(format!("Could not remove {f}: {e}"));
            }
        }
        if let Some(parent) = path.parent() {
            let _ = fs::remove_dir(parent); // only succeeds once the CD's folder is empty
        }
    }
    Ok(())
}

/// Delete all audio of a removed CD.
#[tauri::command]
async fn remove_cd_audio(app: AppHandle, cd_id: String) -> Result<(), String> {
    let _guard = AUDIO_IO.lock().map_err(|_| "Audio storage is busy.")?;
    check_cd_id(&cd_id)?;
    let dir = audio_item_dir(&app, &cd_id)?;
    if dir.is_dir() {
        fs::remove_dir_all(&dir).map_err(|e| format!("Could not remove the audio of that CD: {e}"))?;
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(cd_drive::DriveState::default())
        .manage(audio_split::SplitState::default())
        .register_uri_scheme_protocol("pmco-audio", |context, request| audio_split::preview(context.app_handle(), request))
        .setup(|app| { let _ = cd_drive::recover(app.handle()); let _ = audio_split::recover(app.handle()); Ok(()) })
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            load_data,
            save_data,
            recover_collection,
            choose_audio_location,
            fetch_cover,
            audio_root_dir,
            add_audio,
            audio_split::prepare_audio_split,
            audio_split::start_audio_split,
            audio_split::audio_split_status,
            audio_split::cancel_audio_split,
            audio_split::adopt_audio_split,
            audio_present,
            remove_audio,
            remove_cd_audio,
            list_backups,
            read_backup,
            covers_root_dir,
            save_cover,
            cover_data,
            tidy_covers,
            open_releases
            ,cd_drive::list_cd_drives
            ,cd_drive::read_cd_disc
            ,cd_drive::start_cd_import
            ,cd_drive::cd_import_status
            ,cd_drive::cancel_cd_import
            ,cd_drive::adopt_cd_import
        ])
        .run(tauri::generate_context!())
        .expect("error while running PMCO");
}
