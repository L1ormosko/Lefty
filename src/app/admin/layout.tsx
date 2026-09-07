import { redirect } from "next/navigation";
import { getCurrentUser } from "@/server/auth";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser();
  if (!user) redirect("/login?next=/admin");
  if (user.role !== "ADMIN") redirect(user.role === "MEDIA_OWNER" ? "/owner" : "/dashboard");
  return <>{children}</>;
}
