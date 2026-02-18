# shadcn/ui Registry Pattern

How shadcn/ui distributes components as JSON payloads and its open registry protocol.

## Core Concept

shadcn/ui is **not an npm package**. It's a code distribution platform. `npx shadcn add button` downloads the component source and writes it into your project. You own it, modify it, zero runtime dependency.

Components are stored as **JSON payloads** on a web server:

```
https://ui.shadcn.com/r/styles/new-york-v4/button.json
```

```json
{
  "name": "button",
  "type": "registry:ui",
  "dependencies": ["radix-ui"],
  "files": [{
    "path": "registry/new-york-v4/ui/button.tsx",
    "type": "registry:ui",
    "content": "\"use client\"\n\nimport * as React from \"react\"\n..."
  }]
}
```

The `content` field is the **entire component source** as a string. The CLI fetches it, transforms it, writes to disk.

---

## The `npx shadcn add` Pipeline

### Step 1: Load config

Reads `components.json` from project root — aliases, style, framework detection.

### Step 2: Resolve the registry tree

- Fetches the requested item JSON
- Recursively resolves `registryDependencies` (other registry items it depends on)
- Topologically sorts via Kahn's algorithm so deps install before dependents
- Deep-merges all items' `tailwind`, `cssVars`, `css`, `envVars`, `dependencies`
- Deduplicates files (last one wins for same target path)

Registry dependencies can be:
- **Plain name:** `"button"` → fetches from shadcn base registry
- **Namespaced:** `"@acme/card"` → looks up registry URL in `components.json`
- **URL:** `"https://example.com/r/foo.json"` → fetches directly

### Step 3: Transform each file

Source goes through an AST pipeline using **ts-morph** (TypeScript Compiler API wrapper):

```ts
export async function transform(opts: TransformOpts, transformers: Transformer[]) {
  const sourceFile = project.createSourceFile(tempFile, opts.raw, {
    scriptKind: ScriptKind.TSX,
  })
  for (const transformer of transformers) {
    await transformer({ sourceFile, ...opts })
  }
  return sourceFile.getText()
}
```

Transformers run in order:

| Transformer | What it does |
|-------------|-------------|
| `transformImport` | Rewrites `@/registry/new-york/ui/button` → `@/components/ui/button` using project aliases |
| `transformRsc` | Removes `"use client"` if `rsc: false` |
| `transformCssVars` | Substitutes CSS variable references based on theme |
| `transformTwPrefixes` | Adds Tailwind prefix if configured (e.g., `tw-`) |
| `transformIcons` | Swaps `<IconPlaceholder lucide="ChevronRight" />` for actual icon from configured library (lucide, tabler, hugeicons) |
| `transformJsx` | Converts TypeScript → JavaScript if `tsx: false` |
| `transformCleanup` | Final cleanup pass |

### Step 4: Write everything

Updaters run in sequence:

1. `updateTailwindConfig()` — modifies `tailwind.config.js` (v3) or CSS file with `@theme inline {}` (v4)
2. `updateCssVars()` — injects CSS variables via PostCSS into project's CSS file
3. `updateCss()` — adds `@layer`, `@plugin`, `@utility`, `@keyframes`, `@import` directives
4. `updateEnvVars()` — appends to `.env` files (merges, not overwrites)
5. `updateDependencies()` — runs package manager install for npm deps
6. `updateFonts()` — handles `registry:font` items
7. `updateFiles()` — writes component source files to disk (prompts on conflict unless `--overwrite`)

---

## Registry Item Schema

Full set of fields for a registry item:

```json
{
  "$schema": "https://ui.shadcn.com/schema/registry-item.json",
  "name": "dialog",
  "type": "registry:ui",
  "title": "Dialog",
  "description": "A modal dialog component",
  "author": "shadcn",
  "extends": "none",
  "dependencies": ["radix-ui"],
  "devDependencies": [],
  "registryDependencies": ["button", "@acme/card"],
  "files": [{
    "path": "registry/new-york-v4/ui/dialog.tsx",
    "type": "registry:ui",
    "content": "..."
  }],
  "cssVars": {
    "theme": { "font-sans": "Inter, sans-serif" },
    "light": { "background": "oklch(1 0 0)", "primary": "oklch(0.546 0.245 262.881)" },
    "dark":  { "background": "oklch(0.141 0.005 285.823)", "primary": "oklch(0.707 0.165 254.624)" }
  },
  "css": {},
  "tailwind": { "config": {} },
  "envVars": { "DATABASE_URL": "postgresql://..." },
  "docs": "Post-install instructions shown to user",
  "categories": ["forms"],
  "meta": {}
}
```

### Item Types

| Type | Purpose | Target resolution |
|------|---------|-------------------|
| `registry:ui` | Core UI primitives (button, dialog) | `aliases.ui` path |
| `registry:component` | Composed components | `aliases.components` path |
| `registry:block` | Full page sections/layouts | `aliases.components` path |
| `registry:lib` | Utility functions | `aliases.lib` path |
| `registry:hook` | React hooks | `aliases.hooks` path |
| `registry:page` | Full pages | `target` field required (e.g., `app/login/page.tsx`) |
| `registry:file` | Arbitrary files | `target` field required (e.g., `~/.cursor/rules/custom.mdc`) |
| `registry:theme` | CSS variable overrides | Injected into CSS file |
| `registry:style` | Full style variant | Extends or replaces base styles |
| `registry:font` | Font configuration | Handled by font updater |

### CSS Variables

Three scopes:
- `theme` — applies to both light and dark (Tailwind v4 `@theme`)
- `light` — `:root` / default
- `dark` — `.dark` variant

---

## Project Configuration: `components.json`

Lives in project root, configures how the CLI behaves:

```json
{
  "$schema": "https://ui.shadcn.com/schema.json",
  "style": "new-york",
  "rsc": true,
  "tsx": true,
  "tailwind": {
    "config": "",
    "css": "app/globals.css",
    "baseColor": "neutral",
    "cssVariables": true,
    "prefix": ""
  },
  "iconLibrary": "lucide",
  "aliases": {
    "components": "@/components",
    "utils": "@/lib/utils",
    "ui": "@/components/ui",
    "lib": "@/lib",
    "hooks": "@/hooks"
  },
  "registries": {
    "@acme": "https://acme.com/r/{name}.json",
    "@private": {
      "url": "https://registry.company.com/{name}",
      "headers": { "Authorization": "Bearer ${REGISTRY_TOKEN}" }
    }
  }
}
```

Aliases are resolved against `tsconfig.json` to get absolute filesystem paths. The `{name}` and `{style}` placeholders in registry URLs are replaced at runtime.

---

## Open Registry Protocol (CLI 3.0+)

Anyone can host their own registry. It's just JSON files over HTTP.

### 1. Define `registry.json`

```json
{
  "$schema": "https://ui.shadcn.com/schema/registry.json",
  "name": "acme",
  "homepage": "https://acme.com",
  "items": [{
    "name": "fancy-input",
    "type": "registry:ui",
    "title": "Fancy Input",
    "description": "An animated input component",
    "dependencies": ["motion"],
    "registryDependencies": ["button"],
    "files": [{
      "path": "registry/ui/fancy-input.tsx",
      "type": "registry:ui"
    }]
  }]
}
```

Note: `files[].content` is omitted here — the build step inlines it.

### 2. Build the registry

```sh
npx shadcn@latest build
```

Reads `registry.json`, loads source files from `files[].path`, inlines their content into the `content` field, validates against the schema, outputs individual `{name}.json` files to `public/r/`.

### 3. Users configure your registry

```json
{
  "registries": {
    "@acme": "https://registry.acme.com/r/{name}.json"
  }
}
```

### 4. Users install

```sh
npx shadcn@latest add @acme/fancy-input
```

Cross-registry dependencies work — `@acme/card` can depend on `@shadcn/button` or `@v0/chart`.

### Private registries

Auth headers with env var interpolation:

```json
{
  "@private": {
    "url": "https://api.company.com/registry/{name}.json",
    "headers": { "Authorization": "Bearer ${REGISTRY_TOKEN}" },
    "params": { "version": "latest" }
  }
}
```

### Global registry index

Public index at `https://ui.shadcn.com/r/registries.json` lists known open-source registries. Submit a PR to `apps/v4/registry/directory.json` to get listed.

Discovery commands:
- `shadcn search @namespace -q "query"`
- `shadcn view @namespace/item`
- `shadcn list @namespace`

---

## Why This Architecture Matters

**vs npm packages:**
- Users own and modify the code — no version lock-in
- No bundle size from unused components
- Styles are fully customizable (not fighting CSS specificity)

**vs copy-paste:**
- Dependency resolution is automatic
- AST transforms adapt code to your project (aliases, icon library, RSC)
- Updates are opt-in per-component

**The protocol is framework-agnostic.** The `type` field supports distributing anything — components, hooks, libs, pages, config files, Cursor rules. It's a general-purpose code snippet distribution protocol.

---

## Adopters

**Framework ports** (same architecture, different frameworks):
- shadcn-svelte — full registry support for Svelte
- shadcn/vue — full registry support for Vue

**Community registries:**
- Kibo UI — 1000+ composable components
- Aceternity UI — animated components
- tweakcn — theme customization
- registry.directory — catalogs community registries

**Beyond UI:** The `registry:file` type enables distributing anything — Cursor rules, config files, starter templates. Used by OpenAI, Sonos, Adobe for internal component distribution.

---

## Key Source Files

All relative to `github.com/shadcn-ui/ui`:

| File | Purpose |
|------|---------|
| `packages/shadcn/src/registry/schema.ts` | All Zod schemas |
| `packages/shadcn/src/registry/resolver.ts` | Dependency resolution + topological sort |
| `packages/shadcn/src/registry/fetcher.ts` | HTTP fetch with caching + auth |
| `packages/shadcn/src/registry/builder.ts` | URL construction from namespace + template |
| `packages/shadcn/src/commands/add.ts` | `add` command entry point |
| `packages/shadcn/src/commands/build.ts` | `build` command (for registry authors) |
| `packages/shadcn/src/utils/add-components.ts` | Full install pipeline orchestration |
| `packages/shadcn/src/utils/transformers/index.ts` | AST transformation pipeline |
| `packages/shadcn/src/utils/transformers/transform-import.ts` | Import path rewriting |
| `packages/shadcn/src/utils/transformers/transform-icons.ts` | Icon library swapping |
| `packages/shadcn/src/utils/updaters/update-css-vars.ts` | CSS variable injection via PostCSS |
