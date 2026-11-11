//! A computer-local audio location. Absolute paths never enter collection metadata or sync.
use std::{fs, io::Read, path::{Component, Path, PathBuf}, time::{SystemTime, UNIX_EPOCH}};
use serde_json::json;
const CONFIG: &str = "audio-location.json";

fn linked(meta: &fs::Metadata) -> bool {
    if meta.file_type().is_symlink() { return true; }
    #[cfg(windows)] {
        use std::os::windows::fs::MetadataExt;
        if meta.file_attributes() & 0x400 != 0 { return true; }
    }
    false
}

pub(crate) fn regular_path(path: &Path) -> Result<(), String> {
    for part in path.ancestors() {
        match fs::symlink_metadata(part) {
            Ok(meta) if linked(&meta) => return Err("Choose a folder without links or junctions.".into()),
            Ok(_) => {},
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {},
            Err(_) => return Err("The audio folder is unavailable.".into()),
        }
    }
    Ok(())
}

pub fn root(data: &Path) -> Result<PathBuf, String> {
    let path = match fs::read(data.join(CONFIG)) {
        Ok(bytes) => {
            let doc: serde_json::Value = serde_json::from_slice(&bytes).map_err(|_| "The audio folder setting could not be read.")?;
            let path = PathBuf::from(doc["path"].as_str().ok_or("The audio folder setting could not be read.")?);
            // Never recreate an unavailable external location as an empty library.
            if !path.is_absolute() || !path.is_dir() { return Err("The audio folder is unavailable. Reconnect the drive and try again.".into()); }
            path
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            let legacy = data.join("audio");
            let path = if legacy.is_dir() { legacy } else { data.join("PMCO Audio") }; regular_path(&path)?;
            fs::create_dir_all(&path).map_err(|_| "Could not create the audio folder.")?; path
        },
        Err(_) => return Err("The audio folder setting could not be read.".into()),
    };
    regular_path(&path)?;
    path.canonicalize().map_err(|_| "The audio folder is unavailable.".into())
}

pub fn join(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let rel = Path::new(relative);
    if rel.as_os_str().is_empty() || !rel.components().all(|c| matches!(c, Component::Normal(_))) || relative.contains(':') {
        return Err("That is not a file in the audio library.".into());
    }
    let path = root.join(rel); regular_path(&path)?; Ok(path)
}

fn identical(a: &Path, b: &Path) -> Result<bool, String> {
    let mut a = fs::File::open(a).map_err(|_| "Could not verify the audio copy.")?;
    let mut b = fs::File::open(b).map_err(|_| "Could not verify the audio copy.")?;
    let mut left = [0u8; 65536]; let mut right = [0u8; 65536];
    loop {
        let n = a.read(&mut left).map_err(|_| "Could not verify the audio copy.")?;
        // read_exact avoids assuming matching read chunk sizes.
        b.read_exact(&mut right[..n]).map_err(|_| "Could not verify the audio copy.")?;
        if left[..n] != right[..n] { return Ok(false); }
        if n == 0 { return b.read(&mut right[..1]).map(|n| n == 0).map_err(|_| "Could not verify the audio copy.".into()); }
    }
}

pub fn copy_file(source: &Path, target: &Path) -> Result<(), String> {
    regular_path(source)?; regular_path(target)?;
    let mut input = fs::File::open(source).map_err(|_| "Could not read the audio file.")?;
    let mut output = fs::OpenOptions::new().write(true).create_new(true).open(target).map_err(|_| "Could not create the audio copy.")?;
    let result = std::io::copy(&mut input, &mut output).and_then(|_| output.sync_all());
    drop(output);
    if result.is_err() || !identical(source, target).unwrap_or(false) {
        let _ = fs::remove_file(target); return Err("Could not verify the audio copy.".into());
    }
    Ok(())
}

/// Inspect only the existing managed library. Never follow links during a merge.
fn inventory(source: &Path) -> Result<Vec<PathBuf>, String> {
    let mut pending = vec![(source.to_path_buf(), 0usize)]; let mut files = Vec::new(); let mut count = 0;
    while let Some((dir, depth)) = pending.pop() {
        for entry in fs::read_dir(dir).map_err(|_| "Could not read the audio library.")? {
            let entry = entry.map_err(|_| "Could not read the audio library.")?;
            count += 1; if count > 500_000 { return Err("The audio library has too many files.".into()); }
            let meta = fs::symlink_metadata(entry.path()).map_err(|_| "Could not read the audio library.")?;
            if linked(&meta) { return Err("The audio library contains a link or junction.".into()); }
            if meta.is_dir() {
                if depth >= 16 { return Err("The audio library has too many nested folders.".into()); }
                pending.push((entry.path(), depth + 1));
            } else if meta.is_file() { files.push(entry.path().strip_prefix(source).map_err(|_| "Invalid library path.")?.to_path_buf()); }
            else { return Err("The audio library contains an unsupported file.".into()); }
        }
    }
    Ok(files)
}
pub fn has_files(data: &Path) -> Result<bool, String> { match root(data) { Ok(root)=>Ok(!inventory(&root)?.is_empty()), Err(_)=>Ok(false) } }

pub fn relocate<F: FnOnce(&Path) -> Result<(), String>>(data: &Path, chosen: &Path, merge: bool, allow: F) -> Result<PathBuf, String> {
    regular_path(chosen)?;
    let target = chosen.canonicalize().map_err(|_| "Choose an available folder.")?;
    if !target.is_dir() { return Err("Choose an available folder.".into()); }
    let source = root(data).ok();
    if source.as_ref() == Some(&target) { return Ok(target); }
    let data = data.canonicalize().map_err(|_| "Could not read the app folder.")?;
    if source.as_ref().map(|s| target.starts_with(s) || s.starts_with(&target)).unwrap_or(false) || target.starts_with(&data) || data.starts_with(&target) {
        return Err("Choose a folder outside the current library and app data.".into());
    }
    let files = if merge { inventory(source.as_ref().ok_or("The previous audio folder is unavailable.")?)? } else { Vec::new() };
    let source = source.unwrap_or_default();
    // Preflight all collisions before creating anything. Existing equal copies can be reused.
    for rel in &files {
        let dest = target.join(rel); regular_path(&dest)?;
        if dest.exists() && (!dest.is_file() || !identical(&source.join(rel), &dest).unwrap_or(false)) { return Err("audio_location_conflict".into()); }
        let mut parent = dest.parent();
        while let Some(dir) = parent {
            if dir == target { break; }
            if dir.exists() && !dir.is_dir() { return Err("audio_location_conflict".into()); }
            parent = dir.parent();
        }
    }
    let mut copied = Vec::new(); let mut dirs = Vec::new();
    let result = (|| {
        for rel in &files {
            let dest = target.join(rel);
            if dest.exists() { continue; }
            let mut missing = Vec::new(); let mut parent = dest.parent();
            while let Some(dir) = parent { if dir.exists() { break; } missing.push(dir.to_path_buf()); parent = dir.parent(); }
            for dir in missing.into_iter().rev() { fs::create_dir(&dir).map_err(|_| "Could not copy the audio library.")?; dirs.push(dir); }
            copy_file(&source.join(rel), &dest)?; copied.push(dest);
        }
        allow(&target)?;
        super::storage::atomic_write(&data.join(CONFIG), &json!({"path": target}))?;
        Ok(target.clone())
    })();
    if result.is_err() {
        for file in copied.into_iter().rev() { let _ = fs::remove_file(file); }
        for dir in dirs.into_iter().rev() { let _ = fs::remove_dir(dir); }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn relocation_preserves_originals_and_relative_paths_and_rejects_unsafe_destinations() {
        let base = std::env::temp_dir().join(format!("pmco-location-{}", SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()));
        let data = base.join("data"); let dest = base.join("chosen"); fs::create_dir_all(&data).unwrap(); fs::create_dir(&dest).unwrap();
        let old = root(&data).unwrap(); fs::create_dir(old.join("disc")).unwrap(); fs::write(old.join("disc/test.flac"), b"audio fixture").unwrap();
        assert!(relocate(&data, &old.join("nested"), true, |_| Ok(())).is_err());
        assert!(old.ends_with("PMCO Audio"));
        let new = relocate(&data, &dest, true, |_| Ok(())).unwrap(); assert_eq!(root(&data).unwrap(), new.canonicalize().unwrap());
        assert_eq!(fs::read(new.join("disc/test.flac")).unwrap(), b"audio fixture"); assert!(old.join("disc/test.flac").is_file());
        assert!(join(&new, "../outside").is_err()); assert!(join(&new, "disc/file:stream").is_err());
        fs::remove_dir_all(&new).unwrap(); assert!(root(&data).is_err()); // no fallback/recreation on disconnected drive
        fs::remove_dir_all(base).unwrap();
    }
    #[test]
    fn existing_destination_and_failed_copy_do_not_switch_or_overwrite() {
        let base = std::env::temp_dir().join(format!("pmco-location-fail-{}", SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()));
        let data = base.join("data"); let dest = base.join("chosen"); fs::create_dir_all(&data).unwrap(); fs::create_dir_all(&dest).unwrap();
        let old = root(&data).unwrap(); fs::write(dest.join("keep"), b"keep").unwrap(); fs::write(old.join("keep"), b"different").unwrap();
        assert!(relocate(&data, &dest, true, |_| Ok(())).is_err()); assert_eq!(root(&data).unwrap(), old);
        assert_eq!(fs::read(dest.join("keep")).unwrap(), b"keep");
        let target = base.join("target.flac"); assert!(copy_file(&base.join("missing"), &target).is_err()); assert!(!target.exists());
        fs::remove_dir_all(base).unwrap();
    }
    #[test]
    fn direct_folder_merge_reuses_identical_files_and_keeps_unrelated_content() {
        let base=std::env::temp_dir().join(format!("pmco-merge-{:x}",SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()));
        let data=base.join("data");let dest=base.join("chosen");fs::create_dir_all(&data).unwrap();fs::create_dir_all(dest.join("disc")).unwrap();
        let old=root(&data).unwrap();fs::create_dir(old.join("disc")).unwrap();
        fs::write(old.join("disc/same.wav"),b"same").unwrap();fs::write(dest.join("disc/same.wav"),b"same").unwrap();fs::write(old.join("disc/new.wav"),b"new").unwrap();fs::write(dest.join("keep.txt"),b"keep").unwrap();
        let new=relocate(&data,&dest,true,|_|Ok(())).unwrap();assert_eq!(new,dest.canonicalize().unwrap());assert!(!new.join("PMCO Audio").exists());assert_eq!(fs::read(new.join("disc/new.wav")).unwrap(),b"new");assert!(new.join("keep.txt").is_file());assert!(old.join("disc/new.wav").is_file());
        fs::remove_dir_all(base).unwrap();
    }
    #[test]
    fn switch_only_and_unavailable_old_location_preserve_originals_and_legacy_root() {
        let base=std::env::temp_dir().join(format!("pmco-switch-{:x}",SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()));
        let data=base.join("data");let legacy=data.join("audio");let dest=base.join("chosen");fs::create_dir_all(&legacy).unwrap();fs::create_dir_all(&dest).unwrap();fs::write(legacy.join("saved.wav"),b"old").unwrap();
        assert_eq!(root(&data).unwrap(),legacy.canonicalize().unwrap());relocate(&data,&dest,false,|_|Ok(())).unwrap();assert!(!dest.join("saved.wav").exists());assert!(legacy.join("saved.wav").exists());
        fs::remove_dir(&dest).unwrap();assert!(root(&data).is_err());let replacement=base.join("replacement");fs::create_dir(&replacement).unwrap();relocate(&data,&replacement,false,|_|Ok(())).unwrap();assert_eq!(root(&data).unwrap(),replacement.canonicalize().unwrap());fs::remove_dir_all(base).unwrap();
    }
    #[test]
    fn failed_merge_rolls_back_only_new_copies_and_retains_previous_setting() {
        let base=std::env::temp_dir().join(format!("pmco-merge-fail-{:x}",SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()));
        let data=base.join("data");let dest=base.join("chosen");fs::create_dir_all(&data).unwrap();fs::create_dir_all(&dest).unwrap();let old=root(&data).unwrap();fs::write(old.join("new.wav"),b"new").unwrap();fs::write(dest.join("keep.wav"),b"keep").unwrap();
        assert!(relocate(&data,&dest,true,|_|Err("isolated failure".into())).is_err());assert_eq!(root(&data).unwrap(),old);assert!(!dest.join("new.wav").exists());assert_eq!(fs::read(dest.join("keep.wav")).unwrap(),b"keep");fs::remove_dir_all(base).unwrap();
    }
}
