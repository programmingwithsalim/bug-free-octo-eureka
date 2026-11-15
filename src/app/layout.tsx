import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = { title: "Trade Journal", description: "Journal, analyse and improve your trading." };
export const viewport: Viewport = { width: "device-width", initialScale: 1 };

// Runs before first paint so the saved (or system) theme never flashes the wrong colours.
const THEME_INIT = `try{var t=localStorage.getItem("tj-theme");if(t!=="light"&&t!=="dark")t=matchMedia("(prefers-color-scheme: light)").matches?"light":"dark";document.documentElement.dataset.theme=t}catch(e){document.documentElement.dataset.theme="dark"}`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head><script dangerouslySetInnerHTML={{ __html: THEME_INIT }} /></head>
      <body>{children}</body>
    </html>
  );
}
