import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { FlatCompat } from "@eslint/eslintrc";

const compat = new FlatCompat({ baseDirectory: dirname(fileURLToPath(import.meta.url)) });

const config = [
  { ignores: [".next/**", "node_modules/**", "coverage/**", "next-env.d.ts"] },
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" },
      ],
      "@typescript-eslint/no-explicit-any": "error",
    },
  },
  {
    // Modules are used only through their index.ts (docs/ARCHITECTURE.md): no "@/server/<module>/<file>".
    files: ["src/**/*.{ts,tsx}", "prisma/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@/server/*/*"],
              message: "Import a server module through its index.ts (e.g. \"@/server/auth\"), never one of its internal files.",
            },
          ],
        },
      ],
    },
  },
  {
    // Routes and pages may never touch the internal location functions: they return raw coordinates (spec 22.2).
    // Add any new coordinate-returning internal export here. (This block repeats the module-index pattern above because
    // a later `no-restricted-imports` setting replaces the earlier one for the same files.)
    files: ["src/app/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@/server/location",
              importNames: ["latestValidLocation", "recordLocationEventInTx"],
              message: "Internal to server modules: it carries or writes raw coordinates. Routes call the location services (listLocationEvents, recordLocationEvent).",
            },
          ],
          patterns: [
            {
              group: ["@/server/*/*"],
              message: "Import a server module through its index.ts (e.g. \"@/server/auth\"), never one of its internal files.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["tests/**/*.ts", "prisma/**/*.ts"],
    rules: { "@typescript-eslint/no-explicit-any": "off" },
  },
];

export default config;
