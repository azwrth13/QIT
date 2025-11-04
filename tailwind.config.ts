import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        background: "var(--background)",
        foreground: "var(--foreground)",
        neobrutal: {
          yellow: "#FFE66D",
          pink: "#FF6B6B",
          blue: "#4ECDC4",
          green: "#95E1D3",
          purple: "#A8E6CF",
          border: "#000000",
        },
      },
      borderWidth: {
        'neobrutal': '4px',
      },
      boxShadow: {
        'neobrutal': '4px 4px 0px 0px #000000',
        'neobrutal-sm': '2px 2px 0px 0px #000000',
        'neobrutal-lg': '6px 6px 0px 0px #000000',
      },
      fontFamily: {
        'pixel': ['Press Start 2P', 'monospace'],
        'grotesk': ['Space Grotesk', 'sans-serif'],
      },
    },
  },
  plugins: [],
};
export default config;
