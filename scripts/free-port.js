/**
 * Free a TCP port before starting the dev server (Windows-friendly).
 * Usage: node scripts/free-port.js [port]
 */
import { execSync } from "node:child_process";

const port = String(process.argv[2] || process.env.PORT || "3780");

function freeWindows() {
  try {
    const out = execSync(`netstat -ano | findstr :${port} | findstr LISTENING`, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const pids = new Set();
    for (const line of out.split(/\r?\n/)) {
      const parts = line.trim().split(/\s+/);
      const pid = parts[parts.length - 1];
      if (pid && /^\d+$/.test(pid) && pid !== "0") pids.add(pid);
    }
    for (const pid of pids) {
      try {
        execSync(`taskkill /PID ${pid} /F`, { stdio: "ignore" });
        // eslint-disable-next-line no-console
        console.log(`[free-port] Stopped PID ${pid} on port ${port}`);
      } catch {
        /* already gone */
      }
    }
  } catch {
    /* nothing listening */
  }
}

if (process.platform === "win32") {
  freeWindows();
} else {
  try {
    execSync(`lsof -ti :${port} | xargs kill -9 2>/dev/null`, { shell: true, stdio: "ignore" });
  } catch {
    /* nothing listening */
  }
}
