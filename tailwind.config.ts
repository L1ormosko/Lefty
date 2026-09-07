import type { Config } from "tailwindcss";

// Restrained design system: one neutral ramp, one brand ink, semantic state colors.
const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: {
          50: "#f6f7f9",
          100: "#eceef2",
          200: "#d5dae2",
          300: "#b1bac8",
          400: "#8794a8",
          500: "#67758c",
          600: "#525e73",
          700: "#434c5e",
          800: "#3a4150",
          900: "#191d26",
        },
        brand: {
          50: "#eef4ff",
          100: "#dbe6ff",
          200: "#bed2ff",
          300: "#91b4ff",
          400: "#5d8bfc",
          500: "#3563f0",
          600: "#1f45d6",
          700: "#1b37ad",
          800: "#1c318b",
          900: "#1c2e6e",
        },
        ok: { 50: "#eefbf3", 500: "#128a51", 700: "#0d6b3f" },
        warn: { 50: "#fff8ea", 500: "#a86a09", 700: "#84520a" },
        bad: { 50: "#fef2f2", 500: "#b42318", 700: "#912018" },
      },
      fontFamily: {
        sans: ["var(--font-sans)", "Arial", "sans-serif"],
      },
      borderRadius: { DEFAULT: "6px", md: "8px", lg: "10px" },
      boxShadow: {
        card: "0 1px 2px rgba(25,29,38,.06), 0 1px 3px rgba(25,29,38,.08)",
        panel: "0 8px 24px rgba(25,29,38,.12)",
      },
    },
  },
  plugins: [],
};
export default config;
