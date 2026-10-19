import { spawn } from "node:child_process";

console.log("[wisal-runner] Starting Wisal production stack (Web + Worker)...");

// 1. Start the Background Worker
console.log("[wisal-runner] Spawning background worker...");
const worker = spawn("node", ["--dns-result-order=ipv4first", "--import", "tsx", "src/worker/index.ts"], {
  stdio: "inherit",
  env: process.env,
});

worker.on("error", (err) => {
  console.error("[wisal-runner] Worker process error:", err);
});

worker.on("exit", (code, signal) => {
  console.warn(`[wisal-runner] Worker exited with code=${code} signal=${signal}`);
});

// 2. Start the Next.js Web Server
console.log("[wisal-runner] Spawning Next.js web server...");
const web = spawn("npx", ["next", "start", "-p", process.env.PORT || "3000"], {
  stdio: "inherit",
  env: process.env,
});

web.on("error", (err) => {
  console.error("[wisal-runner] Web server process error:", err);
});

web.on("exit", (code, signal) => {
  console.log(`[wisal-runner] Web server exited with code=${code} signal=${signal}`);
  worker.kill();
  process.exit(code ?? 0);
});

// Clean shutdown handlers
function shutdown() {
  console.log("[wisal-runner] Shutting down all processes...");
  try {
    worker.kill();
    web.kill();
  } catch {
    // Ignore error on kill
  }
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
