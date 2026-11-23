import { defineConfig } from "@playwright/test";
import base from "./playwright.t10.config";

export default defineConfig({ ...base, testMatch: ["t10-editor.spec.ts"],
    webServer: { command: "pnpm exec vite preview --host 127.0.0.1 --port 5174 --strictPort", url: "http://127.0.0.1:5174/", reuseExistingServer: false },
});
