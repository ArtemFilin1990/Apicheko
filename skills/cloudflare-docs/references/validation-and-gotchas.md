# Validation And Gotchas

## Validation Commands

### Content Or MDX Changes

```bash
npm run check
```

Run full site validation locally when the environment can support it:

```bash
npm run build
```

Do not rely on `npm run build` in CI-only environments.

### TypeScript, Astro, Worker, Or Config Changes

```bash
npm run check
npm run lint
npm run format:core:check
npm run test
```

### Redirect Changes

```bash
npm run check
npx tsm bin/validate-redirects.ts
```

## MDX Parsing Pitfalls

MDX is parsed as JSX. These characters regularly break builds when left raw in prose:

- `{` and `}`: wrap in backticks or escape.
- `<` and `>`: wrap in backticks or use HTML entities when prose should stay literal.

Check tables, headings, inline examples, and copied CLI output first when build errors look unrelated.

## Frontmatter Expectations

Common required or high-signal fields:

- `title`
- `description`
- `pcx_content_type`
- `sidebar.order` or `sidebar.label` when navigation order matters
- `products`
- `reviewed`

If new tags or field values are rejected, inspect `src/schemas/**` before changing content blindly.

## Links And Paths

- Use absolute internal links from site root, for example `/workers/get-started/`.
- Do not use full `https://developers.cloudflare.com/...` links for internal pages.
- Do not use relative file links like `./page`.
- Do not include file extensions in internal doc links.

## Code Block Rules

- Always specify a lowercase language after the opening fence.
- Prefer supported names such as `bash`, `ts`, `js`, `json`, `yaml`, `toml`, `python`, or `txt`.
- Do not prefix terminal commands with `$` because users copy the block verbatim.

## Repository-Specific Traps

- Images under `src/content/**` will fail repository expectations; place them in `src/assets/images/**`.
- Missing imports for `<Details>`, `<Tabs>`, `Render`, `WranglerConfig`, and other custom components are a common cause of MDX failures.
- `skills/` is generated content. Fix the generator or source, not the extracted output.
- Redirect source paths in `public/__redirects` have strict formatting and should be revalidated with the redirect checker.

## Style And Editorial Notes

- Prefer active voice and present tense.
- Prefer descriptive link text.
- Keep headings sequential without skipping levels.
- Use bold for clickable UI labels and monospace for code, paths, commands, IPs, ports, and status codes.
