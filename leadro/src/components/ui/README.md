# components/ui — design-system primitives

Reusable, presentation-only React components (spec §24, accessibility §23.4). No data fetching,
no auth, no navigation logic. Import from `@/components/ui` (the `index.ts`).

## Rules every component follows
- **All visible text arrives via props** (already translated). Components hold no user-facing
  strings. Only non-linguistic glyphs (`×`, `*`) are inline and are `aria-hidden`.
- **Logical CSS only** (`ms-/me-/ps-/pe-/start-/end-/text-start/border-s`), so `dir="rtl"` works with
  no per-component code. Directional icons flip with the `rtl:` variant.
- **Never colour alone**: `StatusBadge` and `FieldError` always pair colour with icon + text;
  sortable headers expose `aria-sort`.
- **Keyboard**: visible focus ring (`focusRing` in `cx.ts`); `Dialog`/`ConfirmDialog`/`Drawer` share
  `Overlay` (portal, focus trap, Escape, focus restore, backdrop click).
- **Controlled**: `DataTable`, `Pagination`, `Search`, `FilterPanel` own no data state; they emit
  changes so server-side paging/sorting can be wired later.

## Components
Sidebar, TopNav (start/center/end slots), Search, FilterPanel, DataTable, Pagination,
StatusBadge, UserProfileCard, Dialog, ConfirmDialog (destructive variant, focus starts on
Cancel), Drawer, Field/Label/FieldError/FormSection, TextInput, Select, Checkbox, DatePicker
(native `<input type=date>`), AuditTimeline, EmptyState.

Forms: `<Field label error hint required>{(controlProps) => <TextInput {...controlProps} />}</Field>`
links label, hint and error to the control via `aria-describedby` / `aria-invalid`.

## Tokens
Defined in `tailwind.config.ts`: `canvas surface line ink brand success warning danger info neutral`.
Status colours have `DEFAULT` (text), `soft` (background), `line` (border). Text/background pairs
used here are ≥ 4.5:1 (e.g. ink on surface 16:1, white on brand-600 6.7:1, status text on its soft
background 5.3–7:1).

## Dev gallery and tests
- `src/app/dev/ui` shows every component in LTR and RTL; it 404s in production.
- Component tests (`*.test.tsx`) use Vitest + Testing Library with `// @vitest-environment jsdom`
  at the top of each file; the default environment stays `node` for DB tests.
