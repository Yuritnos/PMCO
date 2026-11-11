//! Windows audio-CD import. Device input is limited to enumerated drive letters.
//! Jobs stage under app data; only adoption into an editor creates library files.
use std::{fs::{self, File, OpenOptions}, io::{Read, Write}, path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, Stdio}, sync::{Arc, Mutex, atomic::{AtomicBool, AtomicU32, Ordering}},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH}};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha1::{Digest, Sha1};
use tauri::{AppHandle, Manager, State};

const SECTOR_BYTES: usize = 2352;
const CHUNK: u32 = 16;
const RESERVE: u64 = 64 * 1024 * 1024;
type Result<T> = std::result::Result<T, String>;
fn fail(code: &str) -> String { code.into() }
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscTrack { pub number: u32, pub start_sector: u32, pub sectors: u32, pub duration: String }
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Disc { pub drive_id: String, pub fingerprint: String, pub tracks: Vec<DiscTrack> }
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress { id: String, state: String, track: u32, tracks: u32, progress: u32, code: String }
struct Job { id: String, folder: PathBuf, cancel: AtomicBool, thread: AtomicU32, status: Mutex<Progress> }
#[derive(Default)]
pub struct DriveState { job: Mutex<Option<Arc<Job>>> }
#[derive(Serialize)]
pub struct ImportedTrack { file: String, name: String, size: u64, track: u32 }

fn make_disc(drive: String, starts: &[u32], leadout: u32) -> Result<Disc> {
    if starts.is_empty() || starts.len() > 99 || leadout > 100 * 60 * 75 || starts[0] > leadout ||
        starts.windows(2).any(|p| p[0] >= p[1]) || *starts.last().unwrap() >= leadout { return Err(fail("drive_disc")); }
    let toc = format!("1 {} {} {}", starts.len(), leadout + 150, starts.iter().map(|n| (n+150).to_string()).collect::<Vec<_>>().join(" "));
    let fingerprint = format!("{:x}", Sha1::digest(toc.as_bytes()));
    let tracks = starts.iter().enumerate().map(|(i, start)| {
        let sectors = starts.get(i+1).copied().unwrap_or(leadout) - start;
        let seconds = (sectors + 37) / 75;
        DiscTrack { number: (i+1) as u32, start_sector: *start, sectors, duration: format!("{}:{:02}", seconds/60, seconds%60) }
    }).collect();
    Ok(Disc { drive_id: drive, fingerprint, tracks })
}
fn parse_toc(drive: String, bytes: &[u8]) -> Result<Disc> {
    if bytes.len() < 12 || bytes[2] != 1 || !(1..=99).contains(&bytes[3]) { return Err(fail("drive_disc")); }
    let count = bytes[3] as usize;
    let length = u16::from_be_bytes([bytes[0], bytes[1]]) as usize + 2;
    if length > bytes.len() || length < 4 + (count+1)*8 { return Err(fail("drive_disc")); }
    let mut sectors = Vec::new();
    for i in 0..=count {
        let track = &bytes[4+i*8..12+i*8];
        if i < count && (track[1]&4 != 0 || track[2] as usize != i+1) { return Err(fail("drive_data")); }
        if i < count && track[1]&9 != 0 { return Err(fail("drive_disc_feature")); }
        if i == count && track[2] != 0xaa { return Err(fail("drive_disc")); }
        if track[6] >= 60 || track[7] >= 75 { return Err(fail("drive_disc")); }
        let msf = (track[5] as u32*60 + track[6] as u32)*75 + track[7] as u32;
        sectors.push(msf.checked_sub(150).ok_or_else(|| fail("drive_disc"))?);
    }
    make_disc(drive, &sectors[..count], sectors[count])
}
trait SectorReader { fn verify(&mut self) -> Result<()>; fn read(&mut self, sector: u32, count: u32, out: &mut [u8]) -> Result<usize>; }
#[repr(align(4096))]
struct Buffer([u8; SECTOR_BYTES * CHUNK as usize]);
fn extract<R: SectorReader, W: Write>(reader: &mut R, track: &DiscTrack, writer: &mut W, cancelled: &AtomicBool, mut progress: impl FnMut(u32)) -> Result<()> {
    let mut buffer = Buffer([0; SECTOR_BYTES * CHUNK as usize]);
    let mut at = 0;
    while at < track.sectors {
        if cancelled.load(Ordering::SeqCst) { return Err(fail("drive_cancelled")); }
        reader.verify()?;
        let count = CHUNK.min(track.sectors-at); let len = count as usize * SECTOR_BYTES;
        let mut success = false;
        for _ in 0..3 {
            if cancelled.load(Ordering::SeqCst) { return Err(fail("drive_cancelled")); }
            if matches!(reader.read(track.start_sector+at, count, &mut buffer.0[..len]), Ok(n) if n==len) { success=true; break; }
            reader.verify()?;
        }
        if !success { return Err(fail("drive_read")); }
        writer.write_all(&buffer.0[..len]).map_err(|_| fail("drive_write"))?;
        at += count; progress(at);
    }
    reader.verify()?;
    if cancelled.load(Ordering::SeqCst) { return Err(fail("drive_cancelled")); }
    Ok(())
}
fn wav_header(bytes: u32) -> Vec<u8> {
    let mut h=Vec::with_capacity(44); h.extend(b"RIFF"); h.extend((bytes+36).to_le_bytes()); h.extend(b"WAVEfmt ");
    h.extend(16u32.to_le_bytes()); h.extend(1u16.to_le_bytes()); h.extend(2u16.to_le_bytes());
    h.extend(44100u32.to_le_bytes()); h.extend(176400u32.to_le_bytes()); h.extend(4u16.to_le_bytes()); h.extend(16u16.to_le_bytes());
    h.extend(b"data"); h.extend(bytes.to_le_bytes()); h
}
enum Sink { Wav(File), Flac { process: Child, input: Option<ChildStdin> } }
fn hidden(cmd: &mut Command) {
    #[cfg(windows)] { use std::os::windows::process::CommandExt; cmd.creation_flags(0x08000000); }
    #[cfg(not(windows))] let _ = cmd;
}
impl Sink {
    fn new(path: &Path, format: &str, encoder: &Path, sectors: u32) -> Result<Self> {
        if format=="wav" {
            let mut file=OpenOptions::new().write(true).create_new(true).open(path).map_err(|_| fail("drive_write"))?;
            file.write_all(&wav_header(sectors*SECTOR_BYTES as u32)).map_err(|_| fail("drive_write"))?; return Ok(Self::Wav(file));
        }
        if !encoder.is_file() { return Err(fail("drive_encoder")); }
        let mut cmd=Command::new(encoder);
        cmd.args(["--silent","--verify","-5","--force-raw-format","--endian=little","--sign=signed","--channels=2","--bps=16","--sample-rate=44100","--no-padding","-o"])
            .arg(path).arg("-").stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::null()); hidden(&mut cmd);
        let mut process=cmd.spawn().map_err(|_| fail("drive_encoder"))?; let input=process.stdin.take();
        Ok(Self::Flac { process, input })
    }
    fn finish(&mut self, cancelled: &AtomicBool) -> Result<()> {
        match self {
            Self::Wav(f) => f.sync_all().map_err(|_| fail("drive_write")),
            Self::Flac{process,input} => {
                input.take(); let start=Instant::now();
                loop {
                    if cancelled.load(Ordering::SeqCst) || start.elapsed()>Duration::from_secs(60) { let _=process.kill(); let _=process.wait(); return Err(fail(if cancelled.load(Ordering::SeqCst){"drive_cancelled"}else{"drive_encoder"})); }
                    match process.try_wait().map_err(|_| fail("drive_encoder"))? {
                        Some(exit) => return if exit.success(){Ok(())}else{Err(fail("drive_encoder"))}, None=>std::thread::sleep(Duration::from_millis(50))
                    }
                }
            }
        }
    }
}
impl Write for Sink {
    fn write(&mut self, b: &[u8]) -> std::io::Result<usize> { match self {Self::Wav(f)=>f.write(b),Self::Flac{input,..}=>input.as_mut().ok_or_else(||std::io::Error::from(std::io::ErrorKind::BrokenPipe))?.write(b)} }
    fn flush(&mut self)->std::io::Result<()> { match self {Self::Wav(f)=>f.flush(),Self::Flac{input,..}=>input.as_mut().ok_or_else(||std::io::Error::from(std::io::ErrorKind::BrokenPipe))?.flush()} }
}
impl Drop for Sink { fn drop(&mut self) { if let Self::Flac{process,..}=self { let _=process.kill(); let _=process.wait(); } } }

#[cfg(windows)]
mod platform {
    use super::*; use std::ffi::c_void;
    #[link(name="kernel32")]
    extern "system" {
        fn GetLogicalDrives()->u32; fn GetDriveTypeW(root:*const u16)->u32;
        fn CreateFileW(name:*const u16,access:u32,share:u32,security:*const c_void,creation:u32,flags:u32,template:isize)->isize;
        fn CloseHandle(handle:isize)->i32;
        fn DeviceIoControl(h:isize,code:u32,input:*const c_void,input_size:u32,output:*mut c_void,output_size:u32,returned:*mut u32,overlapped:*mut c_void)->i32;
        fn GetDiskFreeSpaceExW(dir:*const u16,available:*mut u64,total:*mut u64,free:*mut u64)->i32;
        fn OpenProcess(access:u32,inherit:i32,pid:u32)->isize; fn GetExitCodeProcess(h:isize,code:*mut u32)->i32;
        fn GetLastError()->u32; fn GetCurrentThreadId()->u32;
        fn OpenThread(access:u32,inherit:i32,thread:u32)->isize; fn CancelSynchronousIo(thread:isize)->i32;
    }
    fn wide(s:&str)->Vec<u16>{s.encode_utf16().chain(Some(0)).collect()}
    pub fn drives()->Vec<String>{let mask=unsafe{GetLogicalDrives()};(0..26).filter(|i|mask&(1<<i)!=0).filter_map(|i|{let id=format!("{}:",(b'A'+i as u8) as char);if unsafe{GetDriveTypeW(wide(&format!("{id}\\")).as_ptr())}==5{Some(id)}else{None}}).collect()}
    pub struct Device {handle:isize,drive:String,expected:String,counter:Option<u32>,checks:u32,locked:bool}
    impl Drop for Device { fn drop(&mut self){if self.locked{let _=self.ioctl(0x2d4804,&[0],&mut[]);}unsafe{CloseHandle(self.handle);}} }
    impl Device {
        pub fn open(id:&str)->Result<Self>{
            if id.len()!=2 || id.as_bytes()[1]!=b':' || !id.as_bytes()[0].is_ascii_uppercase() || !drives().iter().any(|d|d==id){return Err(fail("drive_missing"));}
            let h=unsafe{CreateFileW(wide(&format!("\\\\.\\{id}")).as_ptr(),0x80000000,3,std::ptr::null(),3,0,0)};
            if h == -1 {return Err(fail("drive_access"));} Ok(Self{handle:h,drive:id.into(),expected:String::new(),counter:None,checks:0,locked:false})
        }
        fn ioctl(&self,code:u32,input:&[u8],output:&mut[u8])->Result<usize>{let mut n=0;let ok=unsafe{DeviceIoControl(self.handle,code,input.as_ptr().cast(),input.len() as u32,output.as_mut_ptr().cast(),output.len() as u32,&mut n,std::ptr::null_mut())};if ok==0{Err(fail("drive_read"))}else{Ok(n as usize)}}
        pub fn disc(&self)->Result<Disc>{let mut b=[0u8;804];let n=self.ioctl(0x24000,&[],&mut b).map_err(|_|fail("drive_empty"))?;parse_toc(self.drive.clone(),&b[..n.min(b.len())])}
        fn media_counter(&self)->Result<Option<u32>> {let mut b=[0;4]; match self.ioctl(0x2d0800,&[],&mut b){Ok(4)=>Ok(Some(u32::from_le_bytes(b))),Ok(_)=>Ok(None),Err(_)=>{self.disc()?;Ok(None)}}}
        pub fn prepare(&mut self,fingerprint:&str)->Result<Disc>{
            let before=self.media_counter()?;
            self.locked=self.ioctl(0x2d4804,&[1],&mut[]).is_ok();
            let disc=self.disc()?;self.counter=self.media_counter()?;
            if disc.fingerprint!=fingerprint || (before.is_some()&&before!=self.counter){return Err(fail("drive_changed"));}
            // Without either a removal lock or a change counter a same-layout
            // replacement cannot be distinguished safely during extraction.
            if !self.locked&&self.counter.is_none(){return Err(fail("drive_access"));}
            self.expected=fingerprint.into();Ok(disc)
        }
    }
    impl SectorReader for Device {
        fn verify(&mut self)->Result<()> {self.checks+=1;let count=self.media_counter().map_err(|_|fail("drive_changed"))?;if self.counter.is_some()&&count!=self.counter{return Err(fail("drive_changed"));}if self.counter.is_none()||self.checks%64==0{if self.disc()?.fingerprint!=self.expected{return Err(fail("drive_changed"));}}Ok(())}
        fn read(&mut self,sector:u32,count:u32,out:&mut[u8])->Result<usize>{
            // RAW_READ_INFO is LARGE_INTEGER + ULONG + TRACK_MODE_TYPE(CDDA=2).
            // DiskOffset addresses 2048-byte logical sectors, output is 2352-byte PCM.
            let mut input=Vec::new();input.extend((sector as i64*2048).to_le_bytes());input.extend(count.to_le_bytes());input.extend(2u32.to_le_bytes());
            self.ioctl(0x2403e,&input,out)
        }
    }
    pub fn space(path:&Path)->Result<u64>{let mut available=0;let ok=unsafe{GetDiskFreeSpaceExW(wide(&path.to_string_lossy()).as_ptr(),&mut available,std::ptr::null_mut(),std::ptr::null_mut())};if ok==0{Err(fail("drive_space"))}else{Ok(available)}}
    pub fn alive(pid:u32)->bool{let h=unsafe{OpenProcess(0x1000,0,pid)};if h==0{return unsafe{GetLastError()}!=87;}let mut code=0;let ok=unsafe{GetExitCodeProcess(h,&mut code)};unsafe{CloseHandle(h);}ok==0||code==259}
    pub fn thread_id()->u32{unsafe{GetCurrentThreadId()}}
    pub fn cancel_thread(id:u32){if id==0{return;}let h=unsafe{OpenThread(1,0,id)};if h!=0{unsafe{CancelSynchronousIo(h);CloseHandle(h);}}}
}
#[cfg(not(windows))]
mod platform {
    use super::*;
    pub fn drives()->Vec<String>{Vec::new()}
    pub struct Device;
    impl Device {pub fn open(_: &str)->Result<Self>{Err(fail("drive_windows"))} pub fn disc(&self)->Result<Disc>{Err(fail("drive_windows"))} pub fn prepare(&mut self,_:&str)->Result<Disc>{Err(fail("drive_windows"))}}
    impl SectorReader for Device {fn verify(&mut self)->Result<()>{Err(fail("drive_windows"))}fn read(&mut self,_:u32,_:u32,_:&mut[u8])->Result<usize>{Err(fail("drive_windows"))}}
    pub fn space(_: &Path)->Result<u64>{Err(fail("drive_windows"))} pub fn alive(_:u32)->bool{false}
    pub fn thread_id()->u32{0} pub fn cancel_thread(_:u32){}
}

fn root(app:&AppHandle)->Result<PathBuf>{let dir=super::data_dir(app)?.join("cd-imports");fs::create_dir_all(&dir).map_err(|_|fail("drive_write"))?;Ok(dir)}
fn cleanup_folder(path:&Path){if path.file_name().and_then(|p|p.to_str()).map(|p|p.starts_with("rip-")||p.starts_with("split-")).unwrap_or(false)&&!path.is_symlink(){let _=fs::remove_dir_all(path);}}
fn owned_file(job:&str,file:&str)->bool {
    let parts=file.split('/').collect::<Vec<_>>();
    parts.len()==2 && super::check_cd_id(parts[0]).is_ok() && parts[1].starts_with(&format!("{job}-{}-",if job.starts_with("split-"){ "part" }else{ "track" })) &&
        !parts[1].contains(['\\','/']) && (parts[1].ends_with(".wav")||parts[1].ends_with(".flac"))
}
pub(crate) fn collection_references(data:&Path)->(String,bool) {
    let mut text=String::new();let mut safe=true;
    let mut paths=vec![data.join(super::DATA_FILE),data.join(super::BACKUP_FILE)];
    match super::preserved_collections(data) { Ok(preserved)=>paths.extend(preserved),Err(_)=>safe=false }
    match fs::read_dir(data.join(super::BACKUPS_DIR)) {
        Ok(entries)=>for entry in entries {match entry{Ok(e)=>{if super::is_daily_backup_name(&e.file_name().to_string_lossy()){paths.push(e.path());}},Err(_)=>safe=false}},
        Err(e)=>if e.kind()!=std::io::ErrorKind::NotFound{safe=false;}
    }
    for path in paths {match fs::read_to_string(path){
        Ok(value)=>{if serde_json::from_str::<Value>(&value).is_err(){safe=false;}text.push_str(&value);},
        Err(e)=>if e.kind()!=std::io::ErrorKind::NotFound{safe=false;}
    }} (text,safe)
}
pub(crate) fn reap_folder(folder:&Path,audio:&Path,references:&str,can_clean:bool)->bool {
    let name=folder.file_name().unwrap_or_default().to_string_lossy();
    let manifest=folder.join("adopted.json");
    if manifest.exists(){
        if !can_clean{return false;}
        let Some(files)=fs::read(&manifest).ok().and_then(|b|serde_json::from_slice::<Vec<String>>(&b).ok()) else{return false;};
        let Ok(root)=audio.canonicalize() else{return false;};
        for file in files {
            if !owned_file(&name,&file)||references.contains(&file){continue;}
            let path=audio.join(&file);
            if path.is_symlink(){return false;}
            if !path.parent().and_then(|p|p.canonicalize().ok()).map(|p|p.starts_with(&root)).unwrap_or(false){continue;}
            if let Err(e)=fs::remove_file(path){if e.kind()!=std::io::ErrorKind::NotFound{return false;}}
        }
    }
    cleanup_folder(folder);true
}
/// Reap only inactive importer-owned jobs. A manifest keeps adopted files safe
/// across a crash; current data AND backups are consulted before draft cleanup.
pub fn recover(app:&AppHandle)->Result<()> {
    let base=root(app)?;let data=super::data_dir(app)?;
    let (references,can_clean)=collection_references(&data);let audio=super::audio_root(app)?;
    for entry in fs::read_dir(&base).map_err(|_|fail("drive_write"))?.flatten(){
        let name=entry.file_name().to_string_lossy().to_string();let parts=name.split('-').collect::<Vec<_>>();
        if parts.len()!=3||parts[0]!="rip"||entry.path().is_symlink(){continue;}
        let Some(pid)=parts[1].parse::<u32>().ok() else {continue};if platform::alive(pid){continue;}
        reap_folder(&entry.path(),&audio,&references,can_clean);
    } Ok(())
}
pub(crate) fn process_alive(pid:u32)->bool { platform::alive(pid) }
fn run_job(job:&Arc<Job>,drive:&str,fingerprint:&str,format:&str,encoder:&Path)->Result<()> {
    let _audio_guard=super::AUDIO_IO.try_lock().map_err(|_|fail("drive_busy"))?;
    let mut device=platform::Device::open(drive)?;let disc=device.prepare(fingerprint)?;
    let total:u32=disc.tracks.iter().map(|t|t.sectors).sum();
    if platform::space(&job.folder)? < total as u64*SECTOR_BYTES as u64 + RESERVE {return Err(fail("drive_space"));}
    let mut done=0;
    for track in &disc.tracks {
        if job.cancel.load(Ordering::SeqCst){return Err(fail("drive_cancelled"));}
        if platform::space(&job.folder)? < track.sectors as u64*SECTOR_BYTES as u64 + RESERVE {return Err(fail("drive_space"));}
        {let mut s=job.status.lock().unwrap();s.track=track.number;s.tracks=disc.tracks.len() as u32;}
        let path=job.folder.join(format!("track-{:02}.{format}",track.number));
        let mut sink=Sink::new(&path,format,encoder,track.sectors)?;
        extract(&mut device,track,&mut sink,&job.cancel,|at|{job.status.lock().unwrap().progress=((done+at) as u64*100/total as u64) as u32;})?;
        sink.finish(&job.cancel)?;done+=track.sectors;
    }
    Ok(())
}
#[tauri::command]
pub async fn list_cd_drives()->Result<Vec<String>> {tauri::async_runtime::spawn_blocking(platform::drives).await.map_err(|_|fail("drive_read"))}
#[tauri::command]
pub async fn read_cd_disc(drive_id:String)->Result<Disc>{tauri::async_runtime::spawn_blocking(move||platform::Device::open(&drive_id)?.disc()).await.map_err(|_|fail("drive_read"))?}
#[tauri::command]
pub async fn start_cd_import(app:AppHandle,state:State<'_,DriveState>,drive_id:String,fingerprint:String,format:String)->Result<String>{
    if !["wav","flac"].contains(&format.as_str())||fingerprint.len()!=40||!fingerprint.bytes().all(|b|b.is_ascii_hexdigit()){return Err(fail("drive_disc"));}
    let mut slot=state.job.lock().unwrap();
    if let Some(old)=slot.as_ref(){if ["copying","done"].contains(&old.status.lock().unwrap().state.as_str()){return Err(fail("drive_busy"));}}
    let id=format!("rip-{}-{:x}",std::process::id(),SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_nanos());
    let folder=root(&app)?.join(&id);fs::create_dir(&folder).map_err(|_|fail("drive_write"))?;
    let job=Arc::new(Job{id:id.clone(),folder,cancel:AtomicBool::new(false),thread:AtomicU32::new(0),status:Mutex::new(Progress{id:id.clone(),state:"copying".into(),track:0,tracks:0,progress:0,code:String::new()})});
    let encoder=app.path().resource_dir().map_err(|_|fail("drive_encoder"))?.join("flac").join("flac.exe");
    *slot=Some(job.clone());
    std::thread::spawn(move||{
        job.thread.store(platform::thread_id(),Ordering::SeqCst);
        let result=run_job(&job,&drive_id,&fingerprint,&format,&encoder);
        job.thread.store(0,Ordering::SeqCst);
        let mut status=job.status.lock().unwrap();
        match result {Ok(()) if !job.cancel.load(Ordering::SeqCst)=>{status.state="done".into();status.progress=100;},other=>{let code=if job.cancel.load(Ordering::SeqCst){fail("drive_cancelled")}else{other.err().unwrap_or_else(||fail("drive_read"))};status.state=if code=="drive_cancelled"{"cancelled"}else{"error"}.into();status.code=code;cleanup_folder(&job.folder);}}
    });Ok(id)
}
fn find_job(state:&DriveState,id:&str)->Result<Arc<Job>>{state.job.lock().unwrap().as_ref().filter(|j|j.id==id).cloned().ok_or_else(||fail("drive_job"))}
#[tauri::command]
pub fn cd_import_status(state:State<'_,DriveState>,job_id:String)->Result<Progress>{let job=find_job(&state,&job_id)?;let status=job.status.lock().unwrap().clone();Ok(status)}
#[tauri::command]
pub fn cancel_cd_import(state:State<'_,DriveState>,job_id:String)->Result<()>{let job=find_job(&state,&job_id)?;job.cancel.store(true,Ordering::SeqCst);platform::cancel_thread(job.thread.load(Ordering::SeqCst));let mut s=job.status.lock().unwrap();if s.state=="done"{s.state="cancelled".into();cleanup_folder(&job.folder);}Ok(())}

#[cfg(test)]
mod tests {
    use super::*;
    struct Mock { reads:Vec<(u32,u32)>, failures:u32, short:bool, changed:bool }
    impl SectorReader for Mock {
        fn verify(&mut self)->Result<()>{if self.changed{Err(fail("drive_changed"))}else{Ok(())}}
        fn read(&mut self,sector:u32,count:u32,out:&mut[u8])->Result<usize>{self.reads.push((sector,count));if self.failures>0{self.failures-=1;return Err(fail("drive_read"));}out.fill(42);Ok(if self.short{out.len()-1}else{out.len()})}
    }
    fn reader()->Mock{Mock{reads:Vec::new(),failures:0,short:false,changed:false}}
    fn track()->DiscTrack{DiscTrack{number:1,start_sector:100,sectors:CHUNK+3,duration:"0:01".into()}}
    #[test] fn physical_layout_fingerprint_and_durations(){let disc=make_disc("D:".into(),&[0,15213,32164,46442,63264,80339],95312).unwrap();assert_eq!(disc.tracks.len(),6);assert_eq!(disc.fingerprint.len(),40);assert_eq!(disc.tracks[0].duration,"3:23");assert_ne!(disc.fingerprint,make_disc("D:".into(),&[0,15213,32164,46442,63264,80339],95313).unwrap().fingerprint);}
    #[test] fn invalid_layouts_are_rejected(){for starts in [vec![],vec![10,10],vec![11,10],vec![100],vec![0;100]]{assert!(make_disc("D:".into(),&starts,100).is_err());}}
    fn toc_bytes()->Vec<u8>{let mut b=vec![0;28];b[1]=26;b[2]=1;b[3]=2;for (i,start) in [0u32,9000,18000].iter().enumerate(){let at=4+i*8;let msf=start+150;b[at+1]=0x10;b[at+2]=if i==2{0xaa}else{(i+1) as u8};b[at+5]=(msf/4500) as u8;b[at+6]=((msf/75)%60) as u8;b[at+7]=(msf%75) as u8;}b}
    #[test] fn windows_msf_toc_has_physical_track_durations(){let d=parse_toc("D:".into(),&toc_bytes()).unwrap();assert_eq!(d.tracks[0].start_sector,0);assert_eq!(d.tracks[0].sectors,9000);assert_eq!(d.tracks[1].duration,"2:00");}
    #[test] fn data_mixed_invalid_and_truncated_toc_are_rejected(){let mut b=toc_bytes();b[5]|=4;assert_eq!(parse_toc("D:".into(),&b).unwrap_err(),"drive_data");assert!(parse_toc("D:".into(),&b[..20]).is_err());b=toc_bytes();b[10]=60;assert!(parse_toc("D:".into(),&b).is_err());}
    #[test] fn bounded_reads_preserve_exact_pcm_and_final_short_chunk(){let mut r=reader();let mut out=Vec::new();extract(&mut r,&track(),&mut out,&AtomicBool::new(false),|_|{}).unwrap();assert_eq!(r.reads,vec![(100,16),(116,3)]);assert_eq!(out.len(),19*SECTOR_BYTES);assert!(out.iter().all(|b|*b==42));}
    #[test] fn transient_failure_retries_same_sectors_without_duplicate_audio(){let mut r=reader();r.failures=2;let mut out=Vec::new();extract(&mut r,&track(),&mut out,&AtomicBool::new(false),|_|{}).unwrap();assert_eq!(r.reads[..3],[(100,16);3]);assert_eq!(out.len(),19*SECTOR_BYTES);}
    #[test] fn short_reads_fail_without_writing_uninitialized_audio(){let mut r=reader();r.short=true;let mut out=Vec::new();assert_eq!(extract(&mut r,&track(),&mut out,&AtomicBool::new(false),|_|{}).unwrap_err(),"drive_read");assert!(out.is_empty());assert_eq!(r.reads.len(),3);}
    #[test] fn cancellation_stops_before_any_device_read(){let mut r=reader();assert_eq!(extract(&mut r,&track(),&mut Vec::new(),&AtomicBool::new(true),|_|{}).unwrap_err(),"drive_cancelled");assert!(r.reads.is_empty());}
    #[test] fn cancellation_during_copy_stops_before_next_chunk(){let mut r=reader();let flag=AtomicBool::new(false);let mut out=Vec::new();assert!(extract(&mut r,&track(),&mut out,&flag,|_|flag.store(true,Ordering::SeqCst)).is_err());assert_eq!(r.reads.len(),1);assert_eq!(out.len(),16*SECTOR_BYTES);}
    #[test] fn disc_change_never_copies_from_replacement_media(){let mut r=reader();r.changed=true;assert_eq!(extract(&mut r,&track(),&mut Vec::new(),&AtomicBool::new(false),|_|{}).unwrap_err(),"drive_changed");assert!(r.reads.is_empty());}
    #[test] fn write_failure_is_reported(){struct Broken;impl Write for Broken{fn write(&mut self,_:&[u8])->std::io::Result<usize>{Err(std::io::Error::from(std::io::ErrorKind::StorageFull))}fn flush(&mut self)->std::io::Result<()>{Ok(())}}assert_eq!(extract(&mut reader(),&track(),&mut Broken,&AtomicBool::new(false),|_|{}).unwrap_err(),"drive_write");}
    #[test] fn wav_header_has_cd_pcm_format_and_exact_length(){let h=wav_header(2352);assert_eq!(h.len(),44);assert_eq!(&h[..4],b"RIFF");assert_eq!(u32::from_le_bytes(h[24..28].try_into().unwrap()),44100);assert_eq!(u32::from_le_bytes(h[40..44].try_into().unwrap()),2352);}
    #[test] fn recovery_can_only_delete_its_own_adopted_files(){assert!(owned_file("rip-123-abc","disc/rip-123-abc-track-01.flac"));for f in ["../disc/rip-123-abc-track-01.flac","disc/old.flac","disc/rip-234-abc-track-01.flac","disc/rip-123-abc-track-01.flac/other","disc/rip-123-abc-track-01\\..\\old.flac"]{assert!(!owned_file("rip-123-abc",f));}}
    fn fixture_dir()->PathBuf{let path=std::env::temp_dir().join(format!("rip-{}-fixture-{}",std::process::id(),SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()));fs::create_dir(&path).unwrap();path}
    #[test] fn recovery_preserves_saved_backup_and_unrelated_audio(){
        let root=fixture_dir();let audio=root.join("audio");let dir=audio.join("disc");fs::create_dir_all(&dir).unwrap();let job=root.join("rip-123-abc");fs::create_dir(&job).unwrap();
        let files=["disc/rip-123-abc-track-01.flac","disc/rip-123-abc-track-02.flac","disc/original.flac"];
        for file in files{fs::write(audio.join(file),b"audio").unwrap();}
        fs::write(job.join("adopted.json"),serde_json::to_vec(&files).unwrap()).unwrap();
        fs::write(root.join(super::super::BACKUP_FILE),serde_json::json!({"cds":[{"audio":[{"file":files[0]}]}]}).to_string()).unwrap();
        let (refs,safe)=collection_references(&root);assert!(safe);assert!(reap_folder(&job,&audio,&refs,safe));
        assert!(audio.join(files[0]).exists());assert!(!audio.join(files[1]).exists());assert!(audio.join(files[2]).exists());assert!(!job.exists());cleanup_folder(&root);
    }
    #[test] fn invalid_or_unreadable_collection_never_authorizes_draft_deletion(){
        let root=fixture_dir();fs::write(root.join(super::super::DATA_FILE),b"broken json").unwrap();assert!(!collection_references(&root).1);
        fs::remove_file(root.join(super::super::DATA_FILE)).unwrap();
        let preserved=root.join("collection.unreadable-123.json");fs::write(&preserved,b"damaged archive").unwrap();assert!(!collection_references(&root).1);fs::remove_file(preserved).unwrap();
        fs::create_dir(root.join(super::super::BACKUP_FILE)).unwrap();assert!(!collection_references(&root).1);cleanup_folder(&root);
    }
    #[test] fn crash_manifest_is_retained_when_reference_safety_is_unknown(){
        let root=fixture_dir();let job=root.join("rip-123-abc");fs::create_dir(&job).unwrap();fs::write(job.join("adopted.json"),b"[]").unwrap();assert!(!reap_folder(&job,&root,"",false));assert!(job.exists());fs::write(job.join("adopted.json"),b"broken").unwrap();assert!(!reap_folder(&job,&root,"",true));cleanup_folder(&root);
    }
    #[cfg(windows)]
    #[test] fn bundled_flac_encodes_and_decodes_identical_pcm(){
        let folder=std::env::temp_dir().join(format!("rip-{}-test-{}",std::process::id(),SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()));fs::create_dir(&folder).unwrap();
        let encoder=Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/flac/flac.exe");let target=folder.join("test.flac");let pcm=(0..2352*4).map(|i|(i%251) as u8).collect::<Vec<_>>();
        {let mut sink=Sink::new(&target,"flac",&encoder,4).unwrap();sink.write_all(&pcm).unwrap();sink.finish(&AtomicBool::new(false)).unwrap();}
        let output=Command::new(&encoder).args(["--silent","--decode","--stdout","--force-raw-format","--endian=little","--sign=signed"]).arg(&target).output().unwrap();assert!(output.status.success());assert_eq!(output.stdout,pcm);cleanup_folder(&folder);
    }
}
#[tauri::command]
pub async fn adopt_cd_import(app:AppHandle,state:State<'_,DriveState>,job_id:String,cd_id:String)->Result<Vec<ImportedTrack>>{
    let _audio_guard=super::AUDIO_IO.lock().map_err(|_|fail("drive_busy"))?;
    super::check_cd_id(&cd_id)?;let job=find_job(&state,&job_id)?;let mut status=job.status.lock().unwrap();
    if status.state!="done"||job.cancel.load(Ordering::SeqCst){return Err(fail("drive_job"));}
    let dir=super::audio_item_dir(&app,&cd_id)?;fs::create_dir_all(&dir).map_err(|_|fail("drive_write"))?;
    let mut entries=fs::read_dir(&job.folder).map_err(|_|fail("drive_write"))?.flatten().filter(|e|e.path().extension().map(|v|v=="wav"||v=="flac").unwrap_or(false)).collect::<Vec<_>>();
    entries.sort_by_key(|e|e.file_name());
    if entries.len()!=status.tracks as usize {return Err(fail("drive_write"));}
    let files:Vec<String>=entries.iter().map(|e|format!("{cd_id}/{}-{}",job.id,e.file_name().to_string_lossy())).collect();
    // Persist ownership BEFORE moving files, so a crash cannot strand an unseen draft.
    fs::write(job.folder.join("adopted.json"),serde_json::to_vec(&files).unwrap()).map_err(|_|fail("drive_write"))?;
    let mut moved=Vec::new();let mut out=Vec::new();
    for (i,entry) in entries.iter().enumerate(){
        let dest=super::library_path(&app,&files[i])?;
        if super::audio_location::copy_file(&entry.path(),&dest).is_err(){for path in moved{let _=fs::remove_file(path);}status.state="error".into();cleanup_folder(&job.folder);return Err(fail("drive_write"));}
        // The verified, synced library copy is durable even when the library is on another drive.
        let _=fs::remove_file(entry.path());
        moved.push(dest.clone());out.push(ImportedTrack{file:files[i].clone(),name:format!("Track {:02}.{}",i+1,dest.extension().unwrap().to_string_lossy()),size:fs::metadata(&dest).map(|m|m.len()).unwrap_or(0),track:(i+1) as u32});
    }
    status.state="drafted".into();Ok(out)
}
