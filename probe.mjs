import { chromium } from "@playwright/test";
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env","utf8").split("\n")) {
  const m = /^([A-Z0-9_]+)="?([^"\n]*)"?$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
const b = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome", args: ["--no-sandbox","--enable-unsafe-swiftshader"] });
const p = await b.newPage({ locale: "he-IL" });
await p.goto("http://localhost:3000/login");
await p.locator("#email").fill("admin@velto.dev");
await p.locator("#password").fill(process.env.SEED_PASSWORD);
await p.getByRole("button", { name: "כניסה לחשבון" }).click();
await p.waitForURL(/admin|dashboard|owner/);
await p.goto("http://localhost:3000/admin/users");
await p.waitForTimeout(2500);
console.log("buttons:", JSON.stringify(await p.getByRole("button").allInnerTexts()));
console.log("owner row present:", await p.getByText("owner@velto.dev").count());
await b.close();
