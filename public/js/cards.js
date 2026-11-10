// ---------- Cards（設定カード管理・会話別ピッカー） ----------
import { $ } from './dom.js';
import { api, appConfirm } from './util.js';
import { allCards, setAllCards, cardsVersion, setCardsVersion, current, CARD_KINDS } from './state.js';
import { saveConversation } from './conversations.js';

export async function refreshCards() {
  setAllCards(await api('/api/cards'));
  setCardsVersion(cardsVersion + 1);
}
export function openCardsModal(editCard = null) {
  refreshCards().then(renderCardList);
  $('cardsModal').classList.remove('hidden');
  if (editCard) fillCardForm(editCard);
  else resetCardForm();
}
function renderCardList() {
  const el = $('cardList');
  el.innerHTML = '';
  if (!allCards.length) {
    el.innerHTML = '<p class="hint">カードがありません。「新しいカード」で作成してください。</p>';
    return;
  }
  const fws = allCards.filter(c => c.kind === 'foreshadow');
  if (fws.length) {
    const open = fws.filter(c => !c.resolved).length;
    const d = document.createElement('div');
    d.className = 'hint';
    d.style.padding = '4px 8px';
    d.textContent = `伏線トラッカー: 未回収 ${open}件 / 回収済 ${fws.length - open}件（原稿ペインの「伏線チェック」でAI提案できます）`;
    el.appendChild(d);
  }
  for (const c of allCards) {
    const div = document.createElement('div');
    div.className = 'card-item';
    div.innerHTML = `<span class="card-kind">${CARD_KINDS[c.kind] || c.kind}</span> <strong></strong> ${c.resolved ? '<span class="card-resolved">回収済</span>' : ''} <span class="hint"></span>`;
    div.querySelector('strong').textContent = c.name;
    const tagStr = String(c.tags || '').split(/[,、\s]+/).filter(Boolean).map(t => '#' + t).join(' ');
    const hint = (c.content || '').slice(0, 60).replace(/\n/g, ' ');
    div.querySelector('.hint').textContent = (tagStr ? tagStr + ' ' : '') + (c.triggers ? `⚑${c.triggers} ` : '') + hint;
    div.onclick = () => fillCardForm(c);
    el.appendChild(div);
  }
}
function fillCardForm(c) {
  $('cardEditForm').classList.remove('hidden');
  $('cId').value = c.id;
  $('cName').value = c.name;
  $('cKind').value = c.kind;
  $('cContent').value = c.content;
  $('cTriggers').value = c.triggers || '';
  $('cTags').value = c.tags || '';
  $('cResolved').checked = c.resolved === true;
  $('btnDeleteCard').classList.remove('hidden');
}
export function resetCardForm() {
  $('cardEditForm').classList.add('hidden');
  $('cId').value = ''; $('cName').value = ''; $('cContent').value = ''; $('cTriggers').value = ''; $('cTags').value = '';
  $('cResolved').checked = false;
  $('btnDeleteCard').classList.add('hidden');
}
export async function saveCard() {
  const id = $('cId').value;
  const body = { name: $('cName').value, kind: $('cKind').value, content: $('cContent').value, resolved: $('cResolved').checked, triggers: $('cTriggers').value, tags: $('cTags').value };
  if (id) await api('/api/cards/' + id, { method: 'PUT', body: JSON.stringify(body) });
  else await api('/api/cards', { method: 'POST', body: JSON.stringify(body) });
  await refreshCards();
  renderCardList();
  resetCardForm();
}
export async function deleteCard() {
  const id = $('cId').value;
  if (!id || !(await appConfirm('このカードを削除しますか？'))) return;
  await api('/api/cards/' + id, { method: 'DELETE' });
  await refreshCards();
  renderCardList();
  resetCardForm();
}

// ---------- Card picker (per conversation) ----------
export function openCardPicker() {
  if (!current) return;
  const el = $('cardPickList');
  el.innerHTML = '';
  if (!allCards.length) {
    el.innerHTML = '<p class="hint">カードがありません。先にサイドバーの「カード」で作成してください。</p>';
    return;
  }
  for (const c of allCards) {
    const label = document.createElement('label');
    label.className = 'pick-item';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = (current.cardIds || []).includes(c.id);
    cb.dataset.id = c.id;
    label.appendChild(cb);
    const tagStr = String(c.tags || '').split(/[,、\s]+/).filter(Boolean).map(t => '#' + t).join(' ');
    label.appendChild(document.createTextNode(` [${CARD_KINDS[c.kind] || c.kind}] ${c.name}${tagStr ? ' ' + tagStr : ''}`));
    el.appendChild(label);
  }
  $('cardPickModal').classList.remove('hidden');
}
export function saveCardPick() {
  if (!current) return;
  current.cardIds = [...document.querySelectorAll('#cardPickList input:checked')].map(cb => cb.dataset.id);
  saveConversation().then(() => {
    $('btnCloseCardPick').click();
  });
}
