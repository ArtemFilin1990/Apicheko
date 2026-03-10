# Telegram Desktop Build And Conventions

## Fast Validation Path

If the repository already has a configured `out/` directory, use the repository-local command from `AGENTS.md`:

```bash
cmake --build out --config Debug --target Telegram
```

- Prefer `Debug`.
- Do not build `Release` just to verify a change.
- Expected binary in that setup: `out/Debug/Telegram.exe`.

## Stop Conditions

If the build fails with locked-file errors, stop immediately and wait for the user to close the running app or debugger. Do not retry until the lock is gone. Watch for:

- `fatal error C1041`
- `LNK1104`
- `cannot open output file`
- `access denied`
- `file in use`

## Full Environment Setup

Use `docs/building-*.md` when the user needs a from-scratch build, not just an incremental compile.

### Windows

- Toolchain: Visual Studio 2026, Windows SDK `10.0.26100.0`.
- Use the matching Native Tools Command Prompt.
- The repo docs require the Windows 7-compatible toolset selection `-vcvars_ver=14.44`.
- Prepare dependencies with:

```bash
tdesktop\Telegram\build\prepare\win.bat
```

- Configure from `Telegram/` with `TDESKTOP_API_ID` and `TDESKTOP_API_HASH`.

### Linux

- The documented path uses Docker after `Telegram/build/prepare/linux.sh`.
- For debug builds, set `CONFIG=Debug` in the docker invocation.

### macOS

- Use Homebrew-provided prerequisites plus Xcode.
- Prepare dependencies with `Telegram/build/prepare/mac.sh`.
- Configure with `./configure.sh` from `Telegram/`.

## Build Assumptions

- Full local builds expect Telegram API credentials: `TDESKTOP_API_ID` and `TDESKTOP_API_HASH`.
- The repository's documented dependency layout is relative to the repo root, for example `../Libraries`, `../win64/Libraries`, and `../ThirdParty`.
- When troubleshooting environment problems, prefer the repository docs over generic Qt/CMake advice.

## Style Rules To Preserve

Summarized from `AGENTS.md` and `REVIEW.md`:

- Do not add trivial single-line comments. Only add comments for genuinely complex multi-line algorithm explanations.
- Prefer `auto`, `const auto`, and `const auto &` over verbose explicit types when type deduction is clear.
- For multi-line expressions, put continuation operators at the start of continuation lines.
- Add an empty line before the closing brace of a class with sections like `public:` / `private:`.
- Prefer direct subtype casts with null-checks (`asUser()`, `asChannel()`) over `isUser()` plus cast.
- Always initialize basic-type fields and locals unless there is a proven hot-path exception.
- In multi-line calls, put one argument per line.
- Do not use `std::optional::value()`.

## UI Rules

- Put dimensional values in `.style` files, not raw integers in C++.
- Read the owning feature `.style` file together with the widget code.
- Consume style values through `st::...`.
- Remember that `.style` `px` values are scale-aware, while raw numeric constants are not.

## Localization Rules

- Source strings live in `Telegram/Resources/langs/lang.strings`.
- Immediate strings use `tr::lng_key(tr::now, ...)`.
- Reactive strings omit `tr::now` and return `rpl::producer<QString>`.
- Prefer `tr::` projectors and wrappers such as `tr::bold`, `tr::italic`, `tr::rich`, and `tr::marked` over `Ui::Text::*` helpers.
- For `{count}` placeholders in reactive code, use count producers with `| tr::to_count()`.

## API And TL Schema Rules

- Use `Telegram/SourceFiles/mtproto/scheme/api.tl` and `mtproto.tl` as the source of truth for request signatures and response constructors.
- Use generated `MTP...` wrapper types for arguments.
- For result types with multiple constructors, use `.match(...)` or explicit `type()` checks.
- For single-constructor results, `.data()` is the normal shortcut.
- Keep `handleFloodErrors()` behavior consistent with surrounding code.

## RPL Notes

- Start pipelines with `std::move(producer) | rpl::on_next(...)`.
- Pass an `rpl::lifetime` or store the returned lifetime.
- Use `rpl::duplicate(...)` if the same producer must feed multiple pipelines.

## Practical Validation Choices

- UI or localization only: build the Telegram target in Debug; a full package build is unnecessary.
- Build/setup issue: validate the exact documented prepare/configure/build step that is failing.
- Schema/API issue: inspect `.tl` files first, then build the smallest relevant target path.
- If the local environment cannot satisfy the documented dependency layout, state that explicitly instead of guessing.
