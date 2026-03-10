---
name: cloudflare-docs
description: "Work with the `cloudflare/cloudflare-docs` Astro and Starlight repository that powers developers.cloudflare.com. Use when Codex needs to inspect, edit, validate, document, or review Cloudflare docs pages, MDX partials, custom components, content schemas, redirects, Worker delivery code, or repo tooling such as `astro.config.ts`, `src/content.config.ts`, `src/components/**`, `public/__redirects`, `bin/fetch-skills.ts`, and `worker/**`."
---

# Cloudflare Docs

## Overview

Treat this repository as an Astro 5 and Starlight documentation site deployed through a Cloudflare Worker. Build context from the repo map first, then inspect the exact product area, page, component, schema, or build surface touched by the request.

## Workflow

1. Classify the request.
   - Docs or tutorial content under `src/content/docs/**`
   - Reusable partials under `src/content/partials/**`
   - Changelogs or metadata under `src/content/changelog/**`, `src/content/products/**`, or other content collections
   - Components, pages, plugins, or styling under `src/components/**`, `src/pages/**`, `src/plugins/**`, or `src/styles/**`
   - Build, search, skills, redirects, or Worker runtime under `astro.config.ts`, `bin/fetch-skills.ts`, `public/__redirects`, `worker/**`, or `wrangler.toml`
2. Read the repo map before editing.
   - Read [references/repository-overview.md](references/repository-overview.md) for layout, source-of-truth files, and generated directories.
   - Read [references/validation-and-gotchas.md](references/validation-and-gotchas.md) before changing MDX, frontmatter, links, code fences, redirects, or validation commands.
3. Inspect the real source of truth.
   - Treat `src/content/docs/<product>/**` as canonical docs pages.
   - Treat `src/content/partials/<product>/**` and `<Render ...>` callers as the content reuse mechanism.
   - Treat `src/content.config.ts` and `src/schemas/**` as content collection and frontmatter contracts.
   - Treat `src/components/index.ts` as the MDX import barrel and `src/components/**` as component implementations.
   - Treat `astro.config.ts` as the global Starlight, plugin, sidebar, and link-check configuration.
   - Treat `worker/index.ts` and `wrangler.toml` as the serving/runtime entrypoints.
   - Treat `public/__redirects` as the redirect contract.
   - Treat `skills/` as generated output fetched by `bin/fetch-skills.ts`; do not hand-edit it.
4. Preserve repository contracts.
   - Keep internal links absolute from site root and extensionless.
   - Keep filenames lowercase with dashes and preserve landing-page `index.mdx` patterns where the repo already uses them.
   - Keep component imports aligned with `~/components`.
   - Keep images in `src/assets/images/**`, not in `src/content/**`.
   - Prefer page-local or product-local fixes over global config edits when the problem is isolated.
5. Validate the narrowest affected area.
   - MDX/content changes: run `npm run check`; run `npm run build` only in local development, not in CI.
   - TypeScript, Astro, Worker, or config changes: run `npm run check`, `npm run lint`, `npm run format:core:check`, and `npm run test`.
   - Redirect changes: also run `npx tsm bin/validate-redirects.ts`.
6. Escalate carefully.
   - If the request needs new frontmatter fields, new tags, or new collection data, inspect `src/schemas/**` first and update schemas with the content change.
   - If the request affects multiple products, prefer shared partials or shared components over copy-pasting content.

## Decision Guide

- Read [references/repository-overview.md](references/repository-overview.md) when the task is architectural, cross-cutting, or file-location-heavy.
- Read [references/validation-and-gotchas.md](references/validation-and-gotchas.md) when the task touches MDX syntax, links, frontmatter, redirects, formatting, or CI failures.
- Prefer content-only edits for straightforward documentation fixes.
- Prefer schema or config edits only when the current content contract blocks the requested change.

## Constraints

- Do not edit the generated `skills/` directory directly.
- Do not use relative file links like `./page` in docs content.
- Do not leave raw `{`, `}`, `<`, or `>` in MDX prose when they should be escaped or wrapped in code.
- Do not assume `npm run build` is appropriate in CI; the repository treats full builds as local-only.
