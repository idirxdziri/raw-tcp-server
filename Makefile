.PHONY: server client build clean

# Start the TCP server
server:
	npx tsx src/server/index.ts

# Start the TCP client
client:
	npx tsx src/client/index.ts

# Start server in watch mode (auto-restart on file changes)
dev:
	npx tsx watch src/server/index.ts

# Build TypeScript to JavaScript
build:
	npx tsc

# Clean build artifacts
clean:
	rm -rf dist

# Install dependencies
install:
	npm install

# Run with custom port
# Usage: make server-port PORT=8080
server-port:
	PORT=$(PORT) npx tsx src/server/index.ts

# Test with netcat (raw TCP, no client needed)
# Usage: make nc-test
nc-test:
	@echo "Connecting with netcat (raw TCP)..."
	@echo "Type commands manually (PING, ECHO hello, TIME, QUIT)"
	@echo "Press Ctrl+C to disconnect"
	nc localhost 9000
