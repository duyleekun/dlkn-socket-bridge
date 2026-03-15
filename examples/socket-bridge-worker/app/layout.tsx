import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Socket Bridge Dashboard",
  description: "Telegram + Zalo realtime bridge via Cloudflare Workers",
};

export const viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark">
      <body className="antialiased font-sans">
        {children}
      </body>
    </html>
  );
}
