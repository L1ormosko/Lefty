import { NextResponse } from "next/server";
import { mapQuerySchema } from "@/lib/validation";
import { queryMapAssets } from "@/server/assets";

/**
 * Public inventory for the map. Bounding-box filtered server-side and returned
 * as a minimal projection - full detail is fetched only when an asset is opened.
 */
export async function GET(request: Request) {
  const params = Object.fromEntries(new URL(request.url).searchParams);
  const parsed = mapQuerySchema.safeParse(params);
  if (!parsed.success) {
    return NextResponse.json({ error: "פרמטרים לא תקינים" }, { status: 400 });
  }
  try {
    const assets = await queryMapAssets(parsed.data);
    return NextResponse.json(
      { assets, count: assets.length },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (err) {
    console.error("[velto] /api/assets failed:", err);
    return NextResponse.json({ error: "אירעה שגיאה בטעינת השטחים." }, { status: 500 });
  }
}
