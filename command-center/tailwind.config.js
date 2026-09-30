export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: "#14120f",
        panel: "#211e19",
        line: "#3c352c",
        cream: "#f6f1e7",
        mute: "#b7ad9e",
        hi: "#f0c14b",
        need: "#ff4d3a",
        safe: "#3cbf7a",
        evac: "#f08a24",
      },
      fontFamily: {
        sans: ["Source Sans 3", "Segoe UI", "Noto Sans", "Noto Sans Devanagari", "sans-serif"],
        display: ["Barlow Condensed", "Arial Narrow", "sans-serif"],
      },
    },
  },
  plugins: [],
};
