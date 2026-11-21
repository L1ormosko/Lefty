import type { ReactNode } from "react";
import "../../globals.css";

// Tailwind styles are loaded here (not in the root layout) so the dev gallery is self-contained.
export default function DevUiLayout({ children }: { children: ReactNode }) {
  return children;
}
