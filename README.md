# VELTO

A B2B marketplace for physical outdoor advertising in Israel. Advertisers find,
compare and request billboard inventory on a map; media owners publish and
manage their own inventory; VELTO stays neutral — it never owns the assets.

Interface is Hebrew-first and right-to-left. The map covers all of Israel; only
assets that actually exist in the database appear as inventory.

## Running it locally

    service postgresql start                # or point DATABASE_URL elsewhere
    cp .env.example .env                    # fill in DATABASE_URL
    npm install
    npx prisma migrate dev
    npm run seed:dev
    npm run dev

`npm run seed:dev` prints four development logins. They exist only in a local
development database and are printed, never committed.

## Scripts

| Script | What it does |
| --- | --- |
| `npm run dev` | development server |
| `npm run build` / `npm start` | production build and server |
| `npm run typecheck` | TypeScript, no emit |
| `npm test` | Vitest — unit + integration against the database |
| `npm run test:e2e` | Playwright — advertiser / owner / admin journeys |
| `npm run seed:dev` | reset and recreate the demo inventory |

## Maps

MapLibre GL with a keyless OpenStreetMap raster style by default, which is fine
for development. Production traffic needs a commercial tile provider: set
`NEXT_PUBLIC_MAP_STYLE_URL` to a style URL whose key lives in the environment.

## Documentation

- `ARCHITECTURE.md` — how the pieces fit together
- `DECISIONS.md` — the decisions worth not re-litigating
- `PROJECT_STATE.md` — current state and next steps
- `TODO.md` — what is left
