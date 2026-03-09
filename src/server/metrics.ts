// ============================================================================
// metrics.ts — Connection Metrics Tracker
// ============================================================================
// Tracks per-connection and server-wide statistics.
// This is how production servers monitor health and performance.
// ============================================================================

/**
 * Per-connection metrics
 *
 * BEHIND THE SCENES:
 * Every TCP connection has metadata that the OS kernel tracks:
 *   - Source IP:Port and Destination IP:Port (the "4-tuple")
 *   - Socket state (ESTABLISHED, CLOSE_WAIT, etc.)
 *   - Send/receive buffer sizes
 *   - Bytes in flight, RTT estimates, congestion window
 *
 * Our application-level metrics complement the kernel metrics
 * with protocol-specific information.
 */
export interface ConnectionMetrics {
  id: string; // Unique connection identifier
  remoteAddress: string; // Client IP address
  remotePort: number; // Client ephemeral port
  connectedAt: Date; // When the TCP handshake completed
  lastActivityAt: Date; // Last data received/sent
  bytesReceived: number; // Total bytes from client
  bytesSent: number; // Total bytes to client
  messagesReceived: number; // Application-level messages parsed
  messagesSent: number; // Application-level responses sent
}

/**
 * Server-wide metrics aggregator
 */
export class MetricsTracker {
  private connections: Map<string, ConnectionMetrics> = new Map();
  private totalConnectionsServed: number = 0;

  /**
   * Register a new connection.
   * Called right after the TCP 3-way handshake completes (the 'connection' event).
   */
  addConnection(
    id: string,
    remoteAddress: string,
    remotePort: number,
  ): ConnectionMetrics {
    const metrics: ConnectionMetrics = {
      id,
      remoteAddress,
      remotePort,
      connectedAt: new Date(),
      lastActivityAt: new Date(),
      bytesReceived: 0,
      bytesSent: 0,
      messagesReceived: 0,
      messagesSent: 0,
    };
    this.connections.set(id, metrics);
    this.totalConnectionsServed++;
    return metrics;
  }

  /**
   * Record incoming data from a client
   */
  recordReceived(id: string, bytes: number, messages: number): void {
    const m = this.connections.get(id);
    if (m) {
      m.bytesReceived += bytes;
      m.messagesReceived += messages;
      m.lastActivityAt = new Date();
    }
  }

  /**
   * Record outgoing data to a client
   */
  recordSent(id: string, bytes: number): void {
    const m = this.connections.get(id);
    if (m) {
      m.bytesSent += bytes;
      m.messagesSent++;
      m.lastActivityAt = new Date();
    }
  }

  /**
   * Remove a connection (after TCP teardown completes)
   */
  removeConnection(id: string): ConnectionMetrics | undefined {
    const m = this.connections.get(id);
    this.connections.delete(id);
    return m;
  }

  /**
   * Get metrics for a specific connection
   */
  getConnection(id: string): ConnectionMetrics | undefined {
    return this.connections.get(id);
  }

  /**
   * Get a summary of all active connections and server stats
   */
  getServerInfo(): string {
    const active = this.connections.size;
    const uptime = process.uptime();
    const memUsage = process.memoryUsage();

    const lines = [
      `Server Uptime: ${formatDuration(uptime)}`,
      `Active Connections: ${active}`,
      `Total Connections Served: ${this.totalConnectionsServed}`,
      `Memory RSS: ${formatBytes(memUsage.rss)}`,
      `Heap Used: ${formatBytes(memUsage.heapUsed)}/${formatBytes(memUsage.heapTotal)}`,
    ];
    return lines.join(" | ");
  }

  /**
   * Format connection info for the INFO command
   */
  getConnectionInfo(id: string): string {
    const m = this.connections.get(id);
    if (!m) return "Connection not found";

    const duration = (Date.now() - m.connectedAt.getTime()) / 1000;
    return [
      `Connection ID: ${m.id}`,
      `Remote: ${m.remoteAddress}:${m.remotePort}`,
      `Connected: ${formatDuration(duration)}`,
      `Bytes In/Out: ${formatBytes(m.bytesReceived)}/${formatBytes(m.bytesSent)}`,
      `Messages In/Out: ${m.messagesReceived}/${m.messagesSent}`,
    ].join(" | ");
  }
}

// ── Utility Functions ──────────────────────────────────────────────

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
