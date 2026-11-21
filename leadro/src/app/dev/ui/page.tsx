import { notFound } from "next/navigation";
import { UiGallery } from "./UiGallery";

export const metadata = { title: "LEADRO UI gallery (dev only)" };

/** Developer-only component gallery; hidden in production builds. */
export default function UiGalleryPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return (
    <main className="mx-auto max-w-5xl space-y-10 p-6">
      <h1 className="text-2xl font-bold">UI gallery</h1>
      <p className="text-sm text-ink-muted">
        Every shared component, rendered once left-to-right and once right-to-left. Text here is
        demo content only; real screens pass translated strings.
      </p>
      <section aria-label="LTR">
        <h2 className="mb-3 text-lg font-semibold">LTR (en-US)</h2>
        <div dir="ltr">
          <UiGallery dir="ltr" />
        </div>
      </section>
      <section aria-label="RTL">
        <h2 className="mb-3 text-lg font-semibold">RTL (he-IL)</h2>
        <div dir="rtl">
          <UiGallery dir="rtl" />
        </div>
      </section>
    </main>
  );
}
