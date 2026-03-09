# 🖥️ Raw TCP Server & Client — From Scratch

> A **production-quality TCP server and client** built from scratch using only Node.js's built-in `net` module. Every line of code is documented to show you exactly what happens **behind the scenes** at every layer — from your application code down to the kernel's TCP/IP stack.

**No frameworks. No magic. Just raw TCP.**

## 📋 Table of Contents

- [Why This Exists](#-why-this-exists)
- [Quick Start](#-quick-start)
- [Architecture](#-architecture)
- [The TCP Protocol — Behind the Scenes](#-the-tcp-protocol--behind-the-scenes)
  - [What is TCP?](#what-is-tcp)
  - [The 3-Way Handshake](#the-3-way-handshake-connection-setup)
  - [Data Transfer](#data-transfer)
  - [Connection Teardown](#connection-teardown-4-way)
  - [TCP States](#tcp-state-machine)
- [Our Custom Protocol](#-our-custom-protocol)
- [Key Concepts Demonstrated](#-key-concepts-demonstrated)
- [Project Structure](#-project-structure)
- [Further Reading](#-further-reading)

---

## 🎯 Why This Exists

When you use `fetch()`, `axios`, or any HTTP library, **layers of abstraction hide what's actually happening**. This project strips away those layers and forces you to deal with raw TCP sockets, where you must solve the same problems that HTTP, gRPC, WebSocket, and every TCP-based protocol must solve:

| Problem                                       | How We Solve It                         | How Real Protocols Solve It       |
| --------------------------------------------- | --------------------------------------- | --------------------------------- |
| Where does one message end and another begin? | `\n` delimiter                          | HTTP: `\r\n\r\n` + Content-Length |
| What if data arrives in chunks?               | Buffer + scan for delimiter             | Same — all TCP parsers do this    |
| What if the connection drops?                 | Auto-reconnect with exponential backoff | gRPC, WebSockets do the same      |
| How to detect dead connections?               | TCP Keep-Alive                          | HTTP/2: PING frames               |
| How to handle slow clients?                   | Timeouts + backpressure                 | Same — write() returns false      |

---

## 🚀 Quick Start

### Prerequisites

- Node.js 18+ and npm

### Install & Run

```bash
# Install dependencies
npm install

# Terminal 1: Start the server
npx tsx src/server/index.ts

# Terminal 2: Start the client
npx tsx src/client/index.ts
```

### Available Commands

Once connected, type these commands in the client:

| Command      | Description                                | Example                      |
| ------------ | ------------------------------------------ | ---------------------------- |
| `PING`       | Health check — server responds with PONG   | `PING` → `OK:PONG`           |
| `ECHO <msg>` | Echo back a message (tests data integrity) | `ECHO hello` → `OK:hello`    |
| `TIME`       | Get the server's current time              | `TIME` → `OK:2026-03-09T...` |
| `INFO`       | Get connection & server metadata           | `INFO` → connection stats    |
| `QUIT`       | Gracefully close the connection            | `QUIT` → `OK:Goodbye...`     |

### Test with raw netcat (no client needed!)

```bash
# Connect with netcat — raw TCP, no protocol parsing
nc localhost 9000

# Then type commands directly:
PING
ECHO hello from netcat
TIME
QUIT
```

This works because our protocol is text-based. Netcat sends raw bytes over TCP — proving that our server works with **any** TCP client.

---

## 🏗 Architecture

```
┌──────────────────────────────────────────────────────────┐
│                    APPLICATION LAYER                      │
│                                                          │
│  ┌──────────────┐         ┌──────────────┐              │
│  │  TCP Client   │         │  TCP Server   │              │
│  │  (interactive │  TCP    │  (multi-      │              │
│  │   CLI with    │◄──────►│   client with │              │
│  │   reconnect)  │  conn  │   graceful    │              │
│  │              │         │   shutdown)   │              │
│  └──────┬───────┘         └──────┬───────┘              │
│         │                        │                       │
│  ┌──────┴───────┐         ┌──────┴───────┐              │
│  │ Message      │         │ Connection   │              │
│  │ Parser       │         │ Handler      │              │
│  │ (stream      │         │ (command     │              │
│  │  framing)    │         │  execution)  │              │
│  └──────┬───────┘         └──────┬───────┘              │
│         │                        │                       │
│         └────────┬───────────────┘                       │
│                  │                                       │
│          ┌───────┴──────┐                                │
│          │  Protocol    │                                │
│          │  Definition  │                                │
│          │  (commands,  │                                │
│          │   format)    │                                │
│          └──────────────┘                                │
│                                                          │
├──────────────────────────────────────────────────────────┤
│                   NODE.JS / LIBUV                        │
│  net.Socket, net.Server, event loop, epoll/kqueue       │
├──────────────────────────────────────────────────────────┤
│               OPERATING SYSTEM KERNEL                    │
│  TCP/IP stack, socket buffers, connection queues         │
├──────────────────────────────────────────────────────────┤
│                  NETWORK INTERFACE                       │
│  Ethernet frames, Wi-Fi, physical medium                │
└──────────────────────────────────────────────────────────┘
```

---

## 🔍 The TCP Protocol — Behind the Scenes

### What is TCP?

**TCP (Transmission Control Protocol)** is a Layer 4 (Transport) protocol that provides:

| Feature                | Description                                              | How                               |
| ---------------------- | -------------------------------------------------------- | --------------------------------- |
| **Reliable delivery**  | Every byte you send will arrive (or you'll get an error) | Acknowledgments + retransmissions |
| **Ordered delivery**   | Bytes arrive in the same order they were sent            | Sequence numbers                  |
| **Error detection**    | Corrupted data is detected and discarded                 | Checksums                         |
| **Flow control**       | Sender won't overwhelm a slow receiver                   | Sliding window (rwnd)             |
| **Congestion control** | Sender adapts to network capacity                        | Slow start, AIMD, cubic           |
| **Full duplex**        | Both sides can send and receive simultaneously           | Independent send/receive buffers  |

**TCP does NOT provide:**

- Message boundaries (it's a BYTE STREAM, not a message protocol)
- Built-in encryption (that's what TLS adds)
- Message multiplexing (each connection is a single stream)

### The 3-Way Handshake (Connection Setup)

Every TCP connection begins with a 3-way handshake. This is what happens when our client calls `socket.connect()`:

```
     CLIENT                                          SERVER
     ──────                                          ──────
     State: CLOSED                                   State: LISTEN
        │                                               │
   ┌────┤ Step 1: SYN (Synchronize)                     │
   │    │──────────────────────────────────────────────→ │
   │    │  TCP Header:                                  │
   │    │    SYN flag = 1                               │
   │    │    Seq = ISN_client (e.g., 1000)              │
   │    │    Window Size = 65535                         │
   │    │    MSS option = 1460                           │
   │    │                                               │
   │    │  State: SYN_SENT                               │
   │    │                                               │
   │    │ Step 2: SYN-ACK                               │
   │    │ ←────────────────────────────────────────────  │
   │    │  TCP Header:                                  │
   │    │    SYN flag = 1, ACK flag = 1                 │
   │    │    Seq = ISN_server (e.g., 5000)              │
   │    │    Ack = ISN_client + 1 (1001)                │
   │    │    Window Size = 65535                         │
   │    │                                               │
   │    │                          State: SYN_RECEIVED   │
   │    │                                               │
   │    │ Step 3: ACK                                   │
   │    │──────────────────────────────────────────────→ │
   │    │  TCP Header:                                  │
   │    │    ACK flag = 1                               │
   │    │    Seq = 1001                                 │
   │    │    Ack = 5001                                 │
   │    │                                               │
   └────┤  State: ESTABLISHED         State: ESTABLISHED │
        │                                               │
        │  ✅ Connection ready for data transfer         │
        │                                               │
```

**Why 3 steps?** Both sides need to:

1. **Client → Server**: "Here's my initial sequence number" (SYN)
2. **Server → Client**: "Got it. Here's MY initial sequence number" (SYN-ACK)
3. **Client → Server**: "Got yours too" (ACK)

Now both sides know each other's starting sequence numbers, which are used to track every byte of data.

**What are ISNs?** Initial Sequence Numbers are randomly generated (not starting from 0) to prevent:

- Old packets from a previous connection being misinterpreted
- TCP sequence prediction attacks (security)

### Data Transfer

After the handshake, data flows as a stream of TCP segments:

```
CLIENT: socket.write("PING\n")

What actually happens:
┌─────────────────────────────────────────────────────────┐
│ Application: "PING\n" (5 bytes)                         │
├─────────────────────────────────────────────────────────┤
│ TCP Segment:                                            │
│  ┌─────────┬─────────┬──────┬──────┬──────┬──────────┐ │
│  │Src Port │Dst Port │ Seq  │ Ack  │Flags │ Window   │ │
│  │ 52461   │  9000   │ 1001 │ 5001 │ ACK  │ 65535    │ │
│  ├─────────┴─────────┴──────┴──────┴──────┴──────────┤ │
│  │             Payload: "PING\n"                      │ │
│  └───────────────────────────────────────────────────-┘ │
├─────────────────────────────────────────────────────────┤
│ IP Packet:                                              │
│  Src: 192.168.1.100   Dst: 192.168.1.200               │
│  Protocol: TCP (6)                                      │
├─────────────────────────────────────────────────────────┤
│ Ethernet Frame:                                         │
│  Src MAC: aa:bb:cc:dd:ee:ff   Dst MAC: 11:22:33:44:55  │
│  Type: IPv4 (0x0800)                                    │
└─────────────────────────────────────────────────────────┘

Server receives and ACKs:
┌─────────────────────────────────────────┐
│ ACK segment:                             │
│  Seq: 5001, Ack: 1006 (1001 + 5 bytes) │
│  "I received your bytes up to 1006"     │
└─────────────────────────────────────────┘
```

**Key points:**

- **Sequence numbers** track every byte (not every packet)
- **ACK numbers** tell the sender "I received everything up to this byte"
- **Window size** prevents the sender from overwhelming the receiver
- If an ACK doesn't arrive within the RTO (Retransmission Timeout), the segment is resent

### Connection Teardown (4-Way)

When our client sends `QUIT`, the server calls `socket.end()` which initiates TCP teardown:

```
     CLIENT                                          SERVER
     ──────                                          ──────
     State: ESTABLISHED                              State: ESTABLISHED
        │                                               │
        │  Step 1: FIN (client done sending)            │
        │──────────────────────────────────────────────→│
        │  State: FIN_WAIT_1                            │
        │                                               │
        │  Step 2: ACK (server acks the FIN)            │
        │←──────────────────────────────────────────────│
        │  State: FIN_WAIT_2              State: CLOSE_WAIT
        │                                               │
        │  Step 3: FIN (server done sending)            │
        │←──────────────────────────────────────────────│
        │                                 State: LAST_ACK
        │                                               │
        │  Step 4: ACK (client acks)                    │
        │──────────────────────────────────────────────→│
        │  State: TIME_WAIT               State: CLOSED │
        │                                               │
        │  (wait 2×MSL ≈ 60s)                          │
        │  State: CLOSED                                │
```

**Why 4 steps instead of 3?** Because TCP is full-duplex:

- Side A saying "I'm done sending" doesn't mean Side B is done
- Each side independently closes its sending direction

**Why TIME_WAIT?** The side that sends the last ACK waits ~60 seconds before fully closing:

1. In case the last ACK was lost (can retransmit)
2. To ensure old packets from this connection don't interfere with new ones

### TCP State Machine

All the states a TCP connection can be in:

```
                              ┌───────────┐
                              │  CLOSED   │
                              └─────┬─────┘
                           ┌────────┴────────┐
                      (server)             (client)
                      listen()            connect()
                           │                  │
                    ┌──────┴──────┐    ┌──────┴──────┐
                    │   LISTEN    │    │  SYN_SENT   │
                    └──────┬──────┘    └──────┬──────┘
                      rcv SYN              rcv SYN-ACK
                     snd SYN-ACK           snd ACK
                           │                  │
                    ┌──────┴──────┐           │
                    │SYN_RECEIVED │           │
                    └──────┬──────┘           │
                       rcv ACK               │
                           │                  │
                           └────────┬─────────┘
                             ┌──────┴──────┐
                             │ ESTABLISHED │ ← Data flows here
                             └──────┬──────┘
                                    │
                          close() / rcv FIN
                          ┌─────────┴─────────┐
                     ┌────┴─────┐       ┌─────┴────┐
                     │FIN_WAIT_1│       │CLOSE_WAIT│
                     └────┬─────┘       └─────┬────┘
                     rcv ACK             close()
                     ┌────┴─────┐       ┌─────┴────┐
                     │FIN_WAIT_2│       │ LAST_ACK │
                     └────┬─────┘       └─────┬────┘
                     rcv FIN             rcv ACK
                     ┌────┴─────┐             │
                     │TIME_WAIT │       ┌─────┴────┐
                     └────┬─────┘       │  CLOSED  │
                     2×MSL timeout      └──────────┘
                     ┌────┴─────┐
                     │  CLOSED  │
                     └──────────┘
```

---

## 📦 Our Custom Protocol

Since TCP only provides a byte stream, we define our own application-level protocol:

```
┌────────────────────────────────────────────┐
│  REQUEST FORMAT:                           │
│  COMMAND [arguments]\n                     │
│                                            │
│  Examples:                                 │
│    "PING\n"                                │
│    "ECHO hello world\n"                    │
│    "QUIT\n"                                │
├────────────────────────────────────────────┤
│  RESPONSE FORMAT:                          │
│  STATUS:MESSAGE\n                          │
│                                            │
│  Examples:                                 │
│    "OK:PONG\n"                             │
│    "OK:hello world\n"                      │
│    "ERROR:Unknown command\n"               │
├────────────────────────────────────────────┤
│  SERVER EVENTS:                            │
│  EVENT:NAME:DATA\n                         │
│                                            │
│  Examples:                                 │
│    "EVENT:WELCOME:Connected!\n"            │
│    "EVENT:SHUTDOWN:Server stopping\n"      │
└────────────────────────────────────────────┘
```

**The `\n` delimiter is critical!** Without it, the receiver has no way to know where one message ends and another begins. This is the most fundamental problem in TCP programming.

---

## 💡 Key Concepts Demonstrated

### 1. TCP Stream Framing

TCP gives you a byte stream, not messages. Our `MessageParser` class handles the challenge of extracting complete messages from arbitrary data chunks. [→ src/protocol/parser.ts](src/protocol/parser.ts)

### 2. Nagle's Algorithm & `setNoDelay`

By default, TCP batches small writes together for efficiency (Nagle's algorithm). We disable it for low-latency interactive communication. [→ src/server/handler.ts](src/server/handler.ts)

### 3. TCP Keep-Alive

Detects dead connections by sending periodic probe packets. Without it, a crashed client's connection would remain open indefinitely. [→ src/server/handler.ts](src/server/handler.ts)

### 4. Graceful Shutdown

Shows the proper sequence for shutting down a server: stop accepting → notify clients → wait for cleanup → exit. [→ src/server/tcp-server.ts](src/server/tcp-server.ts)

### 5. Exponential Backoff with Jitter

Industry-standard reconnection strategy that prevents the "thundering herd" problem. [→ src/client/reconnect.ts](src/client/reconnect.ts)

### 6. Socket Error Handling

Demonstrates the difference between RST (abrupt reset) and FIN (graceful close), and handles ECONNREFUSED, ECONNRESET, ETIMEDOUT, etc. [→ src/client/tcp-client.ts](src/client/tcp-client.ts)

---

## 📁 Project Structure

```
raw-tcp-server/
├── README.md              ← You are here
├── package.json           ← Dependencies & scripts
├── tsconfig.json          ← TypeScript configuration
├── Makefile               ← Convenience commands
├── src/
│   ├── server/
│   │   ├── index.ts       ← Server entry point (signal handling)
│   │   ├── tcp-server.ts  ← TCP server (socket/bind/listen/accept)
│   │   ├── handler.ts     ← Per-connection handler (data flow, lifecycle)
│   │   └── metrics.ts     ← Connection & server metrics
│   ├── client/
│   │   ├── index.ts       ← Client entry point
│   │   ├── tcp-client.ts  ← Interactive TCP client
│   │   └── reconnect.ts   ← Exponential backoff reconnection
│   └── protocol/
│       ├── protocol.ts    ← Protocol definition (commands, format)
│       └── parser.ts      ← Stream framing & message parsing
└── docs/
    ├── tcp-handshake.md   ← Deep dive: 3-way handshake
    └── data-transfer.md   ← Deep dive: segmentation & flow control
```

---

## 🔧 Configuration

| Environment Variable | Default   | Description            |
| -------------------- | --------- | ---------------------- |
| `PORT`               | `9000`    | Server listening port  |
| `HOST`               | `0.0.0.0` | Server bind address    |
| `MAX_CONNECTIONS`    | `100`     | Max concurrent clients |
| `AUTO_RECONNECT`     | `true`    | Client auto-reconnect  |

```bash
# Custom configuration
PORT=8080 MAX_CONNECTIONS=50 npx tsx src/server/index.ts
```

---

## 📚 Further Reading

### RFCs (The Source of Truth)

- [RFC 793](https://tools.ietf.org/html/rfc793) — Transmission Control Protocol (original TCP spec)
- [RFC 7414](https://tools.ietf.org/html/rfc7414) — TCP Roadmap (index of all TCP-related RFCs)
- [RFC 6298](https://tools.ietf.org/html/rfc6298) — TCP Retransmission Timer

### Recommended Reading

- [Beej's Guide to Network Programming](https://beej.us/guide/bgnet/) — The classic sockets tutorial
- [TCP/IP Illustrated, Vol. 1](https://www.amazon.com/TCP-Illustrated-Vol-Addison-Wesley-Professional/dp/0201633469) by W. Richard Stevens
- [High Performance Browser Networking](https://hpbn.co/) by Ilya Grigorik (free online)

### Tools for Inspecting TCP

```bash
# Watch TCP connections in real-time
watch -n 1 'netstat -an | grep 9000'

# Capture TCP packets (see the actual SYN/ACK/FIN)
sudo tcpdump -i lo0 port 9000 -vv

# See socket states
ss -tn | grep 9000

# See what process is using a port
lsof -i :9000
```

---

## 📄 License

MIT — Build, learn, and share! 🚀
