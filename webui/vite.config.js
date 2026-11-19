import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

// The bot serves the built files from webui/dist. Dev mode proxies the API and the
// WebSocket to the running musebot process (default 18800) so `npm run web:dev` works.
const target = process.env.MUSEBOT_DEV_TARGET || "http://127.0.0.1:18800";

export default defineConfig({
  plugins: [vue()],
  base: "/",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2020",
    sourcemap: false,
  },
  server: {
    port: 5199,
    proxy: {
      "/api": { target, changeOrigin: true },
      "/stream": { target, ws: true, changeOrigin: true },
    },
  },
});
