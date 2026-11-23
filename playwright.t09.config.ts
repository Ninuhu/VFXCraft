import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

export default defineConfig({
    ...base,
    testMatch: ["t05-particles.spec.ts", "t06-3d.spec.ts", "t07-materials.spec.ts", "t08-timeline.spec.ts",
        "t08-performance.spec.ts", "t09-hierarchy.spec.ts", "t09-performance.spec.ts"],
    timeout: 150_000,
    projects: [
        { name: "Chrome", use: { channel: "chrome" } },
        { name: "Edge", use: { channel: "msedge" } },
    ],
});
