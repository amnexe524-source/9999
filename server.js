#!/usr/bin/env node
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { exec, execSync } = require('child_process');
const os = require('os');
const fetch = require('node-fetch');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const PORT = 3000;
const CONFIG_PATH = path.join(__dirname, 'ai_config.json');
const DOWNLOAD_DIR = '/storage/emulated/0/Download';
const UPLOAD_DIR = fs.existsSync(DOWNLOAD_DIR) ? DOWNLOAD_DIR : path.join(__dirname, 'uploads');

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// Multer setup
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => cb(null, Date.now() + '_' + file.originalname)
});
const upload = multer({ storage, limits: { fileSize: 100 * 1024 * 1024 } });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Config API ────────────────────────────────────────────────────────────
app.get('/api/config', (req, res) => {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      res.json(JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')));
    } else {
      res.json({ apiKey: '', model: 'openai/gpt-4o-mini' });
    }
  } catch { res.json({ apiKey: '', model: 'openai/gpt-4o-mini' }); }
});

app.post('/api/config', (req, res) => {
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(req.body, null, 2));
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── System Stats ───────────────────────────────────────────────────────────
function readFile(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return ''; }
}

function getMemInfo() {
  const info = {};
  readFile('/proc/meminfo').split('\n').forEach(line => {
    const [k, v] = line.split(':');
    if (k && v) info[k.trim()] = parseInt(v.trim()) * 1024;
  });
  return info;
}

function getCpuTimes() {
  const lines = readFile('/proc/stat').split('\n');
  for (const l of lines) {
    if (l.startsWith('cpu ')) return l.trim().split(/\s+/).slice(1).map(Number);
  }
  return Array(10).fill(0);
}

let prevCpu = getCpuTimes();
function getCpuPercent() {
  const curr = getCpuTimes();
  const prevTotal = prevCpu.reduce((a, b) => a + b, 0);
  const currTotal = curr.reduce((a, b) => a + b, 0);
  const prevIdle = prevCpu[3];
  const currIdle = curr[3];
  const totalDiff = currTotal - prevTotal;
  const idleDiff = currIdle - prevIdle;
  prevCpu = curr;
  return totalDiff > 0 ? 100 * (1 - idleDiff / totalDiff) : 0;
}

function bytesHuman(n) {
  const units = ['B','KiB','MiB','GiB','TiB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(1)} ${units[i]}`;
}

function getStats() {
  const mem = getMemInfo();
  const ramTotal = mem.MemTotal || 0;
  const ramAvail = mem.MemAvailable || 0;
  const ramUsed = ramTotal - ramAvail;
  const swapTotal = mem.SwapTotal || 0;
  const swapFree = mem.SwapFree || 0;
  const swapUsed = swapTotal - swapFree;

  const load = readFile('/proc/loadavg').trim().split(' ').slice(0, 3).map(Number);
  const uptime = parseFloat(readFile('/proc/uptime').split(' ')[0] || 0);

  // Disk
  let diskTotal = 0, diskUsed = 0, diskFree = 0, diskPct = 0;
  try {
    const df = execSync('df -k / 2>/dev/null || df -k /data', { timeout: 3000 }).toString();
    const parts = df.split('\n')[1]?.split(/\s+/);
    if (parts) {
      diskTotal = parseInt(parts[1]) * 1024;
      diskUsed = parseInt(parts[2]) * 1024;
      diskFree = parseInt(parts[3]) * 1024;
      diskPct = diskTotal > 0 ? (diskUsed / diskTotal) * 100 : 0;
    }
  } catch {}

  // CPU temp
  let temp = null;
  const thermals = [];
  try {
    const zones = fs.readdirSync('/sys/class/thermal').filter(d => d.startsWith('thermal_zone'));
    for (const z of zones) {
      try {
        const t = parseInt(readFile(`/sys/class/thermal/${z}/temp`)) / 1000;
        if (t > 0) thermals.push(t);
      } catch {}
    }
    if (thermals.length) temp = Math.max(...thermals);
  } catch {}

  // Battery
  let battery = null;
  try {
    const res = execSync('termux-battery-status 2>/dev/null', { timeout: 5000 }).toString();
    battery = JSON.parse(res);
  } catch {}

  // Network
  const net = {};
  readFile('/proc/net/dev').split('\n').slice(2).forEach(line => {
    const p = line.trim().split(/\s+/);
    if (p.length >= 10) {
      const iface = p[0].replace(':', '');
      if (iface !== 'lo') net[iface] = { rx: parseInt(p[1]), tx: parseInt(p[9]) };
    }
  });

  // Processes
  let procs = [];
  try {
    const ps = execSync('ps -eo pid,user,comm,%cpu,%mem --sort=-%cpu 2>/dev/null | head -12', { timeout: 3000 }).toString();
    procs = ps.split('\n').slice(1).filter(Boolean).map(line => {
      const p = line.trim().split(/\s+/);
      return { pid: p[0], user: p[1], comm: p[2], cpu: p[3], mem: p[4] };
    }).filter(p => p.pid);
  } catch {}

  // System info (cached)
  let sysinfo = {};
  try {
    sysinfo = {
      arch: os.arch(),
      cores: os.cpus().length,
      cpuModel: os.cpus()[0]?.model || 'Unknown',
      kernel: readFile('/proc/version').slice(0, 80),
      hostname: os.hostname()
    };
    try { sysinfo.android = execSync('getprop ro.build.version.release 2>/dev/null', { timeout: 2000 }).toString().trim(); } catch {}
    try { sysinfo.device = execSync('getprop ro.product.model 2>/dev/null', { timeout: 2000 }).toString().trim(); } catch {}
  } catch {}

  return {
    ts: Date.now(),
    cpu: getCpuPercent(),
    load,
    uptime,
    temp,
    ram: { total: ramTotal, used: ramUsed, avail: ramAvail, pct: ramTotal > 0 ? (ramUsed / ramTotal) * 100 : 0 },
    swap: { total: swapTotal, used: swapUsed, pct: swapTotal > 0 ? (swapUsed / swapTotal) * 100 : 0 },
    disk: { total: diskTotal, used: diskUsed, free: diskFree, pct: diskPct },
    battery,
    net,
    procs,
    sysinfo
  };
}

app.get('/api/stats', (req, res) => {
  try { res.json(getStats()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── File APIs ──────────────────────────────────────────────────────────────
app.post('/api/upload', upload.array('files'), (req, res) => {
  const saved = req.files.map(f => ({ name: f.originalname, path: f.path, size: f.size }));
  res.json({ ok: true, files: saved });
});

app.get('/api/files', (req, res) => {
  const dir = req.query.dir || UPLOAD_DIR;
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const files = entries.map(e => ({
      name: e.name,
      type: e.isDirectory() ? 'dir' : 'file',
      path: path.join(dir, e.name),
      size: e.isFile() ? fs.statSync(path.join(dir, e.name)).size : 0,
      mtime: fs.statSync(path.join(dir, e.name)).mtime
    }));
    res.json({ dir, files });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/download', (req, res) => {
  const fp = req.query.path;
  if (!fp) return res.status(400).json({ error: 'No path' });
  try { res.download(fp); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/delete', (req, res) => {
  const { filePath } = req.body;
  try { fs.unlinkSync(filePath); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Execute Command ─────────────────────────────────────────────────────────
app.post('/api/exec', (req, res) => {
  const { cmd } = req.body;
  if (!cmd) return res.status(400).json({ error: 'No command' });
  exec(cmd, { timeout: 30000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
    res.json({ stdout: stdout || '', stderr: stderr || '', code: err ? err.code : 0 });
  });
});

// ─── AI Chat via OpenRouter ──────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are a powerful AI assistant embedded in a Termux mobile system monitor dashboard.
You have the ability to help the user manage their Android/Termux device. 
When the user wants to execute a command, respond with a JSON block like this:
{"action":"exec","cmd":"command here","reason":"why"}
When the user wants to screenshot, respond with:
{"action":"exec","cmd":"termux-screenshot -f /storage/emulated/0/Download/screenshot_$(date +%s).png","reason":"screenshot"}
When the user wants to send a file back, respond with:
{"action":"sendfile","path":"/path/to/file","reason":"sending file"}
When the user wants to list files, respond with:
{"action":"listfiles","dir":"/path","reason":"listing files"}
For normal chat, just respond naturally. Be concise, no fluff, no unnecessary emojis.
You are running on an Android device via Termux. You can use termux-api commands.
Always think about what the user actually wants and take action if needed.
Respond in the same language the user uses.`;

app.post('/api/chat', async (req, res) => {
  const { messages, apiKey, model } = req.body;
  if (!apiKey) return res.status(400).json({ error: 'No API key' });

  try {
    const resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'http://localhost:3000',
        'X-Title': 'Termux System Monitor'
      },
      body: JSON.stringify({
        model: model || 'openai/gpt-4o-mini',
        messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...messages],
        max_tokens: 1000,
        temperature: 0.7
      })
    });
    const data = await resp.json();
    if (data.error) return res.status(400).json({ error: data.error.message || JSON.stringify(data.error) });
    const content = data.choices?.[0]?.message?.content || '';
    res.json({ content });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Socket.IO: Live Stats ───────────────────────────────────────────────────
io.on('connection', (socket) => {
  const interval = setInterval(() => {
    try { socket.emit('stats', getStats()); } catch {}
  }, 3000);
  socket.on('disconnect', () => clearInterval(interval));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[SYS-MON] Server running on http://0.0.0.0:${PORT}`);
});
