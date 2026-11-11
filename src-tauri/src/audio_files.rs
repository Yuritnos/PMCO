//! Flat audio files with readable names. Import ownership journals stay in app data.
use std::{cmp::Ordering, collections::HashSet, fs::{self, File, OpenOptions}, io::Read, path::{Path,PathBuf}, time::{SystemTime,UNIX_EPOCH}};
use serde::{Deserialize,Serialize};
use sha1::{Digest,Sha1};
use tauri::AppHandle;
type Result<T> = std::result::Result<T,String>;
#[derive(Clone,Default,Deserialize)]
#[serde(default)]
pub struct AudioNaming { pub title:String, pub item:String, pub tracks:Vec<TrackName>, pub next:u32 }
#[derive(Clone,Deserialize)]
pub struct TrackName { pub number:u32, pub title:String }
#[derive(Serialize)]
pub struct AudioFile { pub file:String, pub name:String, pub size:u64, pub track:u32 }
#[derive(Serialize,Deserialize)]
struct OwnedFile { file:String, bytes:u64, sha1:String, created:Option<String> }
#[derive(Serialize,Deserialize)]
struct Journal { version:u32, job:String, root:PathBuf, files:Vec<OwnedFile> }

fn truncate(text:&str,limit:usize)->String {
    let mut units=0;
    text.chars().take_while(|c|{units+=c.len_utf16();units<=limit}).collect()
}
fn clean(text:&str)->String {
    let text=text.chars().map(|c|if c.is_control() || "<>:\"/\\|?*".contains(c){'_'}else{c}).collect::<String>();
    text.trim().trim_end_matches(['.',' ']).to_string()
}
pub fn free_name(root:&Path,requested:&str)->String {
    let requested=clean(requested);
    let (stem,extension)=requested.rsplit_once('.').filter(|(s,e)|!s.is_empty() && !e.is_empty()).unwrap_or((&requested,""));
    let mut stem=truncate(stem,220); if stem.is_empty(){stem="Audio".into();}
    let device=stem.split('.').next().unwrap_or("").to_ascii_uppercase();
    if ["CON","PRN","AUX","NUL","COM1","COM2","COM3","COM4","COM5","COM6","COM7","COM8","COM9","LPT1","LPT2","LPT3","LPT4","LPT5","LPT6","LPT7","LPT8","LPT9"].contains(&device.as_str()){stem.insert(0,'_');}
    let extension=if extension.is_empty(){String::new()}else{format!(".{}",truncate(extension,12))};
    let mut name=format!("{stem}{extension}"); let mut n=2;
    while fs::symlink_metadata(root.join(&name)).is_ok(){name=format!("{stem} ({n}){extension}");n+=1;}
    name
}
impl AudioNaming {
    fn validate(&self)->Result<()> {
        let mut seen=HashSet::new();
        if self.title.len()>16000 || self.item.len()>2000 || self.next>1_000_000 || self.tracks.len()>5000 || self.tracks.iter().any(|t|t.number==0 || t.number>1_000_000 || t.title.len()>16000 || !seen.insert(t.number)){return Err("Invalid audio naming details.".into());}
        Ok(())
    }
    pub fn name(&self,index:usize,extension:&str)->String {
        let slot=self.tracks.get(index);let number=slot.map(|s|s.number).unwrap_or(self.next.max(1)+index.saturating_sub(self.tracks.len()) as u32);
        let title=clean(&self.title);let title=if title.is_empty(){"Untitled"}else{&title};
        let item=clean(&self.item);let item=if item.is_empty(){String::new()}else{format!(" - {item}")};
        let track=slot.map(|s|clean(&s.title)).filter(|s|!s.is_empty()).unwrap_or(format!("Track {number:02}"));
        format!("{}{} - {number:02} - {}.{}",truncate(title,90),truncate(&item,35),truncate(&track,90),extension.to_ascii_lowercase())
    }
}
fn digest(path:&Path)->Result<(u64,String)> {
    let mut file=File::open(path).map_err(|_|"Could not read audio for verification.")?;
    let mut hash=Sha1::new();let mut bytes=0;let mut buffer=[0u8;65536];
    loop{let n=file.read(&mut buffer).map_err(|_|"Could not verify audio.")?;if n==0{break;}hash.update(&buffer[..n]);bytes+=n as u64;}
    Ok((bytes,format!("{:x}",hash.finalize())))
}
fn creation(path:&Path)->Option<String>{fs::metadata(path).ok()?.created().ok()?.duration_since(UNIX_EPOCH).ok().map(|n|n.as_nanos().to_string())}
/// Only newly reserved files enter this journal. Never overwrite anything in the chosen folder.
pub fn copy_batch(sources:&[PathBuf],root:&Path,naming:&AudioNaming,folder:&Path,job:&str)->Result<Vec<AudioFile>> {
    naming.validate()?; if sources.len()>5000{return Err("Choose at most 5,000 audio files at a time.".into());}
    super::audio_location::regular_path(root)?;super::audio_location::regular_path(folder)?;
    if !root.is_dir(){return Err("The audio folder is unavailable.".into());}
    let root=root.canonicalize().map_err(|_|"The audio folder is unavailable.")?;
    fs::create_dir_all(folder).map_err(|_|"Could not create the import journal.")?;
    let manifest=folder.join("adopted.json");let mut journal=Journal{version:2,job:job.into(),root:root.clone(),files:Vec::new()};
    let mut copied=Vec::new();let mut out=Vec::new();
    let result=(||->Result<()>{
        for (i,source) in sources.iter().enumerate(){
            super::audio_location::regular_path(source)?;
            if !source.is_file() || !super::supported_audio(source){return Err("Choose supported regular audio files.".into());}
            let extension=source.extension().and_then(|s|s.to_str()).ok_or("Unsupported audio format.")?;
            let expected=digest(source)?;
            let requested=naming.name(i,extension);
            let (name,path,mut output)=loop{
                let name=free_name(&root,&requested);let path=super::audio_location::join(&root,&name)?;
                match OpenOptions::new().write(true).create_new(true).open(&path){Ok(file)=>break(name,path,file),Err(e)if e.kind()==std::io::ErrorKind::AlreadyExists=>continue,Err(_)=>return Err("Could not create the audio copy.".into())}
            };
            copied.push(path.clone());
            journal.files.push(OwnedFile{file:name.clone(),bytes:expected.0,sha1:expected.1.clone(),created:creation(&path)});
            super::storage::atomic_write(&manifest,&serde_json::to_value(&journal).map_err(|_|"Could not record the audio draft.")?)?;
            let mut input=File::open(source).map_err(|_|"Could not read the selected audio.")?;
            std::io::copy(&mut input,&mut output).and_then(|_|output.sync_all()).map_err(|_|"Could not finish the audio copy.")?;drop(output);
            if digest(&path)?!=expected{return Err("Audio copy verification failed.".into());}
            out.push(AudioFile{file:name.clone(),name,size:expected.0,track:naming.tracks.get(i).map(|s|s.number).unwrap_or(0)});
        }
        Ok(())
    })();
    if let Err(error)=result{for path in copied{let _=fs::remove_file(path);}let _=fs::remove_file(manifest);return Err(error);}
    Ok(out)
}
/// Flat names do not prove ownership. Match the private journal, root, bytes and creation identity.
pub fn reap_manifest(folder:&Path,root:&Path,references:&str,can_clean:bool)->bool {
    if !can_clean{return false;}
    let Ok(bytes)=fs::read(folder.join("adopted.json"))else{return false;};
    let Ok(journal)=serde_json::from_slice::<Journal>(&bytes)else{return false;};
    let Ok(root)=root.canonicalize()else{return false;};
    if journal.version!=2 || journal.job!=folder.file_name().unwrap_or_default().to_string_lossy() || journal.root!=root{return false;}
    let mut safe=true;
    for entry in journal.files {
        if references.contains(&entry.file){continue;}
        if entry.file.contains(['/', '\\', ':']) || entry.file=="." || entry.file==".." || !super::supported_audio(Path::new(&entry.file)){safe=false;continue;}
        let Ok(path)=super::audio_location::join(&root,&entry.file)else{safe=false;continue;};
        if !path.exists(){continue;}
        if !path.is_file() || entry.created.is_some() && creation(&path)!=entry.created || digest(&path).ok()!=Some((entry.bytes,entry.sha1)){safe=false;continue;}
        if fs::remove_file(path).is_err(){safe=false;}
    }
    safe
}
pub fn import_folder(app:&AppHandle)->Result<(PathBuf,String)> {
    let base=super::data_dir(app)?.join("audio-imports");super::audio_location::regular_path(&base)?;fs::create_dir_all(&base).map_err(|_|"Could not create the audio draft folder.")?;
    let job=format!("import-{}-{:x}",std::process::id(),SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_nanos());Ok((base.join(&job),job))
}
pub fn remove_files(root:&Path,files:&[String])->Result<()> {
    let root=root.canonicalize().map_err(|_|"The audio folder is unavailable.")?;
    let paths=files.iter().map(|file|{
        let path=super::audio_location::join(&root,file)?;
        if !super::supported_audio(&path){return Err("That is not an audio file.".into());}Ok(path)
    }).collect::<Result<Vec<_>>>()?;
    for path in paths {
        if let Err(error)=fs::remove_file(&path){if error.kind()!=std::io::ErrorKind::NotFound{return Err("Could not remove the audio file.".into());}}
        if let Some(parent)=path.parent(){if parent!=root{let _=fs::remove_dir(parent);}}
    }Ok(())
}
pub fn recover(app:&AppHandle)->Result<()> {
    let base=super::data_dir(app)?.join("audio-imports");super::audio_location::regular_path(&base)?;
    if !base.is_dir(){return Ok(());}
    let data=super::data_dir(app)?;let (references,safe)=super::cd_drive::collection_references(&data);let root=super::audio_root(app)?;
    for entry in fs::read_dir(base).map_err(|_|"Could not read audio import journals.")?.flatten(){
        let name=entry.file_name().to_string_lossy().to_string();let parts=name.split('-').collect::<Vec<_>>();
        if parts.len()!=3 || parts[0]!="import" || entry.path().is_symlink(){continue;}
        super::audio_location::regular_path(&entry.path())?;
        if parts[1].parse::<u32>().ok().map(|pid|!super::cd_drive::process_alive(pid)).unwrap_or(false){super::cd_drive::reap_folder(&entry.path(),&root,&references,safe);}
    }Ok(())
}
pub fn natural_cmp(left:&str,right:&str)->Ordering {
    let left=left.to_lowercase();let right=right.to_lowercase();let(a,b)=(left.as_bytes(),right.as_bytes());let(mut i,mut j)=(0,0);
    while i<a.len() && j<b.len(){
        if a[i].is_ascii_digit() && b[j].is_ascii_digit(){
            let(mut end_a,mut end_b)=(i,j);while end_a<a.len()&&a[end_a].is_ascii_digit(){end_a+=1;}while end_b<b.len()&&b[end_b].is_ascii_digit(){end_b+=1;}
            let(mut n,mut m)=(i,j);while n<end_a&&a[n]==b'0'{n+=1;}while m<end_b&&b[m]==b'0'{m+=1;}
            let order=(end_a-n).cmp(&(end_b-m)).then_with(||a[n..end_a].cmp(&b[m..end_b]));if order!=Ordering::Equal{return order;}i=end_a;j=end_b;
        }else{let order=a[i].cmp(&b[j]);if order!=Ordering::Equal{return order;}i+=1;j+=1;}
    }a.len().cmp(&b.len())
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Fixture(PathBuf);
    impl Fixture {
        fn new()->Self{let dir=std::env::temp_dir().join(format!("pmco-flat-{:x}",SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()));fs::create_dir_all(dir.join("audio")).unwrap();Self(dir)}
        fn root(&self)->PathBuf{self.0.join("audio")}
        fn source(&self,name:&str,bytes:&[u8])->PathBuf{let path=self.0.join(name);fs::write(&path,bytes).unwrap();path}
        fn folder(&self)->PathBuf{self.0.join("import-0-test")}
    }
    impl Drop for Fixture{fn drop(&mut self){let _=fs::remove_dir_all(&self.0);}}
    fn naming()->AudioNaming{AudioNaming{title:"Symphony".into(),item:"CD2".into(),tracks:vec![TrackName{number:1,title:"I. Opening".into()},TrackName{number:2,title:"II. Finale".into()}],next:3}}
    #[test]
    fn all_import_sources_get_flat_readable_names_with_exact_source_bytes(){
        let f=Fixture::new();let sources=vec![f.source("track-01.flac",b"first"),f.source("part-0001.wav",b"second")];let out=copy_batch(&sources,&f.root(),&naming(),&f.folder(),"import-0-test").unwrap();
        assert_eq!(out[0].file,"Symphony - CD2 - 01 - I. Opening.flac");assert_eq!(out[1].file,"Symphony - CD2 - 02 - II. Finale.wav");assert_eq!(out[0].track,1);assert_eq!(out[1].track,2);
        assert!(fs::read_dir(f.root()).unwrap().all(|entry|entry.unwrap().path().is_file()));assert_eq!(fs::read(f.root().join(&out[0].file)).unwrap(),b"first");assert_eq!(fs::read(&sources[1]).unwrap(),b"second");
        assert!(f.folder().join("adopted.json").is_file());assert!(!f.root().join("adopted.json").exists());
    }
    #[test]
    fn collision_suffixes_never_overwrite_existing_audio_and_discard_keeps_root(){
        let f=Fixture::new();let name=naming().name(0,"flac");fs::write(f.root().join(&name),b"existing").unwrap();let source=f.source("chosen.flac",b"new");
        let out=copy_batch(&[source],&f.root(),&naming(),&f.folder(),"import-0-test").unwrap();assert_eq!(out[0].file,"Symphony - CD2 - 01 - I. Opening (2).flac");remove_files(&f.root(),&[out[0].file.clone()]).unwrap();assert!(f.root().is_dir());assert_eq!(fs::read(f.root().join(name)).unwrap(),b"existing");
    }
    #[test]
    fn failed_batch_removes_only_its_new_files(){
        let f=Fixture::new();let source=f.source("one.wav",b"source");fs::write(f.root().join("keep.wav"),b"keep").unwrap();assert!(copy_batch(&[source,f.0.join("missing.wav")],&f.root(),&naming(),&f.folder(),"import-0-test").is_err());assert_eq!(fs::read_dir(f.root()).unwrap().count(),1);assert_eq!(fs::read(f.root().join("keep.wav")).unwrap(),b"keep");
    }
    #[test]
    fn standalone_missing_metadata_unicode_and_windows_names_are_safe(){
        let f=Fixture::new();let mut n=AudioNaming::default();assert_eq!(n.name(0,"FLAC"),"Untitled - 01 - Track 01.flac");n.title="Album: /\\ *? \"<>|".into();n.tracks=vec![TrackName{number:1,title:"曲目 / Finale?".into()}];let name=free_name(&f.root(),&n.name(0,"wav"));assert!(!name.chars().any(|c|"<>:\"/\\|?*".contains(c)));assert!(!name.contains("CD"));
        assert_eq!(free_name(&f.root(),"CON.wav"),"_CON.wav");n.title="唱片🎵".repeat(100);n.tracks[0].title="楽章🎵".repeat(100);assert!(free_name(&f.root(),&n.name(0,"wav")).encode_utf16().count()<=255);
    }
    #[test]
    fn missing_and_excess_tracks_keep_sequence_and_unassigned_files(){
        let f=Fixture::new();let mut n=naming();n.item.clear();n.tracks=vec![TrackName{number:3,title:String::new()}];n.next=8;let out=copy_batch(&[f.source("a.flac",b"a"),f.source("b.flac",b"b")],&f.root(),&n,&f.folder(),"import-0-test").unwrap();assert_eq!(out[0].file,"Symphony - 03 - Track 03.flac");assert_eq!(out[0].track,3);assert_eq!(out[1].file,"Symphony - 08 - Track 08.flac");assert_eq!(out[1].track,0);
    }
    #[test]
    fn crash_recovery_preserves_references_changed_files_and_foreign_content(){
        let f=Fixture::new();let out=copy_batch(&[f.source("a.flac",b"a"),f.source("b.flac",b"b")],&f.root(),&naming(),&f.folder(),"import-0-test").unwrap();fs::write(f.root().join(&out[1].file),b"replacement").unwrap();fs::write(f.root().join("unrelated.flac"),b"unrelated").unwrap();
        assert!(!reap_manifest(&f.folder(),&f.root(),&out[0].file,true));assert!(f.root().join(&out[0].file).is_file());assert_eq!(fs::read(f.root().join(&out[1].file)).unwrap(),b"replacement");assert!(f.root().join("unrelated.flac").is_file());assert!(!reap_manifest(&f.folder(),&f.root(),"",false));
    }
    #[test]
    fn verified_unreferenced_drafts_are_reaped_but_wrong_root_is_untouched(){
        let f=Fixture::new();let out=copy_batch(&[f.source("a.wav",b"a")],&f.root(),&naming(),&f.folder(),"import-0-test").unwrap();let other=f.0.join("other");fs::create_dir(&other).unwrap();fs::write(other.join(&out[0].file),b"a").unwrap();assert!(!reap_manifest(&f.folder(),&other,"",true));assert!(other.join(&out[0].file).is_file());assert!(reap_manifest(&f.folder(),&f.root(),"",true));assert!(!f.root().join(&out[0].file).exists());
    }
    #[test]
    fn removal_validates_all_paths_and_never_removes_the_selected_folder(){
        let f=Fixture::new();fs::write(f.root().join("one.flac"),b"one").unwrap();assert!(remove_files(&f.root(),&["one.flac".into(),"../escape.flac".into()]).is_err());assert!(f.root().join("one.flac").is_file());remove_files(&f.root(),&["one.flac".into()]).unwrap();assert!(f.root().is_dir());assert_eq!(fs::read_dir(f.root()).unwrap().count(),0);
    }
    #[test]
    fn natural_file_order_and_invalid_naming_are_bounded(){
        let mut files=vec!["10 Finale.wav","2 Middle.wav","01 Opening.wav"];files.sort_by(|a,b|natural_cmp(a,b));assert_eq!(files,vec!["01 Opening.wav","2 Middle.wav","10 Finale.wav"]);let mut n=naming();n.tracks.push(TrackName{number:1,title:"duplicate".into()});assert!(n.validate().is_err());
    }
}
