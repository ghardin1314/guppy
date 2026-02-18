import { relative } from "path";
import { mkdir } from "fs/promises";

/** Convert a page file path to a Next.js-style route pattern. */
function fileToPattern(filePath: string, pagesDir: string): string {
  let rel = relative(pagesDir, filePath)
    .replace(/\.(tsx|ts|jsx|js)$/, "")
    .replace(/\\/g, "/"); // Windows compat

  // index files map to their parent directory
  if (rel === "index") return "/";
  if (rel.endsWith("/index")) rel = rel.slice(0, -"/index".length);

  return "/" + rel;
}

export async function generateRoutes(projectDir: string) {
  try {
    const pagesDir = `${projectDir}/pages`;
    const outDir = `${projectDir}/.guppy`;
    const outPath = `${outDir}/routes.gen.ts`;
    const glob = new Bun.Glob("**/*.{tsx,ts,jsx,js}");

    const routes: Array<{ pattern: string; filePath: string }> = [];
    for await (const file of glob.scan({ cwd: pagesDir, absolute: true })) {
      const pattern = fileToPattern(file, pagesDir);
      routes.push({ pattern, filePath: file });
    }

    // Sort deterministically — prevents unnecessary rewrites that break HMR.
    routes.sort((a, b) => a.pattern.localeCompare(b.pattern));

    const imports: string[] = [];
    const entries: string[] = [];

    for (const { pattern, filePath } of routes) {
      const rel = "./" + relative(outDir, filePath);
      const name = `Page_${imports.length}`;
      imports.push(`import ${name} from "${rel}";`);
      entries.push(`  { pattern: "${pattern}", component: ${name} },`);
    }

    const content = `// AUTO-GENERATED — do not edit.
${imports.join("\n")}

export const routes = [
${entries.join("\n")}
];

// HMR boundary — enables Bun to track page file changes through this generated file
if (import.meta.hot) {
  import.meta.hot.accept();
}
`;

    await mkdir(outDir, { recursive: true });
    const existing = await Bun.file(outPath).text().catch(() => "");
    if (existing !== content) {
      await Bun.write(outPath, content);
      console.log(`[routes] Generated ${routes.length} routes`);
    }
  } catch (e) {
    console.error("[routes] Error generating routes:", e);
  }
}
