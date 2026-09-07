import { redirect } from "next/navigation";
import { getCurrentUser } from "@/server/auth";

/** Media owner area. Admins may enter to inspect; advertisers may not. */
export default async function OwnerLayout({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser();
  if (!user) redirect("/login?next=/owner");
  if (user.role === "ADVERTISER") redirect("/dashboard");
  return <>{children}</>;
}
