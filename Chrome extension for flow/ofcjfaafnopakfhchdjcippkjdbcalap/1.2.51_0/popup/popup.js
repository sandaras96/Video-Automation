// AutoFlow Pro — Popup Script (Test/Dev mode — auth disabled)

const FREE_DAILY_LIMIT = 20;

// ── Local state ────────────────────────────────────────
let isPro        = true;   // true for testing; will be Supabase-driven later
let todayUsage   = 0;
let autoState    = null;
let selectedInterval = 90;

// ── Screen routing ─────────────────────────────────────
function showScreen(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById('screen-' + name)?.classList.add('active');
}

// ── Boot: skip auth, go straight to main ──────────────
async function boot() {
  // Load usage from local storage
  const s = await chrome.storage.local.get(['todayUsage', 'usageDate']);
  const today = todayStr();
  todayUsage = s.usageDate === today ? (s.todayUsage || 0) : 0;

  await loadMain();
}

// ── Main screen ────────────────────────────────────────
async function loadMain() {
  showScreen('main');
  renderStatic();

  const state = await chrome.runtime.sendMessage({ action: 'getState' }).catch(() => null);
  renderDynamic(state || { status: 'idle' });

  await checkTab();
}

function renderStatic() {
  const badge = document.getElementById('plan-badge');
  badge.textContent = isPro ? 'PRO' : 'FREE';
  badge.className = 'plan-badge' + (isPro ? ' pro' : '');

  document.getElementById('usage-wrap').style.display    = isPro ? 'none' : 'block';
  document.getElementById('upgrade-banner').style.display = isPro ? 'none' : 'flex';

  if (!isPro) renderUsage();
}

function renderUsage() {
  const pct = Math.min(100, (todayUsage / FREE_DAILY_LIMIT) * 100);
  document.getElementById('usage-text').textContent = `${todayUsage} / ${FREE_DAILY_LIMIT}`;
  const fill = document.getElementById('usage-fill');
  fill.style.width = pct + '%';
  fill.style.background = pct >= 90 ? '#EF4444' : pct >= 70 ? '#F59E0B' : '#7C5CFC';
}

// ── Dynamic state rendering ────────────────────────────
function renderDynamic(state) {
  autoState = state;

  const dot      = document.getElementById('status-dot');
  const label    = document.getElementById('status-label');
  const idleEl   = document.getElementById('btn-idle');
  const runEl    = document.getElementById('btn-running');
  const progEl   = document.getElementById('progress-wrap');
  const btnPause = document.getElementById('btn-pause');

  if (!state || state.status === 'idle' || state.status === 'completed') {
    dot.className   = 'status-dot' + (state?.status === 'completed' ? ' done' : '');
    label.textContent = state?.status === 'completed' ? 'Tamamlandı' : 'Hazır';
    idleEl.style.display = 'block';
    runEl.style.display  = 'none';
    progEl.style.display = 'none';
    if (state?.status === 'completed') showNotif('Tüm promptlar başarıyla tamamlandı!', 'success');

  } else if (state.status === 'running' || state.status === 'paused') {
    idleEl.style.display = 'none';
    runEl.style.display  = 'grid';
    progEl.style.display = 'block';

    if (state.status === 'running') {
      dot.className = 'status-dot running';
      label.textContent = 'Çalışıyor';
      btnPause.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg> Duraklat`;
      btnPause.className = 'btn btn-pause';
    } else {
      dot.className = 'status-dot paused';
      label.textContent = 'Duraklatıldı';
      btnPause.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><polygon points="5,3 19,12 5,21"/></svg> Devam Et`;
      btnPause.className = 'btn btn-pause resume';
    }

    renderProgress(state);
  }
}

function renderProgress(state) {
  if (!state?.prompts) return;
  const total = state.prompts.length;
  const done  = state.currentIndex;
  const pct   = total > 0 ? (done / total) * 100 : 0;

  document.getElementById('progress-frac').textContent = `${done} / ${total}`;
  document.getElementById('progress-fill').style.width = pct + '%';

  const cur = document.getElementById('progress-current');
  cur.textContent = state.currentPrompt ? `→ ${state.currentPrompt}` : '';

  if (state.status === 'running' && state.interval && total > done) {
    const remaining = (total - done) * state.interval;
    document.getElementById('progress-eta').textContent = `Tahmini kalan: ~${fmtSecs(remaining)}`;
  } else {
    document.getElementById('progress-eta').textContent = '';
  }
}

function fmtSecs(s) {
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60), r = s % 60;
  return r > 0 ? `${m}dk ${r}s` : `${m}dk`;
}

// ── Notification area ──────────────────────────────────
let notifTimer = null;
function showNotif(msg, type = 'info') {
  const area = document.getElementById('notif-area');
  area.innerHTML = `<div class="banner banner-${type}">${msg}</div>`;
  clearTimeout(notifTimer);
  notifTimer = setTimeout(() => { area.innerHTML = ''; }, 4500);
}

// ── Tab check ──────────────────────────────────────────
async function checkTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const onFlow = !!tab?.url?.includes('flow.google.com');
  document.getElementById('flow-warning').style.display = onFlow ? 'none' : 'flex';
  document.getElementById('btn-start').disabled = !onFlow;
}

// ── Start automation ───────────────────────────────────
async function handleStart() {
  const raw = document.getElementById('prompt-input').value.trim();
  if (!raw) { showNotif('Lütfen en az bir prompt girin.', 'error'); return; }

  let prompts = raw.split('\n').map(p => p.trim()).filter(Boolean);
  if (!prompts.length) { showNotif('Geçerli prompt bulunamadı.', 'error'); return; }

  if (!isPro) {
    const remaining = FREE_DAILY_LIMIT - todayUsage;
    if (remaining <= 0) { showNotif('Günlük limitinize ulaştınız.', 'error'); return; }
    if (prompts.length > remaining) {
      prompts = prompts.slice(0, remaining);
      showNotif(`İlk ${remaining} prompt çalıştırılacak.`, 'info');
    }
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url?.includes('flow.google.com')) {
    showNotif('Lütfen önce Google Flow\'u açın.', 'error');
    return;
  }

  const res = await chrome.runtime.sendMessage({
    action: 'start',
    prompts,
    interval: selectedInterval,
    tabId: tab.id,
    userId: null,
    isPro,
    currentUsage: todayUsage
  }).catch(() => null);

  if (res?.success) {
    autoState = { status: 'running', prompts, currentIndex: 0, interval: selectedInterval, currentPrompt: prompts[0] };
    renderDynamic(autoState);
  } else {
    showNotif(res?.error || 'Başlatılamadı. Google Flow sayfasını yenileyin.', 'error');
  }
}

async function handlePause() {
  if (autoState?.status === 'paused') {
    const res = await chrome.runtime.sendMessage({ action: 'resume' }).catch(() => null);
    if (res?.success) { autoState.status = 'running'; renderDynamic(autoState); }
  } else {
    const res = await chrome.runtime.sendMessage({ action: 'pause' }).catch(() => null);
    if (res?.success) { autoState.status = 'paused'; renderDynamic(autoState); }
  }
}

async function handleStop() {
  await chrome.runtime.sendMessage({ action: 'stop' }).catch(() => {});
  renderDynamic({ status: 'idle' });
}

// ── Prompt counter ─────────────────────────────────────
function updateLineCount() {
  const val = document.getElementById('prompt-input').value;
  const count = val.trim() ? val.split('\n').filter(l => l.trim()).length : 0;
  document.getElementById('prompt-line-count').textContent = count;
}

function todayStr() {
  return new Date().toISOString().split('T')[0];
}

// ── Init ───────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  // Main buttons
  document.getElementById('btn-start').addEventListener('click', handleStart);
  document.getElementById('btn-pause').addEventListener('click', handlePause);
  document.getElementById('btn-stop').addEventListener('click',  handleStop);

  // Open Flow link
  document.getElementById('open-flow-link').addEventListener('click', e => {
    e.preventDefault();
    chrome.tabs.create({ url: 'https://flow.google.com' });
  });

  // Interval chips
  document.querySelectorAll('.chip').forEach(chip => {
    chip.addEventListener('click', () => {
      document.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      selectedInterval = parseInt(chip.dataset.seconds);
      const labels = { 30: '30 saniye', 90: '90 saniye', 120: '2 dakika', 180: '3 dakika' };
      document.getElementById('interval-hint').textContent = labels[selectedInterval] || selectedInterval + 's';
    });
  });

  // Prompt counter
  document.getElementById('prompt-input').addEventListener('input', updateLineCount);

  // Background state updates
  chrome.runtime.onMessage.addListener(msg => {
    if (msg.type === 'stateUpdate') {
      renderDynamic(msg.state);
      if (typeof msg.usageCount === 'number') {
        todayUsage = msg.usageCount;
        renderUsage();
        chrome.storage.local.set({ todayUsage, usageDate: todayStr() });
      }
    }
  });

  boot();
});
