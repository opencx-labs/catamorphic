import type { Metadata } from "next";
import { PlaygroundProviders } from "@/lib/providers";
import "./globals.css";

export const metadata: Metadata = {
  title: "Catamorphic AI",
  description: "Code-first workflow builder",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body
        className="antialiased min-h-screen"
        style={{
          background: "var(--background)",
          color: "var(--foreground)",
        }}
      >
        <PlaygroundProviders>
          <header
            className="sticky top-0 z-50 backdrop-blur-sm"
            style={{
              borderBottom: "1px solid var(--border)",
              background:
                "color-mix(in oklch, var(--background) 80%, transparent)",
            }}
          >
            <div className="max-w-screen-2xl mx-auto px-6 h-14 flex items-center justify-between">
              <a
                href="/"
                className="flex items-center gap-2 font-semibold text-lg"
              >
                <span style={{ color: "var(--warm)" }}>◆</span>
                <span>Catamorphic</span>
              </a>
              <nav
                className="flex items-center gap-6 text-sm transition-colors"
                style={{ color: "var(--muted-foreground)" }}
              >
                <a
                  href="/"
                  className="transition-colors hover:[color:var(--foreground)]"
                >
                  Projects
                </a>
                <a
                  href={`${process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001"}/docs`}
                  target="_blank"
                  rel="noreferrer"
                  className="transition-colors hover:[color:var(--foreground)]"
                >
                  API Docs
                </a>
              </nav>
            </div>
          </header>
          {children}
        </PlaygroundProviders>
      </body>
    </html>
  );
}
