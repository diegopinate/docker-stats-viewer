const express = require("express");
const { spawn } = require("child_process");
const WebSocket = require("ws");
const path = require("path");
const http = require("http");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = 3000;

// Serve static files
app.use(express.static(path.join(__dirname, "public")));

// Store active docker stats processes with WebSocket references
const statsProcesses = new Map(); // containerId -> { process, ws, timeoutId }

// Get list of running containers
app.get("/api/containers", (req, res) => {
  // Include exited containers in the list by using -a flag
  const dockerPs = spawn("docker", ["ps", "-a", "--format", "json"]);
  let output = "";
  let error = "";

  dockerPs.stdout.on("data", (data) => {
    output += data.toString();
  });

  dockerPs.stderr.on("data", (data) => {
    error += data.toString();
  });

  dockerPs.on("close", (code) => {
    if (code !== 0) {
      return res
        .status(500)
        .json({ error: "Failed to get containers: " + error });
    }

    try {
      const lines = output
        .trim()
        .split("\n")
        .filter((line) => line.trim());
      if (lines.length === 0) {
        return res.json([]);
      }

      const containers = lines.map((line) => {
        const container = JSON.parse(line);
        return {
          id: container.ID,
          name: container.Names,
          image: container.Image,
          status: container.Status,
          state: container.State,
        };
      });

      res.json(containers);
    } catch (parseError) {
      console.error("Error parsing container data:", parseError);
      res.status(500).json({ error: "Failed to parse container data" });
    }
  });
});

// WebSocket connection handling
wss.on("connection", (ws) => {
  console.log("Client connected");
  ws.containerIds = new Set(); // Track containers this client is subscribed to

  ws.on("message", (message) => {
    try {
      const data = JSON.parse(message);

      if (data.type === "subscribe") {
        const refreshRate = data.refreshRate || 2000; // Default to 2 seconds
        ws.containerIds.add(data.containerId);
        startStatsStream(ws, data.containerId, refreshRate);
      } else if (data.type === "unsubscribe") {
        ws.containerIds.delete(data.containerId);
        stopStatsStream(data.containerId, ws);
      }
    } catch (error) {
      console.error("Error parsing WebSocket message:", error);
    }
  });

  ws.on("close", () => {
    console.log("Client disconnected");
    // Clean up all subscriptions for this client
    if (ws.containerIds) {
      ws.containerIds.forEach((containerId) => {
        stopStatsStream(containerId, ws);
      });
    }
  });

  ws.on("error", (error) => {
    console.error("WebSocket error:", error);
  });
});

function startStatsStream(ws, containerId, refreshRate = 2000) {
  // Stop existing process if running
  stopStatsStream(containerId, ws);

  console.log(
    `Starting stats stream for container: ${containerId} with ${refreshRate}ms refresh rate`
  );

  // First check if container is running before trying to get stats
  const dockerInspect = spawn("docker", [
    "inspect",
    containerId,
    "--format",
    "{{.State.Status}}",
  ]);
  let inspectOutput = "";

  dockerInspect.stdout.on("data", (data) => {
    inspectOutput += data.toString();
  });

  dockerInspect.on("close", (code) => {
    const status = inspectOutput.trim();

    if (status !== "running") {
      // Container is not running, send a status update instead of stats
      if (
        ws.readyState === WebSocket.OPEN &&
        ws.containerIds &&
        ws.containerIds.has(containerId)
      ) {
        ws.send(
          JSON.stringify({
            type: "status",
            containerId: containerId,
            status: status,
            timestamp: Date.now(),
          })
        );
      }

      // Schedule next check for non-running containers
      if (
        ws.readyState === WebSocket.OPEN &&
        ws.containerIds &&
        ws.containerIds.has(containerId)
      ) {
        const timeoutId = setTimeout(() => {
          if (
            ws.readyState === WebSocket.OPEN &&
            ws.containerIds &&
            ws.containerIds.has(containerId)
          ) {
            startStatsStream(ws, containerId, refreshRate);
          }
        }, refreshRate);

        const processInfo = {
          process: null,
          ws: ws,
          timeoutId: timeoutId,
        };
        statsProcesses.set(containerId, processInfo);
      }
      return;
    }

    // Container is running, proceed with stats collection
    const dockerStats = spawn("docker", [
      "stats",
      containerId,
      "--no-stream",
      "--format",
      "table {{.Container}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.MemPerc}}\t{{.NetIO}}\t{{.BlockIO}}\t{{.PIDs}}",
    ]);

    const processInfo = {
      process: dockerStats,
      ws: ws,
      timeoutId: null,
    };
    statsProcesses.set(containerId, processInfo);

    let output = "";
    let error = "";

    dockerStats.stdout.on("data", (data) => {
      output += data.toString();
    });

    dockerStats.stderr.on("data", (data) => {
      error += data.toString();
    });

    dockerStats.on("close", (code) => {
      const currentProcessInfo = statsProcesses.get(containerId);

      if (!currentProcessInfo || currentProcessInfo.process !== dockerStats) {
        return;
      }

      if (code === 0 && output.trim()) {
        try {
          const lines = output.trim().split("\n");
          if (lines.length > 1) {
            const dataLine = lines[1];
            const processedStats = parseStatsLine(dataLine);

            if (
              ws.readyState === WebSocket.OPEN &&
              ws.containerIds &&
              ws.containerIds.has(containerId)
            ) {
              ws.send(
                JSON.stringify({
                  type: "stats",
                  containerId: containerId,
                  data: processedStats,
                  timestamp: Date.now(),
                })
              );
            }
          }
        } catch (parseError) {
          console.error("Error parsing docker stats:", parseError);
        }
      } else if (code !== 0) {
        console.error(`Docker stats error for ${containerId}:`, error);
      }

      if (currentProcessInfo && currentProcessInfo.process === dockerStats) {
        statsProcesses.delete(containerId);
      }

      if (
        ws.readyState === WebSocket.OPEN &&
        ws.containerIds &&
        ws.containerIds.has(containerId)
      ) {
        const timeoutId = setTimeout(() => {
          if (
            ws.readyState === WebSocket.OPEN &&
            ws.containerIds &&
            ws.containerIds.has(containerId)
          ) {
            startStatsStream(ws, containerId, refreshRate);
          }
        }, refreshRate);

        const newProcessInfo = statsProcesses.get(containerId);
        if (newProcessInfo) {
          newProcessInfo.timeoutId = timeoutId;
        }
      }
    });

    dockerStats.on("error", (error) => {
      console.error("Docker stats spawn error:", error);
      const currentProcessInfo = statsProcesses.get(containerId);
      if (currentProcessInfo && currentProcessInfo.process === dockerStats) {
        statsProcesses.delete(containerId);
      }
    });
  });
}

function stopStatsStream(containerId, ws = null) {
  const processInfo = statsProcesses.get(containerId);

  if (processInfo) {
    // Only stop if no specific WebSocket is provided or if it matches the stored WebSocket
    if (!ws || processInfo.ws === ws) {
      if (processInfo.process && !processInfo.process.killed) {
        processInfo.process.kill();
      }

      // Clear any pending timeout
      if (processInfo.timeoutId) {
        clearTimeout(processInfo.timeoutId);
      }

      statsProcesses.delete(containerId);
      console.log(`Stopped stats stream for container: ${containerId}`);
    }
  }
}

function parseStatsLine(line) {
  // Split by multiple spaces and filter out empty strings
  const parts = line.split(/\s+/).filter((part) => part.trim() !== "");

  if (parts.length < 7) {
    console.error("Unexpected stats line format:", line);
    console.error("Parsed parts:", parts);
    return {
      name: "unknown",
      cpuPercent: 0,
      memUsed: 0,
      memTotal: 0,
      memPercent: 0,
      netIn: 0,
      netOut: 0,
      blockRead: 0,
      blockWrite: 0,
      pids: 0,
    };
  }

  // Handle the case where memory usage might be "0B / 0B" (3 parts) or "1.5GiB / 7.7GiB" (3 parts)
  // The format is: CONTAINER CPU% MEM_USED / MEM_TOTAL MEM% NET_IN / NET_OUT BLOCK_READ / BLOCK_WRITE PIDS
  const [container, cpuPerc] = parts;

  // Find the memory usage parts (look for the pattern "X / Y")
  let memUsageStartIndex = 2;
  let memUsage = `${parts[memUsageStartIndex]} ${
    parts[memUsageStartIndex + 1]
  } ${parts[memUsageStartIndex + 2]}`;

  // Memory percentage is after the memory usage
  let memPercIndex = memUsageStartIndex + 3;
  const memPerc = parts[memPercIndex];

  // Network I/O is next (X / Y format)
  let netIOStartIndex = memPercIndex + 1;
  const netIO = `${parts[netIOStartIndex]} ${parts[netIOStartIndex + 1]} ${
    parts[netIOStartIndex + 2]
  }`;

  // Block I/O is next (X / Y format)
  let blockIOStartIndex = netIOStartIndex + 3;
  const blockIO = `${parts[blockIOStartIndex]} ${
    parts[blockIOStartIndex + 1]
  } ${parts[blockIOStartIndex + 2]}`;

  // PIDs is the last field
  const pids = parts[parts.length - 1];

  // Parse CPU percentage
  const cpuPercent = parseFloat(cpuPerc.replace("%", "")) || 0;

  // Parse memory usage (e.g., "1.5GiB / 7.7GiB")
  const memParts = memUsage.split(" / ");
  const memUsed = parseMemory(memParts[0]?.trim() || "0B");
  const memTotal = parseMemory(memParts[1]?.trim() || "0B");
  const memPercent = parseFloat(memPerc.replace("%", "")) || 0;

  // Parse network I/O (e.g., "1.2kB / 648B")
  const netParts = netIO.split(" / ");
  const netIn = parseMemory(netParts[0]?.trim() || "0B");
  const netOut = parseMemory(netParts[1]?.trim() || "0B");

  // Parse block I/O (e.g., "0B / 0B")
  const blockParts = blockIO.split(" / ");
  const blockRead = parseMemory(blockParts[0]?.trim() || "0B");
  const blockWrite = parseMemory(blockParts[1]?.trim() || "0B");

  console.log(`Parsed stats for ${container}:`, {
    cpuPercent,
    memPercent,
    memUsed,
    memTotal,
    netIn,
    netOut,
    pids: parseInt(pids) || 0,
  });

  return {
    name: container,
    cpuPercent,
    memUsed,
    memTotal,
    memPercent,
    netIn,
    netOut,
    blockRead,
    blockWrite,
    pids: parseInt(pids) || 0,
  };
}

function parseMemory(memStr) {
  if (!memStr) return 0;

  const units = {
    B: 1,
    kB: 1000,
    KB: 1024,
    MB: 1000000,
    MiB: 1024 * 1024,
    GB: 1000000000,
    GiB: 1024 * 1024 * 1024,
    TB: 1000000000000,
    TiB: 1024 * 1024 * 1024 * 1024,
  };

  const match = memStr.match(/^([\d.]+)(\w+)$/);
  if (!match) return 0;

  const value = parseFloat(match[1]);
  const unit = match[2];
  return value * (units[unit] || 1);
}

// Start server
server.listen(PORT, () => {
  console.log(`Docker Stats Viewer running at http://localhost:${PORT}`);
  console.log("Make sure Docker is running and containers are available");
});
