// ============================================================================
// protocol.ts — Custom TCP Protocol Definition
// ============================================================================
// This defines our simple text-based protocol that runs ON TOP of TCP.
//
// KEY CONCEPT: TCP is just a reliable byte stream — it has NO concept of
// "messages". We need to define our own message boundaries and format.
// This is exactly what HTTP, FTP, SMTP, etc. do on top of TCP.
//
// Our protocol format:
//   REQUEST:  COMMAND [arguments]\n
//   RESPONSE: STATUS:MESSAGE\n
//
// Commands:
//   PING           → Server responds with PONG (connection health check)
//   ECHO <message> → Server echoes back the message
//   TIME           → Server responds with current timestamp
//   INFO           → Server responds with connection metadata
//   QUIT           → Gracefully close the connection
// ============================================================================

/**
 * Available commands in our protocol.
 * Each maps to a real-world use case:
 * - PING: Like ICMP ping, but at the application layer (think Redis PING)
 * - ECHO: Like the echo service (RFC 862), useful for testing
 * - TIME: Like NTP but simplified, demonstrates request/response
 * - INFO: Like Redis INFO, returns server/connection metadata
 * - QUIT: Like FTP QUIT, initiates graceful connection teardown
 */
export enum Command {
  PING = "PING",
  ECHO = "ECHO",
  TIME = "TIME",
  INFO = "INFO",
  QUIT = "QUIT",
}

/**
 * Response status codes — inspired by HTTP status categories
 */
export enum ResponseStatus {
  OK = "OK", // 2xx equivalent: request succeeded
  ERROR = "ERROR", // 4xx equivalent: client error (bad command)
  SERVER_ERROR = "SRV_ERROR", // 5xx equivalent: server-side error
}

/**
 * Parsed representation of a client request
 */
export interface ProtocolRequest {
  command: Command;
  args: string; // Everything after the command
  raw: string; // Original raw string (for logging)
}

/**
 * Structured server response
 */
export interface ProtocolResponse {
  status: ResponseStatus;
  message: string;
}

/**
 * Protocol constants
 *
 * MESSAGE_DELIMITER: We use \n (newline) as our message boundary.
 * This is how TCP knows where one message ends and another begins.
 *
 * Without a delimiter, TCP would just give us a stream of bytes like:
 *   "PINGECHO helloTIME"
 * With \n delimiter, we get distinct messages:
 *   "PING\n" "ECHO hello\n" "TIME\n"
 *
 * Real protocols use different strategies:
 * - HTTP/1.1: \r\n\r\n for headers, Content-Length for body
 * - Redis: \r\n (CRLF)
 * - Length-prefixed: first 4 bytes = message length
 */

export const PROTOCOL = {
  MESSAGE_DELIMITER: "\n",
  MAX_MESSAGE_LENGTH: 4096, // Prevent memory abuse from huge messages
  ENCODING: "utf-8" as BufferEncoding,
  VERSION: "1.0",
} as const;

/**
 * Format a response into a wire-format string
 *
 * This is what actually gets sent as bytes over the TCP connection.
 * The receiving end must parse this exact format.
 */
export function formatResponse(
  status: ResponseStatus,
  message: string,
): string {
  return `${status}:${message}${PROTOCOL.MESSAGE_DELIMITER}`;
}

/**
 * Format a server event/notification (unsolicited message from server)
 */
export function formatServerEvent(event: string, data: string): string {
  return `EVENT:${event}:${data}${PROTOCOL.MESSAGE_DELIMITER}`;
}
