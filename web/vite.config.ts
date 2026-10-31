import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// In dev, forward API calls to the Node server (`npm run dev` in the repo root).
const api = process.env.API_URL ?? "http://localhost:3000";
export default defineConfig({
  plugins: [react()],
  server: { proxy: { "/events": api, "/stats": api, "/health": api } },
});
