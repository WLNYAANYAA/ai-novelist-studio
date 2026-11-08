const express = require('express');
const fs = require('fs');
const path = require('path');
const os = require('os');

const app = express();
const PORT = process.env.PORT || 3737;
const DEFAULT_BASE_URL = 'https://api.tringpt.com/v1';
// データは各ユーザーのローカルに保存（ネットワーク共有上のdata/は使わない）
// クラウド実行時は DATA_DIR 環境変数で永続ボリュームを指定する
const DATA_DIR = process.env.DATA_DIR || (process.env.APPDATA
  ? path.join(process.env.APPDATA, 'AI Novelist Studio', 'data')
  : path.join(os.homedir(), '.ai-novelist-studio', 'data'));
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const CONV_FILE = path.join(DATA_DIR, 'conversations.json');
const CARDS_FILE = path.join(DATA_DIR, 'cards.json');
const TEMPLATES_FILE = path.join(DATA_DIR, 'templates.json');
// スナップショットは会話ごとに別ファイル（conversations.json の肥大化防止）
const SNAP_DIR = path.join(DATA_DIR, 'snapshots');
const snapFile = (id) => path.join(SNAP_DIR, id + '.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(SNAP_DIR)) fs.mkdirSync(SNAP_DIR, { recursive: true });

function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return fallback; }
}
// 書き込みはデバウンス（連続保存でイベントループをブロックしないように）
const pendingWrites = new Map();
const writeTimers = new Map();
function flushWrite(file) {
  const data = pendingWrites.get(file);
  if (data === undefined) return;
  pendingWrites.delete(file);
  clearTimeout(writeTimers.get(file));
  writeTimers.delete(file);
  try { fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8'); }
  catch (e) { console.error('保存失敗:', file, e.message); }
}
function writeJSON(file, data) {
  pendingWrites.set(file, data);
  clearTimeout(writeTimers.get(file));
  writeTimers.set(file, setTimeout(() => flushWrite(file), 400));
}
function cancelWrite(file) {
  pendingWrites.delete(file);
  clearTimeout(writeTimers.get(file));
  writeTimers.delete(file);
}
process.on('exit', () => {
  for (const file of [...pendingWrites.keys()]) flushWrite(file);
});

const defaultConfig = {
  apiKey: '',
  baseUrl: DEFAULT_BASE_URL,
  noAuth: false,
  model: 'spiko_ultra',
  params: { temperature: 0.8, topP: 0.95, maxTokens: 8192, effort: 'medium', ctxBudget: 120000, autoCards: true, autoCompress: true },
  systemPrompt: '',
  worldMemo: '',
  stylePreset: '',
  lanAccess: false
};

const savedConfig = readJSON(CONFIG_FILE, {});
let config = {
  ...defaultConfig,
  ...savedConfig,
  params: { ...defaultConfig.params, ...(savedConfig.params || {}) }
};
let conversations = readJSON(CONV_FILE, {});
let cards = readJSON(CARDS_FILE, {});
let templates = readJSON(TEMPLATES_FILE, {});

function getLanUrl() {
  if (config.lanAccess !== true) return null;
  const ifaces = os.networkInterfaces();
  for (const list of Object.values(ifaces)) {
    for (const i of list || []) {
      if (i.family === 'IPv4' && !i.internal) return `http://${i.address}:${PORT}`;
    }
  }
  return null;
}

app.use(express.json({ limit: '10mb' }));

// ---------- アクセスキー認証（ACCESS_TOKEN環境変数がある時のみ有効） ----------
const ACCESS_TOKEN = process.env.ACCESS_TOKEN || '';
function authOK(req) {
  const cookie = (req.headers.cookie || '').match(/(?:^|;\s*)nc_access=([^;]+)/);
  const k = req.query.key || (cookie && cookie[1]) || '';
  return k === ACCESS_TOKEN;
}
if (ACCESS_TOKEN) {
  const LOGIN_HTML = `<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AI Novelist Studio</title>
<style>body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#12111a;color:#e6e4f0}form{background:#1b1a26;padding:32px;border-radius:14px;display:flex;flex-direction:column;gap:14px;width:300px}h1{font-size:17px;margin:0}input{padding:10px;border-radius:8px;border:1px solid #3a3952;background:#17161f;color:#e6e4f0;font-size:15px}button{padding:10px;border:none;border-radius:8px;background:#6c5ce7;color:#fff;font-size:14px;font-weight:600;cursor:pointer}</style></head>
<body><form method="get" action="/"><h1>AI Novelist Studio</h1><input type="password" name="key" placeholder="アクセスキー" autofocus><button type="submit">入室</button></form></body></html>`;
  app.use((req, res, next) => {
    if (authOK(req)) {
      if (req.query.key) { // 初回アクセス：Cookieに保存してURLからキーを除去
        res.setHeader('Set-Cookie', `nc_access=${ACCESS_TOKEN}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`);
        const u = new URL(req.originalUrl, 'http://x');
        u.searchParams.delete('key');
        return res.redirect(u.pathname + u.search);
      }
      return next();
    }
    if (req.path === '/') return res.type('html').send(LOGIN_HTML);
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'アクセスキーが必要です' });
    return res.status(401).send('アクセスキーが必要です');
  });
}

app.use(express.static(path.join(__dirname, 'public')));

// ---------- Config ----------
app.get('/api/config', (req, res) => {
  res.json({
    hasApiKey: !!config.apiKey,
    apiKeyMasked: config.apiKey ? config.apiKey.slice(0, 4) + '…' + config.apiKey.slice(-4) : '',
    model: config.model,
    baseUrl: config.baseUrl || DEFAULT_BASE_URL,
    noAuth: config.noAuth === true,
    params: config.params,
    systemPrompt: config.systemPrompt,
    worldMemo: config.worldMemo,
    stylePreset: config.stylePreset,
    stream: config.stream !== false,
    sendOnEnter: config.sendOnEnter === true,
    lanAccess: config.lanAccess === true,
    lanUrl: getLanUrl()
  });
});

app.post('/api/config', (req, res) => {
  const b = req.body || {};
  const prevLan = config.lanAccess === true;
  if (typeof b.apiKey === 'string' && b.apiKey.trim()) config.apiKey = b.apiKey.trim();
  if (typeof b.baseUrl === 'string' && /^https?:\/\//i.test(b.baseUrl.trim())) {
    config.baseUrl = b.baseUrl.trim().replace(/\/+$/, '');
  }
  if (typeof b.noAuth === 'boolean') config.noAuth = b.noAuth;
  if (typeof b.model === 'string' && b.model.trim()) config.model = b.model.trim();
  if (b.params && typeof b.params === 'object') config.params = { ...config.params, ...b.params };
  for (const k of ['systemPrompt', 'worldMemo', 'stylePreset']) {
    if (typeof b[k] === 'string') config[k] = b[k];
  }
  if (typeof b.stream === 'boolean') config.stream = b.stream;
  if (typeof b.sendOnEnter === 'boolean') config.sendOnEnter = b.sendOnEnter;
  if (typeof b.lanAccess === 'boolean') config.lanAccess = b.lanAccess;
  writeJSON(CONFIG_FILE, config);
  if ((config.lanAccess === true) !== prevLan) restartListener();
  res.json({ ok: true });
});

// ---------- Conversations ----------
function convSummary(c) {
  return {
    id: c.id,
    title: c.title,
    created: c.created,
    updated: c.updated,
    messageCount: (c.messages || []).length,
    totalTokens: c.totalTokens || { input: 0, output: 0 }
  };
}

app.get('/api/conversations', (req, res) => {
  const list = Object.values(conversations)
    .map(convSummary)
    .sort((a, b) => b.updated - a.updated);
  res.json(list);
});

app.post('/api/conversations', (req, res) => {
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const now = Date.now();
  const b = req.body || {};
  conversations[id] = {
    id,
    title: typeof b.title === 'string' && b.title ? b.title.slice(0, 100) : '新しい会話',
    created: now,
    updated: now,
    messages: Array.isArray(b.messages) ? b.messages : [],
    profile: {
      systemPrompt: config.systemPrompt,
      worldMemo: config.worldMemo,
      stylePreset: config.stylePreset,
      ...(b.profile && typeof b.profile === 'object' ? b.profile : {})
    },
    cardIds: Array.isArray(b.cardIds) ? b.cardIds : [],
    totalTokens: b.totalTokens || { input: 0, output: 0 }
  };
  writeJSON(CONV_FILE, conversations);
  res.json(conversations[id]);
});

app.get('/api/conversations/:id', (req, res) => {
  const c = conversations[req.params.id];
  if (!c) return res.status(404).json({ error: 'not found' });
  // スナップショットは別ファイルから合成して返す（本体オブジェクトは汚さない）
  const snapshots = readJSON(snapFile(c.id), c.snapshots || []);
  res.json({ ...c, snapshots });
});

app.put('/api/conversations/:id', (req, res) => {
  const c = conversations[req.params.id];
  if (!c) return res.status(404).json({ error: 'not found' });
  const b = req.body || {};
  if (typeof b.title === 'string') c.title = b.title.slice(0, 100);
  if (Array.isArray(b.messages)) c.messages = b.messages;
  if (b.profile && typeof b.profile === 'object') c.profile = { ...c.profile, ...b.profile };
  if (Array.isArray(b.cardIds)) c.cardIds = b.cardIds;
  if (Array.isArray(b.snapshots)) {
    const sf = snapFile(req.params.id);
    if (b.snapshots.length || fs.existsSync(sf)) writeJSON(sf, b.snapshots.slice(-100));
    delete c.snapshots; // 本体JSONには埋め込まない
  } else if (c.snapshots) {
    // 旧形式（埋め込み）のスナップショットを分離ファイルへ移行
    writeJSON(snapFile(req.params.id), c.snapshots.slice(-100));
    delete c.snapshots;
  }
  if (b.totalTokens) c.totalTokens = b.totalTokens;
  c.updated = Date.now();
  writeJSON(CONV_FILE, conversations);
  res.json({ ok: true });
});

app.delete('/api/conversations/:id', (req, res) => {
  if (!conversations[req.params.id]) return res.status(404).json({ error: 'not found' });
  delete conversations[req.params.id];
  cancelWrite(snapFile(req.params.id)); // デバウンス中の書き込みをキャンセルしてから削除
  try { fs.rmSync(snapFile(req.params.id), { force: true }); } catch {}
  writeJSON(CONV_FILE, conversations);
  res.json({ ok: true });
});

// ---------- Search ----------
app.get('/api/search', (req, res) => {
  const q = (req.query.q || '').trim().toLowerCase();
  if (!q) return res.json([]);
  const results = [];
  for (const c of Object.values(conversations)) {
    if ((c.title || '').toLowerCase().includes(q)) {
      results.push({ id: c.id, title: c.title, updated: c.updated, matchType: 'title', snippet: c.title });
      continue;
    }
    for (let i = 0; i < (c.messages || []).length; i++) {
      const m = c.messages[i];
      if (m.role === 'user' || m.role === 'assistant') {
        const text = (m.content || '').toLowerCase();
        const idx = text.indexOf(q);
        if (idx >= 0) {
          const raw = m.content;
          const snippet = raw.slice(Math.max(0, idx - 40), idx + q.length + 60).replace(/\n/g, ' ');
          results.push({ id: c.id, title: c.title, updated: c.updated, matchType: m.role, messageIndex: i, snippet });
          break; // 1会話につき最初のヒットのみ
        }
      }
    }
  }
  results.sort((a, b) => b.updated - a.updated);
  res.json(results.slice(0, 50));
});

// ---------- Cards / Templates ----------
function cardCRUD(file, store) {
  app.get('/api/' + file, (req, res) => res.json(Object.values(store)));
  app.post('/api/' + file, (req, res) => {
    const b = req.body || {};
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    store[id] = {
      id,
      name: String(b.name || '無題').slice(0, 100),
      kind: ['character', 'world', 'term', 'foreshadow'].includes(b.kind) ? b.kind : 'world',
      content: String(b.content || '').slice(0, 20000),
      resolved: b.resolved === true,
      triggers: String(b.triggers || '').slice(0, 500),
      tags: String(b.tags || '').slice(0, 500),
      created: Date.now()
    };
    writeJSON(path.join(DATA_DIR, file + '.json'), store);
    res.json(store[id]);
  });
  app.put('/api/' + file + '/:id', (req, res) => {
    const c = store[req.params.id];
    if (!c) return res.status(404).json({ error: 'not found' });
    const b = req.body || {};
    if (typeof b.name === 'string') c.name = b.name.slice(0, 100);
    if (typeof b.kind === 'string') c.kind = b.kind;
    if (typeof b.content === 'string') c.content = b.content.slice(0, 20000);
    if (typeof b.resolved === 'boolean') c.resolved = b.resolved;
    if (typeof b.triggers === 'string') c.triggers = b.triggers.slice(0, 500);
    if (typeof b.tags === 'string') c.tags = b.tags.slice(0, 500);
    writeJSON(path.join(DATA_DIR, file + '.json'), store);
    res.json(c);
  });
  app.delete('/api/' + file + '/:id', (req, res) => {
    if (!store[req.params.id]) return res.status(404).json({ error: 'not found' });
    delete store[req.params.id];
    writeJSON(path.join(DATA_DIR, file + '.json'), store);
    res.json({ ok: true });
  });
}
cardCRUD('cards', cards);
cardCRUD('templates', templates);

// ---------- Chat proxy (SSE対応) ----------
app.post('/api/chat', async (req, res) => {
  const noAuth = config.noAuth === true;
  if (!config.apiKey && !noAuth) {
    return res.status(400).json({ error: 'APIキーが未設定です。設定画面で入力してください。' });
  }
  const body = { ...req.body, model: req.body.model || config.model };
  const base = (config.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');

  const headers = { 'Content-Type': 'application/json' };
  if (config.apiKey) headers['Authorization'] = 'Bearer ' + config.apiKey;

  let upstream;
  try {
    upstream = await fetch(base + '/chat/completions', {
      method: 'POST',
      headers,
      body: JSON.stringify(body)
    });
  } catch (e) {
    return res.status(502).json({ error: 'APIに接続できません: ' + e.message });
  }

  res.status(upstream.status);
  const ct = upstream.headers.get('content-type') || 'application/json';
  res.setHeader('Content-Type', ct);
  if (ct.includes('text/event-stream')) {
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    const reader = upstream.body.getReader();
    req.on('close', () => reader.cancel().catch(() => {}));
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(Buffer.from(value));
      }
    } catch (e) { /* client aborted */ }
    res.end();
  } else {
    const text = await upstream.text();
    res.send(text);
  }
});

// LAN公開ON時は 0.0.0.0 で待受（localhostも含むので片方だけでよい）
// クラウドでは HOST=0.0.0.0 環境変数で全インターフェースに公開。それ以外はLAN公開設定に従う
const FORCE_HOST = process.env.HOST || '';
let server = null;
function startListener() {
  const host = FORCE_HOST || (config.lanAccess === true ? '0.0.0.0' : '127.0.0.1');
  server = app.listen(PORT, host, () => {
    if (host === '0.0.0.0') {
      console.log(`AI Novelist Studio: http://localhost:${PORT}（LAN公開中: ${getLanUrl() || 'IP取得失敗'}）`);
    } else {
      console.log(`AI Novelist Studio 起動: http://localhost:${PORT}（このPCのみ）`);
    }
  });
  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      console.log(`ポート ${PORT} は使用中です（既に起動済みの可能性）`);
    } else {
      console.error(e);
      process.exit(1);
    }
  });
}
function restartListener() {
  if (server) {
    try { server.close(); } catch {}
    server = null;
  }
  // 進行中の接続を切らないよう少し待ってから張り直す
  setTimeout(startListener, 300);
}
startListener();
