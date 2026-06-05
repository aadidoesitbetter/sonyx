import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{js,ts,jsx,tsx,mdx}"],
  theme: {
    extend: {
      colors: {
        sonyx: {
          purple: "#7B2FBE",
          dark: "#1a0a2e",
        },
      },
    },
  },
  plugins: [],
};

export default config;
