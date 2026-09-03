import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import packageMetadata from "./package.json" with { type: "json" };

export default defineConfig({
  define: {
    __MACHORA_VERSION__: JSON.stringify(packageMetadata.version),
  },
  build: {
    outDir: "dist/client",
  },
  optimizeDeps: {
    include: ["react", "react-dom/client"],
  },
  server: {
    host: "0.0.0.0",
    allowedHosts: ["terminal.local"],
    warmup: {
      clientFiles: ["./src/main.jsx"],
    },
  },
  plugins: [react()],
});
