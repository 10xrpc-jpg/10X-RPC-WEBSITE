import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Toaster as Sonner } from "@/components/ui/sonner";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "10X RPC — Premium Discord Rich Presence",
  description: "Take control of your Discord presence. Custom status, rich presence, VR status, game RPC, smart sleep timer, dynamic placeholders, and 24/7 reliability.",
  keywords: ["10X RPC", "Discord RPC", "Rich Presence", "Discord status", "VR status", "Meta Quest"],
  authors: [{ name: "10X RPC" }],
  icons: { icon: "/logo.svg" },
  openGraph: {
    title: "10X RPC",
    description: "Premium Discord Rich Presence management.",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "10X RPC",
    description: "Premium Discord Rich Presence.",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning className="dark">
      <head>
        {/* Legacy "#/..." URL migration — runs inline BEFORE Next.js boots so
            nothing captures or restores the old hash URL. Converts
            "#/games/x" -> "/games/x" in place. Plain anchors ("#section")
            are untouched. */}
        <script
          dangerouslySetInnerHTML={{
            __html:
              "if(location.hash.indexOf('#/')===0){try{history.replaceState(null,'',location.hash.slice(1)||'/')}catch(e){}}",
          }}
        />
      </head>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-[#0a0b0f] text-white min-h-screen`}
      >
        {children}
        <Sonner
          position="top-center"
          toastOptions={{
            style: {
              background: "rgba(20, 21, 28, 0.95)",
              border: "1px solid rgba(168, 85, 247, 0.3)",
              color: "white",
              backdropFilter: "blur(20px)",
            },
          }}
        />
      </body>
    </html>
  );
}
