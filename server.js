// server.js
// PM2 Live Log Viewer – enhanced + per-process links

const express = require("express");
const path = require("path");
const { execSync, spawn } = require("child_process");
const WebSocket = require("ws");
const http = require("http");
const { URL } = require("url");
const fs = require("fs");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// 🔐 Change this to something strong (or set env LOG_VIEWER_KEY)
const SECRET_KEY = process.env.LOG_VIEWER_KEY || "CHANGE_THIS_KEY";

// ---------- PM2 helpers ----------

function getPm2List() {
  const raw = execSync("pm2 jlist").toString();
  return JSON.parse(raw);
}

function getProcessById(pm2Id) {
  const list = getPm2List();
  return list.find((p) => String(p.pm_id) === String(pm2Id));
}

function getLogInfo(pm2Id) {
  const proc = getProcessById(pm2Id);
  if (!proc) return null;

  const env = proc.pm2_env || {};
  const monit = proc.monit || {};

  return {
    id: proc.pm_id,
    name: env.name || proc.name || `pm2-${proc.pm_id}`,
    status: env.status,
    out: env.pm_out_log_path,
    err: env.pm_err_log_path,
    cpu: monit.cpu,
    memory: monit.memory,
    uptime: env.pm_uptime,
  };
}

// ---------- HTTP auth middleware ----------

function requireKey(req, res, next) {
  const key = req.query.key;
  if (key !== SECRET_KEY) {
    return res.status(401).send("Unauthorized");
  }
  next();
}

// ---------- Routes ----------

// (optional) static if you ever need extra assets
app.use("/static", express.static(path.join(__dirname)));

// Master page: dropdown, you can choose any process
app.get("/", requireKey, (req, res) => {
  res.sendFile(path.join(__dirname, "viewer.html"));
});

// Direct link for single process:
// Example: http://IP:5000/logs/24?key=SECRET_KEY
// viewer.html will read the ":id" from URL and auto-select it.
app.get("/logs/:id", requireKey, (req, res) => {
  res.sendFile(path.join(__dirname, "viewer.html"));
});

// API to get PM2 process list (used by the master page)
// If called from /logs/:id, only return that specific process
app.get("/api/processes", requireKey, (req, res) => {
  try {
    const list = getPm2List();
    
    // Check if restricted by URL
    const restrictedId = req.query.restrictedId;

    let mapped = list.map((p) => {
      const env = p.pm2_env || {};
      const monit = p.monit || {};

      return {
        id: p.pm_id,
        name: env.name || p.name,
        status: env.status,
        cpu: monit.cpu,
        memory: monit.memory,
        uptime: env.pm_uptime,
        out: env.pm_out_log_path,
        err: env.pm_err_log_path,
      };
    });

    // If restricted, only return that process
    if (restrictedId) {
      mapped = mapped.filter((p) => String(p.id) === String(restrictedId));
      if (mapped.length === 0) {
        return res.status(404).json({ success: false, error: "Process not found" });
      }
    }

    res.json({ success: true, processes: mapped });
  } catch (err) {
    console.error("Error getting pm2 list:", err);
    res.status(500).json({ success: false, error: "Failed to get PM2 list" });
  }
});

// Export logs endpoint
app.get("/api/logs/export/:id", requireKey, (req, res) => {
  try {
    const pm2Id = req.params.id;
    const logInfo = getLogInfo(pm2Id);

    if (!logInfo || !logInfo.out) {
      return res.status(404).json({ error: "Process not found" });
    }

    // Read the log file
    if (!fs.existsSync(logInfo.out)) {
      return res.status(404).json({ error: "Log file not found" });
    }

    const logContent = fs.readFileSync(logInfo.out, "utf-8");
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filename = `${logInfo.name}-${pm2Id}-${timestamp}.log`;

    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("Content-Type", "text/plain");
    res.send(logContent);
  } catch (err) {
    console.error("Error exporting logs:", err);
    res.status(500).json({ error: "Failed to export logs" });
  }
});

// ---------- PM2 Process Control Endpoints ----------

// Start a process
app.post("/api/processes/:id/start", requireKey, (req, res) => {
  try {
    const pm2Id = req.params.id;
    const proc = getProcessById(pm2Id);
    
    if (!proc) {
      return res.status(404).json({ success: false, error: "Process not found" });
    }

    const name = proc.pm2_env?.name || proc.name || `pm2-${pm2Id}`;
    execSync(`pm2 start ${name}`);
    
    res.json({ success: true, message: `Process ${name} started` });
  } catch (err) {
    console.error("Error starting process:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Stop a process
app.post("/api/processes/:id/stop", requireKey, (req, res) => {
  try {
    const pm2Id = req.params.id;
    const proc = getProcessById(pm2Id);
    
    if (!proc) {
      return res.status(404).json({ success: false, error: "Process not found" });
    }

    const name = proc.pm2_env?.name || proc.name || `pm2-${pm2Id}`;
    execSync(`pm2 stop ${name}`);
    
    res.json({ success: true, message: `Process ${name} stopped` });
  } catch (err) {
    console.error("Error stopping process:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Restart a process
app.post("/api/processes/:id/restart", requireKey, (req, res) => {
  try {
    const pm2Id = req.params.id;
    const proc = getProcessById(pm2Id);
    
    if (!proc) {
      return res.status(404).json({ success: false, error: "Process not found" });
    }

    const name = proc.pm2_env?.name || proc.name || `pm2-${pm2Id}`;
    execSync(`pm2 restart ${name}`);
    
    res.json({ success: true, message: `Process ${name} restarted` });
  } catch (err) {
    console.error("Error restarting process:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Save PM2 state
app.post("/api/pm2/save", requireKey, (req, res) => {
  try {
    execSync("pm2 save");
    res.json({ success: true, message: "PM2 state saved successfully" });
  } catch (err) {
    console.error("Error saving PM2 state:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------- WebSocket for logs ----------
// ws://host/ws?id=PM2_ID&key=SECRET_KEY&restrictedId=PM2_ID (optional)
wss.on("connection", (ws, req) => {
  try {
    const url = new URL(req.url, "http://localhost");
    const id = url.searchParams.get("id");
    const key = url.searchParams.get("key");
    const restrictedId = url.searchParams.get("restrictedId");

    if (!key || key !== SECRET_KEY) {
      ws.send(JSON.stringify({ type: "error", message: "Unauthorized" }));
      ws.close();
      return;
    }

    if (!id) {
      ws.send(JSON.stringify({ type: "error", message: "Missing id" }));
      ws.close();
      return;
    }

    // If restricted to a specific process, enforce it
    if (restrictedId && String(id) !== String(restrictedId)) {
      ws.send(
        JSON.stringify({
          type: "error",
          message: "Access denied: restricted to a different process",
        })
      );
      ws.close();
      return;
    }

    const logInfo = getLogInfo(id);

    if (!logInfo || !logInfo.out) {
      ws.send(
        JSON.stringify({
          type: "error",
          message: `Invalid PM2 id or no log path for id=${id}`,
        })
      );
      ws.close();
      return;
    }

    console.log(`🔌 WebSocket connected for PM2 id=${id} (${logInfo.name})`);

    // Initial meta info
    try {
      ws.send(
        JSON.stringify({
          type: "meta",
          process: {
            id: logInfo.id,
            name: logInfo.name,
            status: logInfo.status,
            cpu: logInfo.cpu,
            memory: logInfo.memory,
            uptime: logInfo.uptime,
            out: logInfo.out,
            err: logInfo.err,
          },
        })
      );
    } catch (e) {
      console.error("Error sending initial meta:", e.message);
    }

    // Tail stdout (last 200 lines then follow)
    const tailOut = spawn("tail", ["-n", "200", "-F", logInfo.out]);

    tailOut.on("error", (err) => {
      console.error(`Tail error for ${logInfo.out}:`, err.message);
      // Don't close WebSocket on tail file errors - just log them
      // The connection can continue if the file appears later
    });

    tailOut.stdout.on("data", (data) => {
      try {
        if (ws.readyState === 1) { // 1 = OPEN
          ws.send(
            JSON.stringify({
              type: "log",
              stream: "out",
              data: data.toString(),
              timestamp: Date.now(),
            })
          );
        }
      } catch (e) {
        console.error("Error sending log data:", e.message);
      }
    });

    tailOut.stderr.on("data", (data) => {
      try {
        if (ws.readyState === 1) {
          ws.send(
            JSON.stringify({
              type: "log",
              stream: "out-error",
              data: data.toString(),
              timestamp: Date.now(),
            })
          );
        }
      } catch (e) {
        console.error("Error sending log error data:", e.message);
      }
    });

    tailOut.on("exit", (code, signal) => {
      // Only log if it's an actual error code (not killed by signal)
      if (typeof code === "number" && code > 0) {
        console.error(`Stdout tail exited with code ${code} for ${logInfo.out}`);
      } else if (signal) {
        console.log(`Stdout tail killed by signal ${signal}`);
      }
    });

    // Tail stderr if different
    let tailErr = null;
    if (logInfo.err && logInfo.err !== logInfo.out) {
      tailErr = spawn("tail", ["-n", "200", "-F", logInfo.err]);

      tailErr.on("error", (err) => {
        console.error(`Tail error for ${logInfo.err}:`, err.message);
        // Don't close WebSocket on tail file errors - just log them
        // The connection can continue if the file appears later
      });

      tailErr.stdout.on("data", (data) => {
        try {
          if (ws.readyState === 1) {
            ws.send(
              JSON.stringify({
                type: "log",
                stream: "err",
                data: data.toString(),
                timestamp: Date.now(),
              })
            );
          }
        } catch (e) {
          console.error("Error sending err log data:", e.message);
        }
      });

      tailErr.stderr.on("data", (data) => {
        try {
          if (ws.readyState === 1) {
            ws.send(
              JSON.stringify({
                type: "log",
                stream: "err-error",
                data: data.toString(),
                timestamp: Date.now(),
              })
            );
          }
        } catch (e) {
          console.error("Error sending err log error data:", e.message);
        }
      });

      tailErr.on("exit", (code, signal) => {
        // Only log if it's an actual error code (not killed by signal)
        if (typeof code === "number" && code > 0) {
          console.error(`Stderr tail exited with code ${code} for ${logInfo.err}`);
        } else if (signal) {
          console.log(`Stderr tail killed by signal ${signal}`);
        }
      });
    }

    // Periodic CPU/RAM stats
    const statsInterval = setInterval(() => {
      try {
        if (ws.readyState !== 1) return; // Only send if connection is open
        
        const updated = getLogInfo(id);
        if (!updated) return;

        ws.send(
          JSON.stringify({
            type: "stats",
            cpu: updated.cpu,
            memory: updated.memory,
            status: updated.status,
            uptime: updated.uptime,
            timestamp: Date.now(),
          })
        );
      } catch (err) {
        console.error("Error sending stats:", err.message);
      }
    }, 5000);

    // Heartbeat ping-pong to keep connection alive (especially through proxies)
    let pongReceived = true;
    const heartbeatInterval = setInterval(() => {
      if (ws.readyState === 1) { // OPEN
        if (!pongReceived) {
          console.log(`No pong received for PM2 id=${id}. Terminating stale connection.`);
          ws.terminate();
          return;
        }
        pongReceived = false;
        try {
          ws.ping();
        } catch (err) {
          console.error("Error sending ping:", err.message);
        }
      }
    }, 15000); // Send ping every 15 seconds (before most firewalls close at 30-120s)

    ws.on("pong", () => {
      pongReceived = true;
    });

    ws.on("close", () => {
      console.log(`🔌 WebSocket closed for PM2 id=${id}`);
      try {
        tailOut.kill();
      } catch (_) {}
      if (tailErr) {
        try {
          tailErr.kill();
        } catch (_) {}
      }
      clearInterval(statsInterval);
      clearInterval(heartbeatInterval);
    });

    ws.on("error", (err) => {
      console.error("WebSocket error:", err);
    });
  } catch (err) {
    console.error("WS connection error:", err);
    try {
      ws.send(JSON.stringify({ type: "error", message: "Internal error" }));
    } catch (_) {}
    ws.close();
  }
});

const PORT = process.env.PORT || 1111;
server.listen(PORT, () => {
  console.log(`🔥 PM2 Live Log Viewer running on port ${PORT}`);
  console.log(`   Master page: http://147.93.40.215:${PORT}/?key=${SECRET_KEY}`);
  console.log(
    `   Per-process: http://147.93.40.215:${PORT}/logs/<PM2_ID>?key=${SECRET_KEY}`
  );
});
