# Conflict Resolution Playbook

## 1) Detect

```bash
git diff --name-only --diff-filter=U
rg -n "^(<<<<<<<|=======|>>>>>>>)"
```

## 2) Inspect local context

For each conflict location:

- open function boundaries;
- inspect nearby routing/handler tables;
- verify which constant/callback is actually supported.

## 3) Resolve with minimal diff

Pick one side or merge safely:

- preserve existing external contracts;
- avoid opportunistic refactors;
- keep behavior explicit.

## 4) Validate

- ensure markers are gone;
- run repository checks (lint/tests/smoke/build) that already exist.

## 5) Final sanity

- `git status` should only show intended files;
- no secrets introduced;
- no broken imports or syntax errors.
