# Telegram Desktop Repository Map

## Read First

- `AGENTS.md`: repository-local build assumptions, locked-file stop condition, and code conventions.
- `REVIEW.md`: mechanical style rules that are expected in reviews.
- `README.md`: product scope plus links to platform build docs.

## Root Layout

- `CMakeLists.txt`: top-level project entrypoint, includes helper cmake modules and adds the `Telegram` subdirectory.
- `cmake/`: shared desktop-app cmake helpers used by the repo root.
- `docs/`: full from-scratch build instructions for Windows, macOS, and Linux.
- `Telegram/`: primary application sources, resources, generators, and platform build scripts.
- `lib/xdg`: extra shared code outside the main `Telegram/` tree.
- `.github/workflows/`: CI and packaging workflows for Windows, macOS, Linux, Snap, and maintenance bots.

## Main Application Layout

### Build and Generation

- `Telegram/configure.bat`, `Telegram/configure.sh`: configure local builds with API credentials and platform options.
- `Telegram/build/**`: dependency preparation, packaging, updater, release, and docker helper scripts.
- `Telegram/cmake/**`: Telegram-specific generation and build rules such as `td_mtproto.cmake`, `td_scheme.cmake`, and tests wiring.
- `Telegram/codegen/`: code generation support for schemas and other derived assets.

### Core App Sources

- `Telegram/SourceFiles/main.cpp`: desktop entrypoint.
- `Telegram/SourceFiles/mainwidget.*`, `mainwindow.*`, `tray.*`: shell-level startup and top-level UI coordination.
- `Telegram/SourceFiles/main/**`: account, domain, session, and app-config layers.
- `Telegram/SourceFiles/core/**`: cross-cutting app services and runtime state.
- `Telegram/SourceFiles/data/**`: domain models and cached Telegram entities.
- `Telegram/SourceFiles/storage/**`: local storage, sparse lists, file downloads, and persistence helpers.

### Telegram API and Networking

- `Telegram/SourceFiles/api/**`, `apiwrap.*`: high-level request orchestration.
- `Telegram/SourceFiles/mtproto/**`: lower-level MTProto support.
- `Telegram/SourceFiles/mtproto/scheme/api.tl`: Telegram API schema.
- `Telegram/SourceFiles/mtproto/scheme/mtproto.tl`: MTProto protocol schema.

### UI and Feature Areas

- `Telegram/SourceFiles/ui/**`: shared widgets, text, effects, chat helpers, and common UI utilities.
- `Telegram/SourceFiles/window/**`: main window, section switching, menus, notifications, and adaptive layout.
- `Telegram/SourceFiles/dialogs/**`, `history/**`, `overview/**`: conversation list, message history, and overview screens.
- `Telegram/SourceFiles/settings/**`, `intro/**`, `boxes/**`: settings, onboarding, and modal flows.
- `Telegram/SourceFiles/info/**`, `profile/**`: info/profile surfaces and related presentation.
- `Telegram/SourceFiles/media/**`, `calls/**`: media playback, stories, and voice/video call flows.
- `Telegram/SourceFiles/platform/**`: platform-specific behavior when the change is OS-dependent.
- `Telegram/SourceFiles/_other/**`: updater and small platform-specific helpers that do not fit cleanly elsewhere.

## Styles, Localization, and Resources

- `.style` files live next to their owning feature, for example:
  - `Telegram/SourceFiles/window/window.style`
  - `Telegram/SourceFiles/settings/settings.style`
  - `Telegram/SourceFiles/ui/td_common.style`
- `Telegram/Resources/langs/lang.strings`: primary localization source.
- `Telegram/Resources/art/**`, `animations/**`, `emoji/**`, `icons/**`: bundled visual resources.
- `Telegram/Resources/*.tdesktop-theme`: shipped themes and theme bases.

## Shared Libraries Inside `Telegram/`

- `Telegram/lib_base`, `lib_crl`, `lib_rpl`, `lib_ui`, `lib_storage`, `lib_webrtc`, `lib_webview`, and related `lib_*` folders contain reusable internal libraries. Check them when the change affects a cross-cutting primitive instead of only a single feature folder.

## Where To Look By Task

- Startup, account/session lifecycle: `main.cpp`, `mainwidget.*`, `main/**`, `core/**`.
- User-visible text or string placeholders: `Resources/langs/lang.strings` plus the calling feature folder.
- Widget spacing, colors, icon selection, or scale-sensitive UI: related `.style` file plus consuming `.cpp/.h`.
- Request/response wiring, constructor types, and flood handling: `api/**`, `apiwrap.*`, `mtproto/scheme/*.tl`.
- Message history, dialogs, read states, and chat surfaces: `history/**`, `dialogs/**`, `window/**`, `overview/**`.
- Notifications, tray, top-level navigation, and OS shell integration: `tray.*`, `window/**`, `platform/**`.
- Calls, voice, video, stories, or media viewers: `calls/**`, `media/**`, `Telegram/lib_webrtc`.
- Packaging, updater, CI, or environment prep: `Telegram/build/**`, `docs/building-*.md`, `.github/workflows/**`.

## Derived Flows To Respect

- `.style` files define scale-aware values that are consumed through `st::` in C++.
- `lang.strings` keys become `tr::lng_...` accessors; change both source text and usage coherently.
- `.tl` schema files define generated `MTP...` request and response types; inspect schemas before changing request code.
- Avoid patching generated build output in `out/`; change the real source or generator input instead.
