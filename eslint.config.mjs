import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { FlatCompat } from "@eslint/eslintrc";

/**
 * Linting.
 *
 * This did not exist. `npm run lint` ran `next lint`, which found no config
 * and offered to create one interactively - so the script had never actually
 * run, in CI or anywhere else, and "the build is clean" was being reported on
 * a check that was never performed.
 *
 * Flat config rather than `.eslintrc`, because ESLint 9 treats the old format
 * as legacy. `FlatCompat` is how Next's own shareable configs (still written
 * in eslintrc form) are consumed from here.
 */
const compat = new FlatCompat({ baseDirectory: dirname(fileURLToPath(import.meta.url)) });

const config = [
  {
    ignores: [
      ".next/**",
      "node_modules/**",
      "test-results/**",
      "playwright-report/**",
      "coverage/**",
      "next-env.d.ts",
    ],
  },

  ...compat.extends("next/core-web-vitals", "next/typescript"),

  {
    rules: {
      /*
       * Two rules are turned into errors rather than left at their defaults,
       * because both describe mistakes this codebase has actually made:
       *
       * - an unused import or variable is usually the remains of a refactor
       *   that was not finished, and one of them was a redaction helper that
       *   had stopped being called.
       * - `any` is how a Prisma type gets silently widened until it stops
       *   catching the thing it was there to catch.
       *
       * `_`-prefixed arguments are exempt: a server action's signature is
       * `(_prev, formData)` and the first argument is genuinely unused.
       */
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" },
      ],
      "@typescript-eslint/no-explicit-any": "error",
    },
  },

  {
    /*
     * Tests reach into shapes on purpose - a factory builds a partial row, a
     * spec asserts on something the public type does not expose. Failing the
     * lint for that would push the noise into the tests rather than remove it.
     */
    files: ["tests/**/*.ts", "e2e/**/*.ts", "prisma/**/*.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
];

export default config;
