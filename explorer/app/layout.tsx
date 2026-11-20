import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "PriceCatcher Explorer",
  description: "Item prices over time by state, from OpenDOSM PriceCatcher",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
