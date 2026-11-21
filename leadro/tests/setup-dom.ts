import { afterEach } from "vitest";

// Only wire up DOM helpers in jsdom test files; node-environment DB tests skip this entirely.
if (typeof document !== "undefined") {
  await import("@testing-library/jest-dom/vitest");
  const { cleanup } = await import("@testing-library/react");
  afterEach(() => cleanup());
}
