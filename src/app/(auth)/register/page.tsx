import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/server/auth";
import { RegisterForm } from "./RegisterForm";

export const metadata: Metadata = { title: "הרשמה" };

export default async function RegisterPage({
  searchParams,
}: {
  searchParams: Promise<{ role?: string }>;
}) {
  const user = await getCurrentUser();
  if (user) redirect(user.role === "MEDIA_OWNER" ? "/owner" : user.role === "ADMIN" ? "/admin" : "/dashboard");
  const { role } = await searchParams;
  return <RegisterForm defaultRole={role === "MEDIA_OWNER" ? "MEDIA_OWNER" : "ADVERTISER"} />;
}
