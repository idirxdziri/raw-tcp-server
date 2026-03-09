// ============================================================================
// parser.ts — Protocol Message Parser
// ============================================================================
// Handles the critical problem of TCP MESSAGE FRAMING.
//
// THE FUNDAMENTAL PROBLEM WITH TCP:
// TCP gives you a reliable BYTE STREAM, not messages. When you send:
//   socket.write("PING\n")
//   socket.write("ECHO hello\n")
//
// The receiver might get:
//   Case 1: "PING\nECHO hello\n"          ← Both in one chunk
//   Case 2: "PI"  then  "NG\nECHO hello\n" ← Split mid-message
//   Case 3: "PING\nECH"  then  "O hello\n" ← Split at different point
//
// This happens because TCP segments data based on:
//   - MTU (Maximum Transmission Unit, typically 1500 bytes)
//   - Nagle's algorithm (batches small writes)
//   - Network conditions and congestion
//   - Receiver's window size
//
// Our parser handles this with a BUFFER strategy:
//   1. Accumulate all incoming bytes in a buffer
//   2. Scan for our delimiter (\n)
//   3. Extract complete messages
//   4. Keep partial data in buffer for next chunk
// ============================================================================

import { Command, PROTOCOL, type ProtocolRequest } from "./protocol.js";

/**
 * MessageParser — Handles TCP stream framing
 *
 * BEHIND THE SCENES:
 * When data arrives on a TCP socket, it triggers a 'data' event.
 * Each 'data' event gives us a Buffer (raw bytes) that could contain:
 *   - Zero complete messages (partial data)
 *   - Exactly one complete message
 *   - Multiple complete messages
 *   - Multiple complete messages + a partial one at the end
 *
 * This class accumulates data and extracts complete messages.
 * This pattern is used in virtually every TCP-based protocol parser.
 */
export class MessageParser {
  private buffer: string = "";

  /**
   * Feed raw data from a TCP 'data' event into the parser.
   * Returns an array of complete messages found in the data.
   *
   * @example
   * // Scenario: data arrives in chunks
   * parser.feed("PIN")         → []              // Incomplete, buffered
   * parser.feed("G\nECHO hi")  → ["PING"]        // "PING\n" complete, "ECHO hi" buffered
   * parser.feed("\n")           → ["ECHO hi"]     // "ECHO hi\n" now complete
   */
  feed(data: string): string[] {
    this.buffer += data;
    const messages: string[] = [];

    // Scan for complete messages (terminated by our delimiter)
    let delimiterIndex: number;
    while (
      (delimiterIndex = this.buffer.indexOf(PROTOCOL.MESSAGE_DELIMITER)) !== -1
    ) {
      // Extract the complete message (everything before the delimiter)
      const message = this.buffer.substring(0, delimiterIndex).trim();

      // Remove the processed message + delimiter from the buffer
      this.buffer = this.buffer.substring(
        delimiterIndex + PROTOCOL.MESSAGE_DELIMITER.length,
      );

      // Only add non-empty messages
      if (message.length > 0) {
        messages.push(message);
      }
    }

    // Safety: prevent buffer from growing unbounded (DoS protection)
    if (this.buffer.length > PROTOCOL.MAX_MESSAGE_LENGTH) {
      this.buffer = "";
      throw new Error(
        `Message exceeded maximum length of ${PROTOCOL.MAX_MESSAGE_LENGTH} bytes`,
      );
    }

    return messages;
  }

  /**
   * Reset the parser's internal buffer.
   * Called when a connection is closed/reset.
   */
  reset(): void {
    this.buffer = "";
  }

  /**
   * Check if there's unprocessed data in the buffer.
   * Useful for detecting if a client disconnected mid-message.
   */
  hasPartialData(): boolean {
    return this.buffer.length > 0;
  }
}

/**
 * Parse a raw message string into a structured ProtocolRequest.
 *
 * PARSING STRATEGY:
 * 1. Split on first space to get command and arguments
 * 2. Validate the command against our known commands
 * 3. Return structured object or null for invalid commands
 *
 * This is analogous to how HTTP parsers work:
 *   "GET /index.html HTTP/1.1" → { method: GET, path: /index.html, version: 1.1 }
 *   "ECHO hello world"        → { command: ECHO, args: "hello world" }
 */
export function parseRequest(raw: string): ProtocolRequest | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;

  // Split into command and arguments
  const spaceIndex = trimmed.indexOf(" ");
  const commandStr =
    spaceIndex === -1 ? trimmed : trimmed.substring(0, spaceIndex);
  const args = spaceIndex === -1 ? "" : trimmed.substring(spaceIndex + 1);

  // Validate command (case-insensitive for user friendliness)
  const command = commandStr.toUpperCase() as Command;
  if (!Object.values(Command).includes(command)) {
    return null;
  }

  return { command, args, raw: trimmed };
}
