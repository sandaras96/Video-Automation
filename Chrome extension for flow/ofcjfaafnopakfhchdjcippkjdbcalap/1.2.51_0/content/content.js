// AutoFlow Pro — Content Script
// Runs on labs.google.fx, labs.google.com, flow.google.com

(function () {
  'use strict';
  if (window.__autoflowInjected) return;
  window.__autoflowInjected = true;

  console.log('[AutoFlow] Content script loaded on', location.hostname);

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.action === 'submitPrompt') {
      submitPrompt(msg.prompt, msg.settings || {})
        .then(r => { console.log('[AutoFlow] submitPrompt result:', r); sendResponse(r); })
        .catch(e => sendResponse({ success: false, error: e.message }));
      return true;
    }
    if (msg.action === 'ping') { sendResponse({ alive: true }); }
  });

  // ── Main ──────────────────────────────────────────────
  async function submitPrompt(text) {
    // 1. Find the prompt textarea/input
    const input = await findInput();
    if (!input) {
      return { success: false, error: 'Prompt alanı bulunamadı. Sayfayı yenileyin.' };
    }
    console.log('[AutoFlow] Found input:', input.tagName, input.className.slice(0, 60));

    // 2. Click to focus
    input.click();
    input.focus();
    await wait(300);

    // 3. Clear existing content
    await clearInput(input);
    await wait(200);

    // 4. Type the prompt
    await typeText(input, text);
    await wait(400);

    // 5. Send (button click or Enter)
    const sent = await send(input);
    if (!sent) return { success: false, error: 'Gönder butonu bulunamadı.' };

    console.log('[AutoFlow] Prompt sent:', text.slice(0, 50));
    return { success: true };
  }

  // ── Find input ────────────────────────────────────────
  // Google Flow uses a contenteditable div at the bottom of the page
  async function findInput() {
    const MAX_WAIT = 10000;
    const deadline = Date.now() + MAX_WAIT;

    while (Date.now() < deadline) {
      const el = pickBestInput();
      if (el) return el;
      await wait(400);
    }
    return null;
  }

  function pickBestInput() {
    // Gather all editable elements that are visible
    const candidates = [];

    // contenteditable divs (most likely in Google Flow)
    document.querySelectorAll('[contenteditable="true"], [contenteditable=""]').forEach(el => {
      if (visible(el) && !el.closest('[aria-hidden="true"]')) {
        candidates.push({ el, type: 'contenteditable' });
      }
    });

    // textareas
    document.querySelectorAll('textarea').forEach(el => {
      if (visible(el) && !el.closest('[aria-hidden="true"]')) {
        candidates.push({ el, type: 'textarea' });
      }
    });

    if (candidates.length === 0) return null;

    // Prefer the one lowest on screen (prompt input is always at the bottom)
    candidates.sort((a, b) => {
      const ra = a.el.getBoundingClientRect();
      const rb = b.el.getBoundingClientRect();
      // Higher .top = lower on page. We want the lowest.
      return rb.top - ra.top;
    });

    return candidates[0].el;
  }

  // ── Clear input ───────────────────────────────────────
  async function clearInput(el) {
    el.focus();
    if (el.isContentEditable) {
      // Select all and delete
      document.execCommand('selectAll', false, null);
      document.execCommand('delete', false, null);
    } else {
      // textarea / input
      const setter = Object.getOwnPropertyDescriptor(
        Object.getPrototypeOf(el), 'value'
      )?.set;
      if (setter) setter.call(el, '');
      else el.value = '';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }

  // ── Type text ─────────────────────────────────────────
  // Uses execCommand for contenteditable (triggers React's event listeners)
  // Uses native value setter for textarea
  async function typeText(el, text) {
    if (el.isContentEditable) {
      // execCommand('insertText') fires 'input' events that React captures
      const success = document.execCommand('insertText', false, text);
      if (!success || el.textContent.trim() === '') {
        // Fallback: direct manipulation + manual events
        el.textContent = text;
        el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text }));
      }
    } else {
      // textarea: use React's native setter trick
      const proto  = Object.getPrototypeOf(el);
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (setter) setter.call(el, text);
      else el.value = text;

      el.dispatchEvent(new Event('input',  { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }

  // ── Send / submit ─────────────────────────────────────
  async function send(inputEl) {
    // Strategy 1: find the send button near the input
    const btn = findSendBtn(inputEl);
    if (btn) {
      btn.click();
      return true;
    }

    // Strategy 2: press Enter (works for single-line or chat-style inputs)
    const enterEvent = new KeyboardEvent('keydown', {
      key: 'Enter', code: 'Enter', keyCode: 13,
      bubbles: true, cancelable: true
    });
    inputEl.dispatchEvent(enterEvent);
    inputEl.dispatchEvent(new KeyboardEvent('keyup', {
      key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true
    }));

    return true;
  }

  function findSendBtn(inputEl) {
    // Walk up the DOM from the input to find a container with buttons
    let container = inputEl;
    for (let i = 0; i < 10; i++) {
      container = container.parentElement;
      if (!container) break;

      const btns = [...container.querySelectorAll('button, [role="button"]')]
        .filter(b => visible(b) && !b.disabled);

      if (btns.length === 0) continue;

      // Prefer button with arrow/send SVG icon (no text, just icon)
      const iconOnlyBtns = btns.filter(b => b.querySelector('svg') && b.textContent.trim() === '');
      if (iconOnlyBtns.length > 0) {
        // The rightmost icon-only button is likely the send button
        iconOnlyBtns.sort((a, b) => b.getBoundingClientRect().left - a.getBoundingClientRect().left);
        return iconOnlyBtns[0];
      }

      // Prefer button with send-related aria-label
      const sendBtn = btns.find(b => {
        const label = (b.getAttribute('aria-label') || b.textContent || '').toLowerCase();
        return label.includes('send') || label.includes('gönder') ||
               label.includes('submit') || label.includes('generate') ||
               label.includes('create') || label.includes('run');
      });
      if (sendBtn) return sendBtn;
    }

    return null;
  }

  // ── Utilities ─────────────────────────────────────────
  function visible(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const s = window.getComputedStyle(el);
    return r.width > 0 && r.height > 0 &&
           s.display !== 'none' &&
           s.visibility !== 'hidden' &&
           parseFloat(s.opacity) > 0;
  }

  function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

  // ══════════════════════════════════════════════════════
  // GEÇİCİ TANI ARACI v2 — Flow ayar menülerini (model/oran/adet) haritalamak için
  // Tetikle:  document.dispatchEvent(new Event("autoflow-dump"))
  // (ayar feature'ı bitince bu blok silinecek)
  // ══════════════════════════════════════════════════════
  function afOneLine(s, n) { return (s || '').replace(/\s+/g, ' ').trim().slice(0, n); }

  function afDump() {
    const lines = [];
    lines.push('================ AutoFlow AYAR DÖKÜMÜ BAŞLADI ================');
    lines.push('URL: ' + location.href);

    const SEL = 'button, [role="button"], [role="switch"], [role="tab"], ' +
      '[role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"], ' +
      '[role="option"], [role="radio"], a[href], [contenteditable="true"], ' +
      '[contenteditable=""], textarea, [role="textbox"]';

    const els = [...document.querySelectorAll(SEL)].filter(visible);
    lines.push('--- Görünür etkileşimli eleman: ' + els.length + ' ---');
    els.forEach((el, i) => {
      const r = el.getBoundingClientRect();
      const a = n => el.getAttribute(n);
      const bits = [];
      if (a('role')) bits.push(`role="${a('role')}"`);
      if (a('aria-label')) bits.push(`aria="${afOneLine(a('aria-label'), 30)}"`);
      if (a('aria-pressed') != null) bits.push(`pressed=${a('aria-pressed')}`);
      if (a('aria-checked') != null) bits.push(`checked=${a('aria-checked')}`);
      if (a('aria-selected') != null) bits.push(`selected=${a('aria-selected')}`);
      if (a('aria-haspopup')) bits.push(`haspopup=${a('aria-haspopup')}`);
      if (a('data-state')) bits.push(`state=${a('data-state')}`);
      lines.push(
        `#${i} <${el.tagName}> text="${afOneLine(el.textContent, 40)}" ${bits.join(' ')} ` +
        `pos=(${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)}) ` +
        `| ${afOneLine(el.outerHTML, 150)}`
      );
    });

    // Açık menü/liste kapsayıcıları (radix portal'da olabilir)
    const cont = [...document.querySelectorAll('[role="menu"], [role="listbox"], [role="dialog"], [role="radiogroup"]')].filter(visible);
    lines.push('--- Açık menü/liste kapsayıcıları: ' + cont.length + ' ---');
    cont.forEach((el, i) => {
      const r = el.getBoundingClientRect();
      lines.push(`C#${i} <${el.tagName}> role="${el.getAttribute('role')}" text="${afOneLine(el.textContent, 80)}" pos=(${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)})`);
    });

    lines.push('================ AutoFlow AYAR DÖKÜMÜ BİTTİ — tümünü kopyalayın ================');
    console.log(lines.join('\n'));
  }

  document.addEventListener('autoflow-dump', afDump);

  // ── Ayar UYGULAMA (Aşama 1 testi) ──────────────────────
  // settings: { mode:'IMAGE'|'VIDEO', aspect:'LANDSCAPE'|'LANDSCAPE_4_3'|'SQUARE'|
  //             'PORTRAIT_3_4'|'PORTRAIT', count:1|2|3|4, model:'<isim parçası>' }
  // Bu fonksiyonun gövdesi doğrulanınca background.js'e taşınacak.
  async function afApplySettings(s) {
    const log = (...a) => console.log('[AutoFlow][ayar]', ...a);
    const isVis = el => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      const st = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && st.display !== 'none' && st.visibility !== 'hidden' && parseFloat(st.opacity) > 0;
    };
    function realClick(el) {
      const r = el.getBoundingClientRect();
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      const base = { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy, button: 0 };
      for (const type of ['pointerover', 'pointerenter', 'pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
        try {
          const Ev = type.startsWith('pointer') ? PointerEvent : MouseEvent;
          el.dispatchEvent(new Ev(type, { ...base, buttons: (type.includes('up') || type === 'click') ? 0 : 1 }));
        } catch (_) {}
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
    const wait = ms => new Promise(r => setTimeout(r, ms));
    const norm = t => (t || '').replace(/[^\p{L}\p{N}]+/gu, '').toLowerCase();

    // Ayar panelini açan buton: alt kompozisyon barındaki haspopup="menu" buton
    function findOpener() {
      return [...document.querySelectorAll('button[aria-haspopup="menu"]')].filter(isVis)
        .find(b => { const r = b.getBoundingClientRect(); return r.top > innerHeight * 0.55 && r.left > innerWidth * 0.3; }) || null;
    }
    function clickTab(suffix) {
      const t = [...document.querySelectorAll(`[role="tab"][id$="-trigger-${suffix}"]`)].filter(isVis)[0];
      if (t) { log('sekme:', suffix, t.getAttribute('aria-selected')); clickEl(t); return true; }
      log('sekme BULUNAMADI:', suffix); return false;
    }

    const opener = findOpener();
    if (!opener) { log('UYARI: ayar paneli açan buton bulunamadı'); return { success: false }; }
    if (opener.getAttribute('aria-expanded') !== 'true') { clickEl(opener); await wait(600); }

    if (s.mode)   { clickTab(s.mode);   await wait(700); } // mod değişince liste yenilenir
    if (s.aspect) { clickTab(s.aspect); await wait(400); }
    if (s.count)  { clickTab(String(s.count)); await wait(400); }

    if (s.model) {
      const openerRect = opener.getBoundingClientRect();
      const modelTrigger = [...document.querySelectorAll('button[aria-haspopup="menu"]')].filter(isVis)
        .find(b => { const r = b.getBoundingClientRect(); return b !== opener && r.top > innerHeight * 0.55 && r.bottom <= openerRect.top + 5; });
      if (modelTrigger) {
        if (modelTrigger.getAttribute('aria-expanded') !== 'true') { clickEl(modelTrigger); await wait(500); }
        const items = [...document.querySelectorAll('[role="menuitem"]')].filter(isVis);
        log('model öğeleri:', items.map(i => i.textContent.trim()));
        const want = norm(s.model);
        const item = items.find(i => norm(i.textContent) === want) || items.find(i => norm(i.textContent).includes(want));
        if (item) { log('model seçiliyor:', item.textContent.trim()); clickEl(item); await wait(500); }
        else log('model BULUNAMADI:', s.model);
      } else log('model açılır menüsü bulunamadı');
    }

    // Paneli kapat
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));
    log('bitti');
    return { success: true };
  }

  // Test tetikleyici: window.__afTestSettings ile ayar verilebilir; yoksa örnek uygula
  document.addEventListener('autoflow-apply-test', () => {
    const s = window.__afTestSettings || { mode: 'IMAGE', aspect: 'SQUARE', count: 4, model: 'Imagen' };
    console.log('%c[AutoFlow][ayar] Test uygulanıyor:', 'color:#7c5cff;font-weight:bold', s);
    afApplySettings(s);
  });

  console.log('%c[AutoFlow] Tanı/test aracı hazır. Döküm: document.dispatchEvent(new Event("autoflow-dump")) | Ayar testi: document.dispatchEvent(new Event("autoflow-apply-test"))', 'color:#7c5cff;font-weight:bold');
  // ══════════════════════════════════════════════════════

})();
