# Web Prototype Findings

Results from `apps/web-prototype/` — a standalone test of Bun's web server capabilities relevant to Guppy's UI layer.

## What We Tested

Two rendering strategies side-by-side:

- **SPA** — single HTML shell (`shell.html`), client-side hash routing, Bun bundles and serves TSX
- **SSR** — `FileSystemRouter` matches TSX files in `pages/`, server renders via `renderToReadableStream`, wraps in HTML shell

Plus: WebSocket pub/sub, file-based API routes, runtime route creation, HMR behavior.

## Findings

### FileSystemRouter

- **Works as documented.** Scans a directory, matches Next.js-style routes including dynamic params (`[slug].tsx`).
- **`router.reload()` picks up new files immediately.** Write a file, call reload, the route exists. No restart needed.
- **File watchers + reload = automatic route discovery.** Using `fs/promises` `watch()` with `{ recursive: true }` on the pages/routes dirs, calling `router.reload()` on change. New files are live within milliseconds.

### SSR via renderToReadableStream

- **Works.** Dynamic import of the matched TSX file, call `renderToReadableStream(createElement(Component, props))`, return as Response. Full HTML output.
- **Dynamic params passed through.** `pageMatch.params` from FileSystemRouter flows to the component as props.
- **Import cache busting required.** Bun caches `import()` calls. Appending `?t=${Date.now()}` to the file path forces re-import. Without this, editing a page TSX and refreshing returns stale content.
- **No Tailwind in SSR output.** The `bun-plugin-tailwind` static plugin only processes assets referenced from HTML entry files (the ones registered as route handlers via `import from "./file.html"`). SSR pages emit raw HTML at runtime — the bundler never sees their class names. Tailwind classes like `text-zinc-400` render as literal strings with no corresponding CSS. Inline styles work fine.

### Tailwind

- **Works in SPA mode.** `shell.html` links to `global.css` which has `@import "tailwindcss"`. Bun's static plugin scans all bundled TSX and generates the utility CSS. Colors, spacing, typography all apply correctly.
- **Does NOT work in SSR mode.** See above. To get Tailwind in SSR pages, options are:
  1. Inline the compiled CSS from the SPA pipeline at a known URL
  2. Run Tailwind CLI separately to scan `pages/` and emit a stylesheet
  3. Use inline styles only for SSR pages
  4. Serve SSR pages through the SPA shell (hydration approach)

### HMR (initial findings — see "HMR: Deep Investigation" below for updated results)

- **Works for child components.** Edit `Counter.tsx` while the counter has state → label updates, count preserved. Bun logs `Reloaded in 3ms: components/Counter.tsx + 1 more`.
- **Root module edits reset all state.** Editing `app.tsx` (the entry point) re-executes the module, which calls `root.render(<App />)` and remounts the entire tree. All `useState` resets to initial values.
- **Fix: keep entry module thin.** Extract all page components to separate files. The entry module should only do routing and root render. Editing any child file preserves state. This is the natural pattern anyway.
- **`globalThis.__root` prevents double-root errors.** Without it, HMR re-execution of the entry calls `createRoot()` again, producing React warnings. Storing the root on globalThis and reusing it avoids this.
- **Not React Fast Refresh.** Bun's HMR is module-level hot replacement. It re-executes the changed module and its importers. It does NOT do the React Fast Refresh transform (patching component definitions in-place). State preservation happens because parent components stay mounted when only a child module changes.

### WebSocket

- **Native support, works immediately.** `Bun.serve()` websocket config with open/message/close handlers. Client connects via `new WebSocket()`.
- **Broadcast pattern works.** Track clients in a `Set`, iterate and `ws.send()` on broadcast endpoint. Tested with `_broadcast` API route pushing to all connected clients.

### Runtime Route Creation

- **API routes:** Write `.ts` file to `routes/`, call `router.reload()`, fetch the new endpoint → works. FileSystemRouter discovers it, dynamic import loads the handler.
- **SSR pages:** Write `.tsx` file to `pages/`, call `router.reload()`, visit `/ssr/new-page` → works. Full HTML rendered from the new component.
- **This is the core capability for agents.** An agent writes a file, the system picks it up, it's live. No config editing, no build step, no restart.

### API Route Handlers

- **Export-per-method pattern works.** `export function GET()` / `export function POST()` in route files. Server matches `req.method` to the export name.
- **Fallback to `export default`.** If no method-specific export, falls back to `mod.default`.

## Correcting Assumptions from Design Docs

The original `06-ui.md` had some inaccuracies based on assumptions:

1. **"React Fast Refresh — automatic for React components during HMR"** → Not accurate. Bun does module-level HMR, not React Fast Refresh. State is preserved only when editing child modules, not the root.
2. **"Create new pages by writing an HTML file"** → Not required. SSR pages are pure TSX — no HTML file needed. SPA pages do need the HTML shell, but it's shared (one shell, many page components).
3. **`bun-plugin-tailwindcss`** → Wrong package name. The correct one is `bun-plugin-tailwind`.

## Recommendations for Guppy

### Use SSR for agent-created pages

- Agent drops a TSX file in `pages/`, it's a route. Simplest possible DX.
- No router config to edit, no HTML file to create.
- Tailwind limitation is solvable (inline styles, or serve a pre-built CSS bundle).

### Use SPA for the operator UI

- The main operator interface (thread view, event bus, etc.) benefits from client-side state, routing, and HMR.
- Single `shell.html` entry, all page components in separate files for HMR safety.

### File watchers handle route discovery

- No polling needed. `fs.watch()` + `router.reload()` makes new files live instantly.
- Both API routes and SSR pages can be added at runtime without server restart.

### `--hot` and file watchers: both required, for different reasons

The server needs **two** independent mechanisms to handle file changes. They are not interchangeable:

| Mechanism | What it does | What it doesn't do |
|-----------|-------------|-------------------|
| `bun --hot` | Resets ESM module cache on file change, so `import()` returns fresh modules | Does NOT call `FileSystemRouter.reload()` — won't discover new/removed route files |
| `fs.watch()` + `router.reload()` | Tells FileSystemRouter to rescan directories, discovering new/removed files | Does NOT invalidate the ESM import cache — edited files still return stale modules |

**Without `--hot`:** FileSystemRouter finds the file, but `import(filePath)` returns the cached (stale) module. Verified by editing a route handler without `--hot` — the response didn't change.

**Without file watchers:** `--hot` clears the import cache, but FileSystemRouter doesn't know about new files. A newly created route file wouldn't be matched.

**With both:** File watcher detects change → calls `router.reload()` (route discovery) → `--hot` resets module registry (fresh imports). Full coverage.

#### Why not `?t=Date.now()` cache-busting?

We initially used `import(filePath + '?t=' + Date.now())` to bypass the cache. This works but has a critical flaw: **every request creates a new cache entry that never gets GC'd** — an unbounded memory leak. Each unique specifier is a separate module in Bun's registry.

With `--hot`, bare `import(filePath)` works correctly. The cache is cleared on file change, so the next import returns the fresh module. No leak.

#### Production considerations

Without `--hot` in production, `import()` caches by specifier — but in production files aren't changing at runtime, so caching is correct behavior. If Guppy needs runtime file creation in production, we'd need a different cache invalidation strategy.

## Tailwind in SSR: Solved

### Problem

`bun-plugin-tailwind` only runs inside the bundler pipeline (HTML imports / `Bun.build()`). SSR pages emit HTML at runtime via `renderToReadableStream` — the bundler never sees their class names, so Tailwind utility classes have no corresponding CSS.

### What we tried

1. **`Bun.build()` with tailwind plugin at runtime** — works but hacky. The output MIME type is `text/css;charset=utf-8` not `text/css`, requiring a `.startsWith()` check. Also couples the server to the bundler plugin API.
2. **Tailwind CLI with `--watch` as a spawned child process** — works but adds a long-lived subprocess. Overkill when rebuilds only need to happen on file changes we already detect.
3. **Tailwind CLI invoked on demand** — cleanest approach. Run `@tailwindcss/cli -i global.css -o ssr-output.css` once at startup, then re-run in the file watcher when pages change.

### Solution (what we landed on)

```ts
const tailwindArgs = ["-i", `${BASE}/styles/global.css`, "-o", SSR_CSS_PATH];
async function buildSSRStyles() {
  await Bun.$`bunx @tailwindcss/cli ${tailwindArgs}`.quiet();
}
await buildSSRStyles(); // initial build before server starts
```

The file watcher on `pages/` calls `buildSSRStyles()` when page files change. SSR pages link to `/ssr/styles.css` which serves the output file via `Bun.file()`.

### Why this works

Tailwind v4's CLI scans all files in the project for class candidates by default (`**/*` pattern). The SSR output CSS includes utilities from both SPA and SSR page files. Since `Bun.file()` reads from disk on each request, the CSS is always fresh after a rebuild — no caching issues.

### Key detail: two separate Tailwind pipelines

The SPA and SSR use independent Tailwind builds:
- **SPA**: `bun-plugin-tailwind` in `bunfig.toml` processes `global.css` as part of the HTML import bundler pipeline. Automatic, no config.
- **SSR**: `@tailwindcss/cli` builds `global.css` to `ssr-output.css` on demand. Served as a static file.

Both scan the same source files so they produce equivalent CSS. The duplication is acceptable — it's the same input/output, just two build paths suited to their contexts.

## Pure SPA with File-Based Routing

After testing both SPA and SSR, we chose **pure SPA** for Guppy's page rendering. Pages are TSX components that get client-side routed — no SSR, no HTML-per-page. An agent drops a `.tsx` file in `pages/`, a code generator produces the route manifest, and the client router picks it up.

### Framework / Project Split

The codebase is split into two directories modeling the `guppy start` / `guppy init` boundary:

- **`framework/`** — owned by the guppy runtime. Contains `server.ts`, `generate-routes.ts`, `router.ts`, `app.tsx`, `shell.html`, and the auto-generated `routes.gen.ts`.
- **`project/`** — scaffolded by init, agent-modifiable. Contains `pages/`, `routes/`, `components/`, `styles/`.

`start.ts` is the entry point (equivalent to `guppy start`). It statically imports `shell.html` (required for Bun's bundler) and calls `createServer(projectDir, shell)`.

### Route Generation

`generate-routes.ts` scans `project/pages/` and emits `framework/routes.gen.ts` — a file with static imports for each page component and a route array. The generated file includes `import.meta.hot.accept()` to create an HMR boundary so Bun can track page file changes through the barrel file.

### Client-Side Routing

`app.tsx` imports `routes.gen.ts`, matches the current `window.location.pathname` against route patterns (including `[slug]` dynamic segments), and renders the matched component. Navigation uses `history.pushState` + `popstate` event interception on `<a>` clicks. `import.meta.hot.data` preserves the React root across HMR reloads.

## HMR: Deep Investigation

### The Problem

After the framework/project split, editing a page TSX file no longer triggered browser updates despite the server logging `Reloaded in 4ms: project/pages/about.tsx + 1 more`.

### Root Cause: FileSystemRouter Breaks Client-Side HMR

**`Bun.FileSystemRouter` pointing to a directory containing files in the client bundle breaks HMR.** Verified via A/B test:

| Setup | Edit 1 | Edit 2 | Edit 3 | Server reloads detected |
|-------|--------|--------|--------|------------------------|
| `new Bun.FileSystemRouter({ dir: pages/ })` before serve | no update | no update | no update | 1 (then stopped) |
| `new Bun.Glob("**/*.tsx")` scanning same dir | updated | updated | updated | 3 (all detected) |

Same server code, same `shell.html`, same pages directory. Only difference: one line creating `FileSystemRouter`. The FSR variant's server even stopped detecting file changes after the first edit.

This affects ANY `FileSystemRouter` pointing to a directory with client-bundled files, regardless of:
- Whether it's created before or after `Bun.serve()`
- Whether it's persistent or a transient local variable
- Whether `router.reload()` is called

`FileSystemRouter` for non-bundled directories (like API `routes/`) does NOT break HMR.

### Fix

Replaced `FileSystemRouter` in `generate-routes.ts` with `Bun.Glob` for page file discovery. A manual `fileToPattern()` function handles the path-to-route conversion (index files, dynamic `[slug]` segments). Routes are sorted deterministically to prevent unnecessary file rewrites.

### Other HMR Requirements Discovered

1. **`import.meta.hot.accept()` in barrel files.** React Fast Refresh only instruments files that exclusively export React components. `routes.gen.ts` exports a `const routes = [...]` array, so it needs an explicit HMR boundary.
2. **`import.meta.hot.data` for React root.** Using `import.meta.hot.data.root ??= createRoot(el)` instead of `globalThis.__root` — Bun's recommended approach.
3. **Deterministic route ordering.** `Object.entries(router.routes)` returns non-deterministic order. Without sorting, `generate-routes.ts` would rewrite `routes.gen.ts` on every call even with identical pages, triggering unnecessary rebundles.
4. **`development: { hmr: true }` vs `--hot`.** Completely separate systems. `development.hmr` is client-side HMR (bundler pushes updates to browser). `--hot` is server-side module reloading (re-executes changed server modules). Both may be needed but for different reasons.

### Likely Bun Bug

The `FileSystemRouter` + HMR conflict is almost certainly a bug. FSR is documented as not having built-in file watching (`reload()` is manual), yet creating one interferes with the bundler's HMR file change detection for the same directory. The exact internal mechanism is unknown — possibly shared kqueue/inotify descriptors, a module registry collision, or a file stat cache conflict. Worth filing upstream.
