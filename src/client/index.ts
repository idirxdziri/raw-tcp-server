// ============================================================================
// client/index.ts — Client Entry Point
// ============================================================================

import { TCPClient } from "./tcp-client.js";

const HOST = process.env.HOST || "127.0.0.1";
const PORT = parseInt(process.env.PORT || "9000", 10);
const AUTO_RECONNECT = process.env.AUTO_RECONNECT !== "false"; // Default: true

async function main(): Promise<void> {
  console.log("\n╔══════════════════════════════════════════════════════╗");
  console.log("║          🖥️  RAW TCP CLIENT                          ║");
  console.log("╠══════════════════════════════════════════════════════╣");
  console.log(`║  Target: ${HOST}:${PORT}`.padEnd(55) + "║");
  console.log(
    `║  Auto-Reconnect: ${AUTO_RECONNECT ? "ON (exponential backoff + jitter)" : "OFF"}`.padEnd(
      55,
    ) + "║",
  );
  console.log("╚══════════════════════════════════════════════════════╝");

  const client = new TCPClient({
    host: HOST,
    port: PORT,
    autoReconnect: AUTO_RECONNECT,
  });

  // Handle Ctrl+C gracefully
  process.on("SIGINT", () => {
    console.log("\n\n  📡 Received SIGINT — disconnecting...");
    client.disconnect();
    setTimeout(() => process.exit(0), 1000);
  });

  try {
    await client.connect();
  } catch (error) {
    // Initial connection failed — reconnect manager will handle retries
    // if auto-reconnect is enabled
    if (!AUTO_RECONNECT) {
      console.error("\n  Connection failed. Start the server first:");
      console.error("    npx tsx src/server/index.ts\n");
      process.exit(1);
    }
  }
}

main();
