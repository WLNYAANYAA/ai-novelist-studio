const express = require('express');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { DatabaseSync } = require('node:sqlite');
// ファイル取り込み用ライブラリ（PDF/DOCXのテキスト抽出）
const { PDFParse } = require('pdf-parse');
const mammoth = require('mammoth');

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
  maybeAutoSnapshot(kind);
}
function deleteDoc(kind, id) {
  const key = kind + '/' + id;
  pendingWrites.delete(key);
  clearTimeout(writeTimers.get(key));
  writeTimers.delete(key);
  try { stmtDelete.run(kind, id); }
  catch (e) { console.error('削除失敗:', kind, id, e.message); }
  maybeAutoSnapshot(kind);
}

// ---------- タイムマシン：全データの時点スナップショット ----------
// kind='tmsnap'（メタ）+ 'tmsnapdata'（全行ダンプ）をdocsテーブルに保存。
// configは対象外（APIキー等の設定は創作データではないため）
const SNAP_MAX = 150;
const AUTO_SNAP_INTERVAL = 30 * 60 * 1000;
let lastAutoSnap = 0;
let lastSnapMaxUpdated = 0;
const SNAP_SKIP_KINDS = new Set(['tmsnap', 'tmsnapdata', 'config']);

function flushAllWrites() {
  for (const key of [...pendingWrites.keys()]) flushWrite(key);
}
function maxDocUpdated() {
  let m = 0;
  const stmt = db.prepare('SELECT MAX(updated) AS u FROM docs WHERE kind = ?');
  for (const kind of ['conv', 'card', 'template', 'source', 'doc', 'manuscript', 'worldgraph', 'projectPreset', 'snapshot']) {
    const r = stmt.get(kind);
    if (r && r.u > m) m = r.u;
  }
  return m;
}
function createSnapshot(label, auto) {
  flushAllWrites();
  const ts = Date.now();
  const id = String(ts);
  const rows = db.prepare(
    "SELECT kind, id, data, updated FROM docs WHERE kind NOT IN ('tmsnap','tmsnapdata','config')"
  ).all();
  const payload = JSON.stringify({ ts, docs: rows });
  const meta = {
    ts, id, auto: !!auto,
    label: String(label || '').slice(0, 100) || (auto ? '自動記録' : '記録'),
    count: rows.length,
    bytes: Buffer.byteLength(payload),
    maxUpdated: rows.reduce((m, r) => Math.max(m, r.updated || 0), 0)
  };
  stmtUpsert.run('tmsnap', id, JSON.stringify(meta), ts);
  stmtUpsert.run('tmsnapdata', id, payload, ts);
  lastSnapMaxUpdated = meta.maxUpdated;
  // 上限超過分を古い順に削除
  const metas = stmtAll.all('tmsnap').map(r => { try { return JSON.parse(r.data); } catch { return null; } })
    .filter(Boolean).sort((a, b) => a.ts - b.ts);
  for (const old of metas.slice(0, Math.max(0, metas.length - SNAP_MAX))) {
    stmtDelete.run('tmsnap', old.id);
    stmtDelete.run('tmsnapdata', old.id);
  }
  return meta;
}
function maybeAutoSnapshot(kind) {
  if (SNAP_SKIP_KINDS.has(kind)) return;
  const now = Date.now();
  if (now - lastAutoSnap < AUTO_SNAP_INTERVAL) return;
  lastAutoSnap = now;
  setImmediate(() => {
    try {
      flushAllWrites(); // デバウンス滞留分を先に確定させてから変更判定する
      // 前回スナップショット以降に実変更がなければ空スナップショットを作らない
      if (maxDocUpdated() <= lastSnapMaxUpdated) return;
      createSnapshot('自動 ' + new Date(now).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' }), true);
    } catch (e) { console.error('自動スナップショット失敗:', e.message); }
  });
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
// AIのべりすと専用：接続先は常に固定（カスタムエンドポイント・認証なしモードは無効）
config.baseUrl = DEFAULT_BASE_URL;
config.noAuth = false;
let conversations = loadStore('conv');
let cards = loadStore('card');
let templates = loadStore('template');
let manuscript = loadDoc('manuscript', 'main', { title: '無題', chapters: [] });
let sources = loadStore('source');
let documents = loadStore('doc');
let projectPresets = loadStore('projectPreset');
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

app.use(express.json({ limit: '25mb' }));

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

// ---------- App info ----------
app.get('/api/version', (req, res) => {
  try {
    const p = require('./package.json');
    res.json({ name: p.productName || p.name, version: p.version || '' });
  } catch { res.json({ name: 'AI Novelist Studio', version: '' }); }
});

// ---------- Readability（jReadability: MeCab+UniDicがあれば実計測、なければ近似） ----------
let jreadAnalyzer = null, jreadChecked = false;

// 同梱のMeCab/UniDic（tools/）を自動検出。開発時は __dirname/tools、
// パッケージ版は process.resourcesPath/tools（extraResources）を見る。
// 環境変数 JREAD_UNIDIC / PATH 上の mecab があればそちらも使える。
function toolsDir() {
  const candidates = [path.join(__dirname, 'tools')];
  if (process.resourcesPath) candidates.push(path.join(process.resourcesPath, 'tools'));
  return candidates.find(d => fs.existsSync(path.join(d, 'mecab-dist', 'bin', 'mecab.exe')) ||
                              fs.existsSync(path.join(d, 'mecab', 'bin', 'mecab.exe'))) || null;
}
const BUNDLED_UNIDIC_CANDIDATES = () => {
  const dirs = [];
  for (const base of [path.join(__dirname, 'tools'), process.resourcesPath && path.join(process.resourcesPath, 'tools')]) {
    if (base) dirs.push(path.join(base, 'unidic-mecab'));
  }
  return dirs;
};
let mecabBinDirCache = null;
function mecabBinDir() {
  if (mecabBinDirCache !== null) return mecabBinDirCache;
  const t = toolsDir();
  if (!t) return (mecabBinDirCache = null);
  for (const sub of ['mecab-dist', 'mecab']) {
    const bin = path.join(t, sub, 'bin');
    const exe = path.join(bin, process.platform === 'win32' ? 'mecab.exe' : 'mecab');
    if (fs.existsSync(exe)) return (mecabBinDirCache = bin);
  }
  return (mecabBinDirCache = null);
}
function ensureMecabOnPath() {
  const bin = mecabBinDir();
  if (bin) {
    const sep = path.delimiter;
    const dirs = (process.env.PATH || '').split(sep);
    if (!dirs.includes(bin)) process.env.PATH = bin + sep + process.env.PATH;
    // mecab.exe は etc/mecabrc を自動検出しないため MECABRC で明示する
    const rc = path.join(bin, '..', 'etc', 'mecabrc');
    if (fs.existsSync(rc) && !process.env.MECABRC) process.env.MECABRC = rc;
  }
}
function resolveUnidic() {
  const env = process.env.JREAD_UNIDIC;
  if (env && fs.existsSync(path.join(env, 'sys.dic'))) return env;
  for (const d of BUNDLED_UNIDIC_CANDIDATES()) {
    if (fs.existsSync(path.join(d, 'sys.dic'))) return d;
  }
  return null;
}
async function getJreadAnalyzer() {
  if (jreadChecked) return jreadAnalyzer;
  jreadChecked = true;
  const dic = resolveUnidic();
  if (!dic) { jreadAnalyzer = false; return null; }
  try {
    ensureMecabOnPath();
    const mod = await import('jreadability');
    jreadAnalyzer = new mod.Analyzer(dic);
    return jreadAnalyzer;
  } catch (e) {
    console.warn('jreadability初期化失敗（mecab/UniDic要確認）:', e.message);
    jreadAnalyzer = false;
    return null;
  }
}

// 形態素解析なしの近似メトリクス（jReadability式スコアの代理計算）
function approxMetrics(text) {
  const sents = String(text).split(/(?<=[。！？!?])/).map(s => s.trim()).filter(Boolean);
  const chars = [...String(text)].length;
  const count = re => (String(text).match(re) || []).length;
  const kanji = count(/[一-龯々〆ヵヶ]/g);
  const hira = count(/[ぁ-ん]/g);
  const kata = count(/[ァ-ヶー]/g);
  const kangoRuns = count(/[一-龯々〆ヵヶ]+/g);
  const wagoRuns = count(/[ぁ-んー]+/g);
  const kataRuns = count(/[ァ-ヶー]+/g);
  const numRuns = count(/[A-Za-z0-9０-９]+/g);
  const tokens = kangoRuns + wagoRuns + kataRuns + numRuns;
  const lens = sents.map(s => [...s].length);
  const avg = lens.length ? lens.reduce((a, b) => a + b, 0) / lens.length : 0;
  const variance = lens.length ? lens.reduce((a, b) => a + (b - avg) * (b - avg), 0) / lens.length : 0;
  const kangoPct = tokens ? 100 * kangoRuns / tokens : 0;
  const wagoPct = tokens ? 100 * wagoRuns / tokens : 0;
  // 動詞・助詞割合は形態素解析なしでは推定不可のため、実測値の半分程度を仮定した近似スコア
  const score = +(11.724 - 0.056 * avg - 0.126 * kangoPct - 0.042 * wagoPct - 0.145 * 15 - 0.044 * 20).toFixed(2);
  return {
    approx: true,
    score,
    metrics: {
      sentences: sents.length,
      chars,
      avgSentenceLen: +avg.toFixed(1),
      sentenceLenStd: +Math.sqrt(variance).toFixed(1),
      kanjiPct: +(100 * kanji / Math.max(chars, 1)).toFixed(1),
      hiraganaPct: +(100 * hira / Math.max(chars, 1)).toFixed(1),
      katakanaPct: +(100 * kata / Math.max(chars, 1)).toFixed(1),
      commaPer100: +(100 * count(/、/g) / Math.max(chars, 1)).toFixed(2),
      periodPer100: +(100 * count(/。/g) / Math.max(chars, 1)).toFixed(2),
      newlinePer100: +(100 * count(/\n/g) / Math.max(chars, 1)).toFixed(2),
      kangoTokenPct: +kangoPct.toFixed(1),
      wagoTokenPct: +wagoPct.toFixed(1)
    }
  };
}

app.post('/api/readability', async (req, res) => {
  const text = String(req.body?.text || '').slice(0, 20000);
  if (!text.trim()) return res.status(400).json({ error: 'textが空です' });
  const analyzer = await getJreadAnalyzer();
  if (analyzer) {
    try {
      const score = await analyzer.analyze(text);
      return res.json({ approx: false, score: +score.toFixed(2), metrics: approxMetrics(text).metrics });
    } catch (e) {
      console.warn('jreadability解析失敗、近似にフォールバック:', e.message);
    }
  }
  res.json(approxMetrics(text));
});

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
  config.baseUrl = DEFAULT_BASE_URL; // のべりすと専用：常に固定
  config.noAuth = false;
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
    cardIds: c.cardIds || [],
    sceneId: c.sceneId || '',
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
    sceneId: typeof b.sceneId === 'string' ? b.sceneId.slice(0, 60) : '',
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
  if (typeof b.sceneId === 'string') c.sceneId = b.sceneId.slice(0, 60);
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
      if (m && (m.role === 'user' || m.role === 'assistant')) {
        const raw = typeof m.content === 'string' ? m.content : '';
        const text = raw.toLowerCase();
        const idx = text.indexOf(q);
        if (idx >= 0) {
          const snippet = raw.slice(Math.max(0, idx - 40), idx + q.length + 60).replace(/\n/g, ' ');
          results.push({ id: c.id, kind: 'conv', title: c.title, updated: c.updated, matchType: m.role, messageIndex: i, snippet });
          break; // 1会話につき最初のヒットのみ
        }
      }
    }
  }
  const decodeEnt = (s) => String(s || '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ');
  const stripHtml = (h) => decodeEnt(String(h || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ');
  const mkSnippet = (raw, idx) => raw.slice(Math.max(0, idx - 40), idx + q.length + 60).replace(/\n/g, ' ');
  // ドキュメント（リッチテキスト）
  for (const d of Object.values(documents)) {
    const titleHit = String(d.title || '').toLowerCase().includes(q);
    const text = stripHtml(d.content || '');
    const idx = text.toLowerCase().indexOf(q);
    if (titleHit || idx >= 0) {
      results.push({
        id: d.id, kind: 'doc', title: d.title || '無題', updated: d.updated,
        matchType: titleHit ? 'title' : 'document',
        snippet: titleHit ? String(d.title || '') : mkSnippet(text, idx)
      });
    }
  }
  // ソース（参照資料）
  for (const s of Object.values(sources)) {
    const nameHit = String(s.name || s.project || '').toLowerCase().includes(q);
    const text = String(s.content || '');
    const idx = text.toLowerCase().indexOf(q);
    if (nameHit || idx >= 0) {
      results.push({
        id: s.id, kind: 'source', title: s.name || '無題', updated: s.updated,
        matchType: nameHit ? 'title' : 'source',
        snippet: nameHit ? String(s.name || '') : mkSnippet(text, idx)
      });
    }
  }
  // 原稿シーン（シーン名・章名も対象）
  for (const ch of (manuscript?.chapters || [])) {
    if (!ch || typeof ch !== 'object') continue;
    for (const sc of (ch.scenes || [])) {
      if (!sc || typeof sc !== 'object') continue;
      const titleHit = String(sc.title || '').toLowerCase().includes(q) || String(ch.title || '').toLowerCase().includes(q);
      const text = String(sc.content || '');
      const idx = text.toLowerCase().indexOf(q);
      if (titleHit || idx >= 0) {
        results.push({
          id: sc.id, kind: 'scene', title: `${ch.title} / ${sc.title}`, updated: manuscript.updated || 0,
          matchType: titleHit ? 'title' : 'manuscript',
          snippet: titleHit ? String(sc.title || '') : mkSnippet(text, idx)
        });
      }
    }
  }
  results.sort((a, b) => (b.updated || 0) - (a.updated || 0));
  res.json(results.slice(0, 80));
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
      kind: ['character', 'world', 'term', 'foreshadow', 'style'].includes(b.kind) ? b.kind : 'world',
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
    if (typeof b.kind === 'string' && ['character', 'world', 'term', 'foreshadow', 'style'].includes(b.kind)) c.kind = b.kind;
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
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const seenCh = new Set(), seenSc = new Set();
  const chapters = (Array.isArray(b.chapters) ? b.chapters : []).slice(0, 200)
    .filter(ch => ch && typeof ch === 'object')
    .map(ch => {
      let cid = String(ch.id || '');
      if (!cid || seenCh.has(cid)) cid = uid();
      seenCh.add(cid);
      const scenes = (Array.isArray(ch.scenes) ? ch.scenes : []).slice(0, 500)
        .filter(sc => sc && typeof sc === 'object')
        .map(sc => {
          let sid = String(sc.id || '');
          if (!sid || seenSc.has(sid)) sid = uid();
          seenSc.add(sid);
          const content = String(sc.content || '');
          // 上限超過時は末尾（最新の追記）を残す
          const trimmed = content.length > 500000 ? content.slice(-500000) : content;
          const aiSnippets = Array.isArray(sc.aiSnippets)
            ? sc.aiSnippets.slice(-50).filter(s => s && typeof s === 'object' && typeof s.text === 'string')
                .map(s => ({ ts: Number(s.ts) || Date.now(), text: String(s.text).slice(0, 100000) }))
            : undefined;
          return {
            id: sid,
            title: String(sc.title || '無題').slice(0, 200),
            content: trimmed,
            ...(aiSnippets && aiSnippets.length ? { aiSnippets } : {})
          };
        });
      return { id: cid, title: String(ch.title || '無題').slice(0, 200), scenes };
    });
  const st = b._stats && typeof b._stats === 'object' ? b._stats : {};
  const days = st.days && typeof st.days === 'object' ? st.days : {};
  const dayMap = {};
  for (const [d, v] of Object.entries(days).slice(-400)) {
    const n = parseInt(v);
    if (/^\d{4}-\d{2}-\d{2}$/.test(d) && Number.isFinite(n) && n >= 0) dayMap[d] = n;
  }
  manuscript = {
    title: String(b.title || '無題').slice(0, 200),
    chapters,
    goal: String(b.goal || '').slice(0, 50),
    _stats: {
      date: String(st.date || ''),
      dayChars: Math.max(0, parseInt(st.dayChars) || 0),
      totalChars: Math.max(0, parseInt(st.totalChars) || 0),
      days: dayMap
    },
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

// ---------- Documents（リッチテキストエディタのドキュメント） ----------
app.get('/api/documents', (req, res) => {
  res.json(Object.values(documents).map(d => ({
    id: d.id, title: d.title, project: d.project || '',
    updated: d.updated, chars: (d.content || '').length
  })).sort((a, b) => b.updated - a.updated));
});
app.get('/api/documents/:id', (req, res) => {
  const d = documents[req.params.id];
  if (!d) return res.status(404).json({ error: 'not found' });
  res.json(d);
});
app.post('/api/documents', (req, res) => {
  const b = req.body || {};
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  documents[id] = {
    id,
    title: String(b.title || '無題').slice(0, 200),
    project: String(b.project || '').slice(0, 100),
    content: String(b.content || '').slice(0, 2000000),
    created: Date.now(),
    updated: Date.now()
  };
  writeDoc('doc', id, documents[id]);
  res.json(documents[id]);
});
app.put('/api/documents/:id', (req, res) => {
  const d = documents[req.params.id];
  if (!d) return res.status(404).json({ error: 'not found' });
  const b = req.body || {};
  if (typeof b.title === 'string') d.title = b.title.slice(0, 200);
  if (typeof b.project === 'string') d.project = b.project.slice(0, 100);
  if (typeof b.content === 'string') d.content = b.content.slice(0, 2000000);
  d.updated = Date.now();
  writeDoc('doc', req.params.id, d);
  res.json(d);
});
app.delete('/api/documents/:id', (req, res) => {
  if (!documents[req.params.id]) return res.status(404).json({ error: 'not found' });
  delete documents[req.params.id];
  deleteDoc('doc', req.params.id);
  res.json({ ok: true });
});

// ---------- World Graph（物語グラフ：ノード配置・手動エッジの永続化） ----------
let worldGraph = loadDoc('worldgraph', 'main', { nodes: {}, edges: [] });
app.get('/api/worldgraph', (req, res) => res.json(worldGraph));
app.put('/api/worldgraph', (req, res) => {
  const b = req.body || {};
  const nodes = {};
  if (b.nodes && typeof b.nodes === 'object') {
    for (const [id, p] of Object.entries(b.nodes).slice(0, 5000)) {
      if (p && typeof p === 'object' && isFinite(+p.x) && isFinite(+p.y)) {
        nodes[String(id).slice(0, 80)] = {
          x: Math.round(+p.x), y: Math.round(+p.y),
          ...(p.pin === true ? { pin: true } : {})
        };
      }
    }
  }
  const EDGE_KINDS = ['related', 'foreshadow', 'causal', 'appears'];
  const seen = new Set();
  const edges = (Array.isArray(b.edges) ? b.edges : []).slice(0, 5000)
    .filter(e => e && typeof e === 'object')
    .map(e => ({
      id: String(e.id || '').slice(0, 80),
      from: String(e.from || '').slice(0, 80),
      to: String(e.to || '').slice(0, 80),
      kind: EDGE_KINDS.includes(e.kind) ? e.kind : 'related',
      label: String(e.label || '').slice(0, 100)
    }))
    .filter(e => {
      if (!e.from || !e.to || e.from === e.to) return false;
      const k = e.from + '>' + e.to + '>' + e.kind;
      if (seen.has(k)) return false;
      seen.add(k); return true;
    });
  worldGraph = { nodes, edges, updated: Date.now() };
  writeDoc('worldgraph', 'main', worldGraph);
  res.json({ ok: true });
});

// ---------- タイムマシン API ----------
app.get('/api/timemachine', (req, res) => {
  const metas = Object.values(loadStore('tmsnap'))
    .filter(m => m && m.ts)
    .sort((a, b) => b.ts - a.ts);
  res.json(metas);
});
app.post('/api/timemachine', (req, res) => {
  const meta = createSnapshot((req.body || {}).label, false);
  res.json(meta);
});
app.get('/api/timemachine/:id', (req, res) => {
  const row = stmtOne.get('tmsnapdata', String(req.params.id));
  if (!row) return res.status(404).json({ error: 'not found' });
  res.type('application/json').send(row.data);
});
app.delete('/api/timemachine/:id', (req, res) => {
  const id = String(req.params.id);
  if (!stmtOne.get('tmsnap', id)) return res.status(404).json({ error: 'not found' });
  stmtDelete.run('tmsnap', id);
  stmtDelete.run('tmsnapdata', id);
  res.json({ ok: true });
});
app.post('/api/timemachine/:id/restore', (req, res) => {
  const id = String(req.params.id);
  const row = stmtOne.get('tmsnapdata', id);
  if (!row) return res.status(404).json({ error: 'not found' });
  let payload;
  try { payload = JSON.parse(row.data); }
  catch { return res.status(500).json({ error: 'スナップショットが破損しています' }); }
  flushAllWrites();
  // DBをスナップショット時点に戻す（tmsnap系・configは保持）
  db.exec("DELETE FROM docs WHERE kind NOT IN ('tmsnap','tmsnapdata','config')");
  const ins = db.prepare('INSERT INTO docs (kind, id, data, updated) VALUES (?, ?, ?, ?)');
  for (const d of payload.docs || []) {
    try { ins.run(d.kind, d.id, d.data, d.updated || Date.now()); } catch {}
  }
  // サーバーのインメモリストアも再構築（これをしないと次の保存で旧データに戻る）
  const byKind = {};
  for (const d of payload.docs || []) {
    (byKind[d.kind] = byKind[d.kind] || []).push(d);
  }
  const toObj = (kind) => {
    const o = {};
    for (const d of byKind[kind] || []) {
      try { o[d.id] = JSON.parse(d.data); } catch {}
    }
    return o;
  };
  conversations = toObj('conv');
  cards = toObj('card');
  templates = toObj('template');
  sources = toObj('source');
  documents = toObj('doc');
  projectPresets = toObj('projectPreset');
  const msRows = byKind['manuscript'] || [];
  const msMain = msRows.find(d => d.id === 'main');
  try { manuscript = msMain ? JSON.parse(msMain.data) : { title: '無題', chapters: [] }; }
  catch { manuscript = { title: '無題', chapters: [] }; }
  const wgRows = byKind['worldgraph'] || [];
  const wgMain = wgRows.find(d => d.id === 'main');
  try { worldGraph = wgMain ? JSON.parse(wgMain.data) : { nodes: {}, edges: [] }; }
  catch { worldGraph = { nodes: {}, edges: [] }; }
  lastSnapMaxUpdated = Math.max(lastSnapMaxUpdated, payload.ts || 0);
  res.json({ ok: true, restored: id });
});

// ---------- ファイル取り込み（PDF/DOCX → テキスト抽出） ----------
app.post('/api/import/text', async (req, res) => {
  const b = req.body || {};
  const ext = String(b.ext || '').toLowerCase().replace(/^\./, '');
  let buf;
  try { buf = Buffer.from(String(b.dataBase64 || ''), 'base64'); }
  catch { return res.status(400).json({ error: 'ファイルデータが不正です' }); }
  if (!buf.length) return res.status(400).json({ error: 'ファイルが空です' });
  try {
    let text = '';
    if (ext === 'pdf') {
      const parser = new PDFParse({ data: new Uint8Array(buf) });
      try {
        const r = await parser.getText();
        text = r.text || '';
      } finally {
        await parser.destroy().catch(() => {});
      }
    } else if (ext === 'docx') {
      const r = await mammoth.extractRawText({ buffer: buf });
      text = r.value || '';
    } else {
      return res.status(400).json({ error: '対応していない形式です（pdf/docxのみ）' });
    }
    res.json({ name: String(b.name || '取込').slice(0, 200), text: text.slice(0, 500000) });
  } catch (e) {
    res.status(500).json({ error: 'テキスト抽出に失敗しました: ' + (e.message || e) });
  }
});

// ---------- Project presets（プロジェクト単位のコンテキスト一括適用） ----------
app.get('/api/project-presets', (req, res) => {
  res.json(Object.values(projectPresets));
});
app.put('/api/project-presets/:project', (req, res) => {
  const project = String(req.params.project || '').slice(0, 100);
  const b = req.body || {};
  const id = 'preset:' + project;
  projectPresets[id] = {
    id,
    project,
    cardIds: Array.isArray(b.cardIds) ? b.cardIds.map(String).slice(0, 200) : [],
    sourceProject: String(b.sourceProject || '').slice(0, 100),
    useSources: b.useSources === true,
    stylePreset: String(b.stylePreset || '').slice(0, 2000),
    autoApply: b.autoApply === true,
    updated: Date.now()
  };
  writeDoc('projectPreset', id, projectPresets[id]);
  res.json(projectPresets[id]);
});
app.delete('/api/project-presets/:project', (req, res) => {
  const id = 'preset:' + String(req.params.project || '');
  if (!projectPresets[id]) return res.status(404).json({ error: 'not found' });
  delete projectPresets[id];
  deleteDoc('projectPreset', id);
  res.json({ ok: true });
});

// ---------- Chat proxy (SSE対応) ----------
app.post('/api/chat', async (req, res) => {
  const noAuth = config.noAuth === true;
  if (!config.apiKey && !noAuth) {
    return res.status(400).json({ error: 'APIキーが未設定です。設定画面で入力してください。' });
  }
  const incoming = req.body && typeof req.body === 'object' ? req.body : {};
  const body = { ...incoming, model: incoming.model || config.model };
  const base = (config.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');

  const headers = { 'Content-Type': 'application/json' };
  if (config.apiKey) headers['Authorization'] = 'Bearer ' + config.apiKey;

  let upstream;
  try {
    upstream = await fetch(base + '/chat/completions', {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(300000)
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
