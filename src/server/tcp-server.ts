// ============================================================================
// tcp-server.ts — Raw TCP Server Implementation
// ============================================================================
//
// BEHIND THE SCENES — What happens when we call net.createServer():
//
// 1. APPLICATION LAYER (our code)
//    └→ net.createServer() — creates a new Server object
//
// 2. NODE.JS INTERNALS (libuv)
//    └→ Calls socket(AF_INET, SOCK_STREAM, IPPROTO_TCP)
//       This asks the OS to create a TCP socket file descriptor (fd).
//       - AF_INET: IPv4 address family
//       - SOCK_STREAM: TCP (reliable, ordered byte stream)
//       - IPPROTO_TCP: explicitly TCP (vs UDP which uses SOCK_DGRAM)
//
// 3. WHEN WE CALL server.listen(port):
//    └→ bind(fd, {address, port}) — Reserve this IP:port for our server
//    └→ listen(fd, backlog) — Tell the kernel to start accepting connections
//       The kernel creates TWO queues:
//         ┌─────────────────────────────────────────────────┐
//         │ SYN Queue (incomplete connections)               │
//         │ Clients that sent SYN, waiting for ACK          │
//         │ → Kernel replies with SYN-ACK automatically     │
//         ├─────────────────────────────────────────────────┤
//         │ Accept Queue (complete connections)              │
//         │ Clients that completed the 3-way handshake      │
//         │ → Waiting for our code to call accept()         │
//         └─────────────────────────────────────────────────┘
//
// 4. WHEN A CLIENT CONNECTS:
//    └→ Kernel completes 3-way handshake (SYN/SYN-ACK/ACK)
//    └→ Connection moves from SYN Queue → Accept Queue
//    └→ epoll/kqueue notifies libuv that a connection is ready
//    └→ libuv calls accept(fd) → returns new socket fd for this client
//    └→ Node.js emits 'connection' event with the new Socket object
//    └→ Our handleConnection() function is called
//
// ============================================================================

import * as net from "node:net";
import { handleConnection } from "./handler";
import { MetricsTracker } from "./metrics.js";

export interface ServerConfig {
  port: number;
  host: string;
  maxConnections?: number; // Limit concurrent connections
}

/**
 * TCPServer — Our raw TCP server implementation
 *
 * Uses Node.js `net.Server` which is a thin wrapper around:
 *   - socket() + bind() + listen() + accept() system calls
 *   - epoll (Linux) / kqueue (macOS) for event notification
 */
export class TCPServer {
  private server: net.Server;
  private metrics: MetricsTracker;
  private config: ServerConfig;
  private connectionCounter: number = 0;
  private isShuttingDown: boolean = false;
  private activeConnections: Set<net.Socket> = new Set();

  constructor(config: ServerConfig) {
    this.config = config;
    this.metrics = new MetricsTracker();

    // ── Create the server ────────────────────────────────────────
    // net.createServer() does NOT call socket() or bind() yet.
    // It just creates the JavaScript Server object and sets up
    // the 'connection' event handler.
    //
    // The callback here fires for each new connection AFTER the
    // kernel has completed the TCP 3-way handshake.
    //
    this.server = net.createServer((socket: net.Socket) => {
      this.onConnection(socket);
    });

    // Set maximum concurrent connections
    // Beyond this, new connections are refused (kernel sends RST)
    if (config.maxConnections) {
      this.server.maxConnections = config.maxConnections;
    }

    // ── Server-Level Error Handling ──────────────────────────────
    this.server.on("error", (error: Error) => {
      const errCode = (error as NodeJS.ErrnoException).code;
      if (errCode === "EADDRINUSE") {
        console.error(`\n❌ Port ${config.port} is already in use!`);
        console.error(`   Another process is bound to this address.`);
        console.error(`   Run: lsof -i :${config.port}  to find the process\n`);
      } else if (errCode === "EACCES") {
        console.error(`\n❌ Permission denied for port ${config.port}`);
        console.error(`   Ports below 1024 require root/admin privileges\n`);
      } else {
        console.error(`\n❌ Server error: ${error.message}\n`);
      }
      process.exit(1);
    });
  }

  /**
   * Start listening for incoming connections.
   *
   * BEHIND THE SCENES:
   * This triggers the following system calls:
   *   1. socket()  → Create socket file descriptor
   *   2. bind()    → Associate socket with IP:port
   *   3. listen()  → Mark socket as passive (accepting connections)
   *
   * After listen(), the socket enters the LISTEN state:
   *   TCP State: CLOSED → LISTEN
   *
   * The kernel's TCP stack now handles incoming SYN packets automatically.
   */
  start(): Promise<void> {
    return new Promise((resolve) => {
      this.server.listen(this.config.port, this.config.host, () => {
        const addr = this.server.address() as net.AddressInfo;

        console.log(
          "\n╔══════════════════════════════════════════════════════╗",
        );
        console.log("║          🖥️  RAW TCP SERVER — Behind the Scenes     ║");
        console.log("╠══════════════════════════════════════════════════════╣");
        console.log(
          `║  Listening on: ${addr.address}:${addr.port}`.padEnd(55) + "║",
        );
        console.log(`║  Socket State: LISTEN`.padEnd(55) + "║");
        console.log(
          `║  Max Connections: ${this.config.maxConnections || "unlimited"}`.padEnd(
            55,
          ) + "║",
        );
        console.log("╠══════════════════════════════════════════════════════╣");
        console.log("║  What happened behind the scenes:                   ║");
        console.log("║  1. socket(AF_INET, SOCK_STREAM) → fd created      ║");
        console.log(
          `║  2. bind(fd, ${addr.address}:${addr.port})`.padEnd(55) + "║",
        );
        console.log("║  3. listen(fd, backlog) → accepting connections     ║");
        console.log("║  4. epoll/kqueue now watching for incoming SYNs     ║");
        console.log("╠══════════════════════════════════════════════════════╣");
        console.log("║  Waiting for client connections...                  ║");
        console.log("║  Press Ctrl+C for graceful shutdown                 ║");
        console.log(
          "╚══════════════════════════════════════════════════════╝\n",
        );

        resolve();
      });
    });
  }

  /**
   * Called for each new TCP connection.
   * At this point, the TCP 3-way handshake has ALREADY completed.
   */
  private onConnection(socket: net.Socket): void {
    if (this.isShuttingDown) {
      // Server is shutting down — reject new connections
      socket.end("Server is shutting down\n");
      socket.destroy();
      return;
    }

    this.connectionCounter++;
    const connectionId = `conn-${this.connectionCounter.toString().padStart(4, "0")}`;

    // Track active connections for graceful shutdown
    this.activeConnections.add(socket);
    socket.on("close", () => {
      this.activeConnections.delete(socket);
    });

    console.log(`\n┌─── NEW CONNECTION ─────────────────────────────────────`);
    console.log(`│ ID: ${connectionId}`);
    console.log(`│ Client: ${socket.remoteAddress}:${socket.remotePort}`);
    console.log(`│ Active connections: ${this.activeConnections.size}`);
    console.log(`│`);
    console.log(`│ BTS: Kernel completed TCP 3-way handshake:`);
    console.log(`│   1. Client → SYN (seq=x)`);
    console.log(`│   2. Server → SYN-ACK (seq=y, ack=x+1)`);
    console.log(`│   3. Client → ACK (ack=y+1)`);
    console.log(`│   Socket moved from SYN queue → Accept queue → our code`);
    console.log(
      `└───────────────────────────────────────────────────────────\n`,
    );

    // Delegate to the connection handler
    handleConnection(socket, connectionId, this.metrics);
  }

  /**
   * Graceful shutdown — close all connections properly.
   *
   * BEHIND THE SCENES:
   * 1. Stop accepting new connections (close listening socket)
   * 2. For each active connection:
   *    a. Send a goodbye message
   *    b. Call socket.end() → sends FIN to client
   *    c. Wait for client's FIN+ACK (or timeout)
   * 3. Destroy any remaining connections
   *
   * This is how production servers (Nginx, Apache) handle shutdown:
   * - Stop accepting new requests
   * - Finish processing in-flight requests
   * - Close all connections gracefully
   * - Exit process
   */
  async shutdown(): Promise<void> {
    if (this.isShuttingDown) return;
    this.isShuttingDown = true;

    console.log("\n╔══════════════════════════════════════════════════════╗");
    console.log("║  🛑 GRACEFUL SHUTDOWN INITIATED                     ║");
    console.log("╠══════════════════════════════════════════════════════╣");
    console.log(
      `║  Active connections to close: ${this.activeConnections.size}`.padEnd(
        55,
      ) + "║",
    );
    console.log("╚══════════════════════════════════════════════════════╝\n");

    // Step 1: Stop accepting new connections
    await new Promise<void>((resolve) => {
      this.server.close(() => {
        console.log(
          "  ✓ Stopped accepting new connections (listening socket closed)",
        );
        resolve();
      });
    });

    // Step 2: Gracefully close all active connections
    if (this.activeConnections.size > 0) {
      console.log(
        `  ⏳ Closing ${this.activeConnections.size} active connection(s)...`,
      );

      const closePromises = Array.from(this.activeConnections).map((socket) => {
        return new Promise<void>((resolve) => {
          // Send shutdown notification
          const msg = "EVENT:SHUTDOWN:Server is shutting down. Goodbye!\n";

          // Use end() to send FIN (graceful TCP close)
          socket.end(msg, () => {
            resolve();
          });

          // Force close after 5 seconds if client doesn't respond
          setTimeout(() => {
            if (!socket.destroyed) {
              console.log("  ⚠️  Force-closing unresponsive connection");
              socket.destroy();
            }
            resolve();
          }, 5000);
        });
      });

      await Promise.all(closePromises);
    }

    console.log("\n  ✅ Server shutdown complete. All connections closed.\n");
  }
}
