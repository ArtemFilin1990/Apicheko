---
name: git-conflict-autofix
description: "Автоматическое и безопасное разрешение git-конфликтов (<<<<<<< /  ======= / >>>>>>>) с валидацией результата. Использовать, когда нужно быстро устранить merge-conflicts и не оставить маркеры в коде."
---

# Git Conflict Autofix

## Overview

Use this skill when the repository contains merge conflict markers and the user asks to auto-fix conflicts.
The skill prioritizes **small diff**, **contract safety**, and **post-fix validation**.

## Preconditions

1. Ensure you are inside a git repository.
2. Inspect conflict files via `git diff --name-only --diff-filter=U`.
3. If no unmerged files are reported, scan for markers with:
   - `rg -n "^(<<<<<<<|=======|>>>>>>>)"`

## Default strategy

1. **Collect context first**:
   - open each conflicted file around markers;
   - detect language/framework conventions in that file.
2. **Prefer compatibility**:
   - keep callback/data contracts already used by surrounding code;
   - do not rename APIs silently.
3. **Resolve each block explicitly**:
   - keep left side, right side, or a merged variant;
   - remove markers completely.
4. **Verify no markers remain**:
   - `rg -n "^(<<<<<<<|=======|>>>>>>>)"` must return nothing.
5. **Run existing project checks** (only commands already present in repo docs/scripts).

## Heuristics for Telegram callback conflicts

When conflict resembles:

```js
 <<<<<<< branch-a
kb("🏠 В меню", "menu")
 =======
kb("🏠 В меню", "reset:start")
 >>>>>>> branch-b
```

choose value based on current callback contract in repository:

- if project standard is `menu`, keep `menu`;
- if project standard is `reset:start`, keep `reset:start`;
- if both are in active use, prefer the one wired to current handler map and keep backward compatibility only if already implemented.

## Safety rules

- Never leave conflict markers in source.
- Never resolve by deleting both sides without semantic replacement.
- Keep edits minimal and local.
- After conflict fix, re-run tests/smoke checks available in repo.

## Output checklist

- List files resolved.
- State why each side was chosen.
- Include verification commands and outcomes.
- If checks cannot run, explain environment limitation and exact local command to run.

## Resources

- [references/conflict-resolution-playbook.md](references/conflict-resolution-playbook.md)
- [scripts/find_conflicts.sh](scripts/find_conflicts.sh)
