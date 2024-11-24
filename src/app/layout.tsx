import Navbar from "./navbar/navbar";
import './globals.css';

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-[#1b2838] text-white">
        <Navbar />
        <main>{children}</main>
        <footer className="border-t border-[#2a475e] py-4 mt-auto">
          <div className="container mx-auto px-4 text-center text-sm text-gray-400">
            <p>© 2024 GMLNK. All rights reserved.</p>
            <div className="flex justify-center space-x-4 mt-2">
              <a href="/privacy" className="hover:text-white">Privacy Policy</a>
              <a href="/terms" className="hover:text-white">Terms of Service</a>
              <a href="/contact" className="hover:text-white">Contact Us</a>
            </div>
          </div>
        </footer>
      </body>
    </html>
  );
}
