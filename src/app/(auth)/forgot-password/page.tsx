import type { Metadata } from "next";
import { ForgotPasswordForm } from "./ForgotPasswordForm";

export const metadata: Metadata = { title: "שכחתי סיסמה" };

export default function ForgotPasswordPage() {
  return <ForgotPasswordForm />;
}
