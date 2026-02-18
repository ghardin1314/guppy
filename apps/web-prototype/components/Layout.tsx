import type React from "react";

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <div className="max-w-3xl mx-auto px-6 py-10">
      <header className="mb-8">
        <h1 className="text-3xl font-bold text-zinc-100">
          guppy <span className="text-zinc-500 font-normal text-lg">web prototype</span>
        </h1>
      </header>
      <main>{children}</main>
    </div>
  );
}
