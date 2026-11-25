import { defineConfig } from "@playwright/test";
import base from "./playwright.t10.config";

export default defineConfig({ ...base,
    use: { ...base.use, actionTimeout: 15_000 },
    testMatch: [...(base.testMatch as string[]), "t11-recovery.spec.ts", "t11-performance.spec.ts"],
});
