// ---------- World Graph（物語グラフ：作品全体の関連可視化） ----------
// ノード: カード/ドキュメント/原稿シーン/ソース/会話（自動収集）
// エッジ: カード名の本文言及（自動スキャン）・会話のカード/シーン紐付け（自動）・手動の関連付け（サーバー保存）
import { $, convTitleEl } from './dom.js';
import { api, esc, appAlert, appConfirm, appPrompt, fmtDate } from './util.js';
import { allCards, allDocs, allSources } from './state.js';
import { conversations, activateTab, registerTabOpener, showGraphView, openConversation, closeTab } from './conversations.js';
import { listManuscriptScenes } from './manuscript.js';
import { openCardsModal, refreshCards } from './cards.js';

const SVGNS = 'http://www.w3.org/2000/svg';
const NODE_H = 36;
const KIND_LABEL = { character: 'キャラ', world: '世界観', term: '用語', foreshadow: '伏線', style: '文体' };
const EDGE_LABEL = { mention: '言及', uses: '使用', linked: '対象', related: '関連', foreshadow: '伏線', causal: '因果', appears: '登場' };
const COLORS = {
  'card:character': '#8e6fd8', 'card:world': '#3aa17e', 'card:term': '#7d8a99',
  'card:foreshadow': '#d96a5f', 'card:style': '#c9709a',
  doc: '#4a7fd4', scene: '#4da36a', source: '#a97b3f', conv: '#c9a13b'
};
const nodeColor = (n) => COLORS[n.type === 'card' ? 'card:' + n.kind : n.type] || '#888';

let wgData = { nodes: {}, edges: [] };   // サーバー保存分（配置＋手動エッジ）
let nodes = new Map();                    // id -> node
let autoEdges = [];                       // 自動エッジ（言及・使用・対象）
let manualEdges = [];                     // wgData.edges（両端が存在するもの）
let mentionEdges = [];                    // スキャン結果（autoEdgesに含める）
let allEdges = [];
let view = { x: 40, y: 30, k: 1 };
const FILTER_TYPES = [
  ['card:character', 'キャラクター'], ['card:world', '世界観'], ['card:term', '用語'],
  ['card:foreshadow', '伏線'], ['card:style', '文体'],
  ['doc', 'ドキュメント'], ['scene', 'シーン'], ['source', 'ソース'], ['conv', '会話']
];
const filterSet = new Set(FILTER_TYPES.map(([k]) => k)); // 空=全て非表示扱いではなく、セット外を隠す
let unresolvedOnly = false;
let isolatedOnly = false;
let showMentions = true;
let searchQ = '';
let selNodeId = null, selEdgeIdx = -1;
let nodeEls = new Map();                  // id -> {g,rect,t1,t2}
let edgeEls = [];                         // {path,txt,e}
let adjacency = new Map();                // nodeId -> [edgeIdx]
let mmSvg = null, mmView = null, mmMap = null; // ミニマップ
let built = false, scanning = false, scannedOnce = false;
let svg, worldG, edgesG, nodesG;
let drag = null, saveTimer = null;
let uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

const stripHtml = (h) => String(h || '')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ');
const nodeFilterKey = (n) => (n.type === 'card' ? 'card:' + n.kind : n.type);
const TYPE_LABEL = { doc: 'ドキュメント', scene: 'シーン', source: 'ソース', conv: '会話' };
const typeLabel = (n) => (n.type === 'card' ? (KIND_LABEL[n.kind] || n.kind) : (TYPE_LABEL[n.type] || n.type));

// ---------- データ構築 ----------
function addNode(id, type, kind, label, sub, extra = {}) {
  if (nodes.has(id)) return nodes.get(id);
  const n = { id, type, kind: kind || '', label: String(label || '無題'), sub: String(sub || ''), x: 0, y: 0, ...extra };
  const p = wgData.nodes[id];
  if (p) { n.x = p.x; n.y = p.y; n.fixed = true; n.pinned = p.pin === true; }
  nodes.set(id, n);
  return n;
}

function buildStructure() {
  nodes = new Map();
  for (const c of allCards) {
    addNode('card:' + c.id, 'card', c.kind || 'term', c.name,
      KIND_LABEL[c.kind] || c.kind || '',
      { card: c, resolved: c.resolved === true });
  }
  for (const d of allDocs) addNode('doc:' + d.id, 'doc', '', d.title || '無題', d.project || '', { doc: d });
  for (const s of allSources) addNode('src:' + s.id, 'source', '', s.name || '無題', s.project || '', { source: s });
  for (const sc of listManuscriptScenes()) {
    addNode('scene:' + sc.id, 'scene', '', sc.title || '無題', sc.chapter || '', { scene: sc });
  }
  for (const c of conversations) {
    addNode('conv:' + c.id, 'conv', '', c.title || '無題', `${c.messageCount || 0} msgs`, { conv: c });
  }
  // 自動エッジ（言及以外）
  autoEdges = [];
  for (const c of conversations) {
    for (const cid of c.cardIds || []) {
      if (nodes.has('card:' + cid)) autoEdges.push({ from: 'conv:' + c.id, to: 'card:' + cid, kind: 'uses', label: '', auto: true });
    }
    if (c.sceneId && nodes.has('scene:' + c.sceneId)) {
      autoEdges.push({ from: 'conv:' + c.id, to: 'scene:' + c.sceneId, kind: 'linked', label: '', auto: true });
    }
  }
  // 手動エッジ（両端が存在するものだけ）
  manualEdges = (wgData.edges || []).filter(e => nodes.has(e.from) && nodes.has(e.to));
  rebuildEdges();
  // 未配置ノードがあれば配置
  if ([...nodes.values()].some(n => !n.fixed && !n._laid)) layoutMissing();
}

// ---------- レイアウト ----------
function layoutMissing() {
  const free = [...nodes.values()].filter(n => !n.fixed && !n._laid);
  if (!free.length) return;
  const cx = 0, cy = 0;
  free.forEach((n, i) => {
    const a = (i / free.length) * Math.PI * 2;
    const r = 120 + Math.sqrt(i) * 60;
    n.x = cx + Math.cos(a) * r + (Math.random() - 0.5) * 80;
    n.y = cy + Math.sin(a) * r + (Math.random() - 0.5) * 80;
    n._laid = true;
  });
  simulate(free, [...nodes.values()].filter(n => n.fixed));
  markDirty();
}

function simulate(movers, fixedNodes = []) {
  const all = [...movers, ...fixedNodes];
  const n = all.length;
  if (n < 2) return;
  const K = n > 350 ? 60 : 140;
  for (let it = 0; it < K; it++) {
    const disp = new Map(movers.map(m => [m.id, { x: 0, y: 0 }]));
    // 斥力（全ペア・近距離のみ効くよう減衰）
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const a = all[i], b = all[j];
        let dx = a.x - b.x, dy = a.y - b.y;
        let d2 = dx * dx + dy * dy;
        if (d2 > 360000) continue; // 600px以上は無視
        if (d2 < 100) { d2 = 100; dx = dx || (Math.random() - 0.5); dy = dy || (Math.random() - 0.5); }
        const f = 2600 / d2;
        const fx = (dx / Math.sqrt(d2)) * f, fy = (dy / Math.sqrt(d2)) * f;
        if (disp.has(a.id)) { disp.get(a.id).x += fx; disp.get(a.id).y += fy; }
        if (disp.has(b.id)) { disp.get(b.id).x -= fx; disp.get(b.id).y -= fy; }
      }
    }
    // 弾性（エッジ）: movers同士＋mover-fixed 間
    for (const e of allEdges) {
      const a = nodes.get(e.from), b = nodes.get(e.to);
      if (!a || !b) continue;
      const am = disp.has(a.id), bm = disp.has(b.id);
      if (!am && !bm) continue;
      const dx = b.x - a.x, dy = b.y - a.y;
      const d = Math.hypot(dx, dy) || 1;
      const rest = e.kind === 'mention' ? 110 : 150;
      const f = (d - rest) * (e.kind === 'mention' ? 0.004 : 0.012);
      const fx = (dx / d) * f, fy = (dy / d) * f;
      if (am) { disp.get(a.id).x += fx; disp.get(a.id).y += fy; }
      if (bm) { disp.get(b.id).x -= fx; disp.get(b.id).y -= fy; }
    }
    // 中心への重力
    for (const [id, d] of disp) {
      d.x -= nodes.get(id).x * 0.002; d.y -= nodes.get(id).y * 0.002;
    }
    for (const m of movers) {
      const d = disp.get(m.id);
      const step = Math.min(30, Math.hypot(d.x, d.y) * 0.08 + 1);
      const l = Math.hypot(d.x, d.y) || 1;
      m.x += (d.x / l) * step; m.y += (d.y / l) * step;
      m._laid = true;
    }
  }
}

function forceLayout() {
  for (const n of nodes.values()) { n._laid = false; n.fixed = n.pinned === true; }
  layoutMissing();
  persistPositions();
  render();
}

// ---------- 言及スキャン ----------
async function scanMentions() {
  if (scanning) return;
  scanning = true;
  setStats('言及をスキャン中…');
  const texts = [];
  for (const sc of listManuscriptScenes()) {
    if (sc.content) texts.push({ nodeId: 'scene:' + sc.id, text: sc.content });
  }
  for (const s of allSources) {
    if (s.content) texts.push({ nodeId: 'src:' + s.id, text: s.content });
  }
  for (const d of allDocs.slice(0, 60)) {
    try {
      const full = await api('/api/documents/' + d.id);
      texts.push({ nodeId: 'doc:' + full.id, text: stripHtml(full.content) });
    } catch {}
  }
  // カード本文も対象（カード→カードの言及が見える。自己言及は除外）
  for (const c of allCards) {
    const t = [c.name, c.content].filter(Boolean).join('\n');
    if (t.trim()) texts.push({ nodeId: 'card:' + c.id, text: t });
  }
  const names = allCards
    .map(c => ({ id: 'card:' + c.id, name: (c.name || '').trim() }))
    .filter(c => c.name.length >= 2);
  const found = [];
  for (const t of texts) {
    const txt = String(t.text).slice(0, 150000).toLowerCase();
    if (!txt) continue;
    const hits = [];
    for (const c of names) {
      const nm = c.name.toLowerCase();
      let cnt = 0, idx = 0;
      while ((idx = txt.indexOf(nm, idx)) >= 0) { cnt++; idx += nm.length; if (cnt > 999) break; }
      if (cnt && c.id !== t.nodeId) hits.push({ to: c.id, count: cnt });
    }
    hits.sort((a, b) => b.count - a.count);
    for (const h of hits.slice(0, 15)) {
      found.push({ from: t.nodeId, to: h.to, kind: 'mention', label: h.count + '箇所', auto: true });
    }
  }
  mentionEdges = found;
  scanning = false;
  scannedOnce = true;
  rebuildEdges();
  render();
  setStats(`言及エッジ ${found.length}本を検出`);
}

function rebuildEdges() {
  allEdges = [...autoEdges, ...mentionEdges, ...manualEdges]
    .filter(e => nodes.has(e.from) && nodes.has(e.to));
  adjacency = new Map();
  allEdges.forEach((e, i) => {
    if (!adjacency.has(e.from)) adjacency.set(e.from, []);
    if (!adjacency.has(e.to)) adjacency.set(e.to, []);
    adjacency.get(e.from).push(i); adjacency.get(e.to).push(i);
  });
}

// ---------- 永続化 ----------
function markDirty() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveGraph, 800);
}
async function saveGraph() {
  const pos = {};
  for (const n of nodes.values()) pos[n.id] = { x: Math.round(n.x), y: Math.round(n.y), ...(n.pinned ? { pin: true } : {}) };
  wgData.nodes = pos;
  wgData.edges = manualEdges.map(e => ({ id: e.id, from: e.from, to: e.to, kind: e.kind, label: e.label || '' }));
  try { await api('/api/worldgraph', { method: 'PUT', body: JSON.stringify(wgData) }); }
  catch (e) { setStats('保存失敗: ' + e.message); }
}
function persistPositions() { markDirty(); }

// ---------- 表示判定 ----------
function visibleSet() {
  // 戻り値: Map id->mode ('show'|'dim'|'hide')
  const m = new Map();
  if (unresolvedOnly) {
    const incident = new Set();
    for (const n of nodes.values()) {
      if (n.type === 'card' && n.kind === 'foreshadow' && !n.resolved) {
        for (const i of adjacency.get(n.id) || []) {
          const e = allEdges[i];
          incident.add(e.from === n.id ? e.to : e.from);
        }
        m.set(n.id, 'show');
      }
    }
    for (const id of incident) {
      if (nodes.has(id)) m.set(id, 'show');
    }
    return m; // unresolvedOnly時はこれだけ表示
  }
  const q = searchQ.trim().toLowerCase();
  for (const n of nodes.values()) {
    if (!filterSet.has(nodeFilterKey(n))) { m.set(n.id, 'hide'); continue; }
    const deg = (adjacency.get(n.id) || []).filter(i => showMentions || allEdges[i].kind !== 'mention').length;
    if (isolatedOnly && !deg) { m.set(n.id, 'hide'); continue; }
    if (q && !(n.label.toLowerCase().includes(q) || n.sub.toLowerCase().includes(q))) { m.set(n.id, 'dim'); continue; }
    m.set(n.id, 'show');
  }
  // ノード選択中は隣接ノード以外をディム（フォーカス表示）
  if (selNodeId && m.get(selNodeId) === 'show') {
    const keep = new Set([selNodeId]);
    for (const i of adjacency.get(selNodeId) || []) {
      const e = allEdges[i];
      keep.add(e.from === selNodeId ? e.to : e.from);
    }
    for (const [id, mode] of m) {
      if (mode === 'show' && !keep.has(id)) m.set(id, 'dim');
    }
  }
  return m;
}

// ---------- レンダリング ----------
function nodeSize(n) {
  const w = Math.min(200, Math.max(64, Math.max([...n.label].length * 12, [...n.sub].length * 9.5) + 20));
  return { w, h: NODE_H };
}
function edgeGeom(e) {
  const a = nodes.get(e.from), b = nodes.get(e.to);
  if (!a || !b) return null;
  const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const off = e._off || 0;
  const cx = mx + (-dy / len) * off, cy = my + (dx / len) * off;
  return { a, b, c: { x: cx, y: cy }, mx, my, len };
}
function edgePoint(g, t) {
  const u = 1 - t;
  return {
    x: u * u * g.a.x + 2 * u * t * g.c.x + t * t * g.b.x,
    y: u * u * g.a.y + 2 * u * t * g.c.y + t * t * g.b.y
  };
}

function render() {
  if (!svg) return;
  // 同一ペアのエッジにオフセットを割当
  const pairCount = new Map();
  allEdges.forEach(e => {
    const k = [e.from, e.to].sort().join('|');
    e._pi = pairCount.get(k) || 0; pairCount.set(k, (pairCount.get(k) || 0) + 1);
    e._off = 0;
  });
  const pairSeen = new Map();
  for (const e of allEdges) {
    const k = [e.from, e.to].sort().join('|');
    const total = pairCount.get(k);
    const idx = pairSeen.get(k) || 0; pairSeen.set(k, idx + 1);
    e._off = (idx - (total - 1) / 2) * 26;
  }
  const vis = visibleSet();
  // エッジ
  edgesG.textContent = '';
  edgeEls = [];
  allEdges.forEach((e, i) => {
    if (e.kind === 'mention' && !showMentions) return;
    const g = edgeGeom(e);
    if (!g) return;
    const va = vis.get(e.from), vb = vis.get(e.to);
    if (va === 'hide' || vb === 'hide') return;
    const p = document.createElementNS(SVGNS, 'path');
    p.setAttribute('d', `M ${g.a.x} ${g.a.y} Q ${g.c.x} ${g.c.y} ${g.b.x} ${g.b.y}`);
    const isMention = e.kind === 'mention';
    p.setAttribute('class', 'gedge' + (isMention ? ' mention' : e.auto ? '' : ' manual') + (selEdgeIdx === i ? ' sel' : ''));
    p.dataset.idx = i;
    const tt = document.createElementNS(SVGNS, 'title');
    tt.textContent = `${EDGE_LABEL[e.kind] || e.kind}${e.label ? ' ' + e.label : ''}：${nodes.get(e.from)?.label || ''} → ${nodes.get(e.to)?.label || ''}`;
    p.appendChild(tt);
    edgesG.appendChild(p);
    let txt = null;
    if (e.label || !isMention) {
      const lp = edgePoint(g, 0.5);
      txt = document.createElementNS(SVGNS, 'text');
      txt.setAttribute('x', lp.x); txt.setAttribute('y', lp.y - 3);
      txt.setAttribute('class', 'gedge-label' + (isMention ? ' mention' : ''));
      txt.setAttribute('text-anchor', 'middle');
      txt.textContent = e.label || EDGE_LABEL[e.kind] || e.kind;
      edgesG.appendChild(txt);
    }
    edgeEls.push({ path: p, txt, e, i });
  });
  adjacency = new Map();
  allEdges.forEach((e, i) => {
    if (!adjacency.has(e.from)) adjacency.set(e.from, []);
    if (!adjacency.has(e.to)) adjacency.set(e.to, []);
    adjacency.get(e.from).push(i); adjacency.get(e.to).push(i);
  });
  // ノード
  nodesG.textContent = '';
  nodeEls = new Map();
  let shown = 0, hidden = 0;
  for (const n of nodes.values()) {
    const mode = vis.get(n.id) || 'hide';
    if (mode === 'hide') { hidden++; continue; }
    shown++;
    const { w, h } = nodeSize(n);
    const g = document.createElementNS(SVGNS, 'g');
    g.setAttribute('class', 'gnode' + (selNodeId === n.id ? ' sel' : '') + (mode === 'dim' ? ' dim' : ''));
    g.setAttribute('transform', `translate(${n.x} ${n.y})`);
    g.dataset.id = n.id;
    const nt = document.createElementNS(SVGNS, 'title');
    nt.textContent = `${typeLabel(n)}：${n.label}${n.sub ? '（' + n.sub + '）' : ''}`;
    g.appendChild(nt);
    const color = nodeColor(n);
    const rect = document.createElementNS(SVGNS, 'rect');
    rect.setAttribute('x', -w / 2); rect.setAttribute('y', -h / 2);
    rect.setAttribute('width', w); rect.setAttribute('height', h);
    rect.setAttribute('rx', 9);
    rect.setAttribute('class', 'gnode-rect');
    rect.style.fill = color + '1f';
    rect.style.stroke = color;
    if (n.type === 'card' && n.kind === 'foreshadow' && !n.resolved) rect.style.strokeWidth = '2.5';
    const t1 = document.createElementNS(SVGNS, 'text');
    t1.setAttribute('x', 0); t1.setAttribute('y', -3);
    t1.setAttribute('class', 'gnode-label'); t1.setAttribute('text-anchor', 'middle');
    t1.textContent = n.label.length > 16 ? n.label.slice(0, 15) + '…' : n.label;
    const t2 = document.createElementNS(SVGNS, 'text');
    t2.setAttribute('x', 0); t2.setAttribute('y', 13);
    t2.setAttribute('class', 'gnode-sub'); t2.setAttribute('text-anchor', 'middle');
    t2.textContent = n.sub.length > 22 ? n.sub.slice(0, 21) + '…' : n.sub;
    g.appendChild(rect); g.appendChild(t1); g.appendChild(t2);
    nodesG.appendChild(g);
    nodeEls.set(n.id, { g, rect, t1, t2 });
  }
  $('graphEmpty')?.classList.toggle('hidden', nodes.size > 0);
  renderMinimap(vis);
  setStats(`${shown}ノード / ${edgeEls.length}エッジ`);
  renderSide();
}

// ---------- ミニマップ ----------
const MM_W = 180, MM_H = 130, MM_PAD = 10;
function renderMinimap(vis) {
  const wrap = $('graphMinimap');
  if (!wrap || !mmSvg) return;
  wrap.classList.toggle('hidden', nodes.size < 3);
  if (nodes.size < 3) return;
  let minx = 1e9, miny = 1e9, maxx = -1e9, maxy = -1e9;
  for (const n of nodes.values()) {
    minx = Math.min(minx, n.x); maxx = Math.max(maxx, n.x);
    miny = Math.min(miny, n.y); maxy = Math.max(maxy, n.y);
  }
  const bw = Math.max(1, maxx - minx), bh = Math.max(1, maxy - miny);
  const s = Math.min((MM_W - MM_PAD * 2) / bw, (MM_H - MM_PAD * 2) / bh);
  const ox = MM_PAD + ((MM_W - MM_PAD * 2) - bw * s) / 2 - minx * s;
  const oy = MM_PAD + ((MM_H - MM_PAD * 2) - bh * s) / 2 - miny * s;
  mmMap = { s, ox, oy };
  mmSvg.textContent = '';
  for (const n of nodes.values()) {
    const mode = vis.get(n.id);
    if (!mode || mode === 'hide') continue;
    const c = document.createElementNS(SVGNS, 'circle');
    c.setAttribute('cx', n.x * s + ox); c.setAttribute('cy', n.y * s + oy);
    c.setAttribute('r', mode === 'dim' ? 1.6 : 2.6);
    c.setAttribute('fill', nodeColor(n));
    c.setAttribute('opacity', mode === 'dim' ? 0.25 : 0.9);
    mmSvg.appendChild(c);
  }
  mmView = document.createElementNS(SVGNS, 'rect');
  mmView.setAttribute('class', 'mm-view');
  mmSvg.appendChild(mmView);
  updateMmView();
}
function mmToWorld(mx, my) {
  if (!mmMap) return null;
  return { x: (mx - mmMap.ox) / mmMap.s, y: (my - mmMap.oy) / mmMap.s };
}
function updateMmView() {
  if (!mmView || !mmMap) return;
  const wrap = $('graphCanvasWrap');
  if (!wrap) return;
  const w = wrap.clientWidth, h = wrap.clientHeight;
  const x0 = (0 - view.x) / view.k, y0 = (0 - view.y) / view.k;
  const x1 = (w - view.x) / view.k, y1 = (h - view.y) / view.k;
  mmView.setAttribute('x', x0 * mmMap.s + mmMap.ox);
  mmView.setAttribute('y', y0 * mmMap.s + mmMap.oy);
  mmView.setAttribute('width', Math.max(2, (x1 - x0) * mmMap.s));
  mmView.setAttribute('height', Math.max(2, (y1 - y0) * mmMap.s));
}
function centerWorld(wx, wy) {
  const wrap = $('graphCanvasWrap');
  if (!wrap) return;
  view.x = wrap.clientWidth / 2 - wx * view.k;
  view.y = wrap.clientHeight / 2 - wy * view.k;
  applyView();
}
function bindMinimap() {
  if (!mmSvg) return;
  const jump = (e) => {
    const r = mmSvg.getBoundingClientRect();
    const w = mmToWorld(e.clientX - r.left, e.clientY - r.top);
    if (w) centerWorld(w.x, w.y);
  };
  let down = false;
  mmSvg.addEventListener('pointerdown', (e) => { down = true; jump(e); try { mmSvg.setPointerCapture(e.pointerId); } catch {} });
  mmSvg.addEventListener('pointermove', (e) => { if (down) jump(e); });
  mmSvg.addEventListener('pointerup', () => { down = false; });
}

function setStats(extra) {
  const el = $('graphStats');
  if (!el) return;
  const unresolved = [...nodes.values()].filter(n => n.type === 'card' && n.kind === 'foreshadow' && !n.resolved).length;
  el.textContent = (extra ? extra + ' · ' : '') + `未回収伏線 ${unresolved}件`;
  el.style.color = unresolved ? 'var(--danger, #d96a5f)' : '';
}

// ---------- ビュー操作 ----------
function applyView() {
  worldG.setAttribute('transform', `translate(${view.x} ${view.y}) scale(${view.k})`);
  svg?.classList.toggle('zoom-out', view.k < 0.55);
  updateMmView();
}
function fitView() {
  const vis = visibleSet();
  let minx = 1e9, miny = 1e9, maxx = -1e9, maxy = -1e9, cnt = 0;
  for (const n of nodes.values()) {
    const m = vis.get(n.id);
    if (!m || m === 'hide') continue;
    const { w, h } = nodeSize(n);
    minx = Math.min(minx, n.x - w / 2); maxx = Math.max(maxx, n.x + w / 2);
    miny = Math.min(miny, n.y - h / 2); maxy = Math.max(maxy, n.y + h / 2);
    cnt++;
  }
  if (!cnt) return;
  const wrap = $('graphCanvasWrap');
  if (!wrap) return;
  const pad = 70;
  const bw = maxx - minx + pad * 2, bh = maxy - miny + pad * 2;
  view.k = Math.min(1.4, Math.max(0.12, Math.min(wrap.clientWidth / bw, wrap.clientHeight / bh)));
  view.x = wrap.clientWidth / 2 - (minx + maxx) / 2 * view.k;
  view.y = wrap.clientHeight / 2 - (miny + maxy) / 2 * view.k;
  applyView();
}
function svgPoint(e) {
  const r = svg.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}
function toWorld(sx, sy) { return { x: (sx - view.x) / view.k, y: (sy - view.y) / view.k }; }

function bindCanvas() {
  svg.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const p = svgPoint(e);
    const g = e.target.closest ? e.target.closest('.gnode') : null;
    const edge = e.target.closest ? e.target.closest('.gedge') : null;
    if (g) {
      const n = nodes.get(g.dataset.id);
      drag = { mode: 'node', id: n.id, node: n, sx: p.x, sy: p.y, ox: n.x, oy: n.y, moved: false, target: g };
    } else {
      drag = { mode: 'pan', sx: p.x, sy: p.y, vx: view.x, vy: view.y, moved: false, target: edge };
    }
    try { svg.setPointerCapture(e.pointerId); } catch {}
  });
  svg.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const p = svgPoint(e);
    const dx = p.x - drag.sx, dy = p.y - drag.sy;
    if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
    if (drag.mode === 'pan') {
      view.x = drag.vx + dx; view.y = drag.vy + dy;
      applyView();
    } else {
      const w = toWorld(drag.sx + dx, drag.sy + dy);
      // 開始時のワールド座標との差分で移動
      const w0 = toWorld(drag.sx, drag.sy);
      drag.node.x = drag.ox + (w.x - w0.x);
      drag.node.y = drag.oy + (w.y - w0.y);
      const el = nodeEls.get(drag.id);
      if (el) {
        el.g.setAttribute('transform', `translate(${drag.node.x} ${drag.node.y})`);
        for (const i of adjacency.get(drag.id) || []) {
          const ee = edgeEls.find(x => x.i === i);
          if (ee) {
            const g = edgeGeom(ee.e);
            if (g) {
              ee.path.setAttribute('d', `M ${g.a.x} ${g.a.y} Q ${g.c.x} ${g.c.y} ${g.b.x} ${g.b.y}`);
              if (ee.txt) {
                const lp = edgePoint(g, 0.5);
                ee.txt.setAttribute('x', lp.x); ee.txt.setAttribute('y', lp.y - 3);
              }
            }
          }
        }
      }
    }
  });
  svg.addEventListener('pointerup', (e) => {
    if (!drag) return;
    const d = drag; drag = null;
    if (d.mode === 'node') {
      if (!d.moved) { selectNode(d.id); return; }
      markDirty();
      persistPositions();
    } else if (!d.moved) {
      if (d.target && d.target.classList && d.target.classList.contains('gedge')) {
        selectEdge(parseInt(d.target.dataset.idx, 10));
      } else {
        selectNode(null); selectEdge(-1);
      }
    }
  });
  svg.addEventListener('wheel', (e) => {
    e.preventDefault();
    const p = svgPoint(e);
    const k2 = Math.min(2.5, Math.max(0.15, view.k * Math.exp(-e.deltaY * 0.0012)));
    const w = toWorld(p.x, p.y);
    view.x = p.x - w.x * k2; view.y = p.y - w.y * k2; view.k = k2;
    applyView();
  }, { passive: false });
  svg.addEventListener('dblclick', (e) => {
    if (e.target.closest && e.target.closest('.gnode')) return;
    fitView();
  });
}

// ---------- サイドパネル ----------
function renderSide() {
  const el = $('graphSide');
  if (!el) return;
  if (selNodeId && nodes.has(selNodeId)) { el.classList.remove('hidden'); renderNodePanel(nodes.get(selNodeId)); return; }
  if (selEdgeIdx >= 0 && allEdges[selEdgeIdx]) { el.classList.remove('hidden'); renderEdgePanel(allEdges[selEdgeIdx], selEdgeIdx); return; }
  el.classList.add('hidden');
}
function otherNode(id) { return nodes.get(id); }
function nodeLink(id) {
  const n = nodes.get(id);
  return n ? esc(n.label) : '(削除済み)';
}

function nodeActions(n) {
  const btns = [`<button class="btn-ghost btn-sm" data-act="pin">${n.pinned ? '📌 固定中' : '📌 固定'}</button>`];
  if (n.type === 'doc') btns.push(`<button class="btn-ghost btn-sm" data-act="open">ドキュメントを開く</button>`);
  if (n.type === 'scene') btns.push(`<button class="btn-ghost btn-sm" data-act="open">シーンを開く</button>`);
  if (n.type === 'conv') btns.push(`<button class="btn-ghost btn-sm" data-act="open">会話を開く</button>`);
  if (n.type === 'source') btns.push(`<button class="btn-ghost btn-sm" data-act="open">ソース管理を開く</button>`);
  if (n.type === 'scene') {
    btns.push(`<button class="btn-ghost btn-sm" data-act="prevsc">← 前のシーン</button>`);
    btns.push(`<button class="btn-ghost btn-sm" data-act="nextsc">次のシーン →</button>`);
  }
  if (n.type === 'card') {
    btns.push(`<button class="btn-ghost btn-sm" data-act="edit">カードを編集</button>`);
    if (n.kind === 'foreshadow') {
      btns.push(`<button class="btn-ghost btn-sm" data-act="fw">${n.resolved ? '未回収に戻す' : '回収済にする'}</button>`);
    }
  }
  return btns.join('');
}

function relationRows(n) {
  const rows = [];
  const seen = new Set();
  for (const i of adjacency.get(n.id) || []) {
    const e = allEdges[i];
    const otherId = e.from === n.id ? e.to : e.from;
    const dir = e.from === n.id ? '→' : '←';
    const key = i;
    if (seen.has(key)) continue; seen.add(key);
    rows.push({ e, i, otherId, dir });
  }
  rows.sort((a, b) => (a.e.auto ? 1 : 0) - (b.e.auto ? 1 : 0));
  if (!rows.length) return '<p class="hint">関連はまだありません</p>';
  return rows.map(r => {
    const manual = !r.e.auto;
    return `<div class="graph-rel">
      <span class="graph-rel-kind">${esc(EDGE_LABEL[r.e.kind] || r.e.kind)}</span>
      <span class="graph-rel-dir">${r.dir}</span>
      <span class="graph-rel-to" data-goto="${esc(r.otherId)}">${nodeLink(r.otherId)}</span>
      ${r.e.label ? `<span class="hint">${esc(r.e.label)}</span>` : ''}
      ${manual ? `<button class="graph-rel-del" data-del-edge="${r.i}" title="この関連を削除">×</button>` : ''}
    </div>`;
  }).join('');
}

function renderNodePanel(n) {
  const el = $('graphSide');
  const color = nodeColor(n);
  let meta = '';
  if (n.type === 'card') {
    meta = `<div class="graph-card-preview">${esc((n.card?.content || '').slice(0, 500)) || '（内容なし）'}</div>`;
    if (n.card?.triggers) meta += `<p class="hint">⚑ ${esc(n.card.triggers)}</p>`;
    if (n.card?.tags) meta += `<p class="hint"># ${esc(n.card.tags)}</p>`;
  } else if (n.type === 'doc') {
    meta = `<p class="hint">${esc(n.doc?.project || 'プロジェクトなし')} · ${(n.doc?.chars || 0).toLocaleString()}字 · 更新 ${fmtDate(n.doc?.updated || 0)}</p>`;
  } else if (n.type === 'scene') {
    meta = `<p class="hint">${esc(n.scene?.chapter || '')} · ${(n.scene?.content || '').length.toLocaleString()}字</p>`;
    if (n.scene?.content) meta += `<div class="graph-card-preview">${esc(n.scene.content.slice(0, 300))}…</div>`;
  } else if (n.type === 'source') {
    meta = `<p class="hint">${esc(n.source?.project || 'プロジェクトなし')} · ${(n.source?.content || '').length.toLocaleString()}字</p>`;
  } else if (n.type === 'conv') {
    meta = `<p class="hint">${n.conv?.messageCount || 0} msgs · 更新 ${fmtDate(n.conv?.updated || 0)}</p>`;
  }
  const targetOpts = [...nodes.values()]
    .filter(x => x.id !== n.id)
    .sort((a, b) => a.type.localeCompare(b.type) || a.label.localeCompare(b.label))
    .map(x => `<option value="${esc(x.id)}">[${esc(typeLabel(x))}] ${esc(x.label)}</option>`).join('');
  el.innerHTML = `
    <div class="graph-side-head">
      <span class="graph-dot" style="background:${color}"></span>
      <strong class="graph-side-title">${esc(n.label)}</strong>
      <button class="modal-close" id="graphSideClose"><svg class="icon"><use href="#i-close"/></svg></button>
    </div>
    <div class="graph-side-sub hint">${esc(n.sub || nodeFilterKey(n))}${n.type === 'card' && n.kind === 'foreshadow' ? (n.resolved ? ' · 回収済' : ' · <b style="color:var(--danger,#d96a5f)">未回収</b>') : ''}</div>
    <div class="graph-side-actions">${nodeActions(n)}</div>
    ${meta}
    <h4 class="graph-side-h">関連（${(adjacency.get(n.id) || []).length}）</h4>
    <div class="graph-rel-list">${relationRows(n)}</div>
    <h4 class="graph-side-h">関連付けを追加</h4>
    <div class="graph-add-rel">
      <select id="graphRelTarget"><option value="">（相手を選択）</option>${targetOpts}</select>
      <select id="graphRelKind">
        <option value="related">関連</option>
        <option value="appears">登場</option>
        <option value="foreshadow">伏線</option>
        <option value="causal">因果</option>
      </select>
      <button class="btn-ghost btn-sm" id="graphRelAdd">追加</button>
    </div>`;
  $('graphSideClose').onclick = () => { selNodeId = null; selEdgeIdx = -1; render(); };
  el.querySelectorAll('[data-act]').forEach(b => {
    b.onclick = () => nodeAction(n, b.dataset.act);
  });
  el.querySelectorAll('[data-goto]').forEach(s => {
    s.onclick = () => { const id = s.dataset.goto; if (nodes.has(id)) { selNodeId = id; selEdgeIdx = -1; render(); centerOn(id); } };
  });
  el.querySelectorAll('[data-del-edge]').forEach(b => {
    b.onclick = async () => {
      const i = parseInt(b.dataset.delEdge, 10);
      const e = allEdges[i];
      if (!e || e.auto) return;
      if (!(await appConfirm('この関連付けを削除しますか？'))) return;
      manualEdges = manualEdges.filter(x => x.id !== e.id);
      rebuildEdges(); saveGraph(); render();
    };
  });
  $('graphRelAdd').onclick = () => {
    const to = $('graphRelTarget').value, kind = $('graphRelKind').value;
    if (!to) { appAlert('相手ノードを選択してください'); return; }
    if (allEdges.some(e => e.from === n.id && e.to === to && e.kind === kind)) { appAlert('同じ関連が既にあります'); return; }
    manualEdges.push({ id: uid(), from: n.id, to, kind, label: '', auto: false });
    rebuildEdges(); saveGraph(); render();
  };
}

function renderEdgePanel(e, idx) {
  const el = $('graphSide');
  el.innerHTML = `
    <div class="graph-side-head">
      <strong class="graph-side-title">${esc(EDGE_LABEL[e.kind] || e.kind)}${e.label ? '（' + esc(e.label) + '）' : ''}</strong>
      <button class="modal-close" id="graphSideClose"><svg class="icon"><use href="#i-close"/></svg></button>
    </div>
    <div class="graph-rel">
      <span class="graph-rel-to" data-goto="${esc(e.from)}">${nodeLink(e.from)}</span>
      <span class="graph-rel-dir">→</span>
      <span class="graph-rel-to" data-goto="${esc(e.to)}">${nodeLink(e.to)}</span>
    </div>
    <p class="hint">${e.auto ? '自動検出されたエッジ（スキャンで再生成されます）' : '手動で追加した関連付け'}</p>
    ${!e.auto ? `<div class="graph-side-actions">
      <button class="btn-ghost btn-sm" id="graphEdgeLabel">ラベル編集</button>
      <button class="btn-ghost btn-sm" id="graphEdgeDel">この関連を削除</button>
    </div>` : ''}`;
  $('graphSideClose').onclick = () => { selNodeId = null; selEdgeIdx = -1; render(); };
  el.querySelectorAll('[data-goto]').forEach(s => {
    s.onclick = () => { const id = s.dataset.goto; if (nodes.has(id)) { selNodeId = id; selEdgeIdx = -1; render(); centerOn(id); } };
  });
  const del = $('graphEdgeDel');
  if (del) del.onclick = async () => {
    const cur = allEdges[idx];
    if (!cur || cur.auto) return;
    if (!(await appConfirm('この関連付けを削除しますか？'))) return;
    manualEdges = manualEdges.filter(x => x.id !== cur.id);
    rebuildEdges(); saveGraph(); render();
  };
  const lbl = $('graphEdgeLabel');
  if (lbl) lbl.onclick = async () => {
    const cur = allEdges[idx];
    if (!cur || cur.auto) return;
    const v = await appPrompt('エッジラベルを入力（空欄で消去）', cur.label || '');
    if (v === null) return;
    const me = manualEdges.find(x => x.id === cur.id);
    if (me) { me.label = v.trim(); saveGraph(); render(); }
  };
}

async function nodeAction(n, act) {
  if (act === 'pin') {
    n.pinned = !n.pinned;
    n.fixed = true; // 手動配置済みとして扱う
    saveGraph();
    render();
    return;
  }
  if (act === 'open') {
    if (n.type === 'doc') window.__openDocument?.(n.id.slice(4));
    else if (n.type === 'scene') window.__openScene?.(n.id.slice(6));
    else if (n.type === 'conv') await openConversation(n.id.slice(5));
    else if (n.type === 'source') window.__openSources?.();
  } else if (act === 'edit' && n.card) {
    openCardsModal(n.card);
  } else if (act === 'prevsc' || act === 'nextsc') {
    const flat = listManuscriptScenes();
    const i = flat.findIndex(s => 'scene:' + s.id === n.id);
    const nb = flat[i + (act === 'prevsc' ? -1 : 1)];
    if (nb) {
      window.__openScene?.(nb.id);
      selNodeId = 'scene:' + nb.id; selEdgeIdx = -1;
      render();
    }
  } else if (act === 'fw' && n.card) {
    try {
      await api('/api/cards/' + n.card.id, {
        method: 'PUT',
        body: JSON.stringify({ resolved: !n.card.resolved })
      });
      await refreshCards();
      buildStructure();
      render();
    } catch (e) { appAlert('更新に失敗しました: ' + e.message); }
  }
}

function centerOn(id) {
  const n = nodes.get(id);
  if (!n) return;
  const wrap = $('graphCanvasWrap');
  if (!wrap) return;
  const w = wrap.clientWidth, h = wrap.clientHeight;
  view.x = w / 2 - n.x * view.k;
  view.y = h / 2 - n.y * view.k;
  applyView();
}

function selectNode(id) {
  selNodeId = id; selEdgeIdx = -1;
  render();
}
function selectEdge(idx) {
  selEdgeIdx = idx; selNodeId = null;
  render();
}

// ---------- 初期化・オープン ----------
function initGraphDom() {
  svg = $('graphSvg'); worldG = document.createElementNS(SVGNS, 'g');
  edgesG = document.createElementNS(SVGNS, 'g');
  nodesG = document.createElementNS(SVGNS, 'g');
  worldG.appendChild(edgesG); worldG.appendChild(nodesG);
  svg.appendChild(worldG);
  mmSvg = $('graphMmSvg');
  bindMinimap();
  // エッジホバーで両端ノードを強調
  edgesG.addEventListener('pointerover', (e) => {
    const p = e.target.closest ? e.target.closest('.gedge') : null;
    if (!p) return;
    const ee = edgeEls.find(x => x.i === parseInt(p.dataset.idx, 10));
    if (!ee) return;
    for (const id of [ee.e.from, ee.e.to]) nodeEls.get(id)?.g.classList.add('edge-hl');
  });
  edgesG.addEventListener('pointerout', () => {
    nodeEls.forEach(el => el.g.classList.remove('edge-hl'));
  });
  bindCanvas();
  built = true;
}

async function ensureGraph(rescan = false) {
  if (!built) initGraphDom();
  try { wgData = await api('/api/worldgraph'); } catch { wgData = { nodes: {}, edges: [] }; }
  buildStructure();
  if (rescan || !scannedOnce) await scanMentions();
  else render();
}

export async function openWorldGraph() {
  showGraphView();
  convTitleEl.textContent = '物語グラフ';
  document.body.classList.remove('sidebar-open');
  setStats('読み込み中…');
  await ensureGraph();
  render();
}

export async function openGraphTab() {
  activateTab('graph', 'main');
  await openWorldGraph();
}

export function initWorldGraph() {
  $('qbGraph') && ($('qbGraph').onclick = openGraphTab);
  $('btnGraphClose') && ($('btnGraphClose').onclick = () => closeTab({ type: 'graph', id: 'main' }));
  $('btnGraphRescan') && ($('btnGraphRescan').onclick = async () => {
    mentionEdges = [];
    buildStructure();
    await scanMentions();
  });
  $('btnGraphLayout') && ($('btnGraphLayout').onclick = forceLayout);
  $('btnGraphFit') && ($('btnGraphFit').onclick = fitView);
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (document.querySelector('.modal:not(.hidden)')) return;
    if ($('graphPane')?.classList.contains('hidden')) return;
    if (selNodeId || selEdgeIdx >= 0) { selNodeId = null; selEdgeIdx = -1; render(); }
  });
  $('btnGraphMentions') && ($('btnGraphMentions').onclick = (e) => {
    showMentions = !showMentions;
    e.target.classList.toggle('active', showMentions);
    render();
  });
  $('btnGraphIsolated') && ($('btnGraphIsolated').onclick = (e) => {
    isolatedOnly = !isolatedOnly;
    e.target.classList.toggle('active', isolatedOnly);
    render();
  });
  $('btnGraphUnresolved') && ($('btnGraphUnresolved').onclick = (e) => {
    unresolvedOnly = !unresolvedOnly;
    e.target.classList.toggle('active', unresolvedOnly);
    render();
  });
  const menu = $('graphFilterMenu');
  if (menu && !menu.dataset.built) {
    menu.dataset.built = '1';
    menu.innerHTML = `<button class="menu-item" id="graphFReset" type="button">フィルタをリセット</button>` +
      FILTER_TYPES.map(([k, l]) =>
        `<label class="graph-fitem"><input type="checkbox" data-f="${k}" checked> ${l}</label>`).join('');
    $('graphFReset').onclick = () => {
      filterSet.clear();
      FILTER_TYPES.forEach(([k]) => filterSet.add(k));
      menu.querySelectorAll('input[data-f]').forEach(cb => { cb.checked = true; });
      render();
    };
    menu.addEventListener('change', (e) => {
      const k = e.target.dataset.f;
      if (!k) return;
      if (e.target.checked) filterSet.add(k); else filterSet.delete(k);
      render();
    });
  }
  $('graphSearch') && ($('graphSearch').addEventListener('input', (e) => {
    searchQ = e.target.value; render();
  }));
}

registerTabOpener('graph', openWorldGraph);
