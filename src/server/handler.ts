// ============================================================================
// handler.ts — TCP Connection Handler
// ============================================================================
// This is where each client connection is managed. For every connected client,
// we create a handler that:
//   1. Parses incoming TCP stream data into protocol messages
//   2. Executes the command
//   3. Sends the response back over the TCP connection
//
// BEHIND THE SCENES — What happens when data arrives:
//
//   Network Card (NIC)
//       ↓ Raw ethernet frames
//   OS Kernel (TCP/IP Stack)
//       ↓ Reassembles TCP segments, manages sequence numbers
//       ↓ Places data in socket receive buffer
//   Node.js Event Loop (libuv)
//       ↓ epoll/kqueue detects readable socket
//       ↓ Reads from kernel buffer into userspace Buffer
//   socket.on('data', callback)
//       ↓ Our code receives a Buffer (chunk of bytes)
//   MessageParser.feed()
//       ↓ Extracts complete messages from the byte stream
//   handleCommand()
//       ↓ Processes the command and generates response
//   socket.write()
//       ↓ Writes response to kernel send buffer
//   OS Kernel → NIC → Network → Client
//
// ============================================================================

import type * as net from "node:net";
import { MessageParser, parseRequest } from "../protocol/parser";
import {
  Command,
  formatResponse,
  formatServerEvent,
  ResponseStatus,
  type ProtocolResponse,
} from "../protocol/protocol.js";
import type { MetricsTracker } from "./metrics.js";

/** Logger utility with structured output */
function log(connectionId: string, event: string, details: string = ""): void {
  const timestamp = new Date().toISOString();
  const detailStr = details ? ` — ${details}` : "";
  console.log(`[${timestamp}] [${connectionId}] ${event}${detailStr}`);
}

/**
 * Handle a new TCP connection.
 *
 * LIFECYCLE OF A TCP CONNECTION (what this function manages):
 *
 * 1. CONNECTION ESTABLISHED (3-way handshake already done by kernel)
 *    ┌──────────┐    SYN       ┌──────────┐
 *    │  Client  │ ──────────→  │  Server  │
 *    │          │  SYN-ACK     │          │
 *    │          │ ←──────────  │          │
 *    │          │    ACK       │          │
 *    │          │ ──────────→  │          │
 *    └──────────┘              └──────────┘
 *    At this point, socket.on('connection') fires and this function is called.
 *
 * 2. DATA EXCHANGE (handled by 'data' event below)
 *    Client sends commands, server sends responses.
 *    TCP ensures reliable, ordered delivery with ACKs and retransmissions.
 *
 * 3. CONNECTION TEARDOWN (FIN handshake)
 *    When client sends QUIT or disconnects:
 *    ┌──────────┐    FIN       ┌──────────┐
 *    │  Client  │ ──────────→  │  Server  │
 *    │          │    ACK       │          │
 *    │          │ ←──────────  │          │
 *    │          │    FIN       │          │
 *    │          │ ←──────────  │          │
 *    │          │    ACK       │          │
 *    │          │ ──────────→  │          │
 *    └──────────┘              └──────────┘
 */
export function handleConnection(
  socket: net.Socket,
  connectionId: string,
  metrics: MetricsTracker,
): void {
  const remoteAddr = socket.remoteAddress || "unknown";
  const remotePort = socket.remotePort || 0;
  const parser = new MessageParser();

  // ── Connection Established ──────────────────────────────────────
  // The TCP 3-way handshake has ALREADY completed at this point.
  // The kernel handled SYN/SYN-ACK/ACK for us.
  // We now have a fully established, bidirectional byte stream.

  log(connectionId, "🟢 CONNECTION ESTABLISHED", `${remoteAddr}:${remotePort}`);
  log(connectionId, "   TCP State: ESTABLISHED");
  log(
    connectionId,
    `   Socket buffer sizes — Send: ${socket.writableHighWaterMark} bytes, Recv: ${socket.readableHighWaterMark} bytes`,
  );

  // Track this connection
  metrics.addConnection(connectionId, remoteAddr, remotePort);

  // Send welcome message to client
  const welcome = formatServerEvent(
    "WELCOME",
    `Connected to TCP server | Connection ID: ${connectionId}`,
  );
  socket.write(welcome);

  // ── Configure Socket ────────────────────────────────────────────
  //
  // setKeepAlive: Sends TCP keep-alive probes to detect dead connections.
  // Without this, a client could crash and the server would hold the socket
  // open forever (a "half-open" connection). Keep-alive sends periodic
  // empty ACK packets to verify the peer is still alive.
  //
  socket.setKeepAlive(true, 30000); // Probe every 30 seconds

  //
  // setNoDelay: Disables Nagle's algorithm.
  // Nagle's algorithm batches small writes together to reduce the number
  // of TCP segments sent (improves throughput for bulk transfers).
  // For interactive protocols like ours, we want low latency, so we
  // disable it. Each write() immediately sends a TCP segment.
  //
  // Think of it like this:
  //   Nagle ON:  "Wait a bit, maybe more data is coming... okay send it all"
  //   Nagle OFF: "Send immediately, even if it's just a few bytes"
  //
  socket.setNoDelay(true);

  // ── Set Timeouts ────────────────────────────────────────────────
  // If no data is received for 5 minutes, consider the connection idle.
  // This prevents resource exhaustion from abandoned connections.
  socket.setTimeout(300000); // 5 minutes

  socket.on("timeout", () => {
    log(
      connectionId,
      "⏰ TIMEOUT",
      "No activity for 5 minutes, closing connection",
    );
    const msg = formatResponse(
      ResponseStatus.ERROR,
      "Connection timed out due to inactivity",
    );
    socket.end(msg); // Send FIN to client (graceful close)
  });

  // ── Data Reception ──────────────────────────────────────────────
  //
  // CRITICAL CONCEPT: The 'data' event fires whenever the kernel has
  // data ready in the socket's receive buffer. The amount of data in
  // each event is NOT predictable — it depends on:
  //   - TCP segment sizes (typically up to MSS, ~1460 bytes)
  //   - Nagle's algorithm on the sender side
  //   - Network conditions and buffering
  //   - Receive window size
  //
  // This is why we need the MessageParser to handle framing!
  //
  socket.on("data", (data: Buffer) => {
    const rawData = data.toString("utf-8");
    log(connectionId, "📥 DATA RECEIVED", `${data.length} bytes`);

    // Feed raw bytes into our protocol parser
    let messages: string[];
    try {
      messages = parser.feed(rawData);
    } catch (error) {
      // Message too large — possible attack or misbehaving client
      log(connectionId, "⚠️  PARSE ERROR", (error as Error).message);
      socket.write(formatResponse(ResponseStatus.ERROR, "Message too large"));
      return;
    }

    // Update metrics with raw byte count
    metrics.recordReceived(connectionId, data.length, messages.length);

    // Process each complete message
    for (const message of messages) {
      log(connectionId, "📨 MESSAGE PARSED", `"${message}"`);

      const request = parseRequest(message);

      if (!request) {
        const response = formatResponse(
          ResponseStatus.ERROR,
          `Unknown command: "${message}". Available: PING, ECHO <msg>, TIME, INFO, QUIT`,
        );
        socket.write(response);
        metrics.recordSent(connectionId, Buffer.byteLength(response));
        continue;
      }

      // Execute the command and send response
      const response = executeCommand(
        request.command,
        request.args,
        connectionId,
        metrics,
      );
      const responseStr = formatResponse(response.status, response.message);

      log(
        connectionId,
        "📤 RESPONSE SENT",
        `${response.status}: ${response.message}`,
      );

      if (request.command === Command.QUIT) {
        // Graceful shutdown: send response then close
        // socket.end() sends a FIN packet (initiates TCP teardown)
        socket.end(responseStr);
        metrics.recordSent(connectionId, Buffer.byteLength(responseStr));
        return;
      }

      socket.write(responseStr);
      metrics.recordSent(connectionId, Buffer.byteLength(responseStr));
    }
  });

  // ── Connection Close ────────────────────────────────────────────
  //
  // 'end' event: The client sent a FIN packet (graceful close).
  // At this point, the socket is "half-closed" — we can still send
  // data to the client, but won't receive any more.
  //
  // TCP State transition: ESTABLISHED → CLOSE_WAIT
  //
  socket.on("end", () => {
    log(connectionId, "📪 CLIENT SENT FIN", "Client initiated graceful close");
    log(connectionId, "   TCP State: CLOSE_WAIT → LAST_ACK → CLOSED");

    if (parser.hasPartialData()) {
      log(
        connectionId,
        "⚠️  WARNING",
        "Client disconnected with partial message in buffer",
      );
    }
  });

  //
  // 'close' event: The socket is fully closed (both directions).
  // This fires after 'end' and after any remaining data is flushed.
  //
  // TCP State: CLOSED — all resources can be freed
  //
  socket.on("close", (hadError: boolean) => {
    const m = metrics.removeConnection(connectionId);
    const duration = m
      ? `${((Date.now() - m.connectedAt.getTime()) / 1000).toFixed(1)}s`
      : "unknown";
    const errorInfo = hadError ? " (with error)" : "";

    log(
      connectionId,
      `🔴 CONNECTION CLOSED${errorInfo}`,
      `Duration: ${duration}`,
    );
    log(connectionId, "   TCP State: CLOSED — Socket resources freed");

    parser.reset();
  });

  // ── Error Handling ──────────────────────────────────────────────
  //
  // Common socket errors:
  //   ECONNRESET: Client sent RST (abrupt close, e.g., process crash)
  //   EPIPE: Writing to a socket that the peer has already closed
  //   ETIMEDOUT: TCP retransmission timeout (network issue)
  //
  // In TCP terms:
  //   RST (Reset) vs FIN (Finish):
  //   - FIN = "I'm done sending, let's close gracefully" (4-way handshake)
  //   - RST = "Something went wrong, abort immediately" (no handshake)
  //
  socket.on("error", (error: Error) => {
    const errCode = (error as NodeJS.ErrnoException).code;

    if (errCode === "ECONNRESET") {
      log(
        connectionId,
        "⚡ CONNECTION RESET",
        "Client sent RST (abrupt disconnection)",
      );
      log(
        connectionId,
        "   This means the client process crashed or was killed",
      );
    } else if (errCode === "EPIPE") {
      log(
        connectionId,
        "⚡ BROKEN PIPE",
        "Attempted write to closed connection",
      );
    } else if (errCode === "ETIMEDOUT") {
      log(
        connectionId,
        "⚡ TCP TIMEOUT",
        "TCP retransmissions exhausted — network issue",
      );
    } else {
      log(connectionId, "⚡ SOCKET ERROR", `${errCode}: ${error.message}`);
    }
  });
}

// ============================================================================
// Command Execution
// ============================================================================

function executeCommand(
  command: Command,
  args: string,
  connectionId: string,
  metrics: MetricsTracker,
): ProtocolResponse {
  switch (command) {
    case Command.PING:
      // Simplest possible command — just proves the connection is alive
      // Similar to Redis PING/PONG or ICMP echo
      return { status: ResponseStatus.OK, message: "PONG" };

    case Command.ECHO:
      // Echo back the payload — useful for testing data integrity
      // Similar to RFC 862 Echo Protocol
      if (!args) {
        return {
          status: ResponseStatus.ERROR,
          message: "ECHO requires a message. Usage: ECHO <message>",
        };
      }
      return { status: ResponseStatus.OK, message: args };

    case Command.TIME:
      // Return server's current time — demonstrates request/response pattern
      return { status: ResponseStatus.OK, message: new Date().toISOString() };

    case Command.INFO:
      // Return connection and server metadata
      const connInfo = metrics.getConnectionInfo(connectionId);
      const serverInfo = metrics.getServerInfo();
      return {
        status: ResponseStatus.OK,
        message: `${connInfo} || ${serverInfo}`,
      };

    case Command.QUIT:
      // Initiate graceful connection teardown
      return {
        status: ResponseStatus.OK,
        message: "Goodbye! Closing connection...",
      };

    default:
      return {
        status: ResponseStatus.ERROR,
        message: `Unknown command: ${command}`,
      };
  }
}
