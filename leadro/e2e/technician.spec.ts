import { expect, test } from "@playwright/test";
import { navigationPaths, signIn, text } from "./helpers";
import { readFixture } from "./setup/fixture";

const fixture = readFixture();

test("the Technician has no admin navigation and is refused every administration screen", async ({ page }) => {
  await signIn(page, fixture.technician, fixture.password);

  const paths = await navigationPaths(page);
  expect(paths.filter((path) => path.startsWith("/admin"))).toEqual([]);

  for (const screen of ["/admin/company", "/admin/users", "/admin/roles", "/admin/localization"]) {
    await page.goto(screen);
    await expect(page.getByText(text("en-US", "ADMIN.ACCESS_DENIED_TITLE")), screen).toBeVisible();
  }
});

test("opening /admin/employees directly shows the Technician only their own record", async ({ page }) => {
  // By design (spec 4.5) a Technician may view their OWN employee record, so the directory URL is
  // not an access-denied page for them: it must simply never list anybody else.
  await signIn(page, fixture.technician, fixture.password);
  await page.goto("/admin/employees");

  await expect(page.getByRole("heading", { level: 1, name: text("en-US", "ADMIN.EMPLOYEES_TITLE") })).toBeVisible();
  await expect(page.getByRole("row")).toHaveCount(2); // header + their own row
  await expect(page.getByRole("cell", { name: "E-0001", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: text("en-US", "ADMIN.EMPLOYEE_ADD") })).toHaveCount(0);
});
