import { redirect } from "next/navigation";
import { getCurrentUser } from "@/server/auth";

/**
 * Advertiser area. The guard is here and repeated in every action - a layout
 * check alone is never the authorization boundary.
 */
export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser();
  if (!user) redirect("/login?next=/dashboard");
  if (user.role === "MEDIA_OWNER") redirect("/owner");
  return <>{children}</>;
}
