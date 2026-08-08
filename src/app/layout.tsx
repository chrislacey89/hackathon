import type { Metadata } from "next";
import { Montserrat } from "next/font/google";
import type { ReactNode } from "react";
import "./globals.css";

/**
 * Montserrat is JA's official brand typeface (brand guide §5).
 *
 * Loaded through `next/font` rather than a Google Fonts `<link>` so it is
 * self-hosted and subset at build time — no render-blocking request, no layout
 * shift. Only the five weights the guide names are pulled.
 */
const montserrat = Montserrat({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700", "800"],
  display: "swap",
  variable: "--font-montserrat",
});

export const metadata: Metadata = {
  title: "Volunteer Intent Router — Junior Achievement of Northern Indiana",
  description:
    "Volunteers who expressed a forward-looking offer, grouped by who should follow up, each carrying the sentence that triggered it.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={montserrat.variable}>
      <body>{children}</body>
    </html>
  );
}
