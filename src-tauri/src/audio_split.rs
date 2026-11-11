//! Sample-aligned, bounded-memory WAV/FLAC splitting. Paths come only from the native picker.
use std::{fs::{self, File, OpenOptions}, io::{Read, Seek, SeekFrom, Write}, path::{Path, PathBuf}, process::{Command, Stdio}, sync::{Arc, Mutex, atomic::{AtomicBool, Ordering}}, time::{Duration, SystemTime, UNIX_EPOCH}};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt;
type Result<T> = std::result::Result<T, String>;
const INVALID: &str = "split_invalid";
const IO: &str = "split_io";
const CANCELLED: &str = "split_cancelled";
#[derive(Clone, Debug)]
struct Media { rate:u32, frames:u64, channels:u16, bits:u16, wav:Option<(Vec<u8>,u64,u16)> }
#[derive(Clone, Serialize)]
pub struct Info { id:String, name:String, rate:u32, frames:u64 }
#[derive(Clone, Deserialize, Debug)]
pub struct Segment { start:u64, end:u64 }
#[derive(Clone, Serialize)]
pub struct Progress { state:String, progress:u32, code:String }
struct Job { info:Info, media:Media, source:PathBuf, signature:(u64,SystemTime), cd_id:String, folder:PathBuf, cancel:AtomicBool, status:Mutex<Progress> }
#[derive(Default)]
pub struct SplitState { job:Mutex<Option<Arc<Job>>> }
fn u16le(b:&[u8])->u16 { u16::from_le_bytes(b[..2].try_into().unwrap()) }
fn u32le(b:&[u8])->u32 { u32::from_le_bytes(b[..4].try_into().unwrap()) }
fn signature(path:&Path)->Result<(u64,SystemTime)> {
    super::audio_location::regular_path(path)?;
    let m=fs::metadata(path).map_err(|_|IO)?;
    if !m.is_file() { return Err(INVALID.into()); }
    Ok((m.len(),m.modified().map_err(|_|IO)?))
}
fn inspect(path:&Path)->Result<Media> {
    let mut file=File::open(path).map_err(|_|IO)?; let size=file.metadata().map_err(|_|IO)?.len();
    let mut header=[0u8;12]; file.read_exact(&mut header).map_err(|_|INVALID)?;
    if &header[..4]==b"fLaC" {
        file.seek(SeekFrom::Start(4)).map_err(|_|IO)?;
        let mut block=[0u8;38]; file.read_exact(&mut block).map_err(|_|INVALID)?;
        if block[0]&127!=0 || block[1..4]!=[0,0,34] { return Err(INVALID.into()); }
        let packed=u64::from_be_bytes(block[14..22].try_into().unwrap());
        let media=Media{rate:(packed>>44) as u32,channels:((packed>>41&7)+1) as u16,bits:((packed>>36&31)+1) as u16,frames:packed&0xfffffffff,wav:None};
        if media.rate==0 || media.frames==0 || media.frames>media.rate as u64*86400 { return Err(INVALID.into()); }
        return Ok(media);
    }
    if (&header[..4]!=b"RIFF" && &header[..4]!=b"RF64") || &header[8..]!=b"WAVE" { return Err(INVALID.into()); }
    let mut at=12u64; let mut fmt=None; let mut data=None; let mut rf_data=None;
    for _ in 0..4096 {
        if at+8>size { break; }
        file.seek(SeekFrom::Start(at)).map_err(|_|IO)?;
        let mut chunk=[0u8;8]; file.read_exact(&mut chunk).map_err(|_|INVALID)?;
        let mut len=u32le(&chunk[4..]) as u64;
        if &chunk[..4]==b"ds64" && len>=28 && len<=65536 {
            let mut bytes=[0u8;28]; file.read_exact(&mut bytes).map_err(|_|INVALID)?;
            rf_data=Some(u64::from_le_bytes(bytes[8..16].try_into().unwrap()));
        }
        if &chunk[..4]==b"data" && len==u32::MAX as u64 { len=rf_data.ok_or(INVALID)?; }
        let end=at.checked_add(8).and_then(|n|n.checked_add(len)).ok_or(INVALID)?;
        if end>size { return Err(INVALID.into()); }
        if &chunk[..4]==b"fmt " {
            if !(16..=4096).contains(&len) { return Err(INVALID.into()); }
            let mut bytes=vec![0;len as usize]; file.read_exact(&mut bytes).map_err(|_|INVALID)?; fmt=Some(bytes);
        }
        if &chunk[..4]==b"data" { if data.is_some() { return Err(INVALID.into()); } data=Some((at+8,len)); }
        at=end.checked_add(len&1).ok_or(INVALID)?;
    }
    let fmt=fmt.ok_or(INVALID)?; let (offset,len)=data.ok_or(INVALID)?;
    let mut code=u16le(&fmt); let channels=u16le(&fmt[2..]); let rate=u32le(&fmt[4..]); let align=u16le(&fmt[12..]); let bits=u16le(&fmt[14..]);
    if code==0xfffe {
        if fmt.len()<40 || u16le(&fmt[16..])<22 || fmt[26..40]!=[0,0,0,0,16,0,128,0,0,170,0,56,155,113] { return Err(INVALID.into()); }
        code=u16le(&fmt[24..]);
    }
    if ![1,3].contains(&code) || channels==0 || channels>32 || rate==0 || rate>768000 || ![8,16,24,32,64].contains(&bits) || (code==1 && bits==64) || (code==3 && ![32,64].contains(&bits)) || align!=channels*(bits/8) || len==0 || len%align as u64!=0 { return Err(INVALID.into()); }
    let frames=len/align as u64;
    if frames>rate as u64*86400 { return Err(INVALID.into()); }
    Ok(Media{rate,frames,channels,bits,wav:Some((fmt,offset,align))})
}
fn validate(media:&Media,parts:&[Segment])->Result<()> {
    if parts.is_empty() || parts.len()>5000 { return Err(INVALID.into()); }
    let min=(media.rate as u64+9)/10;
    let mut last=0;
    for p in parts { if p.start<last || p.end>media.frames || p.start>=p.end || (p.end-p.start<min && !(p.start==0 && p.end==media.frames)) { return Err(INVALID.into()); } last=p.end; }
    Ok(())
}
fn check(job:&Job)->Result<()> { if job.cancel.load(Ordering::SeqCst) { Err(CANCELLED.into()) } else { Ok(()) } }
fn progress(job:&Job,done:u64,total:u64) { job.status.lock().unwrap().progress=(done*100/total.max(1)).min(99) as u32; }
fn wav_cut(job:&Job,part:&Segment,target:&Path,done:u64,total:u64)->Result<()> {
    let (fmt,offset,align)=job.media.wav.as_ref().ok_or(INVALID)?;
    let bytes=(part.end-part.start)* *align as u64;
    let fmt_pad=fmt.len() as u64+(fmt.len() as u64&1);
    let riff=4+8+fmt_pad+8+bytes+(bytes&1); let rf64=riff>u32::MAX as u64;
    let mut out=OpenOptions::new().write(true).create_new(true).open(target).map_err(|_|IO)?;
    out.write_all(if rf64 {b"RF64"} else {b"RIFF"}).map_err(|_|IO)?;
    out.write_all(&(if rf64 {u32::MAX} else {riff as u32}).to_le_bytes()).map_err(|_|IO)?;
    out.write_all(b"WAVE").map_err(|_|IO)?;
    if rf64 {
        out.write_all(b"ds64").map_err(|_|IO)?; out.write_all(&28u32.to_le_bytes()).map_err(|_|IO)?;
        out.write_all(&(riff+36).to_le_bytes()).map_err(|_|IO)?; out.write_all(&bytes.to_le_bytes()).map_err(|_|IO)?;
        out.write_all(&(part.end-part.start).to_le_bytes()).map_err(|_|IO)?; out.write_all(&0u32.to_le_bytes()).map_err(|_|IO)?;
    }
    out.write_all(b"fmt ").map_err(|_|IO)?; out.write_all(&(fmt.len() as u32).to_le_bytes()).map_err(|_|IO)?; out.write_all(fmt).map_err(|_|IO)?;
    if fmt.len()%2!=0 { out.write_all(&[0]).map_err(|_|IO)?; }
    out.write_all(b"data").map_err(|_|IO)?; out.write_all(&(if rf64 {u32::MAX} else {bytes as u32}).to_le_bytes()).map_err(|_|IO)?;
    let mut input=File::open(&job.source).map_err(|_|IO)?; input.seek(SeekFrom::Start(offset+part.start* *align as u64)).map_err(|_|IO)?;
    let mut remaining=bytes; let mut buffer=[0;65536];
    while remaining>0 { check(job)?; let n=(remaining.min(buffer.len() as u64)) as usize; input.read_exact(&mut buffer[..n]).map_err(|_|IO)?; out.write_all(&buffer[..n]).map_err(|_|IO)?; remaining-=n as u64; progress(job,done+(bytes-remaining)/ *align as u64,total); }
    if bytes%2!=0 { out.write_all(&[0]).map_err(|_|IO)?; }
    out.sync_all().map_err(|_|IO.into())
}
fn hidden(cmd:&mut Command) { #[cfg(windows)] { use std::os::windows::process::CommandExt; cmd.creation_flags(0x08000000); } #[cfg(not(windows))] let _=cmd; }
fn flac_cut(job:&Job,part:&Segment,target:&Path,encoder:&Path,done:u64,total:u64)->Result<()> {
    // Native FLAC re-encoding seeks to the retained samples; discarded ranges are never output.
    let mut cmd=Command::new(encoder);
    cmd.args(["--silent","--verify","--no-preserve-modtime","--no-padding","-5"])
        .arg(format!("--skip={}",part.start)).arg(format!("--until={}",part.end))
        .arg("-o").arg(target).arg("--").arg(&job.source).stdout(Stdio::null()).stderr(Stdio::null()); hidden(&mut cmd);
    let mut child=cmd.spawn().map_err(|_|"split_encoder")?;
    let started=std::time::Instant::now();
    loop {
        if check(job).is_err() || started.elapsed()>Duration::from_secs(7200) { let _=child.kill(); let _=child.wait(); return Err(if job.cancel.load(Ordering::SeqCst) {CANCELLED} else {"split_encoder"}.into()); }
        match child.try_wait() { Ok(Some(exit))=>return if exit.success() {Ok(())} else {Err("split_encoder".into())}, Ok(None)=>{}, Err(_)=>{let _=child.kill();let _=child.wait();return Err("split_encoder".into());} }
        let written=fs::metadata(target).map(|m|m.len()).unwrap_or(0);
        let pcm=(part.end-part.start)*job.media.channels as u64*((job.media.bits as u64+7)/8);
        progress(job,done+(part.end-part.start)*written.min(pcm)/pcm.max(1),total);
        std::thread::sleep(Duration::from_millis(50));
    }
}
fn run_job(job:&Job,parts:&[Segment],encoder:&Path)->Result<()> {
    if signature(&job.source)?!=job.signature { return Err("split_changed".into()); }
    fs::create_dir(&job.folder).map_err(|_|IO)?;
    let total=parts.iter().map(|p|p.end-p.start).sum(); let mut done=0;
    for (i,part) in parts.iter().enumerate() {
        check(job)?;
        let ext=if job.media.wav.is_some() {"wav"} else {"flac"}; let target=job.folder.join(format!("part-{:04}.{ext}",i+1));
        if job.media.wav.is_some() { wav_cut(job,part,&target,done,total)?; } else { flac_cut(job,part,&target,encoder,done,total)?; }
        let actual=inspect(&target)?;
        if actual.frames!=part.end-part.start || actual.rate!=job.media.rate || actual.channels!=job.media.channels || actual.bits!=job.media.bits { return Err("split_encoder".into()); }
        done+=part.end-part.start; progress(job,done,total);
    }
    check(job)?;
    if signature(&job.source)?!=job.signature { return Err("split_changed".into()); }
    Ok(())
}
fn find(state:&SplitState,id:&str)->Result<Arc<Job>> { state.job.lock().unwrap().as_ref().filter(|j|j.info.id==id).cloned().ok_or_else(||INVALID.into()) }
fn cleanup(job:&Job) { let _=fs::remove_dir_all(&job.folder); }
pub fn recover(app:&AppHandle)->Result<()> {
    let root=super::data_dir(app)?.join("audio-splits"); super::audio_location::regular_path(&root)?;
    fs::create_dir_all(&root).map_err(|_|IO)?;
    let data=super::data_dir(app)?;let (references,safe)=super::cd_drive::collection_references(&data);let audio=super::audio_root(app)?;
    for entry in fs::read_dir(&root).map_err(|_|IO)?.flatten() {
        let name=entry.file_name().to_string_lossy().to_string();let parts=name.split('-').collect::<Vec<_>>();
        if parts.len()!=3 || parts[0]!="split" {continue;}
        super::audio_location::regular_path(&entry.path())?;
        if let Ok(pid)=parts[1].parse::<u32>() { if !super::cd_drive::process_alive(pid) {super::cd_drive::reap_folder(&entry.path(),&audio,&references,safe);} }
    }
    Ok(())
}
#[tauri::command]
pub async fn prepare_audio_split(app:AppHandle,state:State<'_,SplitState>,cd_id:String)->Result<Option<Info>> {
    super::check_cd_id(&cd_id)?;
    { let slot=state.job.lock().unwrap(); if let Some(job)=slot.as_ref() { if ["editing","writing","done"].contains(&job.status.lock().unwrap().state.as_str()) { return Err("split_busy".into()); } } }
    let Some(chosen)=app.dialog().file().add_filter("WAV / FLAC", &["wav","flac"]).blocking_pick_file() else { return Ok(None); };
    let source=chosen.into_path().map_err(|_|INVALID)?;
    let (media,sig)=tauri::async_runtime::spawn_blocking({let source=source.clone();move||Ok::<_,String>((inspect(&source)?,signature(&source)?))}).await.map_err(|_|IO)??;
    let id=format!("split-{}-{:x}",std::process::id(),SystemTime::now().duration_since(UNIX_EPOCH).map_err(|_|IO)?.as_nanos());
    let info=Info{id:id.clone(),name:source.file_name().unwrap_or_default().to_string_lossy().into_owned(),rate:media.rate,frames:media.frames};
    let folder=super::data_dir(&app)?.join("audio-splits").join(&id);
    let job=Arc::new(Job{info:info.clone(),media,source,signature:sig,cd_id,folder,cancel:AtomicBool::new(false),status:Mutex::new(Progress{state:"editing".into(),progress:0,code:String::new()})});
    let mut slot=state.job.lock().unwrap();
    if let Some(old)=slot.as_ref() { if ["editing","writing","done"].contains(&old.status.lock().unwrap().state.as_str()) { return Err("split_busy".into()); } }
    *slot=Some(job); Ok(Some(info))
}
#[tauri::command]
pub async fn start_audio_split(app:AppHandle,state:State<'_,SplitState>,id:String,segments:Vec<Segment>)->Result<()> {
    let job=find(&state,&id)?; validate(&job.media,&segments)?;
    let encoder=app.path().resource_dir().map_err(|_|"split_encoder")?.join("flac/flac.exe");
    { let mut s=job.status.lock().unwrap(); if !["editing","error","done"].contains(&s.state.as_str()) { return Err("split_busy".into()); } s.state="writing".into(); s.code.clear(); s.progress=0; }
    cleanup(&job); job.cancel.store(false,Ordering::SeqCst);
    std::thread::spawn(move|| {
        let result=(|| { let _guard=super::AUDIO_IO.try_lock().map_err(|_|"split_busy")?;run_job(&job,&segments,&encoder) })();
        let mut s=job.status.lock().unwrap();
        match result { Ok(())=>{s.state="done".into();s.progress=100;}, Err(code)=>{s.state=if code==CANCELLED {"cancelled"} else {"error"}.into();s.code=code;cleanup(&job);} }
    }); Ok(())
}
#[tauri::command]
pub async fn audio_split_status(state:State<'_,SplitState>,id:String)->Result<Progress> { Ok(find(&state,&id)?.status.lock().unwrap().clone()) }
#[tauri::command]
pub async fn cancel_audio_split(state:State<'_,SplitState>,id:String)->Result<()> {
    let job=find(&state,&id)?; job.cancel.store(true,Ordering::SeqCst);
    tauri::async_runtime::spawn_blocking(move|| {
        loop { let mut s=job.status.lock().unwrap(); if s.state!="writing" { if s.state!="adopted" {cleanup(&job);s.state="cancelled".into();} return Ok(()); } drop(s); std::thread::sleep(Duration::from_millis(25)); }
    }).await.map_err(|_|IO)?
}
#[tauri::command]
pub async fn adopt_audio_split(app:AppHandle,state:State<'_,SplitState>,id:String)->Result<Vec<super::AudioFile>> {
    let job=find(&state,&id)?;
    tauri::async_runtime::spawn_blocking(move|| {
        let _guard=super::AUDIO_IO.try_lock().map_err(|_|"split_busy")?;
        let mut s=job.status.lock().unwrap(); if s.state!="done" || job.cancel.load(Ordering::SeqCst) {return Err(INVALID.into());}
        let mut files=fs::read_dir(&job.folder).map_err(|_|IO)?.map(|e|e.map(|e|e.path()).map_err(|_|IO.to_string())).collect::<Result<Vec<_>>>()?;
        files.retain(|p|p.extension().map(|e|e=="wav"||e=="flac").unwrap_or(false));files.sort();
        let stem=Path::new(&job.info.name).file_stem().unwrap_or_default().to_string_lossy();
        let paths=files.iter().map(|p|format!("{}/{}-{}",job.cd_id,job.info.id,p.file_name().unwrap_or_default().to_string_lossy())).collect::<Vec<_>>();
        super::storage::atomic_write(&job.folder.join("adopted.json"),&serde_json::json!(paths))?;
        let dir=super::audio_item_dir(&app,&job.cd_id)?;fs::create_dir_all(&dir).map_err(|_|IO)?;
        let mut copied=Vec::new();let mut added=Vec::new();
        for (i,path) in files.iter().enumerate() {
            let dest=super::library_path(&app,&paths[i])?;
            if let Err(error)=super::audio_location::copy_file(path,&dest) { for p in copied {let _=fs::remove_file(p);} return Err(error); }
            copied.push(dest.clone());added.push(super::AudioFile{file:paths[i].clone(),name:format!("{} - {:04}.{}",stem,i+1,path.extension().unwrap_or_default().to_string_lossy()),size:fs::metadata(&dest).map_err(|_|IO)?.len()});
        }
        // Retain the small ownership manifest until next startup checks saved data and backups.
        for path in files {let _=fs::remove_file(path);}
        s.state="adopted".into();Ok(added)
    }).await.map_err(|_|IO)?
}
/// Preview only the selected source, in bounded HTTP ranges. No additional asset scope is granted.
pub fn preview(app:&AppHandle,request:tauri::http::Request<Vec<u8>>)->tauri::http::Response<Vec<u8>> {
    let response=(||->Result<_>{
        let state=app.state::<SplitState>(); let job=find(&state,request.uri().path().trim_start_matches('/'))?;
        if !["editing","writing","done","error"].contains(&job.status.lock().unwrap().state.as_str()) || signature(&job.source)?!=job.signature {return Err(INVALID.into());}
        let size=job.signature.0;
        let range=request.headers().get("range").and_then(|v|v.to_str().ok()).unwrap_or("bytes=0-");
        let range=range.strip_prefix("bytes=").ok_or(INVALID)?; if range.contains(',') {return Err(INVALID.into());}
        let (start,end)=range.split_once('-').ok_or(INVALID)?;
        let start=start.parse::<u64>().map_err(|_|INVALID)?;
        let end=if end.is_empty() {size-1} else {end.parse::<u64>().map_err(|_|INVALID)?};
        if start>=size || end<start {return Err(INVALID.into());}
        let end=end.min(size-1).min(start+2*1024*1024-1);
        let mut bytes=vec![0;(end-start+1) as usize]; let mut file=File::open(&job.source).map_err(|_|IO)?;file.seek(SeekFrom::Start(start)).map_err(|_|IO)?;file.read_exact(&mut bytes).map_err(|_|IO)?;
        tauri::http::Response::builder().status(206).header("Access-Control-Allow-Origin","*").header("Accept-Ranges","bytes")
            .header("Content-Range",format!("bytes {start}-{end}/{size}")).header("Content-Length",bytes.len())
            .header("Content-Type",if job.media.wav.is_some() {"audio/wav"} else {"audio/flac"}).body(bytes).map_err(|_|IO.into())
    })();
    response.unwrap_or_else(|_|tauri::http::Response::builder().status(416).body(Vec::new()).unwrap())
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Fixture(PathBuf);
    impl Fixture {
        fn new()->Self { let path=std::env::temp_dir().join(format!("pmco-split-test-{:x}",SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()));fs::create_dir_all(&path).unwrap();Self(path) }
        fn source(&self)->(PathBuf,Vec<u8>) {
            let pcm=(0..24000i16).flat_map(|n|n.to_le_bytes()).collect::<Vec<_>>();
            let mut bytes=Vec::new();bytes.extend(b"RIFF");bytes.extend((pcm.len() as u32+36).to_le_bytes());bytes.extend(b"WAVEfmt ");bytes.extend(16u32.to_le_bytes());bytes.extend(1u16.to_le_bytes());bytes.extend(1u16.to_le_bytes());bytes.extend(8000u32.to_le_bytes());bytes.extend(16000u32.to_le_bytes());bytes.extend(2u16.to_le_bytes());bytes.extend(16u16.to_le_bytes());bytes.extend(b"data");bytes.extend((pcm.len() as u32).to_le_bytes());bytes.extend(&pcm);
            let path=self.0.join("source.wav");fs::write(&path,bytes).unwrap();(path,pcm)
        }
        fn job(&self,source:PathBuf)->Job { let media=inspect(&source).unwrap();let sig=signature(&source).unwrap();Job{info:Info{id:"test".into(),name:"source.wav".into(),rate:media.rate,frames:media.frames},media,source,signature:sig,cd_id:"fixture".into(),folder:self.0.join("output"),cancel:AtomicBool::new(false),status:Mutex::new(Progress{state:"writing".into(),progress:0,code:String::new()})} }
    }
    impl Drop for Fixture {fn drop(&mut self){let _=fs::remove_dir_all(&self.0);}}
    #[test]
    fn wav_cuts_are_sample_exact_and_skip_gaps_without_changing_source() {
        let f=Fixture::new();let (source,pcm)=f.source();let before=fs::read(&source).unwrap();let job=f.job(source.clone());
        let parts=vec![Segment{start:0,end:8000},Segment{start:16000,end:24000}];validate(&job.media,&parts).unwrap();run_job(&job,&parts,Path::new("unused")).unwrap();
        let files=fs::read_dir(&job.folder).unwrap().collect::<Vec<_>>();assert_eq!(files.len(),2);
        for (i,p) in parts.iter().enumerate(){let path=job.folder.join(format!("part-{:04}.wav",i+1));let media=inspect(&path).unwrap();assert_eq!(media.frames,8000);let bytes=fs::read(path).unwrap();let offset=media.wav.unwrap().1 as usize;assert_eq!(&bytes[offset..],&pcm[p.start as usize*2..p.end as usize*2]);}
        assert_eq!(fs::read(source).unwrap(),before);
    }
    #[test]
    fn rejects_overlap_out_of_range_zero_and_sub_minimum_segments() {
        let f=Fixture::new();let(source,_)=f.source();let job=f.job(source);
        for parts in [vec![],vec![Segment{start:0,end:0}],vec![Segment{start:0,end:1}],vec![Segment{start:0,end:24001}],vec![Segment{start:0,end:16000},Segment{start:8000,end:24000}]] {assert!(validate(&job.media,&parts).is_err());}
    }
    #[test]
    fn cancellation_and_changed_sources_never_produce_an_output() {
        let f=Fixture::new();let(source,_)=f.source();let job=f.job(source.clone());job.cancel.store(true,Ordering::SeqCst);let part=Segment{start:0,end:8000};
        fs::create_dir(&job.folder).unwrap();let target=job.folder.join("cancelled.wav");assert_eq!(wav_cut(&job,&part,&target,0,8000).unwrap_err(),CANCELLED);cleanup(&job);assert!(!job.folder.exists());
        fs::write(&source,b"changed").unwrap();assert_eq!(run_job(&job,&[part],Path::new("unused")).unwrap_err(),"split_changed");assert!(!job.folder.exists());
    }
    #[test]
    fn malformed_or_unknown_duration_audio_is_rejected() {
        let f=Fixture::new();let path=f.0.join("bad.wav");for bytes in [b"bad".to_vec(),vec![0;50]] {fs::write(&path,bytes).unwrap();assert!(inspect(&path).is_err());}
        let mut bytes=vec![0;42];bytes[..4].copy_from_slice(b"fLaC");bytes[4]=128;bytes[7]=34;fs::write(&path,bytes).unwrap();assert!(inspect(&path).is_err());
    }
    #[test]
    fn bundled_flac_splits_round_trip_to_exact_retained_samples() {
        let f=Fixture::new();let(source,pcm)=f.source();let encoder=PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/flac/flac.exe");
        if !encoder.is_file() {return;}
        let flac=f.0.join("source.flac");let mut cmd=Command::new(&encoder);cmd.args(["--silent","--verify","-o"]).arg(&flac).arg(&source);hidden(&mut cmd);assert!(cmd.status().unwrap().success());
        let job=f.job(flac.clone());assert_eq!(job.media.frames,24000);let before=fs::read(&flac).unwrap();let parts=[Segment{start:1234,end:9234},Segment{start:15000,end:23999}];run_job(&job,&parts,&encoder).unwrap();
        for(i,p)in parts.iter().enumerate(){let mut cmd=Command::new(&encoder);cmd.args(["--silent","--decode","--stdout","--force-raw-format","--endian=little","--sign=signed"]).arg(job.folder.join(format!("part-{:04}.flac",i+1)));hidden(&mut cmd);let out=cmd.output().unwrap();assert!(out.status.success());assert_eq!(out.stdout,pcm[p.start as usize*2..p.end as usize*2]);}
        assert_eq!(fs::read(flac).unwrap(),before);
    }
    #[test]
    fn long_wav_seeks_to_retained_tail_and_rejects_oversized_rf64_chunks() {
        let f=Fixture::new();let(source,_)=f.source();let frames=8000u32*7200;let bytes=frames*2;
        let mut file=OpenOptions::new().write(true).open(&source).unwrap();file.set_len(bytes as u64+44).unwrap();file.seek(SeekFrom::Start(4)).unwrap();file.write_all(&(bytes+36).to_le_bytes()).unwrap();file.seek(SeekFrom::Start(40)).unwrap();file.write_all(&bytes.to_le_bytes()).unwrap();drop(file);
        let job=f.job(source);assert_eq!(job.media.frames,frames as u64);fs::create_dir(&job.folder).unwrap();let target=job.folder.join("tail.wav");wav_cut(&job,&Segment{start:frames as u64-801,end:frames as u64},&target,0,801).unwrap();assert_eq!(inspect(&target).unwrap().frames,801);assert!(fs::metadata(target).unwrap().len()<2000);
        let mut bad=Vec::new();bad.extend(b"RF64");bad.extend(u32::MAX.to_le_bytes());bad.extend(b"WAVEds64");bad.extend(28u32.to_le_bytes());bad.extend([0;8]);bad.extend(u64::MAX.to_le_bytes());bad.extend([0;12]);bad.extend(b"data");bad.extend(u32::MAX.to_le_bytes());let path=f.0.join("bad-rf64.wav");fs::write(&path,bad).unwrap();assert!(inspect(&path).is_err());
    }
    #[test]
    fn crash_recovery_keeps_referenced_split_files_and_only_reaps_owned_drafts() {
        let f=Fixture::new();let folder=f.0.join("split-0-test");let audio=f.0.join("audio");fs::create_dir_all(audio.join("disc")).unwrap();fs::create_dir(&folder).unwrap();
        let saved="disc/split-0-test-part-0001.wav";let draft="disc/split-0-test-part-0002.wav";let foreign="disc/unrelated.wav";
        for file in [saved,draft,foreign] {fs::write(audio.join(file),b"fixture").unwrap();}
        fs::write(folder.join("adopted.json"),serde_json::to_vec(&vec![saved,draft,foreign]).unwrap()).unwrap();
        assert!(!super::super::cd_drive::reap_folder(&folder,&audio,"",false));assert!(audio.join(draft).exists());
        assert!(super::super::cd_drive::reap_folder(&folder,&audio,saved,true));assert!(audio.join(saved).exists());assert!(!audio.join(draft).exists());assert!(audio.join(foreign).exists());assert!(!folder.exists());
    }
}
