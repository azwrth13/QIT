import Link from 'next/link';
import Navbar from "./navbar/navbar";
import './globals.css';
import { Press_Start_2P, Space_Grotesk } from 'next/font/google';

const pixel = Press_Start_2P({ weight: '400', subsets: ['latin'], variable: '--font-press-start' });
const grotesk = Space_Grotesk({ subsets: ['latin'], variable: '--font-space-grotesk' });

export const metadata = {
  title: 'QIT - Steam Game Library',
  description: 'Explore and manage your Steam game library',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className={`${pixel.variable} ${grotesk.variable} bg-[#FFFEF7] text-black min-h-screen flex flex-col`}>
          <Navbar />
          <main className="flex-1">
            {children}
          </main>
          <footer className="border-t-4 border-black py-6 mt-12 bg-neobrutal-yellow">
            <div className="container mx-auto px-4 text-center">
              <Link href="/privacy" className="inline-block mb-2 font-bold underline">Privacy &amp; data controls</Link>
              <p className="text-sm font-bold">© {new Date().getFullYear()} Qit. All rights reserved.</p>
            </div>
          </footer>
      </body>
    </html>
  );
}
