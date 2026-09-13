import { NextResponse } from "next/server";
import { mapQuerySchema } from "@/lib/validation";
import { queryMapAssets, redactForRestricted } from "@/server/assets";
import { getCurrentUser } from "@/server/auth";
import { viewerAccess } from "@/server/subscription";

/**
 * Inventory for the map. Bounding-box filtered server-side and returned as a
 * minimal projection - full detail is fetched only when an asset is opened.
 *
 * A viewer without a live trial or subscription gets the same listings with
 * the saleable parts removed *before* they are serialised. Redacting in the
 * component would leave the real prices sitting in the network tab.
 */
export async function GET(request: Request) {
  const params = Object.fromEntries(new URL(request.url).searchParams);
  const parsed = mapQuerySchema.safeParse(params);
  if (!parsed.success) {
    return NextResponse.json({ error: "פרמטרים לא תקינים" }, { status: 400 });
  }
  try {
    const rows = await queryMapAssets(parsed.data);
    const viewer = await viewerAccess(await getCurrentUser());
    const assets = viewer.full ? rows : rows.map(redactForRestricted);
    return NextResponse.json(
      { assets, count: assets.length, restricted: !viewer.full },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (err) {
    console.error("[velto] /api/assets failed:", err);
    return NextResponse.json({ error: "אירעה שגיאה בטעינת השטחים." }, { status: 500 });
  }
}
