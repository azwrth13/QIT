import Navbar from "./navbar/navbar";
import './globals.css';
import { Providers } from './providers';

export const metadata = {
  title: 'QIT - Steam Game Library',
  description: 'Explore and manage your Steam game library',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="bg-[#FFFEF7] text-black min-h-screen flex flex-col">
        <Providers>
          <Navbar />
          <main className="flex-1">
            {children}
          </main>
          <footer className="border-t-4 border-black py-6 mt-12 bg-neobrutal-yellow">
            <div className="container mx-auto px-4 text-center">
              <p className="text-sm font-bold">© 2024 Qit. All rights reserved.</p>
            </div>
          </footer>
        </Providers>
      </body>
    </html>
  );
}
