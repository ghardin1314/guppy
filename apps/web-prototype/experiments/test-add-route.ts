/**
 * Test: Can we add an API route at runtime?
 *
 * 1. Write a new route file to routes/
 * 2. Wait for file watcher + --hot to pick it up
 * 3. Fetch the new route
 */

const BASE_URL = "http://localhost:3456";
const routeDir = `${import.meta.dir}/../project/routes`;

// Step 1: Write a new route file
const routePath = `${routeDir}/dynamic.ts`;
await Bun.write(
  routePath,
  `export function GET() {
  return Response.json({ dynamic: true, created: "${new Date().toISOString()}" });
}
`
);
console.log(`[1/2] Wrote ${routePath}`);

// Wait for watcher + hot reload to pick it up
await Bun.sleep(500);

// Step 2: Fetch the new route
const res = await fetch(`${BASE_URL}/api/dynamic`);
const data = await res.json();
console.log(`[2/2] GET /api/dynamic:`, data);

if (data.dynamic === true) {
  console.log("\n✅ Runtime API route works!");
} else {
  console.log("\n❌ Route not found or unexpected response");
}

// Check routes list
const routesRes = await fetch(`${BASE_URL}/api/_routes`);
console.log("\nAll routes:", await routesRes.json());
