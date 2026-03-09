# 🤝 Deep Dive: TCP 3-Way Handshake

## Overview

Before any data can flow between a client and server, TCP must establish a connection through a **3-way handshake**. This process:

1. Synchronizes sequence numbers between both sides
2. Negotiates connection parameters (window size, MSS)
3. Confirms both sides can send AND receive

## Step-by-Step Breakdown

### Step 1: Client Sends SYN

When our code calls `socket.connect(9000, '127.0.0.1')`:

```
Node.js                OS Kernel
───────                ─────────
socket.connect() ──→   connect() syscall
                       │
                       ├─ Create TCP segment:
                       │   ┌──────────────────────────┐
                       │   │ SYN = 1                   │
                       │   │ Seq = ISN (random 32-bit) │
                       │   │ Window = 65535             │
                       │   │ Options:                   │
                       │   │   MSS = 1460              │
                       │   │   Window Scale = 7        │
                       │   │   SACK Permitted           │
                       │   │   Timestamps               │
                       │   └──────────────────────────┘
                       │
                       ├─ Wrap in IP packet (src/dst IP)
                       ├─ Wrap in Ethernet frame (src/dst MAC)
                       └─ Send via NIC → network
```

**Why is ISN random?**

- Prevents old segments from a previous connection interfering
- Security: makes TCP sequence prediction attacks harder
- Modern Linux uses SipHash to generate ISNs

**What is MSS?**

- Maximum Segment Size = largest payload TCP will send
- Typically 1460 bytes (1500 MTU - 20 IP header - 20 TCP header)
- Negotiated during handshake to avoid IP fragmentation

### Step 2: Server Sends SYN-ACK

When the kernel receives the SYN on a socket in LISTEN state:

```
Server Kernel
─────────────
Receive SYN packet
│
├─ Check: Is anyone listening on port 9000? YES
│
├─ Add to SYN QUEUE (incomplete connections)
│   ┌────────────────────────────────────────┐
│   │ SYN Queue (aka half-open connections)  │
│   │                                        │
│   │ This queue holds connections where     │
│   │ we've received SYN but not yet the     │
│   │ final ACK. Limited size (128-1024).    │
│   │                                        │
│   │ SYN FLOOD ATTACK: Attacker sends many  │
│   │ SYNs without completing handshake,     │
│   │ filling this queue → DoS.              │
│   │ Defense: SYN cookies (RFC 4987)        │
│   └────────────────────────────────────────┘
│
├─ Create SYN-ACK segment:
│   ┌──────────────────────────────────┐
│   │ SYN = 1, ACK = 1                 │
│   │ Seq = ISN_server (random)        │
│   │ Ack = ISN_client + 1             │
│   │ Window = 65535                    │
│   │ Options: MSS, Window Scale, etc. │
│   └──────────────────────────────────┘
│
└─ Send SYN-ACK back to client
```

### Step 3: Client Sends ACK

```
Client Kernel
─────────────
Receive SYN-ACK
│
├─ Connection moves to ESTABLISHED state
│
├─ Create ACK segment:
│   ┌────────────────────────────────┐
│   │ ACK = 1                         │
│   │ Seq = ISN_client + 1            │
│   │ Ack = ISN_server + 1            │
│   └────────────────────────────────┘
│
├─ Send ACK to server
│
└─ Notify application (Node.js 'connect' event fires)
```

```
Server Kernel
─────────────
Receive ACK
│
├─ Move connection: SYN Queue → ACCEPT Queue
│   ┌────────────────────────────────────────┐
│   │ Accept Queue (complete connections)     │
│   │                                        │
│   │ Fully established connections waiting  │
│   │ for the application to call accept().  │
│   │ Node.js/libuv calls accept() via       │
│   │ epoll/kqueue notification.             │
│   │                                        │
│   │ If this queue is full, new connections  │
│   │ are DROPPED (not rejected with RST).   │
│   └────────────────────────────────────────┘
│
├─ Connection is ESTABLISHED
│
└─ Notify Node.js → 'connection' event fires on server
```

## Connection Options Negotiated

| Option       | Purpose                            | Typical Value |
| ------------ | ---------------------------------- | ------------- |
| MSS          | Max payload per segment            | 1460 bytes    |
| Window Scale | Multiplier for window size (>64KB) | 7 (×128)      |
| SACK         | Selective ACK (report gaps)        | Permitted     |
| Timestamps   | RTT measurement, PAWS              | Enabled       |
| ECN          | Explicit Congestion Notification   | If supported  |

## What Can Go Wrong

| Scenario            | What Happens                                  | Error in Node.js                |
| ------------------- | --------------------------------------------- | ------------------------------- |
| No server listening | Kernel sends RST                              | `ECONNREFUSED`                  |
| Server unreachable  | SYN timeout (retransmits ~6 times over ~127s) | `ETIMEDOUT`                     |
| Firewall drops SYN  | Same as unreachable                           | `ETIMEDOUT`                     |
| SYN queue full      | Kernel drops SYN silently                     | `ETIMEDOUT`                     |
| Accept queue full   | Kernel drops ACK                              | `ETIMEDOUT` or eventual connect |

## Observe It Yourself

```bash
# Capture the 3-way handshake with tcpdump:
sudo tcpdump -i lo0 port 9000 -vv -S

# You'll see output like:
# 12:00:01 IP client.52461 > server.9000: Flags [S], seq 1000, win 65535, options [mss 1460], length 0
# 12:00:01 IP server.9000 > client.52461: Flags [S.], seq 5000, ack 1001, win 65535, options [mss 1460], length 0
# 12:00:01 IP client.52461 > server.9000: Flags [.], ack 5001, win 65535, length 0
#
# [S]  = SYN
# [S.] = SYN-ACK
# [.]  = ACK
```
