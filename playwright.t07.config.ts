import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

export default defineConfig({
    ...base,
    testMatch: "t07-materials.spec.ts",
    projects: [
        { name: "Chrome", use: { channel: "chrome" } },
        { name: "Edge", use: { channel: "msedge" } },
    ],
});
