import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
    plugins: [react()],
    server: { warmup: { clientFiles: ["./src/main.tsx", "./src/app/editor/EditorApp.tsx", "./src/app/App.tsx"] } }, // 検証ページも初回の変換集中を避ける
    optimizeDeps: { include: ["react", "react-dom/client", "react/jsx-runtime", "three", "@zip.js/zip.js"] }, // 既存依存のみを事前最適化する
});
