import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnvFile } from "./load-env.js";

loadEnvFile();

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const appUrl = String(
  process.env.GARDEN_APP_URL || process.env.PUBLIC_APP_URL || process.env.RENDER_EXTERNAL_URL || ""
)
  .trim()
  .replace(/\/$/, "");

const config = {
  appId: process.env.GARDEN_APP_ID || "tz.garden.app",
  appName: process.env.GARDEN_APP_NAME || "garden",
  webDir: "mobile/www",
  bundledWebRuntime: false,
  backgroundColor: "#0d9488",
  server: {
    androidScheme: "https",
    // Allow http://127.0.0.1 during local device/emulator testing.
    cleartext: true,
  },
  plugins: {
    SplashScreen: {
      launchShowDuration: 1200,
      backgroundColor: "#0d9488",
      showSpinner: false,
    },
    StatusBar: {
      style: "DARK",
      backgroundColor: "#0d9488",
    },
  },
  android: {
    allowMixedContent: true,
  },
  ios: {
    contentInset: "automatic",
    preferredContentMode: "mobile",
  },
};

if (appUrl) {
  config.server.url = appUrl;
  // eslint-disable-next-line no-console
  console.log(`[garden] Capacitor will load ${appUrl}`);
} else {
  // eslint-disable-next-line no-console
  console.warn(
    "[garden] GARDEN_APP_URL / PUBLIC_APP_URL not set — native apps will use bundled mobile/www fallback."
  );
}

const out = path.join(root, "capacitor.config.json");
fs.writeFileSync(out, `${JSON.stringify(config, null, 2)}\n`);
// eslint-disable-next-line no-console
console.log(`[garden] Wrote ${path.relative(root, out)}`);
