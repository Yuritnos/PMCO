# Improvements 3.4 and 3.5

Implemented from `PMCO改进建议3.4-提示词优化版.docx` and `PMCO改进建议3.5.docx`, 11 November 2026. Version remains 0.3.1. Build and installer provenance are recorded in `STATUS.md`.

| Requirement | Result |
| --- | --- |
| A1–A4 | At 860px and below, a 44px sticky bar exposes the current category and More. The category menu reuses the desktop navigation, counts, Favorites, playlists, creation and editing actions. Menus scroll independently and close on Escape, outside interaction or selection. Arrow keys navigate menu actions. Wide layout and shelf tools retain their behavior. |
| B1–B4 | Free-text Media condition appears for all seven media with M / NM / VG+ / VG / G+ / G / F / P suggestions. CD places it beside hub manufacturing, stacking at 480px. Other media place it before Notes. SACD hides hub manufacturing while preserving its value. Empty condition produces no detail row. |
| B5–B6 | Condition passes through item/set drafts, save/reopen, facts, Apply to other items, JSON/CSV and existing metadata sync. Online lookup cannot fill it. Card options, filters, sorting and statistics are unchanged. |
| C1 | File import remains. Folder import, its native command and its UI strings are removed. Add audio files and trim selects one WAV/FLAC source. Invalid or unknown duration stops import. |
| C2–C3 | The automatic algorithm implements all six examples, missing-duration warnings, the 0.5-second tolerance, sample boundaries and merging fragments below 0.1 seconds. Vinyl follows the editor's side/play order. |
| C4 | The visual timeline differentiates retained and hatched discarded regions. It supports full/segment/gap preview, seeking, single/Ctrl/Cmd/Shift/all selection, discard/restore, group drag or keyboard movement, adding/deleting/dragging points, precise time input, 1–32× zoom, Undo/Redo and confirmed reset. The summary remains visible before writing. The editor contains no track-assignment controls. |
| C5 | Confirmation shows file count and discarded duration. Retained segments become ordered draft files, using remaining track/work slots; excess files remain unassigned. Existing assignment controls handle later changes. Files remain drafts until release save. Cancel and late adoption clean only this session's new copies. |
| C6 | Native WAV reads are bounded to 64 KiB and seek directly to retained samples. PCM and float WAV, including RF64, preserve sample bytes and format; FLAC uses the existing verified encoder with sample-index skip/until. Each result's sample count/rate/channel/bit depth is checked. A shared audio-write lock prevents concurrent writes. Progress, cancellation, source-change detection and crash ownership manifests are included. Source preview uses bounded native ranges without granting asset access to its original folder. |
| C7 | Automated checks cover examples, edits, assignments, cancellation/adoption races, sample-identical WAV/FLAC output, source preservation and recovery cleanup. |
| 3.5 | New profiles use app-data/PMCO Audio. Existing legacy roots remain usable. A chosen folder is used directly. When old files exist, Copy and merge / Switch only / Cancel is offered. Identical collisions are reused; different bytes at the same path stop the merge. Failures roll back newly copied files and retain the old setting and all original files. An unavailable old root does not prevent choosing a replacement. |

## Files changed

- `src/index.html`: compact navigation, condition data/UI, split editor, localized storage choices.
- `src-tauri/src/audio_split.rs`: source probing, preview ranges, staged native splitting, adoption, recovery and tests.
- `src-tauri/src/audio_location.rs`: default/direct folders, optional merge, conflict handling and tests.
- `src-tauri/src/lib.rs`: picker/merge choices, split registration and removal of folder import.
- `src-tauri/src/cd_drive.rs`: shared write lock and importer recovery helpers.
- `src-tauri/tauri.conf.json`: selected-source preview protocol in media CSP.
- `tests/improvements-34.cjs`: new isolated regression suite.
- `tests/media-editor.cjs`, `tests/physical-media.cjs`, `tests/improvements-32.cjs`: file-import fixture updates. Physical-media tests also replace two stale expectations confirmed against build 60.
- `README.md`, `STATUS.md`: behavior and delivery handoff.

## Validation

155 unique checks passed, using isolated temporary files, mocked services and fresh browser contexts:

| Suite | Passed |
| --- | ---: |
| Native `cargo test --locked --lib` | 34 |
| `tests/improvements-34.cjs` | 15 |
| `tests/collection-integration.cjs` | 38 |
| `tests/media-editor.cjs` | 28 |
| `tests/physical-media.cjs` | 18 |
| `tests/audio-draft.cjs` | 7 |
| `tests/drive-import.cjs` | 15 |

Focused reruns covered corrected assertions and the final condition-preservation change. Browser coverage includes English/Japanese/Chinese, light/dark, widths 360/480/640/760/860/1280px, scrolling over 500px, keyboard navigation, point/group dragging, precise input, Undo/Redo, all six automatic examples, delayed-adoption cancellation, and a mocked upload/download through the actual sync serializer. Native tests compare retained PCM samples, preserve source bytes, seek a two-hour WAV, reject malformed/overflowing metadata and protect saved/backup-referenced audio during recovery. Screenshots are local QA artifacts, not collection data.

## Scope and remaining limits

The timeline uses colored intervals and time ticks; waveform display was optional and is not included. MP3/M4A/AAC/Ogg/Opus continue to support ordinary file import/playback but trimming is WAV/FLAC only, following the specified default. Adding a general decoder such as FFmpeg requires a separate decision about installer size and dependency maintenance.

Existing audio is never silently moved to the new default folder. Switch only deliberately leaves prior files at their old location, so those tracks may appear missing until copied. Merges retain original copies and never overwrite a different destination file. Installed WebView2 playback and the native folder picker remain manual environment checks; browser tests use mocked native dialogs/preview. No owner account, collection, physical drive or hosted database was used, and the website is not published by this task.
