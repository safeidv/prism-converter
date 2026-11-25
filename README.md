# Prism Converter

Десктопное приложение для пакетной конвертации фото и видео. Tauri 2 + React + TypeScript, обработка через локальный `ffmpeg` — файлы никуда не загружаются.

## Скачать

Готовые сборки — в разделе [Releases](https://github.com/safeidv/prism-converter/releases/latest):

- **Windows x64** — установщик `.exe` (NSIS) или `.msi`
- **Linux x64** — `.AppImage`, `.deb`, `.rpm`

Для работы нужен установленный `ffmpeg` (см. раздел про Windows ниже).

## Возможности

- Фото: JPG, PNG, WebP, AVIF, GIF, TIFF, BMP (вход также HEIC/HEIF/SVG — зависит от сборки ffmpeg)
- Видео и аудио: MP4, WebM, MKV, MOV, AVI, GIF, MP3
- Пакетная обработка до 4 файлов одновременно, прогресс по каждому файлу
- Пресеты: «Как есть», «Для веба», «Соцсети», «Архив», «Клип»
- Настройка качества, размера (ширина / высота / вписать / точный) и FPS
- Удаление метаданных, выбор папки результата, защита от перезаписи оригиналов
- Остановка конвертации, открытие результата в системной программе

## Запуск

Нужны Node.js 18+, Rust и системные зависимости Tauri ([https://v2.tauri.app/start/prerequisites/](https://v2.tauri.app/start/prerequisites/)), а также установленный `ffmpeg` / `ffprobe` в `PATH`.

```bash
npm install
npm run tauri:dev      # разработка
npm run tauri:build    # сборка установщика в src-tauri/target/release/bundle
```

Только веб-интерфейс (без нативных API):

```bash
npm run dev
```

## Структура

- `src/App.tsx` — интерфейс, очередь файлов и настройки
- `src/types.ts` — типы, форматы и пресеты
- `src-tauri/src/lib.rs` — команды Tauri, вызовы ffmpeg/ffprobe, события прогресса
- `src-tauri/capabilities/default.json` — разрешения диалогов, файловой системы и opener

Результат сохраняется рядом с исходником (или в выбранной папке) с суффиксом `_prism`, чтобы не заменять оригинал.

## Сборки для Windows и Linux

Установщики собираются в GitHub Actions (`.github/workflows/build.yml`) на нативных раннерах:

- **Windows x64** — `.msi` и `.exe` (NSIS) в артефакте `prism-converter-windows`
- **Linux x64** — `.deb`, `.AppImage`, `.rpm` в артефакте `prism-converter-linux`

Готовые файлы лежат во вкладке **Actions** → нужный запуск → **Artifacts**, а при пуше тега `v*` они автоматически прикрепляются к релизу.

### Windows: установка ffmpeg

Приложение вызывает `ffmpeg` и `ffprobe` из `PATH`. Установите их одним из способов:

```powershell
winget install Gyan.FFmpeg
```

или скачайте сборку с [gyan.dev](https://www.gyan.dev/ffmpeg/builds/), распакуйте и добавьте папку `bin` в `PATH`. После установки перезапустите приложение — индикатор в шапке станет зелёным.

### Локальная сборка под Windows

На Windows с установленными Node.js, Rust (MSVC) и Visual Studio Build Tools:

```powershell
npm ci
npm run tauri build
```

Результат: `src-tauri\target\release\bundle\msi\` и `src-tauri\target\release\bundle\nsis\`.
