import { readFileSync } from "node:fs";

// Load .env without adding a dependency.
try {
  for (const line of readFileSync(".env", "utf8").split("\n")) {
    const match = /^([A-Z0-9_]+)="?([^"\n]*)"?$/.exec(line.trim());
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2];
  }
} catch {
  // .env is optional when the environment already provides the variables.
}

// Integration tests talk to a real database, so never let them point at
// something that is not a VELTO development database.
if (!process.env.DATABASE_URL?.includes("velto")) {
  throw new Error("DATABASE_URL is not a VELTO development database");
}
