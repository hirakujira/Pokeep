import type { Metadata } from "next";
import { IBM_Plex_Mono, IBM_Plex_Sans } from "next/font/google";
import "./globals.css";

const sans = IBM_Plex_Sans({ subsets: ["latin"], variable: "--font-sans" });
const mono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-mono",
});

export const metadata: Metadata = {
  title: "Pokéep｜iPhone 自動掃描與清倉助手",
  description:
    "透過 iPhone Use 掃描 Pokémon GO 收藏，依據團體戰與 PvP 價值，核對並整理寶可夢盒子。",
};
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="zh-Hant" className={`${sans.variable} ${mono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
