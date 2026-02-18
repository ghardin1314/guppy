import type { ComponentType } from "react";

type Route = {
  pattern: string;
  component: ComponentType<{ params: Record<string, string> }>;
};

type Match = {
  component: ComponentType<{ params: Record<string, string> }>;
  params: Record<string, string>;
};

export function matchRoute(pathname: string, routes: Route[]): Match | null {
  for (const route of routes) {
    const params = matchPattern(route.pattern, pathname);
    if (params !== null) {
      return { component: route.component, params };
    }
  }
  return null;
}

function matchPattern(
  pattern: string,
  pathname: string
): Record<string, string> | null {
  const patternParts = pattern.split("/").filter(Boolean);
  const pathParts = pathname.split("/").filter(Boolean);

  if (patternParts.length !== pathParts.length) return null;

  const params: Record<string, string> = {};
  for (let i = 0; i < patternParts.length; i++) {
    const pp = patternParts[i];
    if (pp.startsWith("[") && pp.endsWith("]")) {
      params[pp.slice(1, -1)] = pathParts[i];
    } else if (pp !== pathParts[i]) {
      return null;
    }
  }
  return params;
}
