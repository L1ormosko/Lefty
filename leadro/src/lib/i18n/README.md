# i18n (pure library)

Framework-free localization for LEADRO: catalogs, `t()`, locale resolution, formatting and the
checks behind `npm run i18n:check`. Implements spec §16 (§16.1–16.6). DB-backed parts (tenant
overrides, resolving a user's locale from the org tree) live in `src/server/i18n`.

## Catalogs
`catalogs/{en-US,es-US,he-IL}.json`: `{ "locale", "version", "messages": { "DOMAIN.KEY": "text" } }`.
- **Keys are dotted `DOMAIN.UPPER_SNAKE`** (`COMMON.SAVE`, `JOB_STATUS.COMPLETED`, `ERROR.FORBIDDEN`).
  Domain = the screen/concept group; keep the part after the dot equal to the internal enum value
  where one exists (`ORG_UNIT_TYPE.BRANCH`, `PERMISSION_ACTION.VIEW`). Internal statuses stay English.
- Placeholders are `{name}`; every locale must use the same set.
- en-US is the source of truth and final fallback. `MessageKey` is derived from it, so `t("TYPO")` fails to compile.
- Bump `version` when you change existing wording (§16.6). Adding keys does not require a bump.
- Machine-translated legal/financial text must not be merged without human review (§16.6).

## Public API (`index.ts`)
- `createTranslator({ localeChain, overrides?, onMissingKey? })` → `t(key, params?)`. Lookup: each locale of
  the chain (tenant override, then built-in), then en-US. Unknown key renders the key; warns once in dev.
- `buildLocaleChain` / `resolveUiLocale` (user → branch → company → en-US), `resolveCustomerCommunicationLocale`,
  `resolveTimeZone`, `directionOf` / `isRtl` (`he-IL` is `rtl`).
- `formatDate/Time/DateTime(WithZone)` (explicit IANA time zone required), `formatNumber`, `formatPercent`,
  `formatMoneyFromMinorUnits` (integer cents, no floats), `formatPhone` (E.164 in, NANP pretty-printed, others unchanged),
  `isolateLtr` for numbers/phones/emails inside RTL text.

## Adding a language
Add it to `SUPPORTED_LOCALES` and `DIRECTION_BY_LOCALE`, add a catalog JSON and register it in `catalogs.ts`,
widen the DB CHECK constraints on locale columns. `npm run i18n:check` tells you what is missing.

## i18n:check
`npm run i18n:check` fails on missing/extra keys, bad key format, empty values, placeholder drift, and
hardcoded user-facing text in `src/app` and `src/components` `.tsx` files (parsed with the TypeScript compiler: JsxText nodes and
literal `title/placeholder/alt/aria-label` attributes). Ignores `src/app/dev/**` and test files. For a legitimate
literal (brand name) add an `i18n-ignore` comment on the same line.
