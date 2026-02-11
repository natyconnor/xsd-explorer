import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "XSD Explorer",
  description: "Read-only XSD schema explorer for fields, types, and enumerations"
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
