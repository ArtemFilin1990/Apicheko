---
name: archive-reader-read-first
description: Enforce a strict read-first workflow for tasks with user-provided files and archives. Use when work involves ZIP/RAR/7z/TAR inputs, mixed document sets, or any analysis/editing request where all relevant files must be inventoried and read before conclusions, code changes, or artifact generation.
---

# Archive Reader / Read-First Workflow

## Core Rule

Read first, act second. Do not implement, edit, summarize, or recommend anything until intake and reading are complete.

Allowed exceptions:
- corrupted file;
- unsupported format/tooling;
- password-protected archive;
- dataset too large for full read in one pass.

When an exception occurs, explicitly list unread files, reason, and workaround path.

## Mandatory Workflow

### Phase 1 — Intake

1. Locate all user-provided inputs in scope.
2. Detect archives (`zip`, `rar`, `7z`, `tar`, `tar.gz`, `tgz`, `tar.bz2`).
3. Unpack each archive into a temporary workspace while preserving folder structure.
4. Record extracted tree and build a unified file list (original + extracted).

### Phase 2 — Inventory

Build a registry with:
- `path`
- `extension`
- `size`
- `category`
- `status_read`

Classify each file as one of:
- text/markdown/code
- pdf
- docx
- xlsx/csv/tsv
- json/yaml/xml
- html
- images
- binaries/unsupported

Tag critical files first:
- instructions/specification/ToR
- README/docs/configs/manifests
- contracts/source documents
- key entrypoints and core code

### Phase 3 — Read First

Read all accessible relevant files before execution.

Priority order:
1. instructions/specification;
2. README/docs/configs;
3. key source/data entrypoints;
4. tables/documents/appendices;
5. remaining related files.

Rules:
- Do not skip files only because they look secondary.
- If volume is large, read critical files first, then batch through remainder.
- For large files, read completely in chunks (not only header).
- For binary/unsupported files, mark as unread with reason.

### Phase 4 — Report Before Action

Before any task execution, print exactly this block:

```markdown
### Intake Report

* Archives found:
* Archives unpacked:
* Total files discovered:
* Files fully read:
* Files not read:
* Source-of-truth files:
* Risks / gaps:
* Ready to proceed: yes/no
```

If `Ready to proceed: no`, close gaps first or request only the strictly necessary user input.

### Phase 5 — Execution

After read-first is complete:
1. execute the user task;
2. rely only on actually read materials;
3. flag source conflicts explicitly;
4. never invent content of unread files.

## Handling Policy

- Text/code (`txt`, `md`, `py`, `js`, `ts`, `go`, `java`, `c`, `cpp`, `rs`, `php`, `rb`, `sh`, `json`, `yaml`, `toml`, `ini`, `env`, `html`, `css`, `xml`, `sql`): read as text.
- PDF: extract text/tables/structure where possible; if not reliable, record limitation.
- DOCX: read text, headings, and tables.
- XLSX/CSV/TSV: read sheets/tables/headers; capture formulas when relevant.
- Images: treat as visual sources only when relevant; avoid overconfident OCR claims.
- Unsupported/binary: mark unsupported; do not infer content.

## Decision Policy

Proceed immediately only when:
- all relevant archives are unpacked;
- all relevant accessible files are read;
- source-of-truth is identified.

Ask user only for blocking issues:
- password-protected archive;
- corrupted file;
- unavailable format/tool;
- oversized corpus requiring prioritization;
- source conflict affecting outcome.

## Done Criteria

Task can start only after all are true:
- archives unpacked;
- registry built;
- relevant files read;
- intake report emitted.
