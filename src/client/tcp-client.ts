// ============================================================================
// tcp-client.ts — Raw TCP Client Implementation
// ============================================================================
//
// BEHIND THE SCENES — What happens when our client connects:
//
// 1. OUR CODE: new net.Socket() + socket.connect(port, host)
//
// 2. NODE.JS/LIBUV:
//    └→ socket(AF_INET, SOCK_STREAM, 0) system call → creates fd
//    └→ connect(fd, {host, port}) system call
//       This triggers the TCP 3-way handshake:
//
//       CLIENT                            SERVER
//       ──────                            ──────
//       State: CLOSED                     State: LISTEN
//       │                                       │
//       │ ──── SYN (seq=1000) ────────────────→ │
//       │      State: SYN_SENT                  │
//       │                                       │
//       │ ←── SYN-ACK (seq=5000, ack=1001) ──  │
//       │      State: ESTABLISHED               │  State: SYN_RECEIVED
//       │                                       │
//       │ ──── ACK (ack=5001) ────────────────→ │
//       │                                       │  State: ESTABLISHED
//       │                                       │
//       └── Both sides now ESTABLISHED ─────────┘
//
//    └→ connect() returns success
//    └→ Node.js emits 'connect' event on the socket
//
// 3. THE CLIENT CAN NOW SEND/RECEIVE DATA:
//    └→ socket.write() → moves data to kernel send buffer
//       └→ Kernel segments data into TCP segments (≤ MSS bytes each)
//       └→ Each segment gets: sequence number, checksum, flags
//       └→ Segment is wrapped in IP packet → sent to Network Interface
//    └→ socket.on('data') → kernel notifies us of received data
//
// 4. EPHEMERAL PORT:
//    When the client connects, the OS assigns a random "ephemeral port"
//    (typically 49152-65535) as the source port. This port + the server's
//    port form the unique connection identifier:
//      (clientIP:ephemeralPort, serverIP:serverPort)
//    This is why a single client machine can have many connections to
//    the same server — each gets a different ephemeral port.
//
// ============================================================================

import * as net from "node:net";
import * as readline from "node:readline";
import { MessageParser } from "../protocol/parser.js";
import { PROTOCOL } from "../protocol/protocol.js";
import { ReconnectManager } from "./reconnect.js";

export interface ClientConfig {
  host: string;
  port: number;
  autoReconnect: boolean;
}

/**
 * TCPClient — Interactive TCP client with auto-reconnect
 */
export class TCPClient {
  private socket: net.Socket | null = null;
  private parser: MessageParser;
  private reconnectManager: ReconnectManager;
  private config: ClientConfig;
  private rl: readline.Interface | null = null;
  private isConnected: boolean = false;
  private isQuitting: boolean = false;

  constructor(config: ClientConfig) {
    this.config = config;
    this.parser = new MessageParser();
    this.reconnectManager = new ReconnectManager({
      initialDelayMs: 1000,
      maxDelayMs: 30000,
      maxAttempts: 0, // Infinite retries
      jitter: true,
    });
  }

  /**
   * Connect to the TCP server.
   *
   * BEHIND THE SCENES:
   * Creates a socket and initiates the TCP 3-way handshake.
   * The handshake is non-blocking — connect() returns immediately,
   * and the 'connect' event fires when the handshake completes.
   */
  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket = new net.Socket();

      // ── Configure socket before connecting ──────────────────
      // setNoDelay(true) disables Nagle's algorithm for low-latency responses
      this.socket.setNoDelay(true);

      // ── Connection Established ──────────────────────────────
      // This fires AFTER the 3-way handshake completes successfully.
      // The kernel handled all the SYN/SYN-ACK/ACK exchanging.
      this.socket.on("connect", () => {
        this.isConnected = true;
        this.reconnectManager.reset(); // Reset backoff counter

        const localAddr = this.socket!.localAddress;
        const localPort = this.socket!.localPort;

        console.log(
          "\n╔══════════════════════════════════════════════════════╗",
        );
        console.log("║          📡 TCP CLIENT — Connected!                  ║");
        console.log("╠══════════════════════════════════════════════════════╣");
        console.log(
          `║  Server: ${this.config.host}:${this.config.port}`.padEnd(55) + "║",
        );
        console.log(`║  Local:  ${localAddr}:${localPort}`.padEnd(55) + "║");
        console.log("╠══════════════════════════════════════════════════════╣");
        console.log("║  BTS: TCP 3-way handshake completed:                ║");
        console.log("║    ┌──────┐  SYN  ┌──────┐                         ║");
        console.log("║    │Client│──────→│Server│                          ║");
        console.log("║    │      │SYN-ACK│      │                          ║");
        console.log("║    │      │←──────│      │                          ║");
        console.log("║    │      │  ACK  │      │                          ║");
        console.log("║    │      │──────→│      │                          ║");
        console.log("║    └──────┘       └──────┘                          ║");
        console.log(
          `║  Ephemeral Port: ${localPort} (assigned by OS)`.padEnd(55) + "║",
        );
        console.log("╠══════════════════════════════════════════════════════╣");
        console.log("║  Commands: PING | ECHO <msg> | TIME | INFO | QUIT  ║");
        console.log(
          "╚══════════════════════════════════════════════════════╝\n",
        );

        this.startPrompt();
        resolve();
      });

      // ── Data Received ──────────────────────────────────────
      this.socket.on("data", (data: Buffer) => {
        const rawData = data.toString(PROTOCOL.ENCODING);

        // Parse out complete messages from the TCP stream
        const messages = this.parser.feed(rawData);

        for (const message of messages) {
          // Check if it's a server event or a command response
          if (message.startsWith("EVENT:")) {
            const parts = message.substring(6).split(":");
            const event = parts[0];
            const eventData = parts.slice(1).join(":");
            this.displayServerEvent(event, eventData);
          } else {
            this.displayResponse(message);
          }
        }
      });

      // ── Connection Closed ──────────────────────────────────
      this.socket.on("end", () => {
        console.log("\n  📪 Server closed the connection (received FIN)");
        this.isConnected = false;
      });

      this.socket.on("close", (hadError: boolean) => {
        this.isConnected = false;
        const reason = hadError ? "with error" : "cleanly";
        console.log(`  🔴 Connection closed ${reason}`);

        this.parser.reset();

        // Auto-reconnect if enabled and not intentionally quitting
        if (this.config.autoReconnect && !this.isQuitting) {
          this.reconnectManager.scheduleReconnect(() => {
            console.log("  📡 Attempting to reconnect...");
            this.connect().catch(() => {
              // Connection failed, scheduleReconnect will be called
              // again from the error handler
            });
          });
        }
      });

      // ── Error Handling ─────────────────────────────────────
      this.socket.on("error", (error: Error) => {
        const errCode = (error as NodeJS.ErrnoException).code;

        if (errCode === "ECONNREFUSED") {
          console.log(
            `\n  ❌ Connection refused — server at ${this.config.host}:${this.config.port} is not running`,
          );
          console.log(
            "     BTS: Our SYN packet was answered with RST (server port has no listener)",
          );
        } else if (errCode === "ECONNRESET") {
          console.log("\n  ❌ Connection reset by server (RST received)");
          console.log(
            "     BTS: Server abruptly closed the connection (crash or force-close)",
          );
        } else if (errCode === "ETIMEDOUT") {
          console.log("\n  ❌ Connection timed out");
          console.log(
            "     BTS: TCP SYN retransmissions exhausted — no response from server",
          );
        } else if (errCode === "EHOSTUNREACH") {
          console.log("\n  ❌ Host unreachable");
          console.log(
            "     BTS: No route to host — network layer (IP) could not reach the server",
          );
        } else {
          console.log(`\n  ❌ Socket error: ${errCode} — ${error.message}`);
        }

        if (!this.isConnected) {
          reject(error);
        }
      });

      // ── Initiate Connection ────────────────────────────────
      console.log(
        `\n  📡 Connecting to ${this.config.host}:${this.config.port}...`,
      );
      console.log(
        "     BTS: Sending SYN packet to initiate TCP 3-way handshake...",
      );
      this.socket.connect(this.config.port, this.config.host);
    });
  }

  /**
   * Start the interactive command prompt
   */
  private startPrompt(): void {
    if (this.rl) {
      this.rl.close();
    }

    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: "tcp> ",
    });

    this.rl.prompt();

    this.rl.on("line", (line: string) => {
      const trimmed = line.trim();
      if (trimmed.length === 0) {
        this.rl?.prompt();
        return;
      }

      if (!this.isConnected || !this.socket) {
        console.log("  ⚠️  Not connected to server");
        this.rl?.prompt();
        return;
      }

      // Check for QUIT command
      if (trimmed.toUpperCase() === "QUIT") {
        this.isQuitting = true;
      }

      // Send the command over TCP
      // We append our protocol delimiter so the server knows where the message ends
      const wireData = trimmed + PROTOCOL.MESSAGE_DELIMITER;

      console.log(
        `  📤 Sending: "${trimmed}" (${Buffer.byteLength(wireData)} bytes on wire)`,
      );
      console.log(
        `     BTS: Data → kernel send buffer → TCP segment → IP packet → network`,
      );

      this.socket.write(wireData);
    });

    this.rl.on("close", () => {
      if (!this.isQuitting) {
        this.isQuitting = true;
        this.disconnect();
      }
    });
  }

  /**
   * Display a server response
   */
  private displayResponse(message: string): void {
    const colonIndex = message.indexOf(":");
    if (colonIndex !== -1) {
      const status = message.substring(0, colonIndex);
      const body = message.substring(colonIndex + 1);

      const icon = status === "OK" ? "✅" : "❌";
      console.log(`  ${icon} [${status}] ${body}`);
    } else {
      console.log(`  📩 ${message}`);
    }

    this.rl?.prompt();
  }

  /**
   * Display a server-sent event
   */
  private displayServerEvent(event: string, data: string): void {
    console.log(`  📢 [${event}] ${data}`);
    this.rl?.prompt();
  }

  /**
   * Gracefully disconnect from the server
   */
  disconnect(): void {
    this.isQuitting = true;
    this.reconnectManager.cancel();

    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }

    if (this.socket && !this.socket.destroyed) {
      console.log("\n  📪 Disconnecting...");
      console.log(
        "     BTS: Sending FIN to server (initiating TCP 4-way teardown)",
      );
      this.socket.end();
    }
  }
}
