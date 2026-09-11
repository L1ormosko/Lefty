# VELTO

A B2B marketplace for physical outdoor advertising in Israel. Advertisers find,
compare and request billboard inventory on a map; media owners publish and
manage their own inventory; VELTO stays neutral — it never owns the assets.

Interface is Hebrew-first and right-to-left. The map covers all of Israel; only
assets that actually exist in the database appear as inventory.

## What the product is for

A map of other people's billboards is a directory. What VELTO holds that nobody
else does is the calendar — when each listed asset is free, and when the
contract on it ends. Three features turn that into the reason to use it:

- **`/brief`** — describe a campaign in one sentence (or fill in the fields) and
  get a ranked shortlist of real inventory, each result showing why it matched
  **and what is unknown about it**. Optionally parsed by a language model; the
  model produces a filter, never a result.
- **The renewal pipeline** (`/owner`) — which of an owner's bookings end in the
  next 60 days, which is exactly when that space should be sold again.
- **"Frees up soon"** (`/brief`) — the same data from the advertiser's side.

What the product deliberately does **not** do is estimate an audience. There are
no impressions, no traffic counts and no demographics anywhere in it, because we
have none; location context is declared by the owner and labelled as declared.
See DECISIONS.md §18.

## Running it locally

    service postgresql start                # or point DATABASE_URL elsewhere
    cp .env.example .env                    # fill in DATABASE_URL
    npm install
    npx prisma migrate dev
    npm run seed:dev
    npm run dev

`npm run seed:dev` creates four development logins. It needs `SEED_PASSWORD`
(at least 24 characters) and refuses to run without it — there is no built-in
password, because this seed creates an ADMIN account and runs against whatever
`DATABASE_URL` points at. The password is never printed either: build logs are
retained and readable. Set `SEED_DEMO=1` to create demo data at all.

## Scripts

| Script | What it does |
| --- | --- |
| `npm run dev` | development server |
| `npm run build` / `npm start` | production build and server |
| `npm run typecheck` | TypeScript, no emit |
| `npm test` | Vitest — unit + integration against the database |
| `npm run test:e2e` | Playwright — advertiser / owner / admin journeys |
| `npm run seed:dev` | reset and recreate the demo inventory |
| `npm run backup:check <file>` | compare a backup file against the live database |
| `npm run backup:restore <file>` | restore a backup into an empty database |

## Backup and restore

**The hosted free-tier database is deleted on 2026-10-07 and has no backups.**
Copy the data out before then. Put a reminder in a calendar; nothing here does.

1. Sign in as an ADMIN and download `/api/admin/backup`. The file is named
   `velto-backup-SENSITIVE-<date>.json` and it deserves that name: it holds
   every user's personal data and their bcrypt password hashes. Do not leave it
   in a downloads folder.
2. `npm run backup:check ./velto-backup-SENSITIVE-<date>.json` — run it against
   the same database it came from. A file nobody has checked is not a backup.
3. To restore: point `DATABASE_URL` at the new, empty database, run
   `npx prisma migrate deploy`, then
   `npm run backup:restore ./velto-backup-SENSITIVE-<date>.json`. It refuses a
   database that already has users unless you pass `--force`, and it writes
   everything in one transaction, so it either completes or changes nothing.

Sessions are deliberately not backed up — everyone signs in again after a
restore, which is the correct outcome. See DECISIONS.md §17 for why the backup
goes out through the app instead of `pg_dump`.

## Maps

MapLibre GL with a keyless OpenStreetMap raster style by default, which is fine
for development. Production traffic needs a commercial tile provider: set
`NEXT_PUBLIC_MAP_STYLE_URL` to a style URL whose key lives in the environment.

## Documentation

- `ARCHITECTURE.md` — how the pieces fit together
- `DECISIONS.md` — the decisions worth not re-litigating
- `PROJECT_STATE.md` — current state and next steps
- `TODO.md` — what is left
