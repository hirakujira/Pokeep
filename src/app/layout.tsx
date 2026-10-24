import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = {
  title: "Pokékeep｜寶可夢錄影分析與清倉助手",
  description:
    "從螢幕錄影整理你的 Pokémon GO 收藏，依據團體戰與 PvP 價值，留下值得培養的夥伴。",
};
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="zh-Hant">
      <body>{children}</body>
    </html>
  );
}
