export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex-1 flex items-start justify-center px-4 py-10 sm:py-16">
      <div className="w-full max-w-md">{children}</div>
    </main>
  );
}
