// ============================================================================
// server/index.ts — Server Entry Point
// ============================================================================
// Starts the TCP server and handles OS signals for graceful shutdown.
//
// BEHIND THE SCENES — Process Signals:
// When you press Ctrl+C in the terminal, the OS sends SIGINT to our process.
// If we don't handle it, Node.js will immediately exit (default behavior).
// By catching SIGINT, we can:
//   1. Stop accepting new connections
//   2. Gracefully close existing connections (send FIN to each client)
//   3. Clean up resources
//   4. Exit cleanly
//
// This is how production servers work:
//   - Kubernetes sends SIGTERM before killing a pod
//   - Docker sends SIGTERM, then SIGKILL after timeout
//   - systemd sends SIGTERM for service stop
// ============================================================================

import { TCPServer } from "./tcp-server.js";

const PORT = parseInt(process.env.PORT || "9000", 10);
const HOST = process.env.HOST || "0.0.0.0";
const MAX_CONNECTIONS = parseInt(process.env.MAX_CONNECTIONS || "100", 10);

async function main(): Promise<void> {
  const server = new TCPServer({
    port: PORT,
    host: HOST,
    maxConnections: MAX_CONNECTIONS,
  });

  // Start listening
  await server.start();

  // ── Signal Handlers ──────────────────────────────────────────
  // Handle graceful shutdown signals
  const shutdown = async (signal: string) => {
    console.log(`\n📡 Received ${signal} signal`);
    await server.shutdown();
    process.exit(0);
  };

  // SIGINT: Ctrl+C in terminal
  process.on("SIGINT", () => shutdown("SIGINT"));

  // SIGTERM: Sent by process managers (Docker, Kubernetes, systemd)
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  // Prevent the process from crashing on unhandled errors
  process.on("uncaughtException", (error) => {
    console.error("💥 Uncaught exception:", error);
    shutdown("UNCAUGHT_EXCEPTION");
  });
}

main().catch((error) => {
  console.error("Failed to start server:", error);
  process.exit(1);
});
