export type FileKind = "image" | "video";

export type ResizeMode = "none" | "width" | "height" | "fit" | "exact";

export type Status = "queued" | "running" | "done" | "error";

export interface MediaFile {
  id: number;
  path: string;
  name: string;
  ext: string;
  kind: FileKind;
  size: number;
  width?: number;
  height?: number;
  duration?: number;
  status: Status;
  progress: number;
  error?: string;
  output?: string;
  targetFormat: string;
}

export interface Job {
  id: number;
  input: string;
  output: string;
  kind: FileKind;
  format: string;
  quality: number;
  resizeMode: ResizeMode;
  width: number;
  height: number;
  fps: number;
  stripMetadata: boolean;
  overwrite: boolean;
}

export interface ProbeResult {
  width: number;
  height: number;
  duration: number;
  kind: string;
}

export type JobEvent =
  | { event: "started"; id: number }
  | { event: "progress"; id: number; percent: number }
  | { event: "finished"; id: number; output: string }
  | { event: "failed"; id: number; error: string };

export const IMAGE_FORMATS = ["jpg", "png", "webp", "avif", "gif", "tiff", "bmp"];
export const VIDEO_FORMATS = ["mp4", "webm", "mkv", "mov", "avi", "gif", "mp3"];

export const PRESETS: Record<string, {
  label: string;
  description: string;
  format: string;
  quality: number;
  resizeMode: ResizeMode;
  width: number;
  height: number;
  fps: number;
}> = {
  original: {
    label: "Как есть", description: "Только смена формата", format: "webp", quality: 85,
    resizeMode: "none", width: 0, height: 0, fps: 0,
  },
  web: {
    label: "Для веба", description: "Лёгкий вес, быстрая загрузка", format: "webp", quality: 78,
    resizeMode: "width", width: 1600, height: 0, fps: 30,
  },
  social: {
    label: "Соцсети", description: "Квадрат 1080×1080", format: "jpg", quality: 88,
    resizeMode: "exact", width: 1080, height: 1080, fps: 30,
  },
  archive: {
    label: "Архив", description: "Максимальное качество", format: "png", quality: 95,
    resizeMode: "none", width: 0, height: 0, fps: 0,
  },
  short: {
    label: "Клип", description: "MP4 для обмена", format: "mp4", quality: 82,
    resizeMode: "width", width: 1280, height: 0, fps: 30,
  },
};

export function formatBytes(bytes: number): string {
  if (!bytes) return "—";
  const units = ["Б", "КБ", "МБ", "ГБ"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** i).toFixed(i ? 1 : 0)} ${units[i]}`;
}

export function formatDuration(seconds?: number): string {
  if (!seconds || seconds < 0.1) return "—";
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function stem(name: string): string {
  return name.replace(/\.[^.]+$/, "");
}
