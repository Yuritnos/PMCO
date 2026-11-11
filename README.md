# PMCO

## Credits

- **Yuritnos** — project owner and maintainer.
- **ChatGPT (OpenAI Codex)** — AI assistance with development, debugging, testing and documentation.
- **Claude (Anthropic)** — AI development assistance.

Source repository: [Yuritnos/PMCO](https://github.com/Yuritnos/PMCO).

PMCO is an app for cataloguing physical music. It supports CD, vinyl, cassette, SACD, DVD, Blu-ray and Other media with free text (including USB/SD), plus mixed-media sets with one shared cover. You can record works, performers and edition details, group releases into favorites, and use English, Japanese or Simplified Chinese. The current Windows installers are PMCO 0.3.1 build 54.

### Try the physical-media preview

Run `npm run preview:media`, then open [the local trial](http://127.0.0.1:4173).
It starts with sample releases, including a set containing two CDs and one vinyl record.
Try opening that set through both CD and Vinyl, adding items with different media, and
editing vinyl through named A/B sides with independent works and numbering. All media folds six medium views, with DVD / Blu-ray combined; the editor and badges keep the exact DVD or Blu-ray format. Other media is a single view with no submenu. The add button follows the selected medium.

Trial changes are saved only in `installers/media-trial/collection.json`, separate from
the installed app. **Reset samples** restores the examples. Account sync is disabled
in this trial. Native audio-file import and CD-drive extraction require the Windows
desktop app; the browser preview covers cataloguing. In the desktop editor, Add audio files copies selected files into the current item draft. Add audio files and trim supports sample-aligned WAV/FLAC splitting with retained/discarded regions, preview, boundary editing and Undo. Audio storage defaults to PMCO Audio in app data; a manually chosen folder is used directly, with an optional verified merge of old audio. All music offers Medium inside Filter; Collection uses the medium sidebar, and both omit the Label filter; filtering keeps the queue and current track intact. Stop the server with Ctrl+C.
No installer build, version change or database migration is needed to run this preview.

It is built with [Tauri 2](https://tauri.app). The screens are a single web page (`src/index.html`) shown in the system's own web view. A small Rust program (`src-tauri/`) keeps the collection in a file on the computer. The same project can later be built for macOS, iPhone and Android.

## Getting the Windows installer

Download **PMCO 0.3.1 build 54** for **Windows x64**. No developer tools or GitHub account are needed.

- **[Download Windows setup (.exe)](https://pmco.pages.dev/downloads/build-54/PMCO_0.3.1_x64-setup.exe)** — recommended; installs for the current user without administrator rights (3,981,117 bytes).
- **[Download Windows MSI (.msi)](https://pmco.pages.dev/downloads/build-54/PMCO_0.3.1_x64_en-US.msi)** — alternative for administrators and managed deployments (4,784,128 bytes).
- **[Visit the PMCO website](https://pmco.pages.dev/#downloads)** — English, Japanese and Simplified Chinese download pages, screenshots and installation guidance.

Run the downloaded installer, follow its prompts, then open PMCO. The packages are currently unsigned, so Windows may show a SmartScreen warning. Check the downloaded file's SHA-256 against these values:

```text
Setup: DA16BF1884ED95BD42472C9DD8FDFD5AA524C7AE880E51D27CF636A3D3393C90
MSI:   1A3B83A5DB83A7CE4F8913B14CC894CAD9C3101EA28F861C18A4A045EF675DF0
```

### Import audio from a CD drive (Windows)

Open a CD item's editor, expand **Audio**, and choose **Add from CD drive**.
Connect a CD/DVD drive, insert a standard audio CD, then choose **Refresh** and
**Read disc**. Choose FLAC (default) or WAV and select **Copy audio**. Review the
editor and **Save** the CD. The FLAC encoder is bundled; no separate encoder setup
is needed.

The drive imports **audio only**: it reads physical track counts and durations,
without identifying the release or looking up titles, performers or artwork.
Entered metadata is preserved. Existing work/audio slots must match the disc's
physical track count; an empty Works section gets numbered tracks. Existing
audio is protected from replacement. Cancel stops copying; Discard removes only
newly copied draft files. Audio stays on your computer and is never uploaded.

Standard stereo audio CDs are supported. Data/mixed-mode, pre-emphasis and
four-channel discs are rejected. The importer includes bounded reads, read-error
retries, cancellation, disc-change checks and FLAC verification. Secure-rip /
AccurateRip checking, drive-offset correction and CD-Text are outside the current
audio-import scope. Physical-drive import has been confirmed on the owner's
setup; broader hardware testing remains limited. See [the importer notes](docs/cd-drive-import.md).

### Publishing a release for others to download

Push a tag that starts with `v`, for example `v0.1.0`. You can also create one on GitHub under **Releases → Draft a new release → Choose a tag**. The same workflow then attaches the installers to a **draft release**. Check it, then select **Publish release**. Anyone can download the installer from the Releases page.

To publish a new version:

1. Raise `version` in `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml` and `package.json`.
2. Tag the new version, for example `v0.1.1`.

## Where the collection is saved

- **Windows:** `%APPDATA%\com.cdc.collection\collection.json`, with the previous save kept as `collection.backup.json`.
- **macOS:** `~/Library/Application Support/com.cdc.collection/`.

The installed application is **PMCO.exe**. A new PMCO data folder starts with an empty collection; old trial data is never imported automatically. Reinstalling or upgrading preserves an existing PMCO collection. To bring back an old trial deliberately, import its `%APPDATA%\CDC\collection.json` through PMCO's import controls.

## Working on it locally

You need [Node.js](https://nodejs.org) 20 or later and [Rust](https://rustup.rs). On Windows, you also need the "Desktop development with C++" tools from Visual Studio Build Tools.

```
npm install
npm run prepare:windows  # Windows: fetch checksum-pinned FLAC binaries, source and licenses
npm run dev      # opens the app with live reload of src/index.html
npm run build    # makes the installer in src-tauri/target/release/bundle/
```

## How it is organised

| Path | What it is |
|---|---|
| `src/index.html` | The entire app UI: layout, translations and logic |
| `src-tauri/src/lib.rs` | `load_data` and `save_data`, which read and write the collection file |
| `src-tauri/tauri.conf.json` | App name, version, window size and installer settings |
| `src-tauri/icons/` | App icons, made from `app-icon.png` (the 1024 px source in the main folder) |
| `.github/workflows/build-windows.yml` | The GitHub build |

### Storage layer, for adding sharing later

All saving and loading in the page goes through one object, `Store` in `src/index.html`, which has `load()` and `save()`. To add accounts, sync or sharing:

1. Set up an online backend, for example Supabase or Firebase.
2. Write a second `Store` with the same two functions.
3. Switch the page to it.

The rest of the app does not need to change.

## Still to do before a public release

- **Code signing.** Unsigned installers trigger Windows SmartScreen's "Windows protected your PC" warning. A code-signing certificate removes it. Tauri's signing guide covers the setup: https://v2.tauri.app/distribute/sign/windows/
- **macOS build.** Add a `macos-latest` job to the workflow. A signed and notarised Mac app needs an Apple Developer account.
- **Phone apps.** Run `npm run tauri android init` / `ios init` and adapt the layout where needed.
