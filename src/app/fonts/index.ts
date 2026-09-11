import localFont from "next/font/local";

/**
 * Heebo, self-hosted.
 *
 * The font was previously named in `globals.css` and never loaded, so every
 * visitor without Heebo installed locally - which is nearly all of them - read
 * a Hebrew-first product rendered in Arial. That is the single biggest reason
 * the interface looked unfinished.
 *
 * It is `next/font/local` rather than `next/font/google` because of how the
 * deploy is shaped. The build command is
 *
 *     npm install && npx prisma migrate deploy && npm run build && npm run seed:dev
 *
 * so the database migration has already run by the time `next build` starts.
 * The compiled Google loader sets a fetch timeout only in development
 * (next/dist/compiled/@next/font/dist/google/fetch-resource.js) and throws with
 * no fallback path when a fetch fails (loader.js). A bad minute at Google would
 * therefore leave the database migrated forward and the application not
 * deployed - an absurd price to pay for a typeface. Files in the git tree
 * cannot fail that way: a missing one is a module-resolution error on the first
 * local build, not a deploy-day surprise.
 *
 * Two files, not six: Heebo v28 is a variable font, so Google serves one file
 * per subset covering the whole 100-900 range. Downloading weights 400/500/600
 * separately returned three byte-identical copies. 42KB total for hebrew+latin.
 * The shekel sign (U+20AA) lives in the hebrew subset, so prices are covered.
 *
 * The fallback list matches what `globals.css` used to declare, so a visitor
 * who blocks the font file lands exactly where the product was before rather
 * than on a serif default.
 */
export const heebo = localFont({
  src: [
    { path: "./Heebo-hebrew.woff2", weight: "100 900", style: "normal" },
    { path: "./Heebo-latin.woff2", weight: "100 900", style: "normal" },
  ],
  variable: "--font-sans",
  display: "swap",
  preload: true,
  fallback: ["Segoe UI", "Arial Hebrew", "Arial", "sans-serif"],
});
