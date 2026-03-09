# 📦 Deep Dive: TCP Data Transfer & Flow Control

## Overview

Once the 3-way handshake completes and the connection is ESTABLISHED, data flows as a **reliable, ordered byte stream**. This document explains how TCP achieves reliability and flow control behind the scenes.

## TCP Segmentation

When you call `socket.write("ECHO hello world\n")`, TCP doesn't send it as-is. It goes through **segmentation**:

```
Application writes: "A very long message that exceeds MSS..." (2000 bytes)

TCP segments it:
┌──────────────────────────────────┐
│ Segment 1 (seq=1001)             │
│ Payload: first 1460 bytes        │
│ Flags: ACK                       │
└──────────────────────────────────┘
┌──────────────────────────────────┐
│ Segment 2 (seq=2461)             │
│ Payload: remaining 540 bytes     │
│ Flags: ACK, PSH                  │
└──────────────────────────────────┘

PSH (Push) flag tells receiver: "Deliver this to the application now,
don't wait for more data in the buffer."
```

## Sequence Numbers & Acknowledgments

Every byte in the stream has a sequence number. ACKs tell the sender what byte is expected next:

```
CLIENT                                    SERVER
──────                                    ──────

write("PING\n")  ──→  [seq=1001, 5 bytes] ──→  recv: "PING\n"
                 ←──  [ack=1006]           ←──  "I got bytes up to 1006"

write("TIME\n")  ──→  [seq=1006, 5 bytes] ──→  recv: "TIME\n"
                 ←──  [ack=1011]           ←──  "I got bytes up to 1011"

                 ←──  [seq=5001, 24 bytes] ←──  write("OK:2026-03-09...\n")
[ack=5025]       ──→                       ──→  "I got bytes up to 5025"
```

**Key insight**: ACK number = the NEXT byte the receiver expects. So `ack=1006` means "I have received bytes 1001-1005, send me byte 1006 next."

## Sliding Window (Flow Control)

The **receive window** prevents a fast sender from overwhelming a slow receiver:

```
┌─────────────────────────────────────────────────────┐
│                    SENDER'S VIEW                     │
│                                                     │
│  Already ACK'd    │   Can Send    │  Cannot Send    │
│  (can discard)    │   (in window) │  (wait for ACK) │
│                   │               │                 │
│  ████████████████ │ ░░░░░░░░░░░░░ │ ─────────────── │
│                   │               │                 │
│  ←── ACK'd ──→   │ ←─ window ──→ │                 │
│                   │   (65535)     │                 │
└─────────────────────────────────────────────────────┘

As ACKs arrive, the window SLIDES forward:

Before ACK:  [████████░░░░░░░░░───────]
                      ↑ window start

After ACK:   [████████████░░░░░░░░░───]
                          ↑ window slides right
```

**In Node.js**, this surfaces as **backpressure**:

```typescript
// socket.write() returns false when the kernel send buffer is full
const canWrite = socket.write(data);

if (!canWrite) {
  // BACKPRESSURE! The receiver's window is full or our send buffer is full.
  // Wait for 'drain' event before writing more.
  socket.once("drain", () => {
    // Now we can write again — receiver has consumed some data
    // and sent an ACK with a larger window
  });
}
```

## Retransmission

If an ACK doesn't arrive within the **RTO (Retransmission Timeout)**, TCP resends the segment:

```
CLIENT                                    SERVER
──────                                    ──────

[seq=1001, "PING\n"] ──→  ✗ (packet lost!)

... RTO expires (typically 200ms-1s) ...

[seq=1001, "PING\n"] ──→  ──→  recv: "PING\n"  (retransmission!)
                     ←──  [ack=1006]  ←──
```

**RTO calculation**: TCP measures round-trip time (RTT) and sets:

- `SRTT` = smoothed RTT (weighted average)
- `RTTVAR` = RTT variance
- `RTO = SRTT + 4 × RTTVAR` (with minimum of 1 second initially)

Each retransmission doubles the RTO (**exponential backoff**), up to a maximum (~120s). After ~15 retransmissions (~15 minutes), TCP gives up and reports an error.

## Congestion Control

TCP also limits send rate based on **network congestion** (separate from flow control):

```
                Congestion Window (cwnd)
                ────────────────────────
Slow Start:     1 → 2 → 4 → 8 → 16 → 32  (doubles each RTT)
                                     │
                              Hit ssthresh
                                     │
                                     ▼
Congestion      32 → 33 → 34 → 35      (increases by 1 each RTT)
Avoidance:                    │
                        Packet loss!
                              │
                              ▼
                ssthresh = cwnd/2 = 17
                cwnd = 1 (slow start again)
```

**Modern algorithms** (CUBIC, BBR) are more sophisticated, but the core idea remains: probe for available bandwidth and back off on loss.

## Nagle's Algorithm

By default, TCP batches small writes:

```
WITHOUT Nagle (setNoDelay=true):
  write("P")  →  [segment: "P"]       sent immediately
  write("I")  →  [segment: "I"]       sent immediately
  write("N")  →  [segment: "N"]       sent immediately
  write("G")  →  [segment: "G"]       sent immediately

WITH Nagle (default):
  write("P")  →  [segment: "P"]       sent (first write always sends)
  write("I")  →  (buffered, waiting for ACK of "P")
  write("N")  →  (buffered)
  write("G")  →  (buffered)
  ACK arrives  →  [segment: "ING"]    now send all buffered data

Result: 2 segments instead of 4, but added latency!
```

**Our server disables Nagle** (`setNoDelay(true)`) because we want low-latency interactive responses. Protocols like SSH, gaming, and interactive tools do the same.

## Observe It Yourself

```bash
# Watch data segments and ACKs:
sudo tcpdump -i lo0 port 9000 -vv -S

# Watch socket buffer levels:
netstat -an | grep 9000

# See detailed TCP connection stats (Linux):
ss -ti | grep 9000
```
