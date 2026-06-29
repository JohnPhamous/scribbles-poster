import type { Metadata, Viewport } from "next";
import { Nanum_Pen_Script } from "next/font/google";
import "./globals.css";

const titleFont = Nanum_Pen_Script({
  display: "swap",
  subsets: ["latin"],
  variable: "--font-title",
  weight: "400",
});

export const metadata: Metadata = {
  title: "Scribbles Poster",
  description: "Collaborative printable poster.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className={titleFont.variable}>{children}</body>
    </html>
  );
}
