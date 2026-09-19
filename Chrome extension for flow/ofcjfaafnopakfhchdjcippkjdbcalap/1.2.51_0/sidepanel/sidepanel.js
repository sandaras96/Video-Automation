// AutoFlow Pro — Side Panel Script

const FREE_DAILY_LIMIT =
  (typeof AUTOFLOW_CONFIG !== 'undefined' && AUTOFLOW_CONFIG.FREE_DAILY_LIMIT) || 20;

// Ücretsiz mod: herkes sınırsız, ödeme arayüzü gizli. config.js'den kontrol edilir.
const FREE_MODE =
  (typeof AUTOFLOW_CONFIG !== 'undefined' && AUTOFLOW_CONFIG.FREE_MODE === true);

// ── State ──────────────────────────────────────────────
let isPro         = false;  // Pro durumu Supabase entitlements'tan gelir
let currentUser   = null;   // Supabase kullanıcı objesi (giriş yapılınca)
let todayUsage    = 0;
let autoState     = null;
// Duraklat/Devam tıklandığında kullanıcının NİYETİ: buton arka ucun yanıtını beklemeden
// hemen bu duruma göre çizilir. Arka uç istenen duruma geçince (ya da 12 sn sonra) düşer.
let pauseIntent   = null;   // { status: 'paused'|'running', until: ms }
let selectedSecs  = 1;
let flowTab       = null;
let panelWinId    = null;

// ── Referans modeli ────────────────────────────────────
// refMode: 'shared' = ortak referanslar HER prompt'a eklenir (eski davranışın çoklu hali)
//          'map'    = her prompt'a Library'den ayrı referans(lar) atanır
let refMode     = 'shared';
let sharedRefs  = [];   // [{ name, dataUrl, type }] — en fazla MAX_SHARED
let library     = [];   // [{ id, name, dataUrl, type, tag }] — kalıcı (chrome.storage.local)
let promptMap   = {};   // { [satırIndeksi]: [libraryId, ...] } — yalnızca 'map' modunda
const MAX_SHARED = 10;
// KRİTİK: boot referans verisini IDB'den YÜKLEYENE kadar saveRefState YAZMAMALI. Aksi halde
// setupReferenceUI() içindeki setRefMode() (boot'tan ÖNCE çalışıyor) boş library'yi kaydedip
// IDB'deki gerçek veriyi SİLİYOR (kütüphane kapat-aç sonrası kayboluyordu). Bu bayrak boot
// yüklemesi bitince true olur; o ana kadarki tüm save çağrıları yok sayılır.
let refStateLoaded = false;

// İndirme ayarları
let autoDownload  = false;
let dlQualityImg  = '1k';
let dlQualityVid  = '720p';
// v149 KAYIT KLASORU: kullanicinin sectigi klasor, tarayicinin Indirilenler klasorunun
// ALTINDA. Chrome eklentilere mutlak disk yolu yazdirmaz -> "yol" = alt klasor adi.
// Bos birakilirsa indirme davranisi eskisiyle birebir aynidir.
let dlFolderRoot  = '';   // ham kullanici metni (temizligi arka uc yapar)
let dlFolderDated = true; // her akis icin tarihli alt klasor
// v151 DOSYA ADI MODU (varsayilani eski davranis). Prompt kutusu icin AYIRMA MODU YOKTUR;
// bicim (satir satir / bos satirla ayrilmis paragraf) parsePromptText icinde anlasilir.
let dlNaming  = 'num';  // 'num' (0001) | 'prompt' | 'time' (00-05) | 'numtime' (0001_00-05)
// v175 BASLANGIC NUMARASI: parca parca gonderimde dosya numarasi kaldigi yerden devam etsin
// (ornek 41 -> 0041, 0042 ...). 1 = eski davranis. Arka uc depodan okur, akis basinda sabitler.
let dlStartNum = 1;
let bulkDownloading = false; // "Sonradan indir" (manuel) şu an çalışıyor mu → buton "Durdur"a döner

// Üretim ayarları — SABİT seçenekler (Flow'dan okuma YOK). Kullanıcı seçer,
// yalnızca Akışı Başlat'ta Flow'a uygulanır. Google yeni model/oran eklerse
// bu liste elle güncellenir. Oran kodları Flow'un radix id sonekleridir.
const GEN_OPTIONS = {
  IMAGE: {
    models: [
      { name: 'Nano Banana Pro' },
      { name: 'Nano Banana 2', selected: true },
      { name: 'Nano Banana 2 Lite' }
    ],
    aspects: [
      { code: 'LANDSCAPE',     label: '16:9', selected: true },
      { code: 'LANDSCAPE_4_3', label: '4:3' },
      { code: 'SQUARE',        label: '1:1' },
      { code: 'PORTRAIT_3_4',  label: '3:4' },
      { code: 'PORTRAIT',      label: '9:16' }
    ],
    counts: [ { n: 1, selected: true }, { n: 2 }, { n: 3 }, { n: 4 } ],
    durations: []
  },
  VIDEO: {
    // 2026-09 Flow güncellemesi: "Omni Flash" → "Omni 1.1 Flash",
    // "Veo 3.1 - Lite [Lower Priority]" listeden kalktı.
    // Flow'daki sirayla. "Lower Priority" YALNIZ Ultra hesaplarda listelenir; listede
    // durmasi zararsiz (secilirse ve hesapta yoksa applyV2 modeli degistirmez, uyari loglar).
    models: [
      { name: 'Omni 1.1 Flash', selected: true },
      { name: 'Veo 3.1 - Lite' },
      { name: 'Veo 3.1 - Fast' },
      { name: 'Veo 3.1 - Quality' },
      { name: 'Veo 3.1 - Lite [Lower Priority]' }
    ],
    aspects: [
      { code: 'LANDSCAPE', label: '16:9', selected: true },
      { code: 'PORTRAIT',  label: '9:16' }
    ],
    counts: [ { n: 1, selected: true }, { n: 2 }, { n: 3 }, { n: 4 } ],
    // YENİ (2026-09): video çözünürlüğü. Flow varsayılanı 360p (ucuz önizleme),
    // 720p daha çok kredi harcar. Boş bırakılırsa Flow'daki mevcut seçim korunur.
    // 2026-09-05 kullanici dogrulamasi: 360p/720p ve 10 sn YALNIZ Omni 1.1 Flash'ta var,
    // Veo modellerinde cozunurluk grubu HIC cizilmez ve sure 8 sn'de biter.
    resolutions: [ { p: '360p', selected: true, models: ['Omni 1.1 Flash'] },
                   { p: '720p', models: ['Omni 1.1 Flash'] } ],
    // `models` alanı olan süre YALNIZ o modellerde listelenir. Alan yoksa süre
    // tüm modellerde geçerlidir → eski davranış aynen.
    durations: [ { sec: 4 }, { sec: 6 }, { sec: 8, selected: true }, { sec: 10, models: ['Omni 1.1 Flash'] } ]
  }
};

// Model adı karşılaştırması: harf/rakam dışı her şey (boşluk, tire, ikon) silinir —
// background.js'teki model eşleştirmesiyle aynı normalizasyon.
function normModelName(s) { return String(s || '').replace(/[^\p{L}\p{N}]+/gu, '').toLowerCase(); }

// Verilen süre listesini seçili modele göre süz (modele özel süreler yalnız o modelde).
function durationsForModel(list, modelName) {
  const nm = normModelName(modelName);
  return (list || []).filter(d => !d.models || d.models.some(x => normModelName(x) === nm));
}

// Çözünürlük listesi de AYNI kuralla süzülür (360p/720p yalnız Omni 1.1 Flash'ta).
function resolutionsForModel(list, modelName) {
  const nm = normModelName(modelName);
  return (list || []).filter(r => !r.models || r.models.some(x => normModelName(x) === nm));
}

let genMode     = 'IMAGE';
let genModel    = '';
let genAspect   = '';
let genCount    = null;
let genDuration = null;  // yalnızca video modunda (saniye)
let genResolution = null; // yalnızca video modunda ('360p' | '720p') — Flow 2026-09

// ── i18n ───────────────────────────────────────────────
let currentLang = 'en';

function t(key) {
  const dict = (window.I18N && window.I18N[currentLang]) || {};
  if (dict[key] != null) return dict[key];
  const en = (window.I18N && window.I18N.en) || {};
  return en[key] != null ? en[key] : key;
}

function applyI18n() {
  // Düz metin
  document.querySelectorAll('[data-i18n]').forEach(el => {
    el.textContent = t(el.getAttribute('data-i18n'));
  });
  // HTML (bold içerenler)
  document.querySelectorAll('[data-i18n-html]').forEach(el => {
    el.innerHTML = t(el.getAttribute('data-i18n-html'));
  });
  // Placeholder
  document.querySelectorAll('[data-i18n-ph]').forEach(el => {
    el.setAttribute('placeholder', t(el.getAttribute('data-i18n-ph')));
  });
  // title (tooltip)
  document.querySelectorAll('[data-i18n-title]').forEach(el => {
    el.setAttribute('title', t(el.getAttribute('data-i18n-title')));
  });
  // Bekleme süresi hızlı chip'leri (30s / 1dk ... dile göre)
  document.querySelectorAll('.qchip[data-s]').forEach(c => {
    const s = parseInt(c.dataset.s);
    c.textContent = (s % 60 === 0) ? `${s / 60}${t('unit_min')}` : `${s}${t('unit_sec')}`;
  });
  // Dinamik alanlar tazelensin
  renderConn();
  renderAccount();
  if (typeof updateRefMeta === 'function') updateRefMeta();
  if (typeof updateMapSummary === 'function') updateMapSummary();
  if (typeof updateI2vMeta === 'function') updateI2vMeta();
  if (typeof renderDlNaming === 'function') renderDlNaming(); // onizlemeyi de tazeler
  else if (typeof updateDlFolderPreview === 'function') updateDlFolderPreview();
  // Foto→Video'daki seg butonlarının etiketleri (Kareler/Malzemeler · Başlangıç/Zincir/
  // Çiftler) ve liste metinleri t() ile ÜRETİLİYOR → dil değişince yeniden çizilmezlerse
  // eski dilde kalırlar (boot'ta doğru, dil değiştirince yanlıştı). Sayı/oran etiketleri
  // (16:9, 8s, x1) dilden bağımsız olduğu için o gruplar burada çizilmez.
  if (typeof renderI2vModeGroups === 'function') renderI2vModeGroups();
  if (typeof renderI2vList === 'function') renderI2vList();
  if (autoState) renderDynamic(autoState);
}

function setCurrentFlag() {
  const flag = document.getElementById('lang-flag');
  const active = (window.LANGS || []).find(l => l.code === currentLang);
  if (flag && active) flag.innerHTML = active.flag;
}

function buildLangMenu() {
  const menu = document.getElementById('lang-menu');
  if (!menu) return;
  menu.innerHTML = (window.LANGS || []).map(l =>
    `<button class="lang-opt" data-lang="${l.code}">
       <span class="lang-flag">${l.flag}</span><span class="lang-name">${l.name}</span>
     </button>`
  ).join('');
  setCurrentFlag();

  menu.querySelectorAll('.lang-opt').forEach(btn => {
    btn.addEventListener('click', () => {
      setLang(btn.dataset.lang);
      document.getElementById('lang-select').classList.remove('open');
    });
  });
}

async function setLang(lang) {
  if (!window.I18N || !window.I18N[lang]) lang = 'en';
  currentLang = lang;
  document.documentElement.lang = lang; // CSS uppercase locale doğru olsun (İ/I sorunu)
  setCurrentFlag();
  applyI18n();
  try { await chrome.storage.local.set({ uiLang: lang }); } catch (_) {}
}

// ── Boot ───────────────────────────────────────────────
async function boot() {
  console.log('[AutoFlow][LIB] boot başladı — build:pause-instant-v122');
  const s = await chrome.storage.local.get([
    'todayUsage', 'usageDate', 'automationState', 'uiLang',
    'afRefMode', 'afSharedRefs', 'afLibrary', 'afPromptMap', 'afActiveTab', 'afPromptDraft',
    'afI2vItems', 'afI2vSort', 'afI2vPrompts', 'afI2vModel', 'afI2vDuration', 'afI2vCount', 'afI2vAspect', 'afI2vResolution',
    'afI2vUse', 'afI2vPair',
    'afDlRoot', 'afDlDated', 'afDlNaming', 'afDlStartNum'
  ]);
  const today = todayStr();
  todayUsage = s.usageDate === today ? (s.todayUsage || 0) : 0;

  // Referans sistemi durumunu geri yükle. Mod + prompt eşlemesi storage.local'de;
  // GÖRSELLER artık IndexedDB'de (kota sorunu yok → kalıcı). Eski sürümden kalan
  // storage.local görselleri ilk açılışta IDB'ye TAŞINIR (migrasyon).
  if (s.afRefMode === 'map' || s.afRefMode === 'shared') refMode = s.afRefMode;
  if (s.afPromptMap && typeof s.afPromptMap === 'object') promptMap = s.afPromptMap;
  try {
    let lib = await idbGet('afLibrary');
    console.log('[AutoFlow][LIB] boot ham okuma → IDB afLibrary:',
      Array.isArray(lib) ? lib.length : '(yok)', '| storage.local afLibrary:',
      Array.isArray(s.afLibrary) ? s.afLibrary.length : '(yok)');
    if (!Array.isArray(lib) && Array.isArray(s.afLibrary) && s.afLibrary.length) {
      lib = s.afLibrary; await idbSet('afLibrary', lib); // eski storage.local → IDB
    }
    if (Array.isArray(lib)) {
      const seenLib = new Set();
      library = lib.filter(x => {
        if (!x || !x.dataUrl || seenLib.has(x.dataUrl)) return false;
        seenLib.add(x.dataUrl); return true;
      });
    }
    let sh = await idbGet('afSharedRefs');
    if (!Array.isArray(sh) && Array.isArray(s.afSharedRefs) && s.afSharedRefs.length) {
      sh = s.afSharedRefs; await idbSet('afSharedRefs', sh);
    }
    if (Array.isArray(sh)) sharedRefs = sh;
    // v115: Foto→Video'nun kendi görsel deposu (Library'den bağımsız)
    const i2l = await idbGet('afI2vLib');
    if (Array.isArray(i2l)) i2vLib = i2l;
    // Eski storage.local kopyalarını temizle (artık IDB tek kaynak; kota'yı boşaltır).
    try { chrome.storage.local.remove(['afLibrary', 'afSharedRefs']); } catch (_) {}
  } catch (e) {
    console.warn('[AutoFlow][LIB] IDB yükleme hatası, storage.local yedeğine düşülüyor:', e && e.message);
    if (Array.isArray(s.afLibrary)) library = s.afLibrary;
    if (Array.isArray(s.afSharedRefs)) sharedRefs = s.afSharedRefs;
  }
  // Veri yüklendi → artık saveRefState YAZABİLİR (bundan önceki init save'leri yok sayıldı,
  // gerçek veri korundu). Bu satırdan SONRA tüm kaydetmeler normal çalışır.
  refStateLoaded = true;
  console.log('[AutoFlow][LIB] yüklendi → library:', library.length, '| shared:', sharedRefs.length);

  currentLang = (s.uiLang && window.I18N && window.I18N[s.uiLang]) ? s.uiLang : 'en';
  document.documentElement.lang = currentLang; // CSS uppercase locale (İ/I) doğru olsun
  buildLangMenu();
  applyI18n();

  // Yüklenen referans durumunu ekrana yansıt (dil uygulandıktan sonra)
  setRefMode(refMode);
  renderSharedRefs();
  renderLibrary();
  updateMapSummary();

  // Görselden Video durumu (sıra + meta; görsellerin kendisi artık i2vLib/IDB'de).
  if (Array.isArray(s.afI2vItems)) {
    const mig = migrateI2vSeparation(s.afI2vItems);
    if (mig.migrated) {
      console.log('[AutoFlow][I2V] v115 geçiş:', mig.migrated, 'görsel i2vLib\'e taşındı;',
        'otomatik promptMap temizlendi:', mig.clearedAutoMap);
      saveI2vLib(); saveRefState();
      renderLibrary(); updateMapSummary(); // yukarıdaki ilk render'lar eski library ile çizmişti
    }
  }
  if (typeof s.afI2vSort === 'string') i2vSort = s.afI2vSort;
  const i2vSel0 = document.getElementById('i2v-sort');
  if (i2vSel0) i2vSel0.value = i2vSort;
  const i2vTa0 = document.getElementById('i2v-prompts');
  if (i2vTa0 && typeof s.afI2vPrompts === 'string' && !i2vTa0.value.trim()) i2vTa0.value = s.afI2vPrompts;
  if (typeof s.afI2vModel === 'string' && GEN_OPTIONS.VIDEO.models.some(m => m.name === s.afI2vModel)) i2vModel = s.afI2vModel;
  if (GEN_OPTIONS.VIDEO.durations.some(d => d.sec === s.afI2vDuration)) i2vDuration = s.afI2vDuration;
  if (GEN_OPTIONS.VIDEO.counts.some(c => c.n === s.afI2vCount)) i2vCount = s.afI2vCount;
  if (typeof s.afI2vAspect === 'string' && GEN_OPTIONS.VIDEO.aspects.some(a => a.code === s.afI2vAspect)) i2vAspect = s.afI2vAspect;
  if (typeof s.afI2vResolution === 'string' && (GEN_OPTIONS.VIDEO.resolutions || []).some(r => r.p === s.afI2vResolution)) i2vResolution = s.afI2vResolution;
  // v119: kare modu + eşleme (bozuk/eski değer yok sayılır → varsayılan 'ingredients'/'start')
  if (s.afI2vUse === 'frames' || s.afI2vUse === 'ingredients') i2vUse = s.afI2vUse;
  if (['start', 'chain', 'pairs'].includes(s.afI2vPair)) i2vPair = s.afI2vPair;
  // v149: kayit klasoru ayari (baglama DOMContentLoaded'da yapildi, burada degeri basiyoruz)
  if (typeof s.afDlRoot === 'string') dlFolderRoot = s.afDlRoot;
  if (s.afDlDated === false) dlFolderDated = false; // yalniz acikca kapatilmissa
  syncDlFolderUi();
  // v151: dosya adi modu (bilinmeyen deger -> 'num' = eski davranis)
  if (s.afDlNaming === 'prompt' || s.afDlNaming === 'time' || s.afDlNaming === 'numtime') dlNaming = s.afDlNaming;
  // v175: baslangic numarasi (eksik/gecersiz deger -> 1 = eski davranis)
  if (Number.isInteger(s.afDlStartNum) && s.afDlStartNum >= 1) dlStartNum = Math.min(s.afDlStartNum, 99999);
  syncDlStartNumUi(null);
  renderDlNaming(); // uyari + klasor onizlemesi
  updateLineCount();
  renderI2vGenControls();
  renderI2vModeGroups();   // kare modu seg grupları (renderI2vList'ten ÖNCE: not satırı listeyle tazelenir)
  renderI2vList();

  // v170: panel yeniden acildiginda (sekme degisince panel kapanip yeniden yukleniyor) Queue
  // bitmis kosunun gonderildi/indirildi/inmedi durumunu kaybetmesin. Bosta (idle) qState
  // BOS kalir -> textarea onizlemesi eskisi gibi calisir.
  {
    const as = s.automationState;
    if (!qState && as && Array.isArray(as.prompts) && as.prompts.length && as.status && as.status !== 'idle') qState = as;
  }
  // Son açık sekmeyi geri yükle + Gallery/Logs ilk render
  setActiveTab(['i2v', 'queue', 'library', 'logs'].includes(s.afActiveTab) ? s.afActiveTab : 'control');
  updateDownloadLaterBtn(s.automationState || {});
  setLogs((s.automationState && s.automationState.logs) || []);

  renderDynamic(s.automationState || { status: 'idle' });

  // Prompt TASLAĞINI geri yükle: panel artık SEKMEYE ÖZEL (v93) — sekme değişince kapanıp
  // dönünce yeniden yüklenir; yazılmış ama Start'a basılmamış promptlar kaybolmasın.
  // Yalnız textarea BOŞSA doldurulur (dolu geldiyse asla ezilmez).
  try {
    const ta = document.getElementById('prompt-input');
    if (ta && !ta.value.trim() && typeof s.afPromptDraft === 'string' && s.afPromptDraft.trim()) {
      ta.value = s.afPromptDraft;
      updateLineCount(); updateMapSummary();
      if (!qState || qState.status === 'idle') renderQueue();
    }
  } catch (_) {}

  // Yan panelin açık olduğu pencereyi kilitle; üretim yalnızca bu pencerede yapılır.
  try { const w = await chrome.windows.getCurrent(); panelWinId = w.id; } catch (_) {}

  await pollFlowTab();
  setInterval(pollFlowTab, 1500);

  // Giriş yapılandırması için (Supabase → Auth → URL Configuration → Redirect URLs)
  try {
    if (globalThis.SBAuth) console.log('[AutoFlow] Supabase Redirect URL:', SBAuth.getRedirectURL());
  } catch (_) {}

  await refreshAuth();
}

// ── Flow tab detection ─────────────────────────────────
function isFlowUrl(url) {
  if (!url) return false;
  // Eski (kanitlanmis) kabuller AYNEN duruyor -> bugune kadar baglanan hicbir adres kaybolmaz.
  if (url.includes('labs.google.fx') ||
      url.includes('labs.google.com') ||
      url.includes('flow.google.com')) return true;
  // v169: eski genel kural `url icinde google VE flow` idi; SORGU DIZESINI de sayiyordu.
  // Boylece https://www.google.com/search?q=flow gibi bir sekme "Bagli" gorunuyor, Start
  // aciliyor, ama eklenti o sayfaya HICBIR ZAMAN yazamiyor (host_permissions disinda) ->
  // butun parti "yapistirilamadi" diye tek tek atlaniyordu (kullanici logu 2026-09-12).
  // Artik "flow" ibaresi yalniz HOST'ta ya da YOL'da aranir; sorgu/hash sayilmaz.
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    const host = u.hostname.toLowerCase();
    const path = (u.pathname || '').toLowerCase();
    const google = host === 'google' || host.endsWith('.google') || host.includes('google.');
    return google && (host.includes('flow') || path.includes('flow'));
  } catch (_) { return false; }
}

async function pollFlowTab() {
  try {
    // Pencere kilidi henüz alınmadıysa al.
    if (panelWinId == null) {
      try { const w = await chrome.windows.getCurrent(); panelWinId = w.id; } catch (_) {}
    }

    // Yalnızca yan panelin açık olduğu pencereyi dinle.
    const tabs = panelWinId != null
      ? await chrome.tabs.query({ windowId: panelWinId })
      : await chrome.tabs.query({ currentWindow: true });

    // O penceredeki AKTİF sekme Flow ise bağlan; değilse "Google Flow'u açın".
    const active = tabs.find(t => t.active);
    flowTab = (active && isFlowUrl(active.url)) ? active : null;
  } catch (_) { flowTab = null; }
  renderConn();
}

function renderConn() {
  const card  = document.getElementById('conn-card');
  const icon  = document.getElementById('conn-icon');
  const title = document.getElementById('conn-title');
  const sub   = document.getElementById('conn-sub');
  const btn   = document.getElementById('conn-btn');
  const start = document.getElementById('btn-start');

  if (flowTab) {
    card.className    = 'conn-card connected';
    icon.className    = 'conn-icon ok';
    icon.innerHTML    = svgCheck();
    title.textContent = t('conn_connected');
    sub.textContent   = flowTab.url || '';
    btn.style.display = 'none';
    applyStartGate();
  } else {
    card.className    = 'conn-card disconnected';
    icon.className    = 'conn-icon off';
    icon.innerHTML    = svgWarn();
    title.textContent = t('conn_notfound');
    sub.textContent   = t('conn_open_hint');
    btn.style.display = 'block';
    start.disabled    = true;
  }
}

// ── Hesap / Auth ───────────────────────────────────────
function renderAccount() {
  const out = document.getElementById('acc-out');
  const inn = document.getElementById('acc-in');
  const card = document.getElementById('account-card');
  const menu = document.getElementById('acc-menu');
  if (!out || !inn) return;

  if (currentUser) {
    out.style.display = 'none';
    inn.style.display = 'inline-flex';
    if (card) card.classList.add('compact');
    if (menu) menu.style.display = 'none';
    const meta  = currentUser.user_metadata || {};
    const email = currentUser.email || meta.email || '';
    document.getElementById('acc-email').textContent = email;

    const avatarUrl = meta.avatar_url || meta.picture || '';
    const av = document.getElementById('acc-avatar');
    av.style.backgroundImage = avatarUrl ? `url("${avatarUrl}")` : '';

    const planEl = document.getElementById('acc-plan');
    planEl.textContent = isPro ? t('acc_plan_pro') : t('acc_plan_free');
    planEl.className   = 'acc-plan' + (isPro ? ' pro' : '');
    // Ücretsiz modda Free/Pro ayrımı anlamsız; rozeti gizle.
    planEl.style.display = FREE_MODE ? 'none' : '';

    const usageEl = document.getElementById('acc-usage');
    usageEl.textContent = (isPro || FREE_MODE) ? '' : `${t('acc_today')}: ${todayUsage} / ${FREE_DAILY_LIMIT}`;

    const upBtn = document.getElementById('btn-upgrade');
    if (upBtn) upBtn.style.display = (isPro || FREE_MODE) ? 'none' : 'inline-flex';
  } else {
    out.style.display = 'flex';
    inn.style.display = 'none';
    if (card) card.classList.remove('compact');
    if (menu) menu.style.display = 'none';
  }

  // Giriş yapılmamışken görünen "günde 20 görsel" notu ücretsiz modda yanlış olur.
  const note = document.querySelector('#acc-out .acc-note');
  if (note) note.style.display = FREE_MODE ? 'none' : '';
}

async function refreshAuth() {
  try {
    if (!globalThis.SBAuth || !SBAuth.isConfigured()) {
      currentUser = null; isPro = false;
    } else {
      currentUser = await SBAuth.getUser();
      if (currentUser) {
        const ent = await SBAuth.getEntitlement();
        isPro = !!(ent && ent.pro);
      } else {
        isPro = false;
      }
    }
  } catch (_) { currentUser = null; isPro = false; }
  renderAccount();
  applyStartGate();
}

async function handleSignIn() {
  if (!globalThis.SBAuth || !SBAuth.isConfigured()) {
    showNotif(t('acc_not_configured'), 'error');
    return;
  }
  const btn = document.getElementById('btn-google');
  btn.disabled = true;
  try {
    await SBAuth.signInWithGoogle();
    await refreshAuth();
  } catch (_) {
    showNotif(t('acc_login_failed'), 'error');
  } finally {
    btn.disabled = false;
  }
}

async function handleSignOut() {
  try { if (globalThis.SBAuth) await SBAuth.signOut(); } catch (_) {}
  currentUser = null; isPro = false;
  renderAccount();
  applyStartGate();
}

function handleUpgrade() {
  if (!currentUser) { handleSignIn(); return; }
  const link = (typeof AUTOFLOW_CONFIG !== 'undefined' && AUTOFLOW_CONFIG.STRIPE_PAYMENT_LINK) || '';
  if (!link || link.indexOf('YOUR_PAYMENT_LINK') !== -1) {
    showNotif(t('acc_not_configured'), 'error');
    return;
  }
  // Ödemeyi doğru kullanıcıya bağlamak için id ve e-postayı linke ekle
  const meta  = currentUser.user_metadata || {};
  const email = currentUser.email || meta.email || '';
  const sep   = link.indexOf('?') !== -1 ? '&' : '?';
  const url   = `${link}${sep}client_reference_id=${encodeURIComponent(currentUser.id || '')}` +
                (email ? `&prefilled_email=${encodeURIComponent(email)}` : '');
  chrome.tabs.create({ url });
  // Ödeme tamamlanınca webhook entitlements'i günceller; biz de kısa süre arayıp
  // Pro olur olmaz arayüzü kendiliğinden güncelleyelim.
  startProPolling();
}

// ── Tek tıkla puanlama kartı (v115; v116: KALICI — hiç gizlenmez) ──────────
// Chrome Web Store yorumları YALNIZCA kullanıcının kendisi tarafından mağaza sayfasında
// yazılabilir (bunun için API yok). Bu kart tek tıkla mağazanın yorum sayfasını açar.
// Kullanıcı kararı: kart az yer kapladığı için her zaman görünür kalır.
function setupRateCard() {
  const cta = document.getElementById('rate-cta');
  if (cta) cta.addEventListener('click', () => {
    // Mağaza yorum sayfası: store kurulumlarında chrome.runtime.id = mağaza kimliği
    try { chrome.tabs.create({ url: 'https://chromewebstore.google.com/detail/' + chrome.runtime.id + '/reviews' }); } catch (_) {}
    showNotif(t('rate_thanks'), 'success');
  });
}

// ── Ücretsiz YouTube eklentisi çapraz tanıtımı (v124) ─────────────────────
// Puanlama kartının hemen altında duran kart; tek tıkla ViralDNA YouTube
// eklentisinin Chrome Mağazası sayfasını açar. Tıklama KARTIN tamamında
// dinlenir (butondaki tık kabarcıklanıp buraya gelir) → tek dinleyici, tek sekme.
const XP_STORE_URL = 'https://chromewebstore.google.com/detail/viraldna-youtube-competit/cbpbijjinbomaofmkodlcjjdfhmaoogi?utm_source=autoflow';
function setupCrossPromo() {
  const card = document.getElementById('xp-card');
  if (card) card.addEventListener('click', () => {
    try { chrome.tabs.create({ url: XP_STORE_URL }); } catch (_) {}
  });
}

// Ödeme sonrası Pro durumunu birkaç dakika boyunca yokla
let proPollTimer = null;
function startProPolling() {
  if (proPollTimer) clearInterval(proPollTimer);
  let tries = 0;
  proPollTimer = setInterval(async () => {
    tries++;
    const was = isPro;
    await refreshAuth();
    if (isPro && !was) showNotif(`${t('acc_plan_pro')} ✓`, 'success');
    if (isPro || tries >= 40) {   // ~40 x 3sn = 2 dk
      clearInterval(proPollTimer);
      proPollTimer = null;
    }
  }, 3000);
}

// ── Başlat butonu kilidi ───────────────────────────────
function canStartNow() {
  const idle = !autoState || autoState.status === 'idle' || autoState.status === 'completed';
  if (!flowTab || !idle) return false;
  // Giriş zorunluluğu handleStart içinde uygulanır; buton tıklanabilir kalır ki
  // giriş yapılmadan tıklayan kullanıcıya "giriş yap" uyarısı gösterilebilsin.
  if (!FREE_MODE && !isPro && todayUsage >= FREE_DAILY_LIMIT) return false;
  return true;
}
function applyStartGate() {
  const start = document.getElementById('btn-start');
  if (start) start.disabled = !canStartNow();
}

// ── Dynamic state rendering ────────────────────────────
function renderDynamic(state) {
  autoState = state;

  const dot      = document.getElementById('status-dot');
  const stText   = document.getElementById('status-text');
  const idleFt   = document.getElementById('footer-idle');
  const runFt    = document.getElementById('footer-running');
  const progEl   = document.getElementById('prog-card');
  const btnPause = document.getElementById('btn-pause');
  const pulse    = document.getElementById('prog-pulse');
  const start    = document.getElementById('btn-start');

  const isIdle = !state || state.status === 'idle' || state.status === 'completed';

  if (isIdle) {
    pauseIntent = null;  // akış bitti/durduruldu → duraklat niyeti taşınmaz (sonraki koşuya sızmasın)
    dot.className        = 'status-dot' + (state?.status === 'completed' ? ' done' : '');
    stText.textContent   = state?.status === 'completed' ? t('status_completed') : t('status_ready');
    idleFt.style.display = 'block';
    runFt.style.display  = 'none';
    progEl.style.display = 'none';
    pulse.classList.remove('on');
    if (state?.status === 'completed') showNotif(t('notif_all_done'), 'success');
    renderConn();
  } else {
    start.disabled       = true;
    idleFt.style.display = 'none';
    runFt.style.display  = 'grid';
    progEl.style.display = 'flex';

    // Kullanıcı Duraklat/Devam'a bastıysa ekran ANINDA ona göre çizilir (pauseIntent).
    // Arka uç bazen birkaç saniye sonra yanıt veriyor; o aralıkta yolda olan ESKİ durum
    // yayını gelirse buton geri dönüp titremesin diye niyet önceliklidir. Niyet YALNIZCA
    // arka uçtan gelen yayında düşer (clearPauseIntent) — burada düşürülMEZ, çünkü tıklama
    // anındaki kendi çizimimiz de aynı durumu taşır ve niyeti daha doğduğu anda silerdi
    // (kullanıcının "bastım, olmadı, 5-6 sn sonra oldu" dediği hatanın kök nedeni buydu).
    if (pauseIntent && Date.now() > pauseIntent.until) pauseIntent = null; // emniyet süresi
    const shown = pauseIntent ? pauseIntent.status : state.status;

    if (shown === 'running') {
      dot.className      = 'status-dot running';
      stText.textContent = t('status_running');
      pulse.classList.add('on');
      setPauseBtn(btnPause, 'pause');
    } else {
      dot.className      = 'status-dot paused';
      stText.textContent = t('status_paused');
      pulse.classList.remove('on');
      setPauseBtn(btnPause, 'resume');
    }
    renderProgress(state);
  }
}

// Arka uçtan gelen durum yayınında niyeti düşür: istenen duruma geçilmişse (ya da emniyet
// süresi dolmuşsa) artık ekran gerçeği göstersin. YALNIZ yayın dinleyicisinden çağrılır.
function clearPauseIntent(state) {
  if (!pauseIntent) return;
  if ((state && state.status === pauseIntent.status) || Date.now() > pauseIntent.until) pauseIntent = null;
}

// Duraklat/Devam butonunun içeriğini YALNIZCA gerçekten değiştiğinde günceller ve
// TIKLANABİLİR DÜĞÜMLERİ ASLA KOPARMAZ.
// KÖK NEDEN (tek tıkla çalışmama): koşu sırasında arka uç saniyede birkaç kez durum
// yayınlıyor → renderDynamic her yayında butonun innerHTML'ini yeniliyordu. Kullanıcının
// mousedown'ı ile mouseup'ı ARASINA denk gelen bir yenilemede, mousedown'ın hedefi (ikon
// ya da <span>) DOM'dan koptuğu için tarayıcı 'click' olayını HİÇ üretmiyor; kullanıcı da
// "bir kez basınca olmuyor, iki kez basmak gerekiyor" diyordu. Artık iki ikon da BİR KEZ
// kurulur; mod değişiminde yalnız görünürlük (style.display) ve etiket METNİ değişir →
// düğümler yerinde kalır, tık hiçbir koşulda düşmez. Görsel sonuç birebir aynı (gizli ikon
// flex öğesi olmadığı için gap de değişmez).
function setPauseBtn(btn, mode) {
  if (!btn) return;
  if (btn.dataset.pbuilt !== '1') {           // tek seferlik kurulum (ikon + ikon + etiket)
    btn.innerHTML = svgPause() + svgPlay() + '<span></span>';
    btn.dataset.pbuilt = '1';
    btn.dataset.pmode  = '';
  }
  const key = mode + ':' + currentLang;
  if (btn.dataset.pmode === key) return;
  btn.dataset.pmode = key;
  btn.className     = mode === 'pause' ? 'btn-pause' : 'btn-pause resume';
  const svgs = btn.getElementsByTagName('svg');
  const lab  = btn.getElementsByTagName('span')[0];
  if (svgs[0]) svgs[0].style.display = mode === 'pause' ? '' : 'none';
  if (svgs[1]) svgs[1].style.display = mode === 'pause' ? 'none' : '';
  if (lab) lab.textContent = mode === 'pause' ? t('btn_pause') : t('btn_resume');
}

function renderProgress(state) {
  if (!state?.prompts) return;
  const total = state.prompts.length, done = state.currentIndex;
  const pct   = total > 0 ? (done / total) * 100 : 0;
  document.getElementById('prog-frac').textContent    = `${done} / ${total}`;
  document.getElementById('prog-fill').style.width    = pct + '%';
  document.getElementById('prog-current').textContent =
    state.currentPrompt ? `→ ${state.currentPrompt}` : '';
  document.getElementById('prog-eta').textContent =
    (state.status === 'running' && total > done)
      ? `${t('eta_prefix')}${fmtSecs((total - done) * state.interval)}`
      : '';
}

// ── Notifications ──────────────────────────────────────
let notifTimer = null;
function showNotif(msg, type = 'info') {
  const w = document.getElementById('notif-wrap');
  w.innerHTML = `<div class="notif ${type}">${msg}</div>`;
  clearTimeout(notifTimer);
  notifTimer = setTimeout(() => { w.innerHTML = ''; }, 5000);
}

// ════════════════════════════════════════════════════════
// REFERANS SİSTEMİ — Shared / Map per Prompt / Library / Auto-Tag
// ════════════════════════════════════════════════════════
function escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function uid() { return 'l' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

// Bir koleksiyon içinde benzersiz dosya adı (arka uç adla seçtiği için şart)
// ── v159 DOSYA SEÇİCİ TUZAĞI (mobil + MIME kaydı eksik Windows) ───────────────
// 1.2.27 döneminde dosya seçicilerin accept listesine uzantılar AÇIKÇA eklendi
// ("image/*" tek başına, Windows MIME kaydı eksikse boş liste veriyordu). Ama koddaki
// süzgeç ESKİ kaldı: yalnızca file.type'a bakıp "image/" ile başlamayan her dosyayı
// SESSİZCE atıyordu. Android dosya yöneticisi (ve bazı .heic/.tiff sağlayıcıları)
// dosyayı BOŞ ya da genel MIME tipiyle verdiği için telefonda seçilen görseller
// kütüphaneye HİÇ eklenmiyor, hata da görünmüyordu. Auto-Tag yalnız kütüphanedeki
// tag'li görselleri aradığından "Auto-Tag çalışmıyor" raporunun kökü buydu.
// ÇÖZÜM: accept listesiyle AYNI uzantılar kodda da kabul edilir ve MIME tipi boşsa
// uzantıdan türetilir (yükleme dosyayı bu tiple oluşturuyor). Gerçek image/* dosyaları
// ilk koşuldan zaten geçtiği için masaüstü davranışı BİREBİR aynı kalır.
const AF_IMG_EXT = /\.(jpe?g|jpe|jfif|png|webp|gif|bmp|avif|heic|heif|tiff?)$/i;
function isImageFile(f) {
  return /^image\//.test((f && f.type) || '') || AF_IMG_EXT.test((f && f.name) || '');
}
function mimeOfFile(f) {
  const t = (f && f.type) || '';
  if (/^image\//.test(t)) return t;                     // tarayıcı zaten doğru söylemiş
  const e = ((((f && f.name) || '').match(/\.([a-z0-9]+)$/i) || [])[1] || '').toLowerCase();
  const alt = { jpg: 'jpeg', jpeg: 'jpeg', jpe: 'jpeg', jfif: 'jpeg', png: 'png', webp: 'webp',
                gif: 'gif', bmp: 'bmp', avif: 'avif', heic: 'heic', heif: 'heif',
                tif: 'tiff', tiff: 'tiff' }[e];
  return alt ? ('image/' + alt) : t;
}

function ensureUniqueName(name, takenSet) {
  let n = name || 'image.png';
  if (!takenSet.has(n)) return n;
  const dot = n.lastIndexOf('.');
  const stem = dot > 0 ? n.slice(0, dot) : n;
  const ext  = dot > 0 ? n.slice(dot)    : '';
  let i = 2;
  while (takenSet.has(`${stem} (${i})${ext}`)) i++;
  return `${stem} (${i})${ext}`;
}

// ── Kalıcılık (IndexedDB) ───────────────────────────────
// Referans görselleri (büyük dataURL'ler) IndexedDB'de saklanır. ÖNCEDEN chrome.storage.local
// kullanılıyordu; ama tam çözünürlüklü görseller depolama kotasını aşınca `set()` SESSİZCE
// başarısız oluyordu (hata lastError'a düşüyor, eski try/catch yakalamıyordu) → eklenti
// kapanınca kütüphane "kayboluyordu". IndexedDB büyük ikili veri için tasarlandı,
// unlimitedStorage ile pratikte sınırsız ve bu kota sorununa hiç takılmaz. Küçük durum
// (mod + prompt eşlemesi) yine storage.local'de kalır.
const IDB_NAME = 'autoflow-refs', IDB_STORE = 'kv';
function idbOpen() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(IDB_NAME, 1);
    r.onupgradeneeded = () => { const db = r.result; if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE); };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
function idbSet(key, val) {
  return idbOpen().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).put(val, key);
    tx.oncomplete = () => { db.close(); resolve(true); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  }));
}
function idbGet(key) {
  return idbOpen().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readonly');
    const rq = tx.objectStore(IDB_STORE).get(key);
    rq.onsuccess = () => { db.close(); resolve(rq.result); };
    rq.onerror = () => { db.close(); reject(rq.error); };
  }));
}

let _saveTimer = null;
function saveRefState() {
  // GUARD: boot referansları YÜKLEMEDEN yazma → yoksa init sırasındaki boş library IDB'deki
  // gerçek veriyi siler (kütüphane kaybolması kök nedeni).
  if (!refStateLoaded) {
    console.log('[AutoFlow][LIB] save atlandı (boot henüz yüklemedi) — gerçek veri korunuyor');
    return;
  }
  // Küçük durum → storage.local (hızlı, küçük).
  try { chrome.storage.local.set({ afRefMode: refMode, afPromptMap: promptMap }); } catch (_) {}
  // Büyük görseller → IndexedDB (kotaya takılmaz → kütüphane KALICI olur).
  console.log('[AutoFlow][LIB] kaydediliyor → library:', library.length, '| shared:', sharedRefs.length);
  idbSet('afLibrary', library).then(() => {
    console.log('[AutoFlow][LIB] kayıt OK (IndexedDB) → library:', library.length);
  }).catch(e => {
    console.warn('[AutoFlow][LIB] IndexedDB kütüphane kaydı BAŞARISIZ:', e && e.message);
    showNotif(currentLang === 'tr' ? 'Kütüphane kaydedilemedi.' : 'Could not save library.', 'error');
  });
  idbSet('afSharedRefs', sharedRefs).catch(e =>
    console.warn('[AutoFlow][LIB] IndexedDB shared ref kaydı başarısız:', e && e.message));
}
function scheduleSaveRefState() {
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(saveRefState, 400);
}

// ── Mod (Shared / Map) ─────────────────────────────────
function setRefMode(mode) {
  refMode = (mode === 'map') ? 'map' : 'shared';
  document.querySelectorAll('#ref-mode-group .seg-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.refmode === refMode));
  const sp = document.getElementById('ref-shared-panel');
  const mp = document.getElementById('ref-map-panel');
  if (sp) sp.style.display = refMode === 'shared' ? 'block' : 'none';
  if (mp) mp.style.display = refMode === 'map' ? 'block' : 'none';
  updateRefMeta();
  updateMapSummary();
  saveRefState();
}

function updateRefMeta() {
  const meta = document.getElementById('ref-meta');
  if (!meta) return;
  meta.textContent = refMode === 'shared'
    ? `${sharedRefs.length}/${MAX_SHARED}`
    : t('ref_mode_map');
}

// ── Shared referans grid ───────────────────────────────
function renderSharedRefs() {
  const grid = document.getElementById('shared-ref-grid');
  if (!grid) return;
  grid.innerHTML = '';
  sharedRefs.forEach((ref, i) => {
    const slot = document.createElement('div');
    slot.className = 'ref-slot has-img';
    slot.innerHTML =
      `<img class="ref-preview" src="${ref.dataUrl}" alt="" style="display:block">
       <button class="ref-rm" title="${escHtml(t('remove'))}">
         <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
       </button>`;
    slot.querySelector('.ref-rm').addEventListener('click', e => {
      e.stopPropagation();
      sharedRefs.splice(i, 1);
      renderSharedRefs(); saveRefState();
    });
    grid.appendChild(slot);
  });
  if (sharedRefs.length < MAX_SHARED) {
    const add = document.createElement('div');
    add.className = 'ref-slot';
    add.innerHTML =
      `<div class="ref-ph">
         <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21,15 16,10 5,21"/></svg>
         <span>${escHtml(t('add_image'))}</span>
       </div>`;
    add.addEventListener('click', pickSharedFiles);
    grid.appendChild(add);
  }
  updateRefMeta();
}

function pickSharedFiles() {
  const inp = document.createElement('input');
  inp.type = 'file'; inp.accept = 'image/*,.jpg,.jpeg,.jpe,.jfif,.png,.webp,.gif,.bmp,.avif,.heic,.heif,.tif,.tiff'; inp.multiple = true;   // uzantılar açıkça: Windows MIME kaydı eksikse image/* boş liste veriyor
  inp.addEventListener('change', e => {
    const files = [...e.target.files];
    const room = MAX_SHARED - sharedRefs.length;
    files.slice(0, room).forEach(file => {
      const reader = new FileReader();
      reader.onload = ev => {
        const taken = new Set(sharedRefs.map(r => r.name));
        sharedRefs.push({
          name: ensureUniqueName(file.name, taken),
          dataUrl: ev.target.result, type: mimeOfFile(file)   // v159: boş MIME yüklemeyi bozuyordu
        });
        renderSharedRefs(); saveRefState();
      };
      reader.readAsDataURL(file);
    });
    if (files.length > room) showNotif(t('ref_max_reached').replace('{n}', MAX_SHARED), 'info');
  });
  inp.click();
}

// ── Library ────────────────────────────────────────────
function renderLibrary() {
  const grid = document.getElementById('lib-grid');
  if (!grid) return;
  grid.innerHTML = '';
  library.forEach(img => {
    const cell = document.createElement('div');
    cell.className = 'lib-cell';
    cell.innerHTML =
      `<div class="lib-thumb">
         <img src="${img.dataUrl}" alt="">
         <button class="lib-rm" title="${escHtml(t('remove'))}">
           <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
         </button>
       </div>
       <input class="lib-tag" type="text" placeholder="${escHtml(t('lib_tag_ph'))}" value="${escHtml(img.tag || '')}">`;
    const tagInp = cell.querySelector('.lib-tag');
    tagInp.addEventListener('input', () => { img.tag = tagInp.value; scheduleSaveRefState(); });
    // Odak çıkınca tag'i normalize et: başına otomatik @ ekle
    tagInp.addEventListener('blur', () => {
      const v = normalizeTag(tagInp.value);
      tagInp.value = v; img.tag = v; saveRefState();
    });
    cell.querySelector('.lib-rm').addEventListener('click', () => {
      library = library.filter(x => x.id !== img.id);
      Object.keys(promptMap).forEach(k => {
        promptMap[k] = (promptMap[k] || []).filter(id => id !== img.id);
      });
      // v115: Foto→Video kendi deposunu (i2vLib) kullanır — Library silme onu etkilemez
      renderLibrary(); saveRefState(); updateMapSummary();
    });
    grid.appendChild(cell);
  });
  const add = document.createElement('div');
  add.className = 'lib-cell lib-add';
  add.innerHTML =
    `<div class="lib-thumb add">
       <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
     </div>`;
  add.addEventListener('click', () => document.getElementById('lib-file-input').click());
  grid.appendChild(add);
  // "Tümünü temizle" butonu yalnız görsel varken görünür
  const clearBtn = document.getElementById('btn-lib-clear');
  if (clearBtn) clearBtn.style.display = library.length ? 'inline-flex' : 'none';
}

// Library'deki TÜM görselleri tek tuşla temizle. Bu görsellere işaret eden Map eşlemesi de
// temizlenir (kırık referans kalmasın). shared referanslar ve Foto→Video deposu (v115'ten
// beri ayrı kümeler) etkilenmez. Onay ister (geri alınamaz).
function clearLibrary() {
  if (!library.length) { showNotif(t('lib_empty'), 'info'); return; }
  if (!confirm(t('lib_clear_confirm').replace('{n}', library.length))) return;
  library = [];
  promptMap = {};                 // tüm eşlemeler bu görsellere işaret ediyordu → boşalt
  renderLibrary(); saveRefState(); updateMapSummary();
  showNotif(t('lib_cleared'), 'success');
}

function addLibraryFiles(fileList) {
  const files = [...fileList];
  let atlanan = 0;   // v159: sessizce atmak yerine say ve söyle
  files.forEach(file => {
    if (!isImageFile(file)) { atlanan++; return; }
    const reader = new FileReader();
    reader.onload = ev => {
      // Aynı görsel zaten varsa (birebir veri) tekrar ekleme — çift yüklemeyi önler
      if (library.some(x => x.dataUrl === ev.target.result)) {
        showNotif(t('lib_dup_skipped'), 'info');
        return;
      }
      const taken = new Set(library.map(x => x.name));
      library.push({
        id: uid(),
        name: ensureUniqueName(file.name, taken),
        dataUrl: ev.target.result,
        type: mimeOfFile(file),
        tag: ''
      });
      renderLibrary(); saveRefState();
    };
    reader.readAsDataURL(file);
  });
  if (atlanan) showNotif(t('lib_skipped_files').replace('{n}', atlanan), 'info');
}

// ── Prompt yardımcıları ────────────────────────────────
// v151: zaman damgasi kurallari arka uctaki AF_TS_RE ile AYNI (saniye iki haneli sart ->
// "16:9 sinematik plan" gibi prompt basi oran ifadeleri damga sanilmaz). Damga YALNIZCA
// dosya adi icin okunur; prompt metni Flow'a HER ZAMAN yazildigi gibi gonderilir.
// v164: kesirli kisim (SRT'nin virgulden sonrasi) dorduncu grupta.
const TS_RE = /^\s*[([{]?\s*(\d{1,3}):([0-5]\d)(?::([0-5]\d))?(?:[.,](\d{1,3})(?!\d))?\s*[)\]}]?/;

function tsLabelOf(p) {
  const m = TS_RE.exec(String(p == null ? '' : p));
  if (!m) return '';
  const pad = n => String(n).padStart(2, '0');
  const base = m[3] ? (pad(m[1]) + '-' + pad(m[2]) + '-' + pad(m[3])) : (pad(m[1]) + '-' + pad(m[2]));
  return m[4] ? base + '.' + (m[4] + '00').slice(0, 3) : base;
}

// Prompt kutusu TEK kutudur, kullanici hicbir mod secmez. Bicimi burada anliyoruz:
//   - Metinde bos satirla ayrilmis BIRDEN COK blok varsa VE bu bloklardan en az biri COK
//     SATIRLIYSA -> her blok tek prompt (paragraf yapistirma; cok satirli prompt yazilabilir).
//   - Diger her durumda -> her satir bir prompt (ESKI DAVRANIS, birebir ayni cikti).
// Tek satirlik promptlarin arasina bos satir konmasi iki kuralda da AYNI sonucu verir, yani
// eskiden calisan hicbir giris bicimi degismez.
function parsePromptText(raw) {
  const s = String(raw == null ? '' : raw);
  const blocks = s.split(/\n[ \t]*\n+/).map(b => b.trim()).filter(Boolean);
  const cokSatirli = blocks.some(b => b.split('\n').filter(l => l.trim()).length > 1);
  if (blocks.length > 1 && cokSatirli) return { prompts: blocks, para: true };
  return { prompts: s.split('\n').map(p => p.trim()).filter(Boolean), para: false };
}

function getPrompts() {
  return parsePromptText((document.getElementById('prompt-input') || {}).value || '').prompts;
}

// "Zaman damgali" adlandirma icin damgasi OLMAYAN promptlarin 1-tabanli sira numaralari.
function missingTsIdx(prompts) {
  const out = [];
  (prompts || []).forEach((p, i) => {
    if (!TS_RE.test(String(p == null ? '' : p))) out.push(i + 1);
  });
  return out;
}

// Tag eşleşmesi: alfanümerik tag'lerde kelime sınırı; özel karakterli (@hero) tag'lerde
// sınır kontrolü yine çalışır çünkü sınır deseni harf/rakam dışını kabul eder.
function promptHasTag(promptLower, tag) {
  tag = (tag || '').toLowerCase().trim();
  if (!tag) return false;
  const esc = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  try {
    return new RegExp('(^|[^\\p{L}\\p{N}])' + esc + '([^\\p{L}\\p{N}]|$)', 'u').test(promptLower);
  } catch (_) {
    return promptLower.includes(tag);
  }
}

function updateMapSummary() {
  const el = document.getElementById('map-summary');
  if (!el) return;
  const prompts = getPrompts();
  const mapped = prompts.filter((_, i) => (promptMap[i] || []).length > 0).length;
  el.textContent = t('map_summary')
    .replace('{m}', mapped).replace('{n}', prompts.length);
}

// ── Map per Prompt modalı ──────────────────────────────
let mapWorking = {};   // modal açıkken üzerinde çalışılan kopya
let libPickRow = null; // o an Library seçici açık olan satır indeksi

function openMapModal() {
  mapWorking = {};
  Object.keys(promptMap).forEach(k => { mapWorking[k] = (promptMap[k] || []).slice(); });
  renderMapRows();
  document.getElementById('map-overlay').style.display = 'flex';
}
function closeMapModal() {
  document.getElementById('map-overlay').style.display = 'none';
  document.getElementById('libpick-overlay').style.display = 'none';
}

function updateMapCount() {
  const el = document.getElementById('map-count');
  if (!el) return;
  const prompts = getPrompts();
  const mapped = prompts.filter((_, i) => (mapWorking[i] || []).length > 0).length;
  el.textContent = t('map_summary').replace('{m}', mapped).replace('{n}', prompts.length);
}

function renderMapRows() {
  const prompts = getPrompts();
  const wrap = document.getElementById('map-rows');
  if (!wrap) return;
  wrap.innerHTML = '';
  if (!prompts.length) {
    wrap.innerHTML = `<div class="map-empty">${escHtml(t('map_no_prompts'))}</div>`;
    updateMapCount();
    return;
  }
  prompts.forEach((p, i) => {
    const ids = mapWorking[i] || [];
    const row = document.createElement('div');
    row.className = 'map-row';
    const badges = ids.map(id => {
      const img = library.find(x => x.id === id);
      if (!img) return '';
      return `<span class="map-badge"><img src="${img.dataUrl}"><span>${escHtml(img.tag || img.name)}</span><button class="map-badge-rm" data-id="${id}">×</button></span>`;
    }).join('');
    row.innerHTML =
      `<div class="map-row-head"><span class="map-num">#${String(i + 1).padStart(3, '0')}</span><span class="map-prompt">${escHtml(p)}</span></div>
       <div class="map-refs">${badges}<button class="map-add" title="${escHtml(t('map_add_ref'))}">+</button></div>`;
    row.querySelector('.map-add').addEventListener('click', () => openLibPicker(i));
    row.querySelectorAll('.map-badge-rm').forEach(b => b.addEventListener('click', () => {
      mapWorking[i] = (mapWorking[i] || []).filter(id => id !== b.dataset.id);
      renderMapRows();
    }));
    wrap.appendChild(row);
  });
  updateMapCount();
}

function openLibPicker(i) {
  libPickRow = i;
  const grid = document.getElementById('libpick-grid');
  grid.innerHTML = '';
  if (!library.length) {
    grid.innerHTML = `<div class="map-empty">${escHtml(t('libpick_empty'))}</div>`;
  }
  library.forEach(img => {
    const sel = (mapWorking[i] || []).includes(img.id);
    const cell = document.createElement('div');
    cell.className = 'libpick-cell' + (sel ? ' selected' : '');
    cell.innerHTML = `<img src="${img.dataUrl}"><span>${escHtml(img.tag || img.name)}</span>`;
    cell.addEventListener('click', () => {
      const arr = mapWorking[i] = mapWorking[i] || [];
      const k = arr.indexOf(img.id);
      if (k >= 0) arr.splice(k, 1); else arr.push(img.id);
      openLibPicker(i);   // seçim vurgusunu tazele
      renderMapRows();    // alttaki rozetleri tazele
    });
    grid.appendChild(cell);
  });
  document.getElementById('libpick-overlay').style.display = 'flex';
}

function autoTagMap() {
  const prompts = getPrompts();
  let added = 0;
  prompts.forEach((p, i) => {
    const lower = p.toLowerCase();
    const arr = mapWorking[i] = mapWorking[i] || [];
    library.forEach(img => {
      if (!(img.tag || '').trim()) return;
      if (promptHasTag(lower, img.tag) && !arr.includes(img.id)) { arr.push(img.id); added++; }
    });
  });
  renderMapRows();
  if (added) { showNotif(t('map_autotag_done').replace('{n}', added), 'success'); return; }
  // v158: "Auto-Tag calismiyor" raporlarinin cogu SEBEP GORUNMEDIGI icin geliyor
  // (kullanici raporu 2026-09-08). Eskiden hicbir sey atanmayinca yalnizca
  // "0 referans atandi" yaziyordu; artik NEDEN atanmadigi soylenir. ESLESTIRME
  // MANTIGI DEGISMEDI, yalnizca added === 0 durumundaki bildirim metni.
  const tagli = library.filter(img => (img.tag || '').trim()).length;
  if (!prompts.length)      showNotif(t('map_no_prompts'), 'info');
  else if (!library.length) showNotif(t('map_autotag_no_lib'), 'info');
  else if (!tagli)          showNotif(t('map_autotag_no_tags'), 'info');
  else                      showNotif(t('map_autotag_no_match').replace('{n}', tagli), 'info');
}

function clearMap() {
  mapWorking = {};
  renderMapRows();
}

function saveMap() {
  promptMap = {};
  Object.keys(mapWorking).forEach(k => {
    if ((mapWorking[k] || []).length) promptMap[k] = mapWorking[k].slice();
  });
  saveRefState();
  updateMapSummary();
  closeMapModal();
  showNotif(t('map_saved'), 'success');
}

// ── Görselden Video (I2V) ──────────────────────────────
// Her görsele bir video: görseller Library'ye (IDB) eklenir; burada yalnız SIRA + META
// tutulur (libId, ad, dosya tarihi). "Kuyruğu Hazırla" mevcut KANITLI mekanizmaları kurar:
// ana prompt kutusu + map modu (prompt başına 1 görsel) + VIDEO modu (+ istenirse düşük
// öncelikli model). Yeni otomasyon yolu YOK → arka uç (background) riski yok; Başlat'tan
// sonrası birebir normal map-modu video akışıdır.
let i2vItems = []; // [{ libId, name, fileDate, addedAt }]
// v115: Foto→Video görselleri artık ORTAK Library'de DEĞİL, kendi deposunda tutulur
// (i2vLib, IDB 'afI2vLib'). Böylece bu sekmeye yüklenen görseller Control (Text→Image)
// sekmesinin referans/Library alanına karışmaz; iki sekme tamamen bağımsız çalışır.
let i2vLib = []; // [{ id, name, dataUrl, type }]
let i2vSort  = 'added';
// Sıralama listesi 20'ŞERLİ SAYFALAR halinde gösterilir (100+ görselde aşağı sonsuz inmesin).
// Arka uçtaki yükleme partisi de 20 (REF_BATCH) → aynı mantıksal grup.
const I2V_PAGE_SIZE = 20;
let i2vPage = 0; // 0-tabanlı aktif sayfa
// Model/süre/adet bu sekmede seçilir, "Kuyruğu Hazırla" ana üretim ayarlarına uygular.
// Varsayılan model = düşük öncelikli (eski checkbox'ın işaretli varsayılanı korunur).
let i2vModel    = (GEN_OPTIONS.VIDEO.models.find(m => /lower priority/i.test(m.name)) || GEN_OPTIONS.VIDEO.models[0]).name;
let i2vDuration = (GEN_OPTIONS.VIDEO.durations.find(d => d.selected) || { sec: 8 }).sec;
// Flow 2026-09: video çözünürlüğü (360p ucuz önizleme / 720p daha çok kredi)
let i2vResolution = (GEN_OPTIONS.VIDEO.resolutions.find(r => r.selected) || { p: '360p' }).p;
let i2vCount    = (GEN_OPTIONS.VIDEO.counts.find(c => c.selected) || { n: 1 }).n;
// v117: ORAN artık bu sekmede de seçilir (önceden Başlat'ta sabit 'LANDSCAPE' gönderiliyordu →
// Foto→Video hep yatay çıkıyordu). Varsayılan yine 16:9 → eski davranış birebir korunur.
let i2vAspect   = (GEN_OPTIONS.VIDEO.aspects.find(a => a.selected) || { code: 'LANDSCAPE' }).code;
// v119: GÖRSEL KULLANIMI — Flow'un video kompozisyonundaki iki ayrı yol.
//   'ingredients' → Malzemeler: görsel prompt'a REFERANS olarak eklenir. v115'ten beri
//                   çalışan, canlı Flow'da kanıtlı yol → VARSAYILAN budur (mevcut
//                   kullanıcıların çıktısı güncellemeyle sessizce değişmesin).
//   'frames'      → Kareler: görsel videonun başlangıç (ve isteğe bağlı bitiş) KARESİ olur.
let i2vUse  = 'ingredients';
// Kareler modunda görsellerin videolara nasıl dağıtılacağı (i2vPairsFor'a bak).
let i2vPair = 'start';

function saveI2vState() {
  try {
    const ta = document.getElementById('i2v-prompts');
    chrome.storage.local.set({
      afI2vItems: i2vItems, afI2vSort: i2vSort,
      afI2vPrompts: (ta && ta.value) || '',
      afI2vModel: i2vModel, afI2vDuration: i2vDuration, afI2vCount: i2vCount,
      afI2vAspect: i2vAspect, afI2vResolution: i2vResolution, afI2vUse: i2vUse, afI2vPair: i2vPair
    });
  } catch (_) {}
}

// Foto→Video görselleri (büyük dataUrl'ler) → IndexedDB. saveRefState ile aynı boot
// guard'ı: veriler yüklenmeden yazma olmaz → init sırasındaki boş liste gerçek veriyi ezemez.
function saveI2vLib() {
  if (!refStateLoaded) return;
  idbSet('afI2vLib', i2vLib).catch(e =>
    console.warn('[AutoFlow][I2V] IndexedDB i2vLib kaydı başarısız:', e && e.message));
}

// ── v115 TEK SEFERLİK GEÇİŞ (boot'tan çağrılır) ────────
// Eski sürüm i2v görsellerini ortak Library'de tutuyor ve Başlat/Hazırla, Control'ün
// promptMap'ine 1:1 eşleme yazıyordu. Geçiş: (1) i2v'nin işaret ettiği Library görselleri
// i2vLib'e KOPYALANIR (aynı id → sıra ve kayıtlar bozulmaz); (2) makine yazımı 1:1
// promptMap deseni temizlenir (Map modalındaki "kendiliğinden eşleşme" kalıntısı gider);
// (3) yalnız i2v için yüklenmiş (promptMap'te kullanılmayan) görseller Library'den
// çıkarılır. Kullanıcının elle kurduğu eşlemeler ve Library'ye bilerek eklediği görseller
// AYNEN kalır. Globalleri (i2vLib, i2vItems, library, promptMap) günceller.
function migrateI2vSeparation(rawItemsIn) {
  const rawItems = (rawItemsIn || []).filter(it => it && it.libId);
  const haveIds = new Set(i2vLib.map(e => e.id));
  let migrated = 0;
  rawItems.forEach(it => {
    if (haveIds.has(it.libId)) return;
    const src = library.find(x => x.id === it.libId);
    if (src) {
      i2vLib.push({ id: src.id, name: src.name, dataUrl: src.dataUrl, type: src.type });
      haveIds.add(src.id);
      migrated++;
    }
  });
  i2vItems = rawItems.filter(it => haveIds.has(it.libId));
  let clearedAutoMap = false;
  if (migrated) {
    const i2vIds = new Set(i2vItems.map(it => it.libId));
    const mapKeys = Object.keys(promptMap);
    clearedAutoMap = mapKeys.length > 0 && mapKeys.every(k => {
      const arr = promptMap[k];
      return Array.isArray(arr) && arr.length === 1 && i2vIds.has(arr[0]);
    });
    if (clearedAutoMap) promptMap = {};
    const usedInMap = new Set();
    Object.values(promptMap).forEach(a => (a || []).forEach(id => usedInMap.add(id)));
    library = library.filter(x => !(i2vIds.has(x.id) && !usedInMap.has(x.id)));
  }
  return { migrated, clearedAutoMap };
}

// Sekmedeki MODEL / SÜRE / ADET kontrollerini mevcut i2v değerlerinden (yeniden) çizer.
// Boot'ta storage'dan yüklenen değerler de bununla ekrana yansır.
function renderI2vGenControls() {
  const msel = document.getElementById('i2v-model');
  if (msel) {
    msel.innerHTML = '';
    GEN_OPTIONS.VIDEO.models.forEach(m => {
      const o = document.createElement('option');
      o.value = m.name; o.textContent = m.name;
      if (m.name === i2vModel) o.selected = true;
      msel.appendChild(o);
    });
    if (![...msel.options].some(o => o.value === i2vModel)) i2vModel = msel.value;
  }
  renderSegGroup('i2v-aspect-group',
    GEN_OPTIONS.VIDEO.aspects.map(a => ({ label: a.label || a.code, value: a.code, selected: a.code === i2vAspect })),
    v => { i2vAspect = v; });
  renderI2vResolutionGroup();
  renderI2vDurationGroup();
  renderSegGroup('i2v-count-group',
    GEN_OPTIONS.VIDEO.counts.map(c => ({ label: 'x' + c.n, value: c.n, selected: c.n === i2vCount })),
    v => { i2vCount = v; });
}

// Çözünürlük grubu SEÇİLİ i2v MODELİNE göre çizilir (360p/720p yalnız Omni 1.1 Flash).
// Model desteklemiyorsa grup BOŞALTILIR ve i2vResolution null olur → payload'a hiç girmez,
// Flow'daki mevcut seçime dokunulmaz.
function renderI2vResolutionGroup() {
  const field = document.getElementById('i2v-resolution-field');
  const list = resolutionsForModel(GEN_OPTIONS.VIDEO.resolutions, i2vModel);
  const prev = i2vResolution;
  i2vResolution = null;
  if (!list.length) {
    const g = document.getElementById('i2v-resolution-group');
    if (g) g.innerHTML = '';
    if (field) field.style.display = 'none';
    return;
  }
  if (field) field.style.display = 'flex';
  const want = list.some(r => r.p === prev) ? prev : (list.find(r => r.selected) || list[0]).p;
  renderSegGroup('i2v-resolution-group',
    list.map(r => ({ label: r.p, value: r.p, selected: r.p === want })),
    v => { i2vResolution = v; });
}

// Süre grubu SEÇİLİ i2v MODELİNE göre çizilir: 10s Flow'da yalnız Omni Flash'ta var.
// Mevcut seçim yeni modelde de geçerliyse korunur, değilse varsayılana (8s) düşer.
function renderI2vDurationGroup() {
  const list = durationsForModel(GEN_OPTIONS.VIDEO.durations, i2vModel);
  if (!list.length) return;
  const want = list.some(d => d.sec === i2vDuration) ? i2vDuration : (list.find(d => d.selected) || list[0]).sec;
  renderSegGroup('i2v-duration-group',
    list.map(d => ({ label: d.sec + 's', value: d.sec, selected: d.sec === want })),
    v => { i2vDuration = v; });
}

function i2vOrdered() {
  const arr = i2vItems.slice();
  const byName = (a, b) => (a.name || '').localeCompare(b.name || '', undefined, { numeric: true, sensitivity: 'base' });
  if (i2vSort === 'name-asc')  arr.sort(byName);
  if (i2vSort === 'name-desc') arr.sort((a, b) => byName(b, a));
  if (i2vSort === 'date-asc')  arr.sort((a, b) => (a.fileDate || 0) - (b.fileDate || 0));
  if (i2vSort === 'date-desc') arr.sort((a, b) => (b.fileDate || 0) - (a.fileDate || 0));
  return arr; // 'added' = ekleme sırası (dizi sırası)
}

function i2vPromptList() {
  const ta = document.getElementById('i2v-prompts');
  return ((ta && ta.value) || '').split('\n').map(s => s.trim()).filter(Boolean);
}

// Flow'un video kompozisyonundaki sekme ikonlarının eşi (köşe çerçevesi = Kareler,
// bilet = Malzemeler). Kullanıcı Flow'da hangi ikonu görüyorsa panelde de aynısını görür.
const ICON_FRAMES =
  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
  'stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M4 8.5V5.5A1.5 1.5 0 0 1 5.5 4h3"/><path d="M15.5 4h3A1.5 1.5 0 0 1 20 5.5v3"/>' +
  '<path d="M20 15.5v3a1.5 1.5 0 0 1-1.5 1.5h-3"/><path d="M8.5 20h-3A1.5 1.5 0 0 1 4 18.5v-3"/></svg>';
const ICON_INGREDIENTS =
  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
  'stroke-width="2" stroke-linejoin="round">' +
  '<path d="M3 8.6V6.5A1.5 1.5 0 0 1 4.5 5h15A1.5 1.5 0 0 1 21 6.5v2.1a3.4 3.4 0 0 0 0 6.8v2.1' +
  'a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5v-2.1a3.4 3.4 0 0 0 0-6.8z"/></svg>';

// ── v119: KARE EŞLEMESİ (saf fonksiyon, test edilebilir) ───────────────────
// Sıralı görsel listesinden üretilecek videoların [başlangıç, bitiş] çiftlerini kurar.
// Dönen dizinin UZUNLUĞU = gereken prompt satırı sayısı.
//   'start' : her görsel bir videonun başlangıç karesi   → N görsel = N video
//   'chain' : (1,2) (2,3) (3,4) … bir videonun bitişi bir sonrakinin başlangıcı;
//             sahneler kesintisiz akar                    → N görsel = N-1 video
//   'pairs' : (1,2) (3,4) (5,6) … her video kendi başlangıç+bitişiyle bağımsız;
//             tek sayıda görselde SON görsel kullanılmaz  → N görsel = ⌊N/2⌋ video
// Malzemeler (ingredients) modunda çift kurulmaz; her görsel tek başına 'start' gibi davranır.
function i2vPairsFor(list, pair) {
  const out = [];
  const arr = Array.isArray(list) ? list : [];
  if (pair === 'chain')      { for (let i = 0; i + 1 < arr.length; i++)     out.push([arr[i], arr[i + 1]]); }
  else if (pair === 'pairs') { for (let i = 0; i + 1 < arr.length; i += 2)  out.push([arr[i], arr[i + 1]]); }
  else                       { for (let i = 0; i < arr.length; i++)         out.push([arr[i], null]); }
  return out;
}
// Seçili moda göre kaç video (= kaç prompt satırı) beklendiği.
function i2vExpectedCount() {
  return i2vUse === 'frames' ? i2vPairsFor(i2vOrdered(), i2vPair).length : i2vItems.length;
}
// Modun ingredients/start gibi BİRE BİR olup olmadığı (mesaj metinleri buna göre seçilir).
function i2vIsOneToOne() { return i2vUse !== 'frames' || i2vPair === 'start'; }

function updateI2vMeta() {
  const el = document.getElementById('i2v-meta');
  renderI2vPairNote();                       // görsel sayısı değiştikçe not satırı da tazelenir
  renderI2vFixHint();                        // sayaç kırmızıysa "ne yapmalıyım" kutusu da
  if (!el) return;
  const i = i2vItems.length, p = i2vPromptList().length;
  const exp = i2vExpectedCount();            // beklenen prompt sayısı moda göre değişir
  el.textContent = t('i2v_meta').replace('{i}', i).replace('{p}', p);
  el.classList.toggle('i2v-mismatch', i > 0 && p > 0 && exp !== p);
}

// ── SAYILAR TUTMUYORSA: NE YAPACAĞINI ADIM ADIM SÖYLE ─────────────────────
// Kuralı (bu modda kaç prompt olmalı) ve düzeltmeyi (kaç satır silinecek / yazılacak)
// SAYIYLA verir. "Kuyruğu Kontrol Et"e basmayı beklemez; sayaç kırmızıya döner dönmez
// aynı anda görünür. Sayılar tuttuğunda boş string döner → kutu gizlenir.
function i2vFixHtml() {
  const n = i2vItems.length;
  const p = i2vPromptList().length;
  const v = i2vExpectedCount();
  if (!n || !p || v === p) return '';        // her şey yolunda (sayaç da kırmızı değil)
  if (!v) return t('i2v_need_two');          // zincir/çiftler tek görselle video kuramaz
  const rule = t(i2vUse === 'frames' ? ('i2v_rule_' + i2vPair) : 'i2v_rule_ingredients')
                 .replace(/\{n\}/g, n).replace(/\{v\}/g, v);
  const d    = Math.abs(p - v);
  const fix  = t(p > v ? 'i2v_fix_del' : 'i2v_fix_add')
                 .replace(/\{p\}/g, p).replace(/\{d\}/g, d).replace(/\{v\}/g, v);
  return rule + '<span class="fix-line">' + fix + '</span>';
}

function renderI2vFixHint() {
  const el = document.getElementById('i2v-fix-hint');
  if (!el) return;
  const html = i2vFixHtml();
  el.innerHTML = html;
  el.style.display = html ? 'block' : 'none';
}

// Seçili modun ne ürettiğini prompt kutusunun hemen üstünde canlı anlatır.
function renderI2vPairNote() {
  const el = document.getElementById('i2v-pair-note');
  if (!el) return;
  const n = i2vItems.length;
  const v = i2vExpectedCount();
  const key = i2vUse === 'frames' ? ('i2v_note_' + i2vPair) : 'i2v_note_ingredients';
  let html = t(key).replace(/\{n\}/g, n).replace(/\{v\}/g, v);
  // Çiftler modunda tek sayıda görsel varsa son görsel hiçbir videoya girmez → açıkça söyle
  const leftover = (i2vUse === 'frames' && i2vPair === 'pairs' && n % 2 === 1 && n > 1);
  if (leftover) html += ' ' + t('i2v_note_odd');
  el.innerHTML = html;
  el.classList.toggle('warn', leftover);
}

// Kullanım/eşleme seg gruplarını çizer. renderSegGroup seçili öğe için onPick'i render
// sırasında da çağırdığından, onPick yalnızca değeri yazıp syncI2vModeUI'yi çağırır
// (seg grubunu YENİDEN ÇİZMEZ → özyineleme yok).
function renderI2vModeGroups() {
  renderSegGroup('i2v-use-group', [
    { label: t('i2v_use_frames'),      value: 'frames',      selected: i2vUse === 'frames',      icon: ICON_FRAMES },
    { label: t('i2v_use_ingredients'), value: 'ingredients', selected: i2vUse === 'ingredients', icon: ICON_INGREDIENTS }
  ], v => { i2vUse = v; syncI2vModeUI(); });
  renderSegGroup('i2v-pair-group', [
    { label: t('i2v_pair_start'), value: 'start', selected: i2vPair === 'start' },
    { label: t('i2v_pair_chain'), value: 'chain', selected: i2vPair === 'chain' },
    { label: t('i2v_pair_pairs'), value: 'pairs', selected: i2vPair === 'pairs' }
  ], v => { i2vPair = v; syncI2vModeUI(); });
  syncI2vModeUI();
}

// Eşleme grubunun görünürlüğü + not satırı + sayaç. Gizli .gen-field flex ÖĞESİ olmadığı
// için kartın 11px gap'i de oluşmaz (Malzemeler'de yerleşim eskisiyle birebir aynı kalır).
function syncI2vModeUI() {
  const pf = document.getElementById('i2v-pair-field');
  if (pf) pf.style.display = (i2vUse === 'frames') ? 'flex' : 'none';
  updateI2vMeta();
}

function renderI2vList() {
  const wrap = document.getElementById('i2v-list');
  if (!wrap) return;
  wrap.innerHTML = '';
  const ordered = i2vOrdered();
  const total   = ordered.length;
  const pages   = Math.max(1, Math.ceil(total / I2V_PAGE_SIZE));
  if (i2vPage >= pages) i2vPage = pages - 1;
  if (i2vPage < 0) i2vPage = 0;
  const start = i2vPage * I2V_PAGE_SIZE;
  const end   = Math.min(start + I2V_PAGE_SIZE, total);
  for (let i = start; i < end; i++) {
    const it  = ordered[i];
    const img = i2vLib.find(x => x.id === it.libId);
    const row = document.createElement('div');
    row.className = 'i2v-row';
    row.innerHTML =
      `<span class="i2v-num">${String(i + 1).padStart(3, '0')}</span>
       <span class="i2v-thumb">${img ? `<img src="${img.dataUrl}" alt="">` : ''}</span>
       <span class="i2v-name">${escHtml(it.name)}</span>
       <button class="i2v-rm" title="${escHtml(t('remove'))}">×</button>`;
    row.querySelector('.i2v-rm').addEventListener('click', () => {
      const k = i2vItems.indexOf(it);
      if (k >= 0) i2vItems.splice(k, 1);
      // Hiçbir satırın işaret etmediği görseller depodan da düşer (şişme olmasın)
      i2vLib = i2vLib.filter(e => i2vItems.some(x => x.libId === e.id));
      saveI2vLib();
      renderI2vList(); saveI2vState();
    });
    wrap.appendChild(row);
  }
  renderI2vPager(total, pages, start, end);
  // "Tümünü Kaldır" butonu yalnız listede görsel varken görünür
  const clearBtn = document.getElementById('btn-i2v-clear');
  if (clearBtn) clearBtn.style.display = i2vItems.length ? 'inline-flex' : 'none';
  updateI2vMeta();
}

// Foto→Video listesindeki TÜM görselleri tek tuşla kaldırır (tek tek × yerine).
// Yalnız bu sekmenin kendi deposunu (i2vItems + i2vLib) boşaltır; Library, shared
// referanslar, promptMap ve prompt metinleri ETKİLENMEZ. Onay ister (geri alınamaz).
function clearI2vImages() {
  if (!i2vItems.length) return;
  if (!confirm(t('i2v_clear_confirm').replace('{n}', i2vItems.length))) return;
  i2vItems = [];
  i2vLib   = [];   // hiçbir satırın işaret etmediği görseller depoda kalmasın
  i2vPage  = 0;
  saveI2vLib();
  renderI2vList(); saveI2vState();
  showNotif(t('i2v_cleared'), 'success');
}

// Sıralama listesi sayfalayıcısı (20'şerli). Tek sayfaya sığıyorsa gizlenir.
function renderI2vPager(total, pages, start, end) {
  const pager = document.getElementById('i2v-pager');
  if (!pager) return;
  if (total <= I2V_PAGE_SIZE) { pager.style.display = 'none'; pager.innerHTML = ''; return; }
  pager.style.display = 'flex';
  const info = t('i2v_page').replace('{c}', i2vPage + 1).replace('{t}', pages);
  pager.innerHTML =
    `<button class="i2v-pg-btn" id="i2v-pg-prev" type="button" ${i2vPage === 0 ? 'disabled' : ''}>‹</button>
     <span class="i2v-pg-info">${start + 1}-${end} / ${total} · ${info}</span>
     <button class="i2v-pg-btn" id="i2v-pg-next" type="button" ${i2vPage >= pages - 1 ? 'disabled' : ''}>›</button>`;
  const prev = document.getElementById('i2v-pg-prev');
  const next = document.getElementById('i2v-pg-next');
  if (prev) prev.addEventListener('click', () => { if (i2vPage > 0) { i2vPage--; renderI2vList(); } });
  if (next) next.addEventListener('click', () => { if (i2vPage < pages - 1) { i2vPage++; renderI2vList(); } });
}

// Dosyaları SIRAYLA oku: FileReader async olduğundan paralel okumada bitiş sırası
// karışır ve "ekleme sırası" seçim sırası olmaktan çıkar.
async function addI2vFiles(fileList) {
  const tumu  = [...fileList];
  const files = tumu.filter(isImageFile);   // v159: uzantı da kabul (bkz. isImageFile)
  if (tumu.length > files.length)
    showNotif(t('lib_skipped_files').replace('{n}', tumu.length - files.length), 'info');
  for (const file of files) {
    const dataUrl = await new Promise(res => {
      const r = new FileReader();
      r.onload = ev => res(ev.target.result);
      r.onerror = () => res(null);
      r.readAsDataURL(file);
    });
    if (!dataUrl) continue;
    // v115: yalnız i2v deposuna yazılır — ortak Library'ye DOKUNULMAZ (sekmeler bağımsız).
    // Depoda birebir aynı veri varsa yeniden ekleme; o kaydı kullan (çift yükleme yok).
    let entry = i2vLib.find(x => x.dataUrl === dataUrl);
    if (!entry) {
      const taken = new Set(i2vLib.map(x => x.name));
      entry = { id: uid(), name: ensureUniqueName(file.name, taken), dataUrl, type: mimeOfFile(file) };
      i2vLib.push(entry);
    }
    i2vItems.push({ libId: entry.id, name: entry.name, fileDate: file.lastModified || Date.now(), addedAt: Date.now() });
  }
  saveI2vLib();
  renderI2vList(); saveI2vState();
}

// "Kuyruğu Hazırla" geri bildirimi: üstteki genel bildirim yerine BUTONUN HEMEN ALTINDA
// (i2v-build-status) gösterilir → kullanıcı butona bakarken sonucu orada görür.
let i2vStatusTimer = null;
function setI2vBuildStatus(msg, type = 'info') {
  const el = document.getElementById('i2v-build-status');
  if (!el) { showNotif(msg, type); return; } // yedek: element yoksa üstteki bildirime düş
  el.className = 'i2v-build-status ' + type;
  el.textContent = msg;
  el.style.display = 'block';
  clearTimeout(i2vStatusTimer);
  i2vStatusTimer = setTimeout(() => { el.style.display = 'none'; }, 8000);
}

// v115: SADECE DOĞRULAMA yapar (görsel var mı, prompt var mı, sayılar eşit mi).
// Eski sürümde ana prompt kutusunu, promptMap'i, ref modunu ve üretim ayarlarını
// EZİYORDU → Foto→Video'ya yüklenen görseller Control (Text→Image) sekmesinin
// "prompt başına eşle" alanına sızıyordu. Artık Başlat, i2v payload'ını Control'e
// hiç dokunmadan doğrudan üretir (buildI2vPayloadParts).
function buildI2vQueue(silent) {
  const ordered = i2vOrdered();
  const prompts = i2vPromptList();
  if (!ordered.length) { setI2vBuildStatus(t('i2v_need_images'), 'error'); return false; }
  if (!prompts.length) { setI2vBuildStatus(t('i2v_need_prompts'), 'error'); return false; }
  // v119: beklenen video sayısı moda göre değişir (zincir N-1, çiftler ⌊N/2⌋).
  const pairs = i2vUse === 'frames' ? i2vPairsFor(ordered, i2vPair) : ordered.map(it => [it, null]);
  if (!pairs.length) {   // zincir/çiftler tek görselle video kuramaz
    setI2vBuildStatus(t('i2v_need_two'), 'error');
    return false;
  }
  if (pairs.length !== prompts.length) {
    // Bire bir modlarda (Malzemeler / Başlangıç) ESKİ mesaj aynen korunur; zincir/çiftlerde
    // "kaç görsel → kaç video" ilişkisini açıklayan yeni mesaj gösterilir. Sonuna sayaç
    // altındaki kutunun DÜZELTME cümlesi (kaç satır silinecek/yazılacak) düz metin eklenir.
    const base = i2vIsOneToOne()
      ? t('i2v_mismatch').replace('{i}', ordered.length).replace('{p}', prompts.length)
      : t('i2v_mismatch_mode').replace('{i}', ordered.length)
                             .replace('{v}', pairs.length)
                             .replace('{p}', prompts.length);
    const fixPlain = i2vFixHtml().split('<span class="fix-line">').pop().replace(/<[^>]*>/g, '');
    setI2vBuildStatus(fixPlain ? (base + ' ' + fixPlain) : base, 'error');
    return false;
  }
  if (!silent) setI2vBuildStatus(i2vIsOneToOne()
    ? t('i2v_built').replace(/\{n\}/g, prompts.length)
    : t('i2v_built_mode').replace('{i}', ordered.length)
                        .replace('{v}', pairs.length)
                        .replace('{p}', prompts.length), 'success');
  return true;
}

// Başlat için i2v'ye özel referans yükü.
// Çıktı şekli buildRefPayload('map') ile BİREBİR aynı → arka ucun mevcut sözleşmesi korunur.
// promptRefNames[i] SIRASI ROLDÜR: [başlangıç] veya [başlangıç, bitiş]. Malzemeler modunda
// tek eleman kalır → arka uç bugünkü davranışını birebir sürdürür.
// count: FREE limit kırpması sonrası kullanılacak prompt sayısı (eşleşme hizalı kalır).
function buildI2vRefPayloadFor(count) {
  const ordered = i2vOrdered();
  const pairs = (i2vUse === 'frames' ? i2vPairsFor(ordered, i2vPair)
                                     : ordered.map(it => [it, null])).slice(0, count);
  const used = new Map(); // name → {name,dataUrl,type} — zincirde aynı görsel 2 videoda kullanılır,
                          // Map sayesinde Flow'a yalnız BİR kez yüklenir
  const nameOf = it => {
    const img = it && i2vLib.find(x => x.id === it.libId);
    if (!img) return null;
    used.set(img.name, { name: img.name, dataUrl: img.dataUrl, type: img.type });
    return img.name;
  };
  const promptRefNames = pairs.map(([a, b]) => {
    const s = nameOf(a);
    if (!s) return [];              // görsel depoda yoksa bu prompt referanssız kalır (eski davranış)
    const e = nameOf(b);
    return e ? [s, e] : [s];
  });
  return { refMode: 'map', refImagesAll: [...used.values()], promptRefNames,
           frameMode: i2vUse === 'frames' ? i2vPair : 'ingredients' };
}

let i2vDraftTimer = null;
function setupI2vUI() {
  const addBtn  = document.getElementById('btn-i2v-add');
  const fileInp = document.getElementById('i2v-file-input');
  if (!addBtn || !fileInp) return;
  addBtn.addEventListener('click', () => fileInp.click());
  fileInp.addEventListener('change', e => { addI2vFiles(e.target.files); e.target.value = ''; });
  const sortSel = document.getElementById('i2v-sort');
  if (sortSel) sortSel.addEventListener('change', () => { i2vSort = sortSel.value; i2vPage = 0; renderI2vList(); saveI2vState(); });
  const ta = document.getElementById('i2v-prompts');
  if (ta) ta.addEventListener('input', () => {
    updateI2vMeta();
    clearTimeout(i2vDraftTimer);
    i2vDraftTimer = setTimeout(saveI2vState, 400);
  });
  const clearBtn = document.getElementById('btn-i2v-clear');
  if (clearBtn) clearBtn.addEventListener('click', clearI2vImages);
  const buildBtn = document.getElementById('btn-i2v-build');
  if (buildBtn) buildBtn.addEventListener('click', () => buildI2vQueue()); // event objesi 'silent' sanılmasın
  // Model / süre / adet + kare modu kontrolleri (boot storage'dan yükleyince yeniden çizer)
  renderI2vGenControls();
  renderI2vModeGroups();
  const msel = document.getElementById('i2v-model');
  // Model değişince süre grubu tazelenir (10s yalnız Omni Flash'ta); geçersiz kalan
  // seçim varsayılana düştüğü için kayıt render'DAN SONRA yapılır.
  if (msel) msel.addEventListener('change', () => {
    i2vModel = msel.value;
    renderI2vResolutionGroup();
    renderI2vDurationGroup();
    saveI2vState();
  });
  ['i2v-aspect-group', 'i2v-duration-group', 'i2v-count-group',
   'i2v-use-group', 'i2v-pair-group'].forEach(id => {
    const g = document.getElementById(id);
    if (g) g.addEventListener('click', e => { if (e.target.closest('.seg-btn')) saveI2vState(); });
  });
}

// Ana üretim ayarları kartındaki seg butonunu etiketiyle bulup tıklar; böylece mevcut
// onPick + active-sınıf mantığı aynen çalışır (değer ataması elle tekrarlanmaz).
function pickSegByLabel(groupId, label) {
  const g = document.getElementById(groupId);
  if (!g) return;
  const b = [...g.querySelectorAll('.seg-btn')].find(x => x.textContent === label);
  if (b) b.click();
}

// ── Başlat payload'ı için referans verisini üret ───────
function buildRefPayload(prompts) {
  if (refMode === 'map') {
    const used = new Map(); // name → {name,dataUrl,type}
    const promptRefNames = prompts.map((_, i) => {
      const names = [];
      (promptMap[i] || []).forEach(id => {
        const img = library.find(x => x.id === id);
        if (img) {
          used.set(img.name, { name: img.name, dataUrl: img.dataUrl, type: img.type });
          names.push(img.name);
        }
      });
      return names;
    });
    return { refMode: 'map', refImagesAll: [...used.values()], promptRefNames };
  }
  // shared: tüm referanslar her prompt'a (ada göre tekilleştir)
  const seen = new Set();
  const refImagesAll = [];
  sharedRefs.forEach(r => {
    if (seen.has(r.name)) return;
    seen.add(r.name);
    refImagesAll.push({ name: r.name, dataUrl: r.dataUrl, type: r.type });
  });
  const allNames = refImagesAll.map(r => r.name);
  const promptRefNames = prompts.map(() => allNames.slice());
  return { refMode: 'shared', refImagesAll, promptRefNames };
}

// ── Referans UI'ını kur (init'ten çağrılır) ────────────
function setupReferenceUI() {
  document.querySelectorAll('#ref-mode-group .seg-btn').forEach(b => {
    b.addEventListener('click', () => setRefMode(b.dataset.refmode));
  });
  document.getElementById('btn-lib-upload').addEventListener('click',
    () => document.getElementById('lib-file-input').click());
  document.getElementById('lib-file-input').addEventListener('change', e => {
    addLibraryFiles(e.target.files);
    e.target.value = '';
  });
  const libClearBtn = document.getElementById('btn-lib-clear');
  if (libClearBtn) libClearBtn.addEventListener('click', clearLibrary);
  document.getElementById('btn-open-map').addEventListener('click', openMapModal);

  // Map modal kontrolleri
  document.getElementById('map-close-x').addEventListener('click', closeMapModal);
  document.getElementById('map-cancel').addEventListener('click', closeMapModal);
  document.getElementById('map-save').addEventListener('click', saveMap);
  document.getElementById('map-autotag').addEventListener('click', autoTagMap);
  document.getElementById('map-clear').addEventListener('click', clearMap);
  document.getElementById('map-overlay').addEventListener('click', e => {
    if (e.target.id === 'map-overlay') closeMapModal();
  });
  // ── Duyuru zili ────────────────────────────────────────────────────────
  // Okunmadıysa kırmızı nokta yanar. Tıklanınca söner (kalıcı olarak kaydedilir) ama
  // duyuru her zaman tekrar açılabilir. NOTICE_ID değiştirilirse uyarı HERKESTE tekrar yanar.
  initNoticeBell();

  // Library seçici
  document.getElementById('libpick-close-x').addEventListener('click',
    () => { document.getElementById('libpick-overlay').style.display = 'none'; });
  document.getElementById('libpick-overlay').addEventListener('click', e => {
    if (e.target.id === 'libpick-overlay') document.getElementById('libpick-overlay').style.display = 'none';
  });

  // İlk render
  setRefMode(refMode);
  renderSharedRefs();
  renderLibrary();
  updateMapSummary();
}

// ── Actions ────────────────────────────────────────────
async function handleStart() {
  if (!currentUser) { showNotif(t('err_login_required'), 'error'); handleSignIn(); return; }
  if (!flowTab) { showNotif(t('err_no_flow'), 'error'); return; }

  // v115: Foto→Video sekmesi TAM BAĞIMSIZ çalışır. Bu sekmede içerik varken Başlat,
  // promptları ve görsel eşlemesini doğrudan i2v verisinden üretir; Control (Text→Image)
  // sekmesinin prompt kutusuna, promptMap'ine, ref moduna ve üretim ayarlarına DOKUNMAZ.
  const isI2vStart = activeTab === 'i2v' && (i2vItems.length || i2vPromptList().length);

  let prompts;
  if (isI2vStart) {
    if (!buildI2vQueue(true)) return; // doğrulama (sayı uyuşmazlığı vb.) — akış başlatılmaz
    prompts = i2vPromptList();
  } else {
    const raw = document.getElementById('prompt-input').value.trim();
    if (!raw) { showNotif(t('err_no_prompt'), 'error'); return; }
    // v151: bicim otomatik anlasilir (satir satir / bos satirla ayrilmis paragraf).
    // Prompt metni Flow'a AYNEN gider; zaman damgasi varsa da metinden cikarilmaz.
    prompts = parsePromptText(raw).prompts;
    if (!prompts.length) { showNotif(t('err_invalid_prompt'), 'error'); return; }
  }

  if (!FREE_MODE && !isPro) {
    const rem = FREE_DAILY_LIMIT - todayUsage;
    if (rem <= 0) { showNotif(t('err_limit'), 'error'); return; }
    if (prompts.length > rem) prompts = prompts.slice(0, rem);
  }

  // v150: "Zaman damgali" dosya adi secildiyse HER promptta zaman damgasi SART. Eksikse
  // akis BASLATILMAZ ve eksik promptlarin sira numaralari hem bildirimde hem indirme
  // kartindaki kirmizi uyarida gosterilir.
  if (dlNaming === 'time' || dlNaming === 'numtime') {
    const miss = missingTsIdx(prompts);
    if (miss.length) {
      const list = miss.slice(0, 10).join(', ') + (miss.length > 10 ? '...' : '');
      showNotif(t('err_ts_missing').replace('{n}', miss.length).replace('{list}', escHtml(list)), 'error');
      renderDlNaming();
      return;
    }
  }

  pauseIntent = null;  // yeni koşu → önceki koşudan kalan duraklat niyeti geçersiz
  renderDynamic({ status: 'running', prompts, currentIndex: 0, interval: selectedSecs, currentPrompt: prompts[0] });

  // i2v: prompt kırpıldıysa görsel listesi de aynı sayıda kırpılır (çiftler hizalı kalır)
  const refPayload = isI2vStart ? buildI2vRefPayloadFor(prompts.length) : buildRefPayload(prompts);
  const payload = {
    action:         'start',
    prompts,
    interval:       selectedSecs,
    tabId:          flowTab.id,
    flowUrl:        flowTab.url || '',   // üretim hangi projede yapıldı → "Sonradan indir" numaralandırması için
    refImages:      refPayload.refImagesAll,   // geriye uyum (eski alan adı)
    refImagesAll:   refPayload.refImagesAll,
    refMode:        refPayload.refMode,
    promptRefNames: refPayload.promptRefNames,
    // v119: 'ingredients' (kanıtlı "+ → İsteme ekle" yolu) | 'start'|'chain'|'pairs'
    // (Kareler yolu: promptRefNames[i][0] başlangıç, [1] varsa bitiş karesi).
    // Control akışı bu alanı HİÇ göndermez → arka uçta 'ingredients'a düşer.
    frameMode:      refPayload.frameMode || 'ingredients',
    autoDownload,
    dlQualityImg,
    dlQualityVid,
    videoOnly:      isI2vStart || genMode === 'VIDEO', // VİDEO üretimi → indirmede referans görselleri atla, yalnız videolar insin
    // i2v: üretim ayarları Control arayüzüne DOKUNMADAN doğrudan sekmenin kendi
    // seçimlerinden kurulur (eski buildI2vQueue'nun renderGen('VIDEO') varsayılanıyla
    // birebir aynı alanlar: mode/model/aspect/count/duration).
    genSettings:    isI2vStart
      ? { mode: 'VIDEO', model: i2vModel, aspect: i2vAspect || 'LANDSCAPE', count: i2vCount,
          duration: i2vDuration, resolution: i2vResolution }
      : buildGenSettings(),
    currentUsage:   todayUsage
  };

  // BÜYÜK REFERANS YÜKÜ: dataUrl'ler mesajla taşınınca chrome.runtime mesaj sınırı
  // aşılabiliyor → mesaj HİÇ iletilmez → "arka plan başlatılamadı". Görseller zaten/ayrıca
  // IDB'ye yazılır (panel ile SW aynı origin = aynı IDB) ve payload küçük gönderilir;
  // SW referansları IDB'den okur. Küçük yüklerde kanıtlı eski yol AYNEN korunur.
  let refBytes = 0;
  (payload.refImagesAll || []).forEach(r => { refBytes += (r && r.dataUrl) ? r.dataUrl.length : 0; });
  if (refBytes > 20 * 1024 * 1024) {
    try {
      await idbSet('afStartRefs', payload.refImagesAll);
      payload.refImages = [];
      payload.refImagesAll = [];
      payload.refsFromIdb = true;
      console.log('[AutoFlow] Referanslar büyük (' + Math.round(refBytes / 1048576) + 'MB) → IDB üzerinden aktarılacak');
    } catch (e) {
      console.warn('[AutoFlow] afStartRefs IDB yazılamadı, normal yol denenecek:', e && e.message);
    }
  }

  // MV3 service worker uykudaysa İLK mesaj kayboluyor → ilk tıklama "başlamıyor",
  // ikinci tıklama (worker artık uyanık) çalışıyordu. Çözüm: ÖNCE hafif bir ping
  // ile worker'ı UYANDIR ve hazır olduğunu doğrula, SONRA 'start' gönder.
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  let lastSendErr = '';
  const ping = async () => {
    try { const s = await chrome.runtime.sendMessage({ action: 'getState' }); return !!s; }
    catch (_) { return false; }
  };
  const trySend = async () => {
    try { const r = await chrome.runtime.sendMessage(payload); return !!(r && r.success); }
    catch (e) {
      lastSendErr = (e && e.message) || String(e);
      console.warn('[AutoFlow] start mesajı gönderilemedi:', lastSendErr);
      return false;
    }
  };
  const isRunning = async () => {
    try { const s = await chrome.runtime.sendMessage({ action: 'getState' }); return !!(s && s.status === 'running'); }
    catch (_) { return false; }
  };

  // 1) Worker'ı uyandır (cold start için birkaç deneme)
  for (let i = 0; i < 6; i++) { if (await ping()) break; await sleep(200); }

  // 2) 'start' gönder; başarısızsa kısa aralıklarla yeniden dene ve doğrula
  let ok = false;
  for (let i = 0; i < 4 && !ok; i++) {
    ok = await trySend();
    if (!ok) { await sleep(250); ok = await isRunning(); }
    if (!ok) await sleep(200);
  }

  if (!ok) {
    // Teşhis: gerçek sendMessage hatasını (örn. mesaj boyutu sınırı) kullanıcıya da göster
    showNotif(t('err_bg_start') + (lastSendErr ? ' (' + lastSendErr + ')' : ''), 'error');
    renderDynamic({ status: 'idle' });
  }
}

// Duraklat/Devam. ÖNCE EKRAN, SONRA MESAJ: buton tıklandığı anda değişir; arka uca
// gönderim arkada sürer. (Eskiden önce `await sendMessage` yapılıyordu; servis çalışanı
// uykudaysa/meşgulse yanıt birkaç saniye sürebiliyor ve buton o kadar süre eski halinde
// donuyordu.) Niyet pauseIntent'e yazılır → yolda olan eski durum yayını butonu geri
// çevirmez; arka uç istenen duruma geçince niyet düşer.
let pauseClickAt = 0;
function handlePause() {
  const now = Date.now();
  if (now - pauseClickAt < 700) return;   // alışkanlıktan atılan çift tık tek işlem sayılır
  pauseClickAt = now;
  // Sıradaki durum, arka uç HENÜZ ONAYLAMAMIŞ olsa bile kullanıcının en son niyetine göre
  // belirlenir; yoksa yolda olan eski bir yayın autoState'i geri çevirdiğinde ikinci tık
  // yanlış yöne (duraklat yerine devam) giderdi.
  const cur = pauseIntent ? pauseIntent.status : (autoState && autoState.status);
  const wantResume = cur === 'paused';
  const next = wantResume ? 'running' : 'paused';
  if (!autoState) autoState = { status: wantResume ? 'paused' : 'running' };
  autoState.status = next;
  pauseIntent = { status: next, until: now + 12000 };
  renderDynamic(autoState);               // ANINDA geri bildirim (arka ucu beklemez)
  // Mesaj arkada gider; yanıtı BEKLENMEZ (servis çalışanı meşgulse yanıt saniyeler sürebilir).
  try { chrome.runtime.sendMessage({ action: wantResume ? 'resume' : 'pause' }).catch(() => {}); } catch (_) {}
}

async function handleStop() {
  await chrome.runtime.sendMessage({ action: 'stop' }).catch(() => {});
  renderDynamic({ status: 'idle' });
}

// ── Üretim ayarları (mode/model/oran/adet/süre) — SABİT listeden ─────────
function markModeActive() {
  document.querySelectorAll('#gen-mode-group .seg-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.mode === genMode));
}

// Segmented buton grubu kur. items: [{label, value, selected}]
function renderSegGroup(groupId, items, onPick) {
  const g = document.getElementById(groupId);
  if (!g) return;
  g.innerHTML = '';
  (items || []).forEach(it => {
    const b = document.createElement('button');
    b.className = 'seg-btn' + (it.selected ? ' active' : '');
    // it.icon verilirse etiketin BAŞINA küçük SVG konur (Flow'daki Kareler/Malzemeler
    // sekmeleriyle aynı görünüm). İkonsuz gruplar eskisi gibi düz metin kalır.
    if (it.icon) { b.classList.add('seg-btn-ic'); b.innerHTML = it.icon + '<span>' + escHtml(it.label) + '</span>'; }
    else b.textContent = it.label;
    if (it.selected) onPick(it.value);
    b.addEventListener('click', () => {
      onPick(it.value);
      g.querySelectorAll('.seg-btn').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
    });
    g.appendChild(b);
  });
}

function populateModels(models) {
  const sel = document.getElementById('gen-model');
  if (!sel) return;
  sel.innerHTML = '';
  if (!models || !models.length) {
    const o = document.createElement('option'); o.value = ''; o.textContent = '—'; sel.appendChild(o);
    genModel = '';
    return;
  }
  models.forEach(m => {
    const o = document.createElement('option');
    o.value = m.name; o.textContent = m.name;
    if (m.selected) { o.selected = true; genModel = m.name; }
    sel.appendChild(o);
  });
  if (!genModel) genModel = sel.value;
}

// Seçili modun SABİT seçeneklerini arayüze bas (Flow'a DOKUNMAZ)
function renderGen(mode) {
  const o = GEN_OPTIONS[mode] || GEN_OPTIONS.IMAGE;

  // Oran
  genAspect = '';
  renderSegGroup('gen-aspect-group',
    (o.aspects || []).map(a => ({ label: a.label || a.code, value: a.code, selected: a.selected })),
    v => { genAspect = v; });

  // Adet
  genCount = null;
  renderSegGroup('gen-count-group',
    (o.counts || []).map(c => ({ label: 'x' + c.n, value: c.n, selected: c.selected })),
    v => { genCount = v; });

  populateModels(o.models);

  // Çözünürlük (yalnızca video — Flow 2026-09: 360p / 720p)
  renderGenResolution();

  // Süre (yalnızca video) — MODEL SEÇİLDİKTEN SONRA çizilir, çünkü bazı süreler
  // yalnız belirli modellerde listelenir (10s → Omni 1.1 Flash).
  renderGenDuration();
}

// Çözünürlük grubu: yalnız VIDEO modunda görünür. Mevcut seçim korunur.
function renderGenResolution() {
  const o = GEN_OPTIONS[genMode] || GEN_OPTIONS.IMAGE;
  const field = document.getElementById('gen-resolution-field');
  const list = resolutionsForModel(o.resolutions, genModel);
  const prev = genResolution;
  genResolution = null;
  if (list.length) {
    if (field) field.style.display = 'flex';
    const want = list.some(r => r.p === prev) ? prev : (list.find(r => r.selected) || list[0]).p;
    renderSegGroup('gen-resolution-group',
      list.map(r => ({ label: r.p, value: r.p, selected: r.p === want })),
      v => { genResolution = v; });
  } else if (field) {
    field.style.display = 'none';
  }
}

// Süre grubu: seçili moda VE seçili modele göre. Mevcut seçim yeni modelde de geçerliyse
// KORUNUR, değilse listenin varsayılanına düşer (Omni Flash'ta 10s seçip Veo'ya geçince 8s).
function renderGenDuration() {
  const o = GEN_OPTIONS[genMode] || GEN_OPTIONS.IMAGE;
  const durField = document.getElementById('gen-duration-field');
  const list = durationsForModel(o.durations, genModel);
  const prev = genDuration;
  genDuration = null;
  if (list.length) {
    if (durField) durField.style.display = 'flex';
    const want = list.some(d => d.sec === prev) ? prev : (list.find(d => d.selected) || list[0]).sec;
    renderSegGroup('gen-duration-group',
      list.map(d => ({ label: d.sec + 's', value: d.sec, selected: d.sec === want })),
      v => { genDuration = v; });
  } else if (durField) {
    durField.style.display = 'none';
  }
}

// Başlat payload'ı için seçili ayarlar (her zaman dolu — sabit listeden)
function buildGenSettings() {
  const s = { mode: genMode };
  if (genModel)    s.model    = genModel;
  if (genAspect)   s.aspect   = genAspect;
  if (genCount)    s.count    = genCount;
  if (genDuration && genMode === 'VIDEO') s.duration = genDuration;
  if (genResolution && genMode === 'VIDEO') s.resolution = genResolution;
  return s;
}

// ── Interval ───────────────────────────────────────────
function setIntervalSecs(v) {
  selectedSecs = Math.max(1, Math.min(300, v));
  // Control + Foto→Video sekmelerindeki kopyalar birlikte güncellenir
  ['interval-input', 'interval-input-i2v'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = selectedSecs;
  });
  document.querySelectorAll('.qchip[data-s]').forEach(c => {
    c.classList.toggle('active', parseInt(c.dataset.s) === selectedSecs);
  });
}

// ── Helpers ────────────────────────────────────────────
let draftSaveTimer = null;
function updateLineCount() {
  const v = document.getElementById('prompt-input').value;
  // v150: sayac ayirma moduna gore PROMPT sayisi ('line' modunda eski sonucun aynisi)
  const n = v.trim() ? getPrompts().length : 0;
  const el = document.getElementById('line-count');
  if (el) el.textContent = n;
  // Prompt TASLAĞINI kaydet (debounce ~400ms): textarea'yı değiştiren HER yol (yazma,
  // .txt yükleme, temizleme) buradan geçer → taslak storage'da hep günceldir; per-tab
  // panel (v93) sekme değişiminde kapanıp yeniden yüklenince boot'ta geri yüklenir.
  clearTimeout(draftSaveTimer);
  draftSaveTimer = setTimeout(() => {
    try {
      const cur = document.getElementById('prompt-input');
      chrome.storage.local.set({ afPromptDraft: (cur && cur.value) || '' });
    } catch (_) {}
  }, 400);
  return n;
}

function todayStr() { return new Date().toISOString().split('T')[0]; }

function fmtSecs(s) {
  const um = t('unit_min'), us = t('unit_sec');
  if (s < 60) return `${s}${us}`;
  const m = Math.floor(s / 60), r = s % 60;
  return r > 0 ? `${m}${um} ${r}${us}` : `${m}${um}`;
}

function svgCheck() {
  return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#22C55E" stroke-width="2.5"><polyline points="20,6 9,17 4,12"/></svg>`;
}
function svgWarn() {
  return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#F59E0B" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`;
}
function svgPause() {
  return `<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>`;
}
function svgPlay() {
  return `<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><polygon points="5,3 19,12 5,21"/></svg>`;
}

// ════════════════════════════════════════════════════════
// SEKMELER / GALLERY / LOGS
// ════════════════════════════════════════════════════════
let activeTab  = 'control';
let logsData   = [];
let logsFilter = 'all';

function setActiveTab(name) {
  activeTab = name;
  document.querySelectorAll('#tabbar .tab').forEach(b =>
    b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.tab-panel').forEach(p =>
    p.classList.toggle('active', p.dataset.panel === name));
  if (name === 'queue') renderQueue();
  try { chrome.storage.local.set({ afActiveTab: name }); } catch (_) {}
}

function normalizeTag(v) {
  let s = (v || '').trim().replace(/^@+/, '');
  return s ? '@' + s : '';
}

// ── Logs sekmesi "Logları İndir" (v171) ───────────────────
// Paneldeki TUM kayitlari (filtre/arama ne olursa olsun) tarihli bir .txt dosyasina yazar.
// Dosya eklenti sayfasindaki bir blob adresinden iner; arka plandaki adlandirma kancasi yalniz
// Flow/Google adreslerini yeniden adlandirdigi icin bu dosyaya dokunmaz (kendi adiyla iner).
function downloadLogsFile() {
  const list = Array.isArray(logsData) ? logsData.slice() : [];
  if (!list.length) { showNotif(t('logs_empty'), 'info'); return; }
  const p = n => String(n).padStart(2, '0');
  const stamp = d => d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' +
    p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  const now = new Date();
  let ver = '';
  try { ver = chrome.runtime.getManifest().version || ''; } catch (_) {}
  const lines = [
    'ViralDNA Auto Flow logs',
    'version: ' + ver,
    'exported: ' + stamp(now),
    'entries: ' + list.length,
    '----------------------------------------',
    ...list.map(e => stamp(new Date(e.t)) + '  [' + (e.kind || 'info') + ']  ' + String(e.msg == null ? '' : e.msg))
  ];
  const text = lines.join('\r\n') + '\r\n';
  const fname = 'AutoFlow-logs-' + now.getFullYear() + p(now.getMonth() + 1) + p(now.getDate()) +
    '-' + p(now.getHours()) + p(now.getMinutes()) + p(now.getSeconds()) + '.txt';
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  const done = ok => {
    showNotif(ok ? t('logs_downloaded') : t('logs_download_failed'), ok ? 'success' : 'error');
    setTimeout(() => { try { URL.revokeObjectURL(url); } catch (_) {} }, 60000);
  };
  // Yedek yol: indirme API'si reddederse sayfa ici <a download>
  const viaAnchor = () => {
    try {
      const a = document.createElement('a');
      a.href = url; a.download = fname; a.style.display = 'none';
      document.body.appendChild(a); a.click(); a.remove();
      done(true);
    } catch (_) { done(false); }
  };
  try {
    chrome.downloads.download({ url, filename: fname, conflictAction: 'uniquify' })
      .then(id => { if (typeof id === 'number') done(true); else viaAnchor(); })
      .catch(viaAnchor);
  } catch (_) { viaAnchor(); }
}

// "Sonradan İndir" butonu: manuel indirme çalışırken "Durdur"a (kırmızı) döner.
function updateDownloadLaterBtn(state) {
  bulkDownloading = !!(state && state.bulkDownloading);
  // Control + Görselden Video sekmelerindeki kopyalar birlikte güncellenir
  ['btn-download-later', 'btn-download-later-i2v'].forEach(id => {
    const btn = document.getElementById(id);
    if (!btn) return;
    btn.classList.toggle('is-stopping', bulkDownloading);
    const span = btn.querySelector('span');
    if (span) span.textContent = bulkDownloading ? t('btn_download_stop') : t('btn_download_later');
    if (bulkDownloading) btn.disabled = false; // durdurmak için her zaman tıklanabilir
  });
}

// "Oto indirmeyi durdur" butonu: oto indirme pipeline'ı aktifken (autoDlActive) görünür.
// Üretim bitince ana Durdur/Duraklat butonu "Başlat"a döndüğü için oto indirme tek başına
// durdurulamıyordu; bu buton onu bağımsız durdurur.
function updateStopAutoDlBtn(state) {
  const show = !!(state && state.autoDlActive);
  ['btn-stop-autodl', 'btn-stop-autodl-i2v'].forEach(id => {
    const btn = document.getElementById(id);
    if (btn) btn.style.display = show ? 'inline-flex' : 'none';
  });
}

// ── Prompt Kuyruğu (Queue sekmesi) ─────────────────────────
// SALT-OKUR: mevcut state'ten (prompts + currentIndex + status + skippedPrompts) durum türetir.
// Üretim/indirme akışına HİÇ dokunmaz. Koşu yokken textarea'dan (getPrompts) önizleme gösterir.
let qState = null;
function renderQueue() {
  const list = document.getElementById('queue-list');
  if (!list) return;
  const st = qState || {};
  const prompts = (st.prompts && st.prompts.length) ? st.prompts : getPrompts();
  const cur     = st.currentIndex || 0;
  const running = st.status === 'running';
  const skipped = st.skippedPrompts || {};
  const summary = document.getElementById('queue-summary');
  // "Temizle" butonu yalnız kuyrukta prompt varken görünür
  const clearBtn = document.getElementById('btn-queue-clear');
  if (clearBtn) clearBtn.style.display = prompts.length ? 'inline-flex' : 'none';
  if (!prompts.length) {
    list.innerHTML = '<div class="queue-empty">' + t('queue_empty') + '</div>';
    if (summary) summary.textContent = '';
    return;
  }
  // v170 INDIRME DURUMU: yalniz bu kosunun indirme kaydi varsa (oto indirme ya da ayni
  // projede "Sonradan indir"). Kayit yoksa asagidaki satirlar BIREBIR eski davranis.
  //   indirildi (yesil)  -> o numarali dosya klasorde var
  //   indirme bekleniyor -> gonderildi, dosyasi henuz inmedi (mavi)
  //   inmedi (kirmizi)   -> uretim VE indirme bitti ama bu numarali dosya hic inmedi
  const track   = !!st.dlTrackPrompts && !!(st.prompts && st.prompts.length);
  const slots   = st.dlSavedSlots || {};
  const perP    = Math.max(1, (st.genSettings && st.genSettings.count) || 1);
  const dlBusy  = !!(st.autoDlActive || st.bulkDownloading);
  const dlEnded = track && !dlBusy && !running && st.status !== 'paused';
  const savedOf = i => { let n = 0; for (let k = 0; k < perP; k++) if (slots[i * perP + k]) n++; return n; };
  let nSent = 0, nSkip = 0, nDl = 0, nMiss = 0;
  const esc = s => (s || '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const frac = (n) => (perP > 1 ? ' ' + n + '/' + perP : '');
  const rows = prompts.map((p, i) => {
    let cls, label;
    const sv = track ? savedOf(i) : 0;
    if (skipped[i])                       { cls = 'q-skipped'; label = t('q_skipped'); nSkip++; }
    else if (track && sv >= perP)         { cls = 'q-dl';      label = t('q_downloaded') + frac(sv) + ' ✓'; nDl++; if (i < cur) nSent++; }
    else if (i < cur) {
      nSent++;
      if (!track)                         { cls = 'q-sent';    label = t('q_sent'); }
      else if (dlEnded)                   { cls = 'q-dlmiss';  label = (sv ? t('q_dl_partial') + frac(sv) : t('q_dl_missing')) + ' ✗'; nMiss++; }
      else                                { cls = 'q-dlwait';  label = sv ? t('q_dl_progress') + frac(sv) : t('q_dl_wait'); }
    }
    else if (i === cur && running)        { cls = 'q-sending'; label = t('q_sending'); }
    else                                  { cls = 'q-pending'; label = t('q_pending'); }
    return '<div class="queue-item ' + cls + '">' +
      '<span class="q-num">' + (i + 1) + '</span>' +
      '<div class="q-body"><div class="q-text">' + esc(p) + '</div>' +
      '<div class="q-status">' + label + '</div></div></div>';
  }).join('');
  list.innerHTML = rows;
  if (summary) summary.textContent = nSent + '/' + prompts.length +
    (track ? ' · ' + nDl + ' ' + t('q_sum_dl') : '') +
    (nMiss ? ' · ' + nMiss + ' ' + t('q_sum_missing') : '') +
    (nSkip ? ' · ' + nSkip + ' ' + t('q_skipped').toLowerCase() : '');
}

// ── Logs ───────────────────────────────────────────────
function logKindClass(kind) {
  if (kind === 'error') return 'log-error';
  if (kind === 'saved' || kind === 'complete' || kind === 'done') return 'log-ok';
  return 'log-info';
}
function fmtLogTime(ts) {
  const d = new Date(ts), p = n => String(n).padStart(2, '0');
  return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}
function setLogs(arr) { logsData = Array.isArray(arr) ? arr.slice() : []; renderLogs(); }
function appendLog(entry) {
  logsData.push(entry);
  if (logsData.length > 200) logsData.splice(0, logsData.length - 200);
  renderLogs();
}
function renderLogs() {
  const list = document.getElementById('logs-list');
  const empty = document.getElementById('logs-empty');
  if (!list) return;
  const errCount = logsData.filter(e => e.kind === 'error').length;
  const setTxt = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  setTxt('logs-count-all', logsData.length);
  setTxt('logs-count-err', errCount);
  setTxt('logs-count-act', logsData.length - errCount);
  const badge = document.getElementById('logs-err-badge');
  if (badge) { badge.style.display = errCount ? 'inline-flex' : 'none'; badge.textContent = errCount; }

  const q = (document.getElementById('logs-search')?.value || '').toLowerCase();
  let rows = logsData;
  if (logsFilter === 'errors')        rows = rows.filter(e => e.kind === 'error');
  else if (logsFilter === 'activity') rows = rows.filter(e => e.kind !== 'error');
  if (q) rows = rows.filter(e => (e.msg || '').toLowerCase().includes(q));

  if (!rows.length) { list.innerHTML = ''; if (empty) empty.style.display = 'block'; return; }
  if (empty) empty.style.display = 'none';
  list.innerHTML = rows.map(e =>
    `<div class="log-row ${logKindClass(e.kind)}"><span class="log-time">${fmtLogTime(e.t)}</span><span class="log-msg">${escHtml(e.msg)}</span></div>`
  ).join('');
  list.scrollTop = list.scrollHeight;
}

// -- v149 KAYIT KLASORU ------------------------------------------------------
// Arka uctaki sanitizeDlRoot'un ONIZLEME kopyasi. Gercek temizligi (ve indirmeyi)
// service worker yapar; buradaki kopya yalnizca kullaniciya yolun nasil gorunecegini
// gosterir. Ikisi ayni kurallari uygular -> onizleme yaniltmaz.
function cleanDlRoot(raw) {
  let s = String(raw == null ? '' : raw).trim();
  if (!s) return '';
  s = s.split(String.fromCharCode(92)).join('/'); // Windows ters bolu -> normal bolu
  s = s.replace(/^[a-zA-Z]:/, '');                // surucu harfi (mutlak yol yok)
  const parts = [];
  for (let p of s.split('/')) {
    p = p.replace(/[<>:"|?*\x00-\x1F]/g, '').replace(/^[.\s]+|[.\s]+$/g, '').trim();
    if (!p || p === '.' || p === '..') continue;
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(p)) p = '_' + p;
    parts.push(p.slice(0, 40));
    if (parts.length >= 4) break;
  }
  return parts.join('/').slice(0, 120).replace(/\/+$/, '');
}

// "Indirilenler / Projem / AutoFlow-20260908-143012 / 0001.mp4" onizlemesi.
function updateDlFolderPreview() {
  const root = cleanDlRoot(dlFolderRoot);
  const d = new Date(), p = n => String(n).padStart(2, '0');
  const dated = 'AutoFlow-' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) +
                '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
  const parts = [t('dl_folder_downloads')];
  if (root) parts.push.apply(parts, root.split('/'));
  // Arka uctaki makeDownloadFolder ile AYNI kural: tarihli klasor kapali VE kok bossa
  // klasor adi 'AutoFlow' olur (bos klasor adi Chrome tarafindan reddedilir).
  if (dlFolderDated) parts.push(dated); else if (!root) parts.push('AutoFlow');
  const html = parts.map(escHtml).join(' <span class="sep">/</span> ') +
               ' <span class="sep">/</span> <b>' + escHtml(dlNamingExample()) + '.mp4</b>';
  ['dl-folder-path', 'dl-folder-path-i2v'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.innerHTML = html;
  });
}

// Iki sekmedeki kopyayi (Control + Foto->Video) ayni degere getir.
function syncDlFolderUi() {
  ['dl-folder', 'dl-folder-i2v'].forEach(id => {
    const el = document.getElementById(id);
    if (el && el.value !== dlFolderRoot) el.value = dlFolderRoot;
  });
  ['dl-folder-dated', 'dl-folder-dated-i2v'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.checked = dlFolderDated;
  });
  updateDlFolderPreview();
}

function saveDlFolderPrefs() {
  try {
    chrome.storage.local.set({ afDlRoot: dlFolderRoot, afDlDated: dlFolderDated });
  } catch (_) {}
}

// Olaylari bagla. Deger DEPOYA yazilir; arka uc klasor adini uretirken depodan okur
// (mesajlasma yok) -> panel kapali olsa bile ayar gecerlidir.
function setupDlFolder() {
  const inputs = ['dl-folder', 'dl-folder-i2v']
    .map(id => document.getElementById(id)).filter(Boolean);
  const checks = ['dl-folder-dated', 'dl-folder-dated-i2v']
    .map(id => document.getElementById(id)).filter(Boolean);
  inputs.forEach(inp => inp.addEventListener('input', () => {
    dlFolderRoot = inp.value;
    inputs.forEach(o => { if (o !== inp) o.value = inp.value; });
    updateDlFolderPreview();
    saveDlFolderPrefs();
  }));
  checks.forEach(chk => chk.addEventListener('change', () => {
    dlFolderDated = chk.checked;
    checks.forEach(o => { if (o !== chk) o.checked = chk.checked; });
    updateDlFolderPreview();
    saveDlFolderPrefs();
  }));
  syncDlFolderUi();
}

// -- v150 AYIRMA MODU + DOSYA ADI ARAYUZU ------------------------------------
// Arka uctaki afPromptLabel ile AYNI kurallar (onizleme yaniltmasin).
function promptLabelOf(p) {
  let s = String(p == null ? '' : p).replace(TS_RE, '');
  s = s.split(String.fromCharCode(92)).join(' ');
  s = s.replace(/[<>:"/|?*\x00-\x1F]/g, ' ').replace(/\s+/g, ' ').trim()
       .slice(0, 40).replace(/^[.\s]+|[.\s]+$/g, ''); // arka uctaki afPromptLabel ile AYNI
  return s;
}

// Arka uctaki afSafeFileBase ile AYNI kurallar: ad tek basina dosya adi olacagi icin
// Windows'un ayrilmis adlari da elenir. Supheli adda arka uc numaraya doner, onizleme de.
function safeFileBaseOf(b) {
  if (!b || b.length > 60) return false;
  if (/[<>:"/|?*]/.test(b)) return false;
  if (b.indexOf(String.fromCharCode(92)) >= 0) return false;
  if (/^[.\s]|[.\s]$/.test(b)) return false;
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(b)) return false;
  return true;
}

// Klasor onizlemesinde gosterilecek ornek dosya adi (secili adlandirmaya gore).
// Numarali disindaki modlarda dosya DOGRUDAN etiketle iner, basinda numara YOKTUR.
function dlNamingExample() {
  const first = String(dlStartNum).padStart(4, '0');   // v175: baslangic numarasi onizlemede de gorunsun
  if (dlNaming !== 'time' && dlNaming !== 'prompt' && dlNaming !== 'numtime') return first;
  const p = getPrompts()[0] || '';
  const label = (dlNaming === 'time')    ? (tsLabelOf(p) || '00-05')
              : (dlNaming === 'numtime') ? (first + '_' + (tsLabelOf(p) || '00-05'))
                                         : (promptLabelOf(p) || t('naming_example'));
  return safeFileBaseOf(label) ? label : first;
}

// Dosya adi modu: iki sekmedeki seg gruplari + eksik zaman damgasi uyarisi + onizleme.
function renderDlNaming() {
  ['dl-naming-group', 'dl-naming-group-i2v'].forEach(gid => {
    const g = document.getElementById(gid);
    if (!g) return;
    g.querySelectorAll('.seg-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.name === dlNaming);
    });
  });
  let html = '';
  if (dlNaming === 'time' || dlNaming === 'numtime') {
    const prompts = getPrompts();
    const miss = missingTsIdx(prompts);
    if (prompts.length && miss.length) {
      const list = miss.slice(0, 10).join(', ') + (miss.length > 10 ? '...' : '');
      html = t('naming_ts_missing').replace('{n}', miss.length).replace('{list}', escHtml(list));
    }
  }
  ['dl-naming-warn', 'dl-naming-warn-i2v'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    // TEK flex ogesi olarak sar: .info-card display:flex oldugundan <strong> ayri sutuna
    // dusuyordu (metin iki parca gorunuyordu).
    el.innerHTML = html ? ('<span>' + html + '</span>') : '';
    el.style.display = html ? 'flex' : 'none';
  });
  updateDlFolderPreview();
}

function setupDlNaming() {
  ['dl-naming-group', 'dl-naming-group-i2v'].forEach(gid => {
    const g = document.getElementById(gid);
    if (!g) return;
    g.querySelectorAll('.seg-btn').forEach(b => b.addEventListener('click', () => {
      dlNaming = b.dataset.name || 'num';
      try { chrome.storage.local.set({ afDlNaming: dlNaming }); } catch (_) {}
      renderDlNaming();
    }));
  });
  renderDlNaming();
}

// -- v175 BASLANGIC NUMARASI ARAYUZU ------------------------------------------
// Iki sekmedeki kutu (Control + Foto->Video) ayni degeri gosterir. Yalnizca tam sayi kabul edilir;
// bos, 0, ondalik ya da harf -> 1 (eski davranis). Deger depoya yazilir, arka uc akis/indirme
// basladiginda okur ve o kosu icin sabitler.
function cleanStartNum(v) {
  const s = String(v == null ? '' : v).trim();
  if (!/^\d+$/.test(s)) return 1;
  const n = parseInt(s, 10);
  return n >= 1 ? Math.min(n, 99999) : 1;
}

function syncDlStartNumUi(except) {
  ['dl-startnum', 'dl-startnum-i2v'].forEach(id => {
    const el = document.getElementById(id);
    if (el && el !== except && el.value !== String(dlStartNum)) el.value = String(dlStartNum);
  });
}

function saveDlStartNum() {
  try { chrome.storage.local.set({ afDlStartNum: dlStartNum }); } catch (_) {}
}

function setupDlStartNum() {
  const inputs = ['dl-startnum', 'dl-startnum-i2v']
    .map(id => document.getElementById(id)).filter(Boolean);
  inputs.forEach(inp => {
    // Yazarken kutu gecici olarak bos kalabilir; o an deger degistirilmez, kutudan cikinca 1'e doner.
    inp.addEventListener('input', () => {
      if (String(inp.value).trim() === '') return;
      dlStartNum = cleanStartNum(inp.value);
      syncDlStartNumUi(inp);
      updateDlFolderPreview();
      saveDlStartNum();
    });
    inp.addEventListener('change', () => {
      dlStartNum = cleanStartNum(inp.value);
      syncDlStartNumUi(null);
      updateDlFolderPreview();
      saveDlStartNum();
    });
  });
  syncDlStartNumUi(null);
}

function setupTabsAndPanels() {
  document.querySelectorAll('#tabbar .tab').forEach(b =>
    b.addEventListener('click', () => setActiveTab(b.dataset.tab)));

  document.querySelectorAll('.logs-filter').forEach(b =>
    b.addEventListener('click', () => {
      logsFilter = b.dataset.logf;
      document.querySelectorAll('.logs-filter').forEach(x => x.classList.toggle('active', x === b));
      renderLogs();
    }));
  document.getElementById('logs-search').addEventListener('input', renderLogs);
  document.getElementById('logs-clear').addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'clearLogs' }).catch(() => {});
    logsData = []; renderLogs();
  });
  document.getElementById('logs-copy').addEventListener('click', () => {
    const text = logsData.map(e => fmtLogTime(e.t) + '  ' + e.msg).join('\n');
    navigator.clipboard.writeText(text).then(() => showNotif(t('logs_copied'), 'success')).catch(() => {});
  });
  // v171: Logs sekmesindeki buton KAYITLARI .txt olarak indirir. (Eskiden toplu GORSEL
  // indirmeyi baslatiyordu; o is Control/Foto->Video sekmelerindeki "Sonradan indir"de duruyor.)
  document.getElementById('logs-download').addEventListener('click', downloadLogsFile);

  // Kuyruğu Temizle: prompt kutusu + arka plandaki kuyruk state'i sıfırlanır.
  // Akış çalışırken izin verilmez (üretim state.prompts üzerinden yürür).
  const queueClearBtn = document.getElementById('btn-queue-clear');
  if (queueClearBtn) queueClearBtn.addEventListener('click', async () => {
    if (qState && (qState.status === 'running' || qState.status === 'paused')) {
      showNotif(t('queue_clear_running'), 'error');
      return;
    }
    const prompts = (qState && qState.prompts && qState.prompts.length) ? qState.prompts : getPrompts();
    if (!prompts.length) return;
    if (!confirm(t('queue_clear_confirm').replace('{n}', prompts.length))) return;
    const ta = document.getElementById('prompt-input');
    if (ta) ta.value = '';
    renderDlNaming(); // v150: kutu bosaldi -> damga uyarisi da kalksin
    updateLineCount();   // satır sayacı + afPromptDraft taslağı temizlenir
    updateMapSummary();
    try { await chrome.runtime.sendMessage({ action: 'clearQueue' }); } catch (_) {}
    qState = null;
    renderQueue();
    showNotif(t('queue_cleared'), 'success');
  });
}

// ── Init ───────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {

  // Dil seçici
  const langSelect = document.getElementById('lang-select');
  const langBtn    = document.getElementById('lang-btn');
  langBtn.addEventListener('click', e => {
    e.stopPropagation();
    langSelect.classList.toggle('open');
  });
  document.addEventListener('click', e => {
    if (!langSelect.contains(e.target)) langSelect.classList.remove('open');
  });

  // Giriş / çıkış
  document.getElementById('btn-google').addEventListener('click', handleSignIn);
  document.getElementById('btn-signout').addEventListener('click', handleSignOut);
  document.getElementById('btn-upgrade').addEventListener('click', handleUpgrade);

  // Avatar menüsü aç/kapa + dışarı tıklayınca kapan
  const avatarBtn = document.getElementById('acc-avatar-btn');
  const accMenu   = document.getElementById('acc-menu');
  if (avatarBtn && accMenu) {
    avatarBtn.addEventListener('click', e => {
      e.stopPropagation();
      accMenu.style.display = (accMenu.style.display === 'none' || !accMenu.style.display) ? 'flex' : 'none';
    });
    document.addEventListener('click', e => {
      if (!accMenu.contains(e.target) && e.target !== avatarBtn && !avatarBtn.contains(e.target)) {
        accMenu.style.display = 'none';
      }
    });
  }

  // Panele geri dönünce (ödeme sekmesinden vb.) Pro durumunu tazele
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && currentUser) refreshAuth();
  });
  window.addEventListener('focus', () => { if (currentUser) refreshAuth(); });

  // Referans sistemi (Shared / Map / Library)
  setupReferenceUI();

  // Görselden Video (I2V) kartı
  setupI2vUI();
  setupRateCard();
  setupCrossPromo();

  // Sekmeler + Gallery + Logs
  setupTabsAndPanels();

  // Oto indirme toggle — Control ve Görselden Video sekmelerindeki kopyalar senkron
  // v149 Kayit klasoru (iki sekmedeki kopya senkron)
  setupDlFolder();
  // v151 Dosya adi modu (iki sekmedeki kopya senkron)
  setupDlNaming();
  setupDlStartNum();   // v175

  const dlToggles = [
    { chk: document.getElementById('chk-download'),     opts: document.getElementById('dl-opts') },
    { chk: document.getElementById('chk-download-i2v'), opts: document.getElementById('dl-opts-i2v') }
  ].filter(x => x.chk && x.opts);
  const syncDlToggles = () => dlToggles.forEach(({ chk, opts }) => {
    chk.checked = autoDownload;
    if (autoDownload) {
      opts.style.display       = 'flex';
      opts.style.flexDirection = 'column';
      opts.style.gap           = '9px';
    } else {
      opts.style.display = 'none';
    }
  });
  dlToggles.forEach(({ chk }) => chk.addEventListener('change', () => {
    autoDownload = chk.checked;
    syncDlToggles();
  }));

  // "Sonradan indir" — oto indirme kapalıyken (veya sonradan) üretilen TÜM görselleri
  // seçili kaliteyle, en eskiden başlayıp sırayla, doğru numaralandırmayla indirir.
  const dlLaterBtns = ['btn-download-later', 'btn-download-later-i2v']
    .map(id => document.getElementById(id)).filter(Boolean);
  const onDlLaterClick = async () => {
    // ÇALIŞIYORSA → DURDUR (panel kapansa bile SW'de sürdüğü için durdurma şart)
    if (bulkDownloading) {
      await chrome.runtime.sendMessage({ action: 'cancelDownloadAll' }).catch(() => {});
      showNotif(t('dl_all_stopped'), 'info');
      return;
    }
    // DEĞİLSE → İNDİR. Aktif Flow sekmesinde (hangi proje açıksa) sıralı indirir.
    if (!flowTab) { showNotif(t('dl_later_no_tab'), 'error'); return; }
    dlLaterBtns.forEach(b => { b.disabled = true; });
    try {
      const r = await chrome.runtime.sendMessage({
        action: 'downloadAll', tabId: flowTab.id, flowUrl: flowTab.url || '',
        dlQualityImg, dlQualityVid, genSettings: buildGenSettings(),
        // Foto→Video sekmesinden VEYA VİDEO modundan indirme → yalnız videolar insin (referans görseller değil)
        videoOnly: (activeTab === 'i2v' || genMode === 'VIDEO')
      });
      // İYİMSER GÜNCELLEME: indirme başladıysa (veya zaten çalışıyorsa=busy) butonu HEMEN
      // "Durdur"a çevir — broadcast'in gelmesini bekleme. Böylece buton kesin görünür ve
      // kullanıcı her zaman durdurabilir.
      if (r && (r.success || r.error === 'busy')) {
        updateDownloadLaterBtn({ bulkDownloading: true });
      }
      showNotif((r && r.success) ? t('dl_all_started') : t('dl_all_busy'),
                (r && r.success) ? 'success' : 'info');
    } catch (_) {}
    setTimeout(() => { dlLaterBtns.forEach(b => { b.disabled = false; }); }, 1500);
  };
  dlLaterBtns.forEach(b => b.addEventListener('click', onDlLaterClick));

  // "Oto indirmeyi durdur" — aktif oto indirme pipeline'ını bağımsız durdurur.
  const stopAutoDlBtns = ['btn-stop-autodl', 'btn-stop-autodl-i2v']
    .map(id => document.getElementById(id)).filter(Boolean);
  const onStopAutoDlClick = async () => {
    stopAutoDlBtns.forEach(b => { b.disabled = true; });
    try {
      await chrome.runtime.sendMessage({ action: 'stopAutoDownload' }).catch(() => {});
      stopAutoDlBtns.forEach(b => { b.style.display = 'none'; }); // iyimser: hemen gizle
      showNotif(t('dl_all_stopped'), 'info');
    } catch (_) {}
    setTimeout(() => { stopAutoDlBtns.forEach(b => { b.disabled = false; }); }, 1500);
  };
  stopAutoDlBtns.forEach(b => b.addEventListener('click', onStopAutoDlClick));

  // Görsel/Video kalite chip'leri — iki sekmedeki gruplar senkron (tıklanan değeri
  // hepsine yansıt; davranış tek gruplu eski haliyle birebir aynı)
  const wireQualityChips = (groupIds, setQ, getQ) => {
    groupIds.forEach(gid => {
      const g = document.getElementById(gid);
      if (!g) return;
      g.querySelectorAll('.qchip').forEach(btn => {
        btn.addEventListener('click', () => {
          setQ(btn.dataset.q);
          groupIds.forEach(gid2 => {
            const g2 = document.getElementById(gid2);
            if (!g2) return;
            g2.querySelectorAll('.qchip').forEach(b => b.classList.toggle('active', b.dataset.q === getQ()));
          });
        });
      });
    });
  };
  wireQualityChips(['img-quality-group', 'img-quality-group-i2v'], v => { dlQualityImg = v; }, () => dlQualityImg);
  wireQualityChips(['vid-quality-group', 'vid-quality-group-i2v'], v => { dlQualityVid = v; }, () => dlQualityVid);

  // Üretim ayarları: Flow'dan getir + mode değişimi + model seçimi
  document.querySelectorAll('#gen-mode-group .seg-btn').forEach(b => {
    b.addEventListener('click', () => {
      genMode = b.dataset.mode;
      markModeActive();
      renderGen(genMode); // sabit listeden göster — Flow'a DOKUNMAZ
    });
  });
  // Model değişince süre listesi tazelenir: 10s YALNIZ Omni Flash'ta görünür,
  // başka modele geçilince seçim geçersiz kalırsa varsayılana (8s) düşer.
  document.getElementById('gen-model').addEventListener('change', e => {
    genModel = e.target.value;
    renderGenResolution();
    renderGenDuration();
  });

  // Açılışta sabit seçenekleri doldur (Flow bağlantısından bağımsız)
  markModeActive();
  renderGen(genMode);

  // Aksiyon butonları
  document.getElementById('btn-start').addEventListener('click', handleStart);
  // Duraklat/Devam BASMA anında işlenir: 'click' olayı yalnız mouseup'tan SONRA ve mousedown
  // hedefi DOM'da kaldıysa üretilir; pointerdown ile o pencereye hiç girilmez (klavye ve
  // pointer desteklemeyen ortamlar için 'click' yedekte durur — 700 ms guard'ı ikisini tek
  // işlem sayar, çift toggle olmaz).
  const btnPauseEl = document.getElementById('btn-pause');
  btnPauseEl.addEventListener('pointerdown', e => { if (e.button === 0) handlePause(); });
  btnPauseEl.addEventListener('click', handlePause);
  document.getElementById('btn-stop').addEventListener('click',  handleStop);

  // Flow aç
  document.getElementById('conn-btn').addEventListener('click', () => {
    chrome.tabs.create({ url: 'https://labs.google/fx/tools/flow' });
  });

  // Interval kontrolleri — Control + Foto→Video sekmelerindeki kopyalar senkron
  // (.qchip[data-s] seçicileri global olduğundan hızlı çipler iki sekmede otomatik senkron)
  [['interval-input', 'btn-plus', 'btn-minus'], ['interval-input-i2v', 'btn-plus-i2v', 'btn-minus-i2v']]
    .forEach(([inpId, plusId, minusId]) => {
      const inp = document.getElementById(inpId);
      if (inp) inp.addEventListener('change', e => setIntervalSecs(parseInt(e.target.value) || 90));
      const plus = document.getElementById(plusId);
      if (plus) plus.addEventListener('click', () => setIntervalSecs(selectedSecs + 10));
      const minus = document.getElementById(minusId);
      if (minus) minus.addEventListener('click', () => setIntervalSecs(selectedSecs - 10));
    });

  document.querySelectorAll('.qchip[data-s]').forEach(chip => {
    chip.addEventListener('click', () => setIntervalSecs(parseInt(chip.dataset.s)));
  });

  // Prompt sayacı
  document.getElementById('prompt-input').addEventListener('input', () => {
    updateLineCount();
    updateMapSummary();
    renderDlNaming(); // v150: eksik zaman damgasi uyarisi + dosya adi onizlemesi
    if (!qState || qState.status === 'idle') renderQueue(); // boşta yazarken önizleme güncel
  });

  // Prompt .txt dosyadan yükleme
  const promptUploadBtn = document.getElementById('btn-prompt-upload');
  const promptFileInput = document.getElementById('prompt-file-input');
  if (promptUploadBtn && promptFileInput) {
    promptUploadBtn.addEventListener('click', () => promptFileInput.click());
    promptFileInput.addEventListener('change', e => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = ev => {
        const text = String(ev.target.result || '')
          .replace(/\r\n/g, '\n').replace(/\r/g, '\n');
        const ta = document.getElementById('prompt-input');
        const existing = ta.value.trim();
        // Mevcut metin varsa alt satıra ekle, yoksa doğrudan yaz
        ta.value = existing ? (existing + '\n' + text.trim()) : text.trim();
        updateLineCount();
        renderDlNaming(); // v150: .txt yuklendi -> damga uyarisi/onizleme tazelensin
        const n = parseInt(document.getElementById('line-count').textContent) || 0;
        showNotif(t('prompt_loaded').replace('{n}', n), 'success');
      };
      reader.readAsText(file);
      promptFileInput.value = ''; // aynı dosya tekrar seçilebilsin
    });
  }

  // Arka plan güncellemeleri
  chrome.runtime.onMessage.addListener(msg => {
    if (msg.type === 'stateUpdate') {
      clearPauseIntent(msg.state);   // niyet YALNIZ arka uç yayınıyla düşer (kendi çizimimizle değil)
      renderDynamic(msg.state);
      updateDownloadLaterBtn(msg.state);
      updateStopAutoDlBtn(msg.state);
      qState = msg.state; renderQueue();
      if (Array.isArray(msg.state.logs)) setLogs(msg.state.logs);
      if (typeof msg.usageCount === 'number') {
        todayUsage = msg.usageCount;
        chrome.storage.local.set({ todayUsage, usageDate: todayStr() });
        renderAccount();
        applyStartGate();
      }
    } else if (msg.type === 'log') {
      appendLog(msg.entry);
    } else if (msg.type === 'queueDl') {
      // v170: bir dosya indi -> yalniz Queue satirlari tazelenir (tam durum yayini beklenmez)
      if (qState) {
        qState.dlSavedSlots = msg.dlSavedSlots || {};
        qState.dlTrackPrompts = !!msg.dlTrackPrompts;
        renderQueue();
      }
    }
  });

  boot();
});

// ══════════════════════════════════════════════════════════════════════
// DUYURU ZİLİ (header, Language'in solunda)
// ══════════════════════════════════════════════════════════════════════
// Kırmızı nokta: kullanıcı duyuruyu AÇANA kadar yanar; açınca kalıcı olarak söner.
// Duyuru metni 6 dilde i18n'den gelir (notice_title / notice_body / notice_ok / notice_rate)
// ve dil değiştirilince applyI18n ile kendiliğinden güncellenir.
// YENİ DUYURU YAYINLAMAK İÇİN: NOTICE_ID'yi değiştir → kırmızı uyarı herkeste tekrar yanar.
const NOTICE_ID = 'flow-v2-2026-09';
async function initNoticeBell() {
  const btn = document.getElementById('bell-btn');
  const ov  = document.getElementById('notice-overlay');
  if (!btn || !ov) return;
  let seen = '';
  try { seen = (await chrome.storage.local.get('afNoticeSeen')).afNoticeSeen || ''; } catch (_) {}
  if (seen !== NOTICE_ID) btn.classList.add('has-news');

  const close = () => { ov.style.display = 'none'; };
  const open  = () => {
    ov.style.display = 'flex';
    btn.classList.remove('has-news');
    try { chrome.storage.local.set({ afNoticeSeen: NOTICE_ID }); } catch (_) {}
  };
  btn.addEventListener('click', open);
  const x = document.getElementById('notice-close-x');
  if (x) x.addEventListener('click', close);
  const ok = document.getElementById('notice-ok');
  if (ok) ok.addEventListener('click', close);
  ov.addEventListener('click', e => { if (e.target.id === 'notice-overlay') close(); });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && ov.style.display === 'flex') close();
  });
  const rate = document.getElementById('notice-rate');
  if (rate) rate.addEventListener('click', e => {
    e.preventDefault();
    try { chrome.tabs.create({ url: 'https://chromewebstore.google.com/detail/' + chrome.runtime.id + '/reviews' }); } catch (_) {}
  });
}
