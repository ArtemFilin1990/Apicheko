---
name: telegram-desktop
description: "Work with the `telegramdesktop/tdesktop` repository, the official Telegram Desktop C++/Qt client. Use when Codex needs to inspect, build, debug, document, review, or modify Telegram Desktop code, especially in `Telegram/SourceFiles/**`, `.style` UI files, `Telegram/Resources/langs/lang.strings`, `Telegram/SourceFiles/mtproto/scheme/*.tl`, build scripts under `Telegram/build/**`, platform code under `Telegram/SourceFiles/platform/**`, and repository guidance in `AGENTS.md` and `REVIEW.md`."
---

# Telegram Desktop

## Overview

Treat this repository as a large C++/Qt desktop application with strong local conventions and generated flows. Recover the exact subsystem first, then edit the smallest surface that keeps build, style, localization, and API contracts aligned.

## Workflow

1. Classify the request before editing.
   - UI, layout, theme, or widget behavior
   - Telegram API / MTProto / schema changes
   - Data, session, storage, or domain logic
   - Platform-specific behavior, packaging, or updater flow
   - Build, setup, or CI troubleshooting
2. Read the repository rules first.
   - Read root `AGENTS.md` for build assumptions, stop conditions, and high-level conventions.
   - Read `REVIEW.md` for the mechanical style rules the repository expects.
3. Load the matching reference file.
   - Read [references/repository-map.md](references/repository-map.md) to find the right folders and entrypoints.
   - Read [references/build-and-conventions.md](references/build-and-conventions.md) for build commands, style rules, localization, API requests, and validation rules.
4. Inspect the narrowest source of truth before editing.
   - For UI work, inspect the target `.cpp/.h` plus the related `.style` file.
   - For text changes, inspect `Telegram/Resources/langs/lang.strings` and the corresponding `tr::lng_...` calls.
   - For API work, inspect `Telegram/SourceFiles/mtproto/scheme/api.tl` or `mtproto.tl` before touching request code.
   - For build issues, inspect `docs/building-*.md`, `Telegram/configure.*`, and `Telegram/build/**`.
5. Preserve repository contracts unless the user asked to change them.
   - Keep sizes, margins, paddings, and coordinates in `.style` files and consume them through `st::`.
   - Keep localization in `lang.strings` and use `tr::` helpers in code.
   - Keep API request shapes consistent with TL schemas and generated `MTP...` types.
   - Do not add trivial comments; rely on self-documenting code.
6. Validate the smallest viable path.
   - If the repository already has `out/` configured, prefer `cmake --build out --config Debug --target Telegram`.
   - Do not build Release just to verify a change.
   - If the build fails because files are locked, stop and ask the user to close Telegram.exe or the debugger before retrying.

## Decision Guide

- Read [references/repository-map.md](references/repository-map.md) when the task starts with "where is this implemented?" or spans multiple subsystems.
- Read [references/build-and-conventions.md](references/build-and-conventions.md) when the task is about building, style compliance, localization, request wiring, or validation.
- Prefer the repository root `AGENTS.md` over generic build habits when the two disagree.
- Prefer the local `.style`, `lang.strings`, and `.tl` schema files over assumptions drawn from other Qt or Telegram clients.

## Constraints

- Do not edit generated build output under `out/` unless the user explicitly asks for generator or build-output work.
- Do not hardcode dimensional constants in C++ when a `.style` value is appropriate.
- Do not use `std::optional::value()`; use `value_or`, `operator bool`, or dereference after checks.
- Prefer direct subtype casts such as `asUser()` plus null-check over `isUser()` followed by cast.
- Keep multi-line calls one argument per line and keep continuation operators at the start of continued lines.
- Assume full from-scratch builds require Telegram API credentials (`TDESKTOP_API_ID` and `TDESKTOP_API_HASH`) and platform-specific dependency setup.

## Resources

- [references/repository-map.md](references/repository-map.md): root layout, `SourceFiles` hotspots, and where to look for each class of change.
- [references/build-and-conventions.md](references/build-and-conventions.md): build paths, stop conditions, style rules, localization guidance, API request patterns, and validation expectations.
