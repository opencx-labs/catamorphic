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
    <html lang="en" className="dark">
      <body className="bg-neutral-950 text-neutral-50 antialiased min-h-screen">
        <PlaygroundProviders>
          <header className="border-b border-neutral-800 bg-neutral-950/80 backdrop-blur-sm sticky top-0 z-50">
            <div className="max-w-screen-2xl mx-auto px-6 h-14 flex items-center justify-between">
              <a
                href="/"
                className="flex items-center gap-2 font-semibold text-lg"
              >
                <span className="text-blue-500">◆</span>
                <span>Catamorphic</span>
              </a>
              <nav className="flex items-center gap-6 text-sm text-neutral-400">
                <a
                  href="/"
                  className="hover:text-neutral-100 transition-colors"
                >
                  Projects
                </a>
                <a
                  href={`${process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001"}/docs`}
                  target="_blank"
                  rel="noreferrer"
                  className="hover:text-neutral-100 transition-colors"
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
