import { defineConfig } from "vitest/config";

// Opt-in suites that drive real external binaries; kept out of `npm run check`.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.integration.ts"],
  },
});
