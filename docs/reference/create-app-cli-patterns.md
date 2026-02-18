# create-xxx-app CLI Patterns

How popular scaffolding CLIs handle templates, options, and composition.

## Prompt Library

All major tools use **`@clack/prompts`** for interactive CLI prompts. It's the clear standard as of 2025.

Other libs: `commander`/`citty` for arg parsing, `arg` for simpler cases.

## Pattern 1: Static Template Directories

**Used by:** create-vite

One complete, standalone project per combination:

```
templates/
  react/
  react-ts/
  vue/
  vue-ts/
  vanilla/
  vanilla-ts/
```

Selection is a flat enum — pick framework, pick variant, copy the dir.

```ts
const templateDir = path.join(__dirname, 'templates', template)
cpSync(templateDir, projectDir, { recursive: true })
```

Some variants have a `customCommand` that delegates to another tool entirely (e.g., `npm create vue@latest`).

**Scales to:** < 10 variants. Breaks at 2^N when options are independent toggles.

**Pros:** Dead simple. Each template is a real, inspectable, runnable project.
**Cons:** Massive duplication. Adding one option doubles the template count.

---

## Pattern 2: Computed Template Name + Programmatic Layer

**Used by:** create-next-app

~9 template dirs handle axes that affect many files (router type, tailwind). Options that only affect config are handled in code.

```
templates/
  app/              # App Router
  app-tw/           # App Router + Tailwind
  app-empty/
  app-tw-empty/
  default/          # Pages Router
  default-tw/
  default-tw-empty/
```

Template name is computed:

```ts
const template = `${app ? 'app' : 'default'}${tailwind ? '-tw' : ''}${empty ? '-empty' : ''}`
const mode = typescript ? 'ts' : 'js'
```

Then `installTemplate()` programmatically:
- Builds `package.json` with conditional deps based on `eslint`, `biome`, `bundler`, `reactCompiler` flags
- Modifies `next.config.ts` in-memory for Rspack/React Compiler
- Handles import alias replacement across all files
- Moves files into `src/` if `srcDir` option is chosen
- Excludes files conditionally: `if (!eslint) copySource.push('!eslint.config.mjs')`

**Scales to:** ~20 combinations. Good when you have 1-2 "big" axes (router, styling) and several "small" config toggles.

**Pros:** Manageable template count. Programmatic layer handles orthogonal options cleanly.
**Cons:** Hybrid approach — must understand both the template dirs and the code layer.

---

## Pattern 3: Base + Extras Overlay

**Used by:** create-t3-app

The most popular pattern for many toggleable options. A **base template** is always copied. Per-feature **installers** then select variant files from an `extras/` directory.

```
template/
  base/                         # always copied first
  extras/
    src/server/api/trpc/
      base.ts                   # trpc alone
      with-auth.ts              # trpc + nextAuth
      with-auth-prisma.ts       # trpc + nextAuth + prisma
      with-auth-drizzle.ts      # trpc + nextAuth + drizzle
      with-prisma.ts            # trpc + prisma
      with-drizzle.ts           # trpc + drizzle
    prisma/schema/
    start-database/
```

### Installer-per-feature

Each feature has an installer function registered in a typed map:

```ts
type PkgInstallerMap = Record<AvailablePackages, {
  inUse: boolean
  installer: Installer
}>
```

Installers receive the full map so they can check what else is active:

```ts
const trpcFile = (() => {
  if (usingAuth && usingDb) return "with-auth-db.ts"
  if (usingAuth)            return "with-auth.ts"
  if (usingDb)              return "with-db.ts"
  return "base.ts"
})()
```

Dependencies are added via `addPackageDependency()` helper.

**Scales to:** ~10+ toggleable options. The variant file count grows but stays manageable.

**Pros:** Each feature's integration logic is co-located in its installer. Base template stays clean.
**Cons:** Cross-cutting concerns multiply variant files (N features affecting one file = N variant files with naming conventions like `with-auth-prisma.ts`).

---

## Pattern 4: EJS Templates + Add-on Registry

**Used by:** TanStack CLI (`@tanstack/cli create`)

The most extensible system. Base templates use EJS conditionals so **one file handles many combos**. Add-ons are self-contained units.

### Directory structure

```
frameworks/react/
  project/
    base/                    # Base template files (*.ejs)
    packages.json            # Conditional dependencies
  add-ons/
    tanstack-query/
      info.json              # Metadata, deps, integrations, routes
      package.json           # Dependencies to add
      assets/                # Files to inject
    drizzle/
    clerk/
  toolchains/               # eslint, biome
  hosts/                     # Deployment adapters
```

### EJS conditionals in templates

```ejs
<% if (addOnEnabled['tanstack-query']) { %>
import { QueryClient } from '@tanstack/react-query'
<% } %>
```

### Integration injection

Add-ons declare integration points in `info.json`:

```json
{
  "integrations": [{
    "type": "provider",
    "jsName": "ClerkProvider",
    "path": "src/integrations/clerk/provider.tsx"
  }]
}
```

The base template loops over these:

```ejs
<% for (const int of integrations.filter(i => i.type === 'provider')) { %>
import { <%= int.jsName %> } from '<%= int.path %>'
<% } %>
```

### Special file patterns

- `*.ejs` — processed through EJS with template context
- `*.append` — appended to existing file (e.g., `_dot_env.local.append`)
- `__postgres__schema.ts` — option-prefixed, only included when that option is active

### Add-on lifecycle

1. `getFiles()` — file list
2. `getFileContents(path)` — content (possibly EJS)
3. `getDeletedFiles()` — files to remove from base
4. Optional `command` — post-install CLI commands
5. `createSpecialSteps` / `postInitSpecialSteps` — hooks

Supports remote add-ons via URL for third-party extensibility.

**Scales to:** Unlimited add-ons. Community-extensible.

**Pros:** One file handles many combos. Rich metadata. Third-party add-ons.
**Cons:** EJS templates are harder to read than plain files. Debugging rendering errors is painful.

---

## Pattern 5: AST-Based Programmatic Manipulation

**Used by:** SvelteKit `sv`

No template files. Add-ons **programmatically modify ASTs**:

```ts
export default defineAddon({
  id: 'tailwindcss',
  options,
  run: ({ sv, files }) => {
    sv.devDependency('tailwindcss', '^4.0.0')

    sv.file(files.viteConfig, (content) => {
      const { ast, generateCode } = parse.script(content)
      js.imports.addDefault(ast, { as: 'tailwindcss', from: '@tailwindcss/vite' })
      js.vite.addPlugin(ast, { code: 'tailwindcss()' })
      return generateCode()
    })

    sv.file(files.stylesheet, (content) => {
      const { ast, generateCode } = parse.css(content)
      css.addAtRule(ast, { name: 'import', params: `'tailwindcss'` })
      return generateCode()
    })
  }
})
```

### Parsing infrastructure

Parsers for every file type, each returning `{ ast, generateCode }`:

```ts
const parse = {
  css: parseCss,
  html: parseHtml,
  json: parseJson,
  script: parseScript,   // JS/TS
  svelte: parseSvelte,
  toml: parseToml,
  yaml: parseYaml,
}
```

Manipulation helpers: `js.imports.addDefault()`, `js.vite.addPlugin()`, `css.addAtRule()`, `json.arrayUpsert()`, `svelte.ensureScript()`, etc.

### Add-on pipeline

```
AddonInput[] → classifyAddons() → AddonReference[]
  → resolveAddons() → LoadedAddon[]
  → setupAddons() → PreparedAddon[]           (resolve deps, check support)
  → promptAddonQuestions() → ConfiguredAddon[] (ask user)
  → applyAddons() → AddonResult[]             (execute)
```

### Options builder

```ts
const options = defineAddonOptions()
  .add('plugins', {
    type: 'multiselect',
    question: 'Which plugins?',
    options: [...],
    default: [],
  })
  .build()
```

Supports official, file-local, and npm-published add-ons.

**Scales to:** Unlimited. Perfect composability.

**Pros:** Add-ons compose perfectly — adding Tailwind works regardless of what else is installed. No variant file explosion. Can't produce invalid code.
**Cons:** Highest implementation cost. Requires building the entire parsing/manipulation layer.

---

## Pattern 4 (Remote Download)

**Used by:** create-astro

Templates aren't bundled — downloaded from GitHub at runtime via `@bluwy/giget-core`:

```ts
downloadTemplate(`github:withastro/astro#examples/${tmpl}`, { dir: projectDir })
```

Supports third-party templates (any GitHub repo). Minimal post-processing (rename `package.json`, strip `CHANGELOG.md`). No per-option composition.

**Use when:** Templates are full example repos that should be independently runnable/testable.

---

## Decision Matrix

| Scenario | Pattern |
|----------|---------|
| < 5 total combos | Static dirs (#1) |
| 1-2 big axes + config toggles | Computed template + code (#2) |
| Many boolean toggles, cross-cutting | Base + extras overlay (#3) |
| Community/third-party extensibility | EJS + add-on registry (#4) |
| Full composability, control the framework | AST manipulation (#5) |

The emerging best practice is the **add-on model** (patterns 4-5). Each feature is a self-contained unit that knows how to install itself, rather than the scaffolder knowing about all N² combinations. TanStack's EJS approach is the most practical to adopt; sv's AST approach is the most powerful but requires significant upfront investment.
