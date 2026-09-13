import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

// shadcn/ui's theme resolves --font-sans / --font-mono, so the loaders must
// publish those exact names.
const fontSans = Geist({
  variable: "--font-sans",
  subsets: ["latin"],
});

const fontMono = Geist_Mono({
  variable: "--font-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Zenstier",
  description: "Centralised remote command execution for your own fleet",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    // The variables must live on <html>: globals.css applies `font-sans` to
    // <html>, and a variable declared on <body> is not visible to its parent.
    <html
      lang="en"
      className={`${fontSans.variable} ${fontMono.variable}`}
      suppressHydrationWarning
    >
      <body className="antialiased">{children}</body>
    </html>
  );
}
