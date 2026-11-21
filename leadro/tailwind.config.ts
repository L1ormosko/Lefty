import type { Config } from "tailwindcss";

/**
 * Design tokens (spec §24.1: restrained enterprise palette).
 * Every text/background pairing used by components meets WCAG AA (4.5:1) — see
 * src/components/ui/README.md. Status colours come in `DEFAULT` (text), `soft` (background)
 * and `line` (border) so a badge is never colour-only: components always add an icon + label.
 */
const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        canvas: "#f6f7f9",
        surface: "#ffffff",
        line: { DEFAULT: "#d5d9e0", strong: "#6b7585" },
        ink: { DEFAULT: "#1a2230", muted: "#4a5568", inverse: "#ffffff" },
        brand: { 50: "#eff4ff", 100: "#dbe6fe", 600: "#1d4ed8", 700: "#1e40af" },
        success: { DEFAULT: "#166534", soft: "#dcfce7", line: "#86efac" },
        warning: { DEFAULT: "#92400e", soft: "#fef3c7", line: "#fcd34d" },
        danger: { DEFAULT: "#b91c1c", soft: "#fee2e2", line: "#fca5a5" },
        info: { DEFAULT: "#1d4ed8", soft: "#dbeafe", line: "#93c5fd" },
        neutral: { DEFAULT: "#374151", soft: "#f3f4f6", line: "#d1d5db" },
      },
      boxShadow: { overlay: "0 10px 30px rgba(15, 23, 42, 0.18)" },
    },
  },
  plugins: [],
};

export default config;
