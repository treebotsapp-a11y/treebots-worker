// TreeBots cloud worker
import mineflayer from 'mineflayer';

const API_BASE = process.env.API_BASE || 'https://tree-bot-core.base44.app';
const NODE_SECRET = process.env.NODE_SECRET;
const NODE_NAME = process.env.NODE_NAME;
const POLL_MS = Number(process.env.POLL_MS || 5000);

if (!NODE_SECRET || !NODE_NAME) {
  console.error('Missing NODE_SECRET and/or NODE_NAME env vars.');
  process.exit(1);
}

const running = new Map();
let lastCpu = { time: process.hrtime(), user: process.cpuUsage() };

async function api(fn, body) {
  const res = await fetch(`${API_BASE}/functions/${fn}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-node-secret': NODE_SECRET },
    body: JSON.stringify(body),
  });
  return res.json();
}

function cpuPercent() {
  const now = process.hrtime(lastCpu.time);
  const cpu = process.cpuUsage(lastCpu.user);
  const elapsedMs = now[0] * 1000 + now[1] / 1e6;
  const cpuMs = cpu.user / 1000;
  lastCpu = { time: process.hrtime(), user: process.cpuUsage() };
  return Math.min(100, Math.round((cpuMs / Math.max(1, elapsedMs)) * 100));
}

function startBot(b) {
  if (running.has(b.id)) return;
  const cfg = b.configuration || {};
  const host = b.server_host;
  const port = b.server_port || 25565;
  const version = b.minecraft_version || undefined;
  const username = cfg.username || `TreeBots_${b.id.slice(-5)}`;

  console.log(`[start] ${b.name} -> ${host}:${port} (${username})`);
  const bot = mineflayer.createBot({ host, port: Number(port), version, username, hideErrors: false });

  bot.once('spawn', async () => {
    console.log(`[online] ${b.name}`);
    running.set(b.id, { bot, startedAt: Date.now(), host, port, version, cfg });
    await api('reportBotStatus', { botId: b.id, status: 'online', clearCommand: true,
      logs: [{ level: 'info', message: `Bot spawned at ${host}:${port}` }] });
    for (const c of cfg.commands || []) {
      try { bot.chat(String(c)); } catch (e) {}
    }
  });

  bot.on('kicked', async (reason) => {
    console.warn(`[kicked] ${b.name}:`, reason);
    await api('reportBotStatus', { botId: b.id, status: 'error', clearCommand: true,
      logs: [{ level: 'warn', message: `Kicked: ${String(reason).slice(0, 200)}` }] });
  });
  bot.on('error', async (err) => {
    console.error(`[error] ${b.name}:`, err.message);
    await api('reportBotStatus', { botId: b.id, status: 'error', clearCommand: true,
      logs: [{ level: 'error', message: `Error: ${err.message.slice(0, 200)}` }] });
  });
  bot.on('end', async () => {
    console.log(`[end] ${b.name}`);
    running.delete(b.id);
    await api('reportBotStatus', { botId: b.id, status: 'offline' });
  });

  running.set(b.id, { bot, startedAt: null, host, port, version, cfg });
}

function stopBot(id) {
  const r = running.get(id);
  if (!r) return;
  try { r.bot.quit('Stopped by TreeBots'); } catch (e) {}
  running.delete(id);
}

async function reconcile() {
  let work;
  try {
    work = await api('pollNodeWork', { nodeName: NODE_NAME });
  } catch (e) {
    console.error('poll failed:', e.message);
    return;
  }
  if (!work || work.error) { if (work?.error) console.error('poll error:', work.error); return; }

  for (const c of work.commands || []) {
    if (c.pending_command === 'stop') {
      stopBot(c.id);
      await api('reportBotStatus', { botId: c.id, status: 'offline', clearCommand: true });
    } else if (c.pending_command === 'restart') {
      stopBot(c.id);
      await new Promise((r) => setTimeout(r, 1500));
      startBot(c);
    } else if (c.pending_command === 'start') {
      startBot(c);
    }
  }

  const desiredIds = new Set((work.running || []).map((b) => b.id));
  for (const b of work.running || []) {
    if (!running.has(b.id)) startBot(b);
  }
  for (const id of [...running.keys()]) {
    if (!desiredIds.has(id)) {
      stopBot(id);
      await api('reportBotStatus', { botId: id, status: 'offline' });
    }
  }

  for (const [id, r] of running) {
    if (!r.startedAt) continue;
    const uptime = (Date.now() - r.startedAt) / 3600000;
    await api('reportBotStatus', {
      botId: id, status: 'online',
      cpu_usage: cpuPercent(), ram_usage: Math.round(process.memoryUsage().rss / 1e6),
      uptime_hours: Number(uptime.toFixed(2)),
    });
  }

  await api('recordNodeHeartbeat', {
    nodeName: NODE_NAME, status: 'online',
    active_bots: running.size, node_type: 'cloud',
  });
}

console.log(`TreeBots worker starting — node "${NODE_NAME}" -> ${API_BASE}`);
reconcile();
setInterval(reconcile, POLL_MS);
