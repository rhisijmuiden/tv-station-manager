import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { brandDir } from "../../branding/brand.mjs";

export default defineConfig({
  root: "web",
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@brand": brandDir() } },
  build: { outDir: "../dist/web", emptyOutDir: true },
  server: {
    port: 5174,
    proxy: { "/api": "http://127.0.0.1:8081" },
    fs: { allow: ["../.."] },
  },
});
