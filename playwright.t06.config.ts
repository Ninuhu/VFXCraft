import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

export default defineConfig({
    ...base,
    testMatch: "t06-3d.spec.ts",
    projects: [
        { name: "Chrome", use: { channel: "chrome" } },
        { name: "Edge", use: { channel: "msedge" } },
    ],
});
