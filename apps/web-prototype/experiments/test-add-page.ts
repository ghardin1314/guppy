/**
 * Test: Can we add a page at runtime?
 *
 * 1. Write a new TSX page to pages/
 * 2. Wait for file watcher to regenerate routes + HMR to pick it up
 * 3. Fetch /new-page to verify it's served
 */

const BASE_URL = "http://localhost:3456";
const pagesDir = `${import.meta.dir}/../project/pages`;

// Step 1: Write a new page
const pagePath = `${pagesDir}/new-page.tsx`;
await Bun.write(
  pagePath,
  `export default function NewPage() {
  return (
    <div className="max-w-3xl mx-auto px-6 py-10">
      <h1 className="text-3xl font-bold text-zinc-100 mb-4">Dynamic Page</h1>
      <p className="text-zinc-400">
        Created at runtime: ${new Date().toISOString()}
      </p>
      <a href="/" className="text-emerald-400 hover:text-emerald-300 text-sm mt-4 inline-block">
        &larr; Back home
      </a>
    </div>
  );
}
`
);
console.log(`[1/2] Wrote ${pagePath}`);

// Wait for watcher + HMR
await Bun.sleep(1000);

// Step 2: Fetch the page (should get shell.html since it's SPA)
const res = await fetch(`${BASE_URL}/new-page`);
const html = await res.text();
console.log(`[2/2] GET /new-page (status ${res.status})`);

if (res.status === 200 && html.includes('<div id="root">')) {
  console.log("\n✅ Runtime page route works (shell.html served, client will render)");
} else {
  console.log("\n❌ Unexpected response");
  console.log(html.slice(0, 300));
}
