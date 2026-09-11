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
        /*
         * The semantic ramps used to carry 50/500/700 only, which is why
         * borders around them were written as `border-ok-500/30` - an opacity
         * hack standing in for a shade that did not exist. Filled in to
         * 50/100/200/500/700/800, keeping the original 50/500/700 values
         * unchanged so nothing that already looked right shifts.
         */
        ok: {
          50: "#eefbf3",
          100: "#d3f5e2",
          200: "#a7e8c6",
          500: "#128a51",
          700: "#0d6b3f",
          800: "#0a5432",
        },
        warn: {
          50: "#fff8ea",
          100: "#fdecc8",
          200: "#f8db9b",
          500: "#a86a09",
          700: "#84520a",
          800: "#66400a",
        },
        bad: {
          50: "#fef2f2",
          100: "#fde3e1",
          200: "#f9c6c2",
          500: "#b42318",
          700: "#912018",
          800: "#731a14",
        },
      },
      fontFamily: {
        sans: ["var(--font-sans)", "Arial", "sans-serif"],
      },
      /*
       * Hebrew-tuned line heights, set on the size scale rather than as one
       * rule on body, so a component can still opt out with a leading-* class.
       *
       * Hebrew letterforms are boxier and have no ascender/descender rhythm to
       * open the line up, so Tailwind's default 1.5 reads cramped for the long
       * paragraphs on the landing and legal pages. Headings go the other way:
       * a 1.75 Hebrew headline falls apart into separate lines, so they are
       * tighter than the default, not looser.
       */
      fontSize: {
        xs: ["0.75rem", { lineHeight: "1.65" }],
        sm: ["0.875rem", { lineHeight: "1.7" }],
        base: ["1rem", { lineHeight: "1.75" }],
        lg: ["1.125rem", { lineHeight: "1.6" }],
        xl: ["1.25rem", { lineHeight: "1.45" }],
        "2xl": ["1.5rem", { lineHeight: "1.35" }],
        "3xl": ["1.875rem", { lineHeight: "1.3" }],
        "4xl": ["2.25rem", { lineHeight: "1.2" }],
        "5xl": ["3rem", { lineHeight: "1.15" }],
      },
      /*
       * One radius scale, and a shadow set that is a ramp rather than two
       * unrelated values. `card` and `panel` keep their original definitions
       * because they are used everywhere and already read correctly; `raised`
       * sits between them for a card that is being hovered or dragged, and
       * `focus` is the brand ring reused by anything that needs to look
       * selected without borrowing the focus-visible outline.
       */
      borderRadius: { DEFAULT: "6px", md: "8px", lg: "10px", xl: "14px" },
      boxShadow: {
        card: "0 1px 2px rgba(25,29,38,.06), 0 1px 3px rgba(25,29,38,.08)",
        raised: "0 2px 4px rgba(25,29,38,.06), 0 4px 12px rgba(25,29,38,.10)",
        panel: "0 8px 24px rgba(25,29,38,.12)",
        focus: "0 0 0 3px rgba(53,99,240,.22)",
      },
      transitionDuration: { DEFAULT: "150ms" },
    },
  },
  plugins: [],
};
export default config;
