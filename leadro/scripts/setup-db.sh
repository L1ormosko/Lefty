#!/usr/bin/env bash
# Idempotent local Postgres bootstrap for LEADRO development and tests.
# Creates the non-superuser app role `leadro` (NOBYPASSRLS, CREATEDB so that
# `prisma migrate` can create its shadow database) and the databases `leadro`
# and `leadro_test`, both owned by that role. Safe to run repeatedly.
#
# Requires a local PostgreSQL 16 server and superuser access via
# `sudo -u postgres psql` (override with PSQL_CMD, e.g. PSQL_CMD="psql -U postgres").
set -euo pipefail

PSQL_CMD="${PSQL_CMD:-sudo -u postgres psql}"
ROLE="${LEADRO_DB_USER:-leadro}"
PASSWORD="${LEADRO_DB_PASSWORD:-leadro}"

run() { $PSQL_CMD -v ON_ERROR_STOP=1 -X -q "$@"; }

run -d postgres <<SQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${ROLE}') THEN
    CREATE ROLE ${ROLE} LOGIN PASSWORD '${PASSWORD}' NOSUPERUSER NOBYPASSRLS CREATEDB;
  ELSE
    ALTER ROLE ${ROLE} LOGIN PASSWORD '${PASSWORD}' NOSUPERUSER NOBYPASSRLS CREATEDB;
  END IF;
END
\$\$;
SQL

for DB in leadro leadro_test; do
  EXISTS=$($PSQL_CMD -d postgres -XtA -c "SELECT 1 FROM pg_database WHERE datname = '${DB}'")
  if [ "${EXISTS}" != "1" ]; then
    run -d postgres -c "CREATE DATABASE ${DB} OWNER ${ROLE}"
    echo "created database ${DB}"
  else
    echo "database ${DB} already exists"
  fi
done
echo "ok: role ${ROLE} and databases leadro, leadro_test are ready"
