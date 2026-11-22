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
    files: ["tests/**/*.ts", "prisma/**/*.ts"],
    rules: { "@typescript-eslint/no-explicit-any": "off" },
  },
];

export default config;
