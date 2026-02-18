/**
 * Test: Can we add an SSR page at runtime?
 *
 * 1. Write a new TSX page to pages/
 * 2. Wait for file watcher + --hot to pick it up
 * 3. Fetch /ssr/new-page and check for rendered HTML
 */

const BASE_URL = "http://localhost:3456";
const pagesDir = `${import.meta.dir}/../pages`;

// Step 1: Write a new page
const pagePath = `${pagesDir}/new-page.tsx`;
await Bun.write(
  pagePath,
  `export default function NewPage() {
  return (
    <div style={{ maxWidth: 640, margin: "0 auto", padding: "40px 24px" }}>
      <h1 style={{ fontSize: 24, fontWeight: "bold", color: "#fafafa" }}>
        Dynamic Page
      </h1>
      <p style={{ color: "#a1a1aa" }}>
        This page was created at runtime: ${new Date().toISOString()}
      </p>
      <a href="/ssr/" style={{ color: "#34d399" }}>&larr; Back</a>
    </div>
  );
}
`
);
console.log(`[1/2] Wrote ${pagePath}`);

// Wait for watcher + hot reload to pick it up
await Bun.sleep(500);

// Step 2: Fetch the SSR page
const res = await fetch(`${BASE_URL}/ssr/new-page`);
const html = await res.text();
console.log(`[2/2] GET /ssr/new-page (status ${res.status}):`);
console.log(html.slice(0, 500));

if (html.includes("Dynamic Page")) {
  console.log("\n✅ Runtime SSR page works!");
} else {
  console.log("\n❌ Page not found or not rendered");
}

// Check routes list
const routesRes = await fetch(`${BASE_URL}/api/_routes`);
console.log("\nAll routes:", await routesRes.json());
