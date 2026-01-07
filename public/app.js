const $ = (id) => document.getElementById(id);

const state = {
  userId: localStorage.getItem('userId') || '',
  auctionId: localStorage.getItem('auctionId') || ''
};

function setUserId(id) {
  state.userId = id;
  localStorage.setItem('userId', id);
  $('userId').textContent = id ? `Пользователь: ${id}` : '';
}

function setAuctionId(id) {
  state.auctionId = id;
  localStorage.setItem('auctionId', id);
  $('selectedAuctionId').value = id;
}

async function api(path, opts) {
  const res = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...opts
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || `${res.status} ${res.statusText}`);
  return data;
}

function fmtMs(ms) {
  if (ms == null) return '—';
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const ss = String(s % 60).padStart(2, '0');
  return `${m}:${ss}`;
}

async function reloadUser() {
  if (!state.userId) {
    $('userState').textContent = 'Пользователь не выбран';
    $('userAvailable').textContent = '—';
    $('userReserved').textContent = '—';
    $('userSpent').textContent = '—';
    return;
  }
  const data = await api(`/api/users/${state.userId}`);
  $('userState').textContent = JSON.stringify(data, null, 2);

  $('userAvailable').textContent = String(data?.balance?.available ?? 0);
  $('userReserved').textContent = String(data?.balance?.reserved ?? 0);
  $('userSpent').textContent = String(data?.balance?.spent ?? 0);
}

function ruAuctionState(state) {
  switch (state) {
    case 'draft':
      return 'черновик';
    case 'running':
      return 'идёт';
    case 'ended':
      return 'завершён';
    case 'cancelled':
      return 'отменён';
    default:
      return String(state);
  }
}

async function reloadAuctions() {
  const data = await api('/api/auctions');
  const root = $('auctionsList');
  root.innerHTML = '';
  for (const a of data.auctions) {
    const id = a._id;
    const item = document.createElement('div');
    item.className = 'item';

    const title = document.createElement('div');
    title.className = 'title';

    const strong = document.createElement('strong');
    strong.textContent = a.title;

    const pill = document.createElement('span');
    pill.className = 'pill';
    pill.title = a.state;
    pill.textContent = ruAuctionState(a.state);
    strong.append(' ', pill);

    const sub = document.createElement('div');
    sub.className = 'sub mono';
    sub.textContent = id;

    title.append(strong, sub);

    const progress = document.createElement('div');
    progress.className = 'mono muted';
    progress.textContent = `${a.awardedCount}/${a.totalQuantity}`;

    const btn = document.createElement('button');
    btn.className = 'secondary';
    btn.textContent = 'Выбрать';
    btn.addEventListener('click', () => setAuctionId(id));

    item.append(title, progress, btn);
    root.appendChild(item);
  }
}

async function reloadSnapshot() {
  if (!state.auctionId) return;
  const qs = state.userId ? `?userId=${encodeURIComponent(state.userId)}` : '';
  const snap = await api(`/api/auctions/${state.auctionId}/snapshot${qs}`);
  $('auctionState').textContent = JSON.stringify(snap.auction, null, 2);
  $('auctionStateLabel').textContent = ruAuctionState(snap.auction.state);
  $('roundNumber').textContent = String(snap.auction.currentRound ?? '—');
  $('awarded').textContent = `${snap.auction.awardedCount}/${snap.auction.totalQuantity}`;
  $('remainingQty').textContent = String(snap.remainingQuantity ?? 0);
  $('revenue').textContent = String(snap.auction.revenue ?? 0);
  $('timeRemaining').textContent = fmtMs(snap.timeRemainingMs);
  $('estimatedCutoff').textContent = snap.estimatedClearingPrice ?? '—';

  const lb = $('leaderboard');
  lb.innerHTML = '';
  for (const [i, b] of snap.leaderboard.entries()) {
    const row = document.createElement('div');
    row.className = 'row';
    row.innerHTML = `
      <span class="mono">#${i + 1}</span>
      <span class="mono">${b.userId}</span>
      <span>ставка=${b.amount}</span>
      <span class="muted">${new Date(b.lastBidAt).toLocaleTimeString()}</span>
    `;
    lb.appendChild(row);
  }

  const rr = $('recentRounds');
  rr.innerHTML = '';
  for (const r of snap.recentRounds) {
    const div = document.createElement('div');
    div.className = 'card';
    div.innerHTML = `
      <div class="row">
        <strong>Раунд ${r.roundNumber}</strong>
        <span class="pill">проходная=${r.clearingPrice}</span>
        <span class="muted">${new Date(r.endedAt).toLocaleString()}</span>
      </div>
      <div class="mono">${r.winners
        .map((w) => `${w.userId} ставка=${w.amount} номер=#${w.giftSerial}`)
        .join('<br/>') || '<span class="muted">Нет победителей</span>'}
      </div>
    `;
    rr.appendChild(div);
  }
}

// Wire UI
setUserId(state.userId);
setAuctionId(state.auctionId);

$('btnCreateUser').addEventListener('click', async () => {
  const data = await api('/api/users', { method: 'POST', body: '{}' });
  setUserId(data.id);
  await reloadUser();
});

$('btnReloadUser').addEventListener('click', async () => {
  await reloadUser();
});

$('btnTopup').addEventListener('click', async () => {
  if (!state.userId) throw new Error('Сначала создайте/выберите пользователя');
  const amount = Number($('topupAmount').value);
  await api(`/api/users/${state.userId}/topup`, {
    method: 'POST',
    body: JSON.stringify({ amount })
  });
  await reloadUser();
});

$('btnCreateAuction').addEventListener('click', async () => {
  const body = {
    title: $('auctionTitle').value,
    totalQuantity: Number($('auctionQty').value),
    config: {
      roundDurationMs: Number($('roundDuration').value),
      winnersPerRound: Number($('winnersPerRound').value),
      antiSnipeWindowMs: Number($('antiWindow').value),
      antiSnipeExtendMs: Number($('antiExtend').value),
      maxDurationMs: Number($('maxDurationMs').value),
      maxConsecutiveEmptyRounds: Number($('maxEmptyRounds').value)
    }
  };
  const res = await api('/api/auctions', { method: 'POST', body: JSON.stringify(body) });
  $('createAuctionOut').textContent = JSON.stringify(res, null, 2);
  setAuctionId(res.id);
  await reloadAuctions();
});

$('btnReloadAuctions').addEventListener('click', async () => {
  await reloadAuctions();
});

$('btnSelectAuction').addEventListener('click', async () => {
  setAuctionId($('selectedAuctionId').value.trim());
  await reloadSnapshot();
});

$('btnStartAuction').addEventListener('click', async () => {
  if (!state.auctionId) throw new Error('Сначала выберите аукцион');
  await api(`/api/auctions/${state.auctionId}/start`, { method: 'POST', body: '{}' });
  await reloadSnapshot();
});

$('btnCancelAuction').addEventListener('click', async () => {
  if (!state.auctionId) throw new Error('Сначала выберите аукцион');
  await api(`/api/auctions/${state.auctionId}/cancel`, { method: 'POST', body: '{}' });
  await reloadSnapshot();
});

$('btnBid').addEventListener('click', async () => {
  if (!state.auctionId) throw new Error('Сначала выберите аукцион');
  if (!state.userId) throw new Error('Сначала создайте/выберите пользователя');
  const amount = Number($('bidAmount').value);
  await api(`/api/auctions/${state.auctionId}/bids`, {
    method: 'POST',
    body: JSON.stringify({ userId: state.userId, amount })
  });
  await reloadUser();
  await reloadSnapshot();
});

$('btnWithdraw').addEventListener('click', async () => {
  if (!state.auctionId) throw new Error('Сначала выберите аукцион');
  if (!state.userId) throw new Error('Сначала создайте/выберите пользователя');
  await api(`/api/auctions/${state.auctionId}/withdraw`, {
    method: 'POST',
    body: JSON.stringify({ userId: state.userId })
  });
  await reloadUser();
  await reloadSnapshot();
});

$('btnStartBots').addEventListener('click', async () => {
  if (!state.auctionId) throw new Error('Сначала выберите аукцион');
  const count = Number($('botCount').value);
  const topupAmount = Number($('botTopup').value);
  const maxBid = Number($('botMaxBid').value);
  const res = await api(`/api/auctions/${state.auctionId}/bots/start`, {
    method: 'POST',
    body: JSON.stringify({ count, topupAmount, maxBid })
  });
  $('botsOut').textContent = JSON.stringify(res, null, 2);
});

$('btnStopBots').addEventListener('click', async () => {
  if (!state.auctionId) throw new Error('Сначала выберите аукцион');
  const res = await api(`/api/auctions/${state.auctionId}/bots/stop`, {
    method: 'POST',
    body: '{}'
  });
  $('botsOut').textContent = JSON.stringify(res, null, 2);
});

$('btnBotsStatus').addEventListener('click', async () => {
  if (!state.auctionId) throw new Error('Сначала выберите аукцион');
  const res = await api(`/api/auctions/${state.auctionId}/bots`);
  $('botsOut').textContent = JSON.stringify(res, null, 2);
});

$('btnAuditAuction').addEventListener('click', async () => {
  if (!state.auctionId) throw new Error('Сначала выберите аукцион');
  const audit = await api(`/api/auctions/${state.auctionId}/audit`);
  $('auditOut').textContent = JSON.stringify(audit, null, 2);
});

$('btnAuditGlobal').addEventListener('click', async () => {
  const audit = await api('/api/audit');
  $('auditOut').textContent = JSON.stringify(audit, null, 2);
});

// Periodic refresh
setInterval(() => {
  void reloadSnapshot().catch(() => {});
  void reloadUser().catch(() => {});
}, 1000);

void reloadAuctions();
void reloadUser();
void reloadSnapshot();

window.addEventListener('unhandledrejection', (e) => {
  alert(e.reason?.message || String(e.reason));
});
