use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicI32, AtomicU32, Ordering};
use std::sync::Mutex;
use tauri::{Emitter, Manager, State};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Job {
    pub id: u32,
    pub input: String,
    pub output: String,
    pub kind: String, // image | video
    pub format: String,
    pub quality: u8,
    pub resize_mode: String, // none | width | height | fit | exact
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub strip_metadata: bool,
    pub overwrite: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "event")]
pub enum JobEvent {
    #[serde(rename_all = "camelCase")]
    Started { id: u32 },
    #[serde(rename_all = "camelCase")]
    Progress { id: u32, percent: u8 },
    #[serde(rename_all = "camelCase")]
    Finished { id: u32, output: String },
    #[serde(rename_all = "camelCase")]
    Failed { id: u32, error: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeResult {
    pub width: u32,
    pub height: u32,
    pub duration: f64,
    pub kind: String,
}

#[derive(Default)]
pub struct AppState {
    processes: Mutex<HashMap<u32, AtomicI32>>,
    next_id: AtomicU32,
}

fn tool_names(name: &str) -> Vec<String> {
    let mut names = vec![name.to_string()];
    if cfg!(windows) {
        for ext in ["exe", "cmd", "bat"] {
            names.push(format!("{name}.{ext}"));
        }
    }
    names
}

fn has_tool(name: &str) -> bool {
    let Some(paths) = std::env::var_os("PATH") else {
        return false;
    };
    let names = tool_names(name);
    std::env::split_paths(&paths).any(|dir| names.iter().any(|n| dir.join(n).is_file()))
}

/// Creates a child process handle without opening a console window on Windows.
fn command(program: &str) -> std::process::Command {
    #[allow(unused_mut)]
    let mut cmd = std::process::Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

#[tauri::command]
fn check_tools() -> HashMap<String, bool> {
    let mut map = HashMap::new();
    map.insert("ffmpeg".into(), has_tool("ffmpeg"));
    map.insert("ffprobe".into(), has_tool("ffprobe"));
    map.insert("magick".into(), has_tool("magick"));
    map.insert("convert".into(), has_tool("convert"));
    map
}

#[tauri::command]
fn probe(path: String) -> Result<ProbeResult, String> {
    let output = command("ffprobe")
        .args([
            "-v", "error",
            "-show_entries", "format=duration:stream=width,height,codec_type",
            "-of", "json",
            &path,
        ])
        .output()
        .map_err(|e| format!("Не удалось запустить ffprobe: {e}"))?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }

    let json: serde_json::Value =
        serde_json::from_slice(&output.stdout).map_err(|e| e.to_string())?;

    let mut width = 0u32;
    let mut height = 0u32;
    let mut kind = "image";
    if let Some(streams) = json.get("streams").and_then(|v| v.as_array()) {
        for stream in streams {
            let codec_type = stream.get("codec_type").and_then(|v| v.as_str()).unwrap_or("");
            if codec_type == "video" {
                width = stream.get("width").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
                height = stream.get("height").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
                let duration = json
                    .get("format")
                    .and_then(|v| v.get("duration"))
                    .and_then(|v| v.as_str())
                    .and_then(|v| v.parse::<f64>().ok())
                    .unwrap_or(0.0);
                if duration > 0.1 || codec_type == "video" && stream.get("nb_frames").is_none() {
                    kind = "video";
                }
            }
        }
    }

    let duration = json
        .get("format")
        .and_then(|v| v.get("duration"))
        .and_then(|v| v.as_str())
        .and_then(|v| v.parse::<f64>().ok())
        .unwrap_or(0.0);

    Ok(ProbeResult { width, height, duration, kind: kind.into() })
}

fn image_filter(job: &Job) -> Option<String> {
    match job.resize_mode.as_str() {
        "width" if job.width > 0 => Some(format!("scale={}:-2", job.width)),
        "height" if job.height > 0 => Some(format!("scale=-2:{}", job.height)),
        "fit" if job.width > 0 && job.height > 0 => {
            Some(format!("scale={}:{}:force_original_aspect_ratio=decrease:flags=lanczos", job.width, job.height))
        }
        "exact" if job.width > 0 && job.height > 0 => {
            Some(format!("scale={}:{}:flags=lanczos", job.width, job.height))
        }
        _ => None,
    }
}

fn video_filter(job: &Job) -> Option<String> {
    let mut parts = Vec::new();
    match job.resize_mode.as_str() {
        "width" if job.width > 0 => parts.push(format!("scale={}:-2:flags=lanczos", job.width)),
        "height" if job.height > 0 => parts.push(format!("scale=-2:{}:flags=lanczos", job.height)),
        "fit" if job.width > 0 && job.height > 0 => parts.push(format!("scale={}:{}:force_original_aspect_ratio=decrease:flags=lanczos", job.width, job.height)),
        "exact" if job.width > 0 && job.height > 0 => parts.push(format!("scale={}:{}:flags=lanczos", job.width, job.height)),
        _ => {}
    }
    if parts.is_empty() { None } else { Some(parts.join(",")) }
}

fn image_args(job: &Job) -> Vec<String> {
    let mut args = vec!["-y".to_string()];
    if job.overwrite {
        // ffmpeg always overwrites with -y; when disabled we pre-check existence
    } else {
        args[0] = "-n".to_string();
    }
    args.push("-i".into());
    args.push(job.input.clone());
    if let Some(filter) = image_filter(job) {
        args.push("-vf".into());
        args.push(filter);
    }
    args.push("-frames:v".into());
    args.push("1".into());
    args.push("-update".into());
    args.push("1".into());

    let fmt = job.format.as_str();
    let q = job.quality as f64 / 100.0;
    match fmt {
        "jpg" | "jpeg" => {
            let crf = (2.0 + (1.0 - q) * 30.0).round() as u32;
            args.extend(["-q:v".into(), crf.to_string(), "-pix_fmt".into(), "yuvj420p".into()]);
        }
        "webp" => {
            let crf = (5.0 + (1.0 - q) * 95.0).round() as u32;
            args.extend(["-c:v".into(), "libwebp".into(), "-quality".into(), crf.to_string()]);
        }
        "avif" => {
            let crf = (60.0 - q * 55.0).round() as u32;
            args.extend(["-c:v".into(), "libaom-av1".into(), "-crf".into(), crf.to_string(), "-b:v".into(), "0".into(), "-still-picture".into(), "1".into()]);
        }
        "png" => {
            args.extend(["-compression_level".into(), ((q * 9.0).round() as u32).max(1).to_string()]);
        }
        "gif" => {
            args.extend(["-filter_complex".into(), "fps=12,scale=iw:ih:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse".into()]);
        }
        "tiff" => {
            args.extend(["-c:v".into(), "tiff".into()]);
        }
        "bmp" => {}
        _ => {}
    }
    if job.strip_metadata {
        args.push("-map_metadata".into());
        args.push("-1".into());
    }
    args.push(job.output.clone());
    args
}

fn video_args(job: &Job) -> Vec<String> {
    let mut args = if job.overwrite {
        vec!["-y".to_string()]
    } else {
        vec!["-n".to_string()]
    };
    args.push("-i".into());
    args.push(job.input.clone());
    let fmt = job.format.as_str();
    let mut filters = Vec::new();
    if let Some(filter) = video_filter(job) {
        filters.push(filter);
    }
    if fmt == "gif" {
        let fps = if job.fps > 0 { job.fps } else { 12 };
        filters.push(format!("fps={},split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse", fps));
    } else if job.fps > 0 {
        args.push("-r".into());
        args.push(job.fps.to_string());
    }
    if !filters.is_empty() {
        let filter = filters.join(",");
        args.push("-vf".into());
        args.push(filter);
    }

    let q = job.quality as f64 / 100.0;
    match fmt {
        "mp4" | "mov" | "m4v" => {
            args.extend(["-c:v".into(), "libx264".into(), "-preset".into(), "medium".into()]);
            let crf = (51.0 - q * 45.0).round() as u32;
            args.extend(["-crf".into(), crf.to_string(), "-pix_fmt".into(), "yuv420p".into(), "-c:a".into(), "aac".into(), "-b:a".into(), "192k".into(), "-movflags".into(), "+faststart".into()]);
        }
        "webm" => {
            args.extend(["-c:v".into(), "libvpx-vp9".into(), "-b:v".into(), "0".into()]);
            let crf = (60.0 - q * 45.0).round() as u32;
            args.extend(["-crf".into(), crf.to_string(), "-c:a".into(), "libopus".into(), "-b:a".into(), "128k".into(), "-row-mt".into(), "1".into()]);
        }
        "mkv" => {
            args.extend(["-c:v".into(), "libx264".into(), "-preset".into(), "medium".into()]);
            let crf = (51.0 - q * 45.0).round() as u32;
            args.extend(["-crf".into(), crf.to_string(), "-c:a".into(), "aac".into(), "-b:a".into(), "192k".into()]);
        }
        "avi" => {
            args.extend(["-c:v".into(), "mpeg4".into(), "-q:v".into(), "4".into(), "-c:a".into(), "libmp3lame".into(), "-b:a".into(), "192k".into()]);
        }
        "mp3" => {
            args.extend(["-vn".into(), "-c:a".into(), "libmp3lame".into(), "-q:a".into(), "2".into()]);
        }
        _ => {}
    }
    if job.strip_metadata {
        args.push("-map_metadata".into());
        args.push("-1".into());
    }
    args.push(job.output.clone());
    args
}

fn run_job(job: &Job, app: &tauri::AppHandle) -> Result<(), String> {
    if !job.overwrite && Path::new(&job.output).exists() {
        return Err("Файл назначения уже существует".into());
    }
    if let Some(parent) = Path::new(&job.output).parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let args = if job.kind == "image" { image_args(job) } else { video_args(job) };

    let mut child = command("ffmpeg")
        .args(&args)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("Не удалось запустить ffmpeg: {e}"))?;

    if let Some(state) = app.try_state::<AppState>() {
        state.processes.lock().unwrap().insert(job.id, AtomicI32::new(child.id() as i32));
    }
    let stderr = child.stderr.take().unwrap();
    let reader = std::io::BufReader::new(stderr);
    let mut last_percent = 0u8;
    for line in std::io::BufRead::lines(reader).flatten() {
        if let Some(pos) = line.find("time=") {
            let rest = &line[pos + 5..];
            if let Some(end) = rest.find(' ') {
                let time = &rest[..end];
                let parts: Vec<&str> = time.split(':').collect();
                if parts.len() == 3 {
                    let secs = parts[0].parse::<f64>().unwrap_or(0.0) * 3600.0
                        + parts[1].parse::<f64>().unwrap_or(0.0) * 60.0
                        + parts[2].parse::<f64>().unwrap_or(0.0);
                    let total = if job.kind == "video" {
                        probe(job.input.clone()).map(|p| p.duration).unwrap_or(0.0)
                    } else {
                        0.1
                    };
                    if total > 0.0 {
                        let pct = ((secs / total) * 100.0).min(100.0) as u8;
                        if pct > last_percent {
                            last_percent = pct;
                            let _ = app.emit("job-event", JobEvent::Progress { id: job.id, percent: pct });
                        }
                    }
                }
            }
        }
    }

    let status = child.wait().map_err(|e| e.to_string())?;
    if let Some(state) = app.try_state::<AppState>() {
        state.processes.lock().unwrap().remove(&job.id);
    }
    if !status.success() {
        return Err(format!("ffmpeg завершился с кодом {}", status.code().unwrap_or(-1)));
    }
    let _ = app.emit("job-event", JobEvent::Progress { id: job.id, percent: 100 });
    Ok(())
}

#[tauri::command]
async fn run_jobs(
    jobs: Vec<Job>,
    app: tauri::AppHandle,
    _state: State<'_, AppState>,
) -> Result<(), String> {
    use std::sync::Arc;
    use tokio::sync::Semaphore;
    let sem = Arc::new(Semaphore::new(4));
    let mut handles = Vec::new();

    for job in jobs {
        let id = job.id;
        let app = app.clone();
        let sem = sem.clone();
        let handle = tokio::task::spawn_blocking(move || {
            let permit = futures::executor::block_on(sem.acquire()).expect("semaphore closed");
            let _permit = permit;
            let _ = app.emit("job-event", JobEvent::Started { id });
            match run_job(&job, &app) {
                Ok(()) => {
                    let _ = app.emit("job-event", JobEvent::Finished { id, output: job.output.clone() });
                }
                Err(error) => {
                    let _ = app.emit("job-event", JobEvent::Failed { id, error });
                }
            }
        });
        handles.push(handle);
    }
    for handle in handles {
        let _ = handle.await;
    }
    Ok(())
}

#[tauri::command]
fn cancel_jobs(state: State<'_, AppState>) -> Result<(), String> {
    let processes = state.processes.lock().unwrap();
    for pid in processes.values() {
        let pid = pid.load(Ordering::Relaxed);
        if pid <= 0 { continue; }
        #[cfg(unix)]
        {
            let _ = command("kill")
                .arg("-TERM")
                .arg(pid.to_string())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .spawn();
        }
        #[cfg(windows)]
        {
            let _ = command("taskkill")
                .args(["/PID", &pid.to_string(), "/F"])
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .spawn();
        }
    }
    Ok(())
}

#[tauri::command]
fn next_ids(count: usize, state: State<'_, AppState>) -> Vec<u32> {
    (0..count)
        .map(|_| state.next_id.fetch_add(1, Ordering::Relaxed) + 1)
        .collect()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            check_tools,
            probe,
            run_jobs,
            cancel_jobs,
            next_ids
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
