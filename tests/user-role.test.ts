import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, makeUser, prisma } from "./factories";

/**
 * Appointing an admin, and the two ways it could go badly wrong.
 *
 * This capability did not exist, and its absence had a sharp edge: whoever the
 * seed created was the only admin the platform would ever have, because the
 * production database accepts no external connections and there was no way to
 * promote anyone through the interface.
 *
 * Adding it introduces the opposite hazard - demoting the last admin leaves a
 * platform nobody can administer and no way back in. Both guards are pinned
 * here.
 */

const requireRoleMock = vi.hoisted(() => vi.fn());
vi.mock("@/server/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/auth")>()),
  requireRole: requireRoleMock,
}));
// Next's cache helpers have no request scope under Vitest.
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const { setUserRoleAction } = await import("@/app/actions/admin");

const form = (userId: string, role: string) => {
  const data = new FormData();
  data.set("userId", userId);
  data.set("role", role);
  return data;
};

let admin: { id: string; email: string; role: string };
let advertiser: { id: string; email: string; role: string };

beforeEach(async () => {
  await cleanup();
  admin = await makeUser("ADMIN");
  advertiser = await makeUser("ADVERTISER");
  requireRoleMock.mockResolvedValue({ id: admin.id, role: "ADMIN", email: admin.email });
});

afterAll(async () => {
  await cleanup();
});

describe("changing a role", () => {
  it("promotes an advertiser to admin", async () => {
    const res = await setUserRoleAction(undefined, form(advertiser.id, "ADMIN"));
    expect(res?.ok).toBe(true);

    const after = await prisma.user.findUnique({ where: { id: advertiser.id } });
    expect(after!.role).toBe("ADMIN");
  });

  it("writes an audit entry naming both ends of the change", async () => {
    await setUserRoleAction(undefined, form(advertiser.id, "MEDIA_OWNER"));

    const entry = await prisma.auditLog.findFirst({
      where: { action: "USER_ROLE_CHANGED", targetId: advertiser.id },
    });
    expect(entry).not.toBeNull();
    expect(entry!.summary).toContain("ADVERTISER");
    expect(entry!.summary).toContain("MEDIA_OWNER");
    expect(entry!.actorId).toBe(admin.id);
  });

  it("refuses to change your own role", async () => {
    const res = await setUserRoleAction(undefined, form(admin.id, "ADVERTISER"));
    expect(res?.ok).toBe(false);

    const after = await prisma.user.findUnique({ where: { id: admin.id } });
    expect(after!.role).toBe("ADMIN");
  });

  it("refuses to demote the last active admin", async () => {
    // The acting admin is not the target here, so the self-check does not
    // cover this: a second admin demoting the first would empty the platform.
    const other = await makeUser("ADMIN");
    requireRoleMock.mockResolvedValue({ id: other.id, role: "ADMIN", email: other.email });
    await prisma.user.update({ where: { id: other.id }, data: { isActive: false } });

    /*
     * The guard counts admins across the whole platform, which is the only
     * way it can mean anything - and this database is shared with the seed,
     * which creates an admin of its own. Without standing those down, the
     * count never reaches zero and this test passes for the wrong reason.
     *
     * They are restored in `finally`, so a failed assertion cannot leave the
     * local database without an admin.
     */
    const bystanders = await prisma.user.findMany({
      where: { role: "ADMIN", isActive: true, id: { notIn: [admin.id, other.id] } },
      select: { id: true },
    });
    await prisma.user.updateMany({
      where: { id: { in: bystanders.map((b) => b.id) } },
      data: { isActive: false },
    });

    try {
      const res = await setUserRoleAction(undefined, form(admin.id, "ADVERTISER"));
      expect(res?.ok).toBe(false);
      expect(await prisma.user.findUnique({ where: { id: admin.id } })).toMatchObject({
        role: "ADMIN",
      });
    } finally {
      await prisma.user.updateMany({
        where: { id: { in: bystanders.map((b) => b.id) } },
        data: { isActive: true },
      });
    }
  });

  it("allows demoting an admin while another active one remains", async () => {
    const other = await makeUser("ADMIN");
    requireRoleMock.mockResolvedValue({ id: other.id, role: "ADMIN", email: other.email });

    const res = await setUserRoleAction(undefined, form(admin.id, "ADVERTISER"));
    expect(res?.ok).toBe(true);
    expect(await prisma.user.findUnique({ where: { id: admin.id } })).toMatchObject({
      role: "ADVERTISER",
    });
  });

  it("refuses a role that is not one of the three", async () => {
    const res = await setUserRoleAction(undefined, form(advertiser.id, "SUPERUSER"));
    expect(res?.ok).toBe(false);
    expect(await prisma.user.findUnique({ where: { id: advertiser.id } })).toMatchObject({
      role: "ADVERTISER",
    });
  });

  it("is a no-op when the role is already what was asked for", async () => {
    const res = await setUserRoleAction(undefined, form(advertiser.id, "ADVERTISER"));
    expect(res?.ok).toBe(true);
    // No audit noise for a change that did not happen.
    const entries = await prisma.auditLog.count({
      where: { action: "USER_ROLE_CHANGED", targetId: advertiser.id },
    });
    expect(entries).toBe(0);
  });

  it("refuses a user that does not exist", async () => {
    const res = await setUserRoleAction(undefined, form("nope", "ADMIN"));
    expect(res?.ok).toBe(false);
  });
});
