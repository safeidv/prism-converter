import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { stat } from "@tauri-apps/plugin-fs";
import { basename, dirname, extname, join } from "@tauri-apps/api/path";
import { openPath } from "@tauri-apps/plugin-opener";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import {
  ArrowRight, Check, ChevronDown, CircleAlert, FileImage, FileVideo,
  Film, FolderOpen, Gauge, Image as ImageIcon, Layers3,
  Play, RotateCcw, Settings2, Sparkles, WandSparkles, X,
} from "lucide-react";
import {
  IMAGE_FORMATS, PRESETS, VIDEO_FORMATS, type FileKind, type Job,
  type JobEvent, type MediaFile, type ProbeResult, type ResizeMode,
  formatBytes, formatDuration, stem,
} from "./types";

const IMAGE_EXTS = ["jpg", "jpeg", "png", "webp", "avif", "gif", "bmp", "tiff", "tif", "heic", "heif", "svg"];
const VIDEO_EXTS = ["mp4", "mkv", "webm", "mov", "avi", "m4v", "wmv", "flv", "mpg", "mpeg", "3gp", "m4a", "mp3", "wav", "aac", "ogg", "flac"];

const defaultSettings = {
  quality: 85,
  resizeMode: "none" as ResizeMode,
  width: 1920,
  height: 1080,
  fps: 0,
  stripMetadata: false,
  overwrite: false,
  outputDir: "",
};

type Settings = typeof defaultSettings;

function kindOf(ext: string): FileKind {
  return VIDEO_EXTS.includes(ext) ? "video" : "image";
}

export default function App() {
  const [files, setFiles] = useState<MediaFile[]>([]);
  const [settings, setSettings] = useState<Settings>(defaultSettings);
  const [preset, setPreset] = useState("original");
  const [format, setFormat] = useState("webp");
  const [activeKind, setActiveKind] = useState<FileKind>("image");
  const [busy, setBusy] = useState(false);
  const [doneCount, setDoneCount] = useState(0);
  const [tools, setTools] = useState<Record<string, boolean>>({});
  const [toast, setToast] = useState<{ text: string; error?: boolean } | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const fileIdRef = useRef(1);

  useEffect(() => {
    invoke<Record<string, boolean>>("check_tools").then(setTools).catch(() => {});
    const unsubs: Array<() => void> = [];
    listen<JobEvent>("job-event", ({ payload }) => {
      setFiles(prev => prev.map(f => {
        if (f.id !== payload.id) return f;
        switch (payload.event) {
          case "started": return { ...f, status: "running", progress: 0 };
          case "progress": return { ...f, progress: payload.percent };
          case "finished":
            setDoneCount(c => c + 1);
            return { ...f, status: "done", progress: 100, output: payload.output };
          case "failed": return { ...f, status: "error", error: payload.error };
        }
      }));
    }).then(u => unsubs.push(u));
    return () => unsubs.forEach(u => u());
  }, []);

  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), 4000);
    return () => window.clearTimeout(t);
  }, [toast]);

  const selected = useMemo(() => files.filter(f => f.kind === activeKind), [files, activeKind]);
  const counts = useMemo(() => ({
    image: files.filter(f => f.kind === "image").length,
    video: files.filter(f => f.kind === "video").length,
  }), [files]);

  const formats = activeKind === "image" ? IMAGE_FORMATS : VIDEO_FORMATS;

  const notify = useCallback((text: string, error = false) => setToast({ text, error }), []);

  const addPaths = useCallback(async (paths: string[]) => {
    const added: MediaFile[] = [];
    for (const path of paths) {
      const ext = (await extname(path)).replace(".", "").toLowerCase();
      const kind = kindOf(ext);
      if (!IMAGE_EXTS.includes(ext) && !VIDEO_EXTS.includes(ext)) continue;
      const info = await stat(path).catch(() => null);
      const name = await basename(path);
      added.push({
        id: fileIdRef.current++, path, name, ext, kind,
        size: info?.size ?? 0, status: "queued", progress: 0,
        targetFormat: kind === "image" ? "webp" : "mp4",
      });
    }
    if (!added.length) {
      notify("Поддерживаемые форматы не найдены", true);
      return;
    }
    setFiles(prev => [...prev, ...added]);
    setActiveKind(added[added.length - 1].kind);
    setFormat(added[added.length - 1].kind === "image" ? "webp" : "mp4");

    for (const file of added) {
      try {
        const probe = await invoke<ProbeResult>("probe", { path: file.path });
        setFiles(prev => prev.map(f => f.id === file.id
          ? { ...f, width: probe.width, height: probe.height, duration: probe.duration,
              kind: (probe.kind === "video" || VIDEO_EXTS.includes(f.ext)) ? f.kind : f.kind }
          : f));
      } catch { /* metadata is optional */ }
    }
  }, [notify]);

  // Native file drag-and-drop (works on Windows and Linux webviews).
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    getCurrentWebview()
      .onDragDropEvent(event => {
        const payload = event.payload;
        if (payload.type === "enter" || payload.type === "over") setDragging(true);
        if (payload.type === "leave") setDragging(false);
        if (payload.type === "drop") {
          setDragging(false);
          if (payload.paths.length) addPaths(payload.paths).catch(() => {});
        }
      })
      .then(u => { unlisten = u; })
      .catch(() => {});
    return () => unlisten?.();
  }, [addPaths]);

  const pickFiles = useCallback(async () => {
    try {
      const result = await open({ multiple: true, title: "Выберите фото и видео",
        filters: [{ name: "Медиафайлы", extensions: [...IMAGE_EXTS, ...VIDEO_EXTS] }] });
      if (!result) return;
      await addPaths(result);
    } catch (e) { notify(String(e), true); }
  }, [addPaths, notify]);

  const reset = () => {
    setFiles([]);
    setDoneCount(0);
    setSettings(defaultSettings);
    setPreset("original");
    setFormat("webp");
  };

  const applyPreset = (key: string) => {
    const p = PRESETS[key];
    setPreset(key);
    setFormat(p.format);
    setSettings(s => ({ ...s, quality: p.quality, resizeMode: p.resizeMode,
      width: p.width || s.width, height: p.height || s.height, fps: p.fps }));
  };

  const cancel = async () => {
    await invoke("cancel_jobs").catch(() => {});
    setFiles(prev => prev.map(f => f.status === "running" ? { ...f, status: "queued", progress: 0 } : f));
    notify("Конвертация остановлена");
  };

  const convert = async () => {
    if (!selected.length || busy) return;
    if (!tools.ffmpeg) {
      notify("ffmpeg не найден в PATH. Установите ffmpeg и перезапустите приложение.", true);
      return;
    }
    setBusy(true);
    try {
      const jobs: Job[] = await Promise.all(selected.filter(f => f.status !== "done").map(async f => {
        const outDir = settings.outputDir || await dirname(f.path);
        const name = `${stem(f.name)}_prism.${format}`;
        return {
          id: f.id, input: f.path,
          output: await join(outDir, name),
          kind: f.kind, format, quality: settings.quality,
          resizeMode: settings.resizeMode, width: settings.width,
          height: settings.height, fps: settings.fps,
          stripMetadata: settings.stripMetadata, overwrite: settings.overwrite,
        };
      }));
      if (!jobs.length) { notify("Все выбранные файлы уже обработаны"); setBusy(false); return; }
      await invoke("run_jobs", { jobs });
      notify(`Обработано: ${jobs.length}`);
    } catch (e) { notify(String(e), true); }
    finally { setBusy(false); }
  };

  const pickOutput = async () => {
    try {
      const dir = await open({ directory: true, title: "Папка для результатов" });
      if (typeof dir === "string") setSettings(s => ({ ...s, outputDir: dir }));
    } catch (e) { notify(String(e), true); }
  };

  const progress = files.length
    ? Math.round(files.reduce((sum, f) => sum + f.progress, 0) / files.length)
    : 0;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark"><Sparkles size={18} /></div>
          <div><strong>Prism</strong><span>Converter</span></div>
        </div>
        <div className="topbar-right">
          <button className="icon-btn" title="Настройки" onClick={() => setSettingsOpen(true)}>
            <Settings2 size={18} />
          </button>
          <div className={`tools ${tools.ffmpeg ? "ok" : "bad"}`}>
            <span className="dot" /> ffmpeg {tools.ffmpeg ? "готов" : "не найден"}
          </div>
        </div>
      </header>

      <main className="main">
        <section className="hero">
          <div>
            <h1>Конвертируйте медиа <em>без лишних шагов</em></h1>
            <p>Перетащите файлы или выберите их вручную. Пакетная обработка, пресеты и тонкая настройка качества.</p>
          </div>
          <button className="primary add-btn" onClick={pickFiles}>
            <FolderOpen size={18} /> Выбрать файлы
          </button>
        </section>

        <div className="layout">
          <section className="panel queue">
            <div className="panel-head">
              <div className="tabs">
                <button className={activeKind === "image" ? "active" : ""} onClick={() => { setActiveKind("image"); setFormat("webp"); }}>
                  <ImageIcon size={15} /> Фото <span>{counts.image}</span>
                </button>
                <button className={activeKind === "video" ? "active" : ""} onClick={() => { setActiveKind("video"); setFormat("mp4"); }}>
                  <Film size={15} /> Видео <span>{counts.video}</span>
                </button>
              </div>
              {files.length > 0 && (
                <button className="text-btn" onClick={reset}><RotateCcw size={14} /> Сбросить</button>
              )}
            </div>

            <div
              className={`dropzone ${files.length ? "compact" : ""} ${dragging ? "dragging" : ""}`}
              onDragOver={e => e.preventDefault()}
              onDrop={async e => {
                e.preventDefault();
                await addPaths(Array.from(e.dataTransfer.files).map(f => (f as File & { path?: string }).path).filter(Boolean) as string[]);
              }}
              onClick={files.length ? undefined : pickFiles}
            >
              <input type="file" multiple hidden id="fallback" onChange={async e => {
                await addPaths(Array.from(e.target.files ?? []).map(f => (f as File & { path?: string }).path).filter(Boolean) as string[]);
              }} />
              {!files.length ? (
                <>
                  <div className="drop-icon"><Layers3 size={30} /></div>
                  <strong>Перетащите файлы сюда</strong>
                  <span>или нажмите, чтобы открыть проводник</span>
                  <small>JPG, PNG, WebP, AVIF, GIF, MP4, MKV, WebM, MOV и другие</small>
                </>
              ) : (
                <span className="drop-hint"><Layers3 size={15} /> Перетащите ещё файлы</span>
              )}
            </div>

            {selected.length > 0 && (
              <div className="file-list">
                {selected.map(f => (
                  <div className={`file-row ${f.status}`} key={f.id}>
                    <div className="file-icon">
                      {f.kind === "image" ? <FileImage size={18} /> : <FileVideo size={18} />}
                    </div>
                    <div className="file-info">
                      <div className="file-name" title={f.path}>{f.name}</div>
                      <div className="file-meta">
                        {f.width ? `${f.width}×${f.height}` : f.ext.toUpperCase()}
                        <span>·</span>{formatBytes(f.size)}
                        {f.kind === "video" && <><span>·</span>{formatDuration(f.duration)}</>}
                      </div>
                    </div>
                    <ArrowRight size={14} className="arrow" />
                    <span className="target">.{format}</span>
                    <div className="row-status">
                      {f.status === "running" && <div className="progress"><div style={{ width: `${f.progress}%` }} /></div>}
                      {f.status === "done" && <button className="mini ok" title={f.output} onClick={() => f.output && openPath(f.output)}><Check size={15} /></button>}
                      {f.status === "error" && <span className="error-mark" title={f.error}><CircleAlert size={16} /></span>}
                      {f.status === "queued" && <span className="queued-mark" />}
                    </div>
                    <button className="remove" title="Удалить" onClick={() => setFiles(prev => prev.filter(x => x.id !== f.id))}>
                      <X size={14} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </section>

          <aside className="panel settings">
            <div className="panel-head"><h2><WandSparkles size={17} /> Настройки конвертации</h2></div>

            <div className="field">
              <label>Пресет</label>
              <div className="preset-grid">
                {Object.entries(PRESETS).map(([key, p]) => (
                  <button key={key} className={`preset ${preset === key ? "active" : ""}`} onClick={() => applyPreset(key)}>
                    {p.label}
                  </button>
                ))}
              </div>
              <small className="hint">{PRESETS[preset].description}</small>
            </div>

            <div className="field">
              <label>Формат</label>
              <div className="select-wrap">
                <select value={format} onChange={e => { setFormat(e.target.value); setPreset("custom"); }}>
                  {formats.map(f => <option key={f} value={f}>.{f}</option>)}
                </select>
                <ChevronDown size={15} />
              </div>
            </div>

            <div className="field">
              <div className="label-row"><label>Качество</label><span>{settings.quality}%</span></div>
              <input type="range" min="1" max="100" value={settings.quality}
                onChange={e => setSettings(s => ({ ...s, quality: +e.target.value }))} />
              <div className="range-labels"><small>Меньше вес</small><small>Лучше качество</small></div>
            </div>

            <div className="field">
              <label>Размер</label>
              <div className="select-wrap">
                <select value={settings.resizeMode} onChange={e => setSettings(s => ({ ...s, resizeMode: e.target.value as ResizeMode }))}>
                  <option value="none">Оригинальный</option>
                  <option value="width">По ширине</option>
                  <option value="height">По высоте</option>
                  <option value="fit">Вписать в рамку</option>
                  <option value="exact">Точный размер</option>
                </select>
                <ChevronDown size={15} />
              </div>
              {settings.resizeMode !== "none" && (
                <div className="two-col">
                  {(settings.resizeMode === "width" || settings.resizeMode === "fit" || settings.resizeMode === "exact") && (
                    <div><small>Ширина</small><input type="number" min="0" value={settings.width} onChange={e => setSettings(s => ({ ...s, width: +e.target.value }))} /></div>
                  )}
                  {(settings.resizeMode === "height" || settings.resizeMode === "fit" || settings.resizeMode === "exact") && (
                    <div><small>Высота</small><input type="number" min="0" value={settings.height} onChange={e => setSettings(s => ({ ...s, height: +e.target.value }))} /></div>
                  )}
                </div>
              )}
            </div>

            {activeKind === "video" && (
              <div className="field">
                <div className="label-row"><label>Частота кадров</label><span>{settings.fps || "как есть"}</span></div>
                <input type="range" min="0" max="60" step="1" value={settings.fps}
                  onChange={e => setSettings(s => ({ ...s, fps: +e.target.value }))} />
              </div>
            )}

            <div className="field toggles">
              <label className="toggle"><input type="checkbox" checked={settings.stripMetadata} onChange={e => setSettings(s => ({ ...s, stripMetadata: e.target.checked }))} /><span>Убрать метаданные</span></label>
              <label className="toggle"><input type="checkbox" checked={settings.overwrite} onChange={e => setSettings(s => ({ ...s, overwrite: e.target.checked }))} /><span>Перезаписывать существующие</span></label>
            </div>

            <div className="output-row">
              <div><small>Папка результата</small><span title={settings.outputDir}>{settings.outputDir || "Рядом с исходниками"}</span></div>
              <button className="icon-btn" onClick={pickOutput} title="Выбрать папку"><FolderOpen size={16} /></button>
            </div>
          </aside>
        </div>

        <footer className="actionbar">
          <div className="action-info">
            <Gauge size={18} />
            {files.length ? (
              <div><strong>{selected.length} файлов → .{format}</strong>
                <span>{doneCount} готово · {progress}% · {settings.outputDir || "исходная папка"}</span>
              </div>
            ) : <span>Добавьте файлы, чтобы начать</span>}
          </div>
          {busy ? (
            <button className="primary convert-btn stop" onClick={cancel}><X size={18} /> Остановить</button>
          ) : (
            <button className="primary convert-btn" disabled={!selected.length} onClick={convert}>
              <Play size={18} fill="currentColor" /> Конвертировать
            </button>
          )}
        </footer>
      </main>

      {toast && <div className={`toast ${toast.error ? "error" : ""}`} onClick={() => setToast(null)}>{toast.text}</div>}

      {settingsOpen && (
        <div className="modal-backdrop" onClick={() => setSettingsOpen(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="panel-head"><h2>О приложении</h2><button className="icon-btn" onClick={() => setSettingsOpen(false)}><X size={17} /></button></div>
            <p>Prism Converter — пакетная конвертация фото и видео через ffmpeg. Обработка до 4 файлов одновременно, без загрузки в облако.</p>
            <div className="tools-grid">
              {(["ffmpeg", "ffprobe"] as const).map(t => (
                <div key={t} className={tools[t] ? "ok" : "bad"}><span className="dot" /> {t}: {tools[t] ? "доступен" : "не найден"}</div>
              ))}
            </div>
            <small className="hint">Файлы сохраняются с суффиксом <code>_prism</code>, чтобы не перезаписывать оригиналы.</small>
          </div>
        </div>
      )}
    </div>
  );
}
