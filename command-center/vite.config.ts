import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "0.0.0.0",
    port: 5173,
    allowedHosts: true,
    proxy: {
      "/api": "http://127.0.0.1:8787",
    },
  },
  preview: { host: "0.0.0.0", port: 5173 },
  test: {
    environment: "jsdom",
    setupFiles: "./src/test-setup.ts",
  },
});
