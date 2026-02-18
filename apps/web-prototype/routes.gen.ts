// AUTO-GENERATED — do not edit. Regenerated when pages/ changes.
import { lazy } from "react";

const Page_0 = lazy(() => import("./pages/about.tsx"));
const Page_1 = lazy(() => import("./pages/index.tsx"));
const Page_2 = lazy(() => import("./pages/projects/[slug].tsx"));

export const routes = [
  { pattern: "/about", component: Page_0 },
  { pattern: "/", component: Page_1 },
  { pattern: "/projects/[slug]", component: Page_2 },
];
