import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/server/auth";
import { LoginForm } from "./LoginForm";

export const metadata: Metadata = { title: "כניסה" };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const user = await getCurrentUser();
  if (user) redirect(user.role === "MEDIA_OWNER" ? "/owner" : user.role === "ADMIN" ? "/admin" : "/dashboard");
  const { next } = await searchParams;
  return <LoginForm next={next} />;
}
