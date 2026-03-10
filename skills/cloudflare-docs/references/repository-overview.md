# Repository Overview

## Runtime And Tooling

- Site stack: Astro 5 with Starlight and MDX content.
- Deployment surface: Cloudflare Worker via `worker/index.ts` and `wrangler.toml`.
- Node requirement: `22.x`.
- Package manager: `npm`.
- Primary branch upstream: `production`.

## Top-Level Map

- `src/content/docs/**`: main product documentation pages.
- `src/content/partials/**`: reusable MDX snippets consumed with `<Render />`.
- `src/content/changelog/**`: product changelog entries.
- `src/content/products/**`: product metadata used by the site and content validation.
- `src/content.config.ts`: content collection registration and loaders.
- `src/schemas/**`: Zod schemas for frontmatter and data collections.
- `src/components/**`: custom Astro and React components.
- `src/components/index.ts`: central export barrel used by MDX imports.
- `src/pages/**`: dynamic routes such as search, glossary, and collection-backed pages.
- `src/plugins/**`: remark, rehype, and Starlight plugin customizations.
- `src/styles/**`: Tailwind and site styling.
- `src/assets/**`: processed assets handled by Astro.
- `public/**`: static files served as-is, including `__redirects`.
- `bin/fetch-skills.ts`: fetches generated Cloudflare skills into `skills/`.
- `worker/**`: Worker runtime and tests.

## Source-Of-Truth Files

- Content contracts: `src/content.config.ts` and `src/schemas/**`.
- MDX component imports: `src/components/index.ts`.
- Global site behavior: `astro.config.ts`.
- Skills ingestion: `bin/fetch-skills.ts`.
- Redirect behavior: `public/__redirects`.
- Worker runtime: `worker/index.ts`.

## Content Editing Rules

- Docs live under `src/content/docs/<product>/`.
- Partials live under `src/content/partials/<product>/`.
- Changelogs live under `src/content/changelog/<product>/`.
- Images belong in `src/assets/images/<product>/`, not under `src/content/`.
- Product folders commonly use `index.mdx` as landing pages.
- Filenames should stay lowercase and dash-separated.

## Components And Reuse

- Import MDX components from `~/components`.
- Treat `src/components/index.ts` as the public component API for content authors.
- Use `Render` for reusable partial content instead of duplicating repeated paragraphs or steps.
- Inspect the actual component file when changing props or output behavior, not only the barrel export.

## Skills Directory

- `skills/` is generated and gitignored.
- `bin/fetch-skills.ts` downloads a tarball from Cloudflare middlecache and extracts it into `skills/`.
- Do not manually edit `skills/`; change the fetch pipeline only when the task is explicitly about skills delivery.

## Typical Change Targets

- Wording or examples: `src/content/docs/**`.
- Shared snippets: `src/content/partials/**`.
- Frontmatter or tag validation failures: `src/schemas/**`.
- Broken MDX component usage: `src/components/index.ts` plus the target component.
- Sidebar, plugin, or search behavior: `astro.config.ts`, `src/plugins/**`, or `src/pages/**`.
- Runtime or serving issues: `worker/**` and `wrangler.toml`.
- Redirect fixes: `public/__redirects`.
