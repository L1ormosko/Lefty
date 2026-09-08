import { requireUser } from "@/server/auth";
import { exportUserData } from "@/server/account";
import { AppError } from "@/server/errors";

/**
 * The "right to see what you hold on me" half of the privacy policy.
 *
 * A route rather than a server action because the result is a file the user
 * downloads. It only ever exports the signed-in user's own data - there is no
 * id parameter to tamper with.
 */
export async function GET() {
  let data;
  try {
    const user = await requireUser();
    data = await exportUserData(user.id);
  } catch (err) {
    if (err instanceof AppError) {
      return new Response(err.message, { status: err.httpStatus });
    }
    console.error("[velto] data export failed:", err);
    return new Response("export failed", { status: 500 });
  }

  const stamp = new Date().toISOString().slice(0, 10);
  return new Response(JSON.stringify(data, null, 2), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="velto-my-data-${stamp}.json"`,
      // Personal data: never let a shared cache hold on to it.
      "Cache-Control": "no-store, private",
    },
  });
}
