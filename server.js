const express = require('express');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { DatabaseSync } = require('node:sqlite');

const app = express();
const PORT = process.env.PORT || 3737;
const DEFAULT_BASE_URL = 'https://api.tringpt.com/v1';
// データは各ユーザーのローカルに保存（SQLite: app.db）
// クラウド実行時は DATA_DIR 環境変数で永続ボリュームを指定する
const DATA_DIR = process.env.DATA_DIR || (process.env.APPDATA
  ? path.join(process.env.APPDATA, 'AI Novelist Studio', 'data')
  : path.join(os.homedir(), '.ai-novelist-studio', 'data'));
const DB_FILE = path.join(DATA_DIR, 'app.db');
// レガシーJSON（初回起動時にSQLiteへ自動移行する。移行後も残す）
const LEGACY_FILES = {
  config: path.join(DATA_DIR, 'config.json'),
  conv: path.join(DATA_DIR, 'conversations.json'),
  card: path.join(DATA_DIR, 'cards.json'),
  template: path.join(DATA_DIR, 'templates.json'),
  manuscript: path.join(DATA_DIR, 'manuscript.json'),
  source: path.join(DATA_DIR, 'sources.json')
};
const LEGACY_SNAP_DIR = path.join(DATA_DIR, 'snapshots');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ---------- SQLite ----------
const db = new DatabaseSync(DB_FILE);
db.exec(`CREATE TABLE IF NOT EXISTS docs (
  kind TEXT NOT NULL,
  id TEXT NOT NULL,
  data TEXT NOT NULL,
  updated INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (kind, id)
)`);

const stmtAll = db.prepare('SELECT id, data FROM docs WHERE kind = ?');
const stmtOne = db.prepare('SELECT data FROM docs WHERE kind = ? AND id = ?');
const stmtUpsert = db.prepare(
  'INSERT INTO docs (kind, id, data, updated) VALUES (?, ?, ?, ?) ' +
  'ON CONFLICT (kind, id) DO UPDATE SET data = excluded.data, updated = excluded.updated'
);
const stmtDelete = db.prepare('DELETE FROM docs WHERE kind = ? AND id = ?');

function loadStore(kind) {
  const out = {};
  for (const row of stmtAll.all(kind)) {
    try { out[row.id] = JSON.parse(row.data); } catch {}
  }
  return out;
}
function loadDoc(kind, id, fallback) {
  const row = stmtOne.get(kind, id);
  if (!row) return fallback;
  try { return JSON.parse(row.data); } catch { return fallback; }
}
function docExists(kind, id) {
  return !!stmtOne.get(kind, id);
}

// 書き込みはデバウンス（連続保存でイベントループをブロックしないように）
const pendingWrites = new Map();
const writeTimers = new Map();
function flushWrite(key) {
  const w = pendingWrites.get(key);
  if (!w) return;
  pendingWrites.delete(key);
  clearTimeout(writeTimers.get(key));
  writeTimers.delete(key);
  try { stmtUpsert.run(w.kind, w.id, JSON.stringify(w.data), Date.now()); }
  catch (e) { console.error('保存失敗:', w.kind, w.id, e.message); }
}
function writeDoc(kind, id, data) {
  const key = kind + '/' + id;
  pendingWrites.set(key, { kind, id, data });
  clearTimeout(writeTimers.get(key));
  writeTimers.set(key, setTimeout(() => flushWrite(key), 400));
}
function deleteDoc(kind, id) {
  const key = kind + '/' + id;
  pendingWrites.delete(key);
  clearTimeout(writeTimers.get(key));
  writeTimers.delete(key);
  try { stmtDelete.run(kind, id); }
  catch (e) { console.error('削除失敗:', kind, id, e.message); }
}
process.on('exit', () => {
  for (const key of [...pendingWrites.keys()]) flushWrite(key);
});

// ---------- レガシーJSONからの自動移行 ----------
function migrateStore(kind, file) {
  if (!fs.existsSync(file)) return;
  if (stmtAll.all(kind).length) return; // 既にDBにデータがある
  try {
    const obj = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const [id, v] of Object.entries(obj)) {
      stmtUpsert.run(kind, id, JSON.stringify(v), Date.now());
    }
    console.log(`データ移行完了: ${path.basename(file)} -> sqlite (${kind}: ${Object.keys(obj).length}件)`);
  } catch (e) { console.error('移行失敗:', file, e.message); }
}
function migrateDoc(kind, id, file) {
  if (!fs.existsSync(file)) return;
  if (docExists(kind, id)) return;
  try {
    stmtUpsert.run(kind, id, fs.readFileSync(file, 'utf8'), Date.now());
    console.log(`データ移行完了: ${path.basename(file)} -> sqlite (${kind})`);
  } catch (e) { console.error('移行失敗:', file, e.message); }
}
function migrateSnapshots() {
  if (!fs.existsSync(LEGACY_SNAP_DIR)) return;
  let n = 0;
  for (const f of fs.readdirSync(LEGACY_SNAP_DIR)) {
    if (!f.endsWith('.json')) continue;
    const id = f.slice(0, -5);
    if (docExists('snapshot', id)) continue;
    try {
      stmtUpsert.run('snapshot', id, fs.readFileSync(path.join(LEGACY_SNAP_DIR, f), 'utf8'), Date.now());
      n++;
    } catch {}
  }
  if (n) console.log(`データ移行完了: snapshots -> sqlite (${n}件)`);
}
migrateStore('conv', LEGACY_FILES.conv);
migrateStore('card', LEGACY_FILES.card);
migrateStore('template', LEGACY_FILES.template);
migrateStore('source', LEGACY_FILES.source);
migrateDoc('config', 'main', LEGACY_FILES.config);
migrateDoc('manuscript', 'main', LEGACY_FILES.manuscript);
migrateSnapshots();

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

const savedConfig = loadDoc('config', 'main', {});
let config = {
  ...defaultConfig,
  ...savedConfig,
  params: { ...defaultConfig.params, ...(savedConfig.params || {}) }
};
let conversations = loadStore('conv');
let cards = loadStore('card');
let templates = loadStore('template');
let manuscript = loadDoc('manuscript', 'main', { title: '無題', chapters: [] });
let sources = loadStore('source');
// 実際に 0.0.0.0 で外部公開中か（startListener で更新）
let lanPublic = false;

function getLanUrl() {
  if (config.lanAccess !== true || !lanPublic) return null;
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
    lanPublic,
    accessTokenSet: !!ACCESS_TOKEN,
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
  writeDoc('config', 'main', config);
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
    project: c.project || '',
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
    project: typeof b.project === 'string' ? b.project.slice(0, 100) : '',
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
  writeDoc('conv', id, conversations[id]);
  res.json(conversations[id]);
});

app.get('/api/conversations/:id', (req, res) => {
  const c = conversations[req.params.id];
  if (!c) return res.status(404).json({ error: 'not found' });
  // スナップショットは別ドキュメントから合成して返す（本体オブジェクトは汚さない）
  const snapshots = loadDoc('snapshot', c.id, c.snapshots || []);
  res.json({ ...c, snapshots });
});

app.put('/api/conversations/:id', (req, res) => {
  const c = conversations[req.params.id];
  if (!c) return res.status(404).json({ error: 'not found' });
  const b = req.body || {};
  if (typeof b.title === 'string') c.title = b.title.slice(0, 100);
  if (typeof b.project === 'string') c.project = b.project.slice(0, 100);
  if (Array.isArray(b.messages)) c.messages = b.messages;
  if (b.profile && typeof b.profile === 'object') c.profile = { ...c.profile, ...b.profile };
  if (Array.isArray(b.cardIds)) c.cardIds = b.cardIds;
  if (Array.isArray(b.snapshots)) {
    if (b.snapshots.length || docExists('snapshot', req.params.id)) {
      writeDoc('snapshot', req.params.id, b.snapshots.slice(-100));
    }
    delete c.snapshots; // 本体には埋め込まない
  } else if (c.snapshots) {
    // 旧形式（埋め込み）のスナップショットを別ドキュメントへ移行
    writeDoc('snapshot', req.params.id, c.snapshots.slice(-100));
    delete c.snapshots;
  }
  if (b.totalTokens) c.totalTokens = b.totalTokens;
  c.updated = Date.now();
  writeDoc('conv', req.params.id, c);
  res.json({ ok: true });
});

app.delete('/api/conversations/:id', (req, res) => {
  if (!conversations[req.params.id]) return res.status(404).json({ error: 'not found' });
  delete conversations[req.params.id];
  deleteDoc('conv', req.params.id);
  deleteDoc('snapshot', req.params.id);
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
function cardCRUD(route, kind, store) {
  app.get('/api/' + route, (req, res) => res.json(Object.values(store)));
  app.post('/api/' + route, (req, res) => {
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
    writeDoc(kind, id, store[id]);
    res.json(store[id]);
  });
  app.put('/api/' + route + '/:id', (req, res) => {
    const c = store[req.params.id];
    if (!c) return res.status(404).json({ error: 'not found' });
    const b = req.body || {};
    if (typeof b.name === 'string') c.name = b.name.slice(0, 100);
    if (typeof b.kind === 'string') c.kind = b.kind;
    if (typeof b.content === 'string') c.content = b.content.slice(0, 20000);
    if (typeof b.resolved === 'boolean') c.resolved = b.resolved;
    if (typeof b.triggers === 'string') c.triggers = b.triggers.slice(0, 500);
    if (typeof b.tags === 'string') c.tags = b.tags.slice(0, 500);
    writeDoc(kind, req.params.id, c);
    res.json(c);
  });
  app.delete('/api/' + route + '/:id', (req, res) => {
    if (!store[req.params.id]) return res.status(404).json({ error: 'not found' });
    delete store[req.params.id];
    deleteDoc(kind, req.params.id);
    res.json({ ok: true });
  });
}
cardCRUD('cards', 'card', cards);
cardCRUD('templates', 'template', templates);

// ---------- Manuscript（原稿） ----------
app.get('/api/manuscript', (req, res) => res.json(manuscript));
app.put('/api/manuscript', (req, res) => {
  const b = req.body || {};
  manuscript = {
    title: String(b.title || '無題').slice(0, 200),
    chapters: (Array.isArray(b.chapters) ? b.chapters : []).slice(0, 200).map(ch => ({
      id: String(ch.id || ''),
      title: String(ch.title || '無題').slice(0, 200),
      scenes: (Array.isArray(ch.scenes) ? ch.scenes : []).slice(0, 500).map(sc => ({
        id: String(sc.id || ''),
        title: String(sc.title || '無題').slice(0, 200),
        content: String(sc.content || '').slice(0, 200000)
      }))
    })),
    updated: Date.now()
  };
  writeDoc('manuscript', 'main', manuscript);
  res.json({ ok: true });
});

// ---------- Sources（参照資料・NotebookLM的なQ&A用） ----------
app.get('/api/sources', (req, res) => res.json(Object.values(sources)));
app.get('/api/sources/:id', (req, res) => {
  const s = sources[req.params.id];
  if (!s) return res.status(404).json({ error: 'not found' });
  res.json(s);
});
app.post('/api/sources', (req, res) => {
  const b = req.body || {};
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  sources[id] = {
    id,
    name: String(b.name || '無題').slice(0, 200),
    project: String(b.project || '').slice(0, 100),
    content: String(b.content || '').slice(0, 500000),
    created: Date.now(),
    updated: Date.now()
  };
  writeDoc('source', id, sources[id]);
  res.json(sources[id]);
});
app.put('/api/sources/:id', (req, res) => {
  const s = sources[req.params.id];
  if (!s) return res.status(404).json({ error: 'not found' });
  const b = req.body || {};
  if (typeof b.name === 'string') s.name = b.name.slice(0, 200);
  if (typeof b.project === 'string') s.project = b.project.slice(0, 100);
  if (typeof b.content === 'string') s.content = b.content.slice(0, 500000);
  s.updated = Date.now();
  writeDoc('source', req.params.id, s);
  res.json(s);
});
app.delete('/api/sources/:id', (req, res) => {
  if (!sources[req.params.id]) return res.status(404).json({ error: 'not found' });
  delete sources[req.params.id];
  deleteDoc('source', req.params.id);
  res.json({ ok: true });
});

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
  // 外部公開（LAN公開・HOST=0.0.0.0）にはアクセスキーが必須。
  // ACCESS_TOKEN 未設定で lanAccess がONでも localhost のみに留める
  const wantPublic = !!FORCE_HOST || config.lanAccess === true;
  const host = FORCE_HOST || (wantPublic && ACCESS_TOKEN ? '0.0.0.0' : '127.0.0.1');
  lanPublic = host === '0.0.0.0';
  if (wantPublic && !ACCESS_TOKEN) {
    console.warn('警告: ACCESS_TOKEN が未設定のため外部公開を無効化しました（127.0.0.1 のみで待受）');
  }
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
