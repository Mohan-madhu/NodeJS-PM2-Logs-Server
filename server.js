// server.js
// PM2 Live Log Viewer – enhanced + per-process links

const express = require("express");
const path = require("path");
const { execSync, spawn } = require("child_process");
const WebSocket = require("ws");
const http = require("http");
const { URL } = require("url");

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
app.get("/api/processes", requireKey, (req, res) => {
  try {
    const list = getPm2List();

    const mapped = list.map((p) => {
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

    res.json({ success: true, processes: mapped });
  } catch (err) {
    console.error("Error getting pm2 list:", err);
    res.status(500).json({ success: false, error: "Failed to get PM2 list" });
  }
});

// ---------- WebSocket for logs ----------
// ws://host/ws?id=PM2_ID&key=SECRET_KEY
wss.on("connection", (ws, req) => {
  try {
    const url = new URL(req.url, "http://localhost");
    const id = url.searchParams.get("id");
    const key = url.searchParams.get("key");

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

    // Tail stdout (last 200 lines then follow)
    const tailOut = spawn("tail", ["-n", "200", "-F", logInfo.out]);

    tailOut.stdout.on("data", (data) => {
      ws.send(
        JSON.stringify({
          type: "log",
          stream: "out",
          data: data.toString(),
          timestamp: Date.now(),
        })
      );
    });

    tailOut.stderr.on("data", (data) => {
      ws.send(
        JSON.stringify({
          type: "log",
          stream: "out-error",
          data: data.toString(),
          timestamp: Date.now(),
        })
      );
    });

    // Tail stderr if different
    let tailErr = null;
    if (logInfo.err && logInfo.err !== logInfo.out) {
      tailErr = spawn("tail", ["-n", "200", "-F", logInfo.err]);

      tailErr.stdout.on("data", (data) => {
        ws.send(
          JSON.stringify({
            type: "log",
            stream: "err",
            data: data.toString(),
            timestamp: Date.now(),
          })
        );
      });

      tailErr.stderr.on("data", (data) => {
        ws.send(
          JSON.stringify({
            type: "log",
            stream: "err-error",
            data: data.toString(),
            timestamp: Date.now(),
          })
        );
      });
    }

    // Periodic CPU/RAM stats
    const statsInterval = setInterval(() => {
      try {
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
        // ignore transient errors
      }
    }, 5000);

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