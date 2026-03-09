// ============================================================================
// reconnect.ts — Auto-Reconnect with Exponential Backoff
// ============================================================================
//
// BEHIND THE SCENES — Why do we need auto-reconnect?
//
// TCP connections can drop for many reasons:
//   - Server restart/deployment (common in production)
//   - Network partition (cable unplugged, WiFi switch, etc.)
//   - Idle timeout (firewalls/NATs drop idle connections)
//   - Server crash
//
// Reconnection strategies:
//
//   1. FIXED INTERVAL: Retry every N seconds
//      Problem: If server is down, ALL clients retry simultaneously
//      when it comes back → "thundering herd" overwhelms the server
//
//   2. EXPONENTIAL BACKOFF: Double the wait time each attempt
//      1s → 2s → 4s → 8s → 16s → 32s → 60s (capped)
//      Better: Spreads out reconnection attempts over time
//
//   3. EXPONENTIAL BACKOFF + JITTER: Add randomness to backoff
//      This is the industry best practice (used by AWS, gRPC, etc.)
//      Without jitter: many clients all retry at 1s, 2s, 4s...
//      With jitter: clients retry at 0.8s, 1.3s, 2.7s, 5.1s...
//      This prevents synchronized retry storms.
//
// We implement #3 — exponential backoff with full jitter.
//
// Reference: https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/
// ============================================================================

export interface ReconnectConfig {
  initialDelayMs: number; // Starting delay (e.g., 1000ms = 1s)
  maxDelayMs: number; // Maximum delay cap (e.g., 30000ms = 30s)
  maxAttempts: number; // 0 = infinite retries
  jitter: boolean; // Add randomness to prevent thundering herd
}

const DEFAULT_CONFIG: ReconnectConfig = {
  initialDelayMs: 1000,
  maxDelayMs: 30000,
  maxAttempts: 0, // Infinite retries
  jitter: true,
};

/**
 * ReconnectManager — Manages reconnection with exponential backoff + jitter
 */
export class ReconnectManager {
  private config: ReconnectConfig;
  private attempt: number = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(config: Partial<ReconnectConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Schedule the next reconnection attempt.
   * Returns the delay and calls the callback after the delay.
   * Returns null if max attempts exceeded.
   */
  scheduleReconnect(callback: () => void): number | null {
    this.attempt++;

    // Check max attempts
    if (this.config.maxAttempts > 0 && this.attempt > this.config.maxAttempts) {
      console.log(
        `\n  ❌ Max reconnection attempts (${this.config.maxAttempts}) exceeded. Giving up.`,
      );
      return null;
    }

    // Calculate delay with exponential backoff
    // Formula: min(maxDelay, initialDelay * 2^(attempt-1))
    const exponentialDelay = Math.min(
      this.config.maxDelayMs,
      this.config.initialDelayMs * Math.pow(2, this.attempt - 1),
    );

    // Apply jitter (random value between 0 and exponentialDelay)
    // This is "full jitter" as recommended by AWS
    const delay = this.config.jitter
      ? Math.floor(Math.random() * exponentialDelay)
      : exponentialDelay;

    console.log(
      `  🔄 Reconnect attempt ${this.attempt}${this.config.maxAttempts > 0 ? `/${this.config.maxAttempts}` : ""} in ${(delay / 1000).toFixed(1)}s (backoff: ${(exponentialDelay / 1000).toFixed(1)}s)`,
    );

    // Schedule the reconnect
    this.timer = setTimeout(callback, delay);

    return delay;
  }

  /**
   * Reset the backoff counter (called after successful connection)
   */
  reset(): void {
    this.attempt = 0;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /**
   * Cancel any pending reconnection
   */
  cancel(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /**
   * Get current attempt number
   */
  getAttempt(): number {
    return this.attempt;
  }
}
