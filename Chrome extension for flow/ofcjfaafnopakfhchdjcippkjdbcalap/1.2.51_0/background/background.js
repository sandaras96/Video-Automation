// AutoFlow Pro — Background Service Worker

// SW yüklenme damgası — her SW örneği benzersiz bir id ile bir kez loglar.
// Konsolda iki FARKLI id görürsen iki SW örneği var demektir (reload sırasında
// eski+yeni birlikte yaşamış). Yeni kodun aktif olduğunu da bu satır doğrular.
const SW_ID = Math.random().toString(36).slice(2, 7);
const AF_BUILD = 'v176-anchor-miss'; // start/bulk loglarına yazılır → LevelDB'den aktif sürüm doğrulanabilir
console.log('[AutoFlow] SW yüklendi — build:' + AF_BUILD + ' | SW_ID=' + SW_ID);

// Side panel SEKMEYE ÖZEL: ikona hangi sekmede tıklandıysa panel YALNIZ o sekmede açılır;
// başka sekmeye geçince Chrome paneli otomatik gizler, o sekmeye dönünce geri getirir.
// Mekanizma: global (tabId'siz) panel DEVRE DIŞI bırakılır; ikon tıklanınca panel yalnız
// o sekme için etkinleştirilip açılır. openPanelOnActionClick KAPALI olmalı ki tıklama
// action.onClicked'e düşsün (açıkken onClicked hiç tetiklenmez). Otomasyona etkisi YOK:
// üretim/indirme background SW'de sabit state.tabId ile yürür, panelin görünürlüğünden bağımsız.
// EDGE İSTİSNASI: Edge, chrome.sidePanel API'sini destekler AMA sekmeye-özel paneli
// Chrome gibi yönetmez — panelin açıldığı sekmeye GERİ DÖNÜLDÜĞÜNDE panel GERİ GELMİYOR
// (kullanıcı bildirdi, bilinen davranış farkı). Edge'de eski GLOBAL davranışa dönülür:
// ikona tıklayınca panel açılır ve tüm sekmelerde görünür kalır (v92 ve öncesi davranış).
const IS_EDGE = typeof navigator !== 'undefined' && /Edg\//.test(navigator.userAgent || '');
if (IS_EDGE) {
  try { chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }); } catch (_) {}
} else {
try { chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }); } catch (_) {}
try { chrome.sidePanel.setOptions({ enabled: false }); } catch (_) {} // global panel kapalı (yalnız varsayılanı değiştirir, sekmeye-özel ayarları EZMEZ)
chrome.action.onClicked.addListener((tab) => {
  // KRİTİK: open() KULLANICI JESTİ gerektirir ve jest `await` SONRASINDA KAYBOLUR
  // (v93'te await'li hali yüzünden panel HİÇ açılmıyordu). Bu yüzden iki çağrı da
  // AYNI SENKRON task içinde yapılır; Chrome API çağrılarını gönderim sırasıyla işler
  // (önce setOptions uygulanır, sonra open çalışır) → yarış yok, jest korunur.
  try {
    chrome.sidePanel.setOptions({ tabId: tab.id, path: 'sidepanel/sidepanel.html', enabled: true })
      .catch(e => console.warn('[AutoFlow] side panel setOptions:', e && e.message));
    chrome.sidePanel.open({ tabId: tab.id })
      .catch(e => console.warn('[AutoFlow] side panel açılamadı:', e && e.message));
  } catch (e) { console.warn('[AutoFlow] side panel açılamadı:', e && e.message); }
});
} // IS_EDGE else sonu — Chrome'a özel sekme-bazlı panel bloğu

// FLOW YÜKLEME LİMİTİ: Flow tek seçimde en çok ~20 görsel kabul ediyor (fazlası
// "N görsel yüklenemedi" uyarısı verir). Bu yüzden referanslar 20'ŞERLİ PARTİLER
// halinde yüklenir: bir prompt'a gelindiğinde ait olduğu 20'lik parti henüz
// yüklenmediyse yalnız o parti yüklenir (sonraki parti, akış oraya gelince).
const REF_BATCH = 20;
// v121: Kareler yolunda kart henüz hazır değilse (Flow dosyayı hâlâ işliyorsa) promptu
// karesiz göndermeden önce kaç kez ve ne kadar aralıkla yeniden denenir (en fazla ~36 sn).
const FRAME_RETRY = 3;
const FRAME_WAIT  = 12000;

let state = {
  status: 'idle', prompts: [], currentIndex: 0,
  interval: 90, tabId: null, currentUsage: 0, currentPrompt: '',
  refImages: [], autoDownload: false, dlQualityImg: '1k', dlQualityVid: '720p',
  staged: false,   // true = refs+prompt hazır, sadece gönderi bekleniyor
  dlIndex: 0,      // sıralı indirme: indirilecek bir sonraki tile (en eski = 0)
  autoDlActive: false, // oto indirme pipeline'ı aktif mi → sidepanel "Oto indirmeyi durdur" butonu
  prevZoom: 1,         // oto indirme açıkken zoom %33'e çekilir; bitince bu değere döner
  zoomForced: false    // zoom %33'e zorlandı mı (çıkışta geri almak için bayrak)
};

// ── UI kilidi ──────────────────────────────────────────
// Üretim (picker/prompt/gönder) ve indirme (sağ tık menüsü) aynı sekmede
// çalıştığından çakışmasınlar. Üretim her zaman öncelikli: kilidi uzun süre
// bekler. İndirme kilidi yalnızca kısa DOM etkileşimi (sağ tık → menü) için
// tutar, upscale/indirme beklemesi sırasında BIRAKIR → üretim hiç durmaz.
let uiLock = false;
let uiPriorityPending = 0; // >0: ÜRETİM (otomasyon) kilidi bekliyor/tutuyor → indirme yol verir
// priority=true (üretim): hemen sıraya girer, indirmenin önüne geçer.
// priority=false (indirme): üretim beklerken/ tutarken kilidi ALMAZ → yalnızca promptlar
//   arası boşlukta çalışır. Böylece indirme, prompt göndermeyi ASLA bekletmez (bağımsız his).
async function acquireUi(maxWaitMs, priority) {
  if (priority) uiPriorityPending++;
  const start = Date.now();
  while (uiLock || (!priority && uiPriorityPending > 0)) {
    if (Date.now() - start > maxWaitMs) { if (priority) uiPriorityPending--; return false; }
    await sleep(120);
  }
  uiLock = true;
  return true;
}
function releaseUi(priority) { uiLock = false; if (priority) uiPriorityPending--; }
async function withUi(fn) {
  const ok = await acquireUi(600000, true); // ÜRETİM = öncelikli; indirme buna yol verir
  // ok=false (zaman aşımı): acquireUi sayacı ZATEN azalttı ve kilit BİZDE DEĞİL →
  // releaseUi çağırmak sayacı ikinci kez azaltıp (negatif) başkasının kilidini de
  // yanlışlıkla açardı. fn yine çalışır (eski davranış) ama muhasebe bozulmaz.
  try { return await fn(); } finally { if (ok) releaseUi(true); }
}

// ── Sıralı indirme durumu ──────────────────────────────
let dlRestarts = 0;   // v130: beklenmedik hata sonrası indirme hattı kaç kez yeniden başlatıldı
let dlLoopActive = false;
let dlCancel = false; // "Sonradan indir" (manuel) iptal bayrağı → pipeline döngüsü kontrol eder
let dlRunToken = 0;   // her pipeline başlangıcında artar; eski (takılı) döngü token uyuşmazsa çıkar
                      // → Durdur sonrası zorla sıfırlama + yeniden başlatmada ÇİFT DÖNGÜ olmaz

// SW başlangıç init'i (state'i depodan yükler) bir promise olarak açılır. Manuel indirme
// başlamadan ÖNCE bunu bekleriz → soğuk başlangıçta state (refImages/ayarlar) yüklenmeden
// pipeline başlamaz ve init ile pipeline ARASINDA state-ezme yarışı olmaz ("Durdur" çıkmama).
let resolveInit;
const initReady = new Promise(r => { resolveInit = r; });

// Flow sekmesi şu an kullanıcıya görünür (render ediliyor) mu?
// Chrome arka plandaki/üstü kapalı/küçültülmüş sekmeleri render etmeyi durdurur;
// o sırada getBoundingClientRect/elementFromPoint bozulur → indirme imleci yanlış
// tile'a kayıp AYNI görseli tekrar indirebilir. 'hidden' ise indirmeyi duraklatırız.
async function isFlowVisible() {
  try {
    const res = await chrome.scripting.executeScript({
      target: { tabId: state.tabId }, world: 'MAIN',
      func: () => document.visibilityState
    });
    return res?.[0]?.result || 'visible';
  } catch (_) {
    return 'visible'; // okunamadıysa eski davranışı koru (engelleme)
  }
}

// v175 GERCEK GORUNURLUK IZLEMESI (yalniz teshis logu, akisin hicbir kararini DEGISTIRMEZ).
// installPageWaitHelper sayfaya "hep gorunur" maskesi kurdugu icin document.visibilityState
// artik hep 'visible' der; gercek deger Document.prototype'taki ozgun getter'dan okunur.
// Musteri vakasi 2026-09-15: sekme ~40. dakikadan sonra gorunmez kaldi, Chrome sayfayi kisti,
// referans secimi prompt basina 5-7 dk surdu ve kosu 58/177'de takildi; Logs'ta bunu anlatan
// tek satir yoktu. Artik sekme 60 sn'den uzun gorunmez kalirsa BIR KEZ yazilir, geri donunce
// ne kadar gizli kaldigi yazilir. Kontrol en fazla 15 sn'de bir, tek satirlik okuma.
let visHiddenSince = 0, visHiddenLogged = false, visLastCheck = 0;
async function afWatchVisibility(tabId) {
  if (!tabId || Date.now() - visLastCheck < 15000) return;
  visLastCheck = Date.now();
  let v = '';
  try {
    const r = await chrome.scripting.executeScript({
      target: { tabId }, world: 'MAIN',
      func: function afRealVisibility() {
        try {
          const d = Object.getOwnPropertyDescriptor(Document.prototype, 'visibilityState');
          return (d && d.get) ? d.get.call(document) : document.visibilityState;
        } catch (_) { return ''; }
      }
    });
    v = (r && r[0] && r[0].result) || '';
  } catch (_) { return; }
  if (v === 'hidden') {
    if (!visHiddenSince) visHiddenSince = Date.now();
    if (!visHiddenLogged && Date.now() - visHiddenSince >= 60000) {
      visHiddenLogged = true;
      logEvent('info', 'Flow sekmesi ekranda görünmüyor (pencere simge durumunda, önde başka sekme/pencere var ya da ekran kilitli/kapalı). ' +
        'Chrome görünmeyen sekmeyi yavaşlatır; akış sürer ama en sağlıklısı Flow sekmesini açık ve ekranda tutmaktır. | ' +
        'The Flow tab is not visible (window minimized, another tab/window in front, or screen locked/off). ' +
        'Chrome slows hidden tabs down; the run continues, but keeping the Flow tab open and on screen is the most reliable.');
    }
  } else if (v === 'visible') {
    if (visHiddenLogged) {
      const mins = Math.max(1, Math.round((Date.now() - visHiddenSince) / 60000));
      logEvent('info', 'Flow sekmesi yeniden ekranda (yaklaşık ' + mins + ' dk görünmez kaldı) | ' +
        'The Flow tab is visible again (hidden for about ' + mins + ' min)');
    }
    visHiddenSince = 0; visHiddenLogged = false;
  }
}
// onDeterminingFilename sırasında dosyayı yeniden adlandırmak için.
// Yalnızca biz indirme tetiklerken set edilir (Flow indirmeleri tek tek bizden).
let pendingDownloadBase = null; // { folder, num, isVideo, id, resolveDone }

// --- v149 KAYIT KLASORU (kullanici secimi) ---------------------------------
// Chrome eklentileri MUTLAK disk yolu SECEMEZ: chrome.downloads.download({filename}) ve
// onDeterminingFilename yalnizca tarayicinin varsayilan Indirilenler klasorune GORELI yol
// kabul eder (mutlak yol veya ".." -> indirme reddedilir). Bu yuzden kullanicidan alt
// klasor aliyoruz: Indirilenler/<kok>/AutoFlow-YYYYMMDD-HHMMSS/0001.ext
// Baska bir diske kaydetmek isteyen kullanici Chrome'un indirme konumunu degistirir; biz
// goreli yol verdigimiz icin dosyalar oraya iner. Ayar BOSSA davranis eskisiyle birebir ayni.
let afDlRoot  = '';   // temizlenmis alt klasor yolu ('' = dogrudan Indirilenler)
let afDlDated = true; // her akis icin tarihli alt klasor (varsayilan: eski davranis)

// Kullanici metnini Chrome'un kabul ettigi GUVENLI goreli yola cevir. Gecersizse '' doner
// -> eski davranis. (Surucu harfi, mutlak yol, "..", yasak karakterler ve Windows'un
// ayrilmis adlari temizlenir; en fazla 4 seviye, seviye basina 40, toplam 120 karakter.)
function sanitizeDlRoot(raw) {
  let s = String(raw == null ? '' : raw).trim();
  if (!s) return '';
  // Windows ters bolu -> normal bolu (ters bolu karakteri kod ile: 92)
  s = s.split(String.fromCharCode(92)).join('/');
  s = s.replace(/^[a-zA-Z]:/, '');  // "C:" surucu harfi (mutlak yol desteklenmiyor)
  const parts = [];
  for (let p of s.split('/')) {
    p = p.replace(/[<>:"|?*\x00-\x1F]/g, '')  // dosya sisteminde yasak karakterler
         .replace(/^[.\s]+|[.\s]+$/g, '')     // bastaki/sondaki nokta ve bosluk
         .trim();
    if (!p || p === '.' || p === '..') continue;
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(p)) p = '_' + p; // Windows ayrilmis ad
    parts.push(p.slice(0, 40));
    if (parts.length >= 4) break;
  }
  return parts.join('/').slice(0, 120).replace(/\/+$/, '');
}

// --- v150 DOSYA ADI ETIKETI (numara | prompt | zaman damgasi) ---------------
// NUMARA MANTIGI HIC DEGISMEDI: 'num' yine kacinci prompt oldugunu soyler, dlNumMap /
// promptMediaMap / bosluk korumasi zinciri aynen calisir. Burada yapilan TEK sey, dosya
// adinda numaranin YANINA bir etiket koymak. Etiket uretilemezse ad yine SADECE numaradir.
let afDlNaming = 'num'; // 'num' (varsayilan = eski davranis) | 'prompt' | 'time' | 'numtime'

// Zaman damgasi: (0:00) [1:02:03] 0:05 00:00:07,966 ... Saniye MUTLAKA iki haneli
// olmali; boylece "16:9 sinematik plan" gibi prompt basi oran ifadeleri zaman
// damgasi sanilmaz.
//
// v164: SANIYE ALTI. SRT satirlari "00:00:07,966" gibi geliyor; eskiden virgulden
// sonrasi yakalanmiyordu ve iki sey birden bozuluyordu:
//   1) dosya adina yalnizca 00-00-07 yaziliyor, 966 ms kayboluyordu,
//   2) damga Flow'a gonderilmeyecegi zaman metinden yalnizca "00:00:07" kirpiliyor,
//      geriye ",966 - ..." kaliyor ve prompt oyle gidiyordu.
// Dorduncu grup kesirli kismi alir (nokta ya da virgul).
const AF_TS_RE = /^\s*[([{]?\s*(\d{1,3}):([0-5]\d)(?::([0-5]\d))?(?:[.,](\d{1,3})(?!\d))?\s*[)\]}]?/;

// '0:05' -> '00-05', '1:02:03' -> '01-02-03' (iki nokta Windows'ta yasak karakter).
// Saniye alti varsa NOKTA ile eklenir: '00:00:07,966' -> '00-00-07.966'. Ayirac
// bilerek farkli: tire zaman birimlerini, nokta kesiri ayirir, boylece okuyan taraf
// '00-05-30' (5 dk 30 sn) ile '00-05.300' (5 sn 300 ms) arasinda karar verebilir.
function afTsLabel(p) {
  const m = AF_TS_RE.exec(String(p == null ? '' : p));
  if (!m) return '';
  const pad = n => String(n).padStart(2, '0');
  const base = m[3] ? (pad(m[1]) + '-' + pad(m[2]) + '-' + pad(m[3])) : (pad(m[1]) + '-' + pad(m[2]));
  // '966' -> 966 ms, '5' -> 500 ms: saga sifirla tamamla.
  return m[4] ? base + '.' + (m[4] + '00').slice(0, 3) : base;
}

// Prompt metninden dosya adina uygun kisa etiket (bastaki zaman damgasi atilir).
function afPromptLabel(p) {
  // v169: SRT ARALIGINDA ("[00:00:00,000 --> 00:00:02,745] metin") eski kod yalniz BASTAKI
  // damgayi atiyordu, dosya adi "-- 00 00 02,745] metin" diye basiliyordu (v168'in metin
  // tarafinda cozdugu hatanin dosya adi ikizi). Artik ayni kirpma kullaniliyor. Tek damgali
  // ve damgasiz promptlarda sonuc BIREBIR eskisi gibi.
  const raw = String(p == null ? '' : p);
  const cut = afCutLeadStamp(raw);
  let s = (cut == null) ? raw : cut;
  s = s.split(String.fromCharCode(92)).join(' ');   // ters bolu -> bosluk
  s = s.replace(/[<>:"/|?*\x00-\x1F]/g, ' ')        // dosya adinda yasak karakterler
       .replace(/\s+/g, ' ')                        // satir sonu / coklu bosluk -> tek bosluk
       .trim()
       .slice(0, 40)
       .replace(/^[.\s]+|[.\s]+$/g, '');            // bas/son nokta-bosluk (gizli dosya olmasin)
  return s;
}

// Dosya adi Chrome tarafindan KABUL EDILEBILIR mi? Etiket artik tek basina dosya adi
// oldugundan (onunde numara yok) Windows'un ayrilmis adlari da kontrol edilir. Gecersiz bir
// ad Chrome tarafindan REDDEDILIR ve dosya klasor disina kendi adiyla inerdi; en ufak
// suphede numarali eski davranisa donuyoruz.
function afSafeFileBase(b) {
  if (!b || b.length > 60) return false;
  if (/[<>:"/|?*]/.test(b)) return false;                       // yasak karakterler
  if (b.indexOf(String.fromCharCode(92)) >= 0) return false;    // ters bolu
  if (/^[.\s]|[.\s]$/.test(b)) return false;                    // basta/sonda nokta veya bosluk
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(b)) return false; // Windows ayrilmis ad
  return true;
}

// ── v163 PROMPT BAŞINDAKİ ZAMAN DAMGASI FLOW'A GÖNDERİLMEZ (KOŞULLU) ──────────
// Kullanıcı raporu 2026-09-08: görsel modeli bazen baştaki "(0:05)" damgasını ÜRETİLEN
// GÖRSELİN İÇİNE yazıyor. Damga bizim için metadata (dosya adı), Flow'un görmesine gerek yok.
// AMA "her sayıyı at" DENEMEZ: "12:30 on a clock face" gerçekten görselde istenen bir sayı
// olabilir. Bu yüzden YALNIZCA iki KESİN durumda ayıklanır:
//   (a) Dosya adı modu "zaman damgası" ise → kullanıcı zaten "bunlar damga" demiştir
//       (üstelik o modda damgasız prompt varsa akış zaten başlatılmıyor),
//   (b) Damga PARANTEZ/KÖŞELİ PARANTEZ içindeyse VE listenin GENELİ damgalıysa →
//       "(0:05)" bir işaret, içerik değil; çoğunluk şartı tek bir "(12:30) saat kadranı"
//       prompt'unun yanlışlıkla budanmasını engeller.
// Diğer her durumda (çıplak "12:30 ..." + numaralı/prompt adlandırma) HİÇBİR ŞEY değişmez.
// Ayıklama prompt'u boşaltacaksa dokunulmaz (asla boş prompt gönderilmez).
// v168 SRT ARALIGI: damga CIFT gelir -> "[00:08:07.348 --> 00:08:28.374] metin".
// AF_TS_RE yalniz BASTAKINI yakaladigi icin geriye "> 00:08:28.374] metin" kaliyordu.
// Iki ayri zarar veriyordu (kullanici logu 2026-09-10, Almanca diz videosu):
//   1) v163'un amaci yarim kaliyordu \u2014 model hala ekranda bir damga goruyor ve gorselin
//      icine yazabiliyordu,
//   2) DAHA AGIRI: Flow kartinin etiketi "> 00:08:28.374] Wide 16:9 photogra" oluyor,
//      bizim listemizdeki prompt ise "[00:08:07.348 --> ..." ile basliyor. Etiket artik
//      promptun ON EKI degil ORTASI oldugu icin promptCandidatesByText BOS donuyor
//      (logda metinAday:0/0) ve numaralandirmanin en guvenilir katmani sessizce oluyor.
// Ok isareti: -->, ->, =>, >, en dash, em dash.
const AF_TS_ARROW_RE = /^[\s]*(?:-{1,3}>|={1,2}>|>|\u2013|\u2014)[\s]*/;
// Damga/ok kalintisi temizleyicisi. '>' BILEREK burada: tek basina kalan ok ucu da gitsin.
const AF_TS_TRIM_RE = /^[\s:.,\u2013\u2014)\]}>=-]+/;
// v169: v168'in MEKANIK kirpmasi buraya alindi. Ayni kirpmayi hem Flow'a giden metin
// (stripLeadTs) hem de DOSYA ADI etiketi (afPromptLabel) kullansin diye; ikisi ayri
// kalinca dosya adi tarafinda SRT araligi yarim kirpiliyordu. Damga yoksa null doner.
function afCutLeadStamp(s) {
  const m = AF_TS_RE.exec(s);
  if (!m) return null;
  let rest = s.slice(m[0].length);
  // Bas damgadan sonra "ok + bitis damgasi" geliyorsa o da atilir. Ok YOKSA hicbir sey
  // yapilmaz -> tek damgali promptlarda davranis birebir eskisi gibi kalir.
  const arrow = AF_TS_ARROW_RE.exec(rest);
  if (arrow) {
    const after = rest.slice(arrow[0].length);
    const m2 = AF_TS_RE.exec(after);
    if (m2) rest = after.slice(m2[0].length);
  }
  return rest.replace(AF_TS_TRIM_RE, '');
}

function stripLeadTs(text, tsScript) {
  const s = String(text == null ? '' : text);
  const m = AF_TS_RE.exec(s);
  if (!m) return s;
  const bracketed = /^\s*[([{]/.test(s);
  // 'numtime' de kullanicinin "bunlar damga" dedigi bir mod, o yuzden 'time' ile ayni.
  const tsMode = (afDlNaming === 'time' || afDlNaming === 'numtime');
  if (!tsMode && !(bracketed && tsScript)) return s;
  const rest = afCutLeadStamp(s);
  return rest || s;
}

// DOSYA ADI. num = '0007' / '0007b' (kacinci prompt + o promptun kacinci ciktisi).
//   'num'    -> '0007'          (varsayilan, eski davranis)
//   'time'   -> '05-13'         (promptun basindaki zaman damgasi)
//   'prompt' -> 'prompt metni'  (promptun ilk 40 karakteri)
// NUMARA MANTIGI DEGISMEZ: hangi dosyanin hangi prompta ait oldugunu yine numaralandirma
// zinciri belirler, biz yalnizca o promptun etiketini yaziyoruz. Uretilemeyen promptun
// dosyasi hic olusmadigi icin "bosluk" kendiliginden korunur (o etiket hic inmez).
// Ayni promptun 2. 3. ciktisi varsa numarali moddaki 'b'/'c' harfi '_b' olarak korunur,
// yoksa iki dosya ayni adi alip birbirini ezerdi.
// Etiket uretilemezse ya da ad supheliyse SADE NUMARA (eski davranis) kullanilir.
// v169: dosya adi modu UYGULANAMADIGINDA kosuda BIR KEZ sebebini yazar ve duz numaraya
// doner. Eskiden sessizce numaraya dusuyordu: kullanici panelde "numara + zaman damgasi"
// secip duz 0001/0002 aliyor ve nedenini hicbir yerde goremiyordu (destek 2026-09-12).
// Karar mantigi DEGISMEDI, yalnizca sebep loglaniyor.
let dlNameWarned = false;   // her pipeline basinda sifirlanir
function afNameFallback(num, why) {
  if (!dlNameWarned) {
    dlNameWarned = true;
    const modeTr = afDlNaming === 'numtime' ? 'numara + zaman damgasi'
                 : afDlNaming === 'time'    ? 'zaman damgasi' : 'prompt metni';
    const REASON = {
      'proje-eslesmiyor':
        'bu indirme, eklentinin bu oturumda URETMEDIGI bir projeden yapiliyor (Sonradan indir). ' +
        'Prompt listesi olmadan hangi dosyanin hangi prompta ait oldugu bilinemez, yanlis etiket ' +
        'yazmak yerine duz numara kullanildi. Etiketli ad icin uretimi eklentiyle yapip ayni ' +
        'oturumda indirin. || this download is from a project the extension did not generate in ' +
        'this session (Download later). Without the prompt list the label would be wrong, so plain ' +
        'numbers were used. Generate with the extension and download in the same session for labels.',
      'damga-yok':
        'promptlarin basinda zaman damgasi yok (ornek: "[00:00:07,966 --> 00:00:12,340] metin"). ' +
        '|| the prompts have no leading timestamp (e.g. "[00:00:07,966 --> 00:00:12,340] text").',
      'etiket-yok':
        'prompt metni bos. || the prompt text is empty.',
      'gecersiz-ad':
        'uretilen ad Windows dosya adi kurallarina uymuyor (yasak karakter / cok uzun). ' +
        '|| the generated name is not a valid Windows filename (illegal character / too long).'
    };
    logEvent('error', 'DOSYA ADI: secili mod ("' + modeTr + '") uygulanamadi, duz numara kullanildi. ' +
      'Sebep: ' + (REASON[why] || why));
  }
  return num;
}

function buildFileBase(num, promptNo) {
  try {
    if (afDlNaming !== 'prompt' && afDlNaming !== 'time' && afDlNaming !== 'numtime') return num;
    // FARKLI/BILINMEYEN projeden indirme (dlSequential): numaralandirma duz siralidir ve
    // promptNo bu projenin promptlariyla ESLESMEZ -> etiket yanlis olurdu, numarada kal.
    if (state && state.dlSequential) return afNameFallback(num, 'proje-eslesmiyor');
    const p = (state && state.prompts && state.prompts[promptNo - 1]) || '';
    // v165 'numtime': numara ONDE, damga arkada -> '0002_00-00-07.966'.
    // Zaman damgali indirmede dosya adinda kacinci prompt oldugu yazmadigi icin
    // uretilemeyen gorsel gozle fark edilmiyordu; numarayi one almak Explorer'da
    // sol sutunda hizali bir dizi verir ve eksik numara hemen goze carpar.
    const tsLabel = afTsLabel(p);
    let label;
    // num '0007b' olabilir; harf ASAGIDAKI sfx mantiginda ekleniyor, burada
    // yalnizca rakam kismini aliyoruz yoksa harf iki kere yazilirdi.
    const numOnly = String(num).replace(/^(\d+).*$/, '$1');
    if (afDlNaming === 'numtime') label = tsLabel ? (numOnly + '_' + tsLabel) : '';
    else if (afDlNaming === 'time') label = tsLabel;
    else label = afPromptLabel(p);
    if (!label) return afNameFallback(num, afDlNaming === 'prompt' ? 'etiket-yok' : 'damga-yok');
    const sfx  = String(num).replace(/^\d+/, '');   // '' | 'b' | 'c' ...
    const base = sfx ? (label + '_' + sfx) : label;
    return afSafeFileBase(base) ? base : afNameFallback(num, 'gecersiz-ad');
  } catch (e) {
    console.warn('[AutoFlow] dosya adi etiketi uretilemedi, numara kullanilacak:', e && e.message);
    return num;
  }
}

// --- v175 BASLANGIC NUMARASI -------------------------------------------------
// Uzun liste parca parca gonderilince (40 + 40 + ...) her parca yeniden 0001'den basliyordu.
// Kullanici panele bu parcanin ilk numarasini yazar (ornek 41), dosya adindaki sayi oradan
// baslar. NUMARALANDIRMA ZINCIRI DEGISMEZ: hangi dosyanin kacinci prompta ait oldugu (useIdx,
// dlNumMap, bosluk korumasi, Queue kaydi, etiket aramasi) aynen hesaplanir; yalnizca dosya
// adina yazilan sayiya (baslangic - 1) eklenir. Deger akis / toplu indirme BASLARKEN
// state.dlNumStart'a kopyalanir, kosu ortasinda panelde degistirilse de o kosu kaymaz.
// 1 (varsayilan) ya da gecersiz deger = eski davranis birebir.
let afDlStartNum = 1;
function afCleanStartNum(v) {
  const n = Number(v);
  return (Number.isInteger(n) && n >= 1) ? Math.min(n, 99999) : 1;
}
function afNumOffset() {
  const n = state && state.dlNumStart;
  return (Number.isInteger(n) && n > 1) ? Math.min(n, 99999) - 1 : 0;
}
function afStartNumNote() {
  const off = afNumOffset();
  if (!off) return '';
  const first = String(off + 1).padStart(4, '0');
  return 'Başlangıç numarası ' + (off + 1) + ': 1. promptun dosyası ' + first + ' olarak adlandırılır | ' +
         'Start number ' + (off + 1) + ': prompt 1 is saved as ' + first;
}

// Ayari depodan tazele. Klasor adi URETILMEDEN HEMEN ONCE cagrilir -> panelde ayar
// degisince hemen gecerli olur, SW yeniden basladiginda da dogru okunur.
async function loadDlPrefs() {
  try {
    const o = await chrome.storage.local.get(['afDlRoot', 'afDlDated', 'afDlNaming', 'afDlStartNum']);
    afDlRoot  = sanitizeDlRoot(o && o.afDlRoot);
    afDlDated = !(o && o.afDlDated === false); // yalniz ACIKCA false ise kapali
    const nm = o && o.afDlNaming;              // bilinmeyen deger -> 'num' (eski davranis)
    afDlNaming = (nm === 'prompt' || nm === 'time' || nm === 'numtime') ? nm : 'num';
    afDlStartNum = afCleanStartNum(o && o.afDlStartNum); // v175
  } catch (e) {
    console.warn('[AutoFlow] kayit klasoru ayari okunamadi:', e && e.message);
  }
}
loadDlPrefs(); // SW acilisinda onbellegi isit (asil okuma klasor uretilirken yapilir)

// Her YENİ akış için benzersiz klasör adı (tarih + saat). Duraklat/devam
// aynı state.dlFolder'ı korur; durdurup yeni akış başlatınca yenisi üretilir.
// v149: kullanici bir kayit klasoru yazdiysa tarihli klasor ONUN ALTINA acilir.
function makeDownloadFolder() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  const dated = `AutoFlow-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
                `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  // Tarihli klasor kapaliysa her sey dogrudan kullanicinin klasorune iner. Klasor adi ASLA
  // bos olamaz (bos -> "/0001.mp4" Chrome tarafindan REDDEDILIR) -> yedek 'AutoFlow'.
  if (!afDlDated) return afDlRoot || 'AutoFlow';
  return afDlRoot ? `${afDlRoot}/${dated}` : dated;
}

// Flow proje URL'ini normalize et (query/hash/sondaki slash at) → aynı proje mi karşılaştırması.
function projectKey(url) {
  if (!url) return '';
  const s = String(url).split('?')[0].split('#')[0].replace(/\/+$/, '').toLowerCase();
  // v136 ÜLKE/DİL BAĞIMSIZ: Flow aynı projeyi ".../fx/tools/flow/project/<id>" ve
  // ".../fx/tr/tools/flow/project/<id>" gibi farklı yollarla açabiliyor (Google yerel
  // ayara göre yönlendiriyor). Tam URL karşılaştırması bunları FARKLI proje sanıyor ve
  // "Sonradan indir" numaralandırmasını düz sıralıya düşürüyordu. Proje kimliği varsa
  // karşılaştırma ONUN üzerinden yapılır → her ülke uzantısında aynı davranış.
  const id = (s.match(/\/project\/([0-9a-z-]{8,})/i) || [])[1];
  return id ? ('project:' + id) : s;
}

function imgToken(q) { return q === '2k' ? '2k' : q === '4k' ? '4k' : '1k'; }
function vidToken(q) {
  return q === '270p' ? '270' : q === '1080p' ? '1080' : q === '4k-v' ? '4k' : '720';
}

function guessExt(item, isVideo) {
  const fn = (item.filename || '').toLowerCase();
  const m = fn.match(/\.([a-z0-9]{2,4})$/);
  if (m) return m[1];
  const mime = (item.mime || '').toLowerCase();
  if (mime.includes('mp4'))  return 'mp4';
  if (mime.includes('webm')) return 'webm';
  if (mime.includes('quicktime') || mime.includes('mov')) return 'mov';
  if (mime.includes('png'))  return 'png';
  if (mime.includes('webp')) return 'webp';
  if (mime.includes('jpeg') || mime.includes('jpg')) return 'jpg';
  return isVideo ? 'mp4' : 'jpg';
}

// v166: FLOW ARTIK GORSELLERI WEBP SUNUYOR. Gorsel adresi "...=s1600-rw" ile
// bitiyor; "-rw" Google'in kendi goruntu adresi secenegi olan "WebP dondur"
// bayragi, karsiligi "-rj" yani "JPEG dondur". CapCut webp istemedigi icin
// indirirken JPEG istiyoruz.
//
// GUVENLIK: bu yalnizca bir ISTEK. Google bayragi yok sayip yine webp dondurse
// bile dosya adi guessExt ile GELEN DOSYANIN gercek turunden uretildigi icin
// webp olarak adlandirilir; jpg adiyla webp inmesi (sessiz bozulma) mumkun degil.
//
// DIKKAT: yalnizca INDIRME adresi degistirilir. directUrl'in kendisi sayfadaki
// <img src> ile birebir karsilastirilip tile gorunur yapiliyor; onu degistirirsek
// eslesme kirilir ve galeri ilerlemesi bozulur.
function afJpegUrl(u) {
  const s = String(u || '');
  return /-rw(?=$|[?#])/.test(s) ? s.replace(/-rw(?=$|[?#])/, '-rj') : s;
}

// Flow indirmeyi başlattığında dosya adını AutoFlow-YYYYMMDD/0001.ext yap.
// KRİTİK: ADLANDIRILMIŞ fonksiyon + TEK SEFER kayıt. onDeterminingFilename eklenti başına
// SADECE BİR dinleyiciye izin verir; service worker uyanınca üst-seviye kod yeniden çalışıp
// addListener'ı TEKRAR çağırınca "at most one listener" hatası çıkıyor ve dinleyici BOZUK
// duruma düşüyordu → dosyalar UUID adıyla klasör DIŞINA iniyordu (download({filename}) bile
// ezilir). globalThis bayrağı + try/catch ile yalnız bir kez, güvenle kaydediyoruz.
// v169 TESHIS: Flow/Google kaynakli bir MEDYA indirmesini adlandiramadan gecirirsek
// kosuda BIR KEZ not dus. "Gorseller bazen Flow'un kendi adiyla, klasor disina iniyor"
// sikayetinin hangi dalda olustugu (bekleyen kayit yok mu, adres suzgeci mi tutmadi,
// Flow medya host'u mu degisti) artik tahmin degil, kayit. Kullanicinin ALAKASIZ
// indirmeleri loglanmaz: yalnizca google adresli VE resim/video turu dosyalar.
let afDlMissLogged = false;
function afDlMissLog(item, where) {
  try {
    if (afDlMissLogged) return;
    const u = (((item && item.url) || '') + ' ' + ((item && item.finalUrl) || '') + ' ' +
               ((item && item.referrer) || '')).toLowerCase();
    // DAR KAPI: kullanicinin Drive/Photos gibi ALAKASIZ Google indirmeleri log'u kirletmesin.
    // Flow medya host'u yine degisse bile REFERRER Flow sayfasini gosterir -> yakalariz.
    if (!/labs\.google|flow\.google|flow-content\.google|googleusercontent|googlevideo/.test(u)) return;
    if (!/(image|video)/i.test((item && item.mime) || '')) return;
    afDlMissLogged = true;
    let host = '';
    try { host = new URL((item && (item.finalUrl || item.url)) || '').hostname; } catch (_) {}
    logEvent('error', 'Bir Google/Flow medya indirmesi AutoFlow tarafindan ADLANDIRILMADI, dosya kendi adiyla indi. ' +
      'nokta:' + where + ' host:' + (host || '?') +
      ' bekleyen-kayit:' + (pendingDownloadBase ? 'var' : 'yok') +
      ' indirme-hatti:' + (dlLoopActive ? 'acik' : 'kapali') +
      ' | Flow medya adresi degismis olabilir, bu satiri gelistiriciye iletin. ' +
      '|| A Google/Flow media download was not renamed by AutoFlow and kept its own name.');
  } catch (_) {}
}

function afDetermineFilename(item, suggest) {
  if (pendingDownloadBase) {
    // GÜVENLİK: pendingDownloadBase set iken (biz bir Flow dosyası bekliyoruz) kullanıcı Flow
    // DIŞI bir şey indirirse onu KAÇIRMA/numaralama. Yalnız indirme gerçekten Flow'dan geliyorsa
    // (url/finalUrl/referrer labs.google|flow.google) bizim tetiklediğimiz dosyadır → adlandır.
    // Aksi halde DOKUNMA (suggest()) → kullanıcının alakasız indirmesi normal Downloads'a iner,
    // pendingDownloadBase TÜKENMEZ → bizim Flow dosyamız sonra gelince doğru adlanır.
    const u = ((item.url || '') + ' ' + (item.finalUrl || '') + ' ' + (item.referrer || '')).toLowerCase();
    // FLOW v2 (2026-09): medya artık ayrı bir host'tan geliyor → https://flow-content.google/...
    // "flow-content.google" dizesi "flow.google" İÇERMEZ (nokta yerine tire) → eski kontrol
    // false dönüyordu ve dosyalar Flow'un kendi UUID adıyla, klasörsüz, numarasız iniyordu.
    if (u.includes('labs.google') || u.includes('flow.google') || u.includes('flow-content.google')) {
      pendingDownloadBase.id = item.id;
      const ext = guessExt(item, pendingDownloadBase.isVideo);
      suggest({
        filename: `${pendingDownloadBase.folder}/${pendingDownloadBase.name || pendingDownloadBase.num}.${ext}`,
        conflictAction: 'uniquify'
      });
      return;
    }
    afDlMissLog(item, 'adres-suzgeci-tutmadi');
    suggest();
    return;
  }
  // GÜVENLİK AĞI — SADECE: (a) AKTİF bir indirme pipeline'ı çalışıyorken VE (b) indirme
  // gerçekten FLOW SAYFASINDAN geliyorsa (referrer labs.google/flow.google). Bu, menü
  // yolundan geç inen 2K/4K upscale dosyasını klasöre alır. KULLANICININ BAŞKA İNDİRMELERİNE
  // ASLA DOKUNMAZ. (ESKİ HATA: `state.autoDownload` kalıcı true olduğundan, oto indirme bir
  // kez açıldıysa AutoFlow çalışmasa bile kullanıcının TÜM indirmeleri AutoFlow klasörüne
  // kaçırılıyordu. `state.autoDownload` koşuldan çıkarıldı + Flow-referrer kontrolü eklendi.)
  if (dlLoopActive && state.dlFolder) {
    const ref = ((item.referrer || '') + ' ' + (item.url || '') + ' ' + (item.finalUrl || '')).toLowerCase();
    const isFlow = ref.includes('labs.google') || ref.includes('flow.google') || ref.includes('flow-content.google');
    if (isFlow) {
      const ext  = guessExt(item, false);
      const base = (item.filename || 'extra').replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '') || 'extra';
      suggest({ filename: `${state.dlFolder}/_gec_${base}.${ext}`, conflictAction: 'uniquify' });
      return;
    }
  }
  afDlMissLog(item, dlLoopActive ? 'hat-acik-ama-flow-degil' : 'bekleyen-kayit-yok');
  suggest();
}
// TEK SEFER kayıt: SW uyanışında üst-seviye kod yeniden çalışsa bile dinleyici BİR KEZ eklenir
// (çift kayıt = "at most one listener" hatası = bozuk isimlendirme). globalThis SW örneği
// boyunca yaşar; hasListener ek güvence.
// v169: kayit tek bir fonksiyona alindi ve HER indirme hattinin basinda tekrar dogrulaniyor.
// Kanca olu/bozuksa (kayit hata almis, baska bir kayit araya girmis) dosyalar Flow'un kendi
// UUID adiyla ve KLASOR DISINA iniyordu; kullanici bunu "gorseller bazen boyle iniyor" diye
// bildiriyordu ama logda hicbir iz yoktu. hasListener yetkili olcudur: false ise kanca YOK
// demektir, yeniden ekleriz ve onarimi Logs'a yazariz.
function ensureDlListener(fromPipeline) {
  try {
    if (chrome.downloads.onDeterminingFilename.hasListener(afDetermineFilename)) {
      globalThis.__afDlListenerAdded = true;
      return true;
    }
    chrome.downloads.onDeterminingFilename.addListener(afDetermineFilename);
    globalThis.__afDlListenerAdded = true;
    if (fromPipeline !== false) {
      try { logEvent('info', 'Dosya adlandirma kancasi kayitli degildi, yeniden kuruldu ' +
        '(bu olmadan dosyalar Flow tarafindan verilen adla ve klasor disina iner).'); } catch (_) {}
    }
    return true;
  } catch (e) {
    console.warn('[AutoFlow] onDeterminingFilename kayıt hatası:', e && e.message);
    try { logEvent('error', 'Dosya adlandirma kancasi KURULAMADI: ' + ((e && e.message) || e) +
      ' -> dosyalar Flow tarafindan verilen adla inebilir. Eklentiyi chrome://extensions uzerinden ' +
      'kapatip acmak bunu duzeltir. || Filename hook could not be installed; files may keep ' +
      'the names Flow gives them. Toggling the extension off/on in chrome://extensions fixes it.'); } catch (_) {}
    return false;
  }
}
ensureDlListener(false);   // SW yuklenirken: sessiz kurulum (onarim degil)

chrome.downloads.onChanged.addListener((delta) => {
  if (!pendingDownloadBase || pendingDownloadBase.id == null) return;
  if (delta.id !== pendingDownloadBase.id) return;
  if (delta.state && delta.state.current === 'complete' && pendingDownloadBase.resolveDone) {
    pendingDownloadBase.resolveDone('complete');
  } else if (delta.state && delta.state.current === 'interrupted' && pendingDownloadBase.resolveDone) {
    pendingDownloadBase.resolveDone('interrupted');
  }
});

// ── Messages ───────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  switch (msg.action) {
    case 'start':
      handleStart(msg);
      sendResponse({ success: true });
      return false;
    case 'pause':    handlePause().then(sendResponse);  return true;
    case 'resume':   handleResume().then(sendResponse); return true;
    case 'stop':     handleStop().then(sendResponse);   return true;
    case 'getState': sendResponse({ ...state });        return false;
    case 'readGenOptions':
      handleReadGenOptions(msg).then(sendResponse).catch(e => sendResponse({ success: false, error: e.message }));
      return true;
    case 'downloadAll':
      handleDownloadAll(msg).then(sendResponse).catch(e => sendResponse({ success: false, error: e.message }));
      return true;
    case 'cancelDownloadAll':
      dlCancel = true; // pipeline döngüsü bir sonraki kontrolde durur
      // GÜVENCE: pipeline uzun bir await'te (örn. video dosya beklemesi) takılıysa
      // dlCancel'i hemen görmeyebilir → kullanıcı ne durdurabilir ne yeniden başlatabilir
      // (buton "Durdur"da kalır, yeni indirme 'busy' döner). Kısa süre sonra durumu ZORLA
      // sıfırla: buton "Sonradan indir"e döner, yeniden başlatma serbest kalır. Takılı eski
      // döngü await'ten dönünce dlCancel ile zaten çıkar.
      setTimeout(() => {
        if (dlCancel) {
          dlRunToken++;            // takılı döngü (auto/manuel) token uyuşmazlığından çıksın
          dlLoopActive = false;
          state.bulkDownloading = false;
          restoreZoomIfForced();  // takılı pipeline finally'ye ulaşamasa da zoom'u geri al
          try { persist(); broadcast(); } catch (_) {}
          console.log('[AutoFlow][DL] cancelDownloadAll → durum zorla sıfırlandı');
        }
      }, 1500);
      sendResponse({ success: true });
      return false;
    case 'stopAutoDownload':
      // OTO indirmeyi manuel durdur. Üretim bitince Durdur/Duraklat butonu "Başlat"a döner
      // ve oto indirme pipeline'ı (grace/lingering) durdurulamaz hale geliyordu. Bu mesaj:
      // autoDownload=false → "güvence: durmuşsa yeniden başlat" tetiklenmez; dlCancel=true →
      // pipeline bir sonraki kontrolde / uzun await dönüşünde HEMEN çıkar.
      state.autoDownload = false;
      dlCancel = true;
      setTimeout(() => { // uzun await'te (video/upscale dosya beklemesi ~dk) takılıysa zorla sıfırla
        if (dlCancel) {
          dlRunToken++;
          dlLoopActive = false;
          state.autoDlActive = false;
          state.bulkDownloading = false;
          restoreZoomIfForced();
          try { persist(); broadcast(); } catch (_) {}
          console.log('[AutoFlow][DL] stopAutoDownload → durum zorla sıfırlandı');
        }
      }, 1500);
      persist(); broadcast();
      sendResponse({ success: true });
      return false;
    case 'galleryExclude':
      if (!state.galleryExcluded) state.galleryExcluded = {};
      if (msg.exclude) state.galleryExcluded[msg.idx] = true; else delete state.galleryExcluded[msg.idx];
      (state.gallery || []).forEach(g => g && (g.outputs || []).forEach(o => {
        if (o && o.idx === msg.idx) o.excluded = !!msg.exclude;
      }));
      persist(); broadcast();
      sendResponse({ success: true });
      return false;
    case 'clearLogs':
      state.logs = []; broadcast();
      sendResponse({ success: true });
      return false;
    case 'clearQueue':
      // Kuyruk sekmesindeki "Temizle" butonu: prompt kuyruğunu sıfırlar. Akış ÇALIŞIRKEN
      // izin verilmez (üretim state.prompts üzerinden yürür — silinirse akış bozulur).
      if (state.status === 'running' || state.status === 'paused') {
        sendResponse({ success: false, error: 'running' });
        return false;
      }
      state.prompts = [];
      state.currentIndex = 0;
      state.currentPrompt = '';
      state.skippedPrompts = {};
      state.dlSavedSlots = {};      // v170: temizlenen kuyruga eski indirme durumu tasinmasin
      state.dlTrackPrompts = false;
      state.status = 'idle';
      persist(); broadcast();
      sendResponse({ success: true });
      return false;
  }
});

// Sidepanel'in çağırdığı: Flow sekmesinden üretim seçeneklerini (mode/model/oran/adet) oku
async function handleReadGenOptions(msg) {
  const tabId = msg.tabId;
  if (!tabId) return { success: false, error: 'no_tab' };
  try {
    // Önce ajan modunu kapat (panel/komposizör normal moda gelsin), sonra oku
    await withUi(() => runFunc(tabId, ensureNormalModeOnFlow));
    const r = await chrome.scripting.executeScript({
      target: { tabId }, world: 'MAIN', func: readFlowGenOptionsAll
    });
    return r?.[0]?.result || { success: false, error: 'no_result' };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

chrome.alarms.onAlarm.addListener(alarm => {
  // af-resume: hata/SW ölümü sonrası kurtarma. af-next: eski sürümden kalan alarm.
  if (alarm.name === 'af-resume' || alarm.name === 'af-next') {
    if (state.status === 'running') runAutomation();
  }
});

// ── Start referansları IDB'den okuma ───────────────────
// Panel, BÜYÜK referans yüklerini (chrome.runtime mesaj sınırını aşanlar) 'afStartRefs'
// anahtarıyla IDB'ye yazar ve payload'da refsFromIdb bayrağını gönderir. SW aynı origin
// olduğundan panelin IDB'sini (autoflow-refs/kv) doğrudan okur. Adlar panelinkiyle
// çakışmasın diye af öneki kullanıldı (SW'de başka IDB kodu yok).
function afIdbOpen() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open('autoflow-refs', 1);
    r.onupgradeneeded = () => { const db = r.result; if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv'); };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
function afIdbGet(key) {
  return afIdbOpen().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction('kv', 'readonly');
    const rq = tx.objectStore('kv').get(key);
    rq.onsuccess = () => { db.close(); resolve(rq.result); };
    rq.onerror = () => { db.close(); reject(rq.error); };
  }));
}

// ── Start ──────────────────────────────────────────────
// Yinelenen 'start' koruması. MV3 cold-start yüzünden sidepanel 'start' mesajını
// + retry'ı işlerken handleStart ÇOK KISA aralıkla iki kez tetiklenebiliyor. İki
// çağrı arasında await (persist + sleep 500) boşluğu olduğu için loopActive guard'ı
// bunu kaçırıyor → İKİ runAutomation döngüsü paralel koşuyor (çift upload + bozuk
// seçim). Burada hem zaten çalışan döngüyü hem de sub-saniye retry burst'ünü eleriz.
let lastStartAt = 0;
async function handleStart(msg) {
  // SOĞUK BAŞLANGIÇ YARIŞI (Chrome'da "ilk Başlat çalışmıyor, ikinci tıklama gerekiyor"):
  // SW uykudan 'start' mesajıyla uyanınca alttaki init IIFE'si storage'dan ESKİ state'i
  // async okur; beklenmezse handleStart'ın kurduğu 'running' state, okuma bitince eski
  // 'idle' state ile EZİLİR (veya running→idle zorlaması yer) ve akış sessizce ölür.
  // handleDownloadAll gibi burada da init'in bitmesini bekle → yarış tamamen kapanır.
  await initReady;
  const now = Date.now();
  console.log('[AutoFlow] handleStart çağrıldı | SW_ID=' + SW_ID +
    ' | loopActive=' + loopActive + ' | Δ=' + (now - lastStartAt) + 'ms');
  if (loopActive || (now - lastStartAt) < 1500) {
    logEvent('start', 'Duplicate start ignored (SW_ID=' + SW_ID +
      ', loopActive=' + loopActive + ', Δ=' + (now - lastStartAt) + 'ms)');
    return;
  }
  lastStartAt = now;
  chrome.alarms.clear('af-next');
  chrome.alarms.clear('af-resume');
  // Büyük referans yükü IDB üzerinden geldiyse mesajdaki boş listeleri IDB'dekiyle doldur
  if (msg.refsFromIdb) {
    try {
      const refs = await afIdbGet('afStartRefs');
      if (Array.isArray(refs) && refs.length) { msg.refImagesAll = refs; msg.refImages = refs; }
      console.log('[AutoFlow] start referansları IDB\'den yüklendi:', Array.isArray(refs) ? refs.length : 0);
    } catch (e) {
      console.warn('[AutoFlow] afStartRefs IDB okunamadı:', e && e.message);
    }
  }
  await loadDlPrefs(); // v149: kayit klasoru ayari akis baslarken depodan tazelenir
  state = {
    status: 'running', prompts: msg.prompts, currentIndex: 0,
    interval: msg.interval, tabId: msg.tabId,
    genUrl: msg.flowUrl || '', // üretim hangi projede yapıldı → "Sonradan indir" numarası için
    currentUsage: msg.currentUsage || 0, currentPrompt: msg.prompts[0] || '',
    refImages:    msg.refImagesAll || msg.refImages || [],
    refMode:      msg.refMode      || 'shared',
    promptRefNames: msg.promptRefNames || [], // prompt başına eklenecek dosya adları
    // v119: görselin Flow'da NASIL kullanılacağı.
    //   'ingredients' → Malzemeler sekmesi, kompozisyondaki "+" ile prompt'a referans
    //                   olarak eklenir (v115'ten beri çalışan, kanıtlı yol).
    //   'start'|'chain'|'pairs' → Kareler sekmesi; promptRefNames[i][0] BAŞLANGIÇ,
    //                   [1] (varsa) BİTİŞ karesi olarak yuvalara yerleştirilir.
    // Alan yoksa (Control akışı, eski panel) 'ingredients' → davranış birebir eskisi.
    frameMode:    msg.frameMode    || 'ingredients',
    autoDownload: msg.autoDownload || false,
    dlQualityImg: msg.dlQualityImg || '1k',
    dlQualityVid: msg.dlQualityVid || '720p',
    videoOnly:    !!msg.videoOnly, // VİDEO üretimi → indirmede YALNIZ videolar iner (referans görseller değil)
    staged: false,
    refsUploaded: false,
    uploadedRefNames: {}, // 20'şerli parti yükleme: Flow'a yüklenmiş referans dosya adları (parti tekrar yüklenmesin)
    agentHandled: false, // ajan modu akış başında bir kez kapatılır
    genSettings: msg.genSettings || null, // mode/model/oran/adet — akış başında Flow'a uygulanır
    genApplied: false,
    dlDoneKeys: {},   // indirilen tile kimlikleri (görsel URL'i) — KİMLİK-BAZLI dedup:
                      // aynı görsel iki kez inmez, atlanan tekrar denenebilir.
    dlFailedKeys: {}, // kalıcı atlanan tile kimlikleri (failed/indirilemeyen) — numara slotu TÜKETİR
    dlRefKeys: {},    // REFERANS tile kimlikleri → indirilmez + ASLA tekrar denenmez + numara slotu TÜKETMEZ
    dlSkipKeys: {},   // v133: FANTOM/bilinmeyen tile'lar → atlanır ama numara slotu TÜKETMEZ
                      // (yalnız GERÇEK üretim hatası boşluk bırakmalı; fantom numarayı kaydırmamalı)
    dlNumMap: {},     // v108: medya kimliği (?name=) → verilen numara slotu (useIdx). Her indirme
                      // buraya yazar; "Sonradan indir" AYNI projede aynı medyayı AYNI numarayla indirir
                      // (oto 1,2,3,5 verdiyse manuel de 1,2,3,5 verir — canlı konum sayımına düşmez)
    promptMediaMap: {}, // v114 KESİN NUMARA: üretim API yanıtından (video:batchAsyncGenerate*)
                      // yakalanan uuid → prompt indeksi. Tile'ın ?name= kimliği burada varsa numara
                      // DOĞRUDAN prompt indeksinden gelir (DOM sayımı/hata kartı tespiti gereksiz;
                      // üretilemeyen prompt hiç medya üretmediğinden boşluğu YAPISAL olarak korunur)
    promptSentAt: {}, // v114: promptIdx → gönderim zamanı (Date.now) — API yanıtı zamanla eşlenir
    refIdMap: (state && state.refIdMap) || {}, // v107: KALICI referans medya kimlikleri (?name=) —
                      // akışlar arası taşınır; aynı projedeki eski referanslar da tanınır
    dlBaseline: null, // ilk inen görselden önceki failed sayısı (leading-baseline → ilk inen 0001)
    dlDone: 0,   // gerçekten inen dosya sayısı (yalnızca bilgi/log)
    dlFolder: makeDownloadFolder(), // her YENİ akışta benzersiz klasör (saat dahil)
    dlNumStart: afDlStartNum, // v175: dosya adındaki numara bu sayıdan başlar (1 = eski davranış)
    logs: [],            // {t, kind, msg} olay akışı (Logs sekmesi)
    gallery: [],         // prompt başına çıktı durumları (Gallery sekmesi)
    galleryExcluded: {}, // { tileIdx: true } — kullanıcı sildi → toplu indirmede atla
    skippedPrompts: {},  // { promptIdx: true } — gönderilemeyip atlanan promptlar (Queue sekmesi)
    dlSavedSlots: {},    // v170: { numara slotu (useIdx): 1 } bu koşuda GERÇEKTEN inen dosyalar (Queue: indirildi/inmedi)
    dlTrackPrompts: !!msg.autoDownload, // v170: Queue indirme durumunu gostersin mi (oto indirme acikken evet)
    autoDlActive: false, // oto indirme pipeline'ı aktif mi (sidepanel durdur butonu)
    prevZoom: 1,         // oto indirme açıkken zoom %33'e çekilir; bitince bu değere döner
    zoomForced: false    // zoom %33'e zorlandı mı (çıkışta geri almak için)
  };
  // v119: VİDEO alt sekmesini (Kareler/Malzemeler) üretim ayarlarıyla BİRLİKTE uygula.
  // Flow bu seçimi proje içinde hatırlıyor → kullanıcı Flow'da Kareler'de bırakmışsa
  // Malzemeler akışı "+" bulamıyordu (destek maillerinin kök nedeni). Artık akış başında
  // hangi yol isteniyorsa o sekme AÇIKÇA seçilir. Yalnız VİDEO modunda ve gerçekten
  // görsel iliştirilecekse dokunulur → referanssız Text→Video akışı eskisi gibi kalır.
  {
    const wantFrames = state.frameMode !== 'ingredients';
    if (state.genSettings && state.genSettings.mode === 'VIDEO' &&
        (wantFrames || (state.refImages && state.refImages.length))) {
      state.genSettings.frameTab = wantFrames ? 'VIDEO_FRAMES' : 'VIDEO_REFERENCES';
    }
  }
  await persist();
  broadcast();
  netTeleCnt = 0; netTeleSeen = new Set(); // v114: NET telemetri tavanı her koşuda tazelenir
  logEvent('start', `Flow started — ${state.prompts.length} prompts | mod:` +
    state.frameMode + ' | ' + AF_BUILD);
  if (afNumOffset()) logEvent('info', afStartNumNote()); // v175
  await setTabAutoDiscard(state.tabId, false); // arka plandayken Bellek Tasarrufu sekmeyi atmasın
  // OTO İNDİRME AÇIK → sayfa zoom'unu %33'e çek. Flow galeriyi SANALLAŞTIRIYOR (ekran-dışı
  // tile'ları DOM'dan atar) → pipeline tile'ları göremeyip indirme sırası/numarası şaşırır.
  // %33'te ~9x daha fazla tile ekrana sığar → sanallaştırma devreye girmez → sıra KESİN korunur.
  // getBoundingClientRect ölçüleri zoom'dan ETKİLENMEZ → tile tespiti/boyut filtresi bozulmaz.
  // Oto indirme KAPALIYSA zoom'a DOKUNULMAZ; bitince/durunca prevZoom'a (genelde %100) döner.
  if (state.autoDownload && state.tabId) {
    let pz = 1;
    try { pz = await chrome.tabs.getZoom(state.tabId); } catch (_) {}
    state.prevZoom = (pz && pz > 0.5) ? pz : 1; // zaten %33'e yakınsa %100'e düş (kademeli tuzağı önle)
    state.zoomForced = true;
    await setAutoZoom(state.tabId, 0.33);
    await persist();
  }
  // ── v139 KOMPAKT (MOBİL) DÜZEN KORUMASI ─────────────────────────────────
  // Flow, sayfanın CSS genişliği ~1000px altına düşünce MOBİL arayüzü render ediyor:
  // picker <div class="mobile-overlay"><flow-mobile-add-menu> olur; asset-item kartı,
  // ingredient bar ve detay paneli YOKTUR → referans eklemek İMKÂNSIZ hale gelir.
  // (Destek vakası 2026-09-06: kullanıcının CSS genişliği 717px, 30 promptun tamamı
  //  referanssız gitti.) Pencere boyutunu değiştiremeyiz ama ZOOM'u azaltmak CSS
  //  genişliğini büyütür → masaüstü düzeni geri gelir. Yalnız GEREKİRSE devreye girer;
  //  geniş pencerede hiçbir şey yapmaz. Zoom, koşu bitince eski değerine döner.
  if (state.tabId && !state.zoomForced) {
    try {
      const vw = await chrome.scripting.executeScript({
        target: { tabId: state.tabId }, world: 'MAIN', func: () => window.innerWidth
      });
      const iw = (vw && vw[0] && vw[0].result) || 0;
      if (iw > 0 && iw < 1000) {
        let cz = 1;
        try { cz = await chrome.tabs.getZoom(state.tabId); } catch (_) {}
        const target = Math.max(0.25, Math.min(1, (cz || 1) * (iw / 1300)));
        state.prevZoom = (cz && cz > 0) ? cz : 1;
        state.zoomForced = true;
        await setAutoZoom(state.tabId, target);
        await persist();
        logEvent('info', 'Flow kompakt (mobil) düzendeydi (genişlik ' + iw + 'px) → yakınlaştırma %' +
          Math.round(target * 100) + ' yapıldı | Flow was in compact layout, zoom set to ' +
          Math.round(target * 100) + '%');
      }
    } catch (_) {}
  }
  await sleep(500);
  runAutomation();
  if (state.autoDownload) downloadPipeline();    // üretimle EŞ ZAMANLI, sıralı indirme
}

// Sekmenin OTOMATİK ATILMASINI (discard) engelle/serbest bırak: Chrome Bellek Tasarrufu,
// arka planda kalan sekmeyi atabilir → sayfa tamamen ölür, otomasyon biter. Akış başında
// kapatılır (allow=false), akış/indirme bitince geri açılır. Hata sessizce yutulur.
async function setTabAutoDiscard(tabId, allow) {
  try { if (tabId) await chrome.tabs.update(tabId, { autoDiscardable: allow }); } catch (_) {}
  // v175: koruma acilirken (allow=false) bilgisayarin uykuya dalmasi ve ekranin kapanmasi da
  // engellenir, koruma kalkarken birakilir. Kilitli/kapali ekranda Chrome butun pencereleri
  // "gorunmez" sayip sayfayi kisiyor, uykuda ise ag ve eklenti tamamen duruyor (musteri kosusu
  // 2026-09-15: 58/177'de takildi). Ayni cagri noktalarini kullandigi icin omru atilma
  // korumasiyla BIREBIR ayni: akis/indirme baslayinca alinir, durunca/bitince birakilir.
  afKeepAwake(!allow);
}

function afKeepAwake(on) {
  try {
    if (!chrome.power) return;   // izin yoksa sessizce gec (davranis eskisi gibi)
    if (on) chrome.power.requestKeepAwake('display');
    else chrome.power.releaseKeepAwake();
  } catch (_) {}
}

// VİDEO-ONLY indirme bayrağını sayfaya aktar (v105 davranışı): açıkken flowCollectTiles,
// referans SİNYALİ (nearRefLabel / __afRefIds / alt-title stem) taşıyan tile'ları 'reference'
// sayar (indirilmez + numara slotu tüketmez); sinyalsiz <img>/bg tile'ları ise üretilen VİDEO
// POSTERİ kabul edip complete+isVideo=true işaretler. (Eski v104 kuralı "her img = referans"
// idi; Flow videoları çoğu kez <img> poster gösterdiğinden HİÇBİR video inmiyordu.)
async function setPageVideoOnly(tabId, on) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId }, world: 'MAIN',
      func: (v) => { window.__afVideoOnly = !!v; },
      args: [!!on]
    });
  } catch (_) {}
}

// Sayfa zoom'unu ayarla (oto indirme sıra güvencesi). Hata olursa üretim normal devam eder.
async function setAutoZoom(tabId, factor) {
  try { await chrome.tabs.setZoom(tabId, factor); console.log('[AutoFlow][ZOOM] zoom →', factor); }
  catch (e) { console.warn('[AutoFlow][ZOOM] setZoom hatası:', e && e.message); }
}

// Zoom %33'e ZORLANDIYSA (state.zoomForced) kullanıcının önceki zoom'una (genelde %100) geri al
// ve bayrağı temizle. HER çıkış yolunda güvenle çağrılır (pipeline finally, Durdur, stopAutoDownload,
// cancelDownloadAll, handleStop) → indirme bitince/durunca zoom takılı kalmaz. Bayrak guard'lı:
// zoom zorlanmadıysa hiçbir şey yapmaz.
async function restoreZoomIfForced() {
  if (!state || !state.zoomForced || !state.tabId) return;
  state.zoomForced = false;
  await setAutoZoom(state.tabId, state.prevZoom || 1);
  try { await persist(); } catch (_) {}
}

// ÖNCE YAYIN, SONRA DEPOYA YAZMA: persist() koşu sırasında (state büyük + sıraya girmiş
// yazmalar) saniyeler sürebiliyor; beklenirse panel doğru durumu o kadar geç öğreniyordu.
// Depoya yazma arkada sürer — SW ölse bile başlangıç kodu running/paused durumunu zaten
// idle'a çektiği için yarım kalan yazmanın hiçbir riski yok.
async function handlePause() {
  if (state.status !== 'running') return { success: false };
  chrome.alarms.clear('af-resume');
  state.status = 'paused'; // çalışan döngü bir sonraki kontrol noktasında durur
  broadcast();
  persist().catch(() => {});
  return { success: true };
}

async function handleResume() {
  if (state.status !== 'paused') return { success: false };
  state.status = 'running';
  broadcast();
  persist().catch(() => {});
  setTabAutoDiscard(state.tabId, false); // v175: duraklatmada bırakılmışsa uyku engeli + atılma koruması geri gelsin
  runAutomation(); // döngüyü mevcut indeksten yeniden başlat
  if (state.autoDownload) downloadPipeline();
  return { success: true };
}

async function handleStop() {
  chrome.alarms.clear('af-next');
  chrome.alarms.clear('af-resume');
  state.status = 'idle'; // çalışan döngü duracak
  await restoreZoomIfForced(); // %33'e zorlanan zoom'u geri al (bayrak guard'lı)
  await setTabAutoDiscard(state.tabId, true); // akış durdu → sekme yeniden atılabilir
  await persist(); broadcast();
  return { success: true };
}

// ── Otomasyon döngüsü — deterministik, sayfa-içi hassas bekleme ──────────
//
// Kullanıcının istediği akış (KONUM BAZLI referans seçimi):
//   İlk prompt (idx 0):
//     • 1 referansı Flow'a yükle → 20 sn bekle (yükleme tamamlansın)
//     • picker'ı aç, 1. SIRADAKİ (en üstteki, pos 0) kartı seç — yüklediğimiz referans
//     • 1 sn sonra promptu yapıştır
//     • 1 sn sonra gönder
//   Sonraki promptlar (idx ≥ 1):
//     • picker'ı aç, 2. SIRADAKİ (pos 1) kartı seç — referans hep 2. sırada kalır
//       (en üste az önce üretilen görsel gelir, referans 1 alt sıraya kayar)
//     • 1 sn sonra promptu yapıştır
//     • kullanıcı aralığı kadar bekle (yapıştırmadan SONRA sayılır) → gönder
//
// NOT: chrome.alarms dakika altı süreleri yuvarladığı için kullanılmıyor.
// Beklemeler SW-içi setTimeout (pageSleep) + periyodik API-keepalive ile yapılır;
// sayfa-içi beklemeler ise __afWait (v175: mesaj köprüsü) ile → sekme arka plandayken de
// Chrome timer kısması (5 dk sonra dakikada 1 uyanma) otomasyonu DONDURAMAZ.
let loopActive = false;
// Bir-kez adımları için senkron in-flight guard'ları. İki döngü (örn. af-resume
// alarmı) yine de oluşursa, kontrol+set arasında await olmadığı için bunlar her
// adımın yalnızca BİR kez çalışmasını sağlar (çift upload/gen-ayar engellenir).
let agentInFlight = false, genInFlight = false, uploadInFlight = false;

// KÖK ÇÖZÜM (çift döngü): Web Locks API, aynı origin'deki TÜM eklenti bağlamlarında
// (birden fazla service worker örneği dâhil — reload sırasında eski+yeni SW birlikte
// yaşayabiliyor) paylaşılan bir kilit verir. Modül-içi `loopActive` yalnızca tek SW'de
// çalıştığı için çift döngüyü kaçırıyordu; bu kilit ÇİFT SW durumunu da keser.
// ifAvailable:true → kilit meşgulse anında null döner, ikinci döngü kuyruğa girmeden atlanır.
async function runAutomation() {
  if (!(navigator.locks && navigator.locks.request)) return runAutomationInner(); // çok eski ortam
  await navigator.locks.request('autoflow-automation', { ifAvailable: true }, async lock => {
    if (!lock) {
      console.log('[AutoFlow] runAutomation: kilit meşgul → ikinci döngü ATLANDI (çift döngü engellendi)');
      logEvent('start', 'Duplicate runAutomation blocked by Web Lock');
      return;
    }
    await runAutomationInner();
  });
}

async function runAutomationInner() {
  if (loopActive) { console.log('[AutoFlow] runAutomation zaten çalışıyor'); return; }
  loopActive = true;
  console.log('[AutoFlow] runAutomationInner BAŞLADI | SW_ID=' + SW_ID);
  try {
    const tabId = state.tabId;
    // ── v169 ON KONTROL: sayfaya yazabiliyor muyuz? ───────────────────────
    // Enjeksiyon hic calismiyorsa asagidaki her adim (ajan kapatma, uretim
    // ayarlari, referans secimi, yapistirma, gonderme) SESSIZCE bos doner ve
    // eski kod bunu "yapistirilamadi" sanip promptlari 8'er denemeyle teker
    // teker atardi. Tek bir zararsiz okuma ile bunu basta anlayip DURUYORUZ,
    // hicbir prompt harcanmaz, kullanici sebebi ilk satirda gorur.
    // Erisim varsa (normal durum) bu blok hicbir sey yapmaz: davranis aynidir.
    {
      const probe = await probePageAccess(tabId);
      if (!probe.ok) { await stopRunForPageAccess(tabId, probe); return; }
    }
    await installPageWaitHelper(tabId); // sekme arka plana düşse de sayfa-içi beklemeler kısılmasın
    await setPageVideoOnly(tabId, state.videoOnly); // VİDEO üretimi → indirmede referans görselleri atla
    // v113: ağ telemetri sarmalayıcısını üretim başında da kur (generate çağrılarının
    // yanıtları da yakalansın; idempotent, salt teşhis)
    try { await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: flowNetTap }); } catch (_) {}
    const hasRefs = () => state.refImages && state.refImages.length > 0;
    // v119: Kareler yolu mu? (başlangıç/bitiş karesi) — değilse eski Malzemeler yolu.
    const framesMode = !!state.frameMode && state.frameMode !== 'ingredients';
    // Prompt-başına gönderim deneme sayacı: bir prompt SEND_MAX kez gönderilemezse ATLA
    // (içerik reddi / kalıcı uyarı). Böylece tek kötü prompt tüm partiyi sonsuza kilitlemez
    // ("sınırsız prompt" için şart). Sahte-başarı DEĞİL — açıkça ATLANDI loglanır.
    let sendFailIdx = -1, sendFailCount = 0;
    const SEND_MAX = 8;
    // Yapıştırma için de AYNI koruma: editör hiç bulunamazsa (Flow DOM değişikliği vb.)
    // eski kod AYNI promptu sonsuza dek yeniden deniyordu → tüm parti kilitleniyordu.
    let mobileWarned = false;   // v139: kompakt düzen uyarısı koşuda bir kez yazılır
    let pasteFailIdx = -1, pasteFailCount = 0;
    const PASTE_MAX = 8;
    // v126.8: ART ARDA kaç prompt kare yerleştirilemediği için atlandı. Flow arayüzü yine
    // değişmişse 200 promptun tamamı sessizce atlanır ve kullanıcı saatler sonra fark eder →
    // 3 ardışık atlamada akış DURDURULUR ve Logs'a ne yapılacağı yazılır.
    let frameSkipStreak = 0;
    const FRAME_SKIP_MAX = 3;
    // v163: liste GENELİ damgalı mı? (tek bir "(12:30) saat" prompt'u yanlışlıkla budanmasın)
    const tsHave = (state.prompts || []).filter(p => AF_TS_RE.test(String(p || ''))).length;
    const tsScript = tsHave >= 2 && tsHave * 2 >= (state.prompts || []).length;
    let tsStripLogged = false;
    let pasteDiagLogged = false; // v166: yapıştırma teşhisi koşuda bir kez yazılır (log şişmesin)

    while (state.status === 'running' && state.currentIndex < state.prompts.length) {
      const idx    = state.currentIndex;
      const prompt = state.prompts[idx];
      state.currentPrompt = prompt;
      broadcast();
      await afWatchVisibility(tabId); // v175 teşhis: sekme uzun süre görünmezse Logs'a bir kez yazar

      // 0) Ajan modunu kapat (akış başında, yalnızca bir kez).
      //    Yeni Flow projesi ajan modunda açılır: sağda sohbet paneli + alt barda
      //    "Ajan" pili seçili gelir. Normal üretim kutusuna geçmek için önce paneli,
      //    sonra "Ajan" pilini kapatırız. Zaten normal moddaysak hiçbir şey yapmaz.
      if (!state.agentHandled && !agentInFlight) {
        agentInFlight = true;
        try {
          console.log('[AutoFlow] Ajan modu kontrol ediliyor (gerekiyorsa kapatılıyor)...');
          await withUi(() => runFunc(tabId, ensureNormalModeOnFlow));
          state.agentHandled = true;
          await persist();
        } finally { agentInFlight = false; }
        if (!running()) break;
      }

      // 0.5) Üretim ayarlarını uygula (mode/model/oran/adet) — yalnızca bir kez,
      //      ajan kapatıldıktan sonra, ilk prompttan önce.
      if (!state.genApplied && state.genSettings && !genInFlight) {
        genInFlight = true;
        try {
          console.log('[AutoFlow] Üretim ayarları uygulanıyor:', JSON.stringify(state.genSettings));
          await withUi(() => runFuncResult(tabId, applyGenerationSettings, [state.genSettings]));
          state.genApplied = true;
          await persist();
        } finally { genInFlight = false; }
        if (!running()) break;
      }

      // 1) Referans hazırlığı — 20'ŞERLİ PARTİ HALİNDE (Flow tek seçimde ~20 kabul ediyor).
      //    Bu prompt'un ait olduğu 20'lik partinin görselleri henüz yüklenmediyse YALNIZ o
      //    partiyi yükle. Böylece 100+ görselde "N görsel yüklenemedi" hatası olmaz; sıradaki
      //    parti akış oraya (prompt 20, 40, …) gelince — yani önceki parti üretime gönderildikten
      //    sonra — yüklenir. Seçim ada göre yapıldığından (selectRefsForPrompt), her prompt kendi
      //    referansını yalnız o parti picker'da varken bulur. state.uploadedRefNames persist edilir
      //    → resume/SW restart sonrası aynı parti tekrar yüklenmez.
      if (hasRefs() && !uploadInFlight) {
        if (!state.uploadedRefNames) state.uploadedRefNames = {};
        const batchStart = Math.floor(idx / REF_BATCH) * REF_BATCH;
        const batchEnd   = Math.min(batchStart + REF_BATCH, state.prompts.length);
        // Bu partideki prompt'ların ihtiyaç duyduğu (henüz yüklenmemiş) referans adları.
        const batchNames = [];
        for (let p = batchStart; p < batchEnd; p++)
          ((state.promptRefNames && state.promptRefNames[p]) || []).forEach(n => { if (n) batchNames.push(n); });
        const uploadNames = [...new Set(batchNames)].filter(n => !state.uploadedRefNames[n]);
        if (uploadNames.length) {
          uploadInFlight = true;
          try {
            await transferRefs(tabId);
            const partNo = Math.floor(batchStart / REF_BATCH) + 1;
            console.log('[AutoFlow] Referans partisi yükleniyor #' + partNo +
              ' (' + uploadNames.length + ' görsel, prompt ' + (batchStart + 1) + '-' + batchEnd + ')...');
            // v119: Flow tek yüklemede ~20 dosya kabul ediyor. Kareler/çiftler modunda bir
            // partide 20'den ÇOK görsel gerekebilir (20 prompt × 2 kare) → 20'şer parçala.
            // Tek parçalı (≤20) durumda döngü bir kez döner → eski davranış birebir aynı.
            const chunks = [];
            for (let c = 0; c < uploadNames.length; c += REF_BATCH) chunks.push(uploadNames.slice(c, c + REF_BATCH));
            // Kareler modunda kompozisyonda "+" YOKTUR; yükleme picker'ı yalnız Malzemeler
            // sekmesinde açılır → yükleme boyunca oraya geç, bitince Kareler'e geri dön.
            if (framesMode) await withUi(() => runFuncResult(tabId, switchVideoSubTab, ['VIDEO_REFERENCES']));
            let up = null;
            for (let ci = 0; ci < chunks.length; ci++) {
              up = await withUi(() => runFuncRaw(tabId, uploadRefImagesToFlow, [chunks[ci]]));
              // TEŞHİS: kaç dosya enjekte edildi / Flow kaç tane gösterdi
              if (up) logEvent('ref', 'UPLOAD diag (parti #' + partNo +
                (chunks.length > 1 ? ' · ' + (ci + 1) + '/' + chunks.length : '') + ') — requested:' + (up.requested ?? '?') +
                ' injected:' + (up.injected ?? '?') + ' pickerImgs:' + (up.pickerImgs ?? '?') +
                ' hazır:' + (up.ready ?? '?') + ' bekleme:' + (up.waited ?? '?') + 'sn' +
                (up.detected ? ' (detected' + (up.why ? ':' + up.why : '') + ')'
                             : (up.stalled ? ' (stalled)' : ' (timeout)')));
              if (ci + 1 < chunks.length) await pageSleep(tabId, 1600); // parçalar arası nefes
            }
            if (framesMode) await withUi(() => runFuncResult(tabId, switchVideoSubTab, ['VIDEO_FRAMES']));
            uploadNames.forEach(n => { state.uploadedRefNames[n] = true; });
            state.refsUploaded = true;
            await persist();
            // Upload sonrası picker/sayfa + KÜTÜPHANE otursun → bu partinin ilk seçimi güvenli olsun.
            await pageSleep(tabId, 2600);
          } finally { uploadInFlight = false; }
        }
      }
      if (!running()) break;

      // 2) Referansı dosya ADIYLA seç (HER üretimde, idx 0 dahil).
      //    Yükleme adımı artık referansı otomatik EKLEMİYOR; bu yüzden ilk
      //    üretimde de seçim şart. Tek seçim = tek işaret (çift olmaz).
      if (hasRefs()) {
        await transferRefs(tabId); // __afRefImages resume/SW restart sonrası kaybolmasın
        console.log('[AutoFlow] Referans seçiliyor #', idx, framesMode ? '(kare yolu)' : '(malzeme yolu)');
        // v119: Kareler modunda yuvalara yerleştirme, aksi halde ESKİ malzeme seçimi (aynen).
        const selT0 = Date.now();
        let sel = framesMode
          ? await withUi(() => runFuncRaw(tabId, selectFramesForPrompt, [idx]))
          : await withUi(() => runFuncRaw(tabId, selectRefsForPrompt, [idx]));
        // v175 teşhis: seçim normalde birkaç saniye. 90 sn'yi aşarsa Logs'a yazılır (müşteri koşusunda
        // 5-7 dk sürüyordu ama hiçbir satır bunu söylemiyordu). Hiçbir kararı değiştirmez.
        {
          const selSec = Math.round((Date.now() - selT0) / 1000);
          if (selSec > 90) logEvent('info', 'Prompt #' + (idx + 1) + ' referans seçimi ' + selSec + ' sn sürdü. ' +
            'Flow sekmesi ekranda değilse Chrome sayfayı yavaşlatır, sekmeyi açık ve görünür tutun. | ' +
            'Reference selection for prompt #' + (idx + 1) + ' took ' + selSec + ' s. ' +
            'If the Flow tab is not on screen Chrome slows the page down, keep it open and visible.');
        }
        // v121 EMNİYET (yalnız Kareler yolu): Flow yüklenen dosyaları sırayla işliyor ve son
        // dosya (genelde 0001) picker'da bir süre "%99" kalabiliyor. O anda kart bulunamayınca
        // eski davranış promptu KARESİZ gönderiyordu — kullanıcı bunu ancak elle duraklatarak
        // fark ediyordu. Artık kısa aralıklarla birkaç kez daha denenir; olmazsa akış eskisi
        // gibi devam eder (parti ASLA kilitlenmez) ama Logs'a açık uyarı düşer.
        if (framesMode && sel && sel.wanted && (sel.placed || 0) < sel.wanted) {
          for (let rt = 1; rt <= FRAME_RETRY && running(); rt++) {
            logEvent('ref', 'Kareler henüz hazır değil (' + (sel.placed || 0) + '/' + sel.wanted +
              ') — Flow yüklemeyi bitirsin diye ' + Math.round(FRAME_WAIT / 1000) +
              ' sn bekleniyor (deneme ' + rt + '/' + FRAME_RETRY + ')');
            await pageSleep(tabId, FRAME_WAIT);
            if (!running()) break;
            sel = await withUi(() => runFuncRaw(tabId, selectFramesForPrompt, [idx]));
            if (sel && (sel.placed || 0) >= sel.wanted) break;
          }
          if (sel && (sel.placed || 0) < sel.wanted) {
            // v126.6: ESKİDEN prompt "karesiz" gönderiliyordu. Ama yuvalarda ÖNCEKİ promptun
            // kareleri kalmış olabiliyor → Flow aynı çifti TEKRAR üretiyor (kullanıcı raporu:
            // iki video birebir aynı çıktı) ve kredi boşa gidiyor. Artık yuvalar boşaltılır ve
            // prompt ATLANIR; Kuyruk sekmesinde kırmızı görünür, numaralandırma kaymaz
            // (skippedPrompts indirme numaralarında zaten hesaba katılıyor).
            logEvent('error', 'Prompt #' + (idx + 1) + ': kareler yerleştirilemedi (' +
              (sel.placed || 0) + '/' + sel.wanted + ') → prompt ATLANDI (yanlış/eski kareyle üretim yapılmasın)');
            try { await withUi(() => runFuncRaw(tabId, selectFramesForPrompt, [idx, true])); } catch (_) {}
            if (!state.skippedPrompts) state.skippedPrompts = {};
            state.skippedPrompts[idx] = true;
            state.currentIndex++;
            await persist(); broadcast();
            // v126.8: ART ARDA çok sayıda atlama = yapısal sorun (Flow arayüzü değişmiş
            // olabilir). 200 promptu sessizce atlayıp saatler harcamak yerine DUR ve söyle.
            if (++frameSkipStreak >= FRAME_SKIP_MAX) {
              logEvent('error', 'Üst üste ' + frameSkipStreak + ' prompt kare yerleştirilemediği için atlandı → AKIŞ DURDURULDU. ' +
                'Flow arayüzü değişmiş olabilir; Logs\'taki "FRAME diag ... ŞERİT:" satırını geliştiriciye iletin.');
              state.status = 'idle';
              await persist(); broadcast();
              break;
            }
            continue;
          }
        }
        if (framesMode && sel && sel.wanted && (sel.placed || 0) >= sel.wanted) frameSkipStreak = 0; // v126.8: seri bozuldu
        // v139: Flow KOMPAKT (mobil) düzende → referans eklemek yapısal olarak imkânsız.
        // Yeniden denemenin faydası yok; kullanıcıya NE YAPACAĞINI söyle (TR + EN).
        if (sel && sel.mobileLayout) {
          if (!mobileWarned) {
            mobileWarned = true;
            logEvent('error',
              'Flow kompakt (mobil) düzende açıldı, bu düzende referans EKLENEMEZ. ' +
              'Tarayıcı penceresini genişletin veya Ctrl+0 ile yakınlaştırmayı sıfırlayıp akışı yeniden başlatın. | ' +
              'Flow is in compact (mobile) layout and reference images cannot be attached. ' +
              'Widen the browser window or press Ctrl+0 to reset zoom, then start the flow again.');
          }
        } else
        // v126 EMNİYET (MALZEME yolu — kareler yolundaki emniyetin eşleniği): prompt
        // kutusuna eksik referans eklendiyse gönderimden ÖNCE bir kez daha dene. Ölçü
        // sel.chips = kutuda GERÇEKTEN duran referans sayısı (seçim raporu DEĞİL).
        // Yeniden seçim map modunda kalan chip'leri temizleyip sıfırdan kurar.
        if (!framesMode && sel && sel.wanted && (sel.chips ?? 0) < sel.wanted) {
          for (let rt = 1; rt <= 2 && running(); rt++) {
            logEvent('ref', 'Referans eksik (' + (sel.chips ?? 0) + '/' + sel.wanted +
              ') → seçim yeniden deneniyor (' + rt + '/2)');
            await pageSleep(tabId, 1500);
            if (!running()) break;
            const sel2 = await withUi(() => runFuncRaw(tabId, selectRefsForPrompt, [idx]));
            if (sel2) sel = sel2;
            if (sel && (sel.chips ?? 0) >= sel.wanted) break;
          }
        }
        // TEŞHİS: bu prompt için ne istendi, kaç kart bulundu, kaçı eşleşti/seçildi
        if (sel && framesMode) logEvent('ref', 'FRAME diag #' + (idx + 1) +
          ' — wanted:' + (sel.wanted ?? '?') + ' placed:' + (sel.placed ?? '?') +
          ' start:' + (sel.startOk ?? '?') + ' end:' + (sel.endOk ?? '-') +
          ' slots:' + (sel.slots ?? '?') + ' cleared:' + (sel.cleared ?? '?') +
          ' kare:' + (sel.frameSig ?? '?') +   // v156: yuvadaki GERÇEK görselin izi
          (sel.names ? ' | ' + sel.names.join(' → ') : '') +
          (sel.barDump ? ' | ŞERİT: ' + String(sel.barDump).slice(0, 420) : ''));
        else if (sel) {
          logEvent('ref', 'SELECT diag #' + (idx + 1) +
            ' — wanted:' + (sel.wanted ?? '?') + ' cards:' + (sel.cardsFound ?? '?') +
            ' matched:' + (sel.matched ?? '?') + ' selected:' + (sel.selected ?? '?') +
            ' chips:' + (sel.chips ?? '?') +
            (sel.cardDump ? ' | cards=[' + sel.cardDump + ']' : ''));
          // v126: chips = prompt kutusunda GERÇEKTEN duran referans sayısı. Eksikse sessiz
          // kalmayız — eskiden "selected:3" denip prompt tek referansla gidiyordu.
          if (sel.wanted && (sel.chips ?? 0) < sel.wanted)
            logEvent('error', 'Prompt #' + (idx + 1) + ': prompt kutusuna ' + (sel.chips ?? 0) + '/' +
              sel.wanted + ' referans eklendi — eksik referansla gönderiliyor');
        }
        // Sayfada yakalanan referans kimliklerini KALICILAŞTIR (v107): __afRefIds yalnız
        // sayfa belleğinde yaşar (yenilenince kaybolur). state.refIdMap'e kopyala + persist →
        // transferRefs her aktarımda geri verir; 'sonradan indir' de referansları kimlikle tanır.
        try {
          const ids = await runFuncRaw(tabId, () => window.__afRefIds || {});
          if (ids && typeof ids === 'object') {
            const m = state.refIdMap || (state.refIdMap = {});
            let added = 0;
            for (const id in ids) if (!m[id]) { m[id] = 1; added++; }
            if (added) { console.log('[AutoFlow] refIdMap +' + added, '(toplam', Object.keys(m).length + ')'); await persist(); }
          }
        } catch (_) {}
      }
      if (!running()) break;

      // 3) 1 sn sonra promptu yapıştır (GÖNDERMEDEN)
      // FLOW v2: tekil düzenleme görünümündeysek oradaki prompt kutusuna yazarız ve üretim
      // ızgaraya DÜŞMEZ (varlığın sürümü olur) → önce ızgaraya dön.
      try {
        const gv = await runFuncRaw(tabId, ensureGridViewOnFlow);   // TAM sonuç lazım (boolean değil)
        if (gv && gv.changed) logEvent(gv.success ? 'info' : 'error',
          gv.success ? 'Tekil görünümden ızgaraya dönüldü' : 'Tekil görünümden dönülemedi: ' + (gv.path || ''));
      } catch (_) {}
      await pageSleep(tabId, 1000);
      // v163: Flow'a giden metinden baştaki zaman damgası (koşullu) ayıklanır.
      // state.prompts DEĞİŞMEZ → dosya adı, kuyruk, eşleme hepsi eskisi gibi çalışır.
      const sendText = stripLeadTs(prompt, tsScript);
      if (sendText !== prompt && !tsStripLogged) {
        tsStripLogged = true;
        logEvent('info', 'Prompt başındaki zaman damgası Flow\'a GÖNDERİLMİYOR ' +
          '(model damgayı görselin içine yazmasın diye); dosya adında kullanılmaya devam ediyor.');
      }
      console.log('[AutoFlow] Prompt yapıştırılıyor #', idx, ':', sendText.slice(0, 40));
      // v166: runFuncResult yalnız boolean veriyordu → yapıştırma neden tutmadı, Logs'ta
      // HİÇ görünmüyordu (8 deneme boyunca sessizlik, sonra kuru bir "atlandı"). runFuncRaw
      // ile tam sonucu alıp ilk başarısızlıkta sebebi + kutunun gerçek içeriğini yazıyoruz.
      // Karar ölçüsü DEĞİŞMEDİ: eskiden result.success===true idi, şimdi de o.
      const stage  = await withUi(() => runFuncRaw(tabId, stagePromptToFlow, [sendText]));
      // v169: stage === null ise sayfa HIC calistirilamamis demektir (mantik hatasi
      // degil, enjeksiyon hatasi). Sebebi runFuncRaw'in sakladigi mesajdan okuruz.
      const execErr = (stage === null) ? lastExecErr : '';
      const pasted = !!(stage && stage.success === true);
      if (!pasted) {
        if (!pasteDiagLogged) {
          pasteDiagLogged = true;
          logEvent('ref', 'Yapıştırma doğrulanamadı (#' + (idx + 1) + ') — sebep: ' +
            ((stage && stage.error) || (execErr ? ('sayfaya erişilemedi → ' + execErr) : 'sonuç yok')) +
            (stage && stage.seen ? ' | kutuda: "' + String(stage.seen).replace(/\s+/g, ' ') + '"' : ''));
        }
        pasteFailCount = (pasteFailIdx === idx) ? pasteFailCount + 1 : 1;
        pasteFailIdx = idx;
        if (pasteFailCount >= PASTE_MAX) {
          // v169: sebep ENJEKSIYON hatasiysa (sekme kapandi/degisti, erisim kesildi)
          // sonraki promptlarin da hicbir sansi yok, eskiden parti sonuna kadar 8'er
          // deneyip hepsi atlaniyordu. Artik burada DURUYORUZ ve sebebi yaziyoruz.
          // Gercek yapistirma hatasinda (stage doldu) eski davranis BIREBIR ayni: atla, devam et.
          if (execErr) {
            const probe = await probePageAccess(tabId);
            await stopRunForPageAccess(tabId, probe.ok ? { err: execErr, url: probe.url } : probe);
            break;
          }
          console.warn('[AutoFlow] Prompt #' + (idx + 1) + ' ' + PASTE_MAX + ' denemede yapıştırılamadı → ATLANIYOR (batch kilitlenmesin)');
          logEvent('error', 'Prompt #' + (idx + 1) + ' yapıştırılamadı → atlandı (' + PASTE_MAX + ' deneme)');
          if (!state.skippedPrompts) state.skippedPrompts = {};
          state.skippedPrompts[idx] = true; // Queue sekmesi kırmızı gösterir
          state.currentIndex++; pasteFailCount = 0; pasteFailIdx = -1;
          await persist(); broadcast();
          continue;
        }
        console.warn('[AutoFlow] Prompt yapıştırılamadı (deneme ' + pasteFailCount + '/' + PASTE_MAX + '), 3 sn sonra tekrar');
        await pageSleep(tabId, 3000);
        continue; // aynı prompt yeniden denenir
      }
      pasteFailCount = 0; pasteFailIdx = -1; // başarılı → sayaç sıfırla
      if (!running()) break;

      // 4) Bekleme — yapıştırmadan SONRA sayılır.
      //    İlk prompt: 1 sn. Sonrakiler: kullanıcı aralığı.
      const waitSec = (idx === 0) ? 1 : Math.max(1, state.interval || 1);
      console.log('[AutoFlow] Gönderim için bekleniyor:', waitSec, 'sn');
      await waitInterruptible(tabId, waitSec * 1000);
      if (!running()) break;

      // 5) Oto indirme artık AYRI, eş zamanlı downloadPipeline() içinde yapılır.
      //    Üretim döngüsü indirme yüzünden ASLA beklemez.

      // 6) Gönder
      console.log('[AutoFlow] Gönderiliyor #', idx);
      const sent = await withUi(() => runFuncResult(tabId, clickSendOnFlow));
      if (!sent) {
        sendFailCount = (sendFailIdx === idx) ? sendFailCount + 1 : 1;
        sendFailIdx = idx;
        if (sendFailCount >= SEND_MAX) {
          console.warn('[AutoFlow] Prompt #' + (idx + 1) + ' ' + SEND_MAX + ' denemede gönderilemedi → ATLANIYOR (batch kilitlenmesin)');
          logEvent('error', 'Prompt #' + (idx + 1) + ' gönderilemedi → atlandı (' + SEND_MAX + ' deneme)');
          if (!state.skippedPrompts) state.skippedPrompts = {};
          state.skippedPrompts[idx] = true; // Queue sekmesi kırmızı gösterir
          state.currentIndex++; sendFailCount = 0; sendFailIdx = -1;
          await persist(); broadcast();
          continue;
        }
        console.warn('[AutoFlow] Gönderilemedi (#' + (idx + 1) + ', deneme ' + sendFailCount + '/' + SEND_MAX + '), 3 sn sonra tekrar');
        await pageSleep(tabId, 3000);
        continue; // aynı prompt yeniden denenir (referanslar zaten ekli)
      }
      sendFailCount = 0; sendFailIdx = -1; // başarılı → sayaç sıfırla

      // 7) İlerle
      if (!state.promptSentAt) state.promptSentAt = {};
      state.promptSentAt[idx] = Date.now(); // v114: üretim yanıtı bu zamana göre bu prompt'a eşlenir
      logEvent('prompt', 'Prompt #' + (idx + 1) + ' sent');
      state.currentIndex++;
      state.currentUsage++;
      await persist();
      broadcast(state.currentUsage);
      // v114: bir önceki prompt'un üretim yanıtı (~6 sn'de gelir) sayfa tamponunda birikti →
      // kalıcı eşlemeye taşı (oto indirme kapalıyken de eşleme dolu kalsın; tampon taşmasın)
      try { await harvestNetToState(tabId); } catch (_) {}

      // sonraki döngü öncesi kısa nefes
      await pageSleep(tabId, 800);
    }

    if (state.status === 'running' && state.currentIndex >= state.prompts.length) {
      await complete();
    }
  } catch (e) {
    console.error('[AutoFlow] runAutomation error:', e);
    // SW ölmüş/sekme kapanmış olabilir — çalışıyorsa kısa süre sonra kurtar
    if (state.status === 'running') chrome.alarms.create('af-resume', { delayInMinutes: 0.1 });
  } finally {
    loopActive = false;
  }
}

function running() { return state.status === 'running'; }

// v174: indirme hattının sayfaya kurduğu değişkenler (referans adları, görünürlük maskesi, video
// bayrağı) Flow sayfası YENİLENİNCE kaybolur. Kurulum bitince sayfaya işaret konur; tarama işareti
// göremezse kurulum tazelenir (kullanıcı koşusu 2026-09-15: koyu kartlar için sayfa yenilendi).
async function afMarkPage(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: function afSetPipeMark() { window.__afPipeMark = 1; } });
  } catch (_) {}
}

// Referans görsel verisini (dataUrl) sayfaya aktar
async function transferRefs(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId }, world: 'MAIN',
      func: (imgs, promptRefs, refMode, refIds) => {
        window.__afRefImages = imgs;
        window.__afPromptRefs = promptRefs || [];
        // refMode da aktarılır: 'zaten ekli' kısayolu gerçek moda göre karar versin.
        // (Eskiden __afPromptRefs.length>0 map modu sanılıyordu; ama sidepanel SHARED
        // modda da promptRefNames'i dolduruyor → kısayol her iki modda da ölü kalıyordu.)
        window.__afRefMode = refMode || '';
        // KALICI referans kimlikleri (v107): __afRefIds sayfa yenilenince/SW ölünce
        // kaybolur; state.refIdMap'te saklanan kopya her aktarımda geri verilir →
        // feed'deki referanslar 'sonradan indir'de de TANINIR (indirilmez, numara almaz).
        window.__afRefIds = Object.assign({}, refIds || {}, window.__afRefIds || {});
      },
      args: [state.refImages, state.promptRefNames || [], state.refMode || '', state.refIdMap || {}]
    });
  } catch (e) { console.warn('[AutoFlow] ref transfer err:', e.message); }
}

// ── v169: SON ENJEKSIYON HATASI ─────────────────────────────────────────
// chrome.scripting.executeScript BASARISIZ olunca (yanlis sekme, izin verilmeyen
// host, kurumsal politika, sekme kapanmis/cokmus) asagidaki sarmalayicilar hatayi
// SW konsoluna yazip null/false donduruyordu. Kullanicinin gordugu Logs panelinde
// bundan HICBIR iz kalmiyordu: yapistirma "sebep: sonuc yok" diye loglaniyor ve
// parti 8'er denemeyle tek tek atlaniyordu (kullanici logu 2026-09-12: 45 promptun
// tamami 6 dakikada coldu, sebep hicbir yerde yazmiyordu). Artik son hata mesaji
// burada saklanir; teshis loglari ve on kontrol bunu AYNEN kullaniciya gosterir.
let lastExecErr = '';   // '' = son enjeksiyon basarili

async function runFunc(tabId, fn) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: fn });
    lastExecErr = '';
  } catch (e) { lastExecErr = (e && e.message) || 'bilinmeyen hata'; console.warn('[AutoFlow] exec err', fn.name, e.message); }
}

async function runFuncResult(tabId, fn, args) {
  try {
    const r = await chrome.scripting.executeScript({
      target: { tabId }, world: 'MAIN', func: fn, args: args || []
    });
    lastExecErr = '';
    return r?.[0]?.result?.success === true;
  } catch (e) { lastExecErr = (e && e.message) || 'bilinmeyen hata'; console.warn('[AutoFlow] exec err', fn.name, e.message); return false; }
}

// runFuncResult gibi ama TAM sonuç nesnesini döndürür (teşhis logu için).
async function runFuncRaw(tabId, fn, args) {
  try {
    const r = await chrome.scripting.executeScript({
      target: { tabId }, world: 'MAIN', func: fn, args: args || []
    });
    lastExecErr = '';
    return r?.[0]?.result ?? null;
  } catch (e) { lastExecErr = (e && e.message) || 'bilinmeyen hata'; console.warn('[AutoFlow] exec err', fn.name, e.message); return null; }
}

// ── v169: SAYFAYA ERISIM ON KONTROLU ────────────────────────────────────
// Tek satirlik zararsiz bir enjeksiyon (location.href okur, sayfaya DOKUNMAZ).
// Basarisizsa Flow sayfasina hicbir sekilde yazamayiz demektir; bunu akis
// BASLAMADAN once bilmek, 45 promptu bos yere yakmaktan iyidir.
async function probePageAccess(tabId) {
  let url = '';
  try { const t = await chrome.tabs.get(tabId); url = (t && t.url) || ''; } catch (_) {}
  if (!tabId) return { ok: false, err: 'Flow sekmesi secilmemis', url };
  // 3 DENEME: sayfa tam o anda yenileniyorsa/yonleniyorsa enjeksiyon GECICI olarak
  // hata verebilir. Tek denemeyle durdurmak calisan bir kosuyu bosuna keserdi.
  // Kalici engelde (izin/politika/sekme yok) uc deneme de ayni hatayi verir.
  let err = 'bilinmeyen hata';
  for (let i = 0; i < 3; i++) {
    try {
      const r = await chrome.scripting.executeScript({
        target: { tabId }, world: 'MAIN', func: () => location.href
      });
      const href = r?.[0]?.result;
      if (typeof href === 'string') return { ok: true, url: href };
      err = 'sayfa sonuc dondurmedi';
    } catch (e) {
      err = (e && e.message) || 'bilinmeyen hata';
    }
    if (i < 2) await sleep(1500);
  }
  return { ok: false, err, url };
}

// Erisim yoksa kullaniciya NE YAPACAGINI soyleyen tek satirlik mesaj (TR | EN).
// Ayni metin hem on kontrolde hem kosu ortasinda kopan baglantida kullanilir.
function pageAccessHelpMsg(probe) {
  const where = probe && probe.url ? ' [sekme: ' + String(probe.url).slice(0, 120) + ']' : '';
  // Chrome hata mesajlari nokta ile biter -> ' . Check' gibi cift nokta olmasin.
  const why = String((probe && probe.err) || 'bilinmiyor').replace(/\.\s*$/, '');
  return 'Flow sayfasina ERISILEMIYOR, akis durduruldu, sebep: ' + why + where +
    ' | Kontrol edin: (1) secili sekme gercekten ACIK BIR FLOW PROJESI mi ' +
    '(flow.google.com/... veya labs.google/fx/tools/flow), arama sonucu/baska bir Google sayfasi olmasin, ' +
    '(2) Flow sekmesini yenileyip akisi tekrar baslatin, ' +
    '(3) chrome://extensions > ViralDNA Auto Flow > "Site erisimi" = "Tum sitelerde" olsun, ' +
    '(4) bilgisayar kurumsal olarak yonetiliyorsa politika eklenti erisimini engelliyor olabilir. || ' +
    'Cannot access the Flow page, run stopped, reason: ' + why +
    '. Check: (1) the selected tab is really an OPEN FLOW PROJECT (flow.google.com/... or labs.google/fx/tools/flow), ' +
    'not a search result or another Google page, (2) reload the Flow tab and start again, ' +
    '(3) chrome://extensions > ViralDNA Auto Flow > Site access = "On all sites", ' +
    '(4) on a managed computer an enterprise policy may block extension scripting.';
}

// Sayfaya erisilemiyor -> kosuyu TEMIZ kapat. handleStop ile AYNI temizlik:
// durum idle, zoom geri, sekme yeniden atilabilir. Ek olarak oto indirme de
// durdurulur; sayfaya erisemezken indirilecek bir sey de yoktur ve pipeline
// bos yere "yeni tile bekleniyor" diye donerdi (Durdur butonu kirmizi kalirdi).
async function stopRunForPageAccess(tabId, probe) {
  logEvent('error', pageAccessHelpMsg(probe));
  state.status = 'idle';
  state.autoDownload = false;
  dlCancel = true;                      // pipeline bir sonraki kontrolde cikar
  setTimeout(() => {                    // uzun bir await'te takiliysa zorla sifirla
    if (dlCancel) {
      dlRunToken++;
      dlLoopActive = false;
      state.autoDlActive = false;
      state.bulkDownloading = false;
      restoreZoomIfForced();
      try { persist(); broadcast(); } catch (_) {}
    }
  }, 1500);
  await restoreZoomIfForced();
  await setTabAutoDiscard(tabId, true);
  await persist(); broadcast();
}

// Bekleme SW'DE yapılır — SAYFA setTimeout'u kullanılMAZ: Chrome gizli (arka plandaki)
// sekmede sayfa timer'larını KISAR (önce ~1 sn'e, 5 dk sonra DAKİKADA 1 uyanmaya) →
// kullanıcı başka sekmeye geçince otomasyon fiilen donuyordu. SW timer'ı sekme
// görünürlüğünden ETKİLENMEZ. SW'nin 30 sn idle ölümüne karşı her parça sonrası ucuz bir
// extension API çağrısı idle sayacını sıfırlar (eski "pending executeScript" keepalive'inin
// görevini devralır). tabId parametresi imza uyumu için duruyor (artık kullanılmıyor).
async function pageSleep(tabId, ms) {
  let left = ms;
  while (left > 0) {
    const t = Math.min(20000, left);
    await sleep(t);
    left -= t;
    try { await chrome.runtime.getPlatformInfo(); } catch (_) {} // SW keepalive
  }
}

// Parça parça bekler; arada durum 'running' değilse erken çıkar (durdur/duraklat tepkisi)
async function waitInterruptible(tabId, ms) {
  const chunk = 2000;
  let left = ms;
  while (left > 0 && state.status === 'running') {
    const t = Math.min(chunk, left);
    await pageSleep(tabId, t);
    left -= t;
  }
}

// ── Sayfa-içi THROTTLE-BAĞIŞIK bekleme yardımcısı (bir kez kurulur) ──────
// Enjekte edilen uzun döngülü fonksiyonlar (kaydırma, menü/upload bekleme) kendi içinde
// sayfa setTimeout'u kullanıyor; Chrome gizli sekmede bunları kısıyor (5 dk sonra dakikada 1).
// - __afWait (v175): MESAJ KOPRUSU. Her bekleme once bir MessageChannel mesajindan gecer, setTimeout
//   o "taze" gorevden kurulur. Chrome gizli sekmede ZINCIRLENMIS zamanlayicilari (bir zamanlayicinin
//   icinden kurulan zamanlayici) dakikaya hizaliyor; kopru zinciri her beklemede kirar.
//   ESKI worker yolu Flow v2'de (flow.google.com) HIC calismiyordu: sayfa
//   "require-trusted-types-for 'script'" + "worker-src 'self'" gonderiyor, blob: worker
//   "This document requires 'TrustedScriptURL' assignment" hatasiyla kurulamiyor ve sessizce duz
//   setTimeout'a dusuluyordu. Musteri kosusu 2026-09-15: sekme gorunmez kalinca her wait() ~60 sn
//   surdu, referans secimi prompt basina 5-7 dk, akis 58/177'de takildi.
//   Olcum (gercek Chrome, gizli flow.google.com sekmesi, 6 x 200 ms): setTimeout zinciri 360 sn,
//   AbortSignal.timeout ve scheduler.postTask da 360 sn (onlar da kisiliyor); kopru 6 sn ve 40 ardisik
//   beklemede sabit. Gorunur sekmede fark yok (mesaj gecikmesi 1 ms'nin altinda).
// - Web Lock: kilit tutan sayfa Chrome'un arka-plan sekme DONDURMASINDAN muaf tutulur
//   (kilit sayfa kapanana/yenilenene dek tutulur; başka hiçbir etkisi yok).
// İdempotent: ikinci çağrı hiçbir şey değiştirmez. MAIN world — self-contained.
async function installPageWaitHelper(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId }, world: 'MAIN',
      func: () => {
        // v175: surum isareti. Eski surumun kurdugu __afWait (worker kurulamadigi icin duz setTimeout)
        // sayfa yenilenmeden de bununla DEGISTIRILIR; calismakta olan enjekte fonksiyonlar window.__afWait'i
        // her beklemede yeniden okudugu icin kesintisiz yeni yola gecer.
        if (window.__afWaitV !== 175) {
          let bridged = null;
          try {
            const ch = new MessageChannel();
            const q = [];   // FIFO: mesajlar gonderildigi sirayla gelir
            ch.port1.onmessage = () => { const j = q.shift(); if (j) setTimeout(j.res, j.ms); };
            bridged = ms => new Promise(res => {
              q.push({ res, ms: Math.max(0, Number(ms) || 0) });
              try { ch.port2.postMessage(0); }
              catch (_) { const j = q.pop(); if (j) setTimeout(j.res, j.ms); }
            });
          } catch (e) { bridged = null; }
          window.__afWait = bridged || (ms => new Promise(res => setTimeout(res, ms)));
          window.__afWaitV = 175;
          console.log('[AutoFlow] __afWait kuruldu (' + (bridged ? 'mesaj köprüsü: gizli sekmede dakika kısmasına girmez' : 'setTimeout yedeği') + ')');
        }
        if (!window.__afFreezeLock && navigator.locks && navigator.locks.request) {
          window.__afFreezeLock = true; // kilit tutan sayfa tab-freeze'den muaf
          try { navigator.locks.request('autoflow-page-active', () => new Promise(() => {})); } catch (_) {}
        }
        // GÖRÜNÜRLÜK MASKESİ: Flow (birçok web uygulaması gibi) sekme gizlenince
        // (document.hidden) galeri/durum güncellemesini DURDURUYOR → üretim sunucuda sürse de
        // 'complete' tile DOM'a düşmüyor, indirme ancak sekmeye DÖNÜNCE akıyordu (kullanıcı
        // bildirdi). Sayfa kendini hep GÖRÜNÜR sanır: hidden=false, visibilityState='visible',
        // hasFocus=true; visibilitychange olayının uygulamaya ulaşması capture'da kesilir.
        // blur/focus olaylarına DOKUNULMAZ (Slate editör blur'u bozulmasın). Sayfa yenilenince
        // maske kendiliğinden kalkar. Otomasyon kullanılmadan ASLA kurulmaz.
        if (!window.__afVisSpoof) {
          window.__afVisSpoof = true;
          try { Object.defineProperty(document, 'hidden', { get: () => false, configurable: true }); } catch (_) {}
          try { Object.defineProperty(document, 'visibilityState', { get: () => 'visible', configurable: true }); } catch (_) {}
          try { Object.defineProperty(document, 'webkitHidden', { get: () => false, configurable: true }); } catch (_) {}
          try { document.hasFocus = () => true; } catch (_) {}
          const swallowVis = e => { try { e.stopImmediatePropagation(); } catch (_) {} };
          try { document.addEventListener('visibilitychange', swallowVis, true); } catch (_) {}
          try { window.addEventListener('visibilitychange', swallowVis, true); } catch (_) {}
          console.log('[AutoFlow] görünürlük maskesi kuruldu (arka planda galeri güncellensin)');
        }
        return true;
      }
    });
  } catch (e) { console.warn('[AutoFlow] wait-helper kurulamadı (throttle korumasız devam):', e.message); }
}

// ── Referans görseli bir kez Flow'a yükle ─────────────────────────────
// currentIndex === 0 olduğunda çağrılır. Tek görseli yükler ve yüklemenin
// tamamlanmasını OTOMATİK tespit eder (sabit süre yok; min 3 / maks 40 sn).
// Yükleme referansı OTOMATİK EKLEMEZ; seçim her üretimde selectRefsForPrompt ile yapılır.
// MAIN world — self-contained
async function uploadRefImagesToFlow(uploadNames) {
  const wait = ms => (window.__afWait ? window.__afWait(ms) : new Promise(r => setTimeout(r, ms))); // arka plan sekmede kısılmayan bekleme
  const all = window.__afRefImages || [];
  // uploadNames verildiyse (20'şerli parti) YALNIZ o adları yükle; verilmediyse tümü (eski yol).
  const imgs = (Array.isArray(uploadNames) && uploadNames.length)
    ? all.filter(im => uploadNames.includes(im.name))
    : all;
  if (!imgs.length) return { success: true, skipped: true };

  function findPlusBtn() {
    // Picker'ı (medya kütüphanesi dialog'u) AÇAN buton, kompozisyon kutusundaki
    // yuvarlak "+" butonudur ve aria-haspopup="dialog" taşır. Gönder/Oluştur
    // butonu (arrow_forward, en sağda) bunu taşımaz — ikisinin de metninde
    // "Oluştur" geçtiği için ayırt etmek şart.
    const isGen = s => /oluştur|olustur|generat|gönder|gonder|send|creat/i.test(s || '');
    const vis = b => {
      const r = b.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && window.getComputedStyle(b).display !== 'none';
    };
    const all = [...document.querySelectorAll('button, [role="button"]')].filter(vis);

    // 0) FLOW v2 (Angular Material, 2026-09): kompozisyondaki "+" artık
    //    button.add-menu-trigger ve aria-haspopup="true" taşıyor (ARTIK "dialog" DEĞİL).
    //    Eski birincil seçici bu yüzden düşüyor, metin yedeği ise sayfanın ÜSTÜNDEKİ
    //    "Medya menüsü ekle" butonunu ("add" ligature'ı, DOM'da daha önce) buluyordu →
    //    picker yerine üst menü açılıyordu. Sınıf adı dilden bağımsızdır.
    //    Ajan yan paneli açıkken sayfada İKİ tane olur; ana kompozisyon SOLDAKİdir.
    const v2Plus = all.filter(b => b.classList && b.classList.contains('add-menu-trigger'));
    if (v2Plus.length) {
      v2Plus.sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);
      return v2Plus[0];
    }

    // 1) BİRİNCİL: alt bölgedeki (kompozisyon) aria-haspopup="dialog" butonu.
    //    Birden çoksa en SOLDAKİ = medya "+" (gönder en sağdadır).
    const H = window.innerHeight;
    const popup = all
      .filter(b => b.getAttribute('aria-haspopup') === 'dialog')
      .filter(b => b.getBoundingClientRect().top > H * 0.5)
      .sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);
    if (popup.length) return popup[0];

    // 2) YEDEK: metin/etiketle medya-ekle butonu (Oluştur/Gönder hariç).
    return all.find(b => {
      const t   = b.textContent.trim().toLowerCase();
      const lbl = (b.getAttribute('aria-label') || b.title || '').toLowerCase();
      if (isGen(t) || isGen(lbl)) return false; // Oluştur/Gönder butonunu ele
      return t === 'add_2' || t === '+' || t === 'add' ||
             t === 'add_photo_alternate' || t === 'add_circle' ||
             t.includes('medya ekle') || t.includes('add media') ||
             t.includes('görsel ekle') || t.includes('add image') ||
             lbl.includes('add media') || lbl.includes('medya ekle') ||
             lbl.includes('görsel ekle') || lbl.includes('add image') ||
             lbl === '+' || lbl === 'add';
    }) || null;
  }

  // ── dataUrl → File ─────────────────────────────────────────────────────
  function toFile(img) {
    const arr  = img.dataUrl.split(',');
    const bstr = atob(arr[1]);
    const u8   = new Uint8Array(bstr.length);
    for (let k = 0; k < bstr.length; k++) u8[k] = bstr.charCodeAt(k);
    return new File([u8], img.name, { type: img.type });
  }

  // ── "Bu resmin kullanım hakları" onay penceresi (FLOW v2, 2026-09) ──────
  // Yükleme başlatılınca Flow bir mat-dialog açıyor: İptal / Kabul ediyorum.
  // Onaylanmazsa dosyalar HİÇ yüklenmez. Yalnızca ONAY metnine uyan butona basar;
  // uyan buton yoksa HİÇBİR ŞEYE dokunmaz (yanlış dialogda yanlış butona basmamak için).
  function acceptRightsDialog() {
    const dlgs = [...document.querySelectorAll('mat-dialog-container, [role="dialog"], [role="alertdialog"]')]
      .filter(d => { const r = d.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
    for (const d of dlgs) {
      const btns = [...d.querySelectorAll('button')]
        .filter(b => { const r = b.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
      if (!btns.length || btns.length > 3) continue;
      // v148: DİL KAPSAMI. Eski liste TR/EN/ES/PT/IT/FR/DE/RU idi; Arapça arayüzde
      // (kullanıcı raporu 2026-09-06) onay penceresi kapanmadığı için ilk yükleme hiç
      // tamamlanmıyordu. Yeni diller EKLENDİ, mevcut diller AYNEN duruyor.
      // ÖNCE RET MUHAFIZI: "İptal / Kapat / Kabul etmiyorum" butonları ELENİR. Bazı dillerde
      // ret metni onay metnini İÇERİR ("لا أوافق" ⊃ "أوافق", "不同意" ⊃ "同意", "동의하지" ⊃
      // "동의") → muhafız olmadan yanlış butona basılabilirdi. Mevcut dillerin onay metinleri
      // bu muhafıza TAKILMAZ → eski davranış birebir korunur.
      const NEG = /iptal|vazge|cancel|annul|abbrech|отмен|скасув|إلغاء|إغلاق|لا أوافق|לא מסכים|不同意|同意しない|동의하지|không đồng ý|nie zgadzam|niet akkoord|tidak setuju|nesouhlas|godkänn inte|godkänner inte|godtar ikke|accepterer ikke|nu sunt de acord|δεν συμφωνώ|असहमत|en hyväksy|nem fogadom/i;
      const ACC = /kabul ediyorum|kabul et|onaylıyorum|i agree|\bagree\b|\baccept\b|acepto|aceptar|aceito|aceitar|accetto|accetta|j.accepte|accepter|ich stimme|zustimmen|einverstanden|принимаю|соглас|أوافق|اوافق|موافق|أقبل|قبول|موافقم|تأیید|מסכים|אישור|सहमत|स्वीकार|setuju|akkoord|zgadzam|akceptuj|同意|承諾|동의|수락|đồng ý|ยอมรับ|погоджу|приймаю|de acord|godkänn|godta|hyväksyn|συμφωνώ|αποδοχή|souhlasím|elfogadom/i;
      const ok = btns.find(b => {
        const t = (b.textContent || '').replace(/\s+/g, ' ').trim();
        if (NEG.test(t)) return false;
        return ACC.test(t);
      });
      if (ok) { try { ok.click(); } catch (_) {} return true; }
    }
    return false;
  }

  // ── Dosyaları file input'a enjekte et ──────────────────────────────────
  async function injectFiles(fileImgs) {
    // ── FLOW v2 (Angular Material, 2026-09) — SÜRÜKLE-BIRAK YOLU ─────────
    // "Medya yükle" artık input[type=file]'ı ANLIK oluşturup .click()'liyor →
    // işletim sistemi dosya penceresi açılır, eklenti oraya enjekte EDEMEZ (eskiden
    // input DOM'da kalıcıydı). Flow proje alanı dosya BIRAKMAYI kabul ediyor
    // ("Oluşturmaya başlayın veya medya dosyası bırakın") → aynı yükleme RPC'leri
    // tetiklenir. Canlı Flow'da doğrulandı. Eski arayüzde bu dal HİÇ çalışmaz.
    if (document.querySelector('flow-project-page, flow-prompt-box')) {
      const tgt = document.querySelector('flow-project-page') ||
                  document.querySelector('flow-prompt-box') || document.body;
      const r = tgt.getBoundingClientRect();
      const base = { bubbles: true, cancelable: true, composed: true,
                     clientX: Math.round(r.left + r.width / 2),
                     clientY: Math.round(r.top + r.height / 2) };
      window.__afBaseImgs = [...document.querySelectorAll('img')]
        .filter(im => /^https?:/.test(im.src || '') && im.complete && im.naturalWidth > 0).length;
      const dt2 = new DataTransfer();
      for (const img of fileImgs) { try { dt2.items.add(toFile(img)); } catch (_) {} }
      if (!dt2.files.length) { console.log('[AutoFlow] Upload v2: dosya kurulamadı'); return false; }
      for (const type of ['dragenter', 'dragover', 'drop']) {
        try { tgt.dispatchEvent(new DragEvent(type, { ...base, dataTransfer: dt2 })); } catch (_) {}
        await wait(220);
      }
      // Onay penceresi (ilk yüklemede kesin, sonrakilerde HİÇ çıkmaz) — kısa gözle.
      // Uzun tutmak, dialog çıkmayan her partide boşuna bekleme demek; geç çıkan dialog
      // zaten aşağıdaki tamamlanma döngüsünde de yakalanıyor.
      let accepted = false;
      for (let i = 0; i < 10; i++) { if (acceptRightsDialog()) { accepted = true; break; } await wait(300); }
      window.__afUploadV2 = true;
      console.log('[AutoFlow] Upload v2: sürükle-bırak ile', dt2.files.length,
                  'dosya | hak onayı:', accepted ? 'kabul edildi' : 'çıkmadı');
      await wait(1000);
      return true;
    }
    const pb = findPlusBtn();
    if (!pb) { console.log('[AutoFlow] Upload: + btn yok'); return false; }
    pb.click(); await wait(1200);

    // Yeni Flow arayüzünde "+" doğrudan picker'ı açıyor ve file input zaten orada.
    // Eski arayüzde önce "Medya yükle" tıklanması gerekiyordu — varsa tıkla, yoksa
    // doğrudan file input'a enjekte et.
    const uploadLink = [...document.querySelectorAll('button, a, [role="button"]')]
      .find(b => { const t = b.textContent.toLowerCase();
        return t.includes('medya yükle') || t.includes('upload media'); });
    if (uploadLink) { uploadLink.click(); await wait(800); }

    const fi = document.querySelector('input[type="file"]');
    if (!fi) {
      console.log('[AutoFlow] Upload: file input yok');
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await wait(500);
      return false;
    }

    const dt = new DataTransfer();
    for (const img of fileImgs) {
      const arr  = img.dataUrl.split(',');
      const bstr = atob(arr[1]);
      const u8   = new Uint8Array(bstr.length);
      for (let k = 0; k < bstr.length; k++) u8[k] = bstr.charCodeAt(k);
      dt.items.add(new File([u8], img.name, { type: img.type }));
    }
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'files')?.set;
    if (setter) setter.call(fi, dt.files);
    else fi.files = dt.files;

    // Yükleme tespiti için temel: enjeksiyondan ÖNCE yüklü görsel sayısı
    window.__afBaseImgs = [...document.querySelectorAll('img')]
      .filter(im => /^https?:/.test(im.src || '') && im.complete && im.naturalWidth > 0).length;

    fi.dispatchEvent(new Event('change', { bubbles: true }));
    console.log('[AutoFlow] Upload: enjekte', fileImgs.length, 'dosya | base img:', window.__afBaseImgs);
    await wait(1200); // picker yerleşsin (Escape YOK — tamamlanma tespiti dışarıda yapılır)
    return true;
  }

  // 1) TÜM referansları tek seferde yükle (picker açık kalır).
  //    injectFiles dizi alır → hepsini tek DataTransfer ile enjekte eder.
  const ok = await injectFiles(imgs);
  if (!ok) return { success: false, requested: imgs.length, injected: 0 };

  // ── FLOW v2: yükleme PICKER'a değil, proje GALERİSİNE düşer ────────────
  // Aşağıdaki (v121/v123) tamamlanma tespiti picker'ın kart/ad/yüzde sinyallerine
  // dayanıyor; v2'de picker hiç açılmıyor. Yerine çok daha net bir sinyal var:
  // galeri tile'ının alt şeridinde (flow-tile-hover-footer) DOSYA ADI yazıyor —
  // hover gerekmez, metin her zaman DOM'da. Ad göründüyse dosya yüklenmiştir.
  if (window.__afUploadV2) {
    // ── v157 KISA DOSYA ADI TUZAĞI (kullanıcı logu 2026-09-08, Exariel) ──────────
    // Eski kod, stem'i eşikten kısa olan dosyaları listeden TAMAMEN atıyordu. Kullanıcının
    // dosyaları a.jpeg / b.jpeg gibi TEK HARFLİ olunca liste BOŞ kalıyor, beklenen ad sayısı
    // 0 oluyor ve tamamlanma döngüsü daha ilk turda "hazır:0/0 bekleme:0sn" ile çıkıyordu:
    // 14 dosya Flow'a yüklenirken HİÇ beklemeden kare yerleştirmeye geçiliyordu (logda hemen
    // ardından "flow-ingredient-bar YOK" gelip ilk koşu tamamen çuvalladı).
    // ÇÖZÜM: kısa stem yerine TAM AD (uzantılı) kullan. Eşiğin amacı 1-2 harflik alt dizeyle
    // yanlış eşleşmeyi önlemekti; "a" tehlikeli bir alt dize, "a.jpeg" değil. Uzun adlarda
    // davranış BİREBİR eskisi gibi kalır (stem kullanılır).
    const stemsV2 = imgs.map(im => {
      const full = (im.name || '').toLowerCase();
      const stem = full.replace(/\.[a-z0-9]+$/i, '');
      return stem.length >= 3 ? stem : full;
    }).filter(s => s.length >= 3);
    const galleryText = () => {
      let t = '';
      for (const f of document.querySelectorAll('flow-tile-hover-footer')) t += ' ' + (f.textContent || '');
      if (!t.trim()) t = ((document.querySelector('flow-project-page') || document.body).textContent || '');
      return t.toLowerCase();
    };
    const hitsNow = () => { const t = galleryText(); return stemsV2.filter(s => t.includes(s)).length; };
    const need2  = stemsV2.length;
    const MAXV2  = Math.min(300000, 45000 + need2 * 6000);
    const QUIET2 = 7000;                       // bu kadar süre yeni ad gelmiyorsa oturmuştur
    const t0 = Date.now();
    let best = 0, lastChange = Date.now(), whyV2 = 'timeout';
    while (Date.now() - t0 < MAXV2) {
      acceptRightsDialog();                    // gecikmeli çıkan onay penceresini de yakala
      const h = hitsNow();
      if (h > best) { best = h; lastChange = Date.now(); }
      if (best >= need2) { whyV2 = 'names'; break; }
      if (best > 0 && Date.now() - lastChange > QUIET2) { whyV2 = 'quiet'; break; }
      await wait(500);
    }
    const secsV2 = Math.round((Date.now() - t0) / 1000);
    // Referans kimliklerini yakala: v2 medya URL'i flow-content.google/<tip>/<uuid>
    // ("?name=" biçimi kalktı) → indirme pipeline'ı referansları asla indirmesin.
    let capV2 = 0;
    try {
      window.__afRefIds = window.__afRefIds || {};
      for (const tile of document.querySelectorAll('flow-grid-tile-container, flow-tile-container')) {
        const tx = (tile.textContent || '').toLowerCase();
        if (!stemsV2.some(s => tx.includes(s))) continue;
        for (const im of tile.querySelectorAll('img')) {
          const id = (String(im.src || '').match(/flow-content\.google\/[a-z]+\/([0-9a-f][0-9a-f-]{15,})/i) || [])[1];
          if (id && !window.__afRefIds[id]) { window.__afRefIds[id] = 1; capV2++; }
        }
      }
    } catch (_) {}
    console.log('[AutoFlow] UPLOAD v2 diag — hazır:' + best + '/' + need2 +
                ' bekleme:' + secsV2 + 'sn (detected:' + whyV2 + ') kimlik:+' + capV2);
    await wait(600);
    return { success: true, requested: imgs.length, injected: imgs.length,
             detected: whyV2 !== 'timeout', waited: secsV2, why: whyV2,
             ready: best + '/' + need2, v2: true };
  }

  // 2) Yüklemenin tamamlanmasını OTOMATİK tespit et — HAZIR OLUNCA HEMEN, boşuna beklemeden.
  //    v121 KÖK NEDEN: Flow dosyaları sırayla işliyor ve genelde SON dosya (listede ilk
  //    sırada duran 0001) picker'da bir süre "%99" kalıyor. Eski kod "yüklü görsel SAYISI
  //    base+N'e ulaştı" sinyaliyle erken çıkabiliyordu → hemen ardından gelen seçim o kartı
  //    bulamıyor, prompt KARESİZ gidiyordu. v121 çözümü: TÜM adlar picker'da görünene kadar bekle.
  //    v123 KÖK NEDEN (kullanıcı: "referanslar yüklendikten sonra dakikalarca bekliyor"):
  //    v121'in "TÜM adlar" şartı gerçek Flow'da ÇOĞU ZAMAN hiç sağlanmıyor — picker listeyi
  //    sanallaştırıyor (20/40 dosyanın yalnız görünen kartları DOM'da) ve picker DOM'unda
  //    kalıcı/gizli bir role="progressbar" bulunabiliyor (eski kod görünürlüğe bakmadan bunu
  //    "yükleme sürüyor" sayıyordu). İkisi de çıkışı engellediği için yükleme çoktan bitmişken
  //    STALL (45 sn) ya da MAX (2+ dk) dolana kadar bekleniyordu; parça başına, parti başına.
  //    v123 çözümü — ESKİ ÇIKIŞLAR AYNEN DURUYOR, üzerine üç şey eklendi:
  //      (a) OTURDU sinyali: picker'a yeni kart/ad gelmiyor + gösterge yok + dosyaların
  //          düştüğü kanıtlı → hemen devam (adların TAMAMINI görmek şart değil).
  //      (b) Gösterge artık İMZA: değişmiyorsa ilerlemiyordur; görünmeyen ve %100 çubuklar
  //          hiç sayılmaz. Gerçek "%99 platosu" (v121'in koruduğu durum) hâlâ bekletir.
  //      (c) "Oturdu" ölçümü picker KAPSAMLI: arkadaki üretim akışının sürekli yüklenen
  //          tile'ları sinyali bozmaz.
  // ── v157 KISA DOSYA ADI TUZAĞI (kullanıcı logu 2026-09-08, Exariel) ──────────
  // Eski kod, stem'i eşikten kısa olan dosyaları listeden TAMAMEN atıyordu. Kullanıcının
  // dosyaları a.jpeg / b.jpeg gibi TEK HARFLİ olunca liste BOŞ kalıyor, beklenen ad sayısı
  // 0 oluyor ve tamamlanma döngüsü daha ilk turda "hazır:0/0 bekleme:0sn" ile çıkıyordu:
  // 14 dosya Flow'a yüklenirken HİÇ beklemeden kare yerleştirmeye geçiliyordu (logda hemen
  // ardından "flow-ingredient-bar YOK" gelip ilk koşu tamamen çuvalladı).
  // ÇÖZÜM: kısa stem yerine TAM AD (uzantılı) kullan. Eşiğin amacı 1-2 harflik alt dizeyle
  // yanlış eşleşmeyi önlemekti; "a" tehlikeli bir alt dize, "a.jpeg" değil. Uzun adlarda
  // davranış BİREBİR eskisi gibi kalır (stem kullanılır).
  const stems = imgs.map(im => {
    const full = (im.name || '').toLowerCase();
    const stem = full.replace(/\.[a-z0-9]+$/i, '');
    return stem.length >= 4 ? stem : full;
  }).filter(s => s.length >= 4);
  const base = window.__afBaseImgs || 0;
  const need = imgs.length;
  // ── Picker (yükleme diyaloğu) kökü — "oturdu mu" ölçümü YALNIZ burada yapılır ─────
  // v123: arkadaki üretim akışı sürekli yeni tile yüklüyor; belge geneli görsel sayısı
  // hiç durmuyor. Kapsamı picker'la sınırlamazsak "yeni kart gelmiyor" sinyali ASLA oluşmaz.
  function pickerDlg() {
    return [...document.querySelectorAll('[role="dialog"], [aria-modal="true"]')]
      .filter(d => { const r = d.getBoundingClientRect(); return r.width > 340 && r.height > 220; }).pop() || null;
  }
  // Picker'ın İÇİNDE yüzde/ilerleme göstergesi varsa yükleme SÜRÜYOR demektir. Kapsam şart:
  // arkadaki üretim akışında da yüzdeler var, onlar bu kararı etkilememeli.
  // "%99" hem "99%" hem TR'deki "%99" biçiminde yazılabilir; %100 BİTTİ demektir, engellemez.
  // v123: artık boolean değil İMZA döner ('' = gösterge yok). İmza DEĞİŞMİYORSA gösterge
  // ilerlemiyor demektir (dekoratif/donmuş çubuk) → aşağıda belirli bir süre sonra yok sayılır.
  // Görünmeyen ya da %100'e ulaşmış çubuklar hiç sayılmaz.
  function uploadBusySig() {
    const dlg = pickerDlg();
    if (!dlg) return '';
    let sig = '';
    for (const pb of dlg.querySelectorAll('[role="progressbar"], progress')) {
      const r = pb.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;                 // görünmeyen gösterge sayılmaz
      const v = pb.getAttribute('aria-valuenow') ?? pb.getAttribute('value') ?? '';
      if (v !== '' && Number(v) >= 100) continue;                  // %100 = bitti
      sig += 'p' + v + ';';
    }
    const tx = dlg.textContent || '';
    const m = tx.match(/(?:^|[^\d])(\d{1,2})\s*%/) || tx.match(/%\s*(\d{1,2})(?:\D|$)/);
    if (m) sig += 'n' + m[1];
    return sig;
  }
  // Picker içinde GERÇEKTEN yüklenmiş (çizilmiş) kart görselleri
  function pickerImgCount(dlg) {
    if (!dlg) return -1;
    return [...dlg.querySelectorAll('img')]
      .filter(im => /^https?:/.test(im.src || '') && im.complete && im.naturalWidth > 0).length;
  }
  const MIN = 3000;
  const MAX = Math.min(240000, 60000 + need * 4000); // güvenlik tavanı (artık normalde görülmez)
  const STALL = 45000;       // ne yeni ad belirdi ne de yükleme göstergesi → boşuna bekleme
  const BUSY_GRACE = 90000;  // adlar göründü ama yüzde hâlâ dönüyorsa en fazla bu kadar beklenir
  // v123: picker'a yeni kart gelmiyor + gösterge yok → yükleme OTURDU. 4 sn bilerek seçildi:
  // Flow kartları peş peşe basarken aralarında kısa boşluklar olabiliyor; eşik çok kısa olursa
  // yüklemenin ORTASINDA "oturdu" sanılır (v121'in düzelttiği karesiz-prompt hatası geri gelir).
  const QUIET = 4000;
  const POLL  = 500;
  // v123: gösterge DEĞİŞMEDEN bu kadar durursa "ilerlemiyor" sayılır ve yok sayılır.
  // Sayı içeren imzada (ör. "%99") uzun tutulur — v121'in koruduğu gerçek 99% platosu budur.
  // Sayısız imzada (değer bildirmeyen sonsuz spinner) hiçbir bilgi taşımaz, kısa tutulur.
  const STUCK_NUM = 45000, STUCK_FLAT = 9000;
  const t0 = Date.now();
  await wait(MIN);
  let detected = false, namesUsable = false, hits = 0, lastHits = -1,
      lastChange = Date.now(), stalled = false, allReadyAt = 0,
      lastSig = null, sigAt = Date.now(), everBusy = false,
      pFirst = -1, lastP = -2, why = '';
  while (Date.now() - t0 < MAX) {
    const loaded = [...document.querySelectorAll('img')]
      .filter(im => /^https?:/.test(im.src || '') && im.complete && im.naturalWidth > 0);
    const ctxAll = loaded.map(im =>
      ((im.alt || '') + ' ' + (im.title || '') + ' ' +
       (im.closest('[role="button"],li,a,div')?.textContent || '')).toLowerCase());
    hits = stems.filter(st => ctxAll.some(c => c.includes(st))).length;
    if (hits > 0) namesUsable = true;                       // bu arayüzde adlar GÖRÜNÜYOR
    const sig = uploadBusySig();
    if (sig !== lastSig) { lastSig = sig; sigAt = Date.now(); }
    if (sig) everBusy = true;
    const stuckMs = /\d/.test(sig) ? STUCK_NUM : STUCK_FLAT;
    const busy     = !!sig && (Date.now() - sigAt < stuckMs);   // ilerlemeyen gösterge = meşgul DEĞİL
    const dlg      = pickerDlg();
    const pImgs    = pickerImgCount(dlg);
    if (pFirst < 0 && pImgs >= 0) pFirst = pImgs;
    const namesAll = !!(stems.length && hits === stems.length);
    const countAll = !namesUsable && loaded.length >= base + need;   // adlar görünmeyen varyant
    // Picker'da kart/ad sayısı arttı mı? (yükleme hâlâ sürüyor demektir)
    const moving   = (hits !== lastHits) || (pImgs !== lastP);
    if (moving || busy) { lastHits = hits; lastP = pImgs; lastChange = Date.now(); }
    // Yeni dosyaların picker'a DÜŞTÜĞÜNE dair kanıt — bu olmadan "sessizlik" hazır sayılmaz
    // (enjeksiyondan hemen sonraki ölü an, dolu bir picker'da erken çıkışa yol açmasın).
    const landed = hits > 0 || (pFirst >= 0 && pImgs > pFirst) || everBusy;
    if (namesAll || countAll) {
      // Kartlar göründü. Ama Flow hâlâ bir dosyayı işliyorsa (%99) o kart SEÇİLEMİYOR →
      // eski kod tam burada çıkıyor ve prompt karesiz gidiyordu. Yüzde kaybolana kadar bekle.
      if (!allReadyAt) allReadyAt = Date.now();
      if (!busy || Date.now() - allReadyAt > BUSY_GRACE) { detected = true; why = namesAll ? 'names' : 'count'; break; }
    } else {
      allReadyAt = 0;
      // v123 ASIL DÜZELTME: picker listeyi SANALLAŞTIRIYOR — 20 dosya yüklense de aynı anda
      // yalnız görünen kartlar DOM'da olur, dolayısıyla "TÜM adlar göründü" koşulu ÇOĞU ZAMAN
      // hiç sağlanmaz. Eski kod bu yüzden yükleme çoktan bitmişken STALL (45 sn) ya da MAX
      // (2+ dk) dolana kadar boşuna bekliyordu. Artık kartlar oturduğu ANDA devam edilir:
      // yeni kart/ad gelmiyor + ilerleme göstergesi yok + dosyaların düştüğü kanıtlı.
      if (landed && !busy && Date.now() - lastChange > QUIET) { detected = true; why = 'quiet'; break; }
    }
    if (!(moving || busy) && Date.now() - lastChange > STALL) { stalled = true; why = 'stall'; break; }
    await wait(POLL);
  }
  if (!detected && !stalled) why = 'timeout';
  const secs = Math.round((Date.now() - t0) / 1000);
  console.log('[AutoFlow] Upload:', detected ? 'yükleme tespit edildi (' + why + ')' : (stalled ? 'ilerleme durdu, devam' : 'zaman aşımı, devam'),
              '(' + secs + ' sn, ' + need + ' görsel, hazır ad: ' + hits + '/' + stems.length + ')');

  // TEŞHİS: kapatmadan ÖNCE picker'da görünen toplam https görsel sayısı
  const pickerImgs = [...document.querySelectorAll('img')]
    .filter(im => /^https?:/.test(im.src || '') && im.complete && im.naturalWidth > 0).length;

  // REFERANS KİMLİKLERİNİ YAKALA (picker'da, kapatmadan ÖNCE). Picker'da dosya ADI GÖRÜNÜR
  // (alt/title/yakın metin); ada eşleşen img'in Flow medya kimliğini (?name=) al → indirme
  // pipeline'ı bu görseli feed'de ASLA indirmesin. Feed thumbnail'ında ad YAZMADIĞINDAN ad-bazlı
  // hariç tutma feed'de tutmuyor (özellikle %33 zoom reflow'unda); kimlik (?name=) her yerde SABİT.
  try {
    window.__afRefIds = window.__afRefIds || {};
    let cap = 0;
    for (const im of document.querySelectorAll('img')) {
      const src = im.src || '';
      if (!/^https?:/.test(src)) continue;
      const id = (src.match(/(?:[?&]name=|flow-content\.google\/[a-z]+\/)([^&?/]+)/i) || [])[1];
      if (!id || window.__afRefIds[id]) continue;
      // dosya adı bu img'in YAKININDA mı? (picker'da ad GÖRÜNÜR; 4 ataya kadar metni topla)
      let ctx = (im.getAttribute('alt') || '') + ' ' + (im.getAttribute('title') || '');
      let p = im;
      for (let i = 0; i < 4 && p; i++) { ctx += ' ' + (p.textContent || ''); p = p.parentElement; }
      ctx = ctx.toLowerCase();
      if (stems.some(s => ctx.includes(s))) { window.__afRefIds[id] = 1; cap++; }
    }
    console.log('[AutoFlow] Upload: referans kimlikleri yakalandı →', cap, '| toplam:', Object.keys(window.__afRefIds).length);
  } catch (_) {}

  // 3) Küçük tampon + picker'ı kapat
  await wait(1200);
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await wait(700);
  console.log('[AutoFlow] Upload done:', imgs.map(i => i.name).join(', '));
  return { success: true, requested: imgs.length, injected: imgs.length,
           pickerImgs, base, detected, stalled, waited: secs, why,
           ready: hits + '/' + stems.length };
}

// ── Her prompttan önce referansı seç ──────────────────────────────────
// BİRİNCİL: yüklediğimiz referansın DOSYA ADINI picker'da ara → nerede
//   olursa olsun bul. Konum güvenilir değil çünkü üretimler listeye
//   düştükçe referans alt sıralara kayıyor (zamanlamaya bağlı).
// YEDEK: ad bulunamazsa konum (idx 0 → pos 0, idx ≥ 1 → pos 1).
// MAIN world — self-contained
async function selectRefsForPrompt(idx) {
  const waitRaw = ms => (window.__afWait ? window.__afWait(ms) : new Promise(r => setTimeout(r, ms))); // arka plan sekmede kısılmayan bekleme
  // v126.1: HER beklemede meşgul bayrağını tazele → seçim ne kadar sürerse sürsün indirme
  // döngüsünün ızgara düzeltmesi araya girip picker'ı kapatamaz (bkz. ensureGridViewOnFlow).
  const wait = ms => { try { window.__afSelBusy = Date.now(); } catch (_) {} return waitRaw(ms); };
  const refImgs = window.__afRefImages || [];
  if (!refImgs.length) return { success: true, skipped: true };
  // v126: seçim sürerken İNDİRME döngüsünün ızgara düzeltmesi araya girip picker'ı
  // kapatmasın (o düzeltme UI kilidinin DIŞINDA, her tarama turunda çalışıyor).
  const touch = () => { try { window.__afSelBusy = Date.now(); } catch (_) {} };
  touch();

  // ── + butonunu bul (sayfa genelinde) ───────────────────────────────────
  function findPlusBtn() {
    // Picker'ı (medya kütüphanesi dialog'u) AÇAN buton, kompozisyon kutusundaki
    // yuvarlak "+" butonudur ve aria-haspopup="dialog" taşır. Gönder/Oluştur
    // butonu (arrow_forward, en sağda) bunu taşımaz — ikisinin de metninde
    // "Oluştur" geçtiği için ayırt etmek şart.
    const isGen = s => /oluştur|olustur|generat|gönder|gonder|send|creat/i.test(s || '');
    const vis = b => {
      const r = b.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && window.getComputedStyle(b).display !== 'none';
    };
    const all = [...document.querySelectorAll('button, [role="button"]')].filter(vis);

    // 0) FLOW v2 (Angular Material, 2026-09): kompozisyondaki "+" artık
    //    button.add-menu-trigger ve aria-haspopup="true" taşıyor (ARTIK "dialog" DEĞİL).
    //    Eski birincil seçici bu yüzden düşüyor, metin yedeği ise sayfanın ÜSTÜNDEKİ
    //    "Medya menüsü ekle" butonunu ("add" ligature'ı, DOM'da daha önce) buluyordu →
    //    picker yerine üst menü açılıyordu. Sınıf adı dilden bağımsızdır.
    //    Ajan yan paneli açıkken sayfada İKİ tane olur; ana kompozisyon SOLDAKİdir.
    const v2Plus = all.filter(b => b.classList && b.classList.contains('add-menu-trigger'));
    if (v2Plus.length) {
      v2Plus.sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);
      return v2Plus[0];
    }

    // 1) BİRİNCİL: alt bölgedeki (kompozisyon) aria-haspopup="dialog" butonu.
    //    Birden çoksa en SOLDAKİ = medya "+" (gönder en sağdadır).
    const H = window.innerHeight;
    const popup = all
      .filter(b => b.getAttribute('aria-haspopup') === 'dialog')
      .filter(b => b.getBoundingClientRect().top > H * 0.5)
      .sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);
    if (popup.length) return popup[0];

    // 2) YEDEK: metin/etiketle medya-ekle butonu (Oluştur/Gönder hariç).
    return all.find(b => {
      const t   = b.textContent.trim().toLowerCase();
      const lbl = (b.getAttribute('aria-label') || b.title || '').toLowerCase();
      if (isGen(t) || isGen(lbl)) return false; // Oluştur/Gönder butonunu ele
      return t === 'add_2' || t === '+' || t === 'add' ||
             t === 'add_photo_alternate' || t === 'add_circle' ||
             t.includes('medya ekle') || t.includes('add media') ||
             t.includes('görsel ekle') || t.includes('add image') ||
             lbl.includes('add media') || lbl.includes('medya ekle') ||
             lbl.includes('görsel ekle') || lbl.includes('add image') ||
             lbl === '+' || lbl === 'add';
    }) || null;
  }

  // ── "İsteme ekle" butonu (sayfa genelinde — picker kökünü bulmaya yarar) ─
  function findAddBtn() {
    // Onay butonu ("İsteme ekle" / "Add to prompt" / "Добавить в запрос") bir AKSİYONDUR:
    // aria-haspopup'ı YOKTUR. "Добавить медиаконтент" (haspopup=menu, yükleme menüsünü açar) ve
    // "+" (haspopup=dialog) gibi MENÜ/DIALOG AÇAN butonlar ELENİR → RU'da yanlışlıkla yükleme
    // menüsü açılıp takılma hatası önlenir. Bu ayrım DİLDEN BAĞIMSIZDIR (her dilde "medya ekle"
    // bir menü açıcı, onay ise düz aksiyondur). TR/EN onay butonunda da haspopup yoktur → korunur.
    // FLOW v2 (Angular Material): onay butonu picker'ın detay panelindedir →
    // <button class="detail-add-to-prompt-btn">. Sınıf dilden bağımsız. Metin yedeği
    // v2'de TEHLİKELİ: galeri kartının ⋮ menüsünde de "İsteme ekle" maddesi var.
    const v2p = v2PickerPane();
    if (v2p) {
      const okv = b => { const r = b.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      const v2a = v2p.querySelector('button.detail-add-to-prompt-btn');
      if (v2a && okv(v2a)) return v2a;
      // v126.1: SINIF ADI DEĞİŞMİŞ OLABİLİR. Eskiden burada null dönülüyordu → onay butonu
      // ekranda DURURKEN (ekran görüntüsüyle doğrulandı) kod onu hiç göremiyor, referans
      // eklenemiyordu. Artık picker'ın DETAY PANELİ içinde metinle de aranır; galeri
      // kartının ⋮ menüsündeki "İsteme ekle" maddesi picker'ın DIŞINDA olduğu için karışmaz.
      const det = v2p.querySelector('flow-add-menu-detail-pane') || v2p;
      const cand = [...det.querySelectorAll('button, [role="button"]')].filter(b => {
        if (!okv(b)) return false;
        if (b.classList && b.classList.contains('asset-item')) return false;   // kart değil
        if (b.getAttribute('aria-haspopup')) return false;                     // menü açıcı değil
        const t = (b.textContent + ' ' + (b.getAttribute('aria-label') || '')).toLowerCase();
        return /steme ekle|add to prompt|в запрос|añadir|agregar|adicionar|ajouter|hinzufügen|aggiungi|toevoegen|追加|추가|添加|新增|thêm|إضافة|जोड़/.test(t);
      });
      if (cand.length) {
        cand.sort((a, b) => b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom);
        return cand[0];
      }
      return null;   // v2 picker açık ama onay yok (Kareler yolu tek tıkla doldurur)
    }
    const adds = [...document.querySelectorAll('button, [role="button"]')].filter(b => {
      const r = b.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return false;
      if (b.getAttribute('aria-haspopup')) return false;                  // menü/dialog açıcıları ele
      const s = (b.textContent + ' ' + (b.getAttribute('aria-label') || '')).toLowerCase();
      return /steme ekle|add to prompt|в запрос|добавить|añadir|agregar|adicionar|ajouter|hinzufügen|aggiungi|toevoegen|追加|추가|添加|新增|thêm|إضافة|जोड़/.test(s);
    });
    if (!adds.length) return null;                                        // yoksa çağıran çift-tık'a düşer
    // Birden çoksa: picker dialog'u İÇİNDEKİNİ ve en ALTTAKİNİ (footer onayı) tercih et.
    const inDlg = adds.filter(b => b.closest('[role="dialog"], [aria-modal="true"]'));
    const pick = inDlg.length ? inDlg : adds;
    pick.sort((a, b) => b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom);
    return pick[0];
  }

  // ── Picker arama kutusunu bul ("Öğeleri arayın") ───────────────────────
  // v120: KAPSAM parametresi eklendi. Flow'un sayfa ÜSTÜNDEKİ genel arama kutusu da bu
  // desene uyuyor ve DOM'da daha ÖNCE geldiğinden, kapsamsız arama onu bulup dosya adını
  // ORAYA yazıyordu → picker filtrelenmiyor, kart bulunamıyordu. Kapsam verildiğinde
  // (picker kökü) yalnız picker'ın kendi kutusu kabul edilir. Kapsam verilmezse davranış
  // ESKİSİYLE BİREBİR aynı (findPickerRoot'un yedek yolu bunu kullanır).
  function findPickerSearch(scope) {
    // FLOW v2: picker'ın kendi arama kutusu <input class="search-input">. Sayfanın
    // ÜSTÜNDEKİ genel arama çubuğu da AYNI sınıfı taşır → kapsam olmadan asla kullanma.
    if (scope && scope.querySelector) {
      const v2 = scope.querySelector('input.search-input');
      if (v2) { const vr = v2.getBoundingClientRect(); if (vr.width > 0 && vr.height > 0) return v2; }
    }
    const match = inp => {
      const r = inp.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return false;
      const s = ((inp.getAttribute('placeholder') || '') + ' ' +
                 (inp.getAttribute('aria-label') || '')).toLowerCase();
      // TR/EN AYNEN + yaygın diller (arama opsiyoneldir; bulunamazsa çağıran zaten devam eder).
      return /ara|search|öğe|поиск|buscar|pesquisar|rechercher|suchen|cerca|zoek|検索|검색|搜索|搜尋|tìm|بحث|खोज/.test(s);
    };
    const SEL = 'input[type="text"], input[type="search"], input:not([type])';
    // v126.2: FLOW v2'de KAPSAMSIZ arama YASAK. Sayfanın ÜST arama çubuğu da aynı desene
    // uyuyor ve DOM'da daha önce geliyor → dosya adı ORAYA yazılıyor, picker filtrelenmiyor,
    // üstelik sayfa medya kütüphanesi görünümüne kayıp seçimi tamamen çökertiyor.
    const v2page = !!document.querySelector('flow-prompt-box, flow-base-prompt-box, flow-project-page');
    if (!scope) return v2page ? null : ([...document.querySelectorAll(SEL)].find(match) || null);
    const inner = [...scope.querySelectorAll(SEL)].find(match);
    if (inner) return inner;
    if (v2page) return null;                    // portal yedeği v2'de kullanılmaz (üst çubuk tuzağı)
    // Portal: DOM'da picker'ın dışında ama EKRANDA picker'ın içinde duran input de kabul
    const pr = scope.getBoundingClientRect ? scope.getBoundingClientRect() : null;
    if (!pr || pr.width <= 0) return null;
    return [...document.querySelectorAll(SEL)].find(inp => {
      if (!match(inp)) return false;
      const r = inp.getBoundingClientRect();
      return r.left >= pr.left - 8 && r.right <= pr.right + 8 &&
             r.top  >= pr.top  - 8 && r.bottom <= pr.bottom + 8;
    }) || null;
  }

  // ── Arama input'unu HAZIRLA (RU/katlanmış arama için) ──────────────────
  // TR/EN'de arama kutusu görünür bir INPUT → findPickerSearch onu bulur, bu helper
  // hiç tıklamaz (davranış AYNEN). RU'da ise arama bir İKON BUTON (metni "search"
  // Material ligature'ı — DİLDEN BAĞIMSIZ, her dilde aynı); onu tıklayıp açar ve
  // beliren input'u döndürür. Böylece kart fold altında/sanallaştırılmış olsa bile
  // ada göre filtrelenip bulunabilir.
  async function ensureSearchInput() {
    const pickerRoot = findPickerRoot();               // v120: arama YALNIZ picker içinde aranır
    // v126.2: picker YOKSA arama YAPMA. Eskiden document kapsamına düşüp dosya adını
    // sayfanın ÜST arama çubuğuna yazıyordu → picker filtrelenmiyor, sayfa kütüphane
    // görünümüne kayıyor, kartlar kayboluyordu (kullanıcı raporu 2026-09-05).
    if (!pickerRoot) return null;
    let s = findPickerSearch(pickerRoot);
    if (s) return s;                                   // TR/EN: input zaten görünür → tıklama YOK
    const root = pickerRoot;
    const btn = [...root.querySelectorAll('button, [role="button"]')].find(b => {
      const r = b.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return false;
      if (b.getAttribute('aria-haspopup')) return false;   // sıralama/filtre menüsü değil
      const t   = (b.textContent || '').toLowerCase();
      const lbl = (b.getAttribute('aria-label') || '').toLowerCase();
      return t.includes('search') ||                  // Material ikon ligature'ı (dilden bağımsız)
             /search|ara|поиск|buscar|rechercher|suchen|検索|검색|搜索|搜尋|tìm|بحث|खोज/.test(lbl);
    });
    if (!btn) return null;
    robustClick(btn);
    for (let i = 0; i < 8; i++) { await wait(200); s = findPickerSearch(pickerRoot); if (s) return s; }
    return null;
  }

  // ── Picker (modal) kökünü bul ──────────────────────────────────────────
  // KRİTİK: kart toplama YALNIZCA bu kök içinde yapılır. Aksi halde sayfanın
  // tepesindeki profil avatarı gibi picker DIŞI görseller cards[0] olup
  // yanlışlıkla tıklanıyordu (hesap paneli açılıyordu).
  function isBig(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width > 340 && r.height > 220 && window.getComputedStyle(el).display !== 'none';
  }
  // FLOW v2 (Angular Material): picker artık role="dialog" DEĞİL —
  // .cdk-overlay-pane içinde <flow-add-menu-popover-content> olarak açılıyor.
  // Kapsam bulunamayınca eski kod arama kutusunu sayfanın ÜSTÜNDEKİ genel
  // arama çubuğunda buluyor ve dosya adını ORAYA yazıyordu (kullanıcı raporu).
  function v2PickerPane() {
    const panes = [...document.querySelectorAll('.cdk-overlay-pane')].filter(x => {
      const r = x.getBoundingClientRect();
      return r.width > 40 && r.height > 40;
    });
    let p = panes.filter(x => x.querySelector('flow-add-menu-popover-content'));   // 1) bilinen bileşen
    // v126.2 YEDEK: Flow bileşen adını değiştirmiş olabilir → picker'ın PARÇALARINI taşıyan pane
    if (!p.length) p = panes.filter(x => x.querySelector(
      'flow-add-menu-asset-list, flow-add-menu-detail-pane, flow-add-menu-side-nav, ' +
      '[class*="add-menu"], [class*="asset-item"], [class*="asset-list"]'));
    // 3) Son çare: içinde hem varlık LİSTESİ hem input olan overlay
    if (!p.length) p = panes.filter(x =>
      x.querySelector('[role="listbox"], cdk-virtual-scroll-viewport') &&
      (x.querySelector('input') || x.querySelector('[role="option"]')));
    return p.length ? p[p.length - 1] : null;
  }
  function findPickerRoot() {
    const v2 = v2PickerPane();
    if (v2) return v2;
    // v126.2 KESİN KAPI: Flow v2 sayfasındaysak picker YALNIZCA bir overlay pane'dir.
    // Aşağıdaki sezgisel yedekler ESKİ arayüz (v1) içindir ve v2'de felakete yol açıyordu:
    // "arama kutusundan yukarı yürü" yolu sayfanın KENDİ medya kütüphanesini picker sanıyor,
    // sonra dosya adı SAYFANIN ÜST arama çubuğuna yazılıyor (kullanıcı raporu 2026-09-05),
    // kartlar galeri tile'ı oluyor, tıklar varlığı büyütüp menü tetikleyebiliyor.
    // Picker açık değilse AÇIK DEĞİL deriz; çağıran zaten yeniden açmayı dener.
    if (document.querySelector('flow-prompt-box, flow-base-prompt-box, flow-project-page')) return null;
    // 1) role=dialog / aria-modal (yeni arayüzde de picker bir dialog olabilir)
    const dlgs = [...document.querySelectorAll('[role="dialog"], [aria-modal="true"]')]
      .filter(isBig);
    for (const d of dlgs) {
      if (/steme ekle|add to prompt|medya yükle|upload media|yüklemeler|tüm medya|all media|öğeleri ara|search items|добавить|загрузить|поиск|añadir|subir|buscar|adicionar|ajouter|importer|hinzufügen|追加|アップロード|추가|업로드|添加|上传|上傳/i.test(d.textContent || ''))
        return d;
    }
    if (dlgs.length) return dlgs[dlgs.length - 1];
    // 2) Arama kutusundan yukarı yürü → görsel kartı içeren İLK büyük kap.
    //    (Eski "Medya yükle" metni yeni arayüzde yok; metin şartı kaldırıldı.)
    const s = findPickerSearch();
    if (s) {
      let el = s.parentElement;
      for (let i = 0; i < 14 && el && el !== document.body; i++) {
        if (isBig(el)) {
          const imgs = [...el.querySelectorAll('img')].filter(im => /^https?:/.test(im.src || ''));
          if (imgs.length >= 1) return el;
        }
        el = el.parentElement;
      }
    }
    // 3) "İsteme ekle" butonundan yukarı yürü (kart seçildikten sonra görünür)
    const addB = findAddBtn();
    if (addB) {
      let el = addB.parentElement;
      for (let i = 0; i < 12 && el && el !== document.body; i++) {
        if (isBig(el)) return el;
        el = el.parentElement;
      }
    }
    return null;
  }

  // ── Picker KÖKÜ içindeki görsel kartlarını topla (en yeni en üstte) ────
  // Her https <img> için en yakın tıklanabilir atayı kart kabul eder.
  // Sol sekme ikonları SVG (https img değil) → elenir.
  // Sıralama: top→bottom, left→right. cards[0] = en üstteki liste öğesi.
  function collectUploadCards(root) {
    const scope = root || document;
    // FLOW v2 (Angular Material): picker kartı artık <button class="asset-item" role="option">.
    // İçinde https <img> olmayabilir (cdk sanal liste) → eski "img'den yukarı yürü" yolu
    // hiç kart bulamıyordu. Dosya adı butonun METNİNDE yazar; rowMatchesName textContent'e
    // baktığından ad eşleşmesi aynen çalışır.
    const visc = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const v2cards = [...scope.querySelectorAll('button.asset-item')].filter(visc);
    if (v2cards.length) return v2cards;   // DOM sırası = listedeki sıra
    // v126.1 YEDEK: sınıf adı değişmiş olabilir. Liste kutusunun (role=listbox) seçenekleri
    // ya da picker içindeki gerçek BUTONLAR alınır. Eskiden buradan img'den yukarı yürüyen
    // yol devreye giriyordu ve çoğu zaman TIKLANAMAYAN bir <div> döndürüyordu → tık hiçbir
    // şey seçmiyor, detay paneli picker açılışında kendiliğinden seçilen İLK kartta kalıyor
    // ve onaya basılınca YANLIŞ referans ekleniyordu (kullanıcı: @man yerine @dog).
    const opts = [...scope.querySelectorAll('[role="option"], cdk-virtual-scroll-viewport button, mat-list-item')]
      .filter(visc)
      .filter(el => !el.closest('flow-add-menu-side-nav'))   // sol sekmeler (Tümü/Resimler/...) değil
      .filter(el => { const r = el.getBoundingClientRect(); return r.height >= 28 && r.height <= 220; });
    if (opts.length) return opts;
    const seen = new Set();
    const out  = [];
    for (const im of [...scope.querySelectorAll('img')]) {
      if (!/^https?:/.test(im.src || '')) continue;
      let el = im, card = null;
      for (let i = 0; i < 6 && el && el !== scope; i++) {
        if (el.matches && el.matches('button, [role="button"], li, a, [tabindex]')) { card = el; break; }
        el = el.parentElement;
      }
      if (!card) card = im.closest('div') || im;
      if (seen.has(card)) continue;
      const r = card.getBoundingClientRect();
      if (r.width < 28 || r.height < 24 || r.width > 700 || r.height > 520) continue;
      if (window.getComputedStyle(card).display === 'none') continue;
      seen.add(card);
      out.push(card);
    }
    out.sort((a, b) => a.getBoundingClientRect().top  - b.getBoundingClientRect().top ||
                       a.getBoundingClientRect().left - b.getBoundingClientRect().left);
    return out;
  }

  // ── Gerçek bir kullanıcı tıklamasını taklit et (React seçim state'ini tetikler) ──
  // KOORDİNATLI: clientX/clientY + elementFromPoint ile o noktadaki GERÇEK (taze, üstteki)
  // elemana gönderir. Koordinatsız sentetik tık, Flow picker'ının post-upload seçim
  // bileşeninde tutmuyordu (log: kart bulunuyor ama seçilmiyor). İndirme menüsü zaten
  // bu koordinatlı yöntemle çalışıyor.
  function robustClick(el) {
    try { el.scrollIntoView({ block: 'center' }); } catch (_) {}
    let r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) { try { el.click(); } catch (_) {} return; }
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const o = { bubbles: true, cancelable: true, composed: true, view: window, clientX: cx, clientY: cy, button: 0 };
    // O noktadaki ÜSTTEKİ eleman (taze; overlay/stale guard). Hem onu hem el'i hedefle.
    // FLOW v2 TUZAĞI: kapanmakta olan bir cdk overlay'in BACKDROP'u tüm sayfayı kaplar →
    // elementFromPoint onu döndürür, tık backdrop'a gider ve hedefe HİÇ ulaşmaz (canlıda
    // kare yuvası bu yüzden picker'ı açmıyordu). Backdrop ise doğrudan el'i hedefle.
    let hit = document.elementFromPoint(cx, cy) || el;
    if (hit !== el && hit.classList && hit.classList.contains('cdk-overlay-backdrop')) hit = el;
    for (const target of (hit === el ? [el] : [hit, el])) {
      try {
        target.dispatchEvent(new PointerEvent('pointerover',  o));
        target.dispatchEvent(new PointerEvent('pointerenter', o));
        target.dispatchEvent(new MouseEvent('mouseover',      o));
        target.dispatchEvent(new PointerEvent('pointerdown',  o));
        target.dispatchEvent(new MouseEvent('mousedown',      o));
        target.dispatchEvent(new PointerEvent('pointerup',    o));
        target.dispatchEvent(new MouseEvent('mouseup',        o));
        target.dispatchEvent(new MouseEvent('click',          o));
      } catch (_) {}
    }
    try { (hit || el).click(); } catch (_) {}
  }

  // ── TEK AKTİVASYONLU tıklamalar (v126) ────────────────────────────────
  // KÖK NEDEN: robustClick sentetik olay dizisini gönderdikten SONRA bir de native
  // el.click() çağırıyor → hedef İKİ kez aktive oluyor. Kare yuvasında zararsızdı (ilk
  // tık picker'ı açar/kapatır, ikincisi boşluğa gider) ama picker kartı bir SEÇİM
  // TOGGLE'ıdır: 1. tık seçer (detay paneli + "İsteme ekle" çizilir), 2. tık seçimi
  // KALDIRIR → onay butonu HİÇ görünmez, referans eklenmez.
  function plainClick(el) {            // gerçek kullanıcı tıkına en yakın olan (Angular bunu dinler)
    try { el.scrollIntoView({ block: 'center' }); } catch (_) {}
    try { el.click(); } catch (_) {}
  }
  function synthClick(el) {            // yedek: koordinatlı AMA TEK sentetik dizi (native click YOK)
    try { el.scrollIntoView({ block: 'center' }); } catch (_) {}
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) { try { el.click(); } catch (_) {} return; }
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const o = { bubbles: true, cancelable: true, composed: true, view: window, clientX: cx, clientY: cy, button: 0 };
    let hit = document.elementFromPoint(cx, cy) || el;
    if (hit !== el && !(el.contains && el.contains(hit))) hit = el;   // backdrop/overlay → doğrudan hedefe
    try {
      hit.dispatchEvent(new PointerEvent('pointerover',  o));
      hit.dispatchEvent(new MouseEvent('mouseover',      o));
      hit.dispatchEvent(new PointerEvent('pointerdown',  o));
      hit.dispatchEvent(new MouseEvent('mousedown',      o));
      hit.dispatchEvent(new PointerEvent('pointerup',    o));
      hit.dispatchEvent(new MouseEvent('mouseup',        o));
      hit.dispatchEvent(new MouseEvent('click',          o));
    } catch (_) {}
  }
  // Yanlış bir tık TEKİL görünüme (/project/<id>/edit/<assetId>) düşürebiliyor: ekranda tek
  // büyük öğe kalır, üretim ızgaraya DÜŞMEZ (varlığın sürümü olur) ve indirme sırası bozulur.
  // Seçim artık bunu KENDİ içinde tespit edip geri döner (indirme döngüsünün ızgara
  // düzeltmesi seçim sırasında devre dışıdır — bkz. __afSelBusy).
  const inEditView = () => /\/(edit|asset|scene)\//.test(location.pathname);
  async function backToGrid() {
    if (!inEditView()) return false;
    console.warn('[AutoFlow] Select: TEKİL görünüme düşüldü →', location.pathname, '→ ızgaraya dönülüyor');
    const back = [...document.querySelectorAll('button, [role="button"]')].find(b => {
      const r = b.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return false;
      if (r.top > 220 || r.left > window.innerWidth * 0.3) return false;
      const leafs = [...b.querySelectorAll('mat-icon, i')].map(ic => (ic.textContent || '').trim());
      return leafs.includes('arrow_back') || (b.textContent || '').trim() === 'arrow_back';
    });
    if (back) { try { back.click(); } catch (_) {} }
    for (let i = 0; i < 10 && inEditView(); i++) await wait(400);
    if (inEditView()) { try { history.back(); } catch (_) {} for (let i = 0; i < 10 && inEditView(); i++) await wait(400); }
    console.log('[AutoFlow] Select: ızgara dönüşü', inEditView() ? 'BAŞARISIZ' : 'tamam', location.pathname);
    return true;
  }

  // ── Kartın metni referansın dosya adıyla eşleşiyor mu? ─────────────────
  // TAM ad/stem — KESİNLİKLE kısaltma yok (kısaltma üretilen görsellerle
  // çakışır). Örn. "referans (1).jpg" → stem "referans (1)".
  function rowMatchesName(card, name) {
    if (!name) return false;
    const n   = name.toLowerCase();
    const im  = card.querySelector('img');
    const txt = [
      card.textContent || '',
      card.getAttribute('aria-label') || '',
      card.getAttribute('title') || '',
      im?.getAttribute('alt') || '',
      im?.getAttribute('title') || ''
    ].join(' ').toLowerCase();
    if (txt.includes(n)) return true;                 // tam ad + uzantı
    const stem = n.replace(/\.[a-z0-9]+$/, '');
    if (stem.length >= 4 && txt.includes(stem)) return true; // tam stem, kısaltmasız
    // v126.1: FLOW v2 picker'ı uzun adları KISALTARAK yazıyor ("Brown_mutt_sitting_on_s…").
    // Kısaltma CSS değil DOM ise tam stem asla eşleşmez → kartı bulamayız. Ad ile kart
    // metnini yalın hale getirip (harf+rakam) adın ÖN EKİ olarak eşleştiririz. Eşik yüksek
    // (>=12 karakter ve stem'in >=%55'i) → farklı referansların birbirine karışması engellenir.
    const norm = x => x.toLowerCase().replace(/[^a-z0-9]+/g, '');
    const nn = norm(stem), tt = norm(txt);
    if (nn.length >= 12 && tt) {
      const minLen = Math.max(12, Math.ceil(nn.length * 0.55));
      for (let L = nn.length; L >= minLen; L--) if (tt.includes(nn.slice(0, L))) return true;
    }
    return false;
  }

  // ── Prompt'a ZATEN ekli referans chip'lerini say ──────────────────────
  // Flow, referansı promptlar arası ekli TUTABİLİR (özellikle RU'da gözlendi). O zaman
  // referans picker'ın "ekle" listesinde GÖRÜNMEZ → kod onu sonsuza dek arar, takılır.
  // Ekli referans = prompt kutusunun HEMEN ÜSTÜNDE, KÜÇÜK, içinde <img> olan ve kaldır
  // ikonu (cancel/close/remove — Material ligature, DİLDEN BAĞIMSIZ) taşıyan buton/chip.
  // Galeri kartları (büyük) ve "istemi temizle" butonu (img'siz) elenir.
  function attachedRefChips() {
    // FLOW v2 (Angular Material): prompt kutusunun malzeme şeridi <flow-ingredient-bar>;
    // ekli her referans orada <button class="chip-container"> (56x56, img.chip-image +
    // mat-icon.hover-icon 'cancel'). KESİN seçici → aşağıdaki geometri sezgisine gerek yok.
    // v126: bu sayaç artık SEÇİMİN BAŞARI ÖLÇÜSÜ ("picker kapandı" sinyali yanıltıcıydı).
    const v2bar = document.querySelector('flow-ingredient-bar');
    if (v2bar) {
      const visb = b => { const r = b.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      const strict = [...v2bar.querySelectorAll('button.chip-container')].filter(visb);
      if (strict.length) return strict;
      // Sınıf adı değişirse: şeritteki, İÇİNDE GÖRSEL olan butonlar (boş yuvada img yoktur)
      return [...v2bar.querySelectorAll('button, [role="button"]')].filter(b => visb(b) && b.querySelector('img'));
    }
    const boxes = [...document.querySelectorAll('[contenteditable="true"], textarea, [role="textbox"]')]
      .filter(el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
    boxes.sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top);
    if (!boxes[0]) return [];
    const boxTop = boxes[0].getBoundingClientRect().top;
    return [...document.querySelectorAll('button, [role="button"]')].filter(b => {
      const r = b.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return false;
      if (r.width > 140 || r.height > 140) return false;            // galeri kartı DEĞİL (küçük chip)
      if (r.top < boxTop - 220 || r.bottom > boxTop + 30) return false; // kutunun hemen ÜSTÜ
      if (!b.querySelector('img')) return false;                    // referans küçük resmi taşır
      const t = (b.textContent || '').toLowerCase();
      return t.includes('cancel') || t.includes('close') || t.includes('remove') || t.includes('delete');
    });
  }
  function attachedRefCount() { return attachedRefChips().length; }

  // ── MAP modu: ÖNCEKİ prompttan kalan ekli chip'leri KALDIR ────────────
  // Flow, referansı promptlar arası ekli TUTABİLİR. Map modunda her prompt'un
  // FARKLI görseli var → eski chip kalırsa referanslar birikir (2. video 1.'nin
  // görselini de alır) ve birkaç prompt sonra Flow'un limitine çarpar. Bu yüzden
  // seçimden ÖNCE tüm ekli chip'ler kaldırılır. Chip'in KENDİSİNE tıklamak
  // önizleme açabilir → yalnızca içindeki kaldır İKONUNA (cancel/close ligature,
  // dilden bağımsız) tıklanır; ikon bulunamazsa DOKUNULMAZ (güvenli taraf,
  // davranış eskisi gibi kalır). Shared modda ÇAĞRILMAZ (orada ekli chip istenir).
  async function removeAttachedChips() {
    let removed = 0;
    for (let round = 0; round < 14; round++) {
      const chips = attachedRefChips();
      if (!chips.length) break;
      const chip = chips[0];
      const icon = [...chip.querySelectorAll('*')].find(el => {
        if (el.querySelector('*')) return false;                    // yaprak eleman (ligature metni)
        const tx = (el.textContent || '').trim().toLowerCase();
        return tx === 'cancel' || tx === 'close' || tx === 'remove' || tx === 'delete';
      });
      if (!icon) { console.warn('[AutoFlow] Select: chip kaldır ikonu bulunamadı → temizlik atlandı'); break; }
      plainClick(icon);   // v126: koordinatlı tık chip'in GÖRSELİNE gidip varlığı tekil görünümde açabiliyor
      removed++;
      let dropped = false;                                          // v126: kaldırma animasyonuna ~1,8 sn tanı
      for (let w = 0; w < 6; w++) { await wait(300); if (attachedRefChips().length < chips.length) { dropped = true; break; } }
      if (!dropped) {                                               // tık tutmadı → tekrar zorlamayı bırak
        console.warn('[AutoFlow] Select: chip kaldırma tutmadı → temizlik durduruldu');
        break;
      }
    }
    if (removed) console.log('[AutoFlow] Select: eski referans chip temizliği →', removed, 'kaldırıldı');
    if (inEditView()) await backToGrid();   // temizlik tıkı tekil görünüme düşürdüyse geri dön
    return removed;
  }

  // ── Bu prompt için seçilecek dosya adları ──────────────────────────────
  //    'map' modunda prompt başına eşlenen adlar; aksi halde (shared/eski yol)
  //    tüm referanslar. __afPromptRefs sidepanel'den gelir.
  const pr = window.__afPromptRefs;
  // GERÇEK mod: transferRefs ile aktarılan refMode. Eski yol (pr.length>0) YANLIŞTI:
  // sidepanel shared modda da promptRefNames'i doldurduğundan her koşu 'map' sanılıyor,
  // 'zaten ekli' kısayolu hiç çalışmıyordu (ekli referans picker'da görünmez → her
  // prompt'ta 2 geçiş × 3 deneme boşa arıyordu). __afRefMode yoksa eski sezgiye düşer.
  const isMapMode = window.__afRefMode
    ? (window.__afRefMode === 'map')
    : (Array.isArray(pr) && pr.length > 0);
  let names = (Array.isArray(pr) && pr.length) ? (pr[idx] || []) : refImgs.map(r => r.name);
  names = [...new Set(names.filter(Boolean))]; // tekilleştir (aynı referansı 2 kez ekleme)
  // MAP modu: önceki promptun ekli chip'lerini KALDIR (birikme + limit + yanlış görsel
  // önlenir). Bu prompt'un referansı OLMASA BİLE temizlik yapılır (yoksa eski görsel
  // bu prompt'a da uygulanır). Shared modda chip'ler bilerek korunur.
  if (isMapMode) await removeAttachedChips();
  if (!names.length) {
    console.log('[AutoFlow] Select: bu prompt için referans yok (idx', idx, ')');
    window.__afSelBusy = 0;
    return { success: true, selected: 0 };
  }
  console.log('[AutoFlow] Select: idx', idx, '→ adlar:', names.join(', '));
  // v139: Flow KOMPAKT (mobil) düzendeyse referans picker'ı tamamen farklıdır
  // (flow-mobile-add-menu: asset-item kartı ve ingredient bar YOK) → seçim yapılamaz.
  // Boşuna 6 deneme yapmak yerine hemen çıkıp SEBEBİ bildiririz.
  // KESİN sinyal: mobil picker bileşeni DOM'da. İkinci sinyal: masaüstü düzeninin
  // olmazsa olmazı olan ingredient bar YOK ve pencere dar. Yalnız genişliğe bakmak,
  // 950px'te masaüstü düzeni gören kullanıcıyı haksız yere engellerdi.
  const mobileNow = !!document.querySelector('flow-mobile-add-menu, .mobile-add-menu-container, .mobile-overlay');
  const noBar = !document.querySelector('flow-ingredient-bar') && !!document.querySelector('flow-prompt-box');
  if (mobileNow || (noBar && window.innerWidth < 1000)) {
    console.warn('[AutoFlow] Select: Flow KOMPAKT (mobil) düzende → referans eklenemez | genişlik:', window.innerWidth);
    window.__afSelBusy = 0;
    return { success: false, mobileLayout: true, wanted: names.length, selected: 0, chips: 0,
             cardsFound: 0, matched: 0, cardDump: '' };
  }

  // Picker'ı bir kez aç (gerekirse birkaç deneme)
  async function openPicker() {
    let root = null;
    for (let attempt = 0; attempt < 3 && !root; attempt++) {
      // GÜVENLİK: önceki indirme etkileşiminden kalmış açık bir ⋮ bağlam menüsü varsa
      // (ör. SW yeniden başladıysa) ÖNCE kapat — picker onun üstüne açılıp çakışmasın.
      const ctxMenuOpen = [...document.querySelectorAll('[role="menu"]')].some(m => {
        const r = m.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && /indir|download/i.test(m.textContent || '');
      });
      if (ctxMenuOpen) { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await wait(250); }
      const pbOpen = findPlusBtn();
      if (!pbOpen) { console.log('[AutoFlow] Select: + btn yok'); return null; }
      pbOpen.click();
      for (let i = 0; i < 14; i++) { await wait(400); root = findPickerRoot(); if (root) break; }
      if (!root) {
        // v126.2 KENDİ KENDİNİ TEŞHİS: picker açılmadıysa sayfadaki overlay'leri logla →
        // Flow bileşen adlarını değiştirdiğinde kanıt TEK koşuda toplansın (ayrı döküm gerekmesin).
        try {
          const dump = [...document.querySelectorAll('.cdk-overlay-pane')].map(x => {
            const r = x.getBoundingClientRect();
            const kid = x.firstElementChild ? x.firstElementChild.tagName.toLowerCase() : '-';
            return kid + '(' + Math.round(r.width) + 'x' + Math.round(r.height) + ')';
          });
          console.warn('[AutoFlow] Select: picker AÇILMADI (deneme', attempt + 1, ') | + btn:',
            (pbOpen.className || '') + ' | ' + (pbOpen.getAttribute('aria-label') || ''),
            '| overlay pane:', dump.join(' , ') || '(yok)',
            '| asset-item:', document.querySelectorAll('button.asset-item').length,
            '| path:', location.pathname);
        } catch (_) {}
        await wait(400);
      }
    }
    return root;
  }

  // GERÇEK FLOW DAVRANIŞI: picker'da bir kart TEK tıklamada SEÇİLMİYOR; İKİ tıklama
  // gerekiyor (ikinci tıkta seçilir VE picker kendiliğinden KAPANIR). Yani çoklu
  // seçim YOK → her referans AYRI oturum: aç → çift tıkla → kapanır → tekrar aç.
  // "İsteme ekle" butonu kullanılmıyor (çift tık zaten ekleyip kapatıyor).
  function robustDoubleClick(el) {
    robustClick(el);
    return wait(200).then(() => { // wait = __afWait → arka plan sekmede kısılmaz
      robustClick(el); // ikinci tık → asıl seçim
      try { el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true })); } catch (_) {}
    });
  }

  // React-kontrollü input'a değer yaz (native setter + input/change event)
  function setNativeValue(input, value) {
    try {
      const d = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
      if (d && d.set) d.set.call(input, value); else input.value = value;
      input.dispatchEvent(new Event('input',  { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    } catch (_) {}
  }

  // İlk açış (teşhis dökümü için). BAŞARISIZ OLSA BİLE ÇIKMA — özellikle ilk promptta
  // upload'tan hemen sonra picker geç oturabiliyor; aşağıdaki per-name döngüsü zaten
  // kendi içinde tekrar tekrar açmayı deniyor. Eskiden burada return ediliyordu →
  // ilk prompt hiç referans seçemeden çıkıyordu (regresyon). Artık sadece uyarı.
  let root = await openPicker();
  if (!root) {
    console.warn('[AutoFlow] Select: ilk açış başarısız → per-name döngüsünde tekrar denenecek');
  }

  // TEŞHİS: picker açılır açılmaz görünen kartların KISA etiketini topla.
  //   Bu, "isimler neden eşleşmiyor / kaç kart var" sorusunu net cevaplar.
  //   Kartın metni + img alt/title'dan ilk 30 karakter; en fazla 12 kart.
  const cardLabel = c => {
    const im = c.querySelector('img');
    return (((c.getAttribute('aria-label') || c.getAttribute('title') ||
      im?.getAttribute('alt') || im?.getAttribute('title') ||
      (c.textContent || '').trim()) || '(boş)').replace(/\s+/g, ' ').slice(0, 30));
  };
  let cardDump = '';
  let cardsFoundFirst = 0;
  try {
    const firstCards = collectUploadCards(findPickerRoot() || root);
    cardsFoundFirst = firstCards.length;
    cardDump = firstCards.slice(0, 12).map(cardLabel).join(' ¦ ');
    // TÜM REFERANS KİMLİKLERİNİ YAKALA (yalnız bu promptunkini DEĞİL). Picker'da TÜM yüklenen
    // referans kartları görünür; her birinin Flow medya kimliğini (?name=) al → indirme feed'de
    // KİMLİKLE hariç tutar. KRİTİK (log kanıtı): map modda prompt 0 yalnız 1 referansa eşli →
    // eski seçim-yakalama 1/4 yakalıyordu, kalan 3 referans seçilmeden feed'de görünüp
    // İNDİRİLMEYE çalışılıyordu. Tümünü baştan yakalayınca hiçbiri denenmez. Kimlik picker↔feed
    // AYNI (log: yakalanan 3d931df0 feed'de 'r' işaretlendi) → kesin çalışır.
    if (root && refImgs.length) {
      window.__afRefIds = window.__afRefIds || {};
      let cap = 0;
      for (const card of firstCards) {
        if (!refImgs.some(r => rowMatchesName(card, r.name))) continue;
        const im = card.querySelector('img');
        const src = im ? (im.src || im.currentSrc || '') : '';
        const id = (src.match(/(?:[?&]name=|flow-content\.google\/[a-z]+\/)([^&?/]+)/i) || [])[1];
        if (id && !window.__afRefIds[id]) { window.__afRefIds[id] = 1; cap++; }
      }
      if (cap) console.log('[AutoFlow] Select: TÜM referans kimlikleri yakalandı +' + cap,
                           '→ toplam', Object.keys(window.__afRefIds).length);
    }
  } catch (_) {}

  let selectedTotal = 0;
  let matchedTotal  = 0;
  const usedNames = new Set(); // adla tekilleştir (picker her seferinde yeniden açılıyor)
  // Uzun ad ÖNCE: "image (1).png" gibi adlar "image.png" kartına yanlış eşleşmesin
  // diye en uzun (en spesifik) adı önce eşleştirir.
  const ordered = [...names].sort((a, b) => b.length - a.length);

  // FLOW REFERANS LİMİTİ: Flow prompt başına en fazla N referans görsele izin veriyor
  // (video üretiminde 3). Limit dolunca "Maksimum ... ulaşıldı / Maximum ... reached"
  // uyarısı çıkıyor ve fazladan eklenen referans SİLİK kalıyor. Bunu görünce kalan
  // referansları eklemeyi BIRAKIRIZ → boşuna 6 deneme + silik chip oluşmaz. Sayıyı
  // sabit yazmayız; uyarıyı okuyarak çalışır (Flow limiti değişse de uyum sağlar).
  let limitHit = false;
  function maxRefsReached() {
    return [...document.querySelectorAll('div, span, p, li')].some(el => {
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return false;
      const t = (el.textContent || '').toLowerCase();
      if (t.length > 200) return false; // kısa uyarı kutusu; uzun sayfa metnini ele
      // ÇOK DİLLİ: "maksimum ... ulaşıldı" uyarısı her dilde farklı; eski liste TR/EN'di →
      // diğer dillerde limit algılanmayıp kalan referanslar için boşa 6'şar deneme yapılıyordu.
      const hasMax  = t.includes('maksimum') || t.includes('maximum') || t.includes('maximal') ||
                      t.includes('máximo') || t.includes('massimo') || t.includes('максим') ||
                      t.includes('最大') || t.includes('최대') || t.includes('अधिकतम');
      const hasFull = t.includes('ulaşıl') || t.includes('ulasil') || t.includes('reached') ||
                      t.includes('izin veril') || t.includes('allowed') || t.includes('atteint') ||
                      t.includes('erreicht') || t.includes('alcanzado') || t.includes('atingido') ||
                      t.includes('raggiunto') || t.includes('достигнут') || t.includes('達し') ||
                      t.includes('도달');
      return hasMax && hasFull;
    });
  }

  // TEK referansı seç: picker'ı aç → kartı TEK kez aktive et → "İsteme ekle"ye bas.
  // BAŞARI SİNYALİ (v126): prompt kutusundaki referans chip SAYISI arttı mı. Eski sinyal
  // ("picker kapandı") yanıltıcıydı: yanlış bir tık tekil görünüme geçirince picker de
  // yok oluyor ve seçilmemiş referans "seçildi" sayılıyordu.
  async function trySelectOne(wantName, maxAttempts) {
    let done = false, everMatched = false;
    // ZATEN EKLİ KONTROLÜ: Flow referansı önceki prompttan tutmuş olabilir → beklenen kadar
    // (names.length) referans chip'i prompt'a ekliyse, bu referans da ekli demektir; picker'da
    // arama yapma (orada görünmez, takılır), başarı dön. Picker'ı boşuna açma → temiz kal.
    // GÜVENLİK: yalnızca PAYLAŞILAN referans modunda (her prompt aynı ref). MAP modunda (prompt
    // başına FARKLI ref) önceki promptun chip'leri seçim başında zaten KALDIRILIYOR; kalan
    // chip'ler bu promptun kendi seçimleridir ama ad bazında ayırt edilemediği için kısayol
    // map modunda yine de uygulanmaz. isMapMode dış kapsamda __afRefMode'dan belirlenir.
    if (!isMapMode && attachedRefCount() >= names.length) {
      console.log('[AutoFlow] Select: referans zaten ekli (chip mevcut) → atla, başarı:', wantName);
      if (findPickerRoot()) { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await wait(300); }
      return { done: true, everMatched: true };
    }
    for (let attempt = 0; attempt < maxAttempts && !done; attempt++) {
      let r = findPickerRoot();
      if (!r) r = await openPicker();
      if (!r) { console.warn('[AutoFlow] Select: picker açılamadı:', wantName); break; }
      await wait(attempt === 0 ? 450 : 300);

      // 1) ÖNCE doğrudan bul (HIZLI — arama yok). Referanslar çoğunlukla görünür,
      //    bu yüzden burada hemen bulunur ve aramaya hiç gerek kalmaz.
      let all  = collectUploadCards(findPickerRoot() || r);
      let card = all.find(c => rowMatchesName(c, wantName)) || null;

      // 2) YALNIZCA bulunamadıysa (çok referansta fold ALTINDA kalmış olabilir) →
      //    picker arama kutusuna adını yazıp filtrele. Arama artık SADECE GEREKİRSE
      //    çalışır → her referansta yavaşlatmaz.
      if (!card) {
        // RU/katlanmış arama: görünür input yoksa "search" ikonunu açıp input'u getir (dilden bağımsız).
        const search = await ensureSearchInput();
        if (search) {
          console.log('[AutoFlow] Select: doğrudan bulunamadı → arama ile filtrele:', wantName);
          setNativeValue(search, wantName.toLowerCase().replace(/\.[a-z0-9]+$/i, ''));
          await wait(650);
          all  = collectUploadCards(findPickerRoot() || r);
          card = all.find(c => rowMatchesName(c, wantName)) || null;
        }
      }

      if (!card) {
        console.warn('[AutoFlow] Select: kart bulunamadı:', wantName, '(deneme', attempt + 1, ')');
        // Picker'ı KAPAT → sonraki deneme TAZE açsın. Özellikle ilk promptta upload'tan
        // hemen sonra kütüphane henüz yüklenmemiş olabilir; taze açış + bekleme yardımcı olur.
        if (findPickerRoot()) { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); }
        await wait(800);
        continue;
      }
      everMatched = true;
      // KÖK NEDEN (log ile doğrulandı: kart bulunuyor ama seçilmiyor): upload'tan
      // hemen sonra picker RE-RENDER olup bulduğumuz kart elemanını STALE yapıyor →
      // tıklama boşa gidiyor. Çözüm: HER tıktan ÖNCE kartı TAZE bul.
      const reFind = () => (collectUploadCards(findPickerRoot() || r)
                              .find(c => rowMatchesName(c, wantName)) || null);
      let c1 = reFind() || card;
      // HAZIRLIK BEKLEMESİ (silik referans düzeltmesi): kartın görseli TAM YÜKLENMEDEN
      // seçilirse Flow referansı SİLİK/eksik ekliyor ("eklenince silik görünüyor, eklenmiyor"
      // raporu). Görsel zaten yüklüyse anında geçer (ek gecikme yok); değilse en çok ~2.5 sn
      // tam yüklenmesini bekler → seçim temiz olur.
      for (let w = 0; w < 10; w++) {
        const im = c1.querySelector('img');
        if (im && im.complete && im.naturalWidth > 0) break;
        if (!im && w >= 2) break;   // FLOW v2: kartta hiç <img> yoksa beklenecek bir şey yok
        await wait(250);
        c1 = reFind() || c1;
      }
      // REFERANS KİMLİĞİNİ YAKALA: seçilen kartın Flow medya URL'inden kararlı kimliği (?name=)
      // al → indirme pipeline'ı (flowCollectTiles) bu görseli ASLA 'complete' sayıp indirmesin.
      // KRİTİK: %33 zoom Flow virtualization'ını kapattığından feed'deki referans tile'ları artık
      // DOM'da KALIYOR; feed thumbnail'ında dosya adı YAZMADIĞINDAN ad-bazlı hariç tutma yetmiyor.
      // Kimlik (?name=) görsel re-render'larında bile SABİT → kesin hariç tutma. img/bg/alt-img tara.
      try {
        const urls = [];
        const im0 = c1.querySelector && c1.querySelector('img');
        if (im0) { urls.push(im0.src || '', im0.currentSrc || ''); }
        if (c1.querySelectorAll) c1.querySelectorAll('img').forEach(x => urls.push(x.src || '', x.currentSrc || ''));
        try { const bg = getComputedStyle(c1).backgroundImage || ''; const u = (bg.match(/url\(["']?([^"')]+)["']?\)/) || [])[1]; if (u) urls.push(u); } catch (_) {}
        window.__afRefIds = window.__afRefIds || {};
        for (const u of urls) {
          const id = (String(u).match(/(?:[?&]name=|flow-content\.google\/[a-z]+\/)([^&?/]+)/i) || [])[1];
          if (id && !window.__afRefIds[id]) { window.__afRefIds[id] = 1; console.log('[AutoFlow] Select: referans kimliği yakalandı', String(id).slice(0, 24)); }
        }
      } catch (_) {}
      // ── KART AKTİVASYONU (v126 — asıl düzeltme) ──────────────────────
      // Eskiden: robustClick(kart) → İKİ aktivasyon (sentetik dizi + native click) →
      // v2'de 1. tık seçer, 2. tık SEÇİMİ KALDIRIR → "İsteme ekle" hiç çizilmez → kod
      // çift-tık yedeğine düşer → çift tık varlığı TEKİL görünümde açar (/edit/<assetId>)
      // ve picker'ı yok eder → "picker kapandı = eklendi" sanılır.
      // Canlı log kanıtı (2026-09-05): "seçilen 3/3" denip prompt'a TEK referans eklendi.
      const v2mode = !!v2PickerPane();
      const chipsBefore = attachedRefCount();
      const cardOf = el => (el && el.matches && el.matches('button.asset-item')) ? el
                         : ((el && el.closest && el.closest('button.asset-item')) || el);
      const cardEl = cardOf(c1);
      console.log('[AutoFlow] Select: kart tıkla →', wantName, '(deneme', attempt + 1, ') | chip:', chipsBefore);
      plainClick(v2mode ? cardEl : (c1.querySelector('img') || c1));   // TEK aktivasyon

      // v2 picker'da kart seçilince sağda DETAY paneli açılır; "İsteme ekle" oradadır ve
      // detay görünümü rotayı /project/<id>/edit/<assetId> yapar — bu NORMALDİR, hata DEĞİL.
      // TUZAK (kullanıcı raporu: "@man yerine @dog eklendi"): picker açılınca listenin İLK
      // kartı kendiliğinden seçili gelebiliyor. Bizim kart seçilmeden onaya basılırsa YANLIŞ
      // referans eklenir → onaya basmadan önce SEÇİLİ kartın bizimki olduğu doğrulanır.
      const isActive = el => !!(el && el.classList) && (el.classList.contains('asset-item-active') ||
                             el.getAttribute('aria-selected') === 'true' || el.classList.contains('selected'));
      const activeCards = () => {
        const p = v2PickerPane(); if (!p) return null;
        const a = [...p.querySelectorAll('button.asset-item')].filter(isActive);
        return a.length ? a : null;                 // null = seçili işareti okunamıyor → kapı UYGULANMAZ
      };
      const mineActive = () => {
        const a = activeCards(); if (!a) return true;
        const cur = cardOf(reFind() || cardEl);
        return a.some(x => x === cur || x.contains(cur) || cur.contains(x));
      };

      // Onay butonu ("İsteme ekle") kart seçildikten ~0,3-1,2 sn sonra çizilir. Sade tık
      // Angular'a ulaşmadıysa ~1,8 sn sonra TEK sentetik dizi ile bir kez daha denenir.
      const btnReady = b => !!b && !b.disabled && b.getAttribute('aria-disabled') !== 'true';
      let addBtn = null, synthTried = false, reclicked = false, addClicked = false;
      for (let k = 0; k < 26; k++) {
        touch();
        if (attachedRefCount() > chipsBefore) break;        // tek tıkla eklenmiş
        const cand = findAddBtn();
        if (btnReady(cand)) {
          if (mineActive()) { addBtn = cand; break; }       // onay hazır VE doğru kart seçili
          if (!reclicked) {                                 // seçili olan BAŞKA kart → hedefe tekrar tık
            reclicked = true;
            console.warn('[AutoFlow] Select: seçili kart BAŞKASI → hedef karta tekrar tıklanıyor:', wantName);
            plainClick(cardOf(reFind() || cardEl));
          }
        } else if (!findPickerRoot()) break;                // picker kapandı → aşağıda chip ile doğrulanır
        else if (v2mode && k === 9 && !synthTried && !cand) {
          synthTried = true;
          console.log('[AutoFlow] Select: sade tık tutmadı → sentetik TEK tık:', wantName);
          synthClick(cardOf(reFind() || cardEl));
        }
        await wait(200);
      }
      if (!addBtn) console.warn('[AutoFlow] Select: onay butonu bulunamadı →', wantName,
        '| picker:', !!findPickerRoot(), '| seçili kart:', (activeCards() || []).length, '| path:', location.pathname);
      if (addBtn) {
        console.log('[AutoFlow] Select: İsteme ekle →', wantName);
        plainClick(addBtn);
        addClicked = true;
        let grew = false;
        for (let k = 0; k < 16; k++) {                     // chip artışını bekle (~3,2 sn)
          touch();
          if (attachedRefCount() > chipsBefore) { grew = true; break; }
          if (k === 7 && findPickerRoot() && btnReady(findAddBtn())) {
            console.log('[AutoFlow] Select: onay tutmadı → tekrar bas:', wantName);
            plainClick(findAddBtn());                      // ilk tık hazır olmadan gitmişse
          }
          await wait(200);
        }
        if (!grew && findPickerRoot()) await wait(400);
      } else if (!v2mode && findPickerRoot()) {
        // ESKİ arayüz (Flow v1): çift-tık yedeği AYNEN korunur. v2'de ASLA çalıştırılmaz.
        const c2 = reFind() || c1;                    // çift-tık yedeği (tazele)
        const t2 = c2.querySelector('img') || c2;
        robustClick(t2);
        try {
          const rr = t2.getBoundingClientRect();
          t2.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, composed: true,
            view: window, clientX: rr.left + rr.width / 2, clientY: rr.top + rr.height / 2, detail: 2 }));
        } catch (_) {}
        await wait(1100);
      }

      // v126.1 — BURADA GERİ BASMAK YOK. Canlı kanıt (kullanıcı ekran görüntüsü + log):
      // v2 picker'ın DETAY görünümü rotayı /project/<id>/edit/<assetId> yapıyor; bu Flow'un
      // NORMAL davranışı. v126'da burada "tekil görünüme düştük" deyip geri basılıyordu →
      // detay paneli ve "İsteme ekle" kapanıyor, chip hiç eklenmiyor, döngü sonsuza dek
      // "bas → büyült → kapat" yapıyordu. Izgaraya dönüş, prompt YAPIŞTIRILMADAN ÖNCE
      // üretim döngüsünde zaten yapılıyor (ensureGridViewOnFlow).

      // LİMİT: Flow "Maksimum ... ulaşıldı" uyarısını gösterdiyse bu referans (ve kalanlar)
      // eklenemez → boşuna tekrar deneme; bayrağı kaldır, picker'ı kapat, dene'den çık.
      if (maxRefsReached()) {
        console.log('[AutoFlow] Select: Flow referans limiti doldu → kalan referanslar atlanıyor');
        limitHit = true;
        if (findPickerRoot()) { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await wait(400); }
        break;
      }

      // BAŞARI ÖLÇÜSÜ (v126): prompt kutusuna GERÇEKTEN chip eklendi mi? Eski ölçü
      // ("picker kapandı") yanıltıcıydı — tekil görünüme geçiş de picker'ı yok ediyor.
      const chipsAfter = attachedRefCount();
      if (chipsAfter > chipsBefore) {
        done = true;
        console.log('[AutoFlow] Select: EKLENDİ →', wantName, '| chip:', chipsBefore, '→', chipsAfter);
      } else if (addClicked && !findPickerRoot()) {
        // Emniyet: GERÇEK onay butonuna basıldı ve picker kapandı. Chip sayacı (Flow şeridi
        // yeniden adlandırılmışsa) okuyamamış olabilir → eklendi say ama LOGLA.
        done = true;
        console.warn('[AutoFlow] Select: onay basıldı, picker kapandı, chip sayılamadı → başarı kabul:', wantName);
      } else if (!v2mode && !findPickerRoot()) {
        done = true;                                  // ESKİ arayüz davranışı (aynen)
        console.log('[AutoFlow] Select: tek tıkla eklendi (picker kapandı) →', wantName);
      } else {
        console.warn('[AutoFlow] Select: EKLENEMEDİ (chip artmadı) →', wantName,
                     '| picker:', !!findPickerRoot(), '| chip:', chipsAfter);
      }
      // Sonraki deneme/ad TAZE picker ile başlasın (stale kart + yarım seçim sıfırlanır)
      if (findPickerRoot()) {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        await wait(done ? 400 : 700);
      }
    }
    // picker açık kaldıysa kapat → sonraki ad temiz başlasın
    if (findPickerRoot()) { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await wait(500); }
    return { done, everMatched };
  }

  // 1. GEÇİŞ — tüm referanslar
  for (const wantName of ordered) {
    if (limitHit) break;                           // Flow limiti doldu → kalanları atla
    if (usedNames.has(wantName)) continue;
    const res = await trySelectOne(wantName, 3);
    if (res.everMatched) matchedTotal++;
    if (res.done) { usedNames.add(wantName); selectedTotal++; }
    else if (!limitHit) console.warn('[AutoFlow] Select: referans seçilemedi (1. geçiş):', wantName);
  }

  // 2. GEÇİŞ — DOĞRULAMA: eksik kalan referansları tekrar dene. Tüm seçim tek bir
  // öncelikli withUi içinde olduğundan indirme araya GİREMEZ; eksik kalması ancak
  // o anki tıkın tutmamasından olur → bu ek tur "9. promptta 3/4" gibi eksikleri kapatır.
  const missing = ordered.filter(n => !usedNames.has(n));
  if (missing.length && !limitHit) {               // limit dolduysa 2. geçişi hiç başlatma
    console.log('[AutoFlow] Select: eksik', missing.length, '→ 2. geçiş:', missing.join(', '));
    await wait(600);
    for (const wantName of missing) {
      if (limitHit) break;                         // Flow limiti doldu → kalanları atla
      const res = await trySelectOne(wantName, 3);
      if (res.done) { usedNames.add(wantName); selectedTotal++; }
      else if (!limitHit) console.warn('[AutoFlow] Select: referans seçilemedi (2. geçiş):', wantName);
    }
  }

  const chipsFinal = attachedRefCount();
  window.__afSelBusy = 0;
  console.log('[AutoFlow] Ref selection done — idx', idx, '| seçilen:', selectedTotal, '/', names.length,
              '| prompt kutusundaki chip:', chipsFinal);
  return { success: true, selected: selectedTotal, wanted: names.length,
           cardsFound: cardsFoundFirst, matched: matchedTotal, cardDump, chips: chipsFinal };
}

// ══════════════════════════════════════════════════════════════════════
// v119 — KARELER (VIDEO_FRAMES) YOLU
// ══════════════════════════════════════════════════════════════════════
// Flow'un video kompozisyonunda İKİ ayrı yol var (canlı DOM dökümüyle doğrulandı):
//   Malzemeler (VIDEO_REFERENCES) → kompozisyonda yuvarlak "+" vardır; görsel prompt'a
//     REFERANS olarak eklenir. Eklentinin v115'ten beri kullandığı yol.
//   Kareler (VIDEO_FRAMES) → "+" YOKTUR. Prompt kutusunun hemen üstünde iki 50x50 yuva
//     vardır: solda başlangıç, sağda bitiş karesi. Picker'ı bu yuvalar açar.
// İki sekme ancak ÜRETİM AYARLARI PANELİ AÇIKKEN DOM'da bulunur (kapalıyken sayfada
// [role="tab"] hiç yoktur) → aşağıdaki fonksiyon paneli açar, sekmeye basar, kapatır.

// ── Video alt sekmesini seç — MAIN world, self-contained ─────────────────────
// suffix: 'VIDEO_FRAMES' | 'VIDEO_REFERENCES'
async function switchVideoSubTab(suffix) {
  const wait = ms => (window.__afWait ? window.__afWait(ms) : new Promise(r => setTimeout(r, ms)));
  const isVis = el => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const st = window.getComputedStyle(el);
    return r.width > 0 && r.height > 0 && st.display !== 'none' && st.visibility !== 'hidden' && parseFloat(st.opacity) > 0;
  };
  // applyGenerationSettings ile AYNI tıklama yöntemi (Radix gerçek olay dizisi bekler)
  function realClick(el) {
    const r = el.getBoundingClientRect();
    const base = { bubbles: true, cancelable: true, view: window, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0 };
    for (const type of ['pointerover', 'pointerenter', 'pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      try { const Ev = type.startsWith('pointer') ? PointerEvent : MouseEvent; el.dispatchEvent(new Ev(type, { ...base, buttons: (type.includes('up') || type === 'click') ? 0 : 1 })); } catch (_) {}
    }
  }
  function fiberClick(el) {
    try {
      const fk = Object.keys(el).find(k => k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance'));
      let f = el[fk];
      while (f) { const p = f.pendingProps || f.memoizedProps || {}; if (typeof p.onClick === 'function') { p.onClick({ type: 'click', isTrusted: true, target: el, currentTarget: el, bubbles: true, preventDefault() {}, stopPropagation() {}, nativeEvent: {} }); return; } f = f.return; }
    } catch (_) {}
  }
  const clickEl = el => { realClick(el); try { el.click(); } catch (_) {} fiberClick(el); };
  const findOpener = () =>
    [...document.querySelectorAll('button[aria-haspopup="menu"]')].filter(isVis)
      .find(b => { const r = b.getBoundingClientRect(); return r.top > innerHeight * 0.55 && r.left > innerWidth * 0.3; }) || null;

  // ── FLOW v2 (Angular Material): Kareler / İçerik öğeleri artık ayar panelindeki
  // mat-button-toggle radio'ları. İkon ligature'ıyla ayırt edilir (dilden bağımsız):
  //   Kareler = crop_free · İçerik öğeleri (eski adı Malzemeler) = chrome_extension
  const V2_SUB = { VIDEO_FRAMES: 'crop_free', VIDEO_REFERENCES: 'chrome_extension' };
  const v2Pane = () => {
    const p = [...document.querySelectorAll('.cdk-overlay-pane')].filter(x => {
      if (!x.querySelector('flow-prompt-box-settings')) return false;
      const r = x.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
    return p.length ? p[p.length - 1] : null;
  };
  const v2Trigger = () => {
    const t = [...document.querySelectorAll('button.settings-trigger-button')].filter(isVis);
    t.sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);
    return t[0] || null;
  };
  if (v2Trigger() || v2Pane()) {
    const icon = V2_SUB[suffix];
    if (!icon) return { success: false, error: 'unknown_suffix', suffix };
    let pane = v2Pane(), openedV2 = false;
    if (!pane) {
      const t = v2Trigger();
      if (!t) { console.log('[AutoFlow][kare] v2 ayar açıcısı yok'); return { success: false, error: 'opener_not_found' }; }
      clickEl(t); openedV2 = true;
      for (let i = 0; i < 12 && !pane; i++) { await wait(250); pane = v2Pane(); }
      if (!pane) { try { t.click(); } catch (_) {} for (let i = 0; i < 12 && !pane; i++) { await wait(250); pane = v2Pane(); } }
    }
    if (!pane) { console.log('[AutoFlow][kare] v2 ayar paneli açılmadı'); return { success: false, error: 'panel_not_open' }; }
    const btn = [...pane.querySelectorAll('button[role="radio"]')].filter(isVis)
      .find(b => [...b.querySelectorAll('mat-icon, i')].some(m => (m.textContent || '').trim() === icon)) || null;
    let alreadyV2 = false;
    if (btn) {
      alreadyV2 = btn.getAttribute('aria-checked') === 'true';
      if (!alreadyV2) { clickEl(btn); await wait(650); }
    }
    if (openedV2) {                                   // paneli biz açtıysak biz kapatalım
      // Escape v2 panelini KAPATMIYOR, backdrop da yok → açıcıya tekrar bas (kanıtlı yol)
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));
      await wait(300);
      for (let i = 0; i < 3 && v2Pane(); i++) {
        const t2 = v2Trigger();
        if (!t2) break;
        try { t2.click(); } catch (_) {}
        await wait(500);
      }
    }
    console.log('[AutoFlow][kare] v2 kullanım:', suffix, btn ? (alreadyV2 ? '(zaten seçili)' : 'seçildi') : 'BULUNAMADI');
    return { success: !!btn, suffix, already: alreadyV2, v2: true };
  }

  const findTab = () => [...document.querySelectorAll(`[role="tab"][id$="-trigger-${suffix}"]`)].filter(isVis)[0] || null;

  // Panel zaten açıksa (ör. applyGenerationSettings'ten hemen sonra) sekme DOM'da olur.
  let tab = findTab(), opened = false;
  if (!tab) {
    const opener = findOpener();
    if (!opener) { console.log('[AutoFlow][kare] ayar paneli açan buton yok'); return { success: false, error: 'opener_not_found' }; }
    if (opener.getAttribute('aria-expanded') !== 'true') { clickEl(opener); opened = true; }
    for (let i = 0; i < 10 && !tab; i++) { await wait(250); tab = findTab(); }
    // clickEl bilerek ÜÇ yoldan tıklar (sentetik olay dizisi + native click + React onClick).
    // Tetikleyici her tıkta AÇ/KAPA yapan bir bileşense bu, paneli açıp hemen kapatabilir.
    // Sekme gelmediyse ve panel kapalıysa TEK sade tıkla kendini düzelt (panel zaten
    // açıldıysa bu blok HİÇ çalışmaz → applyGenerationSettings'teki kanıtlı davranış aynen).
    if (!tab && opener.getAttribute('aria-expanded') !== 'true') {
      try { opener.click(); } catch (_) {}
      opened = true;
      for (let i = 0; i < 8 && !tab; i++) { await wait(250); tab = findTab(); }
    }
  }
  let already = false;
  if (tab) {
    already = tab.getAttribute('aria-selected') === 'true';
    if (!already) { clickEl(tab); await wait(650); }
  }
  if (opened) { // paneli biz açtıysak biz kapatalım (kompozisyonun üstünü kapatmasın)
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));
    await wait(300);
  }
  console.log('[AutoFlow][kare] alt sekme:', suffix, tab ? (already ? '(zaten seçili)' : 'seçildi') : 'BULUNAMADI');
  return { success: !!tab, suffix, already };
}

// ── Bu prompt'un başlangıç/bitiş karelerini yuvalara yerleştir ───────────────
// MAIN world — self-contained. names = __afPromptRefs[idx] → [başlangıç] | [başlangıç, bitiş]
// BAŞARI SİNYALİ picker'ın kapanması DEĞİL, YUVANIN DOLMASIDIR. Flow'un picker davranışı
// (tek tık / çift tık / "İsteme ekle" / açık kalma) sürümden sürüme değişse bile sonuç
// doğru ölçülür; selectRefsForPrompt'ta yaşanan "seçildi ama kapanmadı → başarısız sayıldı"
// tuzağına düşülmez.
async function selectFramesForPrompt(idx, clearOnly) {
  const waitRaw = ms => (window.__afWait ? window.__afWait(ms) : new Promise(r => setTimeout(r, ms)));
  // v126.5: her beklemede "seçim sürüyor" damgası tazelenir → indirme döngüsünün ızgara
  // düzeltmesi (ensureGridViewOnFlow) araya girip picker'ı kapatamaz.
  const wait = ms => { try { window.__afSelBusy = Date.now(); } catch (_) {} return waitRaw(ms); };
  try { window.__afSelBusy = Date.now(); } catch (_) {}
  const pr    = window.__afPromptRefs || [];
  const names = (pr[idx] || []).filter(Boolean);
  if (!clearOnly && !names.length) {
    console.log('[AutoFlow][kare] bu prompt için kare yok (idx', idx, ')');
    window.__afSelBusy = 0;
    return { success: true, wanted: 0, placed: 0, skipped: true };
  }

  const isVis = el => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const s = window.getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden';
  };

  // Koordinatlı gerçek tıklama (selectRefsForPrompt'taki kanıtlı yöntemin aynısı)
  function robustClick(el) {
    try { el.scrollIntoView({ block: 'center' }); } catch (_) {}
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) { try { el.click(); } catch (_) {} return; }
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const o = { bubbles: true, cancelable: true, composed: true, view: window, clientX: cx, clientY: cy, button: 0 };
    // FLOW v2: kapanmakta olan cdk overlay backdrop'u sayfayı kaplayabiliyor → hedefi yut
    let hit = document.elementFromPoint(cx, cy) || el;
    if (hit !== el && hit.classList && hit.classList.contains('cdk-overlay-backdrop')) hit = el;
    for (const target of (hit === el ? [el] : [hit, el])) {
      try {
        target.dispatchEvent(new PointerEvent('pointerover',  o));
        target.dispatchEvent(new PointerEvent('pointerenter', o));
        target.dispatchEvent(new MouseEvent('mouseover',      o));
        target.dispatchEvent(new PointerEvent('pointerdown',  o));
        target.dispatchEvent(new MouseEvent('mousedown',      o));
        target.dispatchEvent(new PointerEvent('pointerup',    o));
        target.dispatchEvent(new MouseEvent('mouseup',        o));
        target.dispatchEvent(new MouseEvent('click',          o));
      } catch (_) {}
    }
    try { (hit || el).click(); } catch (_) {}
  }
  // v126.5: TEK aktivasyonlu tıklar (malzeme yolunda kanıtlandı). robustClick sentetik
  // olay dizisinden SONRA bir de native el.click() atıyor → hedef İKİ kez aktive oluyor.
  // v2 picker kartı SEÇİM TOGGLE'ı olduğundan ikinci tık seçimi KALDIRIYOR ve onay butonu
  // hiç çizilmiyor. robustClick diğer yerlerde (kare yuvası yedeği) AYNEN duruyor.
  function plainClick(el) {
    try { el.scrollIntoView({ block: 'center' }); } catch (_) {}
    try { el.click(); } catch (_) {}
  }
  function synthClick(el) {
    try { el.scrollIntoView({ block: 'center' }); } catch (_) {}
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) { try { el.click(); } catch (_) {} return; }
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const o = { bubbles: true, cancelable: true, composed: true, view: window, clientX: cx, clientY: cy, button: 0 };
    let hit = document.elementFromPoint(cx, cy) || el;
    if (hit !== el && !(el.contains && el.contains(hit))) hit = el;
    try {
      hit.dispatchEvent(new PointerEvent('pointerover', o));
      hit.dispatchEvent(new MouseEvent('mouseover',     o));
      hit.dispatchEvent(new PointerEvent('pointerdown', o));
      hit.dispatchEvent(new MouseEvent('mousedown',     o));
      hit.dispatchEvent(new PointerEvent('pointerup',   o));
      hit.dispatchEvent(new MouseEvent('mouseup',       o));
      hit.dispatchEvent(new MouseEvent('click',         o));
    } catch (_) {}
  }
  const esc = () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

  // ── İKİ KARE YUVASI (soldan sağa: 0 = başlangıç, 1 = bitiş) ────────────────
  // BOŞ yuva  = <div aria-haspopup="dialog"> (BUTTON DEĞİL → buton seçicileri görmez)
  // DOLU yuva = içinde <img> + 'cancel' kaldır ikonu olan ~50x50 öğe
  // İkisinin ARASINDA 32x32 'swap_horiz' butonu durur (canlı DOM dökümüyle doğrulandı).
  //
  // BİRİNCİL YÖNTEM — 'swap_horiz' satırı: yuvaları ETİKETTEN BAĞIMSIZ bulur. Flow dolu
  // yuvayı button yerine div olarak render etse bile (ya da tersi) çalışır; ligature
  // 'swap_horiz' Flow'un TÜM dillerinde aynıdır.
  // YEDEK — geometri: satır bulunamazsa prompt kutusunun hemen üstündeki 50x50 kutular.
  function slotBoxOf(el) {
    const r = el.getBoundingClientRect();
    return (r.width >= 38 && r.width <= 78 && r.height >= 38 && r.height <= 78) ? r : null;
  }
  // v126.5 KENDİ KENDİNİ TEŞHİS: yuva bulunamazsa malzeme şeridinin DOM'unu tek satırda
  // dök → Flow sınıf/etiket değiştirdiğinde kanıt TEK koşuda toplanır (ayrı döküm gerekmez).
  function frameBarDump() {
    try {
      const bar = document.querySelector('flow-ingredient-bar') ||
                  document.querySelector('.ingredient-bar-container');
      if (!bar) return '(flow-ingredient-bar YOK)';
      return [...bar.querySelectorAll('*')].slice(0, 26).map(e => {
        const r = e.getBoundingClientRect();
        const cls = (typeof e.className === 'string' && e.className) ? '.' + e.className.trim().split(/\s+/).join('.') : '';
        return e.tagName.toLowerCase() + cls + '(' + Math.round(r.width) + 'x' + Math.round(r.height) + ')';
      }).join(' , ');
    } catch (e) { return '(döküm hatası: ' + (e && e.message) + ')'; }
  }
  function frameSlots() {
    const out = [];
    // ── 0) FLOW v2 (Angular Material) — ASIL YOL ──────────────────────────
    // Kare yuvaları <flow-ingredient-bar> > div.ingredient-bar-container içindedir:
    // her yuva bir <div class="frame-trigger"> sarmalayıcısı (DOLU: button.chip-container +
    // img.chip-image | BOŞ: button.empty-chip "Başlat"/"Bitir"), ortada
    // <button aria-label="İlk ve son kareyi değiştir"> (<mat-icon>swap_horiz</mat-icon>).
    // ESKİ İKİ YOL v2'DE SIFIR DÖNÜYORDU (canlı log: "FRAME diag slots:0"):
    //   (1) swap_horiz artık <mat-icon>; yaprak araması 'i,span,button,[role=button]'
    //       listesinde mat-icon YOK → swapLeaf bulunamıyor.
    //   (2) Geometri yedeği BOŞ yuva için aria-haspopup="dialog" şartı arıyor; v2'de o
    //       öznitelik yok → boş yuvalar eleniyor, yerleştirme hiç başlamıyordu.
    const v2bar = document.querySelector('flow-ingredient-bar') ||
                  document.querySelector('.ingredient-bar-container');
    if (v2bar) {
      let trigs = [...v2bar.querySelectorAll('.frame-trigger')].filter(isVis);
      if (!trigs.length) {
        // Sınıf adı değişirse: şeritteki 38-78px tıklanabilirler (swap butonu HARİÇ)
        const isSwap = el => {
          const t = (el.textContent || '').trim().toLowerCase();
          const l = (el.getAttribute('aria-label') || '').toLowerCase();
          return t === 'swap_horiz' || t.includes('swap_horiz') ||
                 /değiştir|degistir|swap|switch|intercambi|vertausch|échang|поменять|交換|교체/.test(l);
        };
        let cand = [...v2bar.querySelectorAll('div, button, [role="button"]')]
          .filter(isVis).filter(el => !isSwap(el)).filter(el => !!slotBoxOf(el));
        // iç içe eşleşmelerde EN DIŞTAKİNİ tut (sarmalayıcı + içindeki buton çift saymasın)
        cand = cand.filter(el => !cand.some(o => o !== el && o.contains(el)));
        // 2'den fazla aday varsa yuva OLMA İHTİMALİ yüksek olanları süz (şeritteki başka
        // 56px bir buton soldan sıraya girip yanlış yuvayı hedeflemesin)
        if (cand.length > 2) {
          const strong = cand.filter(el =>
            !!el.querySelector('img') ||
            /frame|chip|slot|empty/i.test(typeof el.className === 'string' ? el.className : '') ||
            /^(başlat|baslat|bitir|start|end|first|last)$/i.test((el.textContent || '').trim()));
          if (strong.length >= 2) cand = strong;
        }
        trigs = cand;
      }
      for (const t of trigs) {
        const r = t.getBoundingClientRect();
        out.push({ el: t, filled: !!t.querySelector('img'), left: r.left });
      }
      if (out.length >= 2) { out.sort((a, b) => a.left - b.left); return out; }
      out.length = 0;   // 2'den az bulunduysa v2 yolu tutmadı → eski yollara düş
    }
    // 1) swap_horiz butonunun bulunduğu satırın 50x50 çocukları
    // v126.5: mat-icon listeye eklendi (v2'de ikon <i> değil <mat-icon>)
    const swapLeaf = [...document.querySelectorAll('i, span, button, [role="button"], mat-icon')].find(el => {
      if (el.querySelector('*')) return false;
      return (el.textContent || '').trim().toLowerCase() === 'swap_horiz';
    });
    if (swapLeaf) {
      const swapBtn = swapLeaf.closest('button, [role="button"]') || swapLeaf;
      const row = swapBtn.parentElement;
      if (row) {
        for (const ch of row.children) {
          if (ch === swapBtn || !isVis(ch)) continue;
          const r = slotBoxOf(ch);
          if (r) out.push({ el: ch, filled: !!ch.querySelector('img'), left: r.left });
        }
      }
    }
    // 2) Yedek: prompt kutusunun HEMEN üstündeki 50x50 kutular (dolu ya da dialog açan)
    if (out.length < 2) {
      const boxes = [...document.querySelectorAll('[contenteditable="true"], textarea, [role="textbox"]')].filter(isVis);
      boxes.sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top);
      if (boxes[0]) {
        const boxTop = boxes[0].getBoundingClientRect().top;
        const seen = new Set(out.map(o => o.el));
        for (const el of document.querySelectorAll('[aria-haspopup="dialog"], button, [role="button"]')) {
          if (seen.has(el) || !isVis(el)) continue;
          const r = slotBoxOf(el);
          if (!r) continue;
          if (r.bottom > boxTop + 12 || r.top < boxTop - 220) continue;   // kutunun HEMEN üstü
          const filled = !!el.querySelector('img');
          // v126.5: v1'de boş yuva aria-haspopup="dialog" taşıyordu; v2'de taşımıyor →
          // sınıf/metin ipuçları da kabul edilir (yoksa boş yuvalar tamamen eleniyordu).
          const looksSlot = !!el.getAttribute('aria-haspopup') ||
            /frame|chip|slot/i.test((el.className && typeof el.className === 'string' ? el.className : '') +
                                    ' ' + ((el.parentElement && typeof el.parentElement.className === 'string') ? el.parentElement.className : '')) ||
            /başlat|baslat|bitir|start|end|first|last/i.test((el.textContent || '').trim());
          if (!filled && !looksSlot) continue;
          seen.add(el);
          out.push({ el, filled, left: r.left });
        }
      }
    }
    out.sort((a, b) => a.left - b.left);
    return out;
  }
  const slotFilled = i => { const s = frameSlots()[i]; return !!(s && s.filled); };

  // ── Dolu yuvayı boşalt: içindeki 'cancel/close' ikon yaprağına bas ─────────
  async function clearSlots() {
    for (let round = 0; round < 8; round++) {
      const filled = frameSlots().filter(s => s.filled);
      if (!filled.length) return true;
      const el = filled[0].el;
      const r = el.getBoundingClientRect();
      // kaldır ikonu yalnız üzerine gelinince görünebiliyor → önce hover
      try {
        el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }));
        el.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }));
      } catch (_) {}
      await wait(220);
      const icon = [...el.querySelectorAll('*')].find(x => {
        if (x.querySelector('*')) return false;                     // yaprak (ligature metni)
        const tx = (x.textContent || '').trim().toLowerCase();
        return tx === 'cancel' || tx === 'close' || tx === 'remove' || tx === 'delete';
      });
      if (!icon) { console.warn('[AutoFlow][kare] kaldır ikonu bulunamadı → temizlik durduruldu'); return false; }
      // v126.5: ÖNCE sade tık — koordinatlı tık ikon gizliyken chip'in GÖRSELİNE gidip
      // picker açabiliyor. Tutmazsa eski koordinatlı yönteme düşülür (davranış korunur).
      const before = frameSlots().filter(s => s.filled).length;
      plainClick(icon);
      await wait(420);
      if (frameSlots().filter(s => s.filled).length >= before) { robustClick(icon); await wait(450); }
    }
    return !frameSlots().some(s => s.filled);
  }

  // ── TEK yuvayı boşalt (v126.6) ────────────────────────────────────────────
  // clearSlots() TÜM yuvaları temizler; doğru doldurulmuş komşu yuvayı bozmadan
  // yalnız bir yuvayı boşaltmak için bu kullanılır.
  async function clearOne(i) {
    for (let round = 0; round < 4; round++) {
      const sl = frameSlots()[i];
      if (!sl || !sl.filled) return true;
      const el = sl.el, r = el.getBoundingClientRect();
      try {   // kaldır ikonu yalnız hover'da görünebiliyor
        el.dispatchEvent(new MouseEvent('mouseover',   { bubbles: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }));
        el.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }));
      } catch (_) {}
      await wait(220);
      const icon = [...el.querySelectorAll('*')].find(x => {
        if (x.querySelector('*')) return false;
        const tx = (x.textContent || '').trim().toLowerCase();
        return tx === 'cancel' || tx === 'close' || tx === 'remove' || tx === 'delete';
      });
      if (!icon) return false;
      plainClick(icon);
      await wait(420);
      const now = frameSlots()[i];
      if (!now || !now.filled) return true;
      robustClick(icon);
      await wait(450);
    }
    const fin = frameSlots()[i];
    return !(fin && fin.filled);
  }

  // ── Picker yardımcıları (selectRefsForPrompt ile AYNI mantık) ──────────────
  const isBig = el => { if (!el) return false; const r = el.getBoundingClientRect();
    return r.width > 340 && r.height > 220 && window.getComputedStyle(el).display !== 'none'; };
  const SEARCH_RE = /ara|search|öğe|поиск|buscar|pesquisar|rechercher|suchen|cerca|zoek|検索|검색|搜索|搜尋|tìm|بحث|खोज/;
  function searchInputsIn(scope) {
    return [...(scope || document).querySelectorAll('input[type="text"], input[type="search"], input:not([type])')].filter(inp => {
      const r = inp.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return false;
      const s = ((inp.getAttribute('placeholder') || '') + ' ' + (inp.getAttribute('aria-label') || '') + ' ' + (inp.getAttribute('data-testid') || '')).toLowerCase();
      return SEARCH_RE.test(s);
    });
  }
  // KRİTİK (v120): KAPSAM verilirse arama kutusu YALNIZ picker'ın içinde aranır.
  // Flow'un sayfa ÜSTÜNDEKİ genel arama kutusu da bu desene uyuyor ve DOM'da daha ÖNCE
  // geldiğinden eski sürüm dosya adını ORAYA yazıyordu → picker hiç filtrelenmiyor, kart
  // bulunamıyordu. Çiftler modunda tek partide 40 görsel yüklendiği için ilk kareler
  // listede görünmüyor ve HER seçimde aramaya düşülüyor → mod tamamen çalışmıyordu
  // (Başlangıç 20, Zincir 21 görselde kartlar görünür kaldığından sorun çıkmıyordu).
  // Kapsam verilmezse (findPickerRoot'un yedek yolu) eski davranış birebir korunur.
  function findPickerSearch(scope) {
    // FLOW v2: picker araması <input class="search-input"> (üstteki genel arama da aynı sınıf → kapsam şart)
    if (scope && scope.querySelector) {
      const v2 = scope.querySelector('input.search-input');
      if (v2) { const vr = v2.getBoundingClientRect(); if (vr.width > 0 && vr.height > 0) return v2; }
    }
    // v126.2: FLOW v2'de KAPSAMSIZ arama YASAK — sayfanın ÜST arama çubuğu da aynı desene
    // uyuyor; oraya yazınca picker filtrelenmiyor ve sayfa kütüphane görünümüne kayıyor.
    const v2page = !!document.querySelector('flow-prompt-box, flow-base-prompt-box, flow-project-page');
    if (!scope) return v2page ? null : (searchInputsIn(document)[0] || null);
    const inner = searchInputsIn(scope)[0];
    if (inner) return inner;
    if (v2page) return null;                    // portal yedeği v2'de kullanılmaz
    // Portal: DOM'da picker'ın dışında ama EKRANDA picker'ın içinde duran input de kabul
    const pr = scope.getBoundingClientRect ? scope.getBoundingClientRect() : null;
    if (!pr || pr.width <= 0) return null;
    return searchInputsIn(document).find(inp => {
      const r = inp.getBoundingClientRect();
      return r.left >= pr.left - 8 && r.right <= pr.right + 8 &&
             r.top  >= pr.top  - 8 && r.bottom <= pr.bottom + 8;
    }) || null;
  }
  // Arama kutusu katlanmış olabilir (RU'da görünür input yok, 'search' ligature'lı İKON
  // BUTON var) → picker İÇİNDEKİ o butona basıp input'u açar. Görünür input varsa hiç
  // tıklamaz (TR/EN davranışı aynen). selectRefsForPrompt'taki kanıtlı yöntemin eşi.
  async function ensureSearchInput(scope) {
    if (!scope) return null;                     // v126.2: kapsamsız arama YASAK (üst çubuk tuzağı)
    let s = findPickerSearch(scope);
    if (s) return s;
    const btn = [...(scope || document).querySelectorAll('button, [role="button"]')].find(b => {
      const r = b.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return false;
      if (b.getAttribute('aria-haspopup')) return false;      // sıralama/filtre menüsü değil
      const tx  = (b.textContent || '').toLowerCase();
      const lbl = (b.getAttribute('aria-label') || '').toLowerCase();
      return tx.includes('search') || SEARCH_RE.test(lbl);
    });
    if (!btn) return null;
    robustClick(btn);
    for (let i = 0; i < 8; i++) { await wait(200); s = findPickerSearch(scope); if (s) return s; }
    return null;
  }
  // FLOW v2 (Angular Material): picker = .cdk-overlay-pane > flow-add-menu-popover-content
  function v2PickerPane() {
    const panes = [...document.querySelectorAll('.cdk-overlay-pane')].filter(x => {
      const r = x.getBoundingClientRect();
      return r.width > 40 && r.height > 40;
    });
    let p = panes.filter(x => x.querySelector('flow-add-menu-popover-content'));   // 1) bilinen bileşen
    // v126.2 YEDEK: Flow bileşen adını değiştirmiş olabilir → picker'ın PARÇALARINI taşıyan pane
    if (!p.length) p = panes.filter(x => x.querySelector(
      'flow-add-menu-asset-list, flow-add-menu-detail-pane, flow-add-menu-side-nav, ' +
      '[class*="add-menu"], [class*="asset-item"], [class*="asset-list"]'));
    // 3) Son çare: içinde hem varlık LİSTESİ hem input olan overlay
    if (!p.length) p = panes.filter(x =>
      x.querySelector('[role="listbox"], cdk-virtual-scroll-viewport') &&
      (x.querySelector('input') || x.querySelector('[role="option"]')));
    return p.length ? p[p.length - 1] : null;
  }
  function findPickerRoot() {
    const v2 = v2PickerPane();
    if (v2) return v2;
    if (document.querySelector('flow-prompt-box, flow-base-prompt-box, flow-project-page')) return null;   // v126.2 (bkz. malzeme yolu)
    const dlgs = [...document.querySelectorAll('[role="dialog"], [aria-modal="true"]')].filter(isBig);
    if (dlgs.length) return dlgs[dlgs.length - 1];
    const s = findPickerSearch();
    if (s) {
      let el = s.parentElement;
      for (let i = 0; i < 14 && el && el !== document.body; i++) {
        if (isBig(el) && [...el.querySelectorAll('img')].some(im => /^https?:/.test(im.src || ''))) return el;
        el = el.parentElement;
      }
    }
    return null;
  }
  function collectUploadCards(root) {
    const scope = root || document;
    // FLOW v2: picker kartı = <button class="asset-item"> (bkz. selectRefsForPrompt notu)
    const visc = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const v2cards = [...scope.querySelectorAll('button.asset-item')].filter(visc);
    if (v2cards.length) return v2cards;
    // v126.1 YEDEK (malzeme yolundakiyle aynı): sınıf değişirse liste seçeneklerini al
    const opts = [...scope.querySelectorAll('[role="option"], cdk-virtual-scroll-viewport button, mat-list-item')]
      .filter(visc)
      .filter(el => !el.closest('flow-add-menu-side-nav'))
      .filter(el => { const r = el.getBoundingClientRect(); return r.height >= 28 && r.height <= 220; });
    if (opts.length) return opts;
    const seen = new Set(), out = [];
    for (const im of [...scope.querySelectorAll('img')]) {
      if (!/^https?:/.test(im.src || '')) continue;
      let el = im, card = null;
      for (let i = 0; i < 6 && el && el !== scope; i++) {
        if (el.matches && el.matches('button, [role="button"], li, a, [tabindex]')) { card = el; break; }
        el = el.parentElement;
      }
      if (!card) card = im.closest('div') || im;
      if (seen.has(card)) continue;
      const r = card.getBoundingClientRect();
      if (r.width < 28 || r.height < 24 || r.width > 700 || r.height > 520) continue;
      if (window.getComputedStyle(card).display === 'none') continue;
      seen.add(card); out.push(card);
    }
    out.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top ||
                       a.getBoundingClientRect().left - b.getBoundingClientRect().left);
    return out;
  }
  function rowMatchesName(card, name) {
    if (!name) return false;
    const n = name.toLowerCase();
    const im = card.querySelector('img');
    const txt = [card.textContent || '', card.getAttribute('aria-label') || '', card.getAttribute('title') || '',
                 im ? (im.getAttribute('alt') || '') : '', im ? (im.getAttribute('title') || '') : ''].join(' ').toLowerCase();
    if (txt.includes(n)) return true;
    const stem = n.replace(/\.[a-z0-9]+$/, '');
    if (stem.length >= 4 && txt.includes(stem)) return true;
    // v126.1: kısaltılmış etiket toleransı (bkz. malzeme yolundaki eşleniği)
    const norm = x => x.toLowerCase().replace(/[^a-z0-9]+/g, '');
    const nn = norm(stem), tt = norm(txt);
    if (nn.length >= 12 && tt) {
      const minLen = Math.max(12, Math.ceil(nn.length * 0.55));
      for (let L = nn.length; L >= minLen; L--) if (tt.includes(nn.slice(0, L))) return true;
    }
    return false;
  }
  function findAddBtn() {
    // FLOW v2 (Angular Material): onay butonu picker'ın detay panelindedir →
    // <button class="detail-add-to-prompt-btn">. Sınıf dilden bağımsız. Metin yedeği
    // v2'de TEHLİKELİ: galeri kartının ⋮ menüsünde de "İsteme ekle" maddesi var.
    const v2p = v2PickerPane();
    if (v2p) {
      const okv = b => { const r = b.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      const v2a = v2p.querySelector('button.detail-add-to-prompt-btn');
      if (v2a && okv(v2a)) return v2a;
      // v126.1: SINIF ADI DEĞİŞMİŞ OLABİLİR. Eskiden burada null dönülüyordu → onay butonu
      // ekranda DURURKEN (ekran görüntüsüyle doğrulandı) kod onu hiç göremiyor, referans
      // eklenemiyordu. Artık picker'ın DETAY PANELİ içinde metinle de aranır; galeri
      // kartının ⋮ menüsündeki "İsteme ekle" maddesi picker'ın DIŞINDA olduğu için karışmaz.
      const det = v2p.querySelector('flow-add-menu-detail-pane') || v2p;
      const cand = [...det.querySelectorAll('button, [role="button"]')].filter(b => {
        if (!okv(b)) return false;
        if (b.classList && b.classList.contains('asset-item')) return false;   // kart değil
        if (b.getAttribute('aria-haspopup')) return false;                     // menü açıcı değil
        const t = (b.textContent + ' ' + (b.getAttribute('aria-label') || '')).toLowerCase();
        return /steme ekle|add to prompt|в запрос|añadir|agregar|adicionar|ajouter|hinzufügen|aggiungi|toevoegen|追加|추가|添加|新增|thêm|إضافة|जोड़/.test(t);
      });
      if (cand.length) {
        cand.sort((a, b) => b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom);
        return cand[0];
      }
      return null;   // v2 picker açık ama onay yok (Kareler yolu tek tıkla doldurur)
    }
    const adds = [...document.querySelectorAll('button, [role="button"]')].filter(b => {
      const r = b.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return false;
      if (b.getAttribute('aria-haspopup')) return false;   // menü/dialog açıcıları ele
      const s = (b.textContent + ' ' + (b.getAttribute('aria-label') || '')).toLowerCase();
      return /steme ekle|add to prompt|в запрос|добавить|añadir|agregar|adicionar|ajouter|hinzufügen|aggiungi|toevoegen|追加|추가|添加|新增|thêm|إضافة|जोड़/.test(s);
    });
    if (!adds.length) return null;
    const inDlg = adds.filter(b => b.closest('[role="dialog"], [aria-modal="true"]'));
    const pick = inDlg.length ? inDlg : adds;
    pick.sort((a, b) => b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom);
    return pick[0];
  }
  function setNativeValue(input, value) {
    try {
      const d = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
      if (d && d.set) d.set.call(input, value); else input.value = value;
      input.dispatchEvent(new Event('input',  { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    } catch (_) {}
  }
  // Referans kimliğini yakala → indirme pipeline'ı bu görseli ASLA video sanıp indirmesin
  function captureRefId(card) {
    try {
      window.__afRefIds = window.__afRefIds || {};
      const urls = [];
      if (card.querySelectorAll) card.querySelectorAll('img').forEach(x => urls.push(x.src || '', x.currentSrc || ''));
      for (const u of urls) {
        const id = (String(u).match(/(?:[?&]name=|flow-content\.google\/[a-z]+\/)([^&?/]+)/i) || [])[1];
        if (id && !window.__afRefIds[id]) window.__afRefIds[id] = 1;
      }
    } catch (_) {}
  }

  // ── Tek yuvayı doldur ─────────────────────────────────────────────────────
  async function fillSlot(slotIdx, wantName, maxAttempts) {
    const label = slotIdx === 0 ? 'başlangıç' : 'bitiş';
    // v126.6 BAYAT İÇERİK KORUMASI: yuva ÇAĞRININ BAŞINDA doluysa içindeki görsel ÖNCEKİ
    // promptun karesidir (temizlik tutmamış). Eskiden bu "başarılı" sayılıyordu → zincir
    // modunda önceki çift AYNEN tekrar üretiliyordu (kullanıcı: iki video birebir aynı).
    // Artık yalnız BU çağrıda doldurulan yuva başarı sayılır; bayat içerik önce boşaltılır.
    let ourFill = false;
    // ── v161 BAYAT KARE TESPITI (kullanici logu 2026-09-08) ─────────────────────
    // slotFilled() yalnizca "yuvada bir img var mi" der. Temizlik BASARILI olsa bile
    // (log: cleared:true) tiklamamiz Flow'un ic modeline islemezse yuva ESKI gorselle
    // yeniden doluyor ve eski kod bunu BASARILI sayiyordu: 49 promptun hepsi ayni
    // kareyle uretildi (log: FRAME diag #1/#2/#3 -> kare:mWpUlNvk9jhNVo).
    // Artik BASARI olcusu = yuvadaki gorselin izi ONCEKI yerlestirmeden FARKLI olmasi.
    // Ayni dosya bilerek tekrar isteniyorsa (yinelenen gorsel) kural devreye girmez.
    const slotSig = k => {
      const s = frameSlots()[k];
      const im = (s && s.el && s.el.querySelector) ? s.el.querySelector('img') : null;
      const src = (im && (im.currentSrc || im.src)) || '';
      return src ? src.slice(-24) : '';
    };
    window.__afFrameLast = window.__afFrameLast || {};
    const lastPut = window.__afFrameLast[slotIdx] || null;
    let staleHit = 0;   // ayni gorsel geri geldi (teshis icin sayilir)
    if (slotFilled(slotIdx)) {
      console.warn('[AutoFlow][kare]', label, 'yuvasında ESKİ görsel duruyor → boşaltılıyor');
      const okClear = await clearOne(slotIdx);
      if (!okClear) console.warn('[AutoFlow][kare]', label, 'yuvası boşaltılamadı — yanlış kare riski');
    }
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (ourFill && slotFilled(slotIdx)) return true;             // önceki deneme tutmuş
      if (!ourFill && slotFilled(slotIdx)) { await clearOne(slotIdx); }   // hâlâ bayat → tekrar dene
      const slots = frameSlots();
      const slot = slots[slotIdx];
      if (!slot) {
        console.warn('[AutoFlow][kare]', label, 'yuvası bulunamadı (deneme', attempt + 1, ') | şerit:', frameBarDump(), '| path:', location.pathname);
        await wait(700); continue;
      }

      // FLOW v2: yuva <div class="frame-trigger"> sarmalayıcısı + içinde
      // <button class="empty-chip"/"chip-container">. Canlı ölçüm: SADE .click() picker'ı
      // AÇIYOR; sentetik tam olay dizisi (robustClick) ise açıp hemen kapatabiliyor.
      // Önce sade tık, açılmazsa robustClick yedeği (eski arayüzde tek yol oydu).
      const inner = (slot.el.querySelector && slot.el.querySelector('button')) || slot.el;
      try { inner.click(); } catch (_) {}
      let root = null;
      for (let i = 0; i < 6 && !root; i++) { await wait(350); root = findPickerRoot(); }
      if (!root) { robustClick(slot.el); }
      for (let i = 0; i < 10 && !root; i++) { await wait(400); root = findPickerRoot(); }
      if (!root) { console.warn('[AutoFlow][kare] picker açılmadı:', label); await wait(600); continue; }

      // Kartı ADIYLA bul; görünmüyorsa PICKER'IN KENDİ arama kutusuyla filtrele
      // (kapsam şart: sayfanın üstündeki genel arama kutusuna yazmak hiçbir şey filtrelemez).
      let card = collectUploadCards(root).find(c => rowMatchesName(c, wantName)) || null;
      if (!card) {
        const scope = findPickerRoot() || root;
        const s = await ensureSearchInput(scope);
        if (s) {
          console.log('[AutoFlow][kare] doğrudan bulunamadı → picker aramasıyla filtrele:', wantName);
          setNativeValue(s, wantName.toLowerCase().replace(/\.[a-z0-9]+$/i, ''));
          await wait(900);
          card = collectUploadCards(findPickerRoot() || root).find(c => rowMatchesName(c, wantName)) || null;
        } else {
          console.warn('[AutoFlow][kare] picker arama kutusu bulunamadı:', wantName);
        }
      }
      if (!card) { console.warn('[AutoFlow][kare] kart bulunamadı:', wantName, '(' + label + ', deneme', attempt + 1, ')'); esc(); await wait(800); continue; }

      // Görsel tam yüklenmeden seçilirse Flow kareyi SİLİK/eksik alıyor → tam yüklenmeyi bekle
      for (let w = 0; w < 10; w++) {
        const im = card.querySelector('img');
        if (im && im.complete && im.naturalWidth > 0) break;
        if (!im && w >= 2) break;   // FLOW v2: kartta hiç <img> yoksa beklenecek bir şey yok
        await wait(250);
        card = collectUploadCards(findPickerRoot() || root).find(c => rowMatchesName(c, wantName)) || card;
      }
      captureRefId(card);
      // v126.5: TEK aktivasyon (malzeme yolunda kanıtlandı) — çift aktivasyon v2 picker'ında
      // seçimi geri alıyor ve onay butonu hiç çizilmiyor.
      const v2mode = !!v2PickerPane();
      const cardEl = (card.matches && card.matches('button.asset-item')) ? card
                   : ((card.closest && card.closest('button.asset-item')) || card);
      const clickTarget = v2mode ? cardEl : (card.querySelector('img') || card);
      // ── v162 TIKLAMA GÜCÜ DENEMEYE GÖRE ARTAR ──────────────────────────────────
      // 1. DENEME ESKİSİYLE BİREBİR (plainClick) → hâlihazırda çalışan kurulumlar
      // hiç etkilenmez. Kullanıcı logu, sade tıkın Flow'un iç seçimini bazen HİÇ
      // değiştirmediğini gösterdi: onay butonu picker'ın VARSAYILAN seçili varlığını
      // (en son yüklenen görsel) ekliyor ve her promptta aynı kare geliyordu.
      // Yeniden denemelerde daha güçlü olay dizisi kullanılır (koordinatlı sentetik
      // dizi + son çare çift tık). Bu dallara YALNIZ ilk deneme başarısız olduğunda
      // (yani bayat kare tespit edildiğinde) girilir.
      if (attempt === 0) {
        plainClick(clickTarget);
      } else if (attempt === 1) {
        console.log('[AutoFlow][kare] 2. deneme → sentetik tık:', wantName);
        plainClick(clickTarget); await wait(250); synthClick(cardEl);
      } else {
        console.log('[AutoFlow][kare] 3. deneme → güçlü tık + çift tık:', wantName);
        robustClick(clickTarget); await wait(250); synthClick(cardEl);
        try {
          const rr = clickTarget.getBoundingClientRect();
          clickTarget.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true,
            composed: true, view: window, clientX: rr.left + rr.width / 2,
            clientY: rr.top + rr.height / 2, detail: 2 }));
        } catch (_) {}
      }
      // v162 TEŞHİS: tıklamadan sonra picker BİZİM kartı seçili gösteriyor mu?
      // (aria-selected / seçili sınıf). Yalnız loga yazılır, karar buna bağlanmaz.
      try {
        await wait(300);
        const sel = cardEl.getAttribute('aria-selected');
        const cls = typeof cardEl.className === 'string' ? cardEl.className : '';
        console.log('[AutoFlow][kare] kart tık sonrası → aria-selected:', sel,
                    '| sınıf:', cls.slice(0, 80), '| deneme:', attempt + 1);
      } catch (_) {}

      // Onay butonu ("İsteme ekle") ~0,3-1,2 sn sonra çizilir; kare yolunda bazen hiç
      // çizilmeden yuva DOĞRUDAN dolar → ikisi birlikte beklenir (~4,4 sn).
      const btnReady = b => !!b && !b.disabled && b.getAttribute('aria-disabled') !== 'true';
      let addBtn = null, synthTried = false;
      // v161: "yuva dolu" TEK BAŞINA bitiş sinyali DEĞİL. Temizlikten sonra Flow yuvayı
      // ESKİ kareyle yeniden doldurabiliyor; eski kod bunu görüp döngüyü ilk turda kırıyor
      // ve ONAY butonuna ("İsteme ekle") HİÇ basmıyordu → seçim uygulanmıyor, eski görsel
      // yerinde kalıyordu (kullanıcı logu: her promptta kare:mWpUlNvk9jhNVo). Artık yuva
      // ancak GERÇEKTEN yeni bir görselle dolduysa çıkılır; aksi hâlde onay beklenir.
      const bayatSimdi = () => !!(lastPut && lastPut.name !== wantName &&
                                  slotSig(slotIdx) && slotSig(slotIdx) === lastPut.sig);
      for (let k = 0; k < 22; k++) {
        if (slotFilled(slotIdx) && !bayatSimdi()) break;  // yuva YENİ görselle doldu → onaya gerek yok
        const cand = findAddBtn();
        if (btnReady(cand)) { addBtn = cand; break; }
        if (!findPickerRoot()) break;                    // picker kapandı
        if (v2mode && k === 9 && !synthTried && !cand) {
          synthTried = true;
          console.log('[AutoFlow][kare] sade tık tutmadı → sentetik TEK tık:', wantName);
          synthClick(cardEl);
        }
        await wait(200);
      }
      if (addBtn) { console.log('[AutoFlow][kare] İsteme ekle →', wantName); plainClick(addBtn); await wait(1200); }
      else if (!findPickerRoot() || v2mode) { /* tek tıkla yerleşti ya da v2: aşağıdaki doğrulama karar verir */ }
      else {
        const c2 = collectUploadCards(findPickerRoot() || root).find(c => rowMatchesName(c, wantName)) || card;
        const t2 = c2.querySelector('img') || c2;
        robustClick(t2);
        try {
          const rr = t2.getBoundingClientRect();
          t2.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, composed: true, view: window,
            clientX: rr.left + rr.width / 2, clientY: rr.top + rr.height / 2, detail: 2 }));
        } catch (_) {}
        await wait(1200);
      }

      // BAŞARI = yuva doldu VE içindeki görsel GERÇEKTEN değişti (v161)
      for (let i = 0; i < 12; i++) {
        if (slotFilled(slotIdx)) {
          const sigNow = slotSig(slotIdx);
          // BAŞKA dosya istendiği hâlde iz öncekiyle AYNIYSA tıklama işlememiş demektir.
          if (lastPut && lastPut.name !== wantName && sigNow && sigNow === lastPut.sig) {
            staleHit++;
            if (i === 0) console.warn('[AutoFlow][kare]', label, 'yuvasına ESKİ görsel geri geldi →',
                                      wantName, '| iz:', sigNow);
          } else {
            ourFill = true;                                  // v126.6: BU çağrıda dolduruldu
            window.__afFrameLast[slotIdx] = { name: wantName, sig: sigNow };   // v161
            if (findPickerRoot()) { esc(); await wait(400); }
            console.log('[AutoFlow][kare]', label, 'karesi yerleşti →', wantName, '| iz:', sigNow);
            return true;
          }
        }
        await wait(300);
      }
      console.warn('[AutoFlow][kare]', label,
                   staleHit ? 'yuvada ESKİ görsel kaldı, tekrar denenecek:' : 'yuvası dolmadı, tekrar denenecek:',
                   wantName);
      if (staleHit) { try { await clearOne(slotIdx); } catch (_) {} }   // v161: bayat içerikle tekrar deneme
      if (findPickerRoot()) { esc(); await wait(700); }
    }
    return false;
  }

  // ── Akış: önce ESKİ kareleri temizle, sonra sırayla yerleştir ──────────────
  // Temizlik şart: Flow kareleri promptlar arası TUTUYOR → temizlenmezse 2. video
  // 1.'nin karesiyle üretilir (zincir/çiftler modunda sonuç tamamen kayar).
  // v161: yeni koşunun ilk prompt'unda önceki koşudan kalan yerleştirme kaydı silinir
  // (yoksa aynı görsellerle ikinci koşuda yanlış 'bayat' alarmı verebilirdi).
  if (idx === 0) { try { window.__afFrameLast = {}; } catch (_) {} }
  const cleared = await clearSlots();
  // v126.6: yalnız TEMİZLİK istendi — kareler yerleştirilemediğinde prompt atlanmadan
  // önce yuvalar boşaltılır ki bir sonraki prompt BAYAT karelerle üretim yapmasın.
  if (clearOnly) {
    window.__afSelBusy = 0;
    console.log('[AutoFlow][kare] yalnız temizlik →', cleared ? 'yuvalar boş' : 'TEMİZLENEMEDİ');
    return { success: !!cleared, cleared, clearOnly: true, slots: frameSlots().length };
  }
  const slots0  = frameSlots().length;
  let placed = 0;
  const okStart = await fillSlot(0, names[0], 3);
  if (okStart) placed++;
  let okEnd = null;
  if (names[1]) {
    okEnd = await fillSlot(1, names[1], 3);
    if (okEnd) placed++;
  }
  window.__afSelBusy = 0;
  // ── v156 TEŞHİS: YUVADA GERÇEKTEN HANGİ GÖRSEL DURUYOR? ──────────────────────
  // slotFilled() yalnızca "dolu mu" der, HANGİ görsel olduğunu sormaz. Kullanıcı raporu
  // "12 görsel yükledim, hepsinde aynı görseli kullandı" derken loglarımız her promptta
  // farklı dosya adı yerleştirdiğimizi söylüyordu. Bu parmak izi ikisini ayırır:
  //   promptlar arasında DEĞİŞMİYORSA  -> yuva gerçekte hiç değişmemiş (bizim taraf),
  //   DEĞİŞİYORSA                  -> Flow'a doğru kare verilmiş (Flow tarafı/başka sebep).
  const frameSig = frameSlots().map(s => {
    const im = (s.el && s.el.querySelector) ? s.el.querySelector('img') : null;
    const src = (im && (im.currentSrc || im.src)) || '';
    return src ? src.slice(-14) : (s.filled ? 'dolu?' : 'boş');
  }).join(',');
  console.log('[AutoFlow][kare] idx', idx, '| istenen:', names.join(' → '), '| yerleşen:', placed, '/', names.length,
              '| yuva:', frameSlots().length, '| kare izi:', frameSig);
  return { success: placed === names.length, wanted: names.length, placed,
           startOk: okStart, endOk: okEnd, cleared, slots: slots0, names, frameSig,
           barDump: slots0 < 2 ? frameBarDump() : '' };   // v126.5: yuva yoksa şerit DOM'u
}

// ══════════════════════════════════════════════════════════════════════
// SIRALI OTO İNDİRME — üretimle EŞ ZAMANLI, sıra ASLA bozulmaz
// ══════════════════════════════════════════════════════════════════════
//
// Sorun: bazı görsellerin üretimi daha uzun sürer. Sıradaki görseli daha
// önce indirip numaralandıran eklentilerde sıra karışır.
//
// Çözüm: Flow akışında en yeni SOL ÜSTtedir; en eski (ilk prompt) SAĞ ALTtadır
// ve yeni tile'lar hep üste eklendiği için en eskinin sırası DEĞİŞMEZ.
// Pipeline her zaman "en eski → en yeni" sırada ilerler. Bir sonraki tile
// HENÜZ üretiliyorsa (% görünüyorsa) BEKLER, ASLA atlamaz. Numaralandırma
// global ve sıralıdır: 0001, 0002, 0003...
//
// Üretim hiç durmaz: pipeline ayrı çalışır ve UI kilidini yalnızca sağ tık →
// menü → kalite seçimi gibi kısa DOM etkileşimi boyunca tutar; upscale ve
// indirme beklemesi sırasında kilidi bırakır.

// Galeriyi EN ALTA (EN ESKİYE) kaydır → pipeline gerçek EN ESKİ tile'dan başlasın.
// Flow galeriyi SANALLAŞTIRDIĞINDAN en alta inmezse yalnız görünen (en YENİ) tile'ları
// görüp karışık sırayla işliyor. SAĞLAM versiyon: TÜM kaydırma kapsayıcılarını (görsel
// atalarından overflow'lu olanlar) + window'u en alta kaydırır; LAZY-LOAD için tile SAYISI
// (yeni tile geliyor mu) stabil olana dek tekrarlar → 100-200 görselde de gerçekten en alta iner.
// (Manuel "Sonradan indir" kullanır; en eski tile'dan sıralı indirme için ŞART.)
async function scrollGalleryToOldest(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId }, world: 'MAIN',
      func: async () => {
        const wait = ms => (window.__afWait ? window.__afWait(ms) : new Promise(r => setTimeout(r, ms))); // arka plan sekmede kısılmayan bekleme
        const tileCount = () => [...document.querySelectorAll('img,video')]
          .filter(m => { const r = m.getBoundingClientRect(); return r.width > 120 && r.height > 80; }).length;
        // YAPI-BAĞIMSIZ KAYDIR: window + sayfa kökü + TÜM kaydırılabilir div'leri en alta it,
        // her birine 'scroll' olayı gönder (lazy-load IntersectionObserver/scroll dinleyicisi
        // tetiklensin). Flow galeri kapsayıcısı ne olursa olsun yakalanır.
        function scrollDownAll() {
          try { window.scrollTo(0, document.documentElement.scrollHeight || 1e9); window.dispatchEvent(new Event('scroll')); } catch (_) {}
          try { const r = document.scrollingElement || document.documentElement; r.scrollTop = r.scrollHeight; } catch (_) {}
          for (const el of document.querySelectorAll('div')) {
            if (el.scrollHeight > el.clientHeight + 150) {
              const cs = getComputedStyle(el);
              if (cs.overflowY === 'auto' || cs.overflowY === 'scroll') {
                try { el.scrollTop = el.scrollHeight; el.dispatchEvent(new Event('scroll', { bubbles: true })); } catch (_) {}
              }
            }
          }
        }
        // EN AZ ~5 sn aktif kaydır (i>=9 → 10 tur × 500ms); sonra tile sayısı 6 tur (≈3 sn)
        // üst üste artmazsa (gerçekten en altta) dur. Maks ~70 sn üst sınır (çok büyük galeri).
        let stable = 0, last = -1;
        for (let i = 0; i < 140; i++) {
          scrollDownAll();
          await wait(500);
          const c = tileCount();
          if (c === last) stable++; else { stable = 0; last = c; }
          if (i >= 9 && stable >= 6) break;
        }
      }
    });
    await pageSleep(tabId, 600);
  } catch (e) { console.warn('[AutoFlow][DL] galeri en-eskiye kaydırma hatası:', e.message); }
}

async function downloadPipeline(manual = false) {
  if (dlLoopActive) { console.log('[AutoFlow][DL] pipeline zaten çalışıyor'); return; }
  if (!manual && !state.autoDownload) return;
  dlLoopActive = true;
  dlNameWarned = false;         // v169: dosya adi uyarisi her kosuda yeniden verilebilsin
  afDlMissLogged = false;       // v169: adlandirilamayan indirme uyarisi da kosu basina bir kez
  ensureDlListener();           // v169: yeniden adlandirma kancasi canli mi? degilse onar
  const myToken = ++dlRunToken; // bu döngünün kimliği; daha yeni bir döngü başlarsa bu çıkar
  dlCancel = false; // yeni pipeline taze başlar (önceki stopAutoDownload/cancel bayrağı temizlenir)
  if (!manual) { state.autoDlActive = true; try { persist(); broadcast(); } catch (_) {} } // "Oto indirmeyi durdur" butonu görünsün
  if (manual) {
    // KRİTİK: manuel başlatma (persist/broadcast) HATA atsa bile dlLoopActive takılı
    // kalmamalı — yoksa sonraki "Sonradan indir" hep 'busy' döner (buton kırmızıya
    // dönmez + indirme başlamaz). Bu yüzden kendi try/catch'i ile koruyoruz.
    try {
      // Toplu indirme: baştan, taze klasör; status'tan bağımsız çalışır.
      // Üretim bittiği için takılı kalmış UI kilidini temizle (manuel indirme bloke olmasın).
      if (!loopActive) { uiLock = false; uiPriorityPending = 0; }
      dlCancel = false;
      state.bulkDownloading = true; // sidepanel butonu "Durdur"a döner
      await loadDlPrefs(); // v149: "Sonradan indir" de kullanicinin kayit klasorunu kullanir
      state.dlNumStart = afDlStartNum; // v175: toplu indirme de paneldeki başlangıç numarasını kullanır
      state.dlDoneKeys = {}; state.dlFailedKeys = {}; state.dlRefKeys = {}; state.dlSkipKeys = {}; state.dlBaseline = null; state.dlDone = 0; state.dlFolder = makeDownloadFolder();
      // v170 Queue: toplu indirme yeni klasore bastan indirir -> inen dosya kaydi da bastan.
      // Farkli projede (dlSequential) numara prompt sirasi DEGIL, duz siradir -> Queue'da
      // indirme durumu hic gosterilmez (yanlis satiri yesil yakmasin).
      state.dlSavedSlots = {}; state.dlTrackPrompts = !state.dlSequential;
      await persist(); broadcast();
      logEvent('start', 'Bulk download started — ' + state.dlFolder + ' | ' + AF_BUILD);
      if (afNumOffset()) logEvent('info', afStartNumNote()); // v175
    } catch (e) {
      console.error('[AutoFlow][DL] manuel başlatma hatası → dlLoopActive sıfırlanıyor:', e);
      dlLoopActive = false; state.bulkDownloading = false;
      try { broadcast(); } catch (_) {}
      return;
    }
  }
  // Sekme arka plandayken de çalışabilsin: bekleme yardımcısı + atılma koruması
  // (auto modda handleStart zaten yapıyor; idempotent — manuel "Sonradan indir" için şart).
  await installPageWaitHelper(state.tabId);
  await setTabAutoDiscard(state.tabId, false);
  await setPageVideoOnly(state.tabId, state.videoOnly); // VİDEO üretimi → yalnız videolar insin, referans görseller değil
  // Referans adlarını sayfaya AKTAR → flowCollectTiles referansları TANISIN ve İNDİRMESİN.
  // Yoksa referans görselleri normal görsel sanılıp 0001,0002… diye iniyor ve numarayı kaydırıyor.
  // HEM AUTO HEM MANUEL: auto modda downloadPipeline, runAutomation ile EŞ ZAMANLI başlıyor;
  // runAutomation içindeki transferRefs'e ulaşılmadan pipeline ilk taramayı yaparsa
  // __afRefImages BOŞ olur → feed'deki referans 'complete' sanılıp İNDİRİLİR. state.refImages
  // handleStart'ta hemen hazır olduğundan burada baştan aktararak bu yarışı kapatıyoruz.
  if ((state.refImages && state.refImages.length) ||
      (state.refIdMap && Object.keys(state.refIdMap).length)) { // v107: kalıcı kimlikler de aktarılır
    try { await transferRefs(state.tabId); }
    catch (e) { console.warn('[AutoFlow][DL] ref transfer err:', e.message); }
  }
  await afMarkPage(state.tabId);   // v174: sayfa yenilenirse tarama bunu fark edip kurulumu tazeler
  if (manual) {
    // VİDEO-ONLY manuel indirmede %33 ZOOM (v107): konum-bazlı video numarası TÜM tile'ların
    // DOM'da olmasına dayanır; %33'te Flow sanallaştırması devreye girmez (oto indirmedeki
    // güvencenin aynısı). restoreZoomIfForced her çıkış yolunda geri alır (bayrak guard'lı).
    if (state.videoOnly && state.tabId && !state.zoomForced) {
      let pz = 1;
      try { pz = await chrome.tabs.getZoom(state.tabId); } catch (_) {}
      state.prevZoom = (pz && pz > 0.5) ? pz : 1;
      state.zoomForced = true;
      await setAutoZoom(state.tabId, 0.33);
      await persist();
    }
    // GALERİYİ EN ALTA (EN ESKİYE) KAYDIR — "Sonradan indir"de ŞART: 100-200 görsel/video varsa
    // pipeline gerçek EN ESKİ tile'dan başlasın (Flow sanallaştırmasında yalnız en-yeniyi görüp
    // sırayı karıştırmasın). Sağlam fonksiyon (tile-sayısı stabil olana dek tüm kapsayıcıları
    // kaydırır) → büyük galeride de gerçekten en alta iner; sonra scrollIntoView ile yukarı ilerler.
    console.log('[AutoFlow][DL] manuel: galeri en eskiye kaydırılıyor (büyük galeri için sabırlı)…');
    await scrollGalleryToOldest(state.tabId);
  }
  // v131: OTO indirme her zaman ÜRETİM projesinden indirir → "farklı proje" bayrağı burada
  // sıfırlanır. (Bayrak yalnız manuel "Sonradan indir" yazıyordu ve KALICIYDI; bir kez farklı
  // projede toplu indirme yapılınca sonraki tüm OTO koşularda numaralandırma bozuluyordu.)
  if (!manual && state.dlSequential) {
    state.dlSequential = false;
    console.log('[AutoFlow][DL] oto koşu → dlSequential sıfırlandı (numara eşlemesi/metin/kayıt tekrar aktif)');
    try { await persist(); } catch (_) {}
  }
  let crashed = false;   // v130: döngü istisnayla mı bitti (aşağıda tek sefer yeniden başlatılır)
  console.log('[AutoFlow][DL] pipeline başladı. manual:', manual, '| klasör:', state.dlFolder);
  // Teşhis: üretilen görseller sayfada nasıl render ediliyor? (bir kez)
  try {
    const dbg = await chrome.scripting.executeScript({
      target: { tabId: state.tabId }, world: 'MAIN', func: flowDebugDump
    });
    console.log('[AutoFlow][DL] TEŞHİS:', JSON.stringify(dbg?.[0]?.result || {}));
  } catch (e) { console.warn('[AutoFlow][DL] debug err:', e.message); }
  // v113: ağ telemetri sarmalayıcısı (idempotent; salt teşhis, sayfa davranışını değiştirmez)
  try {
    await chrome.scripting.executeScript({ target: { tabId: state.tabId }, world: 'MAIN', func: flowNetTap });
  } catch (_) {}
  try {
    let genWait = 0;   // aynı 'üretiliyor' tile'da kaç tur beklendi (takılma guard)
    let trigFail = 0;  // aynı complete tile'da kaç tetik denemesi başarısız
    let skipSeen = 0;  // aynı tile'da art arda kaç kez 'atla' durumu görüldü
    let holdSeen = 0;  // başarısız tile, görünmeyen-kuyruk guard'ında kaç tur bekletildi
    let goneSeen = 0;  // aynı tile için art arda kaç kez 'target-gone' (DOM'dan kaymış) görüldü
    let lastKey  = '';  // hedef tile (key) değişince sayaçları sıfırla
    let lastSnapshot = '';
    let hiddenWarned = false; // sekme gizliyken tek sefer logla
    let refDiagLogged = false; // referans teşhisi tek sefer (SW konsolu)
    let failDiagSig = '';  // v113: başarısız-kart teşhis imzası — imza DEĞİŞTİKÇE loglanır.
    let failDiagCnt = 0;   // (v112'nin tek-seferliği sayfanın <script> veri bloğuna takılıp koşunun
                           //  6. saniyesinde boşa yanmıştı → gerçek hata anından hiç veri alınamadı.
                           //  Artık script metni taranmıyor + koşu başına en çok 3 farklı kayıt.)
    // (v114: NET telemetri sayaçları artık modül kapsamında — harvestNetToState kullanır)
    let uiStarveSince = 0;  // v126.6: oto indirme kaç ms'dir UI kilidini alamıyor (açlık guard'ı)
    let starveLogged  = false; // açlık guard'ı Logs'a bir kez yazılsın
    const usedPiRun = new Set();  // v128: bu koşuda numarası verilmiş prompt indeksleri
    const usedPiCount = new Map(); // v140: prompt indeksi → bu koşuda KAÇ çıktı aldığı
    const usedPiBySid = new Map(); // v145: medya kimliği → o medyaya verilmiş prompt indeksi.
                                   // Tetik başarısız olunca AYNI tile yeniden işlenir; kota
                                   // (usedPiCount) ikinci kez tüketilirse eşleşme "kotası doldu"
                                   // diye REDDEDİLİR ve yeniden denemede numara değişirdi.
                                   // Kimliği bilinen tile kotayı yeniden tüketmez, aynı prompta bağlanır.
    let txtNumOn = false;         // v131: bu koşuda metin-numara EN AZ BİR KEZ uygulandı mı
    // v145: METİN-NUMARA YENİDEN AÇIK — ama artık "tahmin eden" değil "eleyen" biçimde.
    // v142'de kapatılmıştı (Flow başlığı ~33 karakterde kırpılıyor → belirsizlikte yanlış
    // prompta bağlanıyordu). Kapalıyken numara KONUM/SAYAÇ'a düşüyor; 2K/4K ve manuel
    // yolda sayaç = TAMAMLANMA SIRASI olduğundan sırasız biten prompt yanlış numara
    // alıyordu (kullanıcı logu 2026-09-06: 5. prompt 0002 indi). Yeni kural:
    //   • etiket TEK prompta uyuyorsa → numara ondan (kesin kanıt),
    //   • birden çok adaya uyuyorsa → konum adaylardan birini SEÇER (tahmin YOK),
    //   • hiç uymuyorsa → eski yol (konum/sayaç) aynen.
    const TXT_NUM_ENABLED = true;
    // ── v143: GÖRSEL MODU SIRA BEKLEMESİ KAPALI ────────────────────────────────
    // Guard "gönderilen prompt sayısı" ile "galeride görünen kart sayısı"nı karşılaştırıp
    // eksikse indirmeyi bekletiyordu. Flow v2 işleri KUYRUĞA alıyor: 10 prompt
    // gönderilmişken galeride 10 kart YOK, yalnız aktif üretilen birkaç kart var.
    // Yani gönderim sürerken eksik YAPISAL olarak pozitif → guard neredeyse tüm koşu
    // boyunca tetikleniyor ve hibrit indirmeyi öldürüyordu (ölçüm: 1. görsel 4. prompttan
    // sonra hazırdı, 10. prompttan sonra indi; 17 sn sıra-guard'da bekledi).
    // Guard'ın koruduğu senaryo (ESKİ bir promptun kartı hiç çizilmemişken YENİsi
    // tamamlanmış) Flow gönderim sırasına göre işlediği için pratikte oluşmuyor:
    // tamamlanmış bir işin kartı vardır, öncekiler zaten daha erken başlamıştır.
    // Kuyruktaki prompt'un kartı SONRA eklenir, önceki tile'ın numarasını KAYDIRAMAZ.
    // v144 EMNİYET AĞI: bu koşuda ÜRETİLMEKTE olan kartı EN AZ BİR KEZ görebildik mi?
    // Görebiliyorsak konum sayımı tamdır → sıra beklemesine gerek yok (hibrit tam hızda).
    // Göremiyorsak (Flow arayüzü yine değişmişse) konum = TAMAMLANMA SIRASI olur ve numara
    // bozulur → o durumda ESKİ bekleme davranışına DÖNÜLÜR: numara doğru kalır, indirme
    // yavaşlar. Kullanıcı önceliği: numara doğruluğu > hız.
    let sawPending = false;
    let txtNumLogged = false;     // v128: "numara metinden" bilgisi Logs'a bir kez
    let txtSampleLogged = false;  // v128: tile metni okunabiliyor mu — koşuda bir kez örnek
    let dlPhase  = 'baslangic'; // TEŞHİS: döngünün o an takıldığı aşama
    let lastBeat = 0;           // TEŞHİS: nabız satırı en çok 60 sn'de bir
    let lastWaitLog   = 0;  // "indirme bekliyor" teşhis satırı en çok 60 sn'de bir
    const usedSlots = new Set(); // v126.9: BU koşuda verilen numara slotları (çakışma koruması).
                                 // state.dlNumMap KULLANILAMAZ: o koşular arası kalıcıdır ve
                                 // aynı projedeki yeni koşuyu 0001'den başlamaktan alıkoyardı.
    let orderHold  = 0;     // v126.9 (GÖRSEL): eksik çıktı tile'ı için kaç tur beklendi
    let posDeficit = 0;     // v126.9: eksik (henüz çizilmemiş) ESKİ çıktı sayısı → slot rezerve
    let endGrace = 0;  // üretim bitti (status!=running) ama tile bekliyoruz: tampon sayaç
    let endCount = -1; // son görülen tile sayısı (yeni tile geldi mi anlamak için)
    let endSig = '';   // ilerleme imzası (complete:done:tile) — değişiyorsa bekle, sabitse bitir
    let lastNumIdx = -1; // bu koşuda verilen SON numara slotu — dlNumMap'te kaydı olmayan tile
                         // (oto pipeline'ın kaçırdığı) son kayıtlı numaradan +1 devam etsin diye
    let lastNumFail = 0; // v168: lastNumIdx verildiği ANDAKİ kalıcı hata sayısı. Aradaki artış
                         // = o numaradan sonra üretilemeyen prompt sayısı → 'sıra+1' o kadar atlar.
    let holdSig = '';     // v111 görünmez-kuyruk guard'ı: beklenen:görünen imzası — değiştikçe sabır tazelenir
    let ghostSig = '';    // v109 slot-zinciri: çapa-hedef arası bölgenin imzası (kararlılık takibi)
    let ghostStable = 0;  // aynı imza kaç ardışık taramada görüldü (hayalet mi, gerçek boşluk mu)
    let ghostHold = 0;    // hayalet yüzünden kaç tur bekletildi (cap ~3 dk → sonra mevcut sayımla devam)
    const cardSeenAt = new Map(); // v172: medya kimliği → tamamlanmış olarak İLK görüldüğü an
    const posSeenMax = new Map(); // v172: medya kimliği → tamamlanmış kartın önünde görülen EN ÇOK kart sayısı
    let posDropHold = 0;          // v172: hedefin önündeki kart azaldığı için kaç tur bekletildi
    let freshLogged = false;      // v172: olgunlaşma beklemesi Logs'a koşuda bir kez
    let cardDefAccepted = 0;      // v173: ~5 dk kapanmayıp KABUL edilen kart eksiği (sonraki videolar yeniden beklemesin)
    let slotClashHold = 0;        // v173: oto videoda numara çakışmasında kaç tur yeniden sayıldı
    let deficitSince = 0;         // v173: gönderime göre kart eksiğinin KESİNTİSİZ başladığı an (0 = eksik yok)
    const aliasKeys = new Set();  // v174: zaten inmiş kartın YENİ adresi (ayrı kart sayılmaz, indirilmez)
    const slotTxt = new Map();    // v174: numara → o numarayla inen kartın etiketi (adres değişince doğrulama)
    let markRestoreAt = 0;        // v174: sayfa yenilenince kurulumun en son tazelendiği an

    while (manual || state.status !== 'idle') {
      // TOKEN: daha yeni bir pipeline başladıysa (Durdur sonrası zorla sıfırlama + yeniden
      // başlatma) bu ESKİ döngü hemen çıkar → çift döngü/çift indirme olmaz.
      if (dlRunToken !== myToken) { console.log('[AutoFlow][DL] eski döngü (token uyuşmadı) → çıkılıyor'); break; }
      // İPTAL: kullanıcı "Durdur"a bastıysa manuel indirmeyi hemen sonlandır.
      if (dlCancel) { console.log('[AutoFlow][DL] manuel indirme iptal edildi'); logEvent('done', 'Bulk download stopped'); break; }

      // 0) Sekme GÖRÜNÜR mü? Flow sekmesi arka plana alınırsa (başka pencere öne
      // gelir / başka sekmeye geçilir / pencere küçültülür) Chrome sayfayı render
      // etmeyi durdurur; tile pozisyonları bozulur ve AYNI görsel tekrar inebilir.
      // Bu yüzden sekme gizliyken hiçbir tile toplamayız/indirmeyiz ve imleci
      // İLERLETMEYİZ — sekme öne gelince kaldığı yerden güvenle devam eder.
      // NOT: görünürlük maskesi (installPageWaitHelper) kuruluysa burası 'visible' okur →
      // indirme arka planda da sürer. 'hidden' okunması, maskenin KAYBOLDUĞU anlamına gelir
      // (tek nedeni: Flow sayfası yenilendi). İdempotent kurulumu tazele; maske gelince bir
      // sonraki tur 'visible' okur → indirme kaldığı yerden devam eder. Kurulamazsa (sekme
      // kapalı vb.) eski güvenli davranış korunur: gizliyken duraklat.
      if (await isFlowVisible() === 'hidden') {
        if (!hiddenWarned) {
          hiddenWarned = true;
          console.log('[AutoFlow][DL] Flow sekmesi gizli okundu (maske yok — sayfa yenilenmiş olabilir) → maske yeniden kuruluyor');
          await installPageWaitHelper(state.tabId);
        }
        await sleep(1500);
        continue;
      }
      if (hiddenWarned) {
        hiddenWarned = false;
        console.log('[AutoFlow][DL] Flow sekmesi yeniden görünür → indirme devam ediyor');
      }

      // 0) FLOW v2: sayfa tekil düzenleme görünümüne (/edit/) kaymışsa ızgaraya dön.
      //    O görünümde yalnız TEK tile bulunur → sıralı numaralandırma yerinde sayar.
      try {
        const gv = await chrome.scripting.executeScript({
          target: { tabId: state.tabId }, world: 'MAIN', func: ensureGridViewOnFlow
        });
        const gr = gv?.[0]?.result;
        if (gr && gr.changed) logEvent(gr.success ? 'info' : 'error',
          gr.success ? 'Tekil görünümden ızgaraya dönüldü' : 'Tekil görünümden dönülemedi: ' + (gr.path || ''));
      } catch (_) {}

      // 1) Tüm tile'ları al (en eski → en yeni), her birinin durumu ile
      let tiles = [];
      try {
        const res = await chrome.scripting.executeScript({
          target: { tabId: state.tabId }, world: 'MAIN', func: flowCollectTiles
        });
        tiles = res?.[0]?.result || [];
        // v173: 'pending' (medyasız + sinyalsiz kart) yalnız OTO akışta sayılır. "Sonradan indir"
        // üretim bittikten sonra çalışır ve listeyi v172'deki haliyle görür.
        if (manual) tiles = tiles.filter(t => t.state !== 'pending');
      } catch (e) { console.warn('[AutoFlow][DL] collect err:', e.message); }

      // v129: İPTAL kontrolü döngünün BAŞINDA. Eskiden yalnız UI kilidi alındıktan sonra
      // bakılıyordu; bir guard'da beklerken "Durdur" ya da manuel devralma İŞLEMİYORDU.
      if (dlCancel) { console.log('[AutoFlow][DL] iptal (tarama başı) → pipeline kapanıyor'); break; }
      // v174 SAYFA YENİLENDİ Mİ? Toplayıcı işareti göremediyse (pm === false) referans adları,
      // görünürlük maskesi ve video bayrağı sayfadan gitmiştir → yeniden kur ve yeniden tara.
      // (İşaret alanı yoksa, eski sürüm toplayıcı / test düzeneği, hiçbir şey yapılmaz.)
      if (tiles.length && tiles[0].pm === false && Date.now() - markRestoreAt > 5000) {
        markRestoreAt = Date.now();
        logEvent('info', 'Flow sayfası yenilenmiş → indirme kurulumu (referans adları, görünürlük maskesi) yeniden yapıldı');
        try { await installPageWaitHelper(state.tabId); } catch (_) {}
        try { await setPageVideoOnly(state.tabId, state.videoOnly); } catch (_) {}
        if ((state.refImages && state.refImages.length) || (state.refIdMap && Object.keys(state.refIdMap).length)) {
          try { await transferRefs(state.tabId); } catch (_) {}
        }
        await afMarkPage(state.tabId);
        await sleep(500);
        continue;
      }
      if (!sawPending && tiles.some(t => t.state === 'generating')) {
        sawPending = true;                       // v144: üretim kartını görüyoruz → bekleme kapalı
        logEvent('info', 'Üretilmekte olan kartlar görülüyor → numara gönderim sırasından geliyor, indirme beklemez');
      }

      await afWatchVisibility(state.tabId); // v175 teşhis (üretim döngüsüyle ortak, 15 sn'de bir)

      // NABIZ (Logs panelinde görünür): 45 sn'de bir; faz + TILE HARİTASI + hedef indeksi.
      // Harita "c=tamam g=üretiliyor f=başarısız r=referans p=sinyalsiz kart (v173)" → hedefin önünde fazladan/takılı
      // bir tile varsa (numara kayması + indirmenin beklemesi) TEK satırdan görünür.
      if (Date.now() - lastBeat > 45000) {
        lastBeat = Date.now();
        try {
          const mapB = tiles.slice(0, 14).map((t, i2) => i2 + ':' + String(t.state || '?')[0]).join(' ');
          logEvent('info', 'DL nabız — faz:' + dlPhase + ' | harita:[' + mapB + (tiles.length > 14 ? ' …' : '') + ']' +
            ' | inen:' + Object.keys(state.dlDoneKeys || {}).length +
            ' başarısız:' + Object.keys(state.dlFailedKeys || {}).length +
            ' ref:' + Object.keys(state.dlRefKeys || {}).length +
            ' | üretim:' + state.status);
        } catch (_) {}
      }

      // TEŞHİS: tile durumları değiştiğinde tek satır logla (sıra: en eski→yeni)
      const snap = tiles.map((t, i) => i + ':' + t.state[0]).join(' ');
      if (snap !== lastSnapshot) {
        lastSnapshot = snap;
        console.log('[AutoFlow][DL] tile durumları (idx:durum) →', snap || '(boş)');
      }

      // TEŞHİS (tek sefer): referans kimlikleri vs feed tile kimlikleri. "Referans yine iniyor"
      // sorununda eşleşmenin neden tutmadığını KESİNLEŞTİRİR (kimlik yakalandı mı / feed farklı mı).
      if (!refDiagLogged && tiles.some(t => t.state === 'complete' || t.state === 'reference')) {
        refDiagLogged = true;
        try {
          const d = await chrome.scripting.executeScript({ target: { tabId: state.tabId }, world: 'MAIN', func: flowRefDiag });
          console.log('[AutoFlow][DL] REF DIAG →', JSON.stringify(d?.[0]?.result || {}));
        } catch (e) { console.warn('[AutoFlow][DL] ref diag err:', e.message); }
      }

      // TEŞHİS (v113, imza değiştikçe + KALICI log): DOM'da başarısız-kart metni belirince
      // dedektörün onu NASIL gördüğünü kaydet (kaç metin düğümü ışık/shadow DOM'da, kutu
      // boyutları, kapıdan geçti mi, collector kaç 'failed' üretti). logEvent ile persist
      // edilir → sonradan LevelDB'den okunup "kart neden sayılmadı" kesin cevaplanır.
      // v112'de tek-sefer kilidi sayfanın <script> veri bloğundaki eşleşmeyle (FAILDIAG
      // probes tag:SCRIPT, box 3952x2873) 6. saniyede boşa yanmıştı; script artık taranmıyor
      // (flowFailDiag2 + iki collector) ve kayıt imza başına bir kez, koşuda en çok 3 kez.
      if (failDiagCnt < 3) {
        try {
          const d = await chrome.scripting.executeScript({ target: { tabId: state.tabId }, world: 'MAIN', func: flowFailDiag2 });
          const fr = d?.[0]?.result;
          if (fr && (fr.light || fr.shadow)) {
            const sigNow = fr.light + '/' + fr.shadow + '/' + (fr.probes || []).map(p => p.tag + ':' + p.box + ':' + p.pass).join(',');
            if (sigNow !== failDiagSig) {
              failDiagSig = sigNow; failDiagCnt++;
              const fs = JSON.stringify(fr);
              const failCnt = tiles.filter(t => t.state === 'failed').length;
              console.log('[AutoFlow][DL] FAIL DIAG →', fs, '| collector failed:', failCnt);
              logEvent('diag', 'FAILDIAG ' + fs.slice(0, 380) + ' | colFailed:' + failCnt);
            }
          }
        } catch (_) {}
      }

      // AĞ HASADI (v113 telemetri + v114 KESİN EŞLEME): sayfa tamponundaki API yanıt özetlerini
      // al → üretim yanıtlarının uuid'lerini promptMediaMap'e bağla + kalıcı NET telemetrisi yaz.
      await harvestNetToState(state.tabId);

      // KİMLİK-BAZLI SEÇİM (indeks imleci YOK): her tur en eski→yeni TARA, işlenecek
      // İLK tile'ı bul = referans olmayan + henüz indirilmemiş (dlDoneKeys) + kalıcı
      // başarısız olmayan (dlFailedKeys). Kimlik = görsel URL'i (key). Böylece liste
      // bir tur içinde küçülse/kaysa bile (Flow ekran-dışını DOM'dan atınca) hiçbir
      // tile ATLANMAZ — eski indeks imlecinin SESSİZ ATLAMA kusuru ortadan kalkar.
      if (!state.dlDoneKeys)   state.dlDoneKeys = {};
      if (!state.dlFailedKeys) state.dlFailedKeys = {};
      if (!state.dlRefKeys)    state.dlRefKeys = {};
      if (!state.dlSkipKeys)   state.dlSkipKeys = {};   // v133: numara tüketmeyen atlananlar

      // ── v126.3 BİTİŞ KAPISI ────────────────────────────────────────────
      // ÜRETİM bitti (status != running) VE beklenen tüm dosyalar hesaba katıldıysa
      // (indi ya da kalıcı başarısız işaretlendi) pipeline'ı HEMEN kapat.
      // NEDEN: galeride kalan tek bir "üretiliyor" placeholder'ı (kullanıcının kendi
      // üretimi, hayalet kart ya da hiç tamamlanmayan önizleme) aşağıdaki bekleme
      // dalında pipeline'ı ~20 dk tutuyordu → "Durdur" butonu kırmızı kalıyor ve sayfa
      // %33 zoom'da takılı kalıyordu; kullanıcı elle durdurmak zorunda kalıyordu
      // (rapor 2026-09-05). Kapı yalnız OTO modda ve yalnız üretim bittikten sonra
      // çalışır; beklenen dosyalardan biri bile eksikse dokunmaz (eski davranış aynen).
      if (!manual && state.status !== 'running') {
        const perPrompt = state.dlSequential ? 1 : Math.max(1, (state.genSettings && state.genSettings.count) || 1);
        const expectAll = (state.prompts ? state.prompts.length : 0) * perPrompt;
        const accounted = Object.keys(state.dlDoneKeys).length + Object.keys(state.dlFailedKeys).length;
        if (expectAll > 0 && accounted >= expectAll) {
          console.log('[AutoFlow][DL] üretim bitti + beklenen', expectAll, 'dosya tamam (' + accounted +
                      ') → pipeline kapanıyor (buton + zoom serbest)');
          logEvent('info', 'Üretim ve indirme tamamlandı (' + (state.dlDone || 0) + '/' + expectAll + ')');
          break;
        }
      }
      // KARARLI KİMLİK: Flow medya URL'i `?name=XXX` taşır; XXX KALICI ve BENZERSİZ medya
      // kimliğidir. URL'in gerisi (redirect token / yüklenme durumu) tarama arasında
      // DEĞİŞEBİLİR → tam URL'i anahtar yaparsak aynı tile "yeni" sanılıp İKİ KEZ sayılır,
      // küme boyutu +2 olur ve bir slot ATLANIR (10→10c, 7d→8b). Sadece name=XXX'i kullan →
      // her tile TEK kararlı kimlik → sayım asla şişmez. (name= yoksa tam URL — yine benzersiz.)
      // v174: Flow v2 görsel/poster adresi flow.google.com/asb/<token>=<ekler>. Ekler (=s512-rw,
      // =mm,22,15 ...) AYNI medyanın boyut/biçim seçenekleridir ve Flow bunları sonradan değiştiriyor
      // (kullanıcı logu 04:58:57: indirilen kartın adresine "=mm,22,15" eklendi → kart yeni sanıldı,
      // numara dolu olduğu için video başına 30 sn beklendi). Kimlik = token; ek kimliğe girmez.
      const stableId = (u) => { const m = (u || '').match(/(?:[?&]name=|flow-content\.google\/[a-z]+\/)([^&?/]+)/i); if (m) return m[1]; const a = (u || '').match(/\/asb\/([A-Za-z0-9_-]{20,})/); return a ? 'asb:' + a[1] : (u || ''); };
      const tileKey = (t) => t.key ? ('k:' + stableId(t.key)) : ('p:' + t.top + ',' + t.left);
      // genIdx (numara slotu) = ŞİMDİYE KADAR SONUÇLANMIŞ tile sayısı (inen + kalıcı
      // başarısız). KRİTİK: bunu CANLI TARAMADAN saymıyoruz! Galeride çok tile olunca Flow
      // ekran-dışı (inmiş) tile'ları DOM'dan ATIYOR (virtualization) → canlı sayım EKSİK
      // kalıp AYNI numarayı tekrar veriyordu (0003 ×3, 0006c ×5...). KALICI küme boyutu
      // virtualization'dan ETKİLENMEZ → MONOTON artar, numara ASLA tekrarlamaz.
      // NUMARA: inen + GERÇEK başarısız (done+failed). Başarısız tile KENDİ slotunu TÜKETİR →
      // boşluk bırakır ama KAYDIRMAZ: 0001 sonrası 0001b hatalıysa o slot boş kalır, sonraki inen
      // 0002 olur (v37/v1.1.1 davranışı — kullanıcı isteği). GEÇİCİ uyarılar (throttle: olağan
      // dışı/yoğun) v77'de 'failed' SAYILMAZ (beklenir, complete olur) → yalnız GERÇEK hatalar
      // (genuine) slot tüketir → phantom kaynaklı sahte boşluk olmaz.
      const genIdx = Object.keys(state.dlDoneKeys).length + Object.keys(state.dlFailedKeys).length;
      // YENİDEN-ANAHTARLANAN BAŞARISIZ TILE GÖÇÜ (v106): başarısız tile'ın kimliği "önceki
      // complete tile'ın kimliği + ofset"e çapalıdır (F|anchor|off). Videolar SIRASIZ
      // tamamlandığından, işaretleme anında henüz görünmeyen/tamamlanmamış daha ESKİ bir tile
      // SONRADAN complete olursa çapa değişir → aynı fiziksel tile YENİ anahtarla "yeni
      // başarısız" sanılıp İKİNCİ kez sayılır ve sonraki tüm numaralar +1 kayardı. Tespit:
      // kayıtlı F| anahtarının çapası şu an GÖRÜNÜR complete'ler arasında ama anahtarın
      // kendisi taramadaki hiçbir başarısız tile'da yok → ÖKSÜZ kayıt. Taramada bilinmeyen
      // ve finalize bölgesinde kalan (ordinal < genIdx) başarısız tile varsa öksüz anahtar
      // ona TAŞINIR: sayı değişmez, yeniden doğrulama/çift sayım olmaz. Gerçekten YENİ bir
      // başarısız tile sınırda (ordinal ≥ genIdx) olduğundan taşınmaz → eski davranış aynen.
      {
        const curFailedKeys = [];
        const curCompleteIds = new Set();
        let ord = 0;
        for (const t of tiles) {
          if (t.state === 'reference') continue;
          if (t.state === 'complete' && t.key) curCompleteIds.add(stableId(t.key));
          if (t.state === 'failed' && t.failKind !== 'throttle') curFailedKeys.push({ key: tileKey(t), ord });
          ord++;
        }
        const curSet = new Set(curFailedKeys.map(f => f.key));
        const orphans = Object.keys(state.dlFailedKeys).filter(k => {
          if (k.indexOf('k:F|') !== 0 || curSet.has(k)) return false;
          const a = k.split('|')[1]; // 'k:F' | çapa | ofset
          return a === 'head' || curCompleteIds.has(a);
        });
        if (orphans.length) {
          const unknowns = curFailedKeys.filter(f =>
            !state.dlFailedKeys[f.key] && !state.dlDoneKeys[f.key] &&
            !(state.dlRefKeys && state.dlRefKeys[f.key]) && f.ord < genIdx);
          let moved = false;
          for (let m = 0; m < unknowns.length && m < orphans.length; m++) {
            console.log('[AutoFlow][DL] başarısız tile anahtarı taşındı (çapa değişimi — çift sayım önlendi):',
                        orphans[m], '→', unknowns[m].key);
            delete state.dlFailedKeys[orphans[m]];
            state.dlFailedKeys[unknowns[m].key] = true;
            moved = true;
          }
          if (moved) await persist();
        }
      }
      // REFERANS-BİLİNEN tile (v107): collector 'reference' demese bile SW tarafında
      // dlRefKeys (menüde 'orijinal boyut' tespiti) veya kalıcı refIdMap kimliği eşleşiyorsa
      // REFERANSTIR → seçilmez, konum-bazlı numarada ve görünür-tile sayımında da sayılmaz.
      // v173: TAMAMLANMIŞ kartın KENDİ etiketi yüklenen referansın dosya adını taşıyorsa o kart
      // referanstır. Kanıt (kullanıcı logu 04:02:16): referans kartı sayfa tarafında bir anlık
      // 'complete' okundu ve "NUMARA 0003 | metin:"referans (1).jpg"" ile indirilmeye çalışıldı.
      // Liste SW'deki kalıcı state.refImages'tan gelir (sayfa değişkenine bağlı değil). Flow'un
      // ürettiği kart başlıkları dosya uzantısı taşımaz; yalnız uzantılı adlar kullanılır.
      // Yalnız 'complete' kayıtlara bakılır: onların metni her zaman kartın kendi elemanından okunur.
      const refLabelNames = (state.refImages || []).map(r => String((r && r.name) || '').toLowerCase().trim())
        .filter(n => n.length >= 5 && /\.[a-z0-9]{2,5}$/.test(n));
      const refLike = (t) => {
        if (t.state === 'reference') return true;
        if (state.dlRefKeys && state.dlRefKeys[tileKey(t)]) return true;
        if (t.state === 'complete' && refLabelNames.length && t.txt) {
          const lt = String(t.txt).toLowerCase();
          if (refLabelNames.some(n => lt.includes(n))) return true;
        }
        const rid = ((t.key || '').match(/(?:[?&]name=|flow-content\.google\/[a-z]+\/)([^&?/]+)/i) || [])[1];
        return !!(rid && state.refIdMap && state.refIdMap[rid]);
      };
      // VİDEO MODU (v107): numara KONUMDAN gelir (aşağıda) → sırasız indirme numarayı bozmaz.
      const modeVideoNum = (state.genSettings && state.genSettings.mode === 'VIDEO') || !!state.videoOnly;
      // ── v172 KAYBOLAN KART (yalnız OTO VİDEO) ────────────────────────────────────
      // KANIT (kullanıcı logu 2026-09-15, 9 prompt): 5. video 4.'den birkaç saniye önce bitti
      // ve 0004 aldı, 4. video 0005 oldu. 03:18:33 nabzında 9 video gönderilmişken harita 8
      // kart gösteriyordu: Flow v2, videonun SON birkaç saniyesinde kartı ne ilerleme göstergesi
      // ne medyayla çiziyor → toplayıcı o kartı hiç görmüyor. O anda sonraki video tamamlanmışsa
      // konum ve zincir ikisi de kaybolan kartı atlıyor (konum:3 zincir:3 hayalet:0) ve
      // kuyruk guard'ı `konum === sayaç` olduğu için devreye girmiyor.
      // Burada yalnız ölçülür (kart sayısı + tamamlanmanın ilk görüldüğü an); karar aşağıda,
      // kuyruk guard'ından sonra. Kart sayısı = görünen ve sonuçlanmamış kartlar + sonuçlanmış
      // (inen/başarısız/referans) kayıtlar → indirme sayıyı değiştirmez, kaybolan kart düşürür.
      // Konum hafızası HER tamamlanmış kart için her taramada tutulur (yalnız hedef için değil):
      // video tamamlandığında sırada indirilecek başka videolar olabilir; hedef olduğu anda
      // önündeki kart çoktan kaybolmuşsa hafıza boş kalırdı (stres testinde ölçüldü).
      // Sıra ölçüsü = sonuçlanmış kayıt sayısı (inen+başarısız+referans) + kartın önündeki
      // SONUÇLANMAMIŞ görünen kartlar. Önündeki kart inince/referans diye tanınınca ya da inmiş
      // eski kart sayfadan düşünce ölçü DEĞİŞMEZ; yalnız sonuçlanmamış bir kartın kaybolması
      // düşürür. (Ham konum kullanılınca referans tanınması "kart kayboldu" sanılıp akış
      // başında 24'er sn boşa bekleniyordu - ölçüldü.)
      let cardNow = -1;
      let visCardsNow = -1, expCardsNow = -1;   // v173: görünen kart (referans dışı, kimlik-tekil) / gönderimden beklenen kart
      const ordNow = new Map();   // bu taramada tamamlanmış kartın sıra ölçüsü
      if (modeVideoNum && !manual) {
        const seenCard = new Set();
        visCardsNow = 0;
        const resolvedN = Object.keys(state.dlDoneKeys).length + Object.keys(state.dlFailedKeys).length +
                          Object.keys(state.dlRefKeys).length;
        // cardNow gönderilen prompt çıktılarıyla karşılaştırılır → referans kayıtları SAYILMAZ
        cardNow = Object.keys(state.dlDoneKeys).length + Object.keys(state.dlFailedKeys).length;
        let unres = 0;
        for (const t of tiles) {
          if (refLike(t)) continue;
          const sv = t.key ? stableId(t.key) : '';
          if (sv) { if (seenCard.has(sv)) continue; seenCard.add(sv); }
          visCardsNow++;
          const k = tileKey(t);
          const open = !state.dlDoneKeys[k] && !state.dlFailedKeys[k] && !aliasKeys.has(k);   // v174: inmiş kartın yeni adresi ayrı kart değil
          if (t.state === 'complete' && sv && open) {
            const o = resolvedN + unres;
            ordNow.set(sv, o);
            if (!cardSeenAt.has(sv)) cardSeenAt.set(sv, Date.now());
            if (!(posSeenMax.get(sv) >= o)) posSeenMax.set(sv, o);
          }
          if (open) { unres++; cardNow++; }
        }
        // v173: kart eksiği (gönderilen çıktı - sayılan kart) ne zamandan beri KESİNTİSİZ sürüyor?
        // Her taramada ölçülür; aşağıdaki kuyruk muhafızı yalnız süren eksikte bekler.
        {
          const cntD = Math.max(1, (state.genSettings && state.genSettings.count) || 1);
          let skD = 0; const spD = state.skippedPrompts || {};
          for (const kk in spD) if (spD[kk] && Number(kk) < state.currentIndex) skD++;
          expCardsNow = Math.max(0, Math.min(state.currentIndex || 0, (state.prompts || []).length) - skD) * cntD;
          if (expCardsNow - Math.max(visCardsNow, cardNow) > cardDefAccepted) { if (!deficitSince) deficitSince = Date.now(); }
          else deficitSince = 0;
        }
      }
      let idx = -1;
      for (let j = 0; j < tiles.length; j++) {
        const t = tiles[j];
        if (refLike(t)) continue;                     // referans → indirilmez
        const k = tileKey(t);
        // Sonuçlanmış (inen VEYA kalıcı başarısız) → atla. Kimlik = görsel URL'i (key);
        // görsellerde kararlıdır. (Konum-bazlı atlama YOK: manuel indirme galeriyi
        // kaydırdığından viewport konumları değişir ve yanlış tile atlanırdı.)
        if (state.dlDoneKeys[k] || state.dlFailedKeys[k] || (state.dlRefKeys && state.dlRefKeys[k]) ||
            (state.dlSkipKeys && state.dlSkipKeys[k])) continue;   // v133: fantom = atla, slot tüketme
        // VİDEO MODU — OLUŞTUKÇA İNDİR (v107): en eski TAMAMLANMIŞ tile seçilir; üretiliyor/
        // başarısız tile BEKLENMEZ (eskiden en eski işlenmemişte sıra bekleniyordu → kuyruktaki
        // tek yavaş video tüm indirmeyi durduruyordu: "15-20 üretildi, 5. anca indi").
        // Numara konumdan geldiği için atlanan tile sonradan tamamlanınca KENDİ numarasıyla iner.
        // v134: METİN NUMARASI açıkken (txtNumOn) GÖRSEL modunda da aynısı — numara tile'ın
        // kendi başlığından geldiği için sıra beklemenin faydası yok, zararı var (hata kartının
        // 16 sn'lik doğrulaması tüm indirmeyi bekletiyordu).
        if ((modeVideoNum || txtNumOn || !manual) && t.state !== 'complete') continue; // v142: oto akışta da hibrit
        idx = j; break;                               // işlenecek EN ESKİ (video modunda: en eski TAMAM) tile
      }

      // KONUM-BAZLI numara (1K görsel direct + VİDEO modu — aşağıda seçilir): idx'ten ÖNCEKİ
      // referans-olmayan tile sayısı = bu tile'ın ÜRETİM SIRASINDAKİ KONUMU. %33 zoom tüm
      // tile'ları DOM'da tuttuğundan canlı sayım TAM. Her gerçek tile = 1 KONUM → phantom bir
      // tile'ın geçici 'başarısız' fazının dlFailedKeys'teki kalıntısı numarayı ŞİŞİREMEZ
      // (çift sayma imkânsız: aynı tile hem 'failed' hem 'done' anahtarıyla sayılmaz). Sayaç
      // (done+failed) bu çift-saymaya açıktı → 100 promptta 106 numara, 11→13 atlama; v107'de
      // referans tile'larının sayaca karışması "5. video 0008" kaymasını da yaratıyordu →
      // video yolu da konuma geçirildi (refLike dışlanır; başarısız tile konum tüketir = boşluk).
      let genIdxPos = 0;
      if (idx >= 0) {
        // KİMLİK-TEKİLLEŞTİRME (v109): aynı medya feed'de birden çok yerde render edilebiliyor
        // (indirme etkileşimi sonrası önizleme/panel kopyası vb.) → aynı kimlik iki konum sayılıp
        // numarayı +1 kaydırabiliyordu. Bir kimlik yalnız İLK görüldüğü konumda sayılır; hedefin
        // kendi kopyası da sayılmaz. Kimliksiz tile'lar (üretiliyor/başarısız) konumla sayılmaya
        // devam eder (onların güvencesi aşağıdaki slot-zinciri/bekletme).
        const seenPosIds = new Set();
        const sidTarget = stableId(tiles[idx].key || '');
        if (sidTarget) seenPosIds.add(sidTarget);
        for (let j = 0; j < idx; j++) {
          const tj = tiles[j];
          if (refLike(tj)) continue;
          const sj = tj.key ? stableId(tj.key) : '';
          if (sj) { if (seenPosIds.has(sj)) continue; seenPosIds.add(sj); }
          genIdxPos++;
        }
      }

      // İşlenecek tile YOK (hepsi indirildi/başarısız/referans) → bitir / grace bekle.
      // MANUEL indirmede üretim devam ediyor (status='running') olsa BİLE grace'e gir
      // (yoksa sonsuz döner, dlLoopActive takılır). Oto modda ise üretim sürerken bekler.
      if (idx === -1) {
        if (manual || state.status !== 'running') {
          // ÜRETİM GÖNDERİMİ bitti AMA son promptların görselleri hâlâ render/kuyrukta olabilir.
          // İLERLEME-BAZLI bekleme: complete sayısı / inen sayısı / tile sayısı DEĞİŞİYORSA
          // (rate-limit'li yavaş render dahil) sabırla bekle; SABİTLENİNCE moderate süre sonra BİTİR.
          // (Eski mantık: 'anyGen' STUCK placeholder'da SONSUZ bekliyordu; 'totalGen<expected' ~10 dk
          //  lingering yapıyordu → üretim+indirme bitse bile "Oto indirmeyi durdur" butonu kırmızı +
          //  zoom %33 takılı kalıyordu. Artık ilerleme durunca pipeline kapanır → buton/zoom serbest.)
          // v107: video modunda throttle'daki tile da "hâlâ gelecek" sayılır (sonra tamamlanır).
          // v173: sinyalsiz kart ('pending') da henüz gelmemiş bir çıktıdır. Sayılmayınca pipeline
          // üretim bitince ~36 sn sonra kapanıyordu (kullanıcı koşusu: 3-7. videolar hiç inmedi).
          const anyGen = tiles.some(t => t.state === 'generating' || (t.state === 'pending' && !refLike(t)) ||
            (modeVideoNum && t.state === 'failed' && t.failKind === 'throttle'));
          const completeNow = tiles.filter(t => t.state === 'complete').length;
          const doneNow     = Object.keys(state.dlDoneKeys).length;
          const sig = completeNow + ':' + doneNow + ':' + tiles.length;
          if (sig !== endSig) { endSig = sig; endGrace = 0; await sleep(manual ? 1500 : 3000); continue; } // ilerleme var → bekle
          if (manual) {
            // v107: video modunda üretiliyor tile varsa SABIRLA bekle (video dakikalar sürer;
            // eskiden buraya hiç düşülmezdi çünkü seçim generating'de takılırdı) — ~5 dk.
            if (++endGrace < ((modeVideoNum && anyGen) ? 200 : 4)) { await sleep(1500); continue; }
            console.log('[AutoFlow][DL] bulk indirme tamamlandı (galeri sabit) → kapanıyor');
            break;
          }
          // OTO: galeri sabit (ilerleme yok). generating varsa biraz daha sabırlı (queued render
          // başlayabilir), yoksa daha kısa → buton/zoom uzun takılı kalmaz.
          // v107 video modu: seçim generating'de artık BEKLEMEDİĞİ için son videoların
          // render'ı bu dala düşer → eski genWait guard'ına denk sabır (~20 dk).
          const stableMax = anyGen ? (modeVideoNum ? 400 : 24) : 12; // video: ~20 dk / ~72 sn / ~36 sn
          if (++endGrace < stableMax) {
            if (endGrace % 8 === 0)
              console.log('[AutoFlow][DL] galeri sabit, bitiş bekleniyor (grace', endGrace + '/' + stableMax, '| gen:', anyGen + ')');
            await sleep(3000); continue;
          }
          console.log('[AutoFlow][DL] galeri sabitlendi → pipeline kapanıyor (buton/zoom serbest)');
          break;
        }
        // v126.6 TEŞHİS (Logs panelinde görünür — SW konsolu kullanıcıya kapalı):
        // üretim sürerken indirilecek tile YOKSA nedenini 60 sn'de bir yaz.
        if (Date.now() - lastWaitLog > 60000) {
          lastWaitLog = Date.now();
          try {
            const cmp = tiles.filter(t => t.state === 'complete').length;
            const gen = tiles.filter(t => t.state === 'generating').length;
            const rf  = tiles.filter(t => refLike(t)).length;
            const pn  = tiles.filter(t => t.state === 'pending').length;   // v173
            logEvent('info', 'İndirme bekliyor — tile:' + tiles.length + ' tamam:' + cmp +
              ' üretiliyor:' + gen + ' referans:' + rf + (pn ? ' sinyalsiz:' + pn : '') + ' inen:' + Object.keys(state.dlDoneKeys).length);
          } catch (_) {}
        }
        dlPhase = 'yeni-tile-bekleniyor';
        await sleep(3000); // üretim sürüyor, yeni tile bekle
        continue;
      }
      endGrace = 0; endCount = tiles.length;

      const tile = tiles[idx];
      const key  = tileKey(tile);
      if (key !== lastKey) { lastKey = key; genWait = 0; trigFail = 0; skipSeen = 0; goneSeen = 0; holdSeen = 0; holdSig = ''; ghostSig = ''; ghostStable = 0; ghostHold = 0; orderHold = 0; posDeficit = 0; slotClashHold = 0; } // hedef değişti

      // v114 KESİN EŞLEME: hedefin medya kimliği üretim yanıtından bir prompt'a bağlı mı?
      // Bağlıysa numara oradan gelecek → konum/sayım guard'larına ve slot-zincirine gerek yok.
      const sidMap = stableId(tile.key || '');
      const mappedPi = (!state.dlSequential && sidMap && state.promptMediaMap &&
                        Object.prototype.hasOwnProperty.call(state.promptMediaMap, sidMap))
        ? state.promptMediaMap[sidMap] : -1;
      // v129: numara KESİN mi? (ağ eşlemesi VEYA tile metni). Kesinse aşağıdaki konum
      // koruma guard'ları devre dışı → eksik/hiç oluşmayan tile pipeline'ı BEKLETEMEZ.
      // v145: "kesin" ancak etiket TEK prompta (kotası dolmamış) uyuyorsa. Belirsiz etiket
      // artık konumla çözüldüğü için burada kesin SAYILMAZ → konum guard'ları devrede kalır.
      // (dlCount AŞAĞIDA tanımlı → burada kullanmak TDZ hatası atardı; aynı değer yeniden
      //  hesaplanıyor.)
      const cntCert = state.dlSequential ? 1 : Math.max(1, (state.genSettings && state.genSettings.count) || 1);
      // ── v146 YAPISAL KAPI: kart, HENÜZ GÖNDERİLMEMİŞ bir prompta ait OLAMAZ ────────
      // Kullanıcı logu 2026-09-06 17:50: 5 prompt gönderilmişken ilk kart "prompt#10"
      // eşleşmesi aldı. Böyle bir iddia fizik olarak imkânsız; metin eşleşmesinin ilk
      // elemesi bu. currentIndex = gönderilen prompt sayısı. Manuelde (üretim bu oturumda
      // yapılmamış olabilir) kapı UYGULANMAZ → eski davranış korunur.
      const sentMax = (!manual && typeof state.currentIndex === 'number' && state.currentIndex > 0)
        ? state.currentIndex : Infinity;
      const priorPi = (sidMap && usedPiBySid.has(sidMap)) ? usedPiBySid.get(sidMap) : -1;
      const txtCandNow = (TXT_NUM_ENABLED && !state.dlSequential && tile.txt)
        ? promptCandidatesByText(tile.txt, state.prompts)
            .filter(i => i < sentMax)
            .filter(i => i === priorPi || (usedPiCount.get(i) || 0) < cntCert) : [];
      const numCertain = (mappedPi >= 0) || (txtCandNow.length === 1);

      // Kullanıcı bu çıktıyı Gallery'de sildi → indirme, kalıcı atla
      if (state.galleryExcluded && state.galleryExcluded[idx]) {
        console.log('[AutoFlow][DL] tile', idx, 'kullanıcı tarafından hariç tutuldu → atlanıyor');
        state.dlFailedKeys[key] = true; await persist();
        continue;
      }

      // 3) Hâlâ üretiliyor (%) VEYA GEÇİCİ uyarı (throttle: "olağan dışı/yoğun" — tile SONRA
      //    tamamlanır) → BEKLE, asla atlama (sıra korunur; takılma guard'lı). v1.1.1 davranışı:
      //    yüklenen/işlenen tile beklenir, yalnız GERÇEK hatalı (genuine) hızlı geçilir.
      if (tile.state === 'generating' || (tile.state === 'failed' && tile.failKind === 'throttle')) {
        skipSeen = 0;
        const waitLbl = tile.state === 'generating' ? 'üretiliyor' : 'geçici uyarı (throttle)';
        if (++genWait % 10 === 0) console.log('[AutoFlow][DL] tile', idx, waitLbl, 'bekleniyor (' + genWait + ')');
        // v126.3: ÜRETİM BİTTİYSE ve GÖRSEL modundaysak 20 dk beklemenin anlamı yok —
        // görsel saniyeler içinde tamamlanır; hâlâ "üretiliyor" görünen kart bizim işimiz
        // değildir (hayalet kart / kullanıcının kendi üretimi) ve pipeline'ı açık tutarak
        // "Durdur" butonunu kırmızı, sayfayı %33 zoom'da bırakıyordu (rapor 2026-09-05).
        // VİDEO modunda ve üretim SÜRERKEN eski sabır AYNEN korunur (videolar dakikalar sürer).
        // v128 FANTOM KAÇIŞI (yalnız GÖRSEL modu): hedeften SONRA tamamlanmış tile varsa,
        // hedef gerçek bir üretim olamaz (görseller saniyeler içinde biter ve sırayla düşer)
        // → 30 tur (~90 sn) sonra atla. Böylece üretim SÜRERKEN indirme devam eder.
        let stuckMax = (!modeVideoNum && state.status !== 'running') ? 100 : 400;
        if (!modeVideoNum && !manual) {
          let laterComplete = false;
          for (let j2 = idx + 1; j2 < tiles.length; j2++)
            if (tiles[j2].state === 'complete' && !refLike(tiles[j2])) { laterComplete = true; break; }
          if (laterComplete) stuckMax = Math.min(stuckMax, 30);   // ~90 sn
        }
        const genMax = stuckMax;
        if (genWait > genMax) { // görsel+üretim bitti: ~5 dk | video / üretim sürüyor: ~20 dk
          console.warn('[AutoFlow][DL] tile', idx, 'çok uzun süredir üretiliyor → FANTOM sayılıp atlanıyor (numara TÜKETMEZ)');
          state.dlSkipKeys[key] = true; genWait = 0; await persist();   // v133: fantom → slot yemez
          continue;
        }
        dlPhase = 'hedef-uretiliyor';
        await sleep(3000);
        continue;
      }
      genWait = 0;

      // 4) ATLA durumları (failed / bilinmeyen) — SABIRLI DOĞRULAMA (phantom ayrımı).
      //    PHANTOM (video/görsel kısa süre 'başarısız' gösterip SONRA complete olur) ile GERÇEK
      //    hatayı ayırmanın tek güvenilir yolu BEKLEME: ~16sn boyunca yeniden tara → complete/
      //    generating'e dönerse phantom (failed SAYILMAZ → numara şişmez, tek video 0001 kalır);
      //    16sn boyunca 'başarısız' kalırsa GERÇEK hata → slot tüketir (ilk 2 gerçek hatalı → 3.=0003).
      //    (Eski maxVerify=1 ~1-2sn idi → video'nun geçici fazını gerçek hata sanıp sayıyordu.)
      if (tile.state !== 'complete') {
        // GÖRÜNMEZ-KUYRUK GUARD'ı (v106; kullanıcı raporu: video 3 "0004" numarasıyla indi):
        // Flow, KUYRUKTAKİ videoyu % göstergesi çıkana dek tile olarak GÖSTERMEYEBİLİYOR →
        // canlı tarama o tile'ı hiç görmez. O sırada daha YENİ bir prompt anında hata verirse
        // (politika reddi) pipeline başarısız tile'ı sıradan önce işleyip görünmeyen eski
        // videonun NUMARA SLOTUNU tüketir (2'den sonra 4'e atlama). Otomatik akışta beklenen
        // çıktı sayısını biliyoruz (başarıyla gönderilen prompt × adet); görünür referans-dışı
        // tile sayısı bundan AZKEN başarısız tile'ı KALICI SAYMA — görünmeyen tile ortaya
        // çıkıp kendi sırasını/numarasını alana kadar bekle. Sayı bilinmiyorsa (manuel /
        // eski proje galerisi kalabalıksa görünür ≥ beklenen olur) veya ~5 dk dolarsa eski
        // davranışa düşülür → hiçbir akış sonsuz beklemez.
        // v129: numara kesinse VEYA üretim bittiyse (görselde yeni tile gelmez) BEKLEME YOK.
        // Video modunda kuyruktaki iş geç tile üretebildiği için orada bekleme korunur.
        // v131: metin-numara devredeyse (txtNumOn) başarısız tile'ın slot tüketmesi
        // numarayı ETKİLEMEZ → beklemeye hiç gerek yok (bu bekleme "1'i indirdi, gerisi için
        // üretimin bitmesini bekledi" davranışının sebebiydi).
        if (!manual && !numCertain && !txtNumOn && (state.status === 'running' || modeVideoNum) &&
            Array.isArray(state.prompts) && state.prompts.length) {
          const cnt = Math.max(1, (state.genSettings && state.genSettings.count) || 1);
          let skippedN = 0; const sp = state.skippedPrompts || {};
          for (const kk in sp) if (sp[kk] && Number(kk) < state.currentIndex) skippedN++;
          const expOut = Math.max(0, Math.min(state.currentIndex, state.prompts.length) - skippedN) * cnt;
          const visNonRef = tiles.filter(t => t.state !== 'reference').length;
          if (expOut > 0 && visNonRef < expOut && ++holdSeen <= 100) {
            if (holdSeen % 10 === 1)
              console.log('[AutoFlow][DL] tile', idx, tile.state, '— görünür tile', visNonRef, '<', 'beklenen', expOut,
                          '→ başarısız sayımı bekletiliyor (görünmeyen kuyruk tile\'ı numara sırasını almalı,', holdSeen + '/100)');
            await sleep(3000);
            continue;
          }
        }
        const maxVerify = (tile.state === 'failed') ? 8 : 2; // failed: 8×2000=~16sn phantom doğrulama
        const verifyMs  = (tile.state === 'failed') ? 2000 : 1000;
        if (++skipSeen <= maxVerify) {
          if (skipSeen === 1)
            console.log('[AutoFlow][DL] tile', idx, 'durum:', tile.state, '→ doğrulanıyor (complete olabilir, ~16sn sabır)');
          dlPhase = 'durum-dogrulaniyor';
          await sleep(verifyMs);
          continue;
        }
        // v133: YALNIZ gerçek üretim hatası ('failed' kartı) numara slotu tüketir → o promptun
        // numarası BOŞ kalır. Durumu bilinmeyen/fantom tile slot TÜKETMEZ (numara kaymaz).
        const genuineFail = (tile.state === 'failed');
        const reason = genuineFail ? 'BAŞARISIZ (politika/içerik — kalıcı)' : tile.state + ' (fantom)';
        console.log('[AutoFlow][DL] tile', idx, 'kalıcı', reason, '→ atlanıyor |',
                    genuineFail ? ('slot ' + genIdx + ' tüketildi (numara boş kalır)') : 'numara TÜKETİLMEDİ');
        if (genuineFail) state.dlFailedKeys[key] = true; else state.dlSkipKeys[key] = true;
        trigFail = 0; skipSeen = 0; await persist();
        continue;
      }
      skipSeen = 0;

      // ── v126.9 SIRA GUARD'ı (GÖRSEL modu) ────────────────────────────────────
      // KULLANICI RAPORU: 3. görsel 2'den ÖNCE tamamlandı; 2'nin tile'ı henüz DOM'da
      // olmadığı için konum sayımı 3'ü "2." sandı → "0002" indi, 2. görsel sonra gelince
      // "0002 (1)" oldu. Kesin eşleme (mappedPi) varsa gerek yok. Yoksa:
      //   1) eksik çıktının tile'ı için ~30 sn beklenir (çoğu durumda bu yeter),
      //   2) hâlâ gelmediyse ve TÜM gönderimlerin üzerinden 30 sn geçmişse (yani eksik
      //      olan yeni gönderilmiş bir iş DEĞİL, eski/sıkışmış bir iş) eksik sayısı kadar
      //      slot REZERVE edilir → bu tile kendi numarasını alır, eksiğin numarası boş kalır
      //      ve geç gelen çıktı sonra o boş numarayla iner.
      // Akış asla kilitlenmez: bekleme 10 turla (~30 sn) sınırlı.
      if (!sawPending && !manual && !modeVideoNum && !numCertain && !txtNumOn &&
          state.status === 'running' && Array.isArray(state.prompts) && state.prompts.length) {
        const cntI = Math.max(1, (state.genSettings && state.genSettings.count) || 1);
        let skI = 0; const spI = state.skippedPrompts || {};
        for (const kk in spI) if (spI[kk] && Number(kk) < state.currentIndex) skI++;
        const expI = Math.max(0, Math.min(state.currentIndex, state.prompts.length) - skI) * cntI;
        const visI = tiles.filter(t => !refLike(t)).length;
        const defI = expI - visI;                       // henüz çizilmemiş çıktı sayısı
        // v142: eksikler SONA eklenir → hedef kuyruğa yakın DEĞİLSE numarası kesindir.
        // (+1 emniyet payı.) Böylece üretim sürerken baştaki tile'lar inmeye devam eder.
        const tailRisk = (genIdxPos >= visI - defI - 1);
        if (expI > 0 && defI > 0 && tailRisk) {
          dlPhase = 'sira-guard';
          if (++orderHold <= 10) {                    // 10 × 3 sn ≈ 30 sn
            if (orderHold === 1)
              console.log('[AutoFlow][DL] sıra guard: görünür', visI, '< beklenen', expI,
                          '→ eksik çıktının tile\'ı bekleniyor (numara kaymasın)');
            await sleep(3000);
            continue;
          }
          // Bekleme doldu → eksik ESKİ bir işe mi ait? Son gönderimin üzerinden de 30 sn
          // geçtiyse "henüz çizilmedi" ihtimali kalmaz; eksik ancak eski/sıkışmış iştir.
          let lastSent = 0;
          for (const kk in (state.promptSentAt || {})) {
            const v = state.promptSentAt[kk];
            if (typeof v === 'number' && v > lastSent) lastSent = v;
          }
          const allOld = lastSent > 0 && (Date.now() - lastSent > 30000);
          const defNow = expI - visI;
          if (allOld && defNow > 0 && posDeficit !== defNow) {
            posDeficit = defNow;
            console.warn('[AutoFlow][DL] sıra guard: eksik', defNow, 'çıktı 30 sn içinde gelmedi →',
                         defNow, 'slot REZERVE edildi (numara kayması önlendi)');
            logEvent('info', 'Eksik çıktı gelmedi (görünür:' + visI + ' beklenen:' + expI + ') → ' +
                     defNow + ' numara boş bırakıldı, sıradaki kendi numarasını aldı');
          }
        } else { orderHold = 0; posDeficit = 0; }
      }

      // GÖRÜNMEZ-KUYRUK GUARD'ı — VİDEO KONUM NUMARASI İÇİN (v107): konum sayımı, daha eski
      // bir tile henüz DOM'a düşmemişse (kuyrukta, % göstergesi yok) EKSİK kalır → bu video
      // yanlış (küçük) numara alırdı. Otomatik akışta beklenen çıktı sayısını biliyoruz
      // (başarıyla gönderilen prompt × adet); görünür referans-dışı tile bundan AZKEN indirme
      // BEKLETİLİR (cap ~5 dk → sonra eski davranış, akış asla sonsuz beklemez). Manuelde
      // üretim bitmiştir → guard yok.
      if (modeVideoNum && !manual && !numCertain && Array.isArray(state.prompts) && state.prompts.length) { // v114/v129: numara kesinse bekletme gereksiz
        const cnt2 = Math.max(1, (state.genSettings && state.genSettings.count) || 1);
        let skippedN2 = 0; const sp2 = state.skippedPrompts || {};
        for (const kk in sp2) if (sp2[kk] && Number(kk) < state.currentIndex) skippedN2++;
        const expOut2 = Math.max(0, Math.min(state.currentIndex, state.prompts.length) - skippedN2) * cnt2;
        // v109: aynı medyanın kopyası (önizleme/panel) sayımı şişirip guard'ı erken bırakmasın →
        // kimlik-tekilleştirilmiş sayım (kimliksiz tile'lar tek tek sayılır, eski davranış).
        const seenVis = new Set();
        let visNonRef2 = 0;
        for (const t of tiles) {
          if (refLike(t)) continue;
          const sv = t.key ? stableId(t.key) : '';
          if (sv) { if (seenVis.has(sv)) continue; seenVis.add(sv); }
          visNonRef2++;
        }
        // v111: İLERLEME-DUYARLI SABIR (kullanıcı raporu + ekran görüntüsü: "Ses üretilemedi"
        // hatası üretim DAKİKALARCA sürdükten sonra çıkıyor; o pencerede başarısız işin ekranda
        // HİÇ tile'ı yok → 8. video 6'nın hemen ardı sanılıp 0007 alıyordu). Eski guard hedef
        // başına TOPLAM ~5 dk sayıyordu; açık eksik sürerken bile tükenip yanlış numarayla devam
        // ediyordu. Artık sayaç yalnız HİÇBİR ŞEY DEĞİŞMEZKEN işler: beklenen/görünen sayısı
        // değiştikçe (yeni prompt gönderildi, yeni tile/% çıktı, hata kartı düştü) sabır TAZELENİR.
        // Böylece bekleyiş, başarısız işin hata kartı DOM'a düşene dek sürer → kart düşünce ya
        // eksik kapanır (deficit=0) ya da kart v109 zincirinde hayalet/boşluk olarak sayılır →
        // 8. video 0008 alır. Gerçek takılmada (hiçbir değişim yok) ~5 dk sonra eski davranış.
        // v173: sonuçlanmış kayıtlar da sayılır (cardNow = inen + başarısız + görünen sonuçlanmamış
        // kart; inmiş kart sayfadan düşse de eksilmez).
        const haveCards2 = Math.max(visNonRef2, cardNow);
        const holdSig2 = expOut2 + ':' + haveCards2;
        if (holdSig2 !== holdSig) { holdSig = holdSig2; holdSeen = 0; }
        // v126.7 ZİNCİR KONTROLÜ: konum sayısı sıralı sayaçla aynıysa hedefin ÖNÜNDE eksik
        // tile yoktur → numara kesin, BEKLEME YOK. (Eski koşul kuyruklu modellerde tüm koşu
        // boyunca doluydu → üretim bitene kadar hiç indirme yapılmıyordu.)
        // v173: YUKARIDAKİ KISAYOL KALDIRILDI. KANIT (kullanıcı logu 2026-09-15): 9 video
        // gönderilmişti, sayılan kart 2'ydi, henüz hiçbir şey inmemişti → konum 0 === sayaç 0
        // "önünde eksik yok" sayıldı ve önündeki 7 kart görünmezken 8. video 0001 aldı. Eşitlik
        // yalnız GÖRÜNEN kartların sonuçlandığını söyler, görünmeyen ESKİ kart hakkında hiçbir şey
        // söylemez. Kısayolun korumak istediği durumdaki kartlar (kuyruktaki iş) Flow v2'de
        // sinyalsiz kart olarak çiziliyor ve artık 'pending' sayılıyor → eksik yalnız gerçekten
        // görünmeyen kart varken oluşur. Eksik ~5 dk hiç değişmeden kapanmazsa (kartı hiç
        // oluşmayan prompt) KABUL edilir; sonraki videolar yeniden beklemez, eksik büyürse bekler.
        const chainOk = (genIdxPos === genIdx);   // yalnız konsol teşhisi
        const deficit2 = expOut2 - haveCards2;
        if (cardDefAccepted > Math.max(0, deficit2)) cardDefAccepted = Math.max(0, deficit2);
        // Kısa eksik BEKLETMEZ: yeni gönderilen promptun kartı ~3 sn sonra çiziliyor, biten videonun
        // kartı bir iki saniye görünmeyebiliyor; bunları v172 korumaları (konum hafızası + 8 sn
        // olgunlaşma) karşılıyor, burada beklemek yalnız yavaşlatıyordu (sim: video başı +25-60 sn).
        // Eksik 6 sn'den uzun sürüyorsa kart gerçekten görünmüyordur → bekle. Olgunlaşma yeni biten
        // videoyu ilk görüldüğü andan 8 sn tuttuğu için arada korumasız bir an kalmaz.
        const holdNeed2 = expOut2 > 0 && deficit2 > cardDefAccepted && deficitSince > 0 && (Date.now() - deficitSince >= 6000);
        if (holdNeed2) dlPhase = 'kuyruk-guard';
        if (holdNeed2 && ++holdSeen <= 100) {
          if (holdSeen % 10 === 1) {
            console.log('[AutoFlow][DL] görünür tile', visNonRef2, '< beklenen', expOut2,
                        '| konum', genIdxPos, '≠ sıra', genIdx,
                        '→ numara güvenliği için indirme bekletiliyor (sabit ' + holdSeen + '/100)');
            // v126.7: aynı bilgi Logs panelinde de görünsün (SW konsolu kullanıcıya kapalı)
            if (Date.now() - lastWaitLog > 60000) {
              lastWaitLog = Date.now();
              logEvent('info', 'İndirme bekliyor (numara güvenliği) — görünür:' + haveCards2 +
                ' beklenen:' + expOut2 + ' konum:' + genIdxPos + ' sıra:' + genIdx);
            }
          }
          await sleep(3000);
          continue;
        }
        if (holdNeed2) {
          cardDefAccepted = deficit2;
          console.warn('[AutoFlow][DL] kuyruk sabrı doldu → konum', genIdxPos, 'sıra', genIdx, 'ile devam', '| chainOk:', chainOk);
          logEvent('info', 'Kart eksiği ~5 dk kapanmadı (kart:' + haveCards2 + ' beklenen:' + expOut2 +
            ') → mevcut sayımla devam ediliyor');
        }
      }

      // ── v172 KAYBOLAN KART KORUMASI (yalnız OTO VİDEO, numara kesin değilken) ────────
      // Kaybolan kart hedefin ÖNÜNDEYSE numarayı kaydırır; iki durum ayrı ayrı kapanır.
      // Sayıyı yeni beliren kartlarla karşılaştırmak yetmez: yeni gönderilen promptun kartı
      // aynı tarama aralığında belirirse kaybolanı maskeler (ölçüldü). Bu yüzden:
      //  (1) KONUM HAFIZASI: hedef, önünde N kartla görüldüyse ve şimdi daha azı varsa önündeki
      //      bir kart kayboldu → bekle. Yeni kartlar hep hedefin ARKASINA eklenir, bu sinyali
      //      maskeleyemez. Kart gerçekten gittiyse (kullanıcı sildi) ~24 sn sonra kabul edilir.
      //  (2) OLGUNLAŞMA: gönderilen her promptun kartı ekranda DEĞİLSE (beklenen sayı
      //      gönderimden gelir, gözlemden değil) yeni tamamlanan video 8 sn bekletilir. Hedef
      //      tamamlandığında önündeki kart zaten görünmüyorsa (1) onu hiç göremez; kaybolma
      //      yalnız birkaç saniye sürdüğü için o kart bu sürede tamamlanıp geri gelir, en eski
      //      tamamlanan olarak hedef olur ve sıra kendiliğinden düzelir.
      //      Tüm kartlar görünüyorsa gecikme YOK (koşu sonu ve sıradan akış hızını korur).
      if (modeVideoNum && !manual && !numCertain && cardNow >= 0) {
        const sidT = stableId(tile.key || '');
        const posMax = posSeenMax.has(sidT) ? posSeenMax.get(sidT) : -1;
        const ordT = ordNow.has(sidT) ? ordNow.get(sidT) : -1;
        if (sidT && ordT >= 0 && ordT < posMax) {
          if (++posDropHold <= 8) {
            dlPhase = 'kart-kayboldu-guard';
            if (posDropHold === 1)
              logEvent('info', 'Hedefin önündeki bir kart görünmez oldu (önünde:' + ordT + ' önceki:' + posMax +
                ') → numara kaymasın diye bekleniyor');
            await sleep(3000);
            continue;
          }
          logEvent('info', 'Kart geri gelmedi (~24 sn) → mevcut sayımla devam (önünde:' + ordT + ' önceki:' + posMax + ')');
          // Kart gerçekten gittiyse arkasındaki TÜM kartların ölçüsü de aynı miktar düştü →
          // hafızaları da düşürülür, yoksa sıradaki her video için 24 sn yeniden beklenirdi.
          const dropN = posMax - ordT;
          for (const [k2, v2] of posSeenMax) if (v2 >= posMax) posSeenMax.set(k2, v2 - dropN);
        }
        posDropHold = 0;
        const cntF = Math.max(1, (state.genSettings && state.genSettings.count) || 1);
        let skF = 0; const spF = state.skippedPrompts || {};
        for (const kk in spF) if (spF[kk] && Number(kk) < state.currentIndex) skF++;
        const expCards = Math.max(0, Math.min(state.currentIndex || 0, (state.prompts || []).length) - skF) * cntF;
        const firstAt = sidT ? cardSeenAt.get(sidT) : undefined;
        if (cardNow < expCards && firstAt && Date.now() - firstAt < 8000) {
          dlPhase = 'olgunlasma-bekleniyor';
          if (!freshLogged) {
            freshLogged = true;
            logEvent('info', 'Bazı kartlar ekranda değil (kart:' + cardNow + ' beklenen:' + expCards +
              ') → yeni biten videolar birkaç saniye bekletilip sıra doğrulanıyor');
          }
          await sleep(2000);
          continue;
        }
      }

      // ── SLOT-ZİNCİRİ NUMARASI + HAYALET BEKLETME (v109; AUTO VİDEO) ─────────────
      // KULLANICI RAPORU (LevelDB kanıtlı): oto video akışında dlNumMap 0,2,3,4 çıktı — slot 1
      // (0002) HİÇ atanmadı, dlFailedKeys BOŞ. Yani indirme anında hedefin ÖNÜNDE geçici bir
      // "hayalet" tile (erken/yanlış konumlu başarısız tile, kimliksiz yer tutucu, önizleme
      // kopyası...) canlı konum sayımını +1 şişirdi; koşu sonunda yerleşim oturunca son video
      // doğru slotu aldı. ÇÖZÜM: numara artık ham konumdan değil ZİNCİRDEN gelir —
      //   slot(X) = slot(çapa P: X'ten eski, dlNumMap'te kayıtlı EN YAKIN complete)
      //             + 1 + (P-X arası kayıtsız complete'ler)  [sırasız tamamlanma: gerçek çıktılar]
      //             + (P-X arası kararlı hayaletler)          [gerçek başarısız → boşluk korunur]
      // P-X arasında hayalet varken bölge imzası ~6 taramada sabitlenene dek indirme BEKLETİLİR
      // (gerçek hata ~18-20 sn'de kesinleşip slotunu alır; geçici hayalet kaybolur/kayar →
      // imza değişir → sayaç sıfırlanır → temiz sayımla devam). Cap ~3 dk: hiçbir akış sonsuz
      // beklemez, cap dolarsa mevcut sayımla (eski davranış) devam. Çapa yoksa (ilk video)
      // genIdxPos (kimlik-tekilleştirilmiş) kullanılır. Kayıtlı numara (dlNumMap) her durumda
      // en son söz sahibidir (retry aynı numarayı alır).
      // v110: GÖNDERİLEMEYİP ATLANAN prompt (skippedPrompts: yapıştırma/gönderme başarısız)
      // numara slotunu YİNE tüketir — kullanıcı kuralı: çıktısı olmayan HER prompt boşluk
      // bırakır (dosya no = prompt sırası). nextSlot: s'den sonraki UYGUN slota ilerler
      // (atlanan promptun TÜM slotları üstünden atlanır); advSlots: steps kez ilerletir.
      // dlSequential (farklı proje) → düz sıralı, atlama uygulanmaz.
      const cntSlots = state.dlSequential ? 1 : Math.max(1, (state.genSettings && state.genSettings.count) || 1);
      const nextSlot = (s) => {
        let n = s + 1;
        while (!state.dlSequential && state.skippedPrompts && state.skippedPrompts[Math.floor(n / cntSlots)])
          n = (Math.floor(n / cntSlots) + 1) * cntSlots;
        return n;
      };
      const advSlots = (from, steps) => { let s = from; for (let i = 0; i < steps; i++) s = nextSlot(s); return s; };
      let vidSlotIdx = -1;
      let ghostsSeen = -1;   // v154 TESHIS: zincirde capa ile hedef arasindaki kararsiz tile sayisi
      if (modeVideoNum && !manual && !numCertain && idx >= 0) { // v114/v129: numara kesinse zincir/hayalet-bekletme devre dışı
        const sidX = stableId(tile.key || '');
        let pj = -1, pSlot = -1;
        for (let j = idx - 1; j >= 0; j--) {
          const tj = tiles[j];
          if (refLike(tj) || tj.state !== 'complete') continue;
          const sj = stableId(tj.key || '');
          if (sj && sj !== sidX && Object.prototype.hasOwnProperty.call(state.dlNumMap || {}, sj)) {
            pj = j; pSlot = state.dlNumMap[sj]; break;
          }
        }
        if (pj >= 0) {
          const seenMid = new Set(sidX ? [sidX] : []);
          let midComplete = 0; const ghosts = [];
          for (let j = pj + 1; j < idx; j++) {
            const tj = tiles[j];
            if (refLike(tj)) continue;
            if (tj.state === 'complete') {
              const sj = stableId(tj.key || '');
              if (sj) { if (seenMid.has(sj)) continue; seenMid.add(sj); }
              midComplete++;
            } else {
              ghosts.push(tj.state + '|' + (tj.key || ('@' + tj.top + ',' + tj.left)));
            }
          }
          ghostsSeen = ghosts.length;   // v154 TESHIS
          const sig = pSlot + '#' + midComplete + '#' + ghosts.join(';');
          if (sig !== ghostSig) { ghostSig = sig; ghostStable = 0; } else ghostStable++;
          // ~10 tarama (30sn) aynı imza → gerçek boşluk kabul et; geçici hayalet bu sürede
          // kaybolur/yer değiştirir (imza değişir → sayaç sıfırlanır → temiz sayım).
          if (ghosts.length && ghostStable < 10) dlPhase = 'hayalet-guard';
          if (ghosts.length && ghostStable < 10 && ++ghostHold <= 60) {
            if (ghostHold % 8 === 1)
              console.log('[AutoFlow][DL] numara güvenliği: çapa(slot ' + pSlot + ') ile hedef arasında',
                          ghosts.length, 'kararsız tile → sabitlenmesi bekleniyor (' + ghostHold + '/60)');
            await sleep(3000);
            continue;
          }
          // v110: ilerletme advSlots ile — çapa ile hedef arasındaki her gerçek çıktı/boşluk
          // bir slot; atlanan (gönderilemeyen) promptların slotları da otomatik atlanır.
          vidSlotIdx = advSlots(pSlot, 1 + midComplete + ghosts.length);
        }
      }

      // 5) TAMAMLANDI → indir
      // Video tespiti DOM'a güvenilmez: Flow üretilen videoyu çoğu zaman <video>
      // değil <img> poster olarak gösterir → tile.isVideo yanlış 'false' olur ve
      // kalite anahtarı imgToken ('1k') seçilip video menüsündeki '720p' ile
      // EŞLEŞMEZ. Bu yüzden akışın MODU varsa onu KESİN kaynak kabul ederiz.
      // state.videoOnly da video kabul edilir: "Sonradan indir" Foto→Video sekmesinden
      // basıldığında genSettings.mode VIDEO olmayabilir (üretim bu oturumda yapılmadıysa) →
      // videoOnly bayrağı tek başına video kalite menüsünü (720p) garanti eder.
      const modeVideo = (state.genSettings && state.genSettings.mode === 'VIDEO') || !!state.videoOnly;
      const isVideo = modeVideo || !!tile.isVideo;
      const token   = isVideo ? vidToken(state.dlQualityVid) : imgToken(state.dlQualityImg);
      // v143: DOĞRUDAN indirme (1K görsel) sayfada yalnız bir scrollIntoView yapar; ⋮ menü,
      // kalite seçimi, kaydırma yoktur. Menü yolunun 45 sn'lik açlık eşiğini beklemesi
      // gereksiz ve hibrit indirmeyi geciktiriyordu → doğrudan yolda eşik 6 sn.
      const isDirectDl = !!(token === "1k" && !isVideo && tile.key && /^https?:\/\//.test(tile.key));

      // MANUEL "Sonradan indir" → ÖNCELİKLİ (kullanıcı bastı, üretim zaten bitti; öncelik
      // beklemesine takılmasın). OTO indirme → öncelik-dışı (üretime yol verir).
      // v126.6 AÇLIK GUARD'I: oto indirme UI kilidini ÖNCELİK-DIŞI ister (üretime yol verir).
      // Ama üretim yoğunken (kare seçimi + prompt yazma + gönderme art arda) kilit uzun süre
      // hiç boşalmayabiliyor → "üretim tamamen bitmeden hiç indirmiyor" (kullanıcı raporu
      // 2026-09-05). 45 sn boyunca kilit alınamazsa BİR KEZ öncelikli sıraya girilir: indirme
      // yalnızca birkaç saniyelik DOM etkileşimi yapar (⋮ menü + kalite seçimi), üretim en
      // fazla o kadar bekler. Manuel indirme zaten öncelikli.
      let uiPrio = manual;
      let got = await acquireUi(8000, manual);
      if (got) uiStarveSince = 0;
      else if (!manual) {
        if (!uiStarveSince) uiStarveSince = Date.now();
        if (Date.now() - uiStarveSince > (isDirectDl ? 6000 : 45000)) {
          got = await acquireUi(30000, true);
          if (got) {
            uiPrio = true; uiStarveSince = 0;
            console.log('[AutoFlow][DL] açlık guard: kilit ÖNCELİKLİ alındı (üretim yoğun)');
            if (!starveLogged) {
              starveLogged = true;
              logEvent('info', 'Üretim yoğun olduğu için indirme sıraya öncelikli girdi — eş zamanlı indirme sürüyor');
            }
          }
        }
      }
      if (!got) { dlPhase = 'ui-kilidi-bekleniyor'; await sleep(1000); continue; }
      if (dlCancel) { releaseUi(uiPrio); console.log('[AutoFlow][DL] iptal (tetik öncesi)'); break; }

      const folder = state.dlFolder || makeDownloadFolder();
      // PROMPT-BAZLI numara: dosya no = kaçıncı PROMPT, harf = o promptun kaçıncı çıktısı.
      // genIdx = inen + GERÇEK başarısız (done+failed) → başarısız KENDİ slotunu tüketir (boşluk,
      // kaymaz: 0001 sonrası 0001b hatalı→0002). 1 adet:0001,0002…; 2 adet:0001,0001b,0002,0002b…
      const dlCount  = state.dlSequential ? 1 : Math.max(1, (state.genSettings && state.genSettings.count) || 1);
      // NUMARA KAYNAĞI:
      //  • 1K GÖRSEL + AUTO (direct, MENÜSÜZ → reorder YOK) → KONUM-BAZLI (genIdxPos): canlı
      //    taramadaki konum. Phantom 'başarısız' fazının dlFailedKeys kalıntısı numarayı
      //    ŞİŞİREMEZ (her tile=1 konum) → 100 prompt = tam 0001..0100, atlama/şişme YOK.
      //  • VİDEO / 2K / 4K / MANUEL (menü → reorder VAR, ya da galeri kaydırılır) → SAYAÇ-BAZLI
      //    (genIdx=done+failed): reorder/scroll'a dayanıklı; gerçek hata slot tüketir (gap).
      // directImg: gerçekten DIRECT inen (menüsüz → reorder YOK) 1K görsel. directUrl koşuluyla
      // BİREBİR (token 1k + görsel + http key) → blob-key'li 1K menüye düşerse (reorder) konum
      // KULLANILMAZ, sayaç kalır. Böylece konum-bazlı YALNIZ reorder olmayan durumda devrede.
      const directImg = (token === '1k' && !isVideo && !manual && tile.key && /^https?:\/\//.test(tile.key));
      // ── v145 KÖK DÜZELTME: OTO GÖRSEL AKIŞINDA NUMARA HER KALİTEDE KONUMDAN ────────
      // Sayaç (genIdx = inen + başarısız) = TAMAMLANMA SIRASI. v142/v143'te oto akış
      // "hibrit" indirmeye geçti: pipeline artık en eski tile'ı BEKLEMİYOR, tamamlanan
      // ilk tile'ı indiriyor. Flow işleri kuyruğa aldığı için tamamlanma sırası gönderim
      // sırasından FARKLI → sayaç yolunda geç gönderilip erken biten prompt küçük numara
      // alıyordu (kullanıcı logu: 5. prompt "0002"). Bu yol yalnız 2K/4K'da devredeydi
      // (1K doğrudan indirme zaten v84'ten beri konum-bazlı ve doğru çalışıyor) — kalite
      // seçimi numarayı belirlememeli. Konum sayımı referansları dışlar, kimlik
      // tekilleştirir ve gerçek hata kartı KENDİ slotunu tüketir (boşluk kalır, kaymaz).
      // MANUEL "Sonradan indir" DOKUNULMADI: orada üretim bitmiştir, galeri kaydırılır ve
      // dlNumMap/kayıt yolu esastır → eski davranış aynen korunur.
      const autoImgPos = directImg || (!isVideo && !manual);
      // v107: VİDEO modu da KONUM-BAZLI — sayaç (genIdx=done+failed) referans tile'larının
      // geçici 'başarısız' fazlarıyla şişip numarayı kaydırıyordu ("5. video 0008"); konum
      // sayımı refLike'ı dışlar, başarısız tile konum tüketir (boşluk kalır, kaymaz) ve
      // sırasız (oluştukça) indirmede de her video KENDİ numarasını alır.
      let numSrc = (autoImgPos || modeVideoNum) ? 'konum' : 'sayaç';   // v131: numara nereden geldi
      let useIdx = (autoImgPos || modeVideoNum) ? genIdxPos : genIdx;
      // v126.9: sıra guard'ı eksik ESKİ çıktı tespit ettiyse onun slotunu ATLA (boş bıraksın)
      if (autoImgPos && posDeficit > 0) useIdx = genIdxPos + posDeficit;
      // SHARED/MAP REFERANS — SADECE sayaç-bazlı yolda (2K/4K/video/manuel) VE referans VARSA:
      // referans tile'ı feed'de picker'dan FARKLI kimlik taşıdığından (nearRefLabel/refIds
      // kaçırabiliyor) kısa süre 'başarısız' sayılıp dlFailedKeys'e girip İLK numarayı itiyordu
      // (shared ref → ilk görsel 0002, 0001 boşluk). LEADING-BASELINE: ilk indirmeden önceki failed
      // sayısını BİR KEZ sabitle → o leading phantom'lar (referans) numarayı itmez → ilk inen 0001;
      // sonraki GERÇEK hatalar yine sayılır (mid-stream gap korunur). REFERANS YOKSA baseline YOK →
      // gerçek leading hatalar sayılır (kullanıcının "ilk 2 gerçek hatalı→3.=0003" isteği korunur).
      if (!autoImgPos && !modeVideoNum && state.refImages && state.refImages.length > 0) { // v107: video konum-bazlı → baseline gereksiz
        if (state.dlBaseline == null && Object.keys(state.dlDoneKeys).length === 0)
          state.dlBaseline = Object.keys(state.dlFailedKeys).length;
        useIdx = Math.max(0, genIdx - (state.dlBaseline || 0));
      }
      // v110: AUTO'da ham sıra numarası (kaçıncı çıktı) → slot'a çevrilir; gönderilemeyip
      // atlanan promptların (skippedPrompts) slotları boşluk olarak korunur (atlama yoksa
      // advSlots birebir aynı değeri döndürür — davranış değişmez).
      if (!manual) useIdx = advSlots(-1, useIdx + 1);
      // v109: AUTO video yolunda zincir hesabı (çapa+ara sayım) ham konum sayımını EZER
      // (advSlots zincir içinde zaten uygulandı — mutlak slot döner).
      // ── v155 KÖK DÜZELTME: ZİNCİR ARTIK KONUMU AŞAĞI ÇEKEMEZ ────────────────────
      // KANIT (kullanıcı logu 2026-09-08, 49 prompt / 42 inen / 7 üretilemeyen):
      // her satırda numara = zincir+1 çıktı ve son dosya 0043 oldu; yani 49. promptun
      // videosu 0043 numarasını aldı, üretilemeyen 7 promptun 6'sının boşluğu kapandı.
      // Aynı satırlarda konum (genIdxPos) hatalarda tam olarak sıçrıyordu (21→23, 24→26,
      // 37→39) ve max(konum, zincir) ile numaralar 0015..0049 arasında TAM 7 boşlukla
      // diziliyor (aritmetik doğrulama: scratchpad/analiz-log.js).
      // SEBEP YAPISAL: zincir GÖRECELİ çalışır (bir önceki numaralı karta çapalanıp +1
      // ilerler), bu yüzden ÇAPANIN GERİSİNDE ortaya çıkan bir hata kartını asla göremez
      // (logda hep hayalet:0). Konum ise SIFIRDAN mutlak sayar → geriden gelen hatayı da
      // sayar. Bu yüzden zincir artık numarayı YUKARI itebilir (sanallaşan galeride konum
      // eksik sayarsa koruma devam eder) ama AŞAĞI çekemez.
      // Etki alanı: yalnız OTO VİDEO yolu (vidSlotIdx zaten yalnız orada hesaplanıyor;
      // görsel akışı, manuel indirme ve numara kesin olan durumlar bu satıra hiç girmez).
      if (vidSlotIdx >= 0) {
        const posSlot = useIdx;   // konum-bazlı mutlak slot (bu noktada advSlots uygulanmış)
        // MENZİL EMNİYETİ: konum, prompt sayısının ötesine taşarsa (elle üretim/çift render)
        // kullanılmaz → eski zincir değeri kalır, davranış eskisi gibi olur.
        const maxSlotPos = (Array.isArray(state.prompts) && state.prompts.length)
          ? (state.prompts.length * dlCount - 1) : Infinity;
        if (posSlot > vidSlotIdx && posSlot <= maxSlotPos) { useIdx = posSlot; numSrc = 'konum>zincir'; }
        else { useIdx = vidSlotIdx; numSrc = 'zincir'; }
      }
      // ── v114 KESİN NUMARA (nihai çözüm) ────────────────────────────────────────
      // Üretim API yanıtından bağlanan prompt indeksi varsa numara DOĞRUDAN oradan:
      // slot = promptIdx*adet + o prompta verilmiş çıktı sayısı. DOM sayımı, hata kartı
      // tespiti, görünmez kuyruk: hiçbiri numarayı etkileyemez. Üretilemeyen prompt hiç
      // medya üretmediğinden numarası yapısal olarak boş kalır (6'dan sonra 7-8 hatalıysa
      // 9. video 0009). Kayıtlı numara (dlNumMap, aşağıda) yine en son söz sahibi (retry).
      // v128 TEŞHİS: tile'ın etiket metni okunabiliyor mu? ((BOŞ) ise seçici tutmamış demektir)
      if (!txtSampleLogged) {
        txtSampleLogged = true;
        const dbgAny = (tiles.find(t => t.dbg) || {}).dbg || '';
        const _gd = (tiles.find(t => t.gdbg) || {}).gdbg || '';
        logEvent('diag', 'KART SAYIMI — tile:' + tiles.length +
          ' tamam:' + tiles.filter(t => t.state === 'complete').length +
          ' üretiliyor:' + tiles.filter(t => t.state === 'generating').length +
          ' başarısız:' + tiles.filter(t => t.state === 'failed').length +
          ' referans:' + tiles.filter(t => t.state === 'reference').length +
          (tiles.some(t => t.state === 'pending') ? ' sinyalsiz:' + tiles.filter(t => t.state === 'pending').length : '') +
          ' | gönderilen prompt:' + (state.currentIndex || 0) +
          ' || medyasız kapsayıcı: ' + String(_gd).slice(0, 220));
        const _tx = String(tile.txt || '');
        logEvent('diag', 'TILE METNİ örneği: "' + (_tx || '(BOŞ)').slice(0, 60) + '"' +
          ' || uzunluk:' + _tx.length + (/[…]|\.{3}$/.test(_tx) ? ' KIRPIK(…)' : ' TAM') +
          ' | prompt ort. uzunluk:' + (Array.isArray(state.prompts) && state.prompts.length
            ? Math.round(state.prompts.reduce((a, b) => a + String(b).length, 0) / state.prompts.length) : 0) +
          (dbgAny ? ' || YAPI: ' + String(dbgAny).slice(0, 300) : ''));
      }
      // ── v132 NUMARA KAYNAK SIRASI: 1) TILE METNİ  2) ağ eşlemesi  3) konum/sayaç ──
      // Tile'ın etiket metni = üretim prompt'u. DOM'da GÖRÜNEN kanıt olduğu için ağ
      // eşlemesinden (zaman damgası TAHMİNİ) ÖNCE gelir. Metin tutarsa konum sayımı,
      // fantom tile, sıra dışı tamamlanma numarayı KAYDIRAMAZ ve üretilemeyen prompt'un
      // numarası yapısal olarak BOŞ kalır.
      let txtHit = false;
      // v154 TESHIS: metin katmaninin ne kadar KANIT tasidigi (aday sayisi) loga yazilir.
      // 49 promptun metni AYNIYSA aday sayisi 49 olur ve metin hicbir sey kanitlamaz;
      // karar aslinda konumdan gelir. Eskiden log yine 'metin(prompt#N)' yaziyordu ve
      // yaniltiyordu.
      let txtAllN = -1, txtFreeN = -1, txtAmb = false, tsHit = false;   // v168: tsHit = karari damga verdi
      if (TXT_NUM_ENABLED && !state.dlSequential && tile.txt) {
        // ── v145: ADAYLARI BUL → KOTA ELE → BELİRSİZLİĞİ KONUMLA ÇÖZ ───────────────
        // Karar sırası: (1) etikete uyan promptlar, (2) bu koşuda kotası dolanlar elenir,
        // (3) tek aday kaldıysa numara ONDAN, (4) birden çok aday varsa konumun işaret
        // ettiği aday varsa O seçilir, (5) hiçbiri değilse metin kullanılmaz (eski yol).
        let all = promptCandidatesByText(tile.txt, state.prompts);
        // ── v168 DAMGA KATMANI ────────────────────────────────────────────────────
        // Etikette zaman damgasi GORUNUYORSA (damga Flow'a gonderilmis kosullar) o damga
        // promptu tek basina tanimlar. Iki durumda devreye girer:
        //   • metin hic aday bulamadi  -> damganin tek adayi numarayi verir,
        //   • metin BIRDEN COK aday buldu (ayni kalipla baslayan promptlar) -> adaylar
        //     damgayla kesistirilir ve belirsizlik cogu zaman teke iner.
        // Damga yoksa promptCandidatesByTs bos doner ve hicbir sey degismez.
        const byTs = promptCandidatesByTs(tile.txt, state.prompts);
        if (byTs.length === 1 && all.length !== 1) { all = byTs; tsHit = true; }
        else if (byTs.length && all.length > 1) {
          const inter = all.filter(i => byTs.indexOf(i) >= 0);
          if (inter.length) { all = inter; tsHit = true; }
        }
        txtAllN = all.length;   // v154 TESHIS
        const cands = all.filter(i => i < sentMax);          // v146: gönderilmemiş prompt elenir
        if (all.length && !cands.length)
          logEvent('info', 'Metin eşleşmesi reddedildi: prompt#' + (all[0] + 1) + ' henüz gönderilmedi ' +
            '(gönderilen:' + state.currentIndex + ') → numara konumdan veriliyor');
        // ── v140 TEKRAR KORUMASI (kullanıcı logu 2026-09-06) ───────────────────────
        // Bir prompt en fazla dlCount çıktı üretir. Aynı prompt indeksi bundan FAZLA kez
        // iddia edilirse eşleşme yapısal olarak YANLIŞTIR. Kanıt: 20 promptluk koşuda
        // aynı prompt (#10) DÖRT kez iddia edildi; çakışma koruması her seferinde bir
        // sonraki boş slotu verdi ve 0011/0012/0013 gibi hiçbir prompta ait olmayan
        // numaralar üretildi. Böyle bir iddia REDDEDİLİR → numara konumdan gelir.
        const free = cands.filter(i => i === priorPi || (usedPiCount.get(i) || 0) < dlCount);
        txtFreeN = free.length;   // v154 TESHIS
        let tpi = -1;
        if (priorPi >= 0) tpi = priorPi;                 // v145: aynı tile'ın yeniden denemesi
        else if (free.length === 1) tpi = free[0];
        else if (free.length > 1) {
          // Belirsiz etiket (Flow başlığı ~33 karakterde kırpılmış / aynı ön ekli veya
          // tekrarlı promptlar). TAHMİN YOK: konumun işaret ettiği prompt adaylar
          // arasındaysa onu al; değilse metni hiç kullanma.
          const posPi = Math.floor(useIdx / dlCount);
          if (mappedPi >= 0 && free.indexOf(mappedPi) >= 0) tpi = mappedPi;  // ağ eşlemesi adaylardan biriyse
          else if (free.indexOf(posPi) >= 0) { tpi = posPi; txtAmb = true; } // v154: karar KONUMDAN
          else logEvent('info', 'Metin belirsiz (' + free.length + ' prompt aynı başlığa uyuyor) → ' +
            'numara konumdan veriliyor | metin:"' + String(tile.txt).slice(0, 34) + '"');
        } else if (cands.length) {
          logEvent('info', 'Metin eşleşmesi reddedildi: prompt#' + (cands[0] + 1) + ' zaten ' +
            dlCount + ' çıktı aldı → numara konumdan veriliyor | metin:"' +
            String(tile.txt).slice(0, 34) + '"');
        }
        if (tpi >= 0) {
          txtHit = true;
          // KRİTİK: sidNum AŞAĞIDA (dlNumMap bloğunda) tanımlı → burada kullanmak
          // ReferenceError (TDZ) atıyor ve pipeline sessizce ölüyordu (zoom %100'e döner,
          // indirme durur). sidMap AYNI değeri taşır ve YUKARIDA tanımlı.
          const fromTxt = mappedSlotFor(sidMap, tpi, dlCount, state.dlNumMap);
          if (fromTxt !== useIdx)
            console.log('[AutoFlow][DL] numara PROMPT METNİNDEN düzeltildi:', (useIdx + 1), '→', (fromTxt + 1),
                        '| metin:', String(tile.txt).slice(0, 40));
          useIdx = fromTxt;
          // v154: metin belirsizse (birden cok prompt ayni basliga uyuyor) karari KONUM verdi;
          // etiket bunu durustce soyler, yoksa log 'metin' diyip arastirmayi yanlis yone cekiyor.
          // v168: karari damga verdiyse log 'damga' der — 'metin' demek arastirmayi
          // yanlis katmana cekiyordu (v154'teki ayni ders).
          numSrc = (txtAmb ? 'metin~konum(prompt#' : (tsHit ? 'damga(prompt#' : 'metin(prompt#')) + (tpi + 1) + ')';
          txtNumOn = true;   // v131: artık numara konumdan gelmiyor → konum guard'ları gereksiz
          if (!txtNumLogged) {
            txtNumLogged = true;
            logEvent('info', 'Numaralar prompt metninden belirleniyor → konum/fantom numarayı bozamaz');
          }
          if (priorPi < 0) {                                // v145: kota tile başına BİR kez
            usedPiRun.add(tpi);
            usedPiCount.set(tpi, (usedPiCount.get(tpi) || 0) + 1);   // v140
            if (sidMap) usedPiBySid.set(sidMap, tpi);
          }
        }
      }
      if (!txtHit && mappedPi >= 0) { useIdx = mappedSlotFor(sidMap, mappedPi, dlCount, state.dlNumMap); numSrc = 'ağ-eşlemesi'; }
      // KAYITLI NUMARA ESASTIR (v108; kullanıcı raporu: oto 1,2,3,5 verdi ama "Sonradan indir"
      // 1,4,5,6 verdi — 2 ve 3 atlandı). Üretim BİTTİKTEN sonra feed'deki başarısız/hayalet
      // tile'ların metin-bazlı tespiti ve top/left sıralaması GÜVENİLMEZ → canlı konum sayımı
      // (genIdxPos) manuel indirmede numaraları kaydırabiliyor. Her indirme, medya kimliği
      // (?name=) → numara slotunu dlNumMap'e yazar (aşağıda); AYNI projede tekrar indirmede
      // (oto→manuel, manuel→manuel, sahte-başarı sonrası yeniden deneme) kayıtlı numara AYNEN
      // kullanılır → numara asla kaymaz. Kayıtsız tile (oto pipeline kaçırdıysa) son kayıtlı
      // numaradan +1 devam eder. Kayıt hiç yoksa (bağımsız manuel indirme) eski davranış korunur.
      // FARKLI projede (dlSequential) kayıt KULLANILMAZ (o proje düz sıralı numaralanır).
      if (!state.dlNumMap) state.dlNumMap = {};
      const sidNum = stableId(tile.key || '');
      // v174: 1.2.48 ve öncesi asb adresli kartın numarasını TAM adresle kaydediyordu → o kayıt da okunur.
      if (sidNum && tile.key && sidNum !== tile.key && !Object.prototype.hasOwnProperty.call(state.dlNumMap, sidNum) &&
          Object.prototype.hasOwnProperty.call(state.dlNumMap, tile.key)) state.dlNumMap[sidNum] = state.dlNumMap[tile.key];
      if (!state.dlSequential && sidNum && Object.prototype.hasOwnProperty.call(state.dlNumMap, sidNum)) {
        useIdx = state.dlNumMap[sidNum]; numSrc = 'kayıt';
      } else if (manual && !txtHit && mappedPi < 0 && lastNumIdx >= 0 && Object.keys(state.dlNumMap).length > 0) { // v114: eşlenmiş numara lastNumIdx+1 ile EZİLMEZ
        // ── v168 KÖK DÜZELTME: ÜRETİLEMEYEN PROMPT ARTIK BURADA DA SLOT TÜKETİR ────
        // KANIT (kullanıcı logu 2026-09-10, 1K görsel + toplu indirme, Almanca diz videosu):
        // her satır 'sıra+1' kaynaklıydı; 0052'den sonra bir kart üretilemedi (sayaç 51→53
        // sıçradı, konum 27→29 sıçradı: İKİ sayaç da hatayı DOĞRU gördü) ama numara yine de
        // 0053 verildi ve sonraki tüm dosyalar bir kaydı.
        // SEBEP YAPISAL: lastNumIdx yalnız BAŞARILI indirmede ilerler (aşağıda), yani bu dal
        // üretilemeyen prompt'u göremez → boşluk bırakması imkânsızdı. Artık son numaradan
        // bu yana biriken KALICI hata sayısı kadar ileri atlanır → hata kendi slotunu tüketir.
        // İki ek koruma yukarıdaki koşulda: metin/damga katmanı karar verdiyse (txtHit) bu
        // TAHMİN artık onu EZMEZ — kanıt, sıra sayımını her zaman yener.
        const failNow = Object.keys(state.dlFailedKeys || {}).length;
        const gap = Math.max(0, failNow - lastNumFail);
        useIdx = lastNumIdx + 1 + gap;
        numSrc = gap ? ('sıra+1+boşluk' + gap) : 'sıra+1';
      }
      // (lastNumIdx yalnız BAŞARILI tetikte ilerletilir — aşağıda; yoksa aynı tile'ın
      //  yeniden denemeleri numarayı her turda +1 kaydırırdı.)
      // v126.9 ÇAKIŞMA KORUMASI: hesaplanan slot BU KOŞUDA başka bir medyaya verilmişse aynı
      // dosya adı ikinci kez kullanılır ve Chrome "0002 (1)" diye kaydeder (kullanıcı raporu).
      // Kayıtlı numarası olan tile (yukarıdaki dlNumMap dalı) muaftır — o zaten kendi numarası.
      // v173 OTO VİDEO NUMARA ÇAKIŞMASI: numara konumdan geliyorsa (metin/ağ kanıtı yok) her kartın
      // tek bir konumu vardır. Hesaplanan numara bu koşuda BAŞKA bir medyaya zaten verildiyse bu
      // kart ya adresi değişmiş aynı video, ya tanınamamış bir referans, ya da sayım o an eksik.
      // Eski davranış sıradaki boş numarayı veriyordu → dosya BAŞKA bir promptun numarasıyla
      // iniyordu (kullanıcı logu: "1 doluydu → 3 verildi", inen kart referans görseliydi).
      // Artık ~30 sn yeniden sayılır; çakışma sürerse kart yanlış numarayla İNDİRİLMEZ, atlanır.
      // YALNIZ ekranda gönderilen kadar kart varken: Flow ızgarası sanal listedir (canlı DOM:
      // cdk-virtual-scroll-viewport); uzun koşuda inmiş eski satırlar DOM'dan düşünce önündeki
      // kartlar sayılamaz ve çakışma BEKLENİR. O durumda eski davranış (sıradaki boş numara) doğru
      // numarayı veriyor (sim: 180/180) → aynen korunur.
      // v174 AYNI KART, YENİ ADRES: bu numarayla inen kartın adresi şu an ekranda HİÇ yoksa ve etiket
      // aynıysa bu kart o karttır (Flow adresi değiştirdi; sayfa yenilenince uuid'li adres asb adrese
      // dönüyor). Beklemeden tek kart sayılır, tekrar indirilmez. Kart sayısı eksikken de denetlenir
      // (sim: yenilemeden sonra en yeni kart 1-2 sn görünmezken kapı kapalı kalıyor, eski kaydırma
      // aynı videoyu "0026" diye ikinci kez indiriyordu); o durumda etiketin İKİ tarafta da dolu ve
      // birebir aynı olması şart. Eski adres hâlâ ekrandaysa iki ayrı kart aynı numarayı istiyor
      // demektir → aşağıdaki koruma aynen.
      // ── v176 KAYIT ÇAPASI (yalnız OTO GÖRSEL, numara konumdan geliyorken) ──────────────────
      // Hedeften önce ekranda duran EN YAKIN inmiş kartın kayıtlı numarası + aradaki kart sayısı.
      // Konum sayımı hedeften önceki kartların HEPSİ DOM'dayken doğru; Flow'un sanal ızgarası eski
      // satırları attığında eksik sayar (uzun koşu 2026-09-15: %100 yakınlaştırmada 73 yerine 16/20,
      // %33'te ~104 kartta takılı kaldı). Çapa yalnız hedefle arasındaki kartlara bakar → eski
      // satırların DOM'da olup olmamasından etkilenmez.
      const anchorFor = () => {
        if (!(autoImgPos && !manual && !txtHit && mappedPi < 0 && !state.dlSequential && idx >= 0 && numSrc === 'konum')) return null;
        const sidT = stableId(tile.key || '');
        const seenA = new Set(sidT ? [sidT] : []);
        let between = 0;
        for (let j = idx - 1; j >= 0; j--) {
          const tj = tiles[j];
          if (refLike(tj)) continue;
          const sj = tj.key ? stableId(tj.key) : '';
          if (sj && seenA.has(sj)) continue;
          if (sj && tj.state === 'complete' && Object.prototype.hasOwnProperty.call(state.dlNumMap, sj)) {
            const slot = advSlots(state.dlNumMap[sj], between + 1);
            const maxA = (Array.isArray(state.prompts) && state.prompts.length) ? (state.prompts.length * dlCount - 1) : Infinity;
            return (slot <= maxA) ? { slot, between } : null;
          }
          if (sj) seenA.add(sj);
          between++;
        }
        return null;
      };
      // v176b: ÇAKIŞMA OLMADAN da. Konum, önünde başarısız prompt varken onların BOŞ numarasına denk
      // gelebiliyor (sim: konum 31 → 0032 boştu, kart aslında 60. prompttu) → aşağıdaki çakışma
      // koruması hiç tetiklenmiyordu. Fark (çapa − konum) = çapa kartının indiği andan beri ÖNÜNDEN
      // DOM'dan düşen kart sayısıdır. Ekrandaki kart eksiği (gönderilen prompt çıktıları − ekranda sayılan
      // kartlar) en az bu fark kadarsa çapa kullanılır. Eksik yoksa (sıralama oynaması gibi) hiçbir şey
      // değişmez. (İlk yazımda '+2 prompt payı' vardı: sim'de gerçek eksik tam farka eşitti, kural hiç
      // tetiklenmedi ve yanlış çapalar zincirleme taşındı.)
      if (autoImgPos && !manual && sidNum && !Object.prototype.hasOwnProperty.call(state.dlNumMap, sidNum)) {
        const an = anchorFor();
        if (an && an.slot > useIdx && !usedSlots.has(an.slot)) {
          const seenC = new Set(); let visC = 0;
          for (const t of tiles) {
            if (refLike(t)) continue;
            const sv = t.key ? stableId(t.key) : '';
            if (sv) { if (seenC.has(sv)) continue; seenC.add(sv); }
            visC++;
          }
          let skC = 0; const spC = state.skippedPrompts || {};
          for (const kk in spC) if (spC[kk] && Number(kk) < state.currentIndex) skC++;
          const expC = Math.max(0, Math.min(state.currentIndex || 0, (state.prompts || []).length) - skC) * dlCount;
          const missC = expC - visC;
          if (missC >= (an.slot - useIdx)) {
            logEvent('info', 'Numara konumdan eksik sayıldı (konum ' + (useIdx + 1) + ', ekranda ' + missC + ' kart yok) → ' +
              'önceki inen karttan ' + (an.between + 1) + ' kart ileri sayıldı: ' + (an.slot + 1) + ' verildi');
            useIdx = an.slot; numSrc = 'kayıt-çapası';
          }
        }
      }
      if (modeVideoNum && !manual && !txtHit && mappedPi < 0 && !state.dlSequential && sidNum &&
          !Object.prototype.hasOwnProperty.call(state.dlNumMap, sidNum) && usedSlots.has(useIdx)) {
        const owners = Object.keys(state.dlNumMap).filter(s => s !== sidNum && state.dlNumMap[s] === useIdx);
        const shown = new Set(tiles.filter(t => t.key).map(t => stableId(t.key)));
        const ownerShown = owners.some(s => shown.has(s));
        const ownTxt = slotTxt.has(useIdx) ? slotTxt.get(useIdx) : '';
        const curTxt = String(tile.txt || '').trim();
        const txtOk = (visCardsNow >= expCardsNow) ? (!ownTxt || !curTxt || ownTxt === curTxt) : (!!ownTxt && ownTxt === curTxt);
        if (owners.length && !ownerShown && txtOk) {
          releaseUi(uiPrio);
          aliasKeys.add(key); state.dlSkipKeys[key] = true; state.dlNumMap[sidNum] = useIdx; slotClashHold = 0;
          // Bu kart tanınana dek hem eski adresiyle (inen) hem yeni adresiyle (açık) sayıldı → arkasındaki
          // kartların v172 konum hafızası bir fazla. Düşürülmezse "önündeki kart kayboldu" sanılıp
          // boşuna ~24 sn beklenir (sim s7: 8 ile 9 arasında 24 sn).
          const ordA = ordNow.has(sidNum) ? ordNow.get(sidNum) : -1;
          if (ordA >= 0) for (const [k2, v2] of posSeenMax) if (v2 > ordA) posSeenMax.set(k2, v2 - 1);
          logEvent('info', 'Numara ' + (useIdx + 1) + ' ile zaten inen kartın adresi değişti (etiket aynı, eski adres ekranda yok) → ' +
            'tekrar indirilmedi, beklenmedi | metin:"' + curTxt.slice(0, 34) + '"');
          await persist();
          continue;
        }
      }
      if (modeVideoNum && !manual && !txtHit && mappedPi < 0 && !state.dlSequential && sidNum &&
          !Object.prototype.hasOwnProperty.call(state.dlNumMap, sidNum) && usedSlots.has(useIdx) &&
          visCardsNow >= expCardsNow) {
        releaseUi(uiPrio);
        if (++slotClashHold <= 10) {
          dlPhase = 'numara-cakismasi';
          if (slotClashHold === 1)
            logEvent('info', 'Numara ' + (useIdx + 1) + ' bu koşuda başka bir videoya verildi → sayım yeniden doğrulanıyor, ' +
              'yanlış numarayla indirilmez | metin:"' + String(tile.txt || '').slice(0, 34) + '"');
          await sleep(3000);
          continue;
        }
        logEvent('error', 'Numara çakışması ~30 sn sürdü → kart yanlış numarayla İNDİRİLMEDİ, atlandı | numara:' +
          (useIdx + 1) + ' metin:"' + String(tile.txt || '').slice(0, 34) + '"');
        state.dlSkipKeys[key] = true; slotClashHold = 0;
        await persist();
        continue;
      }
      if (!state.dlSequential && sidNum &&
          !Object.prototype.hasOwnProperty.call(state.dlNumMap, sidNum) && usedSlots.has(useIdx)) {
        const before = useIdx;
        // ── v176 KAYIT ÇAPASI (yalnız OTO GÖRSEL, metin/ağ kanıtı yokken) ─────────────────────
        // KANIT (uzun koşu 2026-09-15 19:47, 150 prompt + 3 referans): 58-69 Google "olağan dışı
        // etkinlik" hatasıyla düştü (numaraları boş kalmalı). Pencere simge durumundan geri gelince
        // Flow'un sanal ızgarası bir süre yalnız son satırları çizdi; konum sayımı 73 yerine 16 ve 20
        // buldu. Aşağıdaki eski yedek "sıradaki boş numara" yukarı yürüyüp İLK BOŞLUĞA (58, 59)
        // oturdu → 74. prompt 0058, 75. prompt 0059 diye indi. Boşluk yokken aynı yedek doğru
        // numarayı verdiği için bu hata yalnız "önünde başarısız prompt var + eski satırlar DOM'da
        // yok" birleşiminde görünüyordu.
        // ÇÖZÜM: konumdan gelen numara bu koşuda DOLUYSA önce ekranda hedeften önce duran EN YAKIN
        // inmiş kart aranır; onun kayıtlı numarasından arada duran kart sayısı kadar ileri sayılır
        // (atlanan promptların numaraları nextSlot ile yine atlanır). Sonuç boşsa, hedef konumdan
        // büyükse ve prompt menzilindeyse o numara verilir; değilse ESKİ davranış aynen çalışır.
        // Çakışma yoksa bu blok hiç çalışmaz → normal akış birebir aynı.
        let anchored = -1, anchorBetween = -1;
        {
          const an = anchorFor();
          if (an && an.slot > before && !usedSlots.has(an.slot)) { anchored = an.slot; anchorBetween = an.between; }
        }
        if (anchored >= 0) {
          useIdx = anchored; numSrc = 'kayıt-çapası';
          logEvent('info', 'Numara çakışması: konum eksik sayıldı (' + (before + 1) + ' doluydu, eski kartlar ekranda yok) → ' +
            'önceki inen karttan ' + (anchorBetween + 1) + ' kart ileri sayıldı: ' + (useIdx + 1) + ' verildi');
        } else {
        // ── v140 MENZİL KORUMASI ───────────────────────────────────────────────────
        // Numara, prompt sayısının ÖTESİNE geçemez: 20 promptluk koşuda 0021/0022/0023
        // diye dosya olamaz (o promptlar yok). Çakışma zinciri menzil dışına taşarsa
        // menzil İÇİNDEKİ en küçük boş slota dönülür. Menzilde hiç boş slot yoksa
        // (kullanıcı Flow'da elle de üretmişse çıktı sayısı promptu aşabilir) ESKİ
        // davranış aynen korunur → hiçbir akış kilitlenmez.
        const maxSlot = (!state.dlSequential && Array.isArray(state.prompts) && state.prompts.length)
          ? (state.prompts.length * dlCount - 1) : Infinity;
        let guardN = 0;
        while (usedSlots.has(useIdx) && useIdx <= maxSlot && guardN++ < 1000) useIdx = nextSlot(useIdx);
        if (useIdx > maxSlot) {
          let f = 0;
          while (f <= maxSlot && usedSlots.has(f)) f++;
          if (f <= maxSlot) useIdx = f;
          else { useIdx = before; let g = 0;
                 while (usedSlots.has(useIdx) && g++ < 1000) useIdx = nextSlot(useIdx); }
        }
        console.warn('[AutoFlow][DL] numara çakışması:', before, '→ boş slot', useIdx);
        logEvent('info', 'Numara çakışması önlendi: ' + (before + 1) + ' doluydu → ' + (useIdx + 1) + ' verildi');
        }   // v176: kayıt çapası bulunamadı → eski yedek
      }
      const promptNo  = Math.floor(useIdx / dlCount) + 1;
      const sub       = useIdx % dlCount;
      // v175 BASLANGIC NUMARASI: yalniz dosya adina yazilan sayi kayar. promptNo, useIdx, dlNumMap,
      // Queue kaydi ve etiket aramasi (buildFileBase(num, promptNo) promptNo ile arar) AYNEN kalir.
      const num       = String(promptNo + afNumOffset()).padStart(4, '0') + (sub === 0 ? '' : String.fromCharCode(97 + sub));
      // v131 İZLENEBİLİRLİK: her dosyanın numarası NEREDEN geldi? (Logs panelinde görünür →
      // numara yanlışsa hangi kaynağın karar verdiği tahmine gerek kalmadan anlaşılır.)
      logEvent('ref', 'NUMARA ' + num + ' ← ' + numSrc + ' | konum:' + genIdxPos + ' sayaç:' + genIdx +
        ' | metin:' + (tile.txt ? ('"' + String(tile.txt).slice(0, 34) + '"') : 'YOK') +
        // v154 TESHIS: numara yanlis ciktiginda hangi katmanin ne dedigi tek satirda gorunur.
        ' | zincir:' + vidSlotIdx + ' ag:' + (mappedPi >= 0 ? (mappedPi + 1) : '-') +
        ' metinAday:' + txtAllN + '/' + txtFreeN + ' hayalet:' + ghostsSeen +
        (state.dlSequential ? ' | dlSequential:AÇIK' : ''));

      let resolveDone;
      const donePromise = new Promise(r => (resolveDone = r));
      // v150: DOSYA ADI = numara [+ etiket]. 'num' AYNEN kalir (numaralandirma ona bakar).
      const fileBase = buildFileBase(num, promptNo);
      if (fileBase !== num) logEvent('ref', 'DOSYA ADI ' + fileBase + ' (numara ' + num + ')');
      pendingDownloadBase = { folder, num, name: fileBase, isVideo, id: null, resolveDone };

      dlPhase = 'indiriliyor';
      let trig = { success: false };
      // GÖRSEL + 1K → DOĞRUDAN İNDİRME (HEM AUTO HEM MANUEL): ⋮ menüsü / kaydırma / çakışma YOK.
      // Görselin medya URL'ini doğrudan chrome.downloads ile indiriyoruz → hızlı, kesin sıralı,
      // doğru numaralı, kırılgan menü etkileşimine bağımlı DEĞİL (zip/yanlış-başarısız/isimsiz
      // dosya derdi YOK). Doğrudan URL ÜRETİLEN (1K, ~1376x768) görseli verir; 2K/4K SUNUCU
      // upscale gerektirdiğinden onlar FLOW MENÜSÜ üzerinden iner (kırılgan). Video da menü yolunu kullanır.
      // ⇒ %100 güvenilir indirme için 1K önerilir; auto modda da artık direct.
      const directUrl = (token === '1k' && !isVideo && tile.key && /^https?:\/\//.test(tile.key)) ? tile.key : null;
      console.log('[AutoFlow][DL] YOL:', directUrl ? 'DOĞRUDAN (güvenli)' : 'FLOW MENÜSÜ (kırılgan)',
                  '| token:', token, '| video:', isVideo,
                  '| key:', (tile.key || '').slice(0, 40));
      if (directUrl) {
        // Bu tile'ı GÖRÜNÜR yap → sonraki tarama bir sonraki (daha yeni) tile'ı görsün;
        // galeri sanallaştırdığından traversal böyle eskiden→yeniye ilerler. (Menü yolu da
        // scrollIntoView yapıyor; doğrudan indirmede de aynı ilerlemeyi sağlıyoruz.)
        try {
          await chrome.scripting.executeScript({
            target: { tabId: state.tabId }, world: 'MAIN',
            func: (url) => {
              const m = [...document.querySelectorAll('img,video')]
                .find(e => (e.currentSrc || e.src || '') === url);
              if (m) m.scrollIntoView({ block: 'center' });
            },
            args: [directUrl]
          });
          await sleep(200);
        } catch (_) {}
        try {
          // KRİTİK: dosya adını/klasörünü DOĞRUDAN download()'a veriyoruz → onDeterminingFilename
          // dinleyicisine HİÇ bağımlı DEĞİL. (MV3'te bu dinleyici SW yeniden başlayınca "tek
          // dinleyici" kuralına takılıp bozuk duruma düşebiliyor → dosyalar UUID adıyla klasör
          // DIŞINA iniyordu. filename'i burada vermek 1K indirmeyi %100 garantiye alır.)
          // Adres webp isteyecek sekilde geliyor; indirirken JPEG istiyoruz.
          const dlUrl = afJpegUrl(directUrl);
          const dext = (dlUrl.match(/\.(jpe?g|png|webp|gif)(?:[?#&]|$)/i) || [])[1]
                    || (/-rj(?=$|[?#])/.test(dlUrl) ? 'jpg' : 'jpg');
          const dlId = await chrome.downloads.download({
            url: dlUrl,
            filename: `${folder}/${fileBase}.${dext}`,
            conflictAction: 'uniquify'
          });
          if (typeof dlId === 'number') { pendingDownloadBase.id = dlId; trig = { success: true, direct: true }; }
          else trig = { success: false, error: 'direct-no-id' };
        } catch (e) {
          trig = { success: false, error: 'direct-err' };
          console.warn('[AutoFlow][DL] doğrudan indirme hatası:', e.message);
        }
      } else {
        let trigRaceDone = false; // ANINDA DURDUR: tetik sürerken "Durdur"a basılırsa beklemeyi kes
        try {
          const res = await Promise.race([
            chrome.scripting.executeScript({
              target: { tabId: state.tabId }, world: 'MAIN',
              func: flowDownloadNth, args: [{ idx, top: tile.top, left: tile.left, key: tile.key }, token, isVideo, !manual]
            }).then(r => { trigRaceDone = true; return r; }),
            (async () => { while (!trigRaceDone && !(dlCancel)) await sleep(150); return 'CANCEL'; })()
          ]);
          trigRaceDone = true;
          if (res === 'CANCEL') { releaseUi(uiPrio); pendingDownloadBase = null; console.log('[AutoFlow][DL] tetik sırasında iptal'); break; }
          trig = res?.[0]?.result || { success: false };
        } catch (e) { console.warn('[AutoFlow][DL] trigger err:', e.message); }
      }

      releaseUi(uiPrio); // kısa etkileşim bitti → üretim devam edebilir
      if (dlCancel) { pendingDownloadBase = null; console.log('[AutoFlow][DL] iptal (tetik sonrası)'); break; }

      console.log('[AutoFlow][DL] tile', idx, '→', num, 'tetik:', JSON.stringify(trig),
                  '| token:', token, '| video:', isVideo);

      if (trig.success) logEvent('downloading', '#' + num + ' downloading ' + token);

      if (!trig.success) {
        pendingDownloadBase = null;
        // Referans picker'ı açıktı → üretim UI'yı kullanıyor. ÇAKIŞMADAN kısa bekle ve
        // AYNI tile'ı tekrar dene; trigFail ARTIRMA (yoksa birkaç çakışmada yanlışlıkla
        // 'başarısız' işaretlenir). Üretim picker'ı kapatınca indirme sorunsuz tetiklenir.
        if (trig.error === 'picker-open') {
          await sleep(800);
          continue;
        }
        // Hedef görsel iki tarama arasında DOM'dan kaydı/sanallaştı (yanlış tile'a
        // tıklamamak için flowDownloadNth konuma DÜŞMEDİ). Kısa bekle, AYNI tile'ı
        // taze konum+kimlikle yeniden hedefle; trigFail ARTIRMA (gerçek hata değil,
        // geçici yarış). scrollIntoView ile tile görünür kalacağından hızla çözülür.
        if (trig.error === 'target-gone') {
          if (++goneSeen > 10) { // çok uzun süre bulunamıyorsa (gerçekten gitti) atla
            // v133: DOM'dan tamamen kaybolan hedef GERÇEK bir çıktı değildir (fantom /
            // sanallaşan yer tutucu) → atlanır ama numara slotu TÜKETMEZ.
            console.warn('[AutoFlow][DL] tile', idx, 'hedef sürekli bulunamadı → FANTOM sayıldı (numara TÜKETMEZ)');
            state.dlSkipKeys[key] = true; goneSeen = 0; await persist();
          }
          await sleep(700);
          continue;
        }
        // menu-no-indir: bu tile ZATEN 'complete' doğrulandı (yukarıda); ⋮ menüsünde "İndir"
        // bulunamaması GEÇİCİ bir menü aksaklığıdır (Flow re-render / ⋮ açılmadı / sayfa
        // düğmeleri toplandı), GERÇEK "indirilemez" değil. Eskiden KALICI başarısız işaretliyordu
        // → SAĞLAM görsel siliniyor + numara kayıyordu (log: tile 5 menu-no-indir → atlandı).
        // Artık birkaç kez YENİDEN DENE (taze ⋮); ancak çok ısrarcıysa (gerçekten menüsüz) atla.
        if (trig.error === 'menu-no-indir') {
          if (++trigFail >= 6) {
            console.warn('[AutoFlow][DL] tile', idx, 'menu-no-indir 6 denemede çözülmedi → atlanıyor');
            state.dlFailedKeys[key] = true; trigFail = 0; await persist();
          } else {
            console.log('[AutoFlow][DL] tile', idx, 'menu-no-indir → menü açılmadı, yeniden denenecek (' + trigFail + ')');
          }
          await sleep(1200);
          continue;
        }
        // GÜVENLİK AĞI — REFERANS TİLE: indirme menüsünde "orijinal boyut" var (yüklenen referansın
        // upscale'i yoktur; üretilen görselde 1K/2K/4K seçenekleri olur, "orijinal boyut" OLMAZ) ve
        // istenen kalite submenüde bulunamadı → bu bir REFERANS. ASLA indirme, ASLA tekrar deneme,
        // numara slotu TÜKETME (dlRefKeys ayrı küme — genIdx'e sayılmaz). Kimlik-hariç-tutma kaçırsa
        // bile (feed id != picker id) bu, kullanıcının "hiç denemesin" isteğini garantiler.
        // REFERANS: flowDownloadNth erken-çıkışla 'is-reference' döndü, VEYA submenu-not-found +
        // menüde "orjinal/orijinal boyut". İkisinde de → REFERANS: kalıcı atla, ASLA tekrar deneme,
        // numara slotu TÜKETME (dlRefKeys ayrı küme — genIdx'e sayılmaz).
        {
          const menuTxt = (Array.isArray(trig.menu) ? trig.menu.join(' ') : '').toLowerCase();
          const isRefTile = trig.error === 'is-reference' ||
                            (trig.error === 'submenu-not-found' && /or[i]?jinal|original/.test(menuTxt));
          if (isRefTile) {
            state.dlRefKeys[key] = true; trigFail = 0;
            // Kimliği KALICI referans haritasına da yaz + sayfaya bildir (v107): collector
            // sonraki taramada 'reference' işaretler → konum-bazlı video numarası ve
            // görünür-tile sayımı da bu tile'ı dışlar (numara kayması olmaz).
            const rid = ((tile.key || '').match(/(?:[?&]name=|flow-content\.google\/[a-z]+\/)([^&?/]+)/i) || [])[1];
            if (rid) {
              (state.refIdMap || (state.refIdMap = {}))[rid] = 1;
              try {
                await chrome.scripting.executeScript({
                  target: { tabId: state.tabId }, world: 'MAIN',
                  func: (id) => { window.__afRefIds = window.__afRefIds || {}; window.__afRefIds[id] = 1; },
                  args: [rid]
                });
              } catch (_) {}
            }
            await persist();
            console.log('[AutoFlow][DL] tile', idx, 'REFERANS algılandı (orijinal/orjinal boyut) → atlanıyor, tekrar denenmeyecek, numara etkilenmez');
            continue;
          }
        }
        if (++trigFail >= 4) {
          console.warn('[AutoFlow][DL] tile', idx, '4 denemede indirilemedi → atlanıyor');
          state.dlFailedKeys[key] = true; trigFail = 0; await persist();
        }
        await sleep(2500);
        continue; // aynı tile yeniden denenir (kimliğe göre, sıra korunur)
      }
      // İndirme BAŞARIYLA tetiklendi → bu tile'ı KİMLİĞİYLE indirildi işaretle.
      // onDeterminingFilename dosyayı bu 'num' ile adlandırdı; zaman aşımı olsa bile
      // işaretli kalır → aynı görsel tekrar seçilmez/tetiklenmez.
      // (trigFail burada SIFIRLANMAZ — aşağıdaki tetik doğrulaması geçince sıfırlanır.
      //  Aksi halde sahte başarı 4-deneme sayacını her turda sıfırlayıp sonsuz döngü yapardı.)
      state.dlDoneKeys[key] = true;
      // v108: verilen numarayı medya kimliğine KALICI bağla → "Sonradan indir" aynı projede aynı
      // medyayı AYNI numarayla indirir; sahte-başarı geri alımından sonraki deneme de aynı numarayı
      // kullanır. lastNumIdx yalnız burada ilerler (başarısız denemeler numara kaydırmaz).
      if (sidNum) state.dlNumMap[sidNum] = useIdx;
      usedSlots.add(useIdx);   // v126.9: bu koşuda bu numara kullanıldı
      slotTxt.set(useIdx, String(tile.txt || '').trim());   // v174: adres değişirse etiketle doğrulanır
      lastNumIdx = useIdx;
      lastNumFail = Object.keys(state.dlFailedKeys || {}).length; // v168: boşluk sayımının çıpası
      await persist();

      const upscaleQuality = (token === '2k' || token === '4k' || token === '1080');

      // ── TETİK DOĞRULAMA (SAHTE BAŞARI KORUMASI) ──────────────────────
      // KÖK NEDEN (kullanıcı: "Sonradan indir işlemiyor"): sayfa-içi zincir "İndir/720"
      // METNİNİ sayfanın SABİT bir öğesinde bulup tıklayınca 'ok' raporluyordu ama tarayıcıda
      // İNDİRME HİÇ OLUŞMUYORDU (Chrome indirme geçmişi 16:18-16:19'da BOŞ; oysa log 3 kez
      // "downloading 720" yazdı). Upscale GEREKTİRMEYEN kalitelerde (720/270 video — dosya
      // zaten hazır) indirme tık ile ANINDA başlar → ~25 sn içinde chrome.downloads'ta bir
      // Flow indirmesi BELİRMEZSE tık sahteydi: işareti GERİ AL, dürüstçe yeniden dene;
      // 4 denemede olmazsa tile'ı başarısız işaretle ve MENÜ İÇERİĞİNİ Logs'a yaz (teşhis).
      // 2K/4K/1080 upscale dakikalar sürebildiğinden bu hızlı doğrulama onlara UYGULANMAZ
      // (onların takılması zaten upscale-fail toast poll'u ile yakalanıyor).
      if (!directUrl && !upscaleQuality) {
        const trigAt = Date.now();
        let created = false;
        for (let w = 0; w < 50 && !dlCancel; w++) { // ~25 sn
          if (pendingDownloadBase && pendingDownloadBase.id != null) { created = true; break; }
          // onDeterminingFilename bozuk olsa bile yakala: tetikten SONRA başlamış bir Flow
          // indirmesi var mı? (url/referrer Flow medya sunucularını gösterir)
          try {
            const items = await chrome.downloads.search({ orderBy: ['-startTime'], limit: 5 });
            const hit = (items || []).find(it =>
              it.startTime && new Date(it.startTime).getTime() >= trigAt - 3000 &&
              /labs\.google|flow\.google|googleusercontent|googlevideo/.test(
                ((it.url || '') + ' ' + (it.finalUrl || '') + ' ' + (it.referrer || '')).toLowerCase()));
            if (hit) {
              if (pendingDownloadBase && pendingDownloadBase.id == null) pendingDownloadBase.id = hit.id;
              created = true; break;
            }
          } catch (_) {}
          await sleep(500);
        }
        if (dlCancel) { pendingDownloadBase = null; console.log('[AutoFlow][DL] tetik doğrulaması sırasında iptal'); break; }
        if (!created) {
          delete state.dlDoneKeys[key]; // işareti geri al → aynı tile yeniden hedeflenir
          pendingDownloadBase = null;
          const menuTxt = (Array.isArray(trig.menu) ? trig.menu : []).slice(0, 10).join(' | ');
          console.warn('[AutoFlow][DL] tile', idx, 'SAHTE BAŞARI: tık raporlandı ama indirme başlamadı | menü:', menuTxt || '(boş)');
          if (++trigFail >= 4) {
            state.dlFailedKeys[key] = true; trigFail = 0;
            logEvent('failed', '#' + num + ' indirme hiç başlamadı → atlandı' + (menuTxt ? ' [menü: ' + menuTxt + ']' : ''));
          } else {
            logEvent('error', '#' + num + ' tık sonrası indirme başlamadı → yeniden denenecek (' + trigFail + '/4)' + (menuTxt ? ' [menü: ' + menuTxt + ']' : ''));
          }
          await persist();
          await sleep(1500);
          continue;
        }
      }
      trigFail = 0;

      // İndirme tamamlanmasını bekle. 2K/4K "çözünürlüğü artırılmış" seçenekler
      // sunucu tarafında upscale yaptığından DOSYANIN GELMESİ dakikalar sürebilir
      // (kullanıcı ~4-5 dk sonra indiğini gözledi). Sıra bozulmasın diye dosya
      // GERÇEKTEN inene kadar bir sonraki tile'a GEÇMEYİZ. Kalite başına süre:
      let maxWaitMs = token === '4k'   ? 600000   // 4K  → 10 dk
                      : (token === '2k' || token === '1080') ? 420000  // 2K/1080 → 7 dk
                      : 240000;                                         // 1K/720  → 4 dk
      // Video hazırlama + indirme görselden yavaş; dosya gecikmeli inse de
      // pendingDownloadBase canlı kalsın diye taban süreyi yükselt.
      if (isVideo) maxWaitMs = Math.max(maxWaitMs, 420000); // video → en az 7 dk
      // ÇÖZÜNÜRLÜK ARTIRMA gerektiren kaliteler (2K/4K görsel, 1080p video — upscaleQuality
      // yukarıda hesaplandı) sunucuda upscale yapar; başarısız olunca Flow sağ-üstte
      // "çözünürlük artırılamadı" TOAST'ı gösterir ve DOSYA HİÇ İNMEZ → pipeline 7-10 dk
      // boşuna bekleyip TAKILI görünüyordu. Bu kalitelerde toast'ı poll et; çıkarsa beklemeyi
      // hemen kes → sonrakine geç. Tile zaten dlDoneKeys'te (slot tüketildi) → numara KAYMAZ.
      let raceDone = false; // cancel-poll zombi kalmasın diye race çözülünce durdur
      const racers = [
        donePromise.then(v => { raceDone = true; return v; }),
        sleep(maxWaitMs).then(() => { raceDone = true; return 'timeout'; }),
        // İPTAL: kullanıcı "Durdur"a basarsa uzun beklemeyi (2K/4K dakikalar sürebilir) hemen kes
        (async () => { while (!raceDone && !(dlCancel)) await sleep(400); return 'cancel'; })()
      ];
      if (upscaleQuality) {
        racers.push((async () => {
          await sleep(1500); // ilk kısa gecikme: önceki tile'ın toast'ı kalmışsa yeni tetiğe karışmasın
          while (!raceDone) {
            let errSeen = false;
            try {
              const r = await chrome.scripting.executeScript({
                target: { tabId: state.tabId }, world: 'MAIN', func: flowDetectUpscaleError
              });
              errSeen = !!(r?.[0]?.result);
            } catch (_) {}
            if (errSeen) { raceDone = true; return 'upscale-fail'; }
            await sleep(2000);
          }
          return 'timeout';
        })());
      }
      const outcome = await Promise.race(racers);
      raceDone = true;
      pendingDownloadBase = null;
      if (outcome === 'cancel') { console.log('[AutoFlow][DL] beklerken iptal edildi'); break; }
      if (outcome === 'upscale-fail') {
        // Tile zaten dlDoneKeys'te işaretli (slot tüketildi) → numara kaymadan sonrakine geç.
        console.warn('[AutoFlow][DL] tile', idx, 'çözünürlük artırılamadı (Flow) → atlanıp sonrakine geçiliyor (slot', genIdx, 'tüketildi)');
        logEvent('failed', '#' + num + ' kalite (' + token + ') artırılamadı → atlandı');
        await persist();
        await sleep(2500); // toast'ın kapanması için kısa tampon (sonraki tile'a karışmasın)
        continue;
      }
      console.log('[AutoFlow][DL] tile', idx, 'dosya', num, 'sonuç:', outcome);

      // Numara prompt-bazlı (genIdx) hesaplandı; slot başarılı tetikte işaretlendi
      // (yukarıda). Zaman aşımı olsa bile dosya başlangıçta adlandırıldı; çakışmada
      // conflictAction:'uniquify' yedek.
      if (outcome === 'complete') {
        state.dlDone = (state.dlDone || 0) + 1;
        // v170 Queue: bu dosya numarasi GERCEKTEN indi. Slot, dosya adindaki numarayla ayni
        // kaynaktan (useIdx) geliyor; Queue satiri ile klasordeki dosya birebir eslesir.
        // Salt kayit: numaralandirma/indirme kararlarinin hicbiri bu alani okumaz.
        if (!state.dlSequential) {
          if (!state.dlSavedSlots) state.dlSavedSlots = {};
          state.dlSavedSlots[useIdx] = 1;
          try {
            chrome.runtime.sendMessage({ type: 'queueDl', dlSavedSlots: state.dlSavedSlots,
                                         dlTrackPrompts: !!state.dlTrackPrompts }).catch(() => {});
          } catch (_) {}
        }
        logEvent('saved', '#' + num + ' saved');
        if (sub === dlCount - 1) logEvent('complete', 'Prompt #' + promptNo + ' complete (' + dlCount + '/' + dlCount + ')');
      } else {
        console.warn('[AutoFlow][DL] tile', idx, 'zaman aşımı → sonraki tile');
      }
      // tile zaten dlDoneKeys ile işaretli (yukarıda) → imleç ilerletmeye gerek yok
      await persist();
      // HIZ / DENGE: ÜRETİM BİTTİYSE dosya iner inmez sıradakine geç (seri, en hızlı).
      // ÜRETİM SÜRERKEN biraz daha bekle ki indirme üretimi AÇ BIRAKMASIN (1k anında
      // iniyor; arka arkaya indirme üretime sıra bırakmaz) — kullanıcı: "üretim sürerken
      // yavaşlasın, bitince serileşsin".
      const genBusy = (state.status === 'running');
      await sleep(genBusy ? 1500 : 150);
    }

    console.log('[AutoFlow][DL] pipeline bitti. İnen dosya:', state.dlDone || 0);
    crashed = false;
  } catch (e) {
    crashed = true;
    console.error('[AutoFlow][DL] pipeline error:', e);
    // v130: hata Logs paneline DE yazılır — SW konsolu kullanıcıya kapalı olduğundan
    // pipeline sessizce ölüyordu (zoom %100'e döner, indirme durur, sebep görünmez).
    try { logEvent('error', 'İndirme hattı hatası: ' + ((e && (e.message || e.name)) || e) + ' → yeniden başlatılıyor'); } catch (_) {}
  } finally {
    // YALNIZCA bu döngü hâlâ güncelse durumu sıfırla. Daha yeni bir pipeline başladıysa
    // (token arttı) onun dlLoopActive/bulkDownloading'ini EZME.
    if (dlRunToken === myToken) {
      dlLoopActive = false;
      pendingDownloadBase = null; // GÜVENCE: dangling kalırsa sonraki kullanıcı indirmeleri
                                  // yanlışlıkla AutoFlow klasörüne/numarasına yeniden adlandırılır.
      if (!manual) state.autoDlActive = false; // oto pipeline bitti → "Oto indirmeyi durdur" butonu kalkar
      state.bulkDownloading = false;
      dlCancel = false;
      try { await restoreZoomIfForced(); } catch (_) {} // %33 zoom'u geri al (auto; bayrak guard'lı)
      // Üretim de bittiyse sekme yeniden atılabilir (üretim sürüyorsa koruma kalsın)
      if (state.status !== 'running') { try { await setTabAutoDiscard(state.tabId, true); } catch (_) {} }
      try { persist(); broadcast(); } catch (_) {}
      // v130: BEKLENMEDİK hata sonrası (kullanıcı durdurmadıysa) hattı BİR KEZ yeniden
      // başlat → tek bir istisna tüm koşunun indirmesini öldürmesin. En çok 2 kez.
      if (crashed && !manual && !dlCancel && state.autoDownload && dlRestarts < 2) {
        dlRestarts++;
        console.log('[AutoFlow][DL] hata sonrası yeniden başlatılıyor (' + dlRestarts + '/2)');
        setTimeout(() => { if (!dlLoopActive) downloadPipeline(false); }, 5000);
      }
    }
  }
}

// ── Teşhis: üretilen görsellerin sayfada nasıl render edildiğini raporla ──
// MAIN world — self-contained, yan etkisiz. SW konsoluna döner.
function flowDebugDump() {
  const inRange = el => {
    const r = el.getBoundingClientRect();
    return r.width >= 150 && r.height >= 90 && r.width <= 900 && r.height <= 900;
  };
  const imgs = [...document.querySelectorAll('img')].filter(inRange);
  const schemes = {};
  imgs.forEach(im => {
    const s = (im.src || '').split(':')[0] || 'empty';
    schemes[s] = (schemes[s] || 0) + 1;
  });
  let bg = 0;
  [...document.querySelectorAll('div, a, span')].forEach(el => {
    if (!inRange(el)) return;
    const b = getComputedStyle(el).backgroundImage || '';
    if (b.includes('url(')) bg++;
  });
  const failedTextEls = [...document.querySelectorAll('div, span, p')].filter(el => {
    const t = (el.textContent || '').toLowerCase();
    return t.includes('başarısız') || t.includes('olağan dışı') || t.includes('unusual activity');
  }).length;
  return {
    imgInRange: imgs.length, imgSchemes: schemes,
    videos: [...document.querySelectorAll('video')].filter(inRange).length,
    bgImageDivs: bg, failedTextEls,
    sampleSrcs: imgs.slice(0, 8).map(im => (im.src || '').slice(0, 70))
  };
}

// ── TEŞHİS (tek sefer): yakalanan referans kimlikleri + feed'deki complete tile kimlikleri ──
// "Referans yine iniyor" sorununu kesinleştirir: kimlik yakalandı mı, feed tile farklı kimlik mi
// taşıyor? MAIN world, salt-okuma. SW konsoluna döner.
function flowRefDiag() {
  const idOf = u => (u && (u.match(/(?:[?&]name=|flow-content\.google\/[a-z]+\/)([^&?/]+)/i) || [])[1]) || '';
  const refIds = Object.keys(window.__afRefIds || {});
  const refNames = (window.__afRefImages || []).map(r => (r && r.name) || '');
  const tiles = [];
  document.querySelectorAll('img, video').forEach(m => {
    const r = m.getBoundingClientRect();
    if (!tileSizeOk(r)) return;
    if (m.closest('[role="dialog"], [aria-modal="true"], .cdk-overlay-pane')) return;   // v137: picker overlay'i de ele
    const tag = m.tagName.toLowerCase();
    const src = tag === 'img' ? (m.src || '') : (m.currentSrc || m.src || '');
    if (!/^(https?|blob|data):/.test(src)) return;
    const id = idOf(src);
    tiles.push({ tag, id, alt: (m.getAttribute('alt') || '').slice(0, 18),
                 src: src.slice(0, 80), isRef: !!(id && (window.__afRefIds || {})[id]) });
  });
  return { refIdCount: refIds.length, refIds: refIds.slice(0, 10),
           refNames: refNames.slice(0, 10), tileCount: tiles.length, tiles: tiles.slice(0, 18) };
}

// ── TEŞHİS (v112): başarısız-kart metni DOM'da nerede ve dedektör onu görebiliyor mu? ──
// MAIN world, salt-okuma, self-contained. Sonuç kalıcı log'a yazılır (logEvent) → sorun
// sürerse LevelDB'den okunarak "kart neden sayılmadı" kesin cevaplanır: metin ışık DOM'da mı
// shadow'da mı, en-içteki öğenin etiketi ne, kutu-yürüyüşü hangi boyutu buldu, kapıdan geçti mi.
// ── v114: KESİN NUMARA EŞLEMESİ (saf, test edilebilir yardımcılar) ──────────────
// KANIT (15:09 koşusu NET logları): AutoFlow prompt'u gönderdikten ~6 sn sonra
// /v1/video:batchAsyncGenerateVideoReferenceImages yanıtı geliyor ve içindeki uuid,
// videonun feed'deki ?name= kimliğiyle (dlNumMap anahtarı) BİREBİR aynı.
// → uuid'yi gönderim zamanına göre prompt indeksine bağla; indirmede numara ORADAN gelsin.
// Üretim çağrıları seri (aralık >= yanıt süresi) → "yanıt ts'inden önceki SON gönderim"
// ataması kesindir. Yanıt kaçarsa o tek video eski (heuristik) yola düşer, gerisi etkilenmez.
function applyPromptMediaMap(entries, st) {
  let dirty = false;
  const sa = (st && st.promptSentAt) || {};
  for (const e of (entries || [])) {
    // yalnız ÜRETİM çağrısı (batchCheckAsync... durum yoklaması ve uploadImage HARİÇ)
    // v126.9: her ÜRETİM çağrısı eşlenir (video + GÖRSEL). Durum yoklama / yükleme /
    // listeleme çağrıları elenir — onların kimlikleri prompt'a bağlanmamalı.
    // v160: İSTEK gövdesi kaydı (q:1) REFERANS kimliklerini taşır, ÜRETİLEN medyayı DEĞİL.
    // Eslemeye girerse prompt'a yanlış medya bağlanır → numara bozulur. KESİNLİKLE ELE.
    if (e.q) continue;
    const pth = String(e.p || '').toLowerCase();
    const isGen  = /asyncgenerate|batchgenerate|:generate|generateimage|generatevideo/.test(pth);
    const isPoll = /check|status|poll|list|fetch|upload|download|history|delete/.test(pth);
    if (!isGen || isPoll || !Array.isArray(e.ids) || !e.ids.length) continue;
    const ts = e.ts || Date.now();
    let pi = -1, best = -Infinity;
    for (const k in sa) {
      const t0 = sa[k];
      if (typeof t0 === 'number' && t0 <= ts + 2000 && t0 >= best) { best = t0; pi = Number(k); }
    }
    if (pi < 0) continue;
    if (!st.promptMediaMap) st.promptMediaMap = {};
    for (const id of e.ids) if (!(id in st.promptMediaMap)) { st.promptMediaMap[id] = pi; dirty = true; }
  }
  return dirty;
}
// ── v128: TILE METNİNDEN PROMPT İNDEKSİ ────────────────────────────────────────
// Flow üretilen medyayı PROMPT METNİYLE etiketliyor. Numara buradan gelince konum sayımı,
// fantom tile, sıra dışı tamamlanma numarayı KAYDIRAMAZ; üretilemeyen prompt'un numarası
// da yapısal olarak BOŞ kalır. Eşleşme yoksa -1 → çağıran eski yola düşer (davranış aynı).
function normPromptTxt(x) {
  // Flow uzun başlığı kısaltıp '…' ekleyebiliyor → önce onu at, sonra boşlukları sadeleştir
  // v163: baştaki zaman damgası KARŞILAŞTIRMADA yok sayılır. Zorunlu: damga Flow'a
  // gönderilmediğinde kartın etiketi damgasız gelir, bizim listemizde ise damga DURUR;
  // iki tarafı da aynı şekilde sadeleştirmezsek metin eşleşmesi (numaralandırmanın en
  // güvenilir katmanı) sessizce çalışmaz olurdu. Simetrik olduğu için ayıklama yapılmayan
  // kullanıcıda da sonuç DEĞİŞMEZ (her iki taraftan da aynı önek atılır).
  // v168: TEK damga atmak YETMIYOR. SRT araliginda ("[00:08:07.348 --> 00:08:28.374] ...")
  // Flow'a giden metinden bas damga kirpildigi icin kart etiketi "> 00:08:28.374] ..." ile,
  // bizim listemizdeki prompt ise "[00:08:07.348 --> ..." ile basliyordu: iki taraf AYNI
  // noktadan sadelesmedigi surece on ek eslesmesi yapisal olarak tutmaz. Bastaki TUM
  // damga/ok dizisi (en fazla 4 tur) her iki taraftan da atilir -> simetri garanti.
  // Damgasiz promptlarda ilk tur hicbir sey eslestirmez -> davranis birebir eskisi gibi.
  let s = String(x || '').toLowerCase();
  for (let i = 0; i < 4; i++) {
    const before = s;
    s = s.replace(AF_TS_RE, ' ').replace(AF_TS_TRIM_RE, ' ');
    if (s === before) break;
  }
  return s.replace(/\u2026/g, ' ').replace(/\.{3,}/g, ' ').replace(/\s+/g, ' ').trim();
}
// v168: METNIN BASINDAKI DAMGALAR (en fazla 4) -> afTsLabel bicimine cevrilmis liste.
// SRT damgalari benzersiz oldugu icin bir promptu TEK BASINA tanimlar. Kullanicinin
// promptlarinin hepsi "Wide 16:9 photograph of a chalkboard..." diye basliyor: 33 karakterde
// kirpilan etiket metin katmanina TUM promptlari aday gosterir, damga ise tek adayi verir.
// Yalniz metnin BASI taranir -> prompt icindeki "16:9" gibi ifadeler damga sayilmaz
// (AF_TS_RE saniyeyi iki haneli sart kosar).
function afAllTsTags(x) {
  let s = String(x == null ? '' : x);
  const out = [];
  for (let i = 0; i < 4 && s; i++) {
    s = s.replace(AF_TS_TRIM_RE, '');
    const m = AF_TS_RE.exec(s);
    if (!m) break;
    const lab = afTsLabel(s);
    if (lab) out.push(lab);
    s = s.slice(m[0].length);
  }
  return out;
}
// v168: DAMGA ESLEMESI \u2014 etikette gorunen damgalarin HEPSI bir promptun damgalari
// arasindaysa o prompt adaydir. Etikette damga yoksa BOS doner (cagiran eski yola duser).
function promptCandidatesByTs(txt, prompts) {
  const tags = afAllTsTags(txt);
  if (!tags.length || !Array.isArray(prompts) || !prompts.length) return [];
  const out = [];
  for (let i = 0; i < prompts.length; i++) {
    const pt = afAllTsTags(prompts[i]);
    if (!pt.length) continue;
    if (tags.every(t => pt.indexOf(t) >= 0)) out.push(i);
  }
  return out;
}
// Anlamsız/bağlaç kelimeler — örtüşme skorunu şişirmesinler (TR + EN yaygın olanlar).
const PROMPT_STOP = new Set([
  // EN
  'the','a','an','is','are','was','were','be','been','being','to','of','in','on','at','with',
  'and','or','for','from','by','it','its','this','that','these','those','his','her','their',
  'our','your','my','as','into','onto','then','than','there','here','has','have','had','do',
  'does','did','will','would','can','could',
  // TR
  'ile','ve','bir','bu','su','şu','icin','için','olan','olarak','da','de','ki','mi','mu',
  // FR
  'le','les','une','des','dans','avec','pour','sur','par','qui','est',
  // DE
  'der','das','eine','ein','und','mit','von','für','auf','ist','sind',
  // ES
  'los','las','del','con','para','por','que',
  // IT
  'gli','nel','che','per'
]);
function promptTokens(x) {
  const out = new Set();
  const base = normPromptTxt(x).replace(/[@#_\-.,!?;:()"'’]+/g, ' ');
  for (const w of base.split(/\s+/)) {
    if (w.length < 3) continue;
    if (PROMPT_STOP.has(w)) continue;
    out.add(w);
  }
  return out;
}
// ── v145: ETİKET METNİNDEN ADAY PROMPT İNDEKSLERİ (belirsizlik ÇAĞIRANA bildirilir) ──
// v142'de metin-numara TAMAMEN kapatılmıştı: Flow footer etiketini ~33 karakterde kırpıyor,
// promptIdxByText ise belirsizlikte "en uzun prompt"u seçip numarayı YANLIŞ prompta
// bağlayabiliyordu. Kapatmanın bedeli, numaranın TAMAMLANMA SIRASINA düşmesiydi (2K/4K
// yolunda sayaç = inen dosya sayısı): geç gönderilip erken biten prompt küçük numara alıyordu
// (kullanıcı logu 2026-09-06: 5. prompt "0002" indi).
// DOĞRU AYRIM: "hangi prompt" sorusunun cevabı TEK ise metin kesin kanıttır; BİRDEN ÇOK
// adaya uyuyorsa (kırpılmış başlık / aynı ön ek / tekrarlı prompt) burada KARAR VERİLMEZ —
// adaylar döndürülür, çağıran konumla teke indirir. Böylece hem yanlış eşleşme olmaz hem de
// numara tamamlanma sırasına düşmez.
function promptCandidatesByText(txt, prompts) {
  const t = normPromptTxt(txt);
  if (t.length < 4 || !Array.isArray(prompts) || !prompts.length) return [];
  // ── 1) BİREBİR / ÖN EK — Flow başlığı yeniden yazmadıysa (en güvenilir) ──────────
  // Kırpma iki yönde de olabilir: etiket prompt'un ön eki (Flow kırptı) ya da prompt
  // etiketin ön eki (etiket, prompt + arayüz metni ya da tekrarlı düğüm birleşimi).
  const pref = [];
  for (let i = 0; i < prompts.length; i++) {
    const p = normPromptTxt(prompts[i]);
    if (p.length < 4) continue;
    if (p === t) { pref.push(i); continue; }
    if (t.length >= 8 && p.indexOf(t) === 0) { pref.push(i); continue; }
    if (p.length >= 8 && t.indexOf(p) === 0) pref.push(i);
  }
  return pref;   // eşleşme yoksa BOŞ → çağıran konuma düşer
}
// ── v146: KELİME ÖRTÜŞMESİ AŞAMASI KALDIRILDI (kullanıcı logu 2026-09-06, 17:50) ──
// KANIT: 20 promptluk koşuda prompt ortalama uzunluğu 1458 karakter, Flow kart başlığı ise
// 33 karakter ("Woman standing in Versailles int…"). Uzun promptta etiketin birkaç
// kelimesinin geçmesi kaçınılmaz olduğundan skor (inter / min(etiket, prompt) kelime sayısı)
// 1.0'a çıkıyor ve TEK kazanan ilan ediliyordu: ilk kart, prompt #10 daha GÖNDERİLMEDEN
// "metin(prompt#10)" numarası aldı. Örtüşme skoru uzun promptlarda kanıt değil gürültü.
// Artık yalnız BİREBİR/ÖN EK eşleşmesi kanıt sayılır:
//   • kısa prompt (etiket = prompt'un kendisi) → eşleşir, numara metinden gelir,
//   • uzun prompt (etiket = Flow'un ürettiği başlık) → eşleşmez, numara KONUMDAN gelir.
// KULLANILMIYOR (v145): numara kararı artık promptCandidatesByText + konum ile veriliyor.
// Belirsizlikte "en uzun prompt"u seçtiği için numarayı yanlış prompta bağlayabiliyordu;
// referans olarak duruyor, çağırmayın.
function promptIdxByText(txt, prompts, usedPi) {
  const t = normPromptTxt(txt);
  if (t.length < 4 || !Array.isArray(prompts) || !prompts.length) return -1;
  // ── 1) BİREBİR / ÖN EK eşleşmesi (Flow başlığı yeniden yazmadıysa — en güvenilir) ──
  const hits = [];
  for (let i = 0; i < prompts.length; i++) {
    const p = normPromptTxt(prompts[i]);
    if (p.length < 6) continue;
    const probe = p.slice(0, Math.min(p.length, 60));
    if (t.includes(probe) || (t.length >= 12 && probe.includes(t.slice(0, Math.min(t.length, 40))))) hits.push({ i, len: p.length });
  }
  if (hits.length) {
    hits.sort((a, b) => b.len - a.len);                // bir prompt diğerinin ön eki olabilir
    const top = hits.filter(h => h.len === hits[0].len).map(h => h.i);
    if (top.length === 1) return top[0];
    if (usedPi) { for (const i of top) if (!usedPi.has(i)) return i; }
    return -1;
  }
  // ── 2) KELİME ÖRTÜŞMESİ — Flow prompt'u BAŞLIĞA çeviriyor ──────────────────────
  //    "the @dog is coming to house with @man" → "Dog coming to house with man…"
  //    Anlamlı kelimelerin oranı en yüksek prompt seçilir; kazanan İKİNCİDEN belirgin
  //    şekilde önde olmalı (aksi halde -1 → eski yol devrede kalır, yanlış eşleşme YOK).
  const tt = promptTokens(t);
  if (tt.size < 2) return -1;
  const scored = [];
  for (let i = 0; i < prompts.length; i++) {
    const pt = promptTokens(prompts[i]);
    if (pt.size < 2) { scored.push({ i, s: 0, inter: 0 }); continue; }
    let inter = 0;
    for (const w of tt) if (pt.has(w)) inter++;
    const s = (inter < 2) ? 0 : inter / Math.max(1, Math.min(tt.size, pt.size));
    scored.push({ i, s, inter });
  }
  scored.sort((a, b) => b.s - a.s || a.i - b.i);
  const best = scored[0], second = scored[1] || { s: 0 };
  if (!best || best.s < 0.6) return -1;
  if (best.s - second.s >= 0.15) return best.i;        // net kazanan
  const tied = scored.filter(x => x.s === best.s).map(x => x.i);
  if (usedPi) { for (const i of tied) if (!usedPi.has(i)) return i; }  // beraberlik → sıradaki
  return -1;
}
// Eşlenen promptun mutlak numara slotu: promptIdx*adet + o prompta şimdiye dek verilen çıktı sayısı.
function mappedSlotFor(sid, pi, dlCount, dlNumMap) {
  let sub = 0;
  for (const k in (dlNumMap || {})) {
    if (k === sid) continue;
    if (Math.floor(dlNumMap[k] / dlCount) === pi) sub++;
  }
  return pi * dlCount + Math.min(sub, Math.max(0, dlCount - 1));
}
// Sayfa tamponunu boşalt: eşlemeye uygula + telemetriyi kalıcı loga yaz (koşu başına ≤25,
// handleStart sıfırlar). Kurulum idempotent (sayfa yenilendiyse sarmalayıcı yeniden kurulur).
let netTeleCnt = 0;
let netTeleSeen = new Set();
async function harvestNetToState(tabId) {
  let entries = [];
  try {
    await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: flowNetTap });
    const nh = await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: flowNetHarvest });
    entries = nh?.[0]?.result || [];
  } catch (_) { return; }
  const mapDirty = applyPromptMediaMap(entries, state);
  for (const e of entries) {
    if (netTeleCnt >= 25) break;
    const sig = (e.q ? 'Q|' : 'R|') + (e.p || '') + '|' + (e.ids || []).join(',');
    if (netTeleSeen.has(sig)) continue;
    netTeleSeen.add(sig); netTeleCnt++;
    logEvent('net', ('NET ' + (e.q ? 'İSTEK ' : '') + e.p + ' len=' + e.n + ' ids=[' + (e.ids || []).join(',') + '] st=' +
                     JSON.stringify(e.sts || {}) + (e.pr ? ' pr="' + e.pr + '"' : '') +
                     (e.ts ? ' ts=' + e.ts : '')).slice(0, 380));
  }
  if (mapDirty) { try { await persist(); } catch (_) {} }
}

// ── AĞ TELEMETRİSİ (v113) — MAIN world, SALT TEŞHİS ─────────────────────────────
// Flow API yanıtlarından kompakt özet biriktirir: uç nokta yolu + medya kimlikleri
// (?name= uuid'leri) + "status" sayımları + ilk prompt kırpığı. Amaç: numaralandırma
// için NİHAİ çözüm olan "prompt ↔ medya kimliği" eşlemesinin GERÇEK şemasını, bir
// sonraki koşunun kalıcı loglarından (LevelDB) çıkarabilmek. Sayfa davranışını
// DEĞİŞTİRMEZ: fetch sarmalayıcı orijinal Promise'i AYNEN döndürür, her adım try/catch,
// yanıt gövdesi clone üzerinden okunur (sayfa gövdeyi tüketmişse sessizce vazgeçilir).
function flowNetTap() {
  if (window.__afNetTapOn) return true;
  window.__afNetTapOn = true;
  window.__afNetLog = [];
  const digest = (u, tx, q) => {   // v160: q=1 -> ISTEK govdesi (yanit degil)
    try {
      const t = (tx || '').slice(0, 200000);
      const ids = []; let m;
      const seenId = new Set();
      const pushId = v => { if (v && !seenId.has(v)) { seenId.add(v); if (ids.length < 16) ids.push(v); } };
      // (a) v1 biçimi: "name": "<uuid>"  (AYNEN korunur)
      const reId = /"name"\s*:\s*"([0-9a-f]{8}-[0-9a-f-]{27,})"/g;
      while ((m = reId.exec(t))) pushId(m[1]);
      // (b) FLOW v2: medya kimliği artık URL YOLUNDA → flow-content.google/<tip>/<uuid>
      const reUrl = /flow-content\.google\/[a-z]+\/([0-9a-f]{8}-[0-9a-f-]{27,})/gi;
      while ((m = reUrl.exec(t))) pushId(m[1]);
      // (c) v132: KALDIRILDI. "yanıttaki herhangi bir uuid" yedeği proje/oturum kimliğini
      //     prompt'a bağlayıp SESSİZCE yanlış numara üretebiliyordu. Gerçek medya kimliği
      //     zaten (a) veya (b) ile yakalanır; yakalanamazsa numara TILE METNİNDEN gelir.
      const sts = {};
      const reSt = /"status"\s*:\s*"([A-Z_]{4,40})"/g;
      while ((m = reSt.exec(t))) sts[m[1]] = (sts[m[1]] || 0) + 1;
      const pr = (t.match(/"prompt"\s*:\s*"((?:[^"\\]|\\.){4,50})/) || [])[1] || '';
      if (!ids.length && !Object.keys(sts).length && !pr) return;
      let path = u;
      try { path = new URL(u, location.href).pathname.slice(0, 60); } catch (_) {}
      window.__afNetLog.push({ p: path, n: t.length, ids, sts, pr, ts: Date.now(), q: q ? 1 : 0 }); // ts: v114 eşleme için
      if (window.__afNetLog.length > 40) window.__afNetLog.shift();
    } catch (_) {}
  };
  try {
    const of = window.fetch;
    window.fetch = function () {
      const p = of.apply(this, arguments);
      try {
        const a0 = arguments[0];
        const u = String((a0 && a0.url) || a0 || '');
        if (/\/api\/|trpc|generat|aisandbox|media/i.test(u))
          p.then(r => { try { r.clone().text().then(tx => digest(u, tx)).catch(() => {}); } catch (_) {} }, () => {});
        // ── v160 SALT TEŞHİS: ÜRETİM İSTEĞİNİN GÖVDESİ ──────────────────────────
        // Kullanıcı raporları: "10 görsel yükledim, hepsi aynı görselden üretildi" ama
        // FRAME diag her promptta DOĞRU dosyayı yerleştirdiğimizi söylüyor. DOM'daki chip
        // yanıltabilir; Flow'un o iş için GERÇEKTEN hangi referansı kullandığını yalnız
        // isteğin gövdesi söyler. YALNIZ string gövde okunur (Blob/FormData/stream'e
        // DOKUNULMAZ, sayfa davranışı değişmez) ve kayıt q:1 ile işaretlenir →
        // promptMediaMap bu kayıtları YOK SAYAR, numaralandirma etkilenmez.
        try {
          const init = arguments[1];
          const b = init && init.body;
          if (typeof b === 'string' && /asyncgenerate|batchgenerate|:generate/i.test(u)) digest(u, b, 1);
        } catch (_) {}
      } catch (_) {}
      return p;
    };
  } catch (_) {}
  return true;
}
// Biriken özetleri al ve sayfa tamponunu boşalt (arka plan logEvent ile persist eder).
function flowNetHarvest() {
  const out = window.__afNetLog || [];
  window.__afNetLog = [];
  return out;
}

function flowFailDiag2() {
  const FAIL_RE = /başarısız|olağan dışı|olagan disi|unusual activity|failed|fehlgeschlagen|ungewöhnlich|échou|inhabituelle|non riuscit|insolit|no se pudo|inusual|falhou|incomum|не удалось|необычн|失敗|失败|실패|विफल|असामान्य|oluşturulam|olusturulam|üretilemedi|uretilemedi|couldn.t (?:be )?(?:creat|generat)|could not (?:be )?(?:creat|generat)|unable to (?:creat|generat)|konnte nicht erstellt|impossible de (?:créer|génér)|no se pudo (?:crear|generar)/;
  const res = { iw: window.innerWidth, zoom: (window.outerWidth ? Math.round(window.innerWidth / window.outerWidth * 100) / 100 : 0),
                light: 0, shadow: 0, dialog: 0, probes: [] };
  const roots = [document];
  const findShadowRoots = (root) => {
    let all = [];
    try { all = root.querySelectorAll('*'); } catch (_) { return; }
    for (const el of all) if (el.shadowRoot) { roots.push(el.shadowRoot); findShadowRoots(el.shadowRoot); }
  };
  try { findShadowRoots(document); } catch (_) {}
  for (const root of roots) {
    try {
      const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let n;
      while ((n = w.nextNode())) {
        const tv = (n.nodeValue || '').toLowerCase();
        if (!tv || !FAIL_RE.test(tv)) continue;
        const el = n.parentElement;
        if (!el) continue;
        // v113: script/style veri metni teşhisi kirletmesin (collector'larla aynı kural)
        if (/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|TITLE)$/.test(el.tagName)) continue;
        if (el.closest && el.closest('[role="dialog"], [aria-modal="true"]')) { res.dialog++; continue; }
        if (root === document) res.light++; else res.shadow++;
        if (res.probes.length < 4) {
          let box = el, r = el.getBoundingClientRect(), steps = 0;
          for (let i = 0; i < 8 && box; i++) {
            const br = box.getBoundingClientRect();
            if (br.width >= 120 && br.height >= 90) { r = br; steps = i; break; }
            box = box.parentElement;
          }
          // v137: gerçek kapıyla AYNI ölçüt (oran bağımsız) → teşhis raporu yanıltmasın
          const pass = !(r.width < 90 || r.height < 90 || r.width * r.height < 14000 ||
                         r.width > 1600 || r.height > 1600 || r.width / r.height > 4 || r.height / r.width > 4);
          res.probes.push({ tag: el.tagName, tx: tv.slice(0, 24), own: Math.round(el.getBoundingClientRect().width) + 'x' + Math.round(el.getBoundingClientRect().height),
                            box: Math.round(r.width) + 'x' + Math.round(r.height), steps, pass, sh: root !== document });
        }
      }
    } catch (_) {}
  }
  return res;
}

// ── Sayfada "çözünürlük artırılamadı / yükseltilemedi / couldn't enhance" TOAST'ı var mı? ──
// 2K/4K görsel veya 1080p video upscale SUNUCU tarafında başarısız olunca Flow sağ-üstte bu
// toast'ı gösterir ve DOSYA İNMEZ. Pipeline bunu algılayıp 7-10 dk beklemeden sonrakine geçer.
// MAIN world, salt-okuma. Yalnız GÖRÜNÜR + KÜÇÜK (toast boyutu) + KISA metinli elemanda arar →
// yanlış-pozitif önlenir.
function flowDetectUpscaleError() {
  // ÇOK DİLLİ: toast metni her dilde farklı; eski regex TR/EN'di → diğer dillerde upscale
  // hatası hiç algılanmayıp pipeline 7-10 dk boşuna bekliyordu ("takıldı" görüntüsü).
  const re = /art[ıi]r[ıi]lamad[ıi]|y[üu]kseltilemed[ıi]|enhance\w*\s*fail|upscale\w*\s*fail|couldn'?t\s+(be\s+)?(enhance|upscal)|hochskal\w*\s*fehl|konnte nicht hochskaliert|impossible d'am[ée]liorer|n'a pas pu être am[ée]lior|no se pudo (mejorar|aumentar|escalar)|não foi possível (melhorar|aumentar)|impossibile migliorar|не удалось (улучшить|повысить|увеличить)|アップスケール.{0,8}失敗|画質を向上できません|업스케일.{0,8}실패/i;
  const els = document.querySelectorAll('div, span, p, li, section, output, [role="alert"], [role="status"]');
  for (const el of els) {
    if (el.closest('[role="dialog"], [aria-modal="true"]')) continue;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0 || r.width > 720 || r.height > 320) continue;
    const t = (el.textContent || '').trim();
    if (!t || t.length > 220) continue;
    if (re.test(t)) return true;
  }
  return false;
}

// ── Sayfa içinde: tüm tile'ları "en eski → en yeni" sırada döndür ──────
// Her tile 3 durumdan biri:
//   'complete'   = http medya var (üretilmiş görsel/video)
//   'generating' = "12%" gibi yüzde metni (üretiliyor, medya yok)
//   'failed'     = "Başarısız / Olağan dışı etkinlik" uyarısı (politika reddi)
// En yeni sol-üstte; pozisyona göre sırala, ters çevir → en eski ilk.
// Başarısız ve üretilen tile'ları DA listeye katmak şart: aksi halde
// pozisyon imleci kayar ve sıra bozulur.
// MAIN world — self-contained, yan etkisiz.
function flowCollectTiles() {
  // GİZLİ sekmede tarayıcı render adımları çalışmaz → loading="lazy" görseller HİÇ yüklenmez
  // (tile medyası/URL'i gecikir, indirme bekler). Eager'a çevir: yalnız yüklemeyi öne alır,
  // görünür sekmede davranış farkı yaratmaz. Her taramada çalışır → yeni tile'ları da kapsar.
  try { document.querySelectorAll('img[loading="lazy"]').forEach(i => { i.loading = 'eager'; }); } catch (_) {}
  const refNames = (window.__afRefImages || [])
    .map(r => ((r && r.name) || '').toLowerCase()).filter(n => n.length >= 4);
  const refStems = refNames.map(n => n.replace(/\.[a-z0-9]+$/, '')).filter(s => s.length >= 4);
  // v137: EN/BOY ORANI BAĞIMSIZ boyut kapısı (eski sabit 150x90..900x900 kapısı yalnız
  // 16:9 kartına uyuyordu; 9:16 ve 1:1 kartlar eleniyordu → o oranlarda indirme çalışmıyordu).
  // Ölçüt: makul kenar + ALAN + aşırı uzun/geniş (banner/şerit) eleme + tam ekran eleme.
  const tileSizeOk = (r) => {
    const w = r.width, h = r.height;
    if (w < 90 || h < 90) return false;                 // ikon/avatar/rozet
    if (w * h < 14000) return false;                    // eski 150x90 alan eşiğinin karşılığı
    if (w > 1600 || h > 1600) return false;             // sayfa/bölüm kapsayıcısı
    if (w / h > 4 || h / w > 4) return false;           // banner/şerit (gerçek kart 0.56-1.78 arası)
    if (w > window.innerWidth * 0.9 && h > window.innerHeight * 0.85) return false; // tam ekran
    return true;
  };

  // KESİN referans kimliği: seçim sırasında yakalanan Flow medya kimlikleri (?name=). Feed
  // thumbnail'ında dosya adı yazmadığından ad-bazlı eşleşme referansları kaçırıyor; kimlik sabit.
  const refIds = window.__afRefIds || {};
  const refIdOf = u => (u && (u.match(/(?:[?&]name=|flow-content\.google\/[a-z]+\/)([^&?/]+)/i) || [])[1]) || '';
  // BAŞARISIZ / OLAĞAN DIŞI metinleri — ÇOK DİLLİ. Arayüz dili Google hesabına bağlı;
  // eski liste yalnız TR/EN'di → diğer dillerde başarısız tile HİÇ algılanmıyor, numara
  // ve bekleme davranışı şaşıyordu. Latin-dışı script'ler TR/EN arayüzünde görünemez →
  // eklemek güvenli (i18n kuralı); Latin kelimeler ayırt edici seçildi. Grid-tile boyut
  // filtresi (150-900×90-900) yanlış pozitifleri zaten eler.
  const FAIL_RE = /başarısız|olağan dışı|olagan disi|unusual activity|failed|fehlgeschlagen|ungewöhnlich|échou|inhabituelle|non riuscit|insolit|no se pudo|inusual|falhou|incomum|не удалось|необычн|失敗|失败|실패|विफल|असामान्य|oluşturulam|olusturulam|üretilemedi|uretilemedi|couldn.t (?:be )?(?:creat|generat)|could not (?:be )?(?:creat|generat)|unable to (?:creat|generat)|konnte nicht erstellt|impossible de (?:créer|génér)|no se pudo (?:crear|generar)/;
  // GEÇİCİ (throttle) uyarı metinleri — tile SONRA tamamlanır, sabırla beklenir.
  const THROTTLE_RE = /olağan dışı|olagan disi|unusual activity|yoğun|yogun|ungewöhnlich|inhabituelle|insolit|inusual|incomum|необычн|異常|비정상|असामान्य|high demand/;
  const items = [];
  // ÖNCELİK: gerçek medya (complete) > üretiliyor > başarısız > referans.
  // Gerçek görsel asla 'başarısız' diye atlanmamalı; başarısız bir tile'da
  // gerçek medya yoksa zaten complete'e takılmaz. Üretiliyor, complete'i
  // ezmez ama complete de üretiliyor placeholder'ını ezmez (ikisi de yüksek).
  // REFERANS, geçici durumları (failed/generating) EZER (yüklenen referans kısa süre
  // 'başarısız' görünse bile 'reference' kalsın → numarayı şişirmesin, indirilmesin);
  // ama COMPLETE en üstte (gerçek görsel yanlışlıkla referans sanılıp atlanmasın).
  const rank = { complete: 5, reference: 4, generating: 3, failed: 2 };

  // v113 (yalnız VİDEO modunda): % kutusu ile poster/kart kutusu 24px köşe eşiğinden farklı
  // hizalanabiliyor → AYNI tile 1 'complete' + 1 'generating' olarak İKİ konum tüketip numarayı
  // kaydırıyordu. Kesişim alanı, KÜÇÜK kutunun >= %60'ı ise aynı tile kabul edilir. Görsel
  // (Control) akışında davranış AYNEN eski (yalnız __afVideoOnly açıkken devrede).
  const overlapsSameTile = (it, rect) => {
    // v128: ESKİDEN yalnız VIDEO modunda açıktı. FLOW v2 GÖRSEL akışında da yüzde kutusu ile
    // kart kutusu 24px köşe eşiğinden fazla kayabiliyor → AYNI görsel 1 complete + 1 generating
    // olarak İKİ konum tüketiyordu: (a) numara +1 kayıyor (ilk görsel 0002 aldı), (b) hayalet
    // generating tile hedef olup indirmeyi üretim bitene dek bekletiyordu (hibrit çalışmıyordu).
    // Izgarada gerçek komşu tile'lar örtüşmez → birleştirme güvenli.
    const w1 = it.width || 0, h1 = it.height || 0, w2 = rect.width || 0, h2 = rect.height || 0;
    if (!w1 || !h1 || !w2 || !h2) return false;
    const ix = Math.min(it.left + w1, rect.left + w2) - Math.max(it.left, rect.left);
    const iy = Math.min(it.top + h1, rect.top + h2) - Math.max(it.top, rect.top);
    if (ix <= 0 || iy <= 0) return false;
    return (ix * iy) >= 0.6 * Math.min(w1 * h1, w2 * h2);
  };
  // v128: tile etiket metni (üretim prompt'u). Kapsayıcı dikdörtgenleri BİR KEZ hesaplanır
  // → maliyet O(kapsayıcı) rect + O(tile×kapsayıcı) aritmetik (ucuz). pushItem DEĞİŞMEZ.
  const ICON_RE = /\b(favorite|favorite_border|more_vert|play_arrow|pause|download|edit|add|check|close|cancel|image|videocam|movie|hd|volume_up|volume_off|fullscreen|star|bookmark|share|delete|content_copy|refresh|autorenew|sync|arrow_back|arrow_forward|expand_more|expand_less)\b/gi;
  function tileTextIndex() {
    if (tileTextIndex._i) return tileTextIndex._i;
    const out = [];
    try {
      for (const c of document.querySelectorAll('flow-grid-tile-container, flow-tile-container, [class*="grid-tile"], flow-image-tile, flow-video-tile')) {
        const r = c.getBoundingClientRect();
        if (r.width < 40 || r.height < 40) continue;
        out.push({ el: c, top: r.top, left: r.left, right: r.right, bottom: r.bottom, area: r.width * r.height });
      }
    } catch (_) {}
    return (tileTextIndex._i = out);
  }
  // İkon elemanlarını (mat-icon, material-icons, svg) ATLAYARAK etiket metnini topla.
  // textContent kullanmak ligature'ları ("more_vert", "favorite"...) metne karıştırıyordu.
  function labelTextOf(el) {
    try {
      let out = '';
      const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
      let node;
      while ((node = w.nextNode())) {
        const p = node.parentElement;
        if (!p) continue;
        if (p.closest('mat-icon, .material-icons, .material-symbols-outlined, i, svg, style, script')) continue;
        const t = (node.nodeValue || '').trim();
        if (t) { out += (out ? ' ' : '') + t; if (out.length > 220) break; }
      }
      return out.replace(/\s+/g, ' ').trim().slice(0, 140);
    } catch (_) { return ''; }
  }
  // v132: tile'ın KENDİ elemanından yukarı yürüyerek etiket metnini oku — geometrik
  // eşleme tahminine hiç gerek kalmaz (numara bu metinden geldiği için ıskalama = yanlış numara).
  function tileTextFromEl(el) {
    try {
      if (!el) return '';
      // 0) ELEMANIN KENDİ etiketleri (Flow medyaya prompt'u alt/title/aria-label olarak yazabiliyor)
      const own = ['alt', 'title', 'aria-label']
        .map(a => (el.getAttribute && el.getAttribute(a)) || '')
        .filter(v => v && v.trim().length >= 6).join(' ').replace(/\s+/g, ' ').trim();
      const cont = el.closest('flow-grid-tile-container, flow-tile-container, [class*="grid-tile"], flow-image-tile, flow-video-tile, [class*="tile"]');
      const base = cont || (function () {           // kapsayıcı bulunamazsa: makul boyutta ata
        let p = el;
        for (let i = 0; i < 6 && p; i++) {
          const r = p.getBoundingClientRect();
          if (r.width >= 120 && r.height >= 90) return p;
          p = p.parentElement;
        }
        return null;
      })();
      if (!base) return own.slice(0, 140);
      const foot = base.querySelector('flow-tile-hover-footer');
      const lbl = (foot && labelTextOf(foot)) || labelTextOf(base) || '';
      // v141: Flow footer etiketini "…" ile KIRPIYOR (ölçüm: 33 karakter). Kırpılmış
      // başlık, aynı temadaki promptlar arasında ayırt edici değil ve numarayı yanlış
      // prompta bağlıyordu. Elemanın kendi alt/title/aria-label değeri kırpılmamış
      // metni taşıyabiliyor ve o değer ELEMANA ait olduğu için komşu tile'dan kirlenmez
      // → hangisi UZUNSA o kullanılır (attribute yoksa davranış aynen eskisi gibi).
      // v142: attribute yalnız footer metni YOKKEN yedek. (v141'de "uzun olanı seç"
      // denmişti; Flow'un sabit arayüz etiketi 1 karakter uzun olduğu için prompt
      // başlığını eziyordu.) Metin yine de teşhis için toplanır.
      return String(lbl || own || '').slice(0, 400);
    } catch (_) { return ''; }
  }
  function tileTextAt(top, left) {
    try {
      const idx = tileTextIndex();
      if (!idx.length) return '';
      // 1) KAPSAMA: tile'ın SOL ÜST noktası hangi kapsayıcıların içindeyse, EN KÜÇÜĞÜ.
      //    (Kapsayıcı footer + kenar boşluğu yüzünden tile görselinden büyüktür → köşe
      //     mesafesi eşiği ıskalıyordu; kapsama bundan etkilenmez.)
      let best = null, bestArea = Infinity;
      for (const e of idx) {
        if (top >= e.top - 12 && top <= e.bottom + 12 && left >= e.left - 12 && left <= e.right + 12) {
          if (e.area < bestArea) { bestArea = e.area; best = e.el; }
        }
      }
      // 2) YEDEK: kapsama tutmadıysa köşesi EN YAKIN olan (geniş eşik)
      if (!best) {
        let bestD = 1e9;
        for (const e of idx) {
          const d = Math.abs(e.top - top) + Math.abs(e.left - left);
          if (d < bestD) { bestD = d; best = e.el; }
        }
        if (bestD > 220) return '';
      }
      if (!best) return '';
      const foot = best.querySelector('flow-tile-hover-footer');
      const tx = (foot && labelTextOf(foot)) || labelTextOf(best);
      return tx;
    } catch (_) { return ''; }
  }
  function pushItem(rect, st, isVideo, key, failKind, srcEl) {
    for (const it of items) {
      if ((Math.abs(it.top - rect.top) < 24 && Math.abs(it.left - rect.left) < 24) || overlapsSameTile(it, rect)) {
        if (rank[st] > rank[it.state]) { it.state = st; if (st === 'complete') { it.isVideo = isVideo; it.key = key || it.key; } if (st === 'failed') it.failKind = failKind || it.failKind; }
        if (srcEl && !it.el) it.el = srcEl;   // v132: metin için kaynak eleman
        return;
      }
    }
    items.push({ top: rect.top, left: rect.left, width: rect.width, height: rect.height, state: st, isVideo, key: key || '', failKind: failKind || '', el: srcEl || null });
  }

  // Tile'ın yakınında referans dosya adı etiketi var mı? (Yüklenen referans
  // görseli feed'de görünür; onu indirilebilir 'complete' saymayız.)
  // ZOOM-BAĞIMSIZ: eski eşik `pr.width < 620` idi ama %33 zoom'da responsive container'lar
  // getBoundingClientRect'te ~3x genişliyor (innerWidth ~3x) → referansın container'ı >620
  // oluyor, etiket bulunamıyor → referans 'complete'/'failed' sanılıp indiriliyor + numarayı
  // şişiriyor. textContent.length zoom'dan ETKİLENMEZ → onu kullan: container metni KISA
  // (tek kart = ~dosya adı + birkaç etiket) VE referans adını içeriyorsa → referans. Büyük
  // container (çok tile) metni uzundur → elenir; üretilen tile'ların metni dosya adı içermez.
  // v173 KART SINIRI (kullanici logu 2026-09-15, 9 video + 1 referans): Flow v2'de her kartin
  // (flow-grid-tile-container) HEMEN USTUNDE birkac karti tutan bir SATIR div'i var (canli DOM:
  // kart metni 71, satir 140 = 2 kart). Medyasiz kartin kendi metni neredeyse bos oldugu icin
  // yukari yuruyus satira cikiyor, satirin kisa metninde referansin dosya adi bulunuyor ve
  // referansla AYNI SATIRDAKI kartlar 'reference' sayiliyordu (harita 0:r 1:r 2:r, gercek
  // referans 1 tane). Yuruyus artik kartin kendi kapsayicisinda durur. Medyadan baslayan
  // yuruyus zaten 5. adimda o kapsayiciya ulasiyordu, orada sonuc BIREBIR ayni.
  function nearRefLabel(el) {
    if (!refNames.length) return false;
    const bound = (el && el.closest) ? el.closest('flow-grid-tile-container') : null;
    let p = el;
    for (let i = 0; i < 6 && p; i++) {
      const pr = p.getBoundingClientRect();
      const tx = (p.textContent || '').toLowerCase();
      if (pr.width > 0 && tx.length < 260 && refNames.some(n => tx.includes(n))) return true;
      if (p === bound) break;
      p = p.parentElement;
    }
    return false;
  }

  // 1) Tamamlanmış medya — http/blob/data <img> ve <video>
  document.querySelectorAll('img, video').forEach(m => {
    const r = m.getBoundingClientRect();
    if (!tileSizeOk(r)) return;
    if (m.closest('[role="dialog"], [aria-modal="true"], .cdk-overlay-pane')) return;   // v137: picker overlay'i de ele
    const tag = m.tagName.toLowerCase();
    const isVideo = tag === 'video';
    if (tag === 'img') {
      const src = m.src || '';
      if (!/^(https?|blob|data):/.test(src)) return;
      if (/^data:image\/svg/i.test(src)) return;          // svg = ikon
      // Statik placeholder/doku varlıkları (gerçek üretim DEĞİL) → indirme. "perlin" = Flow'un
      // gri-bulanık gürültü placeholder dokusu; gerçek görsel sanılıp 0010 diye iniyordu
      // (kullanıcı zararlı dosya sanabilir). Gerçek görseller .../api/trpc/media?name=... URL'i.
      if (/favicon|avatar|logo|sprite|perlin|placeholder|noise|skeleton|texture|gradient/i.test(src)) return;
      const alt = (m.getAttribute('alt') || '').toLowerCase();
      const tt  = (m.getAttribute('title') || '').toLowerCase();
      if (refStems.some(st => alt.includes(st) || tt.includes(st))) return;
    }
    const mkey = (tag === 'img' ? (m.src || '') : (m.currentSrc || m.src || ''));
    if (nearRefLabel(m)) { pushItem(r, 'reference', false); return; }
    const mid = refIdOf(mkey);
    if (mid && refIds[mid]) { pushItem(r, 'reference', false); return; } // yüklenen referans → indirme
    // VİDEO-ONLY (v105 düzeltmesi): eski kural "her tamamlanmış <img> = referans" idi; ama Flow
    // üretilen videoyu çoğu kez <video> DEĞİL <img> POSTER olarak gösterir → üretilen videolar da
    // referans sanılıp HİÇBİR ŞEY inmiyordu. Doğru kural: referans SİNYALİ (üstteki nearRefLabel /
    // refIds / alt-title stem kontrolleri) olan img → referans; sinyalsiz img → üretilen VİDEO
    // posteri → complete + isVideo=true (VIDEO modunda tek çıktı videodur → 720p menü anahtarı).
    pushItem(r, 'complete', isVideo || !!window.__afVideoOnly, mkey, '', m);
  });
  // 1b) background-image ile gösterilen tile'lar (bazı complete tile'lar böyle)
  document.querySelectorAll('div, a, span').forEach(el => {
    const r = el.getBoundingClientRect();
    if (!tileSizeOk(r)) return;
    if (el.closest('[role="dialog"], [aria-modal="true"], .cdk-overlay-pane')) return;   // v137
    const b = getComputedStyle(el).backgroundImage || '';
    if (!b.includes('url(')) return;
    if (/\.svg|data:image\/svg/i.test(b)) return;
    const bgUrl = (b.match(/url\(["']?([^"')]+)["']?\)/) || [])[1] || '';
    // v113 KÖK DÜZELTME (LevelDB + video-karesi kanıtı): <img> yolundaki placeholder
    // filtresi bu bg-image yolunda YOKTU. Flow, KUYRUKTAKİ video işini perlin.png
    // arka planlı tile olarak gösteriyor → 'complete' sanılıyordu; tüm perlin tile'ları
    // AYNI URL'i taşıdığından kimlik-dedup sonrası konum sayımına tam +1 phantom giriyordu
    // (20.07 koşusu: 2. prompt'un videosu "0003" numarası aldı) ve görünür-tile guard'ını
    // şişirip erken bırakıyordu. Ayrıca bu sahte-complete tile hedef seçilip menü
    // probe'unda dlRefKeys'e 'k:...perlin.png' kaydı düşürüyordu (state'te kanıtı duruyor).
    if (/favicon|avatar|logo|sprite|perlin|placeholder|noise|skeleton|texture|gradient/i.test(bgUrl)) return;
    if (nearRefLabel(el)) { pushItem(r, 'reference', false); return; }
    const bgId = refIdOf(bgUrl);
    if (bgId && refIds[bgId]) { pushItem(r, 'reference', false); return; } // yüklenen referans → indirme
    // VİDEO-ONLY (v105): bg-image tile de video POSTERİ olabilir → referans sinyali yoksa
    // complete + isVideo=true (eski "hep referans say" kuralı videoları da atlatıyordu).
    pushItem(r, 'complete', !!window.__afVideoOnly, bgUrl, '', el);
  });

  // 2) Üretiliyor placeholder'ları ("12%")
  document.querySelectorAll('div, span').forEach(el => {
    const t = (el.textContent || '').trim();
    if (!/^\d{1,3}\s*%$/.test(t)) return;
    if (el.querySelector('*')) return; // yaprak eleman
    if (el.closest('[role="dialog"], [aria-modal="true"], .cdk-overlay-pane')) return;   // v137
    let box = el, r = el.getBoundingClientRect();
    for (let i = 0; i < 6 && box; i++) {
      const br = box.getBoundingClientRect();
      if (br.width >= 120 && br.height >= 90) { r = br; break; }
      box = box.parentElement;
    }
    if (r.width < 80) return;
    pushItem(r, 'generating', false, '', '', box || el);
  });

  // 2b) ÜRETİLMEKTE OLAN KARTI YAPISINDAN TANI (v144) ─ NUMARALANDIRMANIN TEMELİ
  // ÖLÇÜM (kullanıcı nabzı 2026-09-06): 7 prompt gönderilmişken galeride yalnız 2 kart
  // görünüyordu ve İKİSİ DE 'complete' idi → toplayıcı üretilmekte olan kartı HİÇ
  // görmüyordu. Sebep: yukarıdaki (2) dedektörü "12%" gibi bir YÜZDE METNİ arıyor; Flow v2
  // (Angular Material) yüzdesiz bir ilerleme göstergesi çiziyor.
  // SONUÇ: konum sayımı yalnız TAMAMLANMIŞLARI sayıyordu, yani "konum" = TAMAMLANMA SIRASI
  // oluyordu ve geç biten prompt en büyük numarayı alıyordu (rapor: 13. prompt → 0020).
  // Eski sıra guard'ı bunu, tüm kartlar oluşana kadar İNDİRMEYİ BEKLETEREK gizliyordu;
  // guard kalkınca sorun görünür oldu. Doğru çözüm beklemek değil, kartı GÖRMEK.
  // Hata kartını yanlışlıkla 'generating' saymamak için POZİTİF sinyal şartı var
  // (ilerleme göstergesi); yoksa dokunulmaz. pushItem rank'e göre birleştirir
  // (complete 5 > reference 4 > generating 3) → mevcut kayıtlar BOZULMAZ.
  const genDbg = [];
  const blankCards = [];   // v173: medyasız + sinyalsiz kart adayları (aşağıda, hata taramasından SONRA eklenir)
  document.querySelectorAll('flow-grid-tile-container, flow-tile-container').forEach(el => {
    const r = el.getBoundingClientRect();
    if (!tileSizeOk(r)) return;
    if (el.closest('[role="dialog"], [aria-modal="true"], .cdk-overlay-pane')) return;
    if (el.querySelector('img[src^="http"], img[src^="blob"], img[src^="data:image"], video')) return; // medyası var
    if (nearRefLabel(el)) { pushItem(r, 'reference', false, '', '', el); return; }
    const busy = el.querySelector('[role="progressbar"], mat-progress-spinner, mat-progress-bar, mat-spinner, .mat-mdc-progress-spinner, .mat-mdc-progress-bar, [class*="progress"], [class*="spinner"], [class*="loading"], [class*="pending"], [class*="skeleton"]');
    if (genDbg.length < 3) {
      const cls = (typeof el.className === 'string' ? el.className : '').trim().split(/s+/).slice(0, 2).join('.');
      genDbg.push(el.tagName.toLowerCase() + (cls ? '.' + cls : '') +
        '(' + Math.round(r.width) + 'x' + Math.round(r.height) + ')' +
        (busy ? ' SİNYAL:' + busy.tagName.toLowerCase() : ' SİNYAL-YOK') +
        ' çocuk:' + [...el.children].map(c => c.tagName.toLowerCase()).slice(0, 4).join(','));
    }
    if (!busy) { blankCards.push({ r, el }); return; }   // v173: hata kartı olabilir → karar hata taramasından sonra
    pushItem(r, 'generating', false, '', '', el);
  });

  // 3) Başarısız tile'lar — DERİN TARAMA (v112). ESKİ dedektör yalnız document
  // .querySelectorAll('div,span,p') görüyordu: hata kartının metni SHADOW DOM içindeyse
  // veya "Başarısız" başlığı div/span/p DIŞI bir öğedeyse (h4/strong/custom element) kart
  // HİÇ algılanmıyordu → boşluk sayılamıyor, sonraki video hatalının numarasını alıyordu
  // (kullanıcı ekran görüntüsü: kartta "Başarısız / Ses üretilemedi" yazdığı halde numara
  // atlamıyordu; 0003→0004 arası 12sn = ne guard ne hayalet-bekletme tetiklenmiş = kart
  // taramada YOK). YENİ: TreeWalker ile METİN düğümleri taranır (etiketten bağımsız,
  // doğal olarak en-içteki) + tüm shadow root'lar da gezilir. Kutu-yürüyüşü ve grid-boyut
  // kapıları AYNEN korunur (banner/toast yine elenir).
  {
    const failEls = [];
    const roots = [document];
    const findShadowRoots = (root) => {
      let all = [];
      try { all = root.querySelectorAll('*'); } catch (_) { return; }
      for (const el of all) if (el.shadowRoot) { roots.push(el.shadowRoot); findShadowRoots(el.shadowRoot); }
    };
    try { findShadowRoots(document); } catch (_) {}
    for (const root of roots) {
      try {
        const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        let n;
        while ((n = w.nextNode())) {
          const tv = (n.nodeValue || '').toLowerCase();
          if (!tv || !FAIL_RE.test(tv)) continue;
          const el = n.parentElement;
          if (!el) continue;
          // v113: <script>/<style> içeriği de METİN DÜĞÜMÜDÜR — sayfanın Next.js veri bloğu
          // FAIL_RE'yle eşleşip (kanıt: FAILDIAG probes tag:SCRIPT box:3952x2873) taramayı
          // kirletiyordu. Kart metni bu etiketlerde olamaz → atla.
          if (/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|TITLE)$/.test(el.tagName)) continue;
          if (el.closest && el.closest('[role="dialog"], [aria-modal="true"]')) continue;
          failEls.push(el);
        }
      } catch (_) {}
    }
    for (const el of failEls) {
      const t = (el.textContent || '').toLowerCase();
      let box = el, r = el.getBoundingClientRect();
      for (let i = 0; i < 8 && box; i++) {
        const br = box.getBoundingClientRect();
        if (br.width >= 120 && br.height >= 90) { r = br; break; }
        box = box.parentElement;
      }
      // SADECE GRID BOYUTUNDAKİ başarısız tile (complete ile AYNI ölçü aralığı 150-900×90-900).
      // Geniş "olağan dışı etkinlik" banner/toast'ları yanlışlıkla 'failed' sayılıp numarayı
      // şişirmesin diye elenir (v106 davranışı korunur).
      if (!tileSizeOk(r)) continue;
      // REFERANS: yüklenen referans görseli yüklenirken kısa süre 'başarısız' görünebiliyor;
      // dosya-adı etiketi yakındaysa 'reference' işaretle (slot tüketmez, indirilmez).
      if (nearRefLabel(box || el)) { pushItem(r, 'reference', false); continue; }
      // THROTTLE ("olağan dışı/yoğun" — GEÇİCİ) ile GERÇEK hatayı ayır (v1.1.1 davranışı).
      const throttle = THROTTLE_RE.test(t);
      pushItem(r, 'failed', false, '', throttle ? 'throttle' : 'genuine', box || el);
    }
  }

  // v173 SİNYALSİZ KART = 'pending' (kullanıcı logu 2026-09-15, 9 video + 1 referans).
  // Flow v2 video kartını DAKİKALARCA ne medya ne ilerleme göstergesiyle çiziyor (KART SAYIMI:
  // "medyasız kapsayıcı ... SİNYAL-YOK", ekran görüntüsünde 7 koyu kart). Bu kartlar hiç
  // sayılmayınca 8. ve 9. video en eski tamamlananlar olarak konum 0 ve 1'i aldı → 0001, 0002.
  // Kart her durumda gönderim sırasındaki YERİNİ tutar → listeye 'pending' olarak girer:
  // indirilmez, hata sayılmaz, yalnız arkasındaki kartların konumuna katılır. Hata kartı da
  // medyasız ve sinyalsizdir → aday yalnız HİÇBİR mevcut kayıtla örtüşmüyorsa eklenir, yani
  // complete/generating/failed/reference kayıtlarının durumu, kutusu ve sırası BİREBİR aynı.
  // "Sonradan indir" bu kayıtları görmez (downloadPipeline manuel akışta eler).
  for (const b of blankCards) {
    if (items.some(it => (Math.abs(it.top - b.r.top) < 24 && Math.abs(it.left - b.r.left) < 24) || overlapsSameTile(it, b.r))) continue;
    items.push({ top: b.r.top, left: b.r.left, width: b.r.width, height: b.r.height, state: 'pending', isVideo: false, key: '', failKind: '', el: b.el });
  }

  // BAŞARISIZ tile'lara KARARLI kimlik ver. Başarısız tile'ın görsel URL'i (key) YOKTUR →
  // pipeline onu KONUMLA anahtarlıyordu; galeri büyüyünce konum kayıp AYNI başarısız tile
  // birden çok kez sayılıyor, genIdx şişip numara kayıyordu. Çözüm: sıralı (en eski→yeni)
  // listede her başarısız tile'ı, kendisinden ÖNCEKİ son COMPLETE tile'ın KALICI kimliğine
  // (name=) + ofsete sabitle. Grid sırası kaymadığından bu anahtar kararlı → tek kez sayılır.
  // (Bu blok aşağıdaki sıralamadan ÖNCE — items henüz oluşturma sırasında; aşağıda yeniden
  //  sıralanıp ters çevriliyor, o yüzden kimliği SIRALAMA SONRASI atamalıyız → aşağı taşındı.)

  // SIRALAMA: en yeni sol-üstte → top, sonra left ile sırala (en yeni ilk), ters çevir
  // (en eski ilk). flowDownloadNth ile BİREBİR AYNI olmalı ki pipeline'ın idx'i ile
  // tıklanan tile aynı olsun. (Kusursuz çalışan ORİJİNAL sıralama budur — DEĞİŞTİRME.)
  // v147: RTL ARAYÜZ — ızgara aynalanır (en yeni sol-üstte DEĞİL, sağ-üstte) → satır
  // içinde yeniden eskiye SAĞDAN SOLA gider. LTR'de bayrak false, sıralama BİREBİR aynı.
  const GRTL = (() => { try { return getComputedStyle(document.body).direction === 'rtl'; } catch (_) { return false; } })();
  // v170 SATIR BANDI (kullanici logu 2026-09-12, 45 prompt, 43 uretilemedi, 42 "0043" indi).
  // Hata kartinin kutusu kartin IC dolgusundan geliyor (FAILDIAG box 456x201) ve satirdaki
  // gorsellerden birkac piksel ASAGIDA basliyor. Eski siralama `top` degerini birebir
  // karsilastirdigi icin hata karti kendi satirinin EN ESKISI sayiliyordu; saginda duran ve
  // henuz inmemis daha eski gorsel bu yuzden bir konum fazla aliyordu. Satir artik dikey
  // konumdan cikariliyor: `top` farki 1px icindeyse her zaman ayni satir (eski davranis);
  // daha fazlaysa ogenin ORTASI satir capasinin yuksekligi icinde kaliyorsa yine ayni satir.
  // Satirdaki kartlarin ayni hizada durdugu izgarada sonuc eski siralamayla BIREBIR ayni.
  // flowDownloadNth icinde AYNI blok var; ikisi birlikte degismeli.
  {
    const byTop = items.slice().sort((a, b) => a.top - b.top);
    let row = -1, rTop = 0, rH = 0;
    for (let i = 0; i < byTop.length; i++) {
      const it = byTop[i];
      const h = it.height || 0;
      if (row >= 0 && (it.top - rTop <= 1 || it.top + h / 2 <= rTop + rH)) { it._row = row; continue; }
      row++; rTop = it.top;
      const hs = [];
      for (let j = i; j < byTop.length && byTop[j].top - rTop <= 1; j++) hs.push(byTop[j].height || 0);
      hs.sort((a, b) => a - b);
      rH = hs[Math.floor((hs.length - 1) / 2)];   // alt medyan: satira tasan tek bir buyuk kutu capayi sisirmesin
      it._row = row;
    }
  }
  items.sort((a, b) => a._row - b._row || (GRTL ? b.left - a.left : a.left - b.left));
  items.reverse();
  // BAŞARISIZ tile'lara KARARLI kimlik (en eski→yeni sıralı listede): kendisinden önceki
  // son COMPLETE tile'ın name kimliği + ofset. Konum-bazlı anahtarın kaymasından doğan
  // tekrar-sayma (genIdx şişmesi → numara kayması) böylece ortadan kalkar.
  {
    const nmeOf = u => {   // v174: downloadPipeline stableId ile AYNI (hata kartı çapası adres ekiyle değişmesin)
      const m = (u && u.match(/(?:[?&]name=|flow-content\.google\/[a-z]+\/)([^&?/]+)/i)) || [];
      if (m[1]) return m[1];
      const a = u && u.match(/\/asb\/([A-Za-z0-9_-]{20,})/);
      return a ? 'asb:' + a[1] : (u || '');
    };
    let anchor = 'head', off = 0;
    for (const it of items) {
      if (it.state === 'complete' && it.key) { anchor = nmeOf(it.key); off = 0; }
      else if (it.state === 'failed' && !it.key) { it.key = 'F|' + anchor + '|' + (off++); }
    }
  }
  // v133 TEŞHİS: ilk complete tile için DOM yapısı (metin boş kalırsa sebebi bu satırdan çıkar)
  let dbgOnce = '';
  try {
    const f = items.find(x => x.state === 'complete' && x.el);
    if (f) {
      const chain = [];
      let p = f.el;
      for (let i = 0; i < 6 && p; i++) {
        const r = p.getBoundingClientRect();
        const cls = (typeof p.className === 'string' && p.className) ? '.' + p.className.trim().split(/\s+/).slice(0, 2).join('.') : '';
        chain.push(p.tagName.toLowerCase() + cls + '(' + Math.round(r.width) + 'x' + Math.round(r.height) + ')');
        p = p.parentElement;
      }
      const cont = f.el.closest('flow-grid-tile-container, flow-tile-container, [class*="grid-tile"]');
      dbgOnce = chain.join(' < ') +
        ' || kapsayıcı:' + (cont ? cont.tagName.toLowerCase() : 'YOK') +
        ' footer:' + (cont && cont.querySelector('flow-tile-hover-footer') ? 'VAR' : 'YOK') +
        ' || ham:"' + String((cont || f.el).textContent || '').replace(/\s+/g, ' ').trim().slice(0, 70) + '"' +
        ' || alt:"' + String((f.el.getAttribute && f.el.getAttribute('alt')) || '').slice(0, 40) + '"';
    }
  } catch (e) { dbgOnce = '(döküm hatası: ' + (e && e.message) + ')'; }
  // v144: medyasız tile kapsayıcıları ne içeriyor? ("SİNYAL-YOK" çıkarsa Flow'un üretim
  // kartında ilerleme göstergesi yok demektir → seçici listesi genişletilmeli.)
  const genDbgOut = genDbg.length ? genDbg.join(' || ') : '(medyasız tile kapsayıcısı yok)';
  return items.map((it, i2) => ({
    state: it.state, isVideo: !!it.isVideo, key: it.key || '', failKind: it.failKind || '',
    top: Math.round(it.top), left: Math.round(it.left),
    txt: tileTextFromEl(it.el) || tileTextAt(it.top, it.left),
    dbg: i2 === 0 ? dbgOnce : '',
    gdbg: i2 === 0 ? genDbgOut : '',
    pm: i2 === 0 ? !!window.__afPipeMark : undefined   // v174: indirme kurulumu sayfada duruyor mu
  }));
}

// ── Sayfa içinde: oldestIndex'teki tile'ı sağ tık → İndir → kalite ile indir ──
// flowCollectTiles ile AYNI sıralama mantığı (eleman referanslı).
// qualityToken: '1k'|'2k'|'4k' (görsel) veya '720'|'1080'|'4k' (video).
// MAIN world — self-contained.
async function flowDownloadNth(targetInfo, qualityToken, forceVideo, pickerGuard) {
  const wait = ms => (window.__afWait ? window.__afWait(ms) : new Promise(r => setTimeout(r, ms))); // arka plan sekmede kısılmayan bekleme
  const norm = s => (s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').trim();
  const refNames = (window.__afRefImages || [])
    .map(r => ((r && r.name) || '').toLowerCase()).filter(n => n.length >= 4);
  const refStems = refNames.map(n => n.replace(/\.[a-z0-9]+$/, '')).filter(s => s.length >= 4);
  // v137: EN/BOY ORANI BAĞIMSIZ boyut kapısı (eski sabit 150x90..900x900 kapısı yalnız
  // 16:9 kartına uyuyordu; 9:16 ve 1:1 kartlar eleniyordu → o oranlarda indirme çalışmıyordu).
  // Ölçüt: makul kenar + ALAN + aşırı uzun/geniş (banner/şerit) eleme + tam ekran eleme.
  const tileSizeOk = (r) => {
    const w = r.width, h = r.height;
    if (w < 90 || h < 90) return false;                 // ikon/avatar/rozet
    if (w * h < 14000) return false;                    // eski 150x90 alan eşiğinin karşılığı
    if (w > 1600 || h > 1600) return false;             // sayfa/bölüm kapsayıcısı
    if (w / h > 4 || h / w > 4) return false;           // banner/şerit (gerçek kart 0.56-1.78 arası)
    if (w > window.innerWidth * 0.9 && h > window.innerHeight * 0.85) return false; // tam ekran
    return true;
  };

  // KESİN referans kimlikleri (seçim sırasında yakalanan ?name= id'leri) — flowCollectTiles
  // ile AYNI hariç tutma burada da uygulanır (eskiden yalnız collect'te vardı → menü yolunda
  // referans tile 'complete' sanılabiliyordu).
  const refIds = window.__afRefIds || {};
  const refIdOf = u => (u && (u.match(/(?:[?&]name=|flow-content\.google\/[a-z]+\/)([^&?/]+)/i) || [])[1]) || '';
  // flowCollectTiles ile AYNI çok dilli başarısız-metin listesi (iki fonksiyon özdeş kural).
  const FAIL_RE = /başarısız|olağan dışı|olagan disi|unusual activity|failed|fehlgeschlagen|ungewöhnlich|échou|inhabituelle|non riuscit|insolit|no se pudo|inusual|falhou|incomum|не удалось|необычн|失敗|失败|실패|विफल|असामान्य|oluşturulam|olusturulam|üretilemedi|uretilemedi|couldn.t (?:be )?(?:creat|generat)|could not (?:be )?(?:creat|generat)|unable to (?:creat|generat)|konnte nicht erstellt|impossible de (?:créer|génér)|no se pudo (?:crear|generar)/;

  // GÜVENLİK (eş zamanlılık): referans picker'ı (medya kütüphanesi dialog'u) AÇIKSA
  // indirme menüsünü AÇMA. Aksi halde ⋮ menüsü ile picker birbirini kapatır (kullanıcı
  // raporu: "indir'e basamadan picker açılınca menü kapanıyor"). Üretim önceliklidir →
  // indirme YOL VERİR; pipeline kısa süre sonra tekrar dener. Normal akışta (picker
  // kapalı) bu kontrolün hiçbir etkisi yoktur.
  // YALNIZCA OTO modda (pickerGuard=true): manuel "Tümünü indir"de üretim çalışmaz →
  // picker hiç açılamaz; orada bu kontrolü ÇALIŞTIRMAYIZ ki yanlış-pozitif (ör. sayfada
  // "tüm medya" metni) indirmeyi sonsuza dek 'picker-open' ile bekletmesin.
  if (pickerGuard) {
    const pickerDialogOpen = [...document.querySelectorAll('[role="dialog"],[aria-modal="true"]')]
      .some(d => {
        const r = d.getBoundingClientRect();
        if (r.width < 340 || r.height < 220) return false;
        if (window.getComputedStyle(d).display === 'none') return false;
        return /steme ekle|add to prompt|öğeleri ara|search items|tüm medya|all media|yüklemeler|upload media/i
          .test(d.textContent || '');
      });
    if (pickerDialogOpen) return { success: false, error: 'picker-open' };
  }

  // KARARLI KİMLİK: flowCollectTiles ile AYNI mantık (medya URL'inin ?name=XXX kimliği).
  // Hedef tile'ı KONUM yerine KİMLİĞE göre seçmek için (konum iki tarama arasında kayar).
  // v174: downloadPipeline ile AYNI (asb adresinde '=' sonrası ek kimliğe girmez).
  const stableId = (u) => { const m = (u || '').match(/(?:[?&]name=|flow-content\.google\/[a-z]+\/)([^&?/]+)/i); if (m) return m[1]; const a = (u || '').match(/\/asb\/([A-Za-z0-9_-]{20,})/); return a ? 'asb:' + a[1] : (u || ''); };

  // ── tile listesini eleman referanslı oluştur (flowCollectTiles ile AYNI) ──
  const items = [];
  const rank = { complete: 5, reference: 4, generating: 3, failed: 2 }; // referans > failed/generating (flowCollectTiles ile AYNI)
  // v113: flowCollectTiles ile AYNI örtüşme-dedup'u (yalnız __afVideoOnly modunda; iki
  // toplayıcının konum/sıra listesi BİREBİR aynı kalmalı ki idx'ler eşleşsin).
  const overlapsSameTile = (it, rect) => {
    // v128: ESKİDEN yalnız VIDEO modunda açıktı. FLOW v2 GÖRSEL akışında da yüzde kutusu ile
    // kart kutusu 24px köşe eşiğinden fazla kayabiliyor → AYNI görsel 1 complete + 1 generating
    // olarak İKİ konum tüketiyordu: (a) numara +1 kayıyor (ilk görsel 0002 aldı), (b) hayalet
    // generating tile hedef olup indirmeyi üretim bitene dek bekletiyordu (hibrit çalışmıyordu).
    // Izgarada gerçek komşu tile'lar örtüşmez → birleştirme güvenli.
    const w1 = it.width || 0, h1 = it.height || 0, w2 = rect.width || 0, h2 = rect.height || 0;
    if (!w1 || !h1 || !w2 || !h2) return false;
    const ix = Math.min(it.left + w1, rect.left + w2) - Math.max(it.left, rect.left);
    const iy = Math.min(it.top + h1, rect.top + h2) - Math.max(it.top, rect.top);
    if (ix <= 0 || iy <= 0) return false;
    return (ix * iy) >= 0.6 * Math.min(w1 * h1, w2 * h2);
  };
  function pushItem(el, rect, st, isVideo, key) {
    for (const it of items) {
      if ((Math.abs(it.top - rect.top) < 24 && Math.abs(it.left - rect.left) < 24) || overlapsSameTile(it, rect)) {
        if (rank[st] > rank[it.state]) { it.state = st; if (st === 'complete') { it.isVideo = isVideo; it.el = el; it.key = key || it.key; } }
        return;
      }
    }
    items.push({ el, top: rect.top, left: rect.left, width: rect.width, height: rect.height, state: st, isVideo, key: key || '' });
  }
  function nearRefLabel(el) {
    // flowCollectTiles ile AYNI (zoom-bağımsız): eski `pr.width < 620` eşiği %33 zoom'da
    // bozuluyordu (container rect ~3x büyür → referans etiketi bulunamaz → referans
    // 'complete' sanılır). textContent uzunluğu zoom'dan etkilenmez.
    if (!refNames.length) return false;
    const bound = (el && el.closest) ? el.closest('flow-grid-tile-container') : null;   // v173: flowCollectTiles ile AYNI kart sınırı
    let p = el;
    for (let i = 0; i < 6 && p; i++) {
      const pr = p.getBoundingClientRect();
      const tx = (p.textContent || '').toLowerCase();
      if (pr.width > 0 && tx.length < 260 && refNames.some(n => tx.includes(n))) return true;
      if (p === bound) break;
      p = p.parentElement;
    }
    return false;
  }
  // 1) complete medya — http/blob/data <img>, <video>
  document.querySelectorAll('img, video').forEach(m => {
    const r = m.getBoundingClientRect();
    if (!tileSizeOk(r)) return;
    if (m.closest('[role="dialog"], [aria-modal="true"], .cdk-overlay-pane')) return;   // v137: picker overlay'i de ele
    const tag = m.tagName.toLowerCase();
    const isVideo = tag === 'video';
    if (tag === 'img') {
      const src = m.src || '';
      if (!/^(https?|blob|data):/.test(src)) return;
      if (/^data:image\/svg/i.test(src)) return;
      // Statik placeholder/doku varlıkları (gerçek üretim DEĞİL) → indirme. "perlin" = Flow'un
      // gri-bulanık gürültü placeholder dokusu; gerçek görsel sanılıp 0010 diye iniyordu
      // (kullanıcı zararlı dosya sanabilir). Gerçek görseller .../api/trpc/media?name=... URL'i.
      if (/favicon|avatar|logo|sprite|perlin|placeholder|noise|skeleton|texture|gradient/i.test(src)) return;
      const alt = (m.getAttribute('alt') || '').toLowerCase();
      const tt  = (m.getAttribute('title') || '').toLowerCase();
      if (refStems.some(st => alt.includes(st) || tt.includes(st))) return;
    }
    const mkey = (tag === 'img' ? (m.src || '') : (m.currentSrc || m.src || ''));
    if (nearRefLabel(m)) { pushItem(m, r, 'reference', false); return; }
    const mid = refIdOf(mkey);
    if (mid && refIds[mid]) { pushItem(m, r, 'reference', false); return; } // yüklenen referans → indirme
    // VİDEO-ONLY (v105): flowCollectTiles ile AYNI kural — sinyalsiz <img> video POSTERİ sayılır.
    pushItem(m, r, 'complete', isVideo || !!window.__afVideoOnly, mkey);
  });
  // 1b) background-image tile'ları
  document.querySelectorAll('div, a, span').forEach(el => {
    const r = el.getBoundingClientRect();
    if (!tileSizeOk(r)) return;
    if (el.closest('[role="dialog"], [aria-modal="true"], .cdk-overlay-pane')) return;   // v137
    const b = getComputedStyle(el).backgroundImage || '';
    if (!b.includes('url(')) return;
    if (/\.svg|data:image\/svg/i.test(b)) return;
    const bgUrl = (b.match(/url\(["']?([^"')]+)["']?\)/) || [])[1] || '';
    // v113: flowCollectTiles ile AYNI placeholder filtresi (perlin = kuyruk placeholder'ı,
    // 'complete' sanılıp konum/sayım şişiriyordu — iki toplayıcı özdeş kural taşımalı)
    if (/favicon|avatar|logo|sprite|perlin|placeholder|noise|skeleton|texture|gradient/i.test(bgUrl)) return;
    if (nearRefLabel(el)) { pushItem(el, r, 'reference', false); return; }
    const bgId = refIdOf(bgUrl);
    if (bgId && refIds[bgId]) { pushItem(el, r, 'reference', false); return; } // yüklenen referans → indirme
    // VİDEO-ONLY (v105): flowCollectTiles ile AYNI kural.
    pushItem(el, r, 'complete', !!window.__afVideoOnly, bgUrl);
  });
  // 2) üretiliyor (%)
  document.querySelectorAll('div, span').forEach(el => {
    const t = (el.textContent || '').trim();
    if (!/^\d{1,3}\s*%$/.test(t)) return;
    if (el.querySelector('*')) return;
    if (el.closest('[role="dialog"], [aria-modal="true"], .cdk-overlay-pane')) return;   // v137
    let box = el, r = el.getBoundingClientRect();
    for (let i = 0; i < 6 && box; i++) {
      const br = box.getBoundingClientRect();
      if (br.width >= 120 && br.height >= 90) { r = br; break; }
      box = box.parentElement;
    }
    if (r.width < 80) return;
    pushItem(box || el, r, 'generating', false);
  });
  // 3) başarısız — DERİN TARAMA (v112, flowCollectTiles ile AYNI kural): TreeWalker ile
  // metin düğümleri (etiketten bağımsız) + shadow root'lar; kutu/boyut kapıları aynı.
  {
    const failEls = [];
    const roots = [document];
    const findShadowRoots = (root) => {
      let all = [];
      try { all = root.querySelectorAll('*'); } catch (_) { return; }
      for (const el of all) if (el.shadowRoot) { roots.push(el.shadowRoot); findShadowRoots(el.shadowRoot); }
    };
    try { findShadowRoots(document); } catch (_) {}
    for (const root of roots) {
      try {
        const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        let n;
        while ((n = w.nextNode())) {
          const tv = (n.nodeValue || '').toLowerCase();
          if (!tv || !FAIL_RE.test(tv)) continue;
          const el = n.parentElement;
          if (!el) continue;
          // v113: <script>/<style> içeriği de METİN DÜĞÜMÜDÜR — sayfanın Next.js veri bloğu
          // FAIL_RE'yle eşleşip (kanıt: FAILDIAG probes tag:SCRIPT box:3952x2873) taramayı
          // kirletiyordu. Kart metni bu etiketlerde olamaz → atla.
          if (/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|TITLE)$/.test(el.tagName)) continue;
          if (el.closest && el.closest('[role="dialog"], [aria-modal="true"]')) continue;
          failEls.push(el);
        }
      } catch (_) {}
    }
    for (const el of failEls) {
      let box = el, r = el.getBoundingClientRect();
      for (let i = 0; i < 8 && box; i++) {
        const br = box.getBoundingClientRect();
        if (br.width >= 120 && br.height >= 90) { r = br; break; }
        box = box.parentElement;
      }
      if (!tileSizeOk(r)) continue;
      pushItem(box || el, r, 'failed', false);
    }
  }
  // KRİTİK: flowCollectTiles ile BİREBİR AYNI sıralama kullanılmalı; aksi halde
  // pipeline'ın 'idx'i ile buradaki items[idx] FARKLI tile'a denk gelir → yanlış tile'a
  // tıklanır / complete tile atlanır. (Kusursuz çalışan ORİJİNAL sıralama: top || left.)
  // v147: RTL ARAYÜZ — ızgara aynalanır (en yeni sol-üstte DEĞİL, sağ-üstte) → satır
  // içinde yeniden eskiye SAĞDAN SOLA gider. LTR'de bayrak false, sıralama BİREBİR aynı.
  const GRTL = (() => { try { return getComputedStyle(document.body).direction === 'rtl'; } catch (_) { return false; } })();
  // v170 SATIR BANDI: flowCollectTiles'taki blokla BIREBIR ayni (aciklama orada).
  {
    const byTop = items.slice().sort((a, b) => a.top - b.top);
    let row = -1, rTop = 0, rH = 0;
    for (let i = 0; i < byTop.length; i++) {
      const it = byTop[i];
      const h = it.height || 0;
      if (row >= 0 && (it.top - rTop <= 1 || it.top + h / 2 <= rTop + rH)) { it._row = row; continue; }
      row++; rTop = it.top;
      const hs = [];
      for (let j = i; j < byTop.length && byTop[j].top - rTop <= 1; j++) hs.push(byTop[j].height || 0);
      hs.sort((a, b) => a - b);
      rH = hs[Math.floor((hs.length - 1) / 2)];   // alt medyan: satira tasan tek bir buyuk kutu capayi sisirmesin
      it._row = row;
    }
  }
  items.sort((a, b) => a._row - b._row || (GRTL ? b.left - a.left : a.left - b.left));
  items.reverse(); // en eski ilk

  // Hedef tile'ı KİMLİĞE göre seç — KÖK DÜZELTME. Eskiden KONUMA (top/left) göre
  // seçiliyordu; ama galeri iki tarama arasında kayınca (yeni görsel render, Flow
  // sanallaştırması, bulk indirmede en-alta kaydırma) en yakın konumdaki tile BAŞKA
  // bir görsel oluyordu → yanlış tile indiriliyor, doğru tile atlanıyor, başkası
  // İKİNCİ kez iniyordu (sırasız + tekrar + kusurlu numara). Kimlik (?name=XXX) konumdan
  // BAĞIMSIZ ve kalıcıdır → her zaman DOĞRU görsel tıklanır. Konum yalnızca kimlik
  // yokken (eski çağrı / name'siz blob) yedek; o da olmazsa idx.
  let tile = null;
  if (targetInfo && typeof targetInfo === 'object') {
    if (targetInfo.key) {
      const want = stableId(targetInfo.key);
      if (want) {
        tile = items.find(it => it.state === 'complete' && it.key && stableId(it.key) === want) || null;
        // Kimlik verildi ama bu görsel ŞU AN DOM'da yok (sanallaştırıldı/kaydı) →
        // KONUMA DÜŞME (yanlış tile indirebilir). 'target-gone' dön → pipeline yeniden
        // tarayıp doğru tile'ı taze konum+kimlikle bulur (sıra/numara bozulmaz).
        if (!tile) return { success: false, error: 'target-gone', count: items.length };
      }
    }
    if (!tile) {
      let best = null, bestD = Infinity;
      for (const it of items) {
        const d = Math.abs(it.top - targetInfo.top) + Math.abs(it.left - targetInfo.left);
        if (d < bestD) { bestD = d; best = it; }
      }
      tile = (best && bestD <= 60) ? best : items[targetInfo.idx];
    }
  } else {
    tile = items[targetInfo];
  }
  if (!tile)                      return { success: false, error: 'tile-missing', count: items.length };
  if (tile.state !== 'complete')  return { success: false, error: 'not-complete', state: tile.state };
  const target = tile.el;

  // ── SADECE HOVER (sağ tık YOK) ──
  // Sağ tık / tile gövdesine basmak Flow'da ÇOKLU SEÇİM moduna sokuyor
  // ("sil" çubuğu) ve toplu düşük çözünürlüklü ZIP indiriyordu. Bunun yerine
  // tile'ın üstüne SADECE gelerek (hover) köşedeki ⋮ (more_vert) butonunu
  // görünür kılıp ona tıklıyoruz. Tile gövdesine ASLA basmıyoruz.
  // Flow sağ-üst bildirimleri ("Çözünürlük artırma işlemi tamamlandı / Görüntünüz
  // indirildi") o köşedeki tile'ın üstünü kapatıp hover'ı/menüyü engelliyor → ÖNCE
  // bu bildirimleri kapat. Aksi halde o tile indirilemiyor.
  function dismissToasts() {
    // NOT: norm() aksanları siler; bu yüzden anahtar kelimeler ASCII (normalize) halde.
    const KW = ['goruntunuz indirildi', 'cozunurluk artirma', 'image downloaded',
                'resolution upscal', 'goruntunuz', 'cozunurluk', 'indirildi', 'downloaded'];
    const hasKW = txt => { const n = norm(txt); return KW.some(k => n.includes(k)); };
    let acted = 0;

    // 1) Varsa "Kapat/Close" butonuna bas (sağ-üst toast bölgesi)
    [...document.querySelectorAll('button, [role="button"], a')].forEach(b => {
      const t = norm(b.textContent), al = norm(b.getAttribute('aria-label') || '');
      const isClose = t === 'kapat' || t === 'close' || t === 'dismiss' ||
                      al.includes('kapat') || al.includes('close') || al.includes('dismiss');
      if (!isClose) return;
      const r = b.getBoundingClientRect();
      if (r.width <= 0 || r.top > window.innerHeight * 0.55 || r.right < window.innerWidth * 0.45) return;
      let p = b, ok = false;
      for (let i = 0; i < 6 && p; i++) { if (hasKW(p.textContent)) { ok = true; break; } p = p.parentElement; }
      if (ok) { try { b.click(); acted++; } catch (_) {} }
    });

    // 2) Kapatma butonu olmayan/inatçı toast'ları DOM'da ETKİSİZLEŞTİR:
    //    anahtar kelimeli metnin, position fixed/absolute olan üst kapsayıcısını gizle.
    //    pointer-events:none → elementFromPoint/hover artık alttaki tile'ı yakalar.
    const seen = new Set();
    [...document.querySelectorAll('span, div, p, li')].forEach(el => {
      // sadece KENDİ doğrudan metni anahtar kelime içeren yaprak benzeri elemanlar
      const ownText = [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('');
      if (!ownText.trim() || !hasKW(ownText)) return;
      // pozisyonlanmış (fixed/absolute) en yakın üst kapsayıcıyı bul
      let p = el, host = null;
      for (let i = 0; i < 8 && p; i++) {
        const cs = window.getComputedStyle(p);
        if (cs.position === 'fixed' || cs.position === 'absolute') host = p;
        p = p.parentElement;
      }
      const node = host || el;
      if (seen.has(node)) return; seen.add(node);
      const r = node.getBoundingClientRect();
      // tüm sayfayı/galeriyi kaplayan kapsayıcıya DOKUNMA (yanlışlıkla içeriği gizleme)
      if (r.width > window.innerWidth * 0.9 && r.height > window.innerHeight * 0.85) return;
      // sadece üst bölgedeki toast'lar
      if (r.top > window.innerHeight * 0.5) return;
      try {
        node.style.setProperty('pointer-events', 'none', 'important');
        node.style.setProperty('opacity', '0', 'important');
        node.style.setProperty('display', 'none', 'important');
        acted++;
      } catch (_) {}
    });

    // 3) DİLDEN BAĞIMSIZ YAPISAL (RU vb.): üst-sağ köşede KÜÇÜK (toast boyutu) pozisyonlanmış
    //    bir kapsayıcı içindeki "close" ligature'lı kapat butonuna bas. Metin tanınmasa da
    //    çalışır (RU "closeЗакрыть", DE "closeSchließen" ...). İndirme akışında üst-sağdaki
    //    tek küçük öğe toast olduğundan güvenli. TR/EN yukarıdaki adımlarla zaten kapanır.
    // v147: yön bayrağı döngü DIŞINDA (her buton için getComputedStyle çağırmayalım)
    const TRTL = (() => { try { return getComputedStyle(document.body).direction === 'rtl'; } catch (_) { return false; } })();
    [...document.querySelectorAll('button, [role="button"]')].forEach(b => {
      const t = norm(b.textContent), al = norm(b.getAttribute('aria-label') || '');
      const isClose = t.includes('close') || t === 'kapat' || t === 'dismiss' ||
                      al.includes('close') || al.includes('kapat') || al.includes('dismiss') ||
                      /закрыть|закрий|schliessen|schließen|cerrar|fermer|fechar|chiudi|sluiten|閉じ|閉じる|닫기|关闭|關閉|إغلاق|đóng/.test(t + ' ' + al);
      if (!isClose) return;
      const r = b.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return;
      // v147: RTL arayüzde toast SOL üstte belirir → yatay şart yalnız LTR'de uygulanır.
      if (r.top > window.innerHeight * 0.45) return;                                  // üst bölge
      if (!TRTL && r.right < window.innerWidth * 0.5) return;                         // LTR: sağ köşe
      // küçük + pozisyonlanmış (fixed/absolute) bir toast kapsayıcısı içinde mi?
      let p = b, host = null;
      for (let i = 0; i < 8 && p; i++) {
        const cs = window.getComputedStyle(p);
        if (cs.position === 'fixed' || cs.position === 'absolute') { host = p; break; }
        p = p.parentElement;
      }
      if (!host) return;
      const hr = host.getBoundingClientRect();
      if (hr.width > window.innerWidth * 0.6 || hr.height > window.innerHeight * 0.5) return; // toast küçük olmalı
      try { b.click(); acted++; } catch (_) {}
    });
    return acted;
  }
  dismissToasts();

  try { target.scrollIntoView({ block: 'center' }); } catch (_) {}
  // v110 HIZ: MANUEL toplu indirmede (pickerGuard=false → üretim çalışmıyor, sayfa sakin)
  // menü etkileşim beklemeleri kısaltılır — kullanıcı isteği: "indirme biter bitmez sonrakine
  // geç". OTO modda (üretimle eş zamanlı, sayfa hareketli) eski süreler AYNEN korunur.
  const fastUi = !pickerGuard;
  await wait(fastUi ? 250 : 450);
  dismissToasts(); // scroll sonrası yeni gelmiş olabilir
  const rr = target.getBoundingClientRect();
  const cx = rr.left + rr.width / 2, cy = rr.top + rr.height / 2;
  let hit = document.elementFromPoint(cx, cy) || target;

  // ── menü satırı bul (kendi metni eşleşen en kısa/yaprak eleman) ──
  function findRow(pred) {
    const cands = [...document.querySelectorAll('[role="menuitem"],[role="option"],li,button,a,span,div')];
    const pool = cands.filter(el => {
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return false;
      if (window.getComputedStyle(el).display === 'none') return false;
      const t = norm(el.textContent);
      return t && pred(t);
    });
    pool.sort((a, b) => (a.textContent || '').length - (b.textContent || '').length);
    // AÇIK MENÜ KATMANI ÖNCELİĞİ: sayfanın SABİT metinleri (tile üzerindeki "720p" rozeti,
    // araç çubuğundaki download ikonu vb.) menü satırı SANILMASIN — menü hiç açılmadan
    // eşleşip tıklanınca indirme tetiklenmeden "başarılı" raporlanıyordu (sahte başarı).
    // Gerçek açık menü/popup/dialog içindeki eşleşme varsa ONU kullan; yoksa eski davranışa
    // (en kısa metin) düş → dil/yapı farklı olsa da eski çalışma şekli bozulmaz.
    const MENU_SCOPE = '[role="menu"],[role="listbox"],[role="dialog"],[aria-modal="true"],[data-radix-popper-content-wrapper]';
    const inMenu = pool.filter(el => el.closest(MENU_SCOPE));
    return inMenu[0] || pool[0] || null;
  }
  function hover(el) {
    const r = el.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2;
    ['pointerover', 'mouseover', 'pointerenter', 'mouseenter', 'pointermove', 'mousemove'].forEach(t =>
      el.dispatchEvent(new MouseEvent(t, { bubbles: true, clientX: x, clientY: y })));
  }
  function click(el) {
    const r = el.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2;
    ['pointerover', 'mouseover', 'pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach(t =>
      el.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 })));
  }

  // Teşhis: o an görünen tüm menü satırlarının metinleri
  function visibleMenuTexts() {
    return [...document.querySelectorAll('[role="menuitem"],[role="menuitemradio"],[role="option"],li,button,a')]
      .filter(el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; })
      .map(el => norm(el.textContent).slice(0, 28))
      .filter(Boolean)
      .filter((v, i, a) => a.indexOf(v) === i)
      .slice(0, 50);
  }

  // ── Tile içindeki tıklanabilir elemanlar (teşhis + ⋮ butonu bulma) ──
  function within(el) {
    const b = el.getBoundingClientRect();
    if (b.width <= 0 || b.height <= 0) return false;
    const ex = b.left + b.width / 2, ey = b.top + b.height / 2;
    return ex >= rr.left - 6 && ex <= rr.right + 6 && ey >= rr.top - 6 && ey <= rr.bottom + 6;
  }
  function tileButtons() {
    return [...document.querySelectorAll('button,[role="button"],[aria-haspopup],a,[tabindex]')]
      .filter(within)
      .map(el => ({
        t:  norm(el.textContent).slice(0, 18),
        al: norm(el.getAttribute('aria-label') || '').slice(0, 18),
        w:  Math.round(el.getBoundingClientRect().width),
        h:  Math.round(el.getBoundingClientRect().height)
      }))
      .slice(0, 18);
  }
  function findTileMenuBtn() {
    // KESİN ⋮ butonu: KÜÇÜK (≤60px), tile'ın ÜST-SAĞ bölgesinde, metni
    // "more_vert" içeren (veya aria-label diğer/seçenek). Sayfa çubuğundaki
    // filtre/ayar/arama gibi butonları (geniş veya farklı konumda) ELEMEZ.
    const BLACK = ['search', 'ara', 'filter', 'filtre', 'settings', 'ayar',
                   'favorite', 'favori', 'redo', 'undo', 'yeniden', 'delete',
                   'sil', 'share', 'paylas', 'animasyon', 'help', 'add'];
    const MRTL = (() => { try { return getComputedStyle(document.body).direction === 'rtl'; } catch (_) { return false; } })();   // v147: döngü dışında
    const cands = [...document.querySelectorAll('button,[role="button"],[aria-haspopup]')]
      .filter(within)
      .filter(el => {
        const b = el.getBoundingClientRect();
        if (b.width > 60 || b.height > 60) return false;                 // küçük ikon butonu
        const ex = b.left + b.width / 2, ey = b.top + b.height / 2;
        // v147: RTL'de kart içi düzen aynalanır → ⋮ SOL üsttedir. LTR'de aynı kural.
        if (!MRTL && ex < rr.left + rr.width * 0.4) return false;         // LTR: sağ yarı (RTL'de iki taraf da geçerli)
        if (ey > rr.top + rr.height * 0.6) return false;                 // üst bölge
        const t  = norm(el.textContent);
        const al = norm(el.getAttribute('aria-label') || '');
        const isMore = t.includes('more_vert') || al.includes('diğer') ||
                       al.includes('diger') || al.includes('seçenek') ||
                       al.includes('secenek') || al.includes('options') || al.includes('menu');
        if (!isMore) return false;
        if (BLACK.some(w => t.includes(w) && !t.includes('more_vert'))) return false;
        return true;
      });
    // menü köşesine en yakın olanı tercih et (LTR: sağ-üst, RTL: sol-üst)
    {
      const dx = (r) => MRTL ? Math.abs(r.left - rr.left) : Math.abs(rr.right - r.right);
      cands.sort((a, b) => {
        const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
        return (dx(ra) + Math.abs(ra.top - rr.top)) - (dx(rb) + Math.abs(rb.top - rr.top));
      });
    }
    return cands[0] || null;
  }
  // Açık menüde İndir YOK ama Yeniden adlandır/Çöp/Sil VAR → indirilemez tile
  // (referans yüklemesi / başarısız). Hızlı atlamak için ayrı işaret.
  function menuHasOnlyManage() {
    const txts = visibleMenuTexts();
    const joined = txts.join(' | ');
    const hasManage = /yeniden adlandir|cop kutusu|cöp kutusu|^sil| sil/.test(joined);
    const hasIndir  = txts.some(t => t.includes('indir') || t.includes('download'));
    return hasManage && !hasIndir;
  }
  function hoverHit() {
    ['pointerover', 'mouseover', 'pointerenter', 'mouseenter', 'pointermove', 'mousemove'].forEach(t =>
      hit.dispatchEvent(new MouseEvent(t, { bubbles: true, clientX: cx, clientY: cy })));
  }

  // "İndir" / "Download" — ikon ligatürü önek olabilir (ör. "downloadindir").
  const indirPred = t => t.includes('indir') || t.includes('download');
  const isVid     = !!forceVideo || !!tile.isVideo;
  const qpred     = t => t.includes(qualityToken);

  // Bağlam menüsü (⋮) şu an açık mı? — re-render onu kapattıysa anlamak için.
  function ctxMenuOpen() {
    if (findRow(indirPred)) return true;
    return [...document.querySelectorAll('[role="menu"]')].some(m => {
      const r = m.getBoundingClientRect(); return r.width > 0 && r.height > 0;
    });
  }

  // TEK denemede tüm zincir: ⋮ aç → İndir bul → çözünürlük alt-menüsü aç → kaliteyi tıkla.
  // KÖK NEDEN (log: İndir bulunuyor ama çözünürlük bulunamıyor → submenu-not-found,
  // İnen dosya 0): Flow yeni bir üretim TAMAMLANINCA galeriyi YENİDEN ÇİZİYOR ve o anda
  // AÇIK olan ⋮/alt menüyü KAPATIYOR. Eskiden çözünürlük adımı menüyü yeniden açmadığı
  // için tek bir re-render indirmeyi düşürüyordu. Artık zincir TEK birim: kopması hâlinde
  // DIŞ DÖNGÜ taze ⋮ açıp tekrar dener → indirme, sakin bir ana denk gelince tamamlanır.
  async function openMenuAndPickQuality() {
    // a) ⋮ menüsünü aç + İndir'i bul
    let indir = null;
    for (let attempt = 0; attempt < 3 && !indir; attempt++) {
      // Bu sırada yeni bir toast gelmiş olabilir → temizle ve hit'i tazele
      // (toast tile'ı kapatırsa hover ⋮ butonunu açığa çıkarmaz).
      dismissToasts();
      hit = document.elementFromPoint(cx, cy) || target;
      hoverHit();
      await wait(fastUi ? (attempt === 0 ? 220 : 180) : (attempt === 0 ? 350 : 250));
      const mb = findTileMenuBtn();
      if (!mb) continue;
      click(mb);
      // Menü açılır açılmaz İndir'i YAKALA — hızlı yokla (genelde 100-300ms'de belirir).
      for (let k = 0; k < 12 && !indir; k++) { await wait(110); indir = findRow(indirPred); }
      // Menü açıldı ama İndir yok, sadece yönetim (yeniden adlandır/sil) → indirilemez tile.
      if (!indir && menuHasOnlyManage()) return { status: 'no-indir' };
    }
    if (!indir) return { status: 'no-menu' };

    // b) Alt menüyü AÇ: İndir üzerine gel, hover'ı canlı tut (Radix/MUI alt menüsü
    //    pointerenter ile kısa gecikmeyle açılır). Olmazsa İndir'e tıklayıp dene.
    let qrow = null;
    for (let i = 0; i < 12 && !qrow; i++) { hover(indir); await wait(140); qrow = findRow(qpred); }
    if (!qrow) {
      click(indir); await wait(fastUi ? 320 : 500);
      for (let i = 0; i < 6 && !qrow; i++) { qrow = findRow(qpred); if (!qrow) await wait(250); }
    }
    // REFERANS TESPİTİ — VIDEO YOLUNDA DA (v107, "Sonradan indir hiç başlamıyor" kök nedeni):
    // videoOnly modunda referans kimlikleri kayıpsa (sayfa yenilendi / SW yeniden başladı;
    // feed thumbnail'ında dosya adı da yazmaz) REFERANS GÖRSELİ 'video' sanılır. GERÇEK
    // videoda İndir tıklanınca indirme doğrudan tetiklenir ve menü KAPANIR; görselde ise
    // alt menü AÇIK kalır ve 'orijinal boyut' satırı görünür. Eskiden isVid dalı bu kontrole
    // ulaşmadan 'video-direct' (SAHTE başarı) dönüyordu → tetik doğrulaması tile başına
    // 4×~25 sn boşa dönüyor, galerinin dibindeki onlarca referans bitmeden hiçbir video
    // inmiyordu. Kontrol AÇIK MENÜ katmanına sınırlı → sayfadaki rastgele metin tetikleyemez.
    if (!qrow) {
      const MSCOPE = '[role="menu"],[role="listbox"],[role="dialog"],[aria-modal="true"],[data-radix-popper-content-wrapper]';
      const openMenuTxt = [...document.querySelectorAll(MSCOPE)]
        .filter(d => { const r = d.getBoundingClientRect(); return r.width > 0 && r.height > 0; })
        .map(d => norm(d.textContent)).join(' ');
      if (/or[i]?jinal|original|оригинал/.test(openMenuTxt))
        return { status: 'is-reference', menu: visibleMenuTexts() };
    }
    // VIDEO: istenen kalite yoksa açık herhangi bir çözünürlük satırını seç.
    if (!qrow && isVid) qrow = findRow(t => /\d{3,4}\s*p/.test(t));

    if (!qrow) {
      // VIDEO: yukarıda İndir'e TIKLANDI → Flow videoyu DOĞRUDAN indirir (kalite alt menüsü
      // yoktur). Bu durumda menünün KAPANMIŞ olması NORMAL = indirme tetiklendi → BAŞARI say.
      // (Bu kontrol ctxMenuOpen'dan ÖNCE olmalı; aksi halde kapanan menü 'dismissed' sanılıp
      //  video sonsuza dek yeniden denenir ve hiç indirilmez.)
      if (isVid) return { status: 'video-direct' };
      // REFERANS ERKEN ÇIKIŞ: İndir alt menüsünde istenen kalite (ör. 4K) YOK ama "orjinal/
      // orijinal boyut" VAR (yüklenen referansın upscale'i yoktur). 3 tur boşuna deneme — HEMEN
      // referans olarak bildir → pipeline tek denemede atlar (kullanıcı: "3 kez deniyor").
      const mt = visibleMenuTexts().join(' ').toLowerCase();
      if (/or[i]?jinal|original/.test(mt)) return { status: 'is-reference', menu: visibleMenuTexts() };
      // Görsel: menü bu sırada KAPANDI mı? Kapandıysa (re-render) → dışarıda yeniden açılır.
      if (!ctxMenuOpen()) return { status: 'dismissed' };
      return { status: 'no-submenu' };
    }

    // c) Kaliteyi seç → indirme tetiklenir. Menünün anlık görüntüsü teşhis için döndürülür:
    // tık "başarılı" görünüp tarayıcıda indirme BAŞLAMAZSA pipeline bunu Logs'a yazar →
    // neye tıklandığı sonradan görülebilir (sahte başarı kök nedeni).
    const menuSnap = visibleMenuTexts();
    hover(qrow); await wait(fastUi ? 110 : 140); click(qrow); await wait(fastUi ? 300 : 500);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    return { status: 'ok', menu: menuSnap };
  }

  // DIŞ DÖNGÜ: menü re-render ile kapanırsa baştan (taze ⋮) aç ve tekrar dene.
  let lastMenu = [];
  for (let round = 0; round < 3; round++) {
    const res = await openMenuAndPickQuality();
    if (res.status === 'ok')           return { success: true, menu: res.menu };
    if (res.status === 'video-direct') {
      // VIDEO indirme İndir tıklamasıyla zaten TETİKLENDİ. Menüyü AÇIK BIRAKMA — aksi halde
      // ekranda ⋮ menüsü açık kalıyor ve kullanıcı "indir'e basılmadı, takıldı" sanıp Durdur'a
      // basıyor (log: "beklerken iptal edildi"). Escape menüyü kapatır; indirme etkilenmez.
      const menu = visibleMenuTexts();
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      return { success: true, videoDirect: true, menu };
    }
    if (res.status === 'no-indir') {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      return { success: false, error: 'menu-no-indir', menu: visibleMenuTexts() };
    }
    if (res.status === 'is-reference') {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      return { success: false, error: 'is-reference', menu: res.menu || visibleMenuTexts() };
    }
    lastMenu = visibleMenuTexts();
    // dismissed / no-submenu / no-menu → menüyü kapat, kısa bekle, baştan dene.
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await wait(400);
  }
  return { success: false, error: 'submenu-not-found', token: qualityToken, menu: lastMenu };
}

// ── Ajan modunu kapat → normal üretim moduna geç — MAIN world, self-contained ──
// Yeni Flow projesi "ajan" modunda açılır. İki adımda normal moda geçer:
//   1) Sağdaki ajan sohbet panelini kapat (başlıktaki X — "close" ikonu, sağ-üst)
//   2) Alt bardaki "Ajan" pilini kapat (button[aria-pressed="true"])
// Durum sinyali aria-pressed olduğu için dilden ve class adından bağımsızdır.
// Zaten normal moddaysak hiçbir şey yapmaz (idempotent). Hata olsa bile akışı
// engellemez; en kötü ihtimalle eski davranışa (ajan kutusuna yapıştırma) düşer.
async function ensureNormalModeOnFlow() {
  const wait = ms => (window.__afWait ? window.__afWait(ms) : new Promise(r => setTimeout(r, ms))); // arka plan sekmede kısılmayan bekleme

  function isVis(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const s = window.getComputedStyle(el);
    return r.width > 0 && r.height > 0 &&
           s.display !== 'none' && s.visibility !== 'hidden' &&
           parseFloat(s.opacity) > 0;
  }

  // React onClick'i doğrudan tetikle (kod tabanının her yerinde kullanılan yöntem)
  function fiberClick(el) {
    try {
      const fkey = Object.keys(el).find(k =>
        k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance'));
      if (!fkey) return false;
      let fiber = el[fkey];
      while (fiber) {
        const props = fiber.pendingProps || fiber.memoizedProps || {};
        if (typeof props.onClick === 'function') {
          props.onClick({
            type: 'click', isTrusted: true, target: el, currentTarget: el,
            bubbles: true, cancelable: true,
            preventDefault() {}, stopPropagation() {},
            stopImmediatePropagation() {}, persist() {},
            nativeEvent: { isTrusted: true, target: el, type: 'click' }
          });
          return true;
        }
        fiber = fiber.return;
      }
    } catch (_) {}
    return false;
  }
  // Gerçek kullanıcı tıklaması gibi tam olay dizisi gönder (Radix/React bunu bekler)
  function realClick(el) {
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const base = { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy, button: 0, buttons: 1 };
    const seq = ['pointerover', 'pointerenter', 'pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'];
    for (const type of seq) {
      try {
        const Ev = type.startsWith('pointer') ? PointerEvent : MouseEvent;
        el.dispatchEvent(new Ev(type, { ...base, buttons: type.includes('up') || type === 'click' ? 0 : 1 }));
      } catch (_) {
        try { el.dispatchEvent(new MouseEvent(type === 'click' ? 'click' : 'mousedown', base)); } catch (_) {}
      }
    }
  }
  function clickEl(el) {
    realClick(el);
    try { el.click(); } catch (_) {}
    fiberClick(el);
  }

  // ── Adım 1: Ajan (sağ) panelini kapat ──────────────────────────────
  // X butonu: sağ-üst bölgede, içinde "close" ikonu OLAN ya da metni/etiketi
  // kapatma anlamına gelen buton. Birden fazlaysa en sağdaki (panel başlığındaki).
  function findAgentCloseBtn() {
    const closeRe = /\bclose\b|kapat|schließen|cerrar|fermer|закры|chiudi|fechar/i;
    const ARTL = (() => { try { return getComputedStyle(document.body).direction === 'rtl'; } catch (_) { return false; } })();   // v147: döngü dışında
    const cands = [...document.querySelectorAll('button')].filter(isVis).filter(b => {
      const r = b.getBoundingClientRect();
      if (r.top >= 220) return false;
      if (!ARTL && r.left <= window.innerWidth * 0.45) return false;   // v147: yatay şart yalnız LTR
      const icon = b.querySelector('i');
      const iconTxt = icon ? icon.textContent.trim().toLowerCase() : '';
      const lbl = (b.getAttribute('aria-label') || b.title || b.textContent || '').toLowerCase();
      return iconTxt === 'close' || closeRe.test(lbl);
    });
    cands.sort((a, b) => b.getBoundingClientRect().right - a.getBoundingClientRect().right);
    return cands[0] || null;
  }

  // "Ajan" aç/kapa pili: aria-pressed taşıyan buton. Metni "Ajan"/"Agent" olanı
  // tercih et; yoksa alt yarıda (kompozisyon barı) duran pressed butonu al.
  // Bu pil YALNIZCA panel kapalıyken görünür → "panel kapandı" sinyali olarak da kullanılır.
  function findAgentToggle() {
    const btns = [...document.querySelectorAll('button[aria-pressed]')].filter(isVis);
    return btns.find(b => ['ajan', 'agent'].includes((b.textContent || '').trim().toLowerCase()))
        || btns.find(b => b.getBoundingClientRect().top > window.innerHeight * 0.5)
        || null;
  }

  const log = (...a) => console.log('[AutoFlow][ajan]', ...a);
  log('başladı | buton sayısı:', document.querySelectorAll('button').length,
      '| pressed buton:', document.querySelectorAll('button[aria-pressed]').length);

  // ══ FLOW v2 (Angular Material, 2026-09) ═══════════════════════════════
  // Ajan modu AÇIKKEN kompozisyonda üretim ayarları çipi (settings-trigger-button)
  // HİÇ ÇİZİLMEZ; prompt ajana gider, mod/model/oran/süre uygulanamaz. Yeni pil
  // aria-pressed TAŞIMIYOR → durum, ayar çipinin VARLIĞINDAN okunur (en doğru sinyal:
  // aslında ihtiyacımız olan tam olarak o çipin var olması). Kapatma ikonu artık
  // <i> değil <mat-icon> — eski seçici bu yüzden paneli hiç bulamıyordu.
  if (document.querySelector('flow-prompt-box')) {
    const vis1 = sel => [...document.querySelectorAll(sel)].filter(isVis)[0] || null;
    for (let i = 0; i < 8; i++) {                       // 1) Ajan yan panelini kapat
      if (vis1('button.settings-trigger-button')) break;
      const ARTL = (() => { try { return getComputedStyle(document.body).direction === 'rtl'; } catch (_) { return false; } })();   // v147: döngü dışında
      const cb = [...document.querySelectorAll('button')].filter(isVis).find(b => {
        const r = b.getBoundingClientRect();
        if (r.top >= 220) return false;
        if (!ARTL && r.left <= window.innerWidth * 0.45) return false;   // v147: yatay şart yalnız LTR
        return [...b.querySelectorAll('mat-icon, i')].some(ic => (ic.textContent || '').trim() === 'close');
      });
      if (!cb) break;
      log('v2: ajan paneli kapatılıyor');
      clickEl(cb); await wait(800);
    }
    for (let i = 0; i < 4; i++) {                       // 2) "Ajan" pilini kapat
      if (vis1('button.settings-trigger-button')) break;
      const chip = vis1('button.agent-mode-chip');
      if (!chip) { await wait(500); continue; }
      log('v2: "Ajan" pili kapatılıyor (deneme', i + 1, ')');
      // clickEl ÜÇ yoldan tıklar → aç/kapa pilinde çift tetikleme riski var.
      // Önce sade click, tutmazsa sentetik olay dizisi (v121 dersi).
      if (i % 2 === 0) { try { chip.click(); } catch (_) {} }
      else realClick(chip);
      await wait(900);
    }
    const okV2 = !!vis1('button.settings-trigger-button');
    log('v2 normal mod:', okV2 ? 'HAZIR (ayar çipi görünür)' : 'UYARI: ayar çipi hâlâ yok');
    return { success: okV2, v2: true, agentOff: okV2 };
  }

  // ── Adım 1: Ajan panelini kapat ────────────────────────────────────
  // Panel (ve dolayısıyla kapatma butonu) sayfa yüklenirken gecikebilir; bekle.
  // "Ajan" pili göründüyse panel zaten kapalıdır → kapatmaya gerek yok.
  let panelClosed = false;
  for (let i = 0; i < 20; i++) {
    if (findAgentToggle()) { log('pil görünür → panel kapalı, adım 1 atlanıyor'); panelClosed = true; break; }
    const cb = findAgentCloseBtn();
    if (cb) {
      log('kapatma butonu bulundu, tıklanıyor →', (cb.outerHTML || '').slice(0, 90));
      clickEl(cb);
      await wait(900);
      if (findAgentToggle()) { log('panel kapandı (pil belirdi)'); panelClosed = true; break; }
      log('tıklandı ama pil belirmedi, tekrar denenecek');
    } else {
      log('kapatma butonu yok (deneme', i + 1, ')');
    }
    await wait(500);
  }
  if (!panelClosed) log('UYARI: panel kapatılamadı (buton bulunamadı veya tıklama işe yaramadı)');

  // ── Adım 2: "Ajan" pilini kapat ────────────────────────────────────
  for (let i = 0; i < 12; i++) {
    const tg = findAgentToggle();
    if (!tg) { await wait(400); continue; }
    const pressed = tg.getAttribute('aria-pressed');
    log('pil durumu:', pressed);
    if (pressed === 'true') {
      log('"Ajan" pili kapatılıyor');
      clickEl(tg);
      await wait(700);
    } else {
      break; // false → normal mod hazır
    }
  }

  const finalTg = findAgentToggle();
  log('bitti | son pil durumu:', finalTg ? finalTg.getAttribute('aria-pressed') : '(pil yok)');
  return { success: true };
}

// ── Ortak ayar-paneli yardımcıları (MAIN world fonksiyonlarına gömülür) ──
// NOT: executeScript ile enjekte edilen fonksiyonlar self-contained olmalı, bu
// yüzden yardımcılar her fonksiyonun içinde tekrar tanımlanır.

// ── Üretim ayarlarını UYGULA — MAIN world, self-contained ──
// settings: { mode:'IMAGE'|'VIDEO', aspect:'<kod>', count:Sayı, duration:Saniye, model:'<isim>' }
// Mod/oran sabit id (…-trigger-KOD) ile; adet/süre sayısal sekme ETİKETİ ('x' vs 's')
// ile bulunur (ikisi de sayısal id taşıdığından id ile ayırt edilemez); model ikon
// temizlenmiş metinle eşleştirilir. Hepsi dilden/class'tan bağımsız.
async function applyGenerationSettings(settings) {
  const s = settings || {};
  const log = (...a) => console.log('[AutoFlow][ayar]', ...a);
  const wait = ms => (window.__afWait ? window.__afWait(ms) : new Promise(r => setTimeout(r, ms))); // arka plan sekmede kısılmayan bekleme
  const isVis = el => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const st = window.getComputedStyle(el);
    return r.width > 0 && r.height > 0 && st.display !== 'none' && st.visibility !== 'hidden' && parseFloat(st.opacity) > 0;
  };
  const norm = t => (t || '').replace(/[^\p{L}\p{N}]+/gu, '').toLowerCase();
  const cleanText = el => { const c = el.cloneNode(true); c.querySelectorAll('i').forEach(i => i.remove()); return (c.textContent || '').replace(/\s+/g, ' ').trim(); };
  function realClick(el) {
    const r = el.getBoundingClientRect();
    const base = { bubbles: true, cancelable: true, view: window, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0 };
    for (const type of ['pointerover', 'pointerenter', 'pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      try { const Ev = type.startsWith('pointer') ? PointerEvent : MouseEvent; el.dispatchEvent(new Ev(type, { ...base, buttons: (type.includes('up') || type === 'click') ? 0 : 1 })); } catch (_) {}
    }
  }
  function fiberClick(el) {
    try {
      const fk = Object.keys(el).find(k => k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance'));
      let f = el[fk];
      while (f) { const p = f.pendingProps || f.memoizedProps || {}; if (typeof p.onClick === 'function') { p.onClick({ type: 'click', isTrusted: true, target: el, currentTarget: el, bubbles: true, preventDefault() {}, stopPropagation() {}, nativeEvent: {} }); return; } f = f.return; }
    } catch (_) {}
  }
  const clickEl = el => { realClick(el); try { el.click(); } catch (_) {} fiberClick(el); };

  // ══════════════════════════════════════════════════════════════════════
  // FLOW v2 (Angular Material — 2026-09 arayüz değişikliği)
  // ══════════════════════════════════════════════════════════════════════
  // Eski arayüzdeki [role="tab"][id$="-trigger-XXX"] sekmeleri ve
  // button[aria-haspopup="menu"] ayar açıcısı KALKTI. Yenisi:
  //   açıcı  : <button class="settings-trigger-button">  ("Video · 360p · 8 sn. · x2")
  //   panel  : .cdk-overlay-pane > <flow-prompt-box-settings>
  //   gruplar: <mat-button-toggle-group role="radiogroup"> > <button role="radio" aria-checked>
  //   model  : <button class="mat-mdc-menu-trigger"> → <button class="mat-mdc-menu-item">
  // Seçenekler METİNLE DEĞİL Material ikon LIGATURE'ıyla ayırt edilir → DİLDEN BAĞIMSIZ.
  // Eski arayüzde bu dal hiç çalışmaz (settings-trigger-button yok) → davranış birebir korunur.
  const V2_ICON = {
    IMAGE: 'image', VIDEO: 'videocam',
    VIDEO_FRAMES: 'crop_free', VIDEO_REFERENCES: 'chrome_extension',
    LANDSCAPE: 'crop_16_9', LANDSCAPE_4_3: 'crop_landscape', SQUARE: 'crop_square',
    PORTRAIT_3_4: 'crop_portrait', PORTRAIT: 'crop_9_16'
  };
  const v2Clean = el => {
    const c = el.cloneNode(true);
    c.querySelectorAll('mat-icon, i').forEach(n => n.remove());
    return (c.textContent || '').replace(/\s+/g, ' ').trim();
  };
  function v2Pane() {
    const p = [...document.querySelectorAll('.cdk-overlay-pane')].filter(x => {
      if (!x.querySelector('flow-prompt-box-settings')) return false;
      const r = x.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
    return p.length ? p[p.length - 1] : null;
  }
  function v2Trigger() {
    // Ajan yan paneli açıkken sayfada İKİ açıcı olur; ana kompozisyon SOLDAKİdir.
    const t = [...document.querySelectorAll('button.settings-trigger-button')].filter(isVis);
    t.sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);
    return t[0] || null;
  }
  async function v2Open() {
    if (v2Pane()) return v2Pane();
    const t = v2Trigger();
    if (!t) return null;
    clickEl(t);
    for (let i = 0; i < 12; i++) { await wait(250); if (v2Pane()) return v2Pane(); }
    // clickEl üç yoldan tıkladığı için aç/kapa yapan tetikleyicide panel açılıp
    // hemen kapanmış olabilir → tek sade tıkla kendini düzelt (v121'deki kanıtlı çare).
    try { t.click(); } catch (_) {}
    for (let i = 0; i < 12; i++) { await wait(250); if (v2Pane()) return v2Pane(); }
    return null;
  }
  const v2Radios = pane => [...pane.querySelectorAll('button[role="radio"]')].filter(isVis);
  function v2ByIcon(pane, icon) {
    return v2Radios(pane).find(b =>
      [...b.querySelectorAll('mat-icon, i')].some(m => (m.textContent || '').trim() === icon)) || null;
  }
  function v2ByText(pane, pred) {
    return v2Radios(pane).find(b => {
      const lab = b.querySelector('.toggle-text');
      const txt = (lab ? (lab.textContent || '') : v2Clean(b)).replace(/\s+/g, ' ').trim();
      return pred(txt);
    }) || null;
  }
  async function v2Pick(el, what) {
    if (!el) { log('v2 bulunamadı:', what); return false; }
    if (el.getAttribute('aria-checked') === 'true') return true;   // zaten seçili → dokunma
    clickEl(el); await wait(520);
    return true;
  }
  async function v2Model(pane, want) {
    const trig = [...pane.querySelectorAll('button.mat-mdc-menu-trigger')].filter(isVis)[0];
    if (!trig) { log('v2 model menüsü yok'); return false; }
    if (norm(v2Clean(trig)) === norm(want)) return true;           // zaten seçili
    const readItems = () =>
      [...document.querySelectorAll('button.mat-mdc-menu-item, [role="menuitem"]')].filter(isVis);
    clickEl(trig);
    let items = [];
    for (let i = 0; i < 10 && !items.length; i++) { await wait(250); items = readItems(); }
    if (!items.length) {                                           // aç/kapa yutulmuş olabilir
      try { trig.click(); } catch (_) {}
      for (let i = 0; i < 10 && !items.length; i++) { await wait(250); items = readItems(); }
    }
    const w = norm(want);
    const it = items.find(i => norm(v2Clean(i)) === w) ||
               items.find(i => norm(v2Clean(i)).includes(w)) ||
               items.find(i => { const n = norm(v2Clean(i)); return n.length > 4 && w.includes(n); });
    if (!it) {
      log('v2 model bulunamadı:', want, '| mevcut:', items.map(i => v2Clean(i)));
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await wait(300);
      return false;
    }
    log('v2 model seçiliyor:', v2Clean(it));
    clickEl(it); await wait(700);
    return true;
  }
  // Flow v2'de ayar panelinin BACKDROP'u YOK ve Escape onu KAPATMIYOR (canlı ölçüldü).
  // Kapatmanın kanıtlı yolu açıcıya TEKRAR basmaktır. Panel açık kalırsa kompozisyonun
  // üstünü kapatır ve sonraki adımlar (picker / gönder) yanlış öğeye denk gelebilir.
  async function v2Close() {
    if (!v2Pane()) return true;
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));
    await wait(300);
    for (let i = 0; i < 3 && v2Pane(); i++) {
      const t = v2Trigger();
      if (!t) break;
      try { t.click(); } catch (_) {}      // sade tık: çift tetikleme riski yok
      await wait(500);
    }
    return !v2Pane();
  }
  async function applyV2() {
    let pane = await v2Open();
    if (!pane) { log('v2: ayar paneli açılamadı'); return { success: false, error: 'opener_not_found' }; }
    // SIRA ÖNEMLİ: model değişince süre/çözünürlük listesi yenilendiğinden model
    // bunlardan ÖNCE uygulanır (eski kodda 10sn için ayrıca ikinci geçiş gerekiyordu).
    if (s.mode && V2_ICON[s.mode]) {
      await v2Pick(v2ByIcon(pane, V2_ICON[s.mode]), 'mod ' + s.mode);
      await wait(500); pane = v2Pane() || pane;                    // mod değişince gruplar yenilenir
    }
    if (s.frameTab && V2_ICON[s.frameTab]) {
      await v2Pick(v2ByIcon(pane, V2_ICON[s.frameTab]), 'kullanım ' + s.frameTab);
      pane = v2Pane() || pane;
    }
    if (s.model)  { await v2Model(pane, s.model); pane = v2Pane() || pane; }
    if (s.aspect && V2_ICON[s.aspect]) {
      await v2Pick(v2ByIcon(pane, V2_ICON[s.aspect]), 'oran ' + s.aspect);
      pane = v2Pane() || pane;
    }
    if (s.resolution) {                                            // YENİ grup: 360p / 720p
      const wr = String(s.resolution).toLowerCase().replace(/[^0-9p]/g, '');
      await v2Pick(v2ByText(pane, t => t.toLowerCase().replace(/[^0-9p]/g, '') === wr),
                   'çözünürlük ' + s.resolution);
      pane = v2Pane() || pane;
    }
    if (s.duration) {
      await v2Pick(v2ByText(pane, t => !/^x/i.test(t) && !t.includes(':') &&
                   /[a-z]/i.test(t) && t.replace(/\D/g, '') === String(s.duration)),
                   'süre ' + s.duration);
      pane = v2Pane() || pane;
    }
    if (s.count) {
      await v2Pick(v2ByText(pane, t => /^x/i.test(t) && t.replace(/\D/g, '') === String(s.count)),
                   'adet ' + s.count);
      pane = v2Pane() || pane;
    }
    const summary = pane ? v2Clean(pane).slice(0, 120) : '';
    const closed = await v2Close();
    const chip = v2Trigger();
    log('v2 uygulandı:', JSON.stringify(s), '| çip:', chip ? v2Clean(chip) : '-',
        '| panel kapandı:', closed);
    return { success: true, v2: true, chip: chip ? v2Clean(chip) : '', panel: summary, closed };
  }

  function findOpener() {
    return [...document.querySelectorAll('button[aria-haspopup="menu"]')].filter(isVis)
      .find(b => { const r = b.getBoundingClientRect(); return r.top > innerHeight * 0.55 && r.left > innerWidth * 0.3; }) || null;
  }
  function clickTabBySuffix(suffix) {
    const t = [...document.querySelectorAll(`[role="tab"][id$="-trigger-${suffix}"]`)].filter(isVis)[0];
    if (t) { clickEl(t); return true; }
    log('sekme bulunamadı (id):', suffix); return false;
  }
  // Sayısal sekme: kind 'count' → etikette 'x', 'duration' → etikette 's' (oran ':' hariç)
  function clickNumericTab(num, kind) {
    const tabs = [...document.querySelectorAll('[role="tab"]')].filter(isVis);
    const t = tabs.find(tab => {
      const l = cleanText(tab);
      if (l.includes(':')) return false;
      if (l.replace(/\D/g, '') !== String(num)) return false;
      return kind === 'count' ? /x/i.test(l) : (/s/i.test(l) && !/x/i.test(l));
    });
    if (t) { clickEl(t); return true; }
    log(kind + ' sekmesi bulunamadı:', num); return false;
  }

  // FLOW v2 arayüzü varsa oraya sap (eski arayüzde bu koşul HİÇ sağlanmaz).
  if (v2Trigger() || v2Pane()) return await applyV2();

  const opener = findOpener();
  if (!opener) { log('UYARI: ayar paneli açan buton yok'); return { success: false, error: 'opener_not_found' }; }
  if (opener.getAttribute('aria-expanded') !== 'true') { clickEl(opener); await wait(650); }

  if (s.mode)     { clickTabBySuffix(s.mode);          await wait(750); } // mod değişince liste yenilenir
  // v119: VİDEO alt sekmesi — 'VIDEO_FRAMES' (Kareler) | 'VIDEO_REFERENCES' (Malzemeler).
  // Panel ZATEN açık olduğundan ek açma gerekmez. Alan yoksa (eski payload / IMAGE modu)
  // hiç dokunulmaz → mevcut davranış birebir korunur.
  if (s.frameTab) { clickTabBySuffix(s.frameTab);      await wait(650); }
  if (s.aspect)   { clickTabBySuffix(s.aspect);        await wait(450); }
  if (s.count)    { clickNumericTab(s.count, 'count'); await wait(450); }
  if (s.duration) { clickNumericTab(s.duration, 'duration'); await wait(450); }

  if (s.model) {
    const openerRect = opener.getBoundingClientRect();
    const modelTrigger = [...document.querySelectorAll('button[aria-haspopup="menu"]')].filter(isVis)
      .find(b => { const r = b.getBoundingClientRect(); return b !== opener && r.top > innerHeight * 0.55 && r.bottom <= openerRect.top + 5; });
    if (modelTrigger) {
      if (modelTrigger.getAttribute('aria-expanded') !== 'true') { clickEl(modelTrigger); await wait(550); }
      const items = [...document.querySelectorAll('[role="menuitem"]')].filter(isVis);
      const want = norm(s.model);
      const item = items.find(i => norm(cleanText(i)) === want) || items.find(i => norm(cleanText(i)).includes(want));
      if (item) {
        log('model seçiliyor:', cleanText(item)); clickEl(item); await wait(500);
        // MODELE ÖZEL SÜRE: 10s sekmesi Flow'da yalnız Omni Flash seçiliyken listelenir,
        // yani yukarıdaki ilk deneme (model henüz değişmemişken) sekmeyi bulamaz. Model
        // değişince süre sekmeleri yenilendiği için burada TEKRAR uygulanır. 4/6/8 sn
        // akışları bu bloğa hiç girmez → mevcut davranış birebir korunur.
        if (s.duration > 8) { clickNumericTab(s.duration, 'duration'); await wait(450); }
      }
      else log('model bulunamadı:', s.model, '| mevcut:', items.map(i => cleanText(i)));
    } else log('model açılır menüsü yok');
  }

  // Paneli kapat
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));
  await wait(150);
  log('uygulandı:', JSON.stringify(s));
  return { success: true };
}

// ── Flow ayar panelinden HER İKİ MODUN seçeneklerini OKU — MAIN world, self-contained ──
// IMAGE ve VIDEO modlarını sırayla okur, sonra Flow'u BAŞLANGIÇTAKİ moduna geri döndürür
// (eklenti açılışında bir kez çağrılır; kullanıcı UI'da mod değiştirince Flow'a dokunulmaz).
// Döner: { success, current:'IMAGE'|'VIDEO', modes: { IMAGE:{aspects,counts,durations,models},
//          VIDEO:{...} } }
async function readFlowGenOptionsAll() {
  const log = (...a) => console.log('[AutoFlow][oku]', ...a);
  const wait = ms => (window.__afWait ? window.__afWait(ms) : new Promise(r => setTimeout(r, ms))); // arka plan sekmede kısılmayan bekleme
  const isVis = el => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const st = window.getComputedStyle(el);
    return r.width > 0 && r.height > 0 && st.display !== 'none' && st.visibility !== 'hidden' && parseFloat(st.opacity) > 0;
  };
  const cleanText = el => { const c = el.cloneNode(true); c.querySelectorAll('i').forEach(i => i.remove()); return (c.textContent || '').replace(/\s+/g, ' ').trim(); };
  function realClick(el) {
    const r = el.getBoundingClientRect();
    const base = { bubbles: true, cancelable: true, view: window, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0 };
    for (const type of ['pointerover', 'pointerenter', 'pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      try { const Ev = type.startsWith('pointer') ? PointerEvent : MouseEvent; el.dispatchEvent(new Ev(type, { ...base, buttons: (type.includes('up') || type === 'click') ? 0 : 1 })); } catch (_) {}
    }
  }
  function fiberClick(el) {
    try {
      const fk = Object.keys(el).find(k => k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance'));
      let f = el[fk];
      while (f) { const p = f.pendingProps || f.memoizedProps || {}; if (typeof p.onClick === 'function') { p.onClick({ type: 'click', isTrusted: true, target: el, currentTarget: el, bubbles: true, preventDefault() {}, stopPropagation() {}, nativeEvent: {} }); return; } f = f.return; }
    } catch (_) {}
  }
  const clickEl = el => { realClick(el); try { el.click(); } catch (_) {} fiberClick(el); };

  function findOpener() {
    return [...document.querySelectorAll('button[aria-haspopup="menu"]')].filter(isVis)
      .find(b => { const r = b.getBoundingClientRect(); return r.top > innerHeight * 0.55 && r.left > innerWidth * 0.3; }) || null;
  }
  function tabSuffix(tab) { const m = (tab.id || '').match(/-trigger-(.+)$/); return m ? m[1] : ''; }
  function tabPrefix(tab) { const m = (tab.id || '').match(/^(.*)-trigger-/); return m ? m[1] : (tab.id || ''); }

  const opener = findOpener();
  if (!opener) return { success: false, error: 'opener_not_found' };
  if (opener.getAttribute('aria-expanded') !== 'true') { clickEl(opener); await wait(650); }

  function currentMode() {
    const sel = [...document.querySelectorAll('[role="tab"][id*="-trigger-"]')].filter(isVis)
      .find(t => { const s = tabSuffix(t); return (s === 'IMAGE' || s === 'VIDEO') && t.getAttribute('aria-selected') === 'true'; });
    return sel ? tabSuffix(sel) : 'IMAGE';
  }
  async function switchMode(m) {
    const mt = [...document.querySelectorAll(`[role="tab"][id$="-trigger-${m}"]`)].filter(isVis)[0];
    if (mt && mt.getAttribute('aria-selected') !== 'true') { clickEl(mt); await wait(800); }
  }
  // O an görünen modun oran/adet/süre/model seçeneklerini oku
  async function readCurrent() {
    const tabs = [...document.querySelectorAll('[role="tab"][id*="-trigger-"]')].filter(isVis);
    const groups = {};
    for (const tab of tabs) { const p = tabPrefix(tab); (groups[p] = groups[p] || []).push(tab); }
    let aspects = [], counts = [], durations = [];
    for (const p in groups) {
      const gt = groups[p];
      const codes = gt.map(tabSuffix);
      const labels = gt.map(cleanText);
      const mk = t => ({ selected: t.getAttribute('aria-selected') === 'true' });
      if (codes.includes('IMAGE') || codes.includes('VIDEO')) continue; // mode grubu
      else if (codes.some(c => /LANDSCAPE|PORTRAIT|SQUARE|RATIO|ASPECT/i.test(c)) || labels.some(l => l.includes(':'))) {
        aspects = gt.map(t => ({ code: tabSuffix(t), label: cleanText(t), ...mk(t) }));
      } else if (labels.some(l => /\d/.test(l))) {
        const isDuration = labels.some(l => /\d/.test(l) && /s/i.test(l) && !/x/i.test(l));
        if (isDuration) durations = gt.map(t => { const l = cleanText(t); return { sec: parseInt(l.replace(/\D/g, '')) || 0, label: l, ...mk(t) }; });
        else counts = gt.map(t => { const l = cleanText(t); return { n: parseInt(l.replace(/\D/g, '')) || 0, label: l, ...mk(t) }; });
      }
    }
    // Model listesi: açılır menüyü aç, oku (ikon temizlenmiş), kapat
    const models = [];
    const openerRect = opener.getBoundingClientRect();
    const modelTrigger = [...document.querySelectorAll('button[aria-haspopup="menu"]')].filter(isVis)
      .find(b => { const r = b.getBoundingClientRect(); return b !== opener && r.top > innerHeight * 0.55 && r.bottom <= openerRect.top + 5; });
    if (modelTrigger) {
      const currentModel = cleanText(modelTrigger);
      if (modelTrigger.getAttribute('aria-expanded') !== 'true') { clickEl(modelTrigger); await wait(550); }
      const items = [...document.querySelectorAll('[role="menuitem"]')].filter(isVis);
      for (const it of items) { const name = cleanText(it); if (name) models.push({ name, selected: name === currentModel }); }
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));
      await wait(250);
    }
    return { aspects, counts, durations, models };
  }

  const original = currentMode();
  const modes = {};
  for (const m of ['IMAGE', 'VIDEO']) {
    await switchMode(m);
    modes[m] = await readCurrent();
  }
  // Flow'u başlangıçtaki moda geri döndür (kullanıcı için görünür değişiklik kalmasın)
  await switchMode(original);

  // Paneli kapat
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));
  await wait(150);

  const result = { success: true, current: original, modes };
  log('okundu (iki mod):', JSON.stringify(result));
  return result;
}

// ── Tekil düzenleme görünümünden PROJE IZGARASINA dön — MAIN world, self-contained ──
// FLOW v2 TUZAĞI (kullanıcı raporu 2026-09-05): sayfa bir şekilde
// /project/<id>/edit/<assetId> görünümüne geçtiğinde ekranda TEK büyük öğe kalıyor;
// üretimler o varlığın SÜRÜMÜ olarak ekleniyor, ızgaraya düşmüyor. Bu durumda
// flowCollectTiles tek tile görüyor → sıralı indirme numarası ilerlemiyor
// (log kanıtı: "#0001 saved" üç kez, "Prompt #1 complete" üç kez).
// Bu fonksiyon durumu tespit edip geri döner; ızgaradaysa HİÇBİR ŞEY YAPMAZ.
async function ensureGridViewOnFlow() {
  const wait = ms => (window.__afWait ? window.__afWait(ms) : new Promise(r => setTimeout(r, ms)));
  const inEdit = () => /\/(edit|asset|scene)\//.test(location.pathname);
  if (!inEdit()) return { success: true, changed: false };
  // v126: referans SEÇİMİ sürerken KARIŞMA. İndirme döngüsü bu fonksiyonu UI kilidinin
  // DIŞINDA, her tarama turunda çağırıyor → seçim sırasında geri butonuna basarsa picker
  // kapanır ve seçim yanlışlıkla "başarılı" sayılır. Seçim kendi kurtarmasını yapıyor.
  if (window.__afSelBusy && Date.now() - window.__afSelBusy < 15000)
    return { success: true, changed: false, busy: true };
  console.warn('[AutoFlow] IZGARA DÜZELTMESİ: tekil görünümdeyiz →', location.pathname);
  // 1) Sol üstteki geri oku (arrow_back ligature'ı — dilden bağımsız)
  const back = [...document.querySelectorAll('button, [role="button"]')].find(b => {
    const r = b.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    if (r.top > 220 || r.left > window.innerWidth * 0.3) return false;
    const leafs = [...b.querySelectorAll('mat-icon, i')].map(ic => (ic.textContent || '').trim());
    return leafs.includes('arrow_back') || (b.textContent || '').trim() === 'arrow_back';
  });
  if (back) { try { back.click(); } catch (_) {} }
  for (let i = 0; i < 12 && inEdit(); i++) await wait(400);
  // 2) Tarayıcı geçmişi
  if (inEdit()) {
    try { history.back(); } catch (_) {}
    for (let i = 0; i < 12 && inEdit(); i++) await wait(400);
  }
  const ok = !inEdit();
  console.log('[AutoFlow] IZGARA DÜZELTMESİ:', ok ? 'ızgaraya dönüldü' : 'DÖNÜLEMEDİ', location.pathname);
  return { success: ok, changed: true, path: location.pathname };
}

// ── Prompt metnini yazar ama GÖNDERMEZ — MAIN world, self-contained ────
async function stagePromptToFlow(promptText) {
  const wait = ms => (window.__afWait ? window.__afWait(ms) : new Promise(r => setTimeout(r, ms))); // arka plan sekmede kısılmayan bekleme

  function isVis(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const s = window.getComputedStyle(el);
    return r.width > 0 && r.height > 0 &&
           s.display !== 'none' && s.visibility !== 'hidden' &&
           parseFloat(s.opacity) > 0;
  }
  function getContent(el) {
    return (el.isContentEditable ? el.textContent : el.value).trim();
  }
  // v166 KÖK DÜZELTME (ÇOK SATIRLI PROMPT): doğrulama, yapıştırılan metni kutunun
  // textContent'i ile karşılaştırıyordu. Flow'un contenteditable editörü her satırı AYRI
  // BLOK olarak yazar ve textContent blok sınırlarına "\n" KOYMAZ → "1\n@NOBODY, seated in"
  // aranırken kutuda "1@NOBODY, seated in" durur, eşleşme HİÇ tutmaz. Metin ekranda
  // görünmesine rağmen "yapıştırılamadı" sayılıp prompt 8 denemede atlanıyordu (kullanıcı
  // raporu 2026-09-09: boş satırla ayrılmış numaralı bloklar, 190 promptun tamamı atlanacaktı).
  // ÇÖZÜM: iki tarafı da TÜM boşluklardan arındırıp karşılaştır. Tek satırlı promptlarda
  // sonuç BİREBİR aynıdır: eskiden eşleşen her metin boşluksuz halde de eşleşir (boşluk
  // silmek bitişik alt diziyi bozmaz), yani mevcut davranış korunur.
  function hasText(el, text) {
    const squash = s => String(s || '').replace(/\s+/g, '');
    const c = squash(getContent(el));
    const n = squash(text).slice(0, 20);
    return c.length > 0 && n.length > 0 && c.includes(n);
  }
  function findGenerateBtn() {
    const all = [...document.querySelectorAll('button, [role="button"]')].filter(isVis);
    // ── v147: RTL ARAYÜZ (Arapça/İbranice/Farsça) ───────────────────────────
    // RTL'de kompozisyon barı aynalanır: gönder butonu prompt kutusunun SOLUNDA
    // durur. Aşağıdaki "sağ yarıdan sağda" filtresi ve "en sağdaki = gönder"
    // sıralaması RTL'de gönder butonunu ELİYORDU → editör hiçbir zaman "hazır"
    // sayılmıyor ve prompt gönderilemiyordu (kullanıcı raporu 2026-09-06: Arapça
    // Flow arayüzünde referans eklendi ama Oluştur'a basılamadı).
    // LTR'de RTL=false → tüm karşılaştırmalar BİREBİR eskisi gibi çalışır.
    const RTL = (() => { try { return getComputedStyle(document.body).direction === 'rtl'; } catch (_) { return false; } })();
    const onSendSide = (r, bx) => RTL ? (r.left + r.width / 2) < (bx.left + bx.width * 0.5)
                                      : (r.left + r.width / 2) > (bx.left + bx.width * 0.5);
    const bySendEdge = (a, b) => {
      const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
      return RTL ? (ra.left - rb.left) : (rb.right - ra.right);
    };
    // KÖK DÜZELTME (büyük galeride gönderim takılması): (1) "creat"→"create" — "creat" galeri
    // tile'ının "Creator" metnini yakalıyordu; "create" "creator"u İÇERMEZ. (2) Galeri overlay +
    // uyarı/başarısız/tekrar-üret terimlerini KARA LİSTEYLE ele (yanlış buton tıklanmasın).
    // (3) Gönder butonu prompt KUTUSUNUN yanındadır (kompozitör); galeri büyüyünce tile'lar
    // kutunun altına düşüp "en alttaki" seçimini bozuyordu → kutuya DİKEY yakınlıkla filtrele.
    const KW    = ['oluştur', 'olustur', 'generate', 'gönder', 'gonder', 'send', 'create'];
    const BLACK = ['play_circle', 'creator', 'write', 'indir', 'download', 'more_vert',
                   'favorite', 'favori', 'share', 'paylas', 'animasyon',
                   'warning', 'başarısız', 'basarisiz', 'failed', 'içerik', 'icerik',
                   'unusual', 'olağan', 'olagan', 'uyarı', 'uyari', 'tekrar', 'retry', 'regenerate'];
    const hit = s => {
      s = (s || '').toLowerCase();
      if (BLACK.some(b => s.includes(b))) return false;
      return KW.some(k => s.includes(k));
    };
    const cand = all.filter(b => {
      // UZUN öğeleri (galeri kartları, >120px boy) ELE: prompt metni "sending/create/generate"
      // gibi kelime içerince üretilen kartın AÇIKLAMASI KW'ye (send/create) takılıp yanlış gönder
      // butonu seçiliyordu. Gönder butonu KISA (~32-48px), galeri kartı UZUN (>300px). DİLDEN
      // BAĞIMSIZ ve TR/EN'i bozmaz (gönder butonu hiçbir dilde uzun değil).
      if (b.getBoundingClientRect().height > 120) return false;
      return hit(b.textContent) || hit(b.getAttribute('aria-label') || b.title || '');
    });
    if (!cand.length) {
      // DİLDEN BAĞIMSIZ YEDEK — yalnızca metinle HİÇ aday yokken (TR/EN DIŞI arayüz) çalışır;
      // TR/EN'de cand DOLU olduğundan bu blok ASLA çalışmaz → mevcut davranış birebir korunur.
      // Gönder butonu kompozitörde KÜÇÜK bir ikon buttondur ve "arrow_forward/send" gönder-ok
      // ligature'ı (dilden bağımsız) taşır. KRİTİK: galeri kartları GENİŞ olduğundan sağ kenarları
      // gönder butonundan daha sağda kalıp yanlış seçiliyordu → boyutla (>120px) ELE. "İstemi temizle"
      // (close/clear/cancel) de ELE → yanlışlıkla kart açıp prompt silme/içerik silme önlenir.
      const SEND_IC = /arrow_forward|arrow_upward|arrow_right_alt|subdirectory_arrow_left|north_east|\bsend\b/;
      const CLEARIC = /\bclose\b|\bclear\b|backspace|\bdelete\b|cancel|temizle|очис/;
      const bxs = [...document.querySelectorAll('[contenteditable="true"], textarea, [role="textbox"]')].filter(isVis);
      bxs.sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top);
      const bx = bxs[0] ? bxs[0].getBoundingClientRect() : null;
      if (!bx) return null;
      const cyy = bx.top + bx.height / 2;
      const near = all.filter(b => {
        // disabled OLSA BİLE bul: editör-hazır tespiti (stagePromptToFlow) ve clickSendOnFlow,
        // prompt yazılmadan disabled olan gönder butonunu bulup AKTİF olmasını bekler. Disabled'ı
        // burada elersek buton hiç bulunamaz → "editor ready" gelmez → 3 dk takılır.
        const r = b.getBoundingClientRect();
        if (r.width > 120 || r.height > 120) return false;            // galeri kartı/büyük öğe DEĞİL
        const ss = ((b.textContent || '') + ' ' + (b.getAttribute('aria-label') || b.title || '')).toLowerCase();
        if (BLACK.some(k => ss.includes(k)) || CLEARIC.test(ss)) return false; // temizle/iptal/blacklist değil
        return Math.abs((r.top + r.height / 2) - cyy) < Math.max(180, bx.height * 2.5) &&
               onSendSide(r, bx);                     // kutunun gönder tarafında (RTL: SOL yarı)
      });
      if (!near.length) return null;
      // gönder-ok ligature'lı olanı TERCİH et; yoksa en sağdaki küçük kompozitör butonu.
      const arrows = near.filter(b =>
        SEND_IC.test(((b.textContent || '') + ' ' + (b.getAttribute('aria-label') || '')).toLowerCase()));
      const pool2 = arrows.length ? arrows : near;
      pool2.sort(bySendEdge);                 // v147: LTR en sağdaki, RTL en soldaki
      return pool2[0];
    }
    // Prompt kutusunu (en alttaki görünür contenteditable/textarea) bul → kompozitör çapası.
    const inputs = [...document.querySelectorAll('[contenteditable="true"], textarea')].filter(isVis);
    inputs.sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top);
    const box = inputs[0] ? inputs[0].getBoundingClientRect() : null;
    if (box) {
      const cy = box.top + box.height / 2;
      const near = cand.filter(b => {
        const r = b.getBoundingClientRect();
        return Math.abs((r.top + r.height / 2) - cy) < Math.max(180, box.height * 2.5);
      });
      const pool = near.length ? near : cand;
      pool.sort(bySendEdge);                   // en SAĞ = gönder (RTL: en SOL)
      return pool[0];
    }
    cand.sort((a, b) => {
      const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
      return (rb.bottom - ra.bottom) || (RTL ? (ra.left - rb.left) : (rb.right - ra.right));
    });
    return cand[0];
  }

  // 1. Editör hazır olana kadar bekle (max 3dk)
  let editorReady = false;
  for (let i = 0; i < 90; i++) {
    if (findGenerateBtn()) { editorReady = true; break; }
    await wait(2000);
  }
  if (!editorReady) return { success: false, error: 'Editor not ready after 3min' };
  console.log('[AutoFlow] Stage: editor ready');

  // 2. Outer input
  const findOuter = () => {
    const cands = [
      ...document.querySelectorAll('[contenteditable="true"]'),
      ...document.querySelectorAll('textarea')
    ].filter(el => isVis(el) && !el.closest('[aria-hidden="true"]'));
    if (!cands.length) return null;
    cands.sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top);
    return cands[0];
  };
  let outer = null;
  for (let i = 0; i < 20; i++) { outer = findOuter(); if (outer) break; await wait(400); }
  if (!outer) return { success: false, error: 'Input not found' };

  // 3. İç editör
  const innerSel = outer.querySelector('.ProseMirror, [data-lexical-editor="true"], [contenteditable="true"]');
  const editor = (innerSel && innerSel !== outer) ? innerSel : outer;

  // 4. Focus
  outer.click(); editor.click(); editor.focus();
  await wait(300);

  // 5. Strateji A: selectAll + beforeinput insertText
  let ok = false;
  document.execCommand('selectAll', false, null);
  await wait(60);
  editor.dispatchEvent(new InputEvent('beforeinput', {
    inputType: 'insertText', data: promptText, bubbles: true, cancelable: true
  }));
  await wait(500);
  ok = hasText(editor, promptText);
  console.log('[AutoFlow] Stage A:', ok, '|', getContent(editor).slice(0, 60));

  // 6. Strateji B: Ctrl+A + paste
  if (!ok) {
    editor.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'a', code: 'KeyA', keyCode: 65, ctrlKey: true, bubbles: true, cancelable: true
    }));
    // v167: SENTETİK Ctrl+A tarayıcıda seçim YAPMAZ (yalnız editör kendi dinliyorsa işe
    // yarar). Seçim olmayınca paste, kutudaki metnin SONUNA ekleniyor → metin İKİZLENİYOR
    // ve Flow'a iki kopya gidiyordu. keydown aynen duruyor (kendi dinleyen editörlerde
    // davranış değişmesin), seçimi ise KENDİMİZ kuruyoruz.
    //
    // NEDEN execCommand DEĞİL (ölçüldü 2026-09-10): execCommand('selectAll') belge ODAKTA
    // değilken true döner ama HİÇBİR ŞEY SEÇMEZ (document.hasFocus()===false iken seçim
    // uzunluğu 0) → arka plandaki sekmede ikizlenme aynen sürerdi. Odaklıyken de seçimi
    // editöre değil TÜM SAYFAYA yaydığı görüldü. Range API ikisini de çözüyor: odaktan
    // bağımsız çalışır ve seçim editörün içiyle sınırlı kalır.
    try {
      const sel = window.getSelection();
      sel.removeAllRanges();
      const rng = document.createRange();
      rng.selectNodeContents(editor);
      sel.addRange(rng);
    } catch (_) { document.execCommand('selectAll', false, null); }
    await wait(80);
    try {
      const dt = new DataTransfer();
      dt.setData('text/plain', promptText);
      editor.dispatchEvent(new ClipboardEvent('paste', {
        clipboardData: dt, bubbles: true, cancelable: true
      }));
      await wait(500);
      ok = hasText(editor, promptText);
      console.log('[AutoFlow] Stage B:', ok, '|', getContent(editor).slice(0, 60));
    } catch (e) { console.log('[AutoFlow] paste err:', e.message); }
  }

  // 7. Strateji C: ProseMirror transaction
  if (!ok) {
    function findPMView(el) {
      let node = el;
      while (node && node !== document.body) {
        if (node.pmViewDesc) {
          try { const v = node.pmViewDesc.view; if (v?.state && v.dispatch) return v; } catch(_) {}
        }
        node = node.parentElement;
      }
      const w = document.createTreeWalker(el, NodeFilter.SHOW_ELEMENT);
      let c;
      while ((c = w.nextNode())) {
        if (c.pmViewDesc) {
          try { const v = c.pmViewDesc.view; if (v?.state && v.dispatch) return v; } catch(_) {}
        }
      }
      return null;
    }
    const pmv = findPMView(editor) || findPMView(outer);
    if (pmv) {
      try {
        const s = pmv.state;
        pmv.dispatch(s.tr.delete(0, s.doc.content.size).insertText(promptText, 0));
        ok = true;
        await wait(400);
      } catch (e) { console.log('[AutoFlow] PM err:', e.message); }
    }
  }

  // v166: başarısızlıkta kutunun GERÇEK içeriğini de döndür → ana döngü bunu Logs'a yazar.
  // "Metin ekranda duruyor ama eklenti göremiyor" tipi hatalar tek koşuda teşhis edilsin.
  if (!ok) return { success: false, error: 'All insert strategies failed',
                    seen: getContent(editor).slice(0, 80) };
  console.log('[AutoFlow] Stage done:', promptText.slice(0, 40));
  return { success: true };
}

// ── Sadece Gönder butonuna basar — MAIN world, self-contained ──────────
async function clickSendOnFlow() {
  const wait = ms => (window.__afWait ? window.__afWait(ms) : new Promise(r => setTimeout(r, ms))); // arka plan sekmede kısılmayan bekleme

  function isVis(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const s = window.getComputedStyle(el);
    return r.width > 0 && r.height > 0 &&
           s.display !== 'none' && s.visibility !== 'hidden' &&
           parseFloat(s.opacity) > 0;
  }
  function findGenerateBtn() {
    const all = [...document.querySelectorAll('button, [role="button"]')].filter(isVis);
    // ── v147: RTL ARAYÜZ (Arapça/İbranice/Farsça) ───────────────────────────
    // RTL'de kompozisyon barı aynalanır: gönder butonu prompt kutusunun SOLUNDA
    // durur. Aşağıdaki "sağ yarıdan sağda" filtresi ve "en sağdaki = gönder"
    // sıralaması RTL'de gönder butonunu ELİYORDU → editör hiçbir zaman "hazır"
    // sayılmıyor ve prompt gönderilemiyordu (kullanıcı raporu 2026-09-06: Arapça
    // Flow arayüzünde referans eklendi ama Oluştur'a basılamadı).
    // LTR'de RTL=false → tüm karşılaştırmalar BİREBİR eskisi gibi çalışır.
    const RTL = (() => { try { return getComputedStyle(document.body).direction === 'rtl'; } catch (_) { return false; } })();
    const onSendSide = (r, bx) => RTL ? (r.left + r.width / 2) < (bx.left + bx.width * 0.5)
                                      : (r.left + r.width / 2) > (bx.left + bx.width * 0.5);
    const bySendEdge = (a, b) => {
      const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
      return RTL ? (ra.left - rb.left) : (rb.right - ra.right);
    };
    // KÖK DÜZELTME (büyük galeride gönderim takılması): (1) "creat"→"create" — "creat" galeri
    // tile'ının "Creator" metnini yakalıyordu; "create" "creator"u İÇERMEZ. (2) Galeri overlay +
    // uyarı/başarısız/tekrar-üret terimlerini KARA LİSTEYLE ele (yanlış buton tıklanmasın).
    // (3) Gönder butonu prompt KUTUSUNUN yanındadır (kompozitör); galeri büyüyünce tile'lar
    // kutunun altına düşüp "en alttaki" seçimini bozuyordu → kutuya DİKEY yakınlıkla filtrele.
    const KW    = ['oluştur', 'olustur', 'generate', 'gönder', 'gonder', 'send', 'create'];
    const BLACK = ['play_circle', 'creator', 'write', 'indir', 'download', 'more_vert',
                   'favorite', 'favori', 'share', 'paylas', 'animasyon',
                   'warning', 'başarısız', 'basarisiz', 'failed', 'içerik', 'icerik',
                   'unusual', 'olağan', 'olagan', 'uyarı', 'uyari', 'tekrar', 'retry', 'regenerate'];
    const hit = s => {
      s = (s || '').toLowerCase();
      if (BLACK.some(b => s.includes(b))) return false;
      return KW.some(k => s.includes(k));
    };
    const cand = all.filter(b => {
      // UZUN öğeleri (galeri kartları, >120px boy) ELE: prompt metni "sending/create/generate"
      // gibi kelime içerince üretilen kartın AÇIKLAMASI KW'ye (send/create) takılıp yanlış gönder
      // butonu seçiliyordu. Gönder butonu KISA (~32-48px), galeri kartı UZUN (>300px). DİLDEN
      // BAĞIMSIZ ve TR/EN'i bozmaz (gönder butonu hiçbir dilde uzun değil).
      if (b.getBoundingClientRect().height > 120) return false;
      return hit(b.textContent) || hit(b.getAttribute('aria-label') || b.title || '');
    });
    if (!cand.length) {
      // DİLDEN BAĞIMSIZ YEDEK — yalnızca metinle HİÇ aday yokken (TR/EN DIŞI arayüz) çalışır;
      // TR/EN'de cand DOLU olduğundan bu blok ASLA çalışmaz → mevcut davranış birebir korunur.
      // Gönder butonu kompozitörde KÜÇÜK bir ikon buttondur ve "arrow_forward/send" gönder-ok
      // ligature'ı (dilden bağımsız) taşır. KRİTİK: galeri kartları GENİŞ olduğundan sağ kenarları
      // gönder butonundan daha sağda kalıp yanlış seçiliyordu → boyutla (>120px) ELE. "İstemi temizle"
      // (close/clear/cancel) de ELE → yanlışlıkla kart açıp prompt silme/içerik silme önlenir.
      const SEND_IC = /arrow_forward|arrow_upward|arrow_right_alt|subdirectory_arrow_left|north_east|\bsend\b/;
      const CLEARIC = /\bclose\b|\bclear\b|backspace|\bdelete\b|cancel|temizle|очис/;
      const bxs = [...document.querySelectorAll('[contenteditable="true"], textarea, [role="textbox"]')].filter(isVis);
      bxs.sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top);
      const bx = bxs[0] ? bxs[0].getBoundingClientRect() : null;
      if (!bx) return null;
      const cyy = bx.top + bx.height / 2;
      const near = all.filter(b => {
        // disabled OLSA BİLE bul: editör-hazır tespiti (stagePromptToFlow) ve clickSendOnFlow,
        // prompt yazılmadan disabled olan gönder butonunu bulup AKTİF olmasını bekler. Disabled'ı
        // burada elersek buton hiç bulunamaz → "editor ready" gelmez → 3 dk takılır.
        const r = b.getBoundingClientRect();
        if (r.width > 120 || r.height > 120) return false;            // galeri kartı/büyük öğe DEĞİL
        const ss = ((b.textContent || '') + ' ' + (b.getAttribute('aria-label') || b.title || '')).toLowerCase();
        if (BLACK.some(k => ss.includes(k)) || CLEARIC.test(ss)) return false; // temizle/iptal/blacklist değil
        return Math.abs((r.top + r.height / 2) - cyy) < Math.max(180, bx.height * 2.5) &&
               onSendSide(r, bx);                     // kutunun gönder tarafında (RTL: SOL yarı)
      });
      if (!near.length) return null;
      // gönder-ok ligature'lı olanı TERCİH et; yoksa en sağdaki küçük kompozitör butonu.
      const arrows = near.filter(b =>
        SEND_IC.test(((b.textContent || '') + ' ' + (b.getAttribute('aria-label') || '')).toLowerCase()));
      const pool2 = arrows.length ? arrows : near;
      pool2.sort(bySendEdge);                 // v147: LTR en sağdaki, RTL en soldaki
      return pool2[0];
    }
    // Prompt kutusunu (en alttaki görünür contenteditable/textarea) bul → kompozitör çapası.
    const inputs = [...document.querySelectorAll('[contenteditable="true"], textarea')].filter(isVis);
    inputs.sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top);
    const box = inputs[0] ? inputs[0].getBoundingClientRect() : null;
    if (box) {
      const cy = box.top + box.height / 2;
      const near = cand.filter(b => {
        const r = b.getBoundingClientRect();
        return Math.abs((r.top + r.height / 2) - cy) < Math.max(180, box.height * 2.5);
      });
      const pool = near.length ? near : cand;
      pool.sort(bySendEdge);                   // en SAĞ = gönder (RTL: en SOL)
      return pool[0];
    }
    cand.sort((a, b) => {
      const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
      return (rb.bottom - ra.bottom) || (RTL ? (ra.left - rb.left) : (rb.right - ra.right));
    });
    return cand[0];
  }
  function fiberClick(el) {
    try {
      const fkey = Object.keys(el).find(k =>
        k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance'));
      if (!fkey) return false;
      let fiber = el[fkey];
      while (fiber) {
        const props = fiber.pendingProps || fiber.memoizedProps || {};
        if (typeof props.onClick === 'function') {
          props.onClick({
            type: 'click', isTrusted: true,
            target: el, currentTarget: el,
            bubbles: true, cancelable: true,
            preventDefault() {}, stopPropagation() {},
            stopImmediatePropagation() {}, persist() {},
            nativeEvent: { isTrusted: true, target: el, type: 'click' }
          });
          return true;
        }
        fiber = fiber.return;
      }
    } catch (e) { console.log('[AutoFlow] fiberClick err:', e.message); }
    return false;
  }

  // Buton GERÇEKTEN tıklanabilir mi? (üretim sürerken Flow onu devre dışı bırakır)
  function isEnabled(btn) {
    if (!btn) return false;
    if (btn.disabled) return false;
    if (btn.getAttribute('aria-disabled') === 'true') return false;
    const s = window.getComputedStyle(btn);
    if (s.pointerEvents === 'none') return false;
    if (parseFloat(s.opacity) < 0.15) return false;
    return true;
  }

  // ── Gönder butonu AKTİF olana kadar bekle (max ~150s) ──────────────────
  // KÖK SORUN: bir önceki prompt hâlâ üretilirken buton disabled olur.
  // Disabled butona tıklamak hiçbir şey yapmaz ama eski kod "gönderildi"
  // sayıp ilerliyordu → promptların yarısı atlanıyordu. Aktif olana dek bekle.
  let sendBtn = null;
  for (let i = 0; i < 100; i++) {
    const b = findGenerateBtn();
    if (b && isEnabled(b)) { sendBtn = b; break; }
    if (i === 0 && b) {
      const bs0 = window.getComputedStyle(b);
      console.log('[AutoFlow] Send: buton bulundu ama pasif, bekleniyor | pe:',
        bs0.pointerEvents, '| op:', bs0.opacity, '| disabled:', b.disabled);
    }
    await wait(1500);
  }

  if (!sendBtn) {
    // Fallback: Enter
    const ed = [...document.querySelectorAll('[contenteditable="true"]')]
      .find(el => { const r = el.getBoundingClientRect(); return r.width > 100 && r.height > 0; });
    if (ed) {
      ed.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true, cancelable: true
      }));
      console.warn('[AutoFlow] Send: aktif buton yok, Enter denendi');
      return { success: true, method: 'enter-fallback' };
    }
    console.warn('[AutoFlow] Send: aktif buton bulunamadı');
    return { success: false, error: 'Send btn not enabled' };
  }

  const bs = window.getComputedStyle(sendBtn);
  console.log('[AutoFlow] Send: AKTİF buton | pe:', bs.pointerEvents, '| op:', bs.opacity,
              '| text:', sendBtn.textContent.trim().slice(0, 20));

  // GÜVENİLİR SİNYALLER (tıklamadan ÖNCE base): büyük/hızlı galeride buton bazen pasifleşmiyor
  // (Flow sıradakini hemen kabul ediyor) → tek-sinyalli onay false-negative verip AYNI promptu
  // sonsuza dek yeniden yapıştırıyordu (#32 takılması). Üç sinyalden HERHANGİ biri = gönderildi:
  // (a) buton VAR ama pasif, (b) yeni "%/üretiliyor" göstergesi, (c) prompt kutusu boşaldı.
  const editorFull = () => [...document.querySelectorAll('[contenteditable="true"], textarea')]
    .some(el => ((el.isContentEditable ? el.textContent : el.value) || '').trim().length > 3);
  const genCount = () => [...document.querySelectorAll('div, span')]
    .filter(el => { const t = (el.textContent || '').trim(); return /^\d{1,3}\s*%$/.test(t) && !el.querySelector('*'); }).length;
  const baseGen     = genCount();
  const baseHadText = editorFull();

  sendBtn.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }));
  sendBtn.dispatchEvent(new MouseEvent('mouseover',     { bubbles: true }));
  await wait(60);
  sendBtn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
  sendBtn.dispatchEvent(new MouseEvent('mousedown',     { bubbles: true, cancelable: true }));
  await wait(80);
  sendBtn.dispatchEvent(new PointerEvent('pointerup',   { bubbles: true }));
  sendBtn.dispatchEvent(new MouseEvent('mouseup',       { bubbles: true }));
  sendBtn.click();
  await wait(300);
  const fibered = fiberClick(sendBtn);

  // ── Gönderim gerçekleşti mi? SPESİFİK sinyaller (sahte-pozitif YOK), ~15sn pencere ──
  let started = false, sig = '';
  for (let i = 0; i < 22; i++) {
    await wait(700);
    const b = findGenerateBtn();
    const btnBusy = !!b && !isEnabled(b);            // buton VAR ama pasif = üretim başladı
    const moreGen = genCount() > baseGen;            // yeni "%/üretiliyor" göstergesi
    const cleared = baseHadText && !editorFull();    // Flow gönderince prompt kutusunu boşalttı
    if (btnBusy || moreGen || cleared) {
      started = true;
      sig = btnBusy ? 'btn-pasif' : moreGen ? 'uretiliyor' : 'kutu-bos';
      break;
    }
  }
  const fb = findGenerateBtn();
  console.log('[AutoFlow] Send: fiberClick:', fibered, '| başladı:', started, '| sinyal:', sig,
              '| btnEnabled:', fb ? isEnabled(fb) : false, '| baseGen:', baseGen, '| endGen:', genCount());

  if (!started) return { success: false, error: 'Send not confirmed' };
  return { success: true, method: fibered ? 'fiber' : 'click', sig };
}

// ── Helpers ────────────────────────────────────────────
async function complete() {
  // Üretim bitti. İndirme pipeline'ı 'completed' durumunda da çalışmaya devam
  // eder (status 'idle' olmadıkça) → kalan tile'lar sırayla indirilir.
  state.status = 'completed';
  await persist(); broadcast();
  logEvent('done', 'All ' + state.prompts.length + ' prompts generated');
  if (state.autoDownload && !dlLoopActive) downloadPipeline(); // güvence: durmuşsa yeniden başlat
  if (!state.autoDownload) {
    await setTabAutoDiscard(state.tabId, true); // indirme yoksa iş bitti → koruma kalksın
    // v139: kompakt düzen için zoom değiştirildiyse kullanıcının değerine geri dön.
    // (Oto indirme AÇIKSA zoom'u indirme hattının finally bloğu geri alır.)
    try { await restoreZoomIfForced(); } catch (_) {}
  }
  try {
    chrome.notifications.create('af-done', {
      type: 'basic', iconUrl: chrome.runtime.getURL('icons/icon48.png'),
      title: 'ViralDNA Auto Flow', message: `${state.prompts.length} prompt tamamlandı!`
    }, () => { void chrome.runtime.lastError; }); // ikon yüklenemese de hata yutulur
  } catch (_) {}
}

function broadcast(usageCount) {
  // Ağır alanları (referans dataURL'leri) yayından çıkar — sidepanel'in ihtiyacı yok
  // ve poller 3 sn'de bir yayınlıyor (büyük base64'ler gereksiz yük olur).
  const { refImages, promptRefNames, ...lite } = state;
  const payload = { type: 'stateUpdate', state: lite };
  if (typeof usageCount === 'number') payload.usageCount = usageCount;
  chrome.runtime.sendMessage(payload).catch(() => {});
}

// ── Logs (olay akışı) ──────────────────────────────────
function logEvent(kind, msg) {
  const entry = { t: Date.now(), kind, msg };
  if (!state.logs) state.logs = [];
  state.logs.push(entry);
  if (state.logs.length > 200) state.logs.splice(0, state.logs.length - 200);
  console.log('[AutoFlow][LOG]', kind, msg);
  try { chrome.runtime.sendMessage({ type: 'log', entry }).catch(() => {}); } catch (_) {}
}

// ── Gallery durum toplayıcı (oto-indirmeden BAĞIMSIZ) ──
// flowCollectTiles (salt-okuma) ile tile'ları okuyup prompt başına gruplar; UI kilidi gerekmez.
let galleryLoopActive = false;
async function galleryPoll() {
  if (galleryLoopActive) return;
  galleryLoopActive = true;
  try {
    while (state.status === 'running' || state.status === 'completed') {
      if (!state.tabId) break;
      let tiles = [];
      try {
        const res = await chrome.scripting.executeScript({
          target: { tabId: state.tabId }, world: 'MAIN', func: flowCollectTiles
        });
        tiles = res?.[0]?.result || [];
      } catch (_) {}
      const count = Math.max(1, (state.genSettings && state.genSettings.count) || 1);
      const groups = [];
      tiles.forEach((tile, idx) => {
        const p = Math.floor(idx / count), o = idx % count;
        if (!groups[p]) groups[p] = { no: p + 1, prompt: state.prompts[p] || '', outputs: [] };
        groups[p].outputs[o] = {
          idx, state: tile.state, isVideo: !!tile.isVideo,
          excluded: !!(state.galleryExcluded && state.galleryExcluded[idx])
        };
      });
      state.gallery = groups;
      broadcast();
      if (state.status !== 'running' && !tiles.some(tl => tl.state === 'generating')) break;
      await sleep(3000);
    }
  } catch (e) { console.warn('[AutoFlow][GAL] poll err:', e.message); }
  finally { galleryLoopActive = false; }
}

// ── Toplu indirme (oto-indirme kapalıyken "Tümünü İndir") ──
async function handleDownloadAll(msg) {
  await initReady; // state depodan yüklenene kadar bekle (soğuk başlangıç yarışı engellenir)
  console.log('[AutoFlow][DL] handleDownloadAll | dlLoopActive=' + dlLoopActive +
              ' | msg.tabId=' + (msg && msg.tabId) + ' | state.tabId=' + state.tabId);
  if (dlLoopActive) {
    // GERÇEKTEN manuel toplu indirme çalışıyor → buton zaten "Durdur"; tekrar başlatma.
    if (state.bulkDownloading) {
      console.log('[AutoFlow][DL] → BUSY: manuel toplu indirme zaten çalışıyor');
      try { broadcast(); } catch (_) {}
      return { success: false, error: 'busy' };
    }
    // ÜRETİM HÂLÂ SÜRÜYOR → auto indirme aktif olarak gerekli, kesme.
    if (state.status === 'running') {
      console.log('[AutoFlow][DL] → BUSY: üretim sürüyor (auto indirme aktif)');
      return { success: false, error: 'busy' };
    }
    // ÜRETİM BİTTİ ama AUTO indirme pipeline'ı hâlâ "grace"te lingering (dlLoopActive=true,
    // son görselleri bekliyor; 1-10 dk sürebilir). Eskiden bu pencerede toplu indirmeye
    // basınca İLK TIK 'busy' dönüyor, kullanıcı önce Durdur'a basıp tekrar denemek zorunda
    // kalıyordu. Artık lingering auto pipeline'ı SONLANDIRIP (token++ ile eski döngü çıkar)
    // manuel indirmeye HEMEN geçiyoruz → ilk tıkta çalışır.
    console.log('[AutoFlow][DL] auto pipeline grace\'te lingering → sonlandırılıp manuel indirme başlatılıyor');
    dlRunToken++;          // eski auto döngü token uyuşmazlığından bir sonraki kontrolde çıkar
    dlLoopActive = false;  // manuel pipeline başlayabilsin
    dlCancel = false;
  }
  // "Sonradan indir" butonundan gelen güncel sekme/kalite/üretim ayarlarını uygula.
  // (Eski Logs-sekmesi butonu msg göndermez → mevcut state korunur — geriye uyumlu.)
  if (msg) {
    if (msg.tabId)        state.tabId        = msg.tabId;
    if (msg.dlQualityImg) state.dlQualityImg = msg.dlQualityImg;
    if (msg.dlQualityVid) state.dlQualityVid = msg.dlQualityVid;
    if (msg.genSettings)  state.genSettings  = msg.genSettings; // count → b/c/d numaralandırma
    if (typeof msg.videoOnly === 'boolean') state.videoOnly = msg.videoOnly; // VİDEO indirmede referans görselleri atla
    // NUMARALANDIRMA KARARI: indirme yapılan proje, ÜRETİM yapılan proje ile AYNI mı?
    //   AYNI  → üretimdeki adete göre grupla (0001,0001b,0001c…).
    //   FARKLI (veya üretim bu oturumda bilinmiyor) → düz sıralı (0001,0002,0003…).
    const sameProject = !!(msg.flowUrl && state.genUrl &&
                           projectKey(msg.flowUrl) === projectKey(state.genUrl));
    state.dlSequential = !sameProject;
    console.log('[AutoFlow][DL] numaralandırma:', sameProject ? 'üretim projesine göre (b/c/d)' : 'düz sıralı (farklı/bilinmeyen proje)');
  }
  if (!state.tabId) { console.log('[AutoFlow][DL] → no_tab'); return { success: false, error: 'no_tab' }; }
  // v129: ÜRETİM BİTMİŞKEN oto pipeline hâlâ dönüyorsa (bir guard'da takılı kalmış olabilir)
  // manuel indirme eskiden "pipeline zaten çalışıyor" deyip HİÇ başlamıyordu (kullanıcı raporu:
  // "sonradan toplu indirme butonu da çalışmıyor"). Artık oto pipeline iptal edilip devralınır.
  if (dlLoopActive && state.status !== 'running') {
    console.log('[AutoFlow][DL] oto pipeline dönüyor → iptal edilip manuel devralınıyor');
    logEvent('info', 'Oto indirme durduruldu, toplu indirme devralıyor');
    dlCancel = true;
    for (let i = 0; i < 40 && dlLoopActive; i++) await sleep(250);   // en çok 10 sn
    dlCancel = false;
    if (dlLoopActive) {
      console.warn('[AutoFlow][DL] oto pipeline kapanmadı → manuel başlatılamıyor');
      return { success: false, error: 'busy' };
    }
  }
  console.log('[AutoFlow][DL] → manuel pipeline başlatılıyor');
  downloadPipeline(true); // manual mod: status'tan bağımsız, en eskiden başlayıp sırayla indirir
  return { success: true };
}

async function persist() {
  await chrome.storage.local.set({ automationState: { ...state } });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

(async () => {
  try {
    // Her başlangıçta alarmları temizle — eski bir otomasyon devam etmesin
    chrome.alarms.clearAll();
    afKeepAwake(false); // v175: SW yeniden başladıysa koşu bitmiştir (running→idle), uyku engeli kalmasın
    const s = await chrome.storage.local.get('automationState');
    if (s.automationState) {
      state = s.automationState;
      // running veya paused → idle. Kullanıcı her zaman manuel başlatmalı.
      if (state.status === 'running' || state.status === 'paused') {
        state.status = 'idle';
      }
      // SW yeniden başladıysa (reload) çalışan indirme döngüsü ölmüştür; kalıcıda
      // bulkDownloading 'true' takılı kalmış olabilir → zombi "Durdur"u temizle.
      // (Manuel indirme handleDownloadAll içinde initReady'yi BEKLEDİĞİNDEN bu sıfırlama
      //  pipeline'ın bulkDownloading=true'sunu EZMEZ — yarış yok.)
      state.bulkDownloading = false;
      await persist();
    }
  } catch (e) { console.warn('[AutoFlow] init err:', e && e.message); }
  finally { resolveInit(); } // state yüklendi → manuel indirme artık güvenle başlayabilir
})();
