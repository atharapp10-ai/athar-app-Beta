/* ============================================================
   أثر — Athar | السكربت الرئيسي — (! MOD Dev)
   ============================================================
   Bug fixes applied:
   1. Referral activation now driven by DB triggers + explicit insert.
   2. Username fetched from profiles/get_leaderboard RPC, not email.
   3. Points counter no longer double-counts (DB is sole source of truth).
   4. "Available" counter derived from a single recompute path.
   ============================================================ */

(() => {
  'use strict';

  /* ============================================================
     ١. أدوات مساعدة عامة
     ============================================================ */

  const $  = (sel, ctx = document) => ctx.querySelector(sel);
  const $$ = (sel, ctx = document) => Array.from(ctx.querySelectorAll(sel));

  const prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const clamp = (v, min, max) => Math.min(Math.max(v, min), max);
  const easeOutCubic = t => 1 - Math.pow(1 - t, 3);

  const ARABIC_DIGITS = ['٠','١','٢','٣','٤','٥','٦','٧','٨','٩'];
  const toArabicDigits = n => String(n).replace(/\d/g, d => ARABIC_DIGITS[+d]);

  const REFERRAL_KEY = 'athar_pending_referral';
  const SOUND_KEY = 'athar_sound_enabled';

  const MAX_DEPTH = 4;
  const COOLDOWN_MS = 24 * 60 * 60 * 1000;
  const READING_DURATION = 30;

  /* ============================================================
     ٢. أدوات الأمان
     ============================================================ */

  function sanitizeText(raw) {
    if (raw == null) return '';
    return String(raw)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;')
      .replace(/\//g, '&#x2F;');
  }

  function escapeHTML(raw) {
    if (raw == null) return '';
    return String(raw)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function truncateText(text, maxLength) {
    if (!text) return '';
    const s = String(text).trim();
    if (s.length <= maxLength) return s;
    return s.slice(0, maxLength - 1) + '…';
  }

  /* ============================================================
     ٣. انتظار تهيئة عميل Supabase
     ============================================================ */

  function waitForSupabase(timeout = 6000) {
    return new Promise(resolve => {
      if (window.AtharSupabase) return resolve(window.AtharSupabase);
      let settled = false;
      const done = client => {
        if (settled) return;
        settled = true;
        window.removeEventListener('athar:supabase-ready', handler);
        resolve(client || window.AtharSupabase || null);
      };
      const handler = e => done(e && e.detail && e.detail.client);
      window.addEventListener('athar:supabase-ready', handler, { once: true });
      setTimeout(() => done(null), timeout);
    });
  }

  /* ============================================================
     ٤. الصوت والاهتزاز
     ============================================================ */

  let audioCtx = null;
  let soundEnabled = true;
  try {
    if (localStorage.getItem(SOUND_KEY) === 'off') soundEnabled = false;
  } catch (_) {}

  function ensureAudioCtx() {
    try {
      if (!audioCtx) {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) return null;
        audioCtx = new Ctx();
      }
      if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
      return audioCtx;
    } catch (_) { return null; }
  }

  function playChime() {
    if (!soundEnabled) return;
    const ctx = ensureAudioCtx();
    if (!ctx) return;
    try {
      const now = ctx.currentTime;
      const notes = [523.25, 659.25, 783.99];
      notes.forEach((freq, i) => {
        const osc  = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = freq;
        const t0 = now + i * 0.08;
        gain.gain.setValueAtTime(0, t0);
        gain.gain.linearRampToValueAtTime(0.07, t0 + 0.025);
        gain.gain.exponentialRampToValueAtTime(0.0008, t0 + 0.65);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(t0);
        osc.stop(t0 + 0.75);
      });
    } catch (_) {}
  }

  function playClick() {
    if (!soundEnabled) return;
    const ctx = ensureAudioCtx();
    if (!ctx) return;
    try {
      const now = ctx.currentTime;
      const osc  = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = 880;
      gain.gain.setValueAtTime(0.05, now);
      gain.gain.exponentialRampToValueAtTime(0.0008, now + 0.14);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.16);
    } catch (_) {}
  }

  function haptic(pattern) {
    try {
      if (navigator.vibrate) navigator.vibrate(pattern);
    } catch (_) {}
  }

  /* ============================================================
     ٥. التنبيه السريع (Toast)
     ============================================================ */

  const toastEl = $('#toast');
  const toastText = $('#toastText');
  let toastTimer = null;

  function showToast(message, duration = 2800) {
    if (!toastEl || !toastText) return;
    toastText.textContent = message;
    toastEl.classList.remove('is-visible');
    void toastEl.offsetWidth;
    toastEl.classList.add('is-visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('is-visible'), duration);
  }

  /* ============================================================
     ٦. حالة الاتصال بالإنترنت
     ============================================================ */

  const offlineBanner = $('#offlineBanner');

  function updateOnlineState() {
    if (!offlineBanner) return;
    offlineBanner.hidden = navigator.onLine;
  }

  window.addEventListener('online', () => {
    updateOnlineState();
    showToast('تم استعادة الاتصال بالإنترنت ✦');
    loadVersesFromSupabase();
    loadLeaderboardFromSupabase();
    refreshStatsFromSupabase();
    refreshTreeData();
  });

  window.addEventListener('offline', () => {
    updateOnlineState();
  });

  /* ============================================================
     ٧. تأثير الموجة (Ripple)
     ============================================================ */

  function spawnRipple(event, el) {
    if (prefersReduced || !el) return;
    const rect = el.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const size = Math.max(rect.width, rect.height) * 1.15;
    let px = event.clientX, py = event.clientY;
    if (!px && !py) { px = rect.left + rect.width / 2; py = rect.top + rect.height / 2; }
    const ripple = document.createElement('span');
    ripple.className = 'ripple';
    ripple.style.width = `${size}px`;
    ripple.style.height = `${size}px`;
    ripple.style.left = `${px - rect.left - size / 2}px`;
    ripple.style.top = `${py - rect.top - size / 2}px`;
    el.appendChild(ripple);
    ripple.addEventListener('animationend', () => ripple.remove(), { once: true });
    setTimeout(() => ripple.remove(), 900);
  }

  /* ============================================================
     ٨. أنيميشن الظهور المتدرّج
     ============================================================ */

  const revealEls = $$('.reveal');
  let revealObserver = null;

  if (prefersReduced) {
    revealEls.forEach(el => el.classList.add('is-visible'));
  } else if ('IntersectionObserver' in window) {
    revealObserver = new IntersectionObserver((entries, obs) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-visible');
          obs.unobserve(entry.target);
        }
      });
    }, { threshold: 0.12, rootMargin: '0px 0px -8% 0px' });
    revealEls.forEach(el => revealObserver.observe(el));
  } else {
    revealEls.forEach(el => el.classList.add('is-visible'));
  }

  function observeReveal(el) {
    if (!el) return;
    if (prefersReduced || !revealObserver) { el.classList.add('is-visible'); return; }
    revealObserver.observe(el);
  }

  /* ============================================================
     ٩. التنقل بين التبويبات الأربعة
     ============================================================ */

  const tabsNav = $('#tabsNav');
  const glider = $('#tabGlider');
  const tabs = $$('.tab');

  const panels = {
    verses: $('#panel-verses'),
    sadaqah: $('#panel-sadaqah'),
    tree: $('#panel-tree'),
    board: $('#panel-board')
  };

  function positionGlider(activeTab) {
    if (!glider || !activeTab) return;
    glider.style.width = `${activeTab.offsetWidth}px`;
    glider.style.transform = `translateX(${activeTab.offsetLeft}px)`;
  }

  function initGlider() {
    const active = $('.tab.is-active') || tabs[0];
    if (!glider || !active) return;
    glider.style.transition = 'none';
    positionGlider(active);
    void glider.offsetWidth;
    requestAnimationFrame(() => glider.style.transition = '');
  }

  function revealPanel(panel) {
    if (!panel) return;
    const els = $$('.reveal', panel);
    if (!els.length) return;
    if (prefersReduced) { els.forEach(el => el.classList.add('is-visible')); return; }
    requestAnimationFrame(() => requestAnimationFrame(() => {
      els.forEach(el => el.classList.add('is-visible'));
    }));
  }

  function activateTab(tab, animate = true) {
    if (!tab) return;
    const target = tab.dataset.target;
    if (!target || !panels[target]) return;

    tabs.forEach(t => {
      const on = t === tab;
      t.classList.toggle('is-active', on);
      t.setAttribute('aria-selected', on ? 'true' : 'false');
      t.tabIndex = on ? 0 : -1;
    });

    Object.keys(panels).forEach(key => {
      if (panels[key]) panels[key].classList.toggle('is-active', key === target);
    });

    if (animate) positionGlider(tab);
    else if (glider) {
      const prev = glider.style.transition;
      glider.style.transition = 'none';
      positionGlider(tab);
      void glider.offsetWidth;
      glider.style.transition = prev;
    }

    if (target === 'tree') {
      revealPanel(panels.tree);
      refreshTreeData();
      requestAnimationFrame(() => requestAnimationFrame(() => {
        if (treeState.canvas) {
          resizeCanvas();
          if (!treeState.centered) {
            centerTreeView();
            treeState.centered = true;
          }
          renderTree();
        }
      }));
    } else {
      closeNodePopover();
      if (target === 'verses')  revealPanel(panels.verses);
      if (target === 'sadaqah') revealPanel(panels.sadaqah);
      if (target === 'board')   revealPanel(panels.board);
    }
  }

  if (tabsNav && tabs.length) {
    tabsNav.addEventListener('click', e => {
      const tab = e.target.closest('.tab');
      if (!tab || !tabsNav.contains(tab)) return;
      activateTab(tab, true);
    });

    tabsNav.addEventListener('keydown', e => {
      const key = e.key;
      if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].indexOf(key) === -1) return;
      const idx = tabs.findIndex(t => t.classList.contains('is-active'));
      if (idx === -1) return;
      e.preventDefault();

      const isRTL = document.documentElement.dir === 'rtl';
      let delta = 0;
      if (key === 'ArrowLeft')  delta = isRTL ? 1 : -1;
      if (key === 'ArrowRight') delta = isRTL ? -1 : 1;

      let next;
      if (key === 'Home') next = 0;
      else if (key === 'End') next = tabs.length - 1;
      else next = (idx + delta + tabs.length) % tabs.length;

      const nextTab = tabs[next];
      if (!nextTab) return;
      nextTab.focus();
      activateTab(nextTab, true);
    });

    let resizeRaf = null;
    window.addEventListener('resize', () => {
      if (resizeRaf) cancelAnimationFrame(resizeRaf);
      resizeRaf = requestAnimationFrame(() => {
        const active = $('.tab.is-active');
        if (!active || !glider) return;
        const prev = glider.style.transition;
        glider.style.transition = 'none';
        positionGlider(active);
        void glider.offsetWidth;
        glider.style.transition = prev;
      });
    }, { passive: true });
  }

  /* ============================================================
     ١٠. قسم الآيات والأحاديث
     ============================================================ */

  const versesGrid = $('#versesGrid');

  /* ----------------------------------------
     حالة الإحصاءات — مصدرها الوحيد هو DB
     ----------------------------------------
     totalVerses      : عدد النصوص المنشورة (is_archived=false)
     completedCount   : عدد النصوص التي أتمّها المستخدم الحالي
     totalPoints      : مجموع نقاط المستخدم من profile_stats (أو profiles)
     availableCount   : totalVerses - completedCount   (Bug 4)
     ---------------------------------------- */
  const statsState = {
    totalVerses: 0,
    completedCount: 0,
    totalPoints: 0,
    availableCount: 0
  };

  const userReadsMap = new Map();
  let currentUserId = null;

  function animateStat(key, to) {
    const el = $(`[data-stat="${key}"]`);
    if (!el) return;
    const from = parseInt(el.textContent, 10) || 0;
    if (prefersReduced || from === to) { el.textContent = String(to); return; }
    const duration = 720;
    const startTime = performance.now();
    const step = now => {
      const t = clamp((now - startTime) / duration, 0, 1);
      el.textContent = String(Math.round(from + (to - from) * easeOutCubic(t)));
      if (t < 1) requestAnimationFrame(step);
      else el.textContent = String(to);
    };
    requestAnimationFrame(step);
  }

  /**
   * Bug 4 fix: single source of truth for the derived "available" counter.
   * Called after any change to totalVerses or completedCount.
   */
  function recomputeDerivedStats() {
    statsState.availableCount = Math.max(
      0,
      Number(statsState.totalVerses || 0) - Number(statsState.completedCount || 0)
    );
    animateStat('available', statsState.availableCount);
    animateStat('completed', statsState.completedCount);
    animateStat('points',    statsState.totalPoints);
  }

  async function getCurrentUsername() {
    try {
      const sb = window.AtharSupabase;
      if (!sb) return '';
      const { data } = await sb.auth.getUser();
      return (data && data.user && data.user.user_metadata && data.user.user_metadata.username)
        ? String(data.user.user_metadata.username).trim()
        : '';
    } catch (_) { return ''; }
  }

  async function buildShareLink(name, verseId) {
    const username = await getCurrentUsername();
    const params = new URLSearchParams();
    if (username) params.set('ref', username);
    if (verseId)  params.set('deed', verseId);
    const query = params.toString() ? `?${params}` : '';
    const slug  = encodeURIComponent((name || '').trim().replace(/\s+/g, '-'));
    const base  = `${location.origin}${location.pathname}`;
    return {
      url:    `${base}${query}#athar-${slug}`,
      slug,
      username,
      verseId
    };
  }

  async function copyShareLink(name, verseId) {
    const link = await buildShareLink(name, verseId);
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(link.url);
        return true;
      }
    } catch (_) {}
    try {
      const ta = document.createElement('textarea');
      ta.value = link.url;
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0;';
      document.body.appendChild(ta);
      ta.select();
      ta.setSelectionRange(0, ta.value.length);
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch (_) { return false; }
  }

  function formatCountdown(ms) {
    if (ms <= 0) return '00:00:00';
    const totalSec = Math.floor(ms / 1000);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  function applyCooldownState(card, expiry) {
    if (!card) return;
    card.dataset.cooldownExpiry = String(expiry);
    const btn = card.querySelector('.btn-verse-complete');
    if (btn) {
      btn.disabled = true;
      btn.classList.add('is-cooldown');
      const label = btn.querySelector('.btn-text');
      if (label) label.textContent = 'تمّ الإتمام';
    }
    const cooldown = card.querySelector('.verse-cooldown');
    if (cooldown) cooldown.hidden = false;
    refreshCooldownDisplay(card);
  }

  function clearCooldownState(card) {
    if (!card) return;
    delete card.dataset.cooldownExpiry;
    const btn = card.querySelector('.btn-verse-complete');
    if (btn) {
      btn.disabled = false;
      btn.classList.remove('is-cooldown');
      const label = btn.querySelector('.btn-text');
      if (label) label.textContent = 'قراءة وإتمام';
    }
    const cooldown = card.querySelector('.verse-cooldown');
    if (cooldown) cooldown.hidden = true;
  }

  function refreshCooldownDisplay(card) {
    if (!card) return;
    const expiry = parseInt(card.dataset.cooldownExpiry || '0', 10);
    if (!expiry) return;
    const remaining = expiry - Date.now();
    if (remaining <= 0) { clearCooldownState(card); return; }
    const timerEl = card.querySelector('.cooldown-timer');
    if (timerEl) timerEl.textContent = formatCountdown(remaining);
  }

  setInterval(() => {
    document.querySelectorAll('.verse-card[data-cooldown-expiry]').forEach(refreshCooldownDisplay);
  }, 1000);

  async function loadUserReads() {
    userReadsMap.clear();
    const sb = await waitForSupabase();
    if (!sb) return;
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return;

    const { data, error } = await sb
      .from('user_reads')
      .select('verse_id, read_at')
      .eq('user_id', user.id)
      .order('read_at', { ascending: false });

    if (error) {
      console.warn('[أثر] تعذّر تحميل سجل القراءات:', error.message);
      return;
    }

    for (const row of (data || [])) {
      if (!userReadsMap.has(row.verse_id)) {
        userReadsMap.set(row.verse_id, new Date(row.read_at).getTime());
      }
    }
  }

  function renderEmptyState(opts) {
    const wrap = document.createElement('div');
    wrap.className = 'empty-state';
    wrap.innerHTML = `
      <span class="empty-state-icon" aria-hidden="true">${opts.icon || ''}</span>
      <span class="empty-state-title">${escapeHTML(opts.title)}</span>
      <span class="empty-state-text">${escapeHTML(opts.text)}</span>
      ${opts.ctaLabel ? `<button class="empty-state-cta" type="button">${escapeHTML(opts.ctaLabel)}</button>` : ''}
    `;
    if (opts.ctaLabel && typeof opts.onCta === 'function') {
      wrap.querySelector('.empty-state-cta').addEventListener('click', opts.onCta);
    }
    return wrap;
  }

  const ICON_BOOK = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4.6h6.4a2.4 2.4 0 0 1 2.4 2.4v12.6a2 2 0 0 0-2-2H4Z"/><path d="M20 4.6h-6.4a2.4 2.4 0 0 0-2.4 2.4v12.6a2 2 0 0 1 2-2H20Z"/></svg>`;
  const ICON_TROPHY = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M8 21h8"/><path d="M12 17v4"/><path d="M17.5 3.5h2.2A1.3 1.3 0 0 1 21 4.8c0 2.4-1.6 4.4-4 5.1"/><path d="M6.5 3.5H4.3A1.3 1.3 0 0 0 3 4.8c0 2.4 1.6 4.4 4 5.1"/><path d="M6.6 3.5h10.8v5.1a5.4 5.4 0 0 1-10.8 0V3.5Z"/></svg>`;
  const ICON_OFFLINE = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M2 2l20 20"/><path d="M5 12.5a10 10 0 0 1 4.5-2.6"/><path d="M19 12.5a10 10 0 0 0-2.5-2.1"/><path d="M8.5 16a5 5 0 0 1 4-1.9"/><path d="M15.5 16a5 5 0 0 0-1.6-1.4"/><path d="M12 20h.01"/></svg>`;

  function renderVersesEmpty(message, opts) {
    if (!versesGrid) return;
    versesGrid.innerHTML = '';
    const state = renderEmptyState({
      icon: opts && opts.offline ? ICON_OFFLINE : ICON_BOOK,
      title: opts && opts.offline ? 'تعذّر الاتصال' : message,
      text: opts && opts.offline
        ? 'تحقّق من اتصالك بالإنترنت ثم أعد المحاولة.'
        : 'سيظهر هنا أول نصٍ يضيفه المشرف من لوحة الإدارة.',
      ctaLabel: 'إعادة المحاولة',
      onCta: () => loadVersesFromSupabase()
    });
    versesGrid.appendChild(state);
    statsState.totalVerses = 0;
    recomputeDerivedStats();
  }

  function buildVerseCard(data) {
    const isHadith = data.type === 'hadith';
    const article = document.createElement('article');
    article.className = 'verse-card';
    if (data.id) article.dataset.id = data.id;
    article.dataset.deed = data.reference;
    article.dataset.type = data.type;
    article.dataset.points = String(data.points);

    const iconPath = isHadith
      ? '<path d="M12 21.2v-5.6" /><path d="M12 15.6c-3.4 0-5.8-2.1-5.8-5 0-2.2 1.5-3.8 3.3-4C9.8 4.7 10.8 2.6 12 2.6s2.2 2.1 2.5 4c1.8.2 3.3 1.8 3.3 4 0 2.9-2.4 5-5.8 5Z" />'
      : '<path d="M4 4.6h6.4a2.4 2.4 0 0 1 2.4 2.4v12.6a2 2 0 0 0-2-2H4Z" /><path d="M20 4.6h-6.4a2.4 2.4 0 0 0-2.4 2.4v12.6a2 2 0 0 1 2-2H20Z" />';

    article.innerHTML = `
      <span class="card-sheen" aria-hidden="true"></span>
      <div class="verse-head">
        <span class="verse-badge ${isHadith ? 'verse-badge-hadith' : 'verse-badge-ayah'}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${iconPath}</svg>
          <span>${isHadith ? 'حديث شريف' : 'آية قرآنية'}</span>
        </span>
        <span class="card-points">
          <span class="card-points-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
              <path d="M12 2 15.09 8.26 22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2Z" />
            </svg>
          </span>
          <b>${data.points}</b>
          <span>نقطة</span>
        </span>
      </div>

      <blockquote class="verse-text"></blockquote>
      <cite class="verse-ref"></cite>

      <div class="verse-actions">
        <button class="btn-verse btn-verse-share" type="button" data-action="share">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <circle cx="18" cy="5" r="3" /><circle cx="6" cy="12" r="3" /><circle cx="18" cy="19" r="3" />
            <path d="m8.6 13.5 6.8 3.9" /><path d="m15.4 6.6-6.8 3.9" />
          </svg>
          <span class="btn-text">مشاركة النص</span>
        </button>

        <button class="btn-verse btn-verse-complete" type="button" data-action="complete">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M20 6 9 17l-5-5" />
          </svg>
          <span class="btn-text">قراءة وإتمام</span>
        </button>
      </div>

      <div class="verse-cooldown" hidden>
        <span class="cooldown-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" />
          </svg>
        </span>
        <span class="cooldown-label">متاح للقراءة مجدداً بعد</span>
        <span class="cooldown-timer" aria-live="polite">23:59:59</span>
      </div>
    `;

    article.querySelector('.verse-text').textContent = data.content || '';
    article.querySelector('.verse-ref').textContent  = data.reference || '';

    if (data.id) {
      const lastRead = userReadsMap.get(data.id);
      if (lastRead) {
        const expiry = lastRead + COOLDOWN_MS;
        if (expiry > Date.now()) applyCooldownState(article, expiry);
      }
    }

    return article;
  }

  function renderVerses(rows) {
    if (!versesGrid) return;
    versesGrid.innerHTML = '';
    const list = Array.isArray(rows) ? rows : [];
    if (!list.length) { renderVersesEmpty('لا توجد نصوص منشورة بعد'); return; }

    const frag = document.createDocumentFragment();
    list.forEach((row, i) => {
      const card = buildVerseCard({
        id: row.id,
        type: row.type,
        reference: row.reference,
        content: row.content,
        points: row.points
      });
      card.classList.add('reveal');
      card.style.setProperty('--i', String(i));
      frag.appendChild(card);
      observeReveal(card);
    });
    versesGrid.appendChild(frag);

    // Bug 4 fix: update the source of truth, then recompute derived stats.
    statsState.totalVerses = list.length;
    recomputeDerivedStats();
  }

  async function loadVersesFromSupabase() {
    if (!versesGrid) return;

    if (!navigator.onLine) {
      renderVersesEmpty('لا يمكن التحميل', { offline: true });
      return;
    }

    await loadUserReads();
    const sb = await waitForSupabase();
    if (!sb) { renderVersesEmpty('تعذّر الاتصال بقاعدة البيانات'); return; }

    const { data, error } = await sb
      .from('verses')
      .select('id, type, reference, content, points, created_at, is_archived')
      .eq('is_archived', false)
      .order('created_at', { ascending: false });

    if (error) {
      console.error('[أثر] فشل جلب النصوص:', error.message);
      showToast('تعذّر تحميل الآيات والأحاديث');
      renderVersesEmpty('حدث خطأ أثناء التحميل');
      return;
    }
    renderVerses(data);
  }

  async function handleVerseAction(e) {
    const shareBtn = e.target.closest('[data-action="share"]');
    const completeBtn = e.target.closest('[data-action="complete"]');
    if (!shareBtn && !completeBtn) return;
    if (!versesGrid.contains(shareBtn || completeBtn)) return;

    const card = (shareBtn || completeBtn).closest('.verse-card');
    if (!card) return;

    const name = card.dataset.deed || 'نص';
    const verseId = card.dataset.id;

    if (shareBtn) {
      spawnRipple(e, shareBtn);
      playClick();
      haptic(12);

      const link = await buildShareLink(name, verseId);
      const shareData = {
        title: 'أثر — الصدقة الجارية',
        text: `اقرأ: ${name}`,
        url: link.url
      };

      if (navigator.share && navigator.canShare && navigator.canShare(shareData)) {
        try {
          await navigator.share(shareData);
          return;
        } catch (err) {
          if (err && err.name === 'AbortError') return;
        }
      }

      openShareSheet({
        title: name,
        content: card.querySelector('.verse-text') ? card.querySelector('.verse-text').textContent : '',
        url: link.url,
        verseId: verseId
      });
      return;
    }

    if (completeBtn) {
      if (completeBtn.disabled || completeBtn.classList.contains('is-cooldown')) return;
      spawnRipple(e, completeBtn);
      playClick();
      haptic(12);

      const verse = {
        id: verseId,
        type: card.dataset.type || 'ayah',
        reference: name,
        content: card.querySelector('.verse-text') ? card.querySelector('.verse-text').textContent : '',
        points: parseInt(card.dataset.points, 10) || 0
      };
      openDeedView(verse, null);
    }
  }

  if (versesGrid) versesGrid.addEventListener('click', handleVerseAction);

  /* ============================================================
     ١١. لوحة الشرف — Bug 2 fix: use get_leaderboard RPC
     ============================================================ */

  const boardEl = $('#board');
  const RANK_META = { 1: { cls: 'rank-1' }, 2: { cls: 'rank-2' }, 3: { cls: 'rank-3' } };
  const MEDAL_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 21h8" /><path d="M12 17v4" /><path d="M17.5 3.5h2.2A1.3 1.3 0 0 1 21 4.8c0 2.4-1.6 4.4-4 5.1" /><path d="M6.5 3.5H4.3A1.3 1.3 0 0 0 3 4.8c0 2.4 1.6 4.4 4 5.1" /><path d="M6.6 3.5h10.8v5.1a5.4 5.4 0 0 1-10.8 0V3.5Z" /></svg>`;

  function formatJoinDate(iso) {
    if (!iso) return '';
    try {
      const d = new Date(iso);
      const months = ['يناير','فبراير','مارس','أبريل','مايو','يونيو','يوليو','أغسطس','سبتمبر','أكتوبر','نوفمبر','ديسمبر'];
      return `انضم في ${months[d.getMonth()]} ${toArabicDigits(d.getFullYear())}`;
    } catch (_) { return ''; }
  }

  function buildBoardRow(profile, index) {
    const rank = index + 1;
    const meta = RANK_META[rank];
    const row = document.createElement('article');
    row.className = 'board-row reveal';
    if (meta) row.classList.add(meta.cls);
    row.style.setProperty('--i', String(Math.min(index, 10)));
    const username = profile.username || 'عضو';
    const points = Number(profile.points) || 0;
    const subtitle = formatJoinDate(profile.created_at) || 'عضو في أثر';

    row.innerHTML = `
      ${meta ? `<span class="medal" aria-hidden="true">${MEDAL_SVG}</span>` : ''}
      <span class="rank-num" aria-hidden="true">${toArabicDigits(rank)}</span>
      <div class="board-info"><span class="board-name"></span><span class="board-sub"></span></div>
      <span class="board-score"><b>${toArabicDigits(points)}</b><i>نقطة</i></span>`;

    row.querySelector('.board-name').textContent = username;
    row.querySelector('.board-sub').textContent  = subtitle;
    return row;
  }

  function renderBoard(rows) {
    if (!boardEl) return;
    boardEl.innerHTML = '';
    const list = Array.isArray(rows) ? rows : [];
    if (!list.length) {
      boardEl.appendChild(renderEmptyState({
        icon: ICON_TROPHY,
        title: 'لا يوجد أعضاء بعد',
        text: 'كن أول من ينشر أثراً، فيبدأ ترتيبك من القمة.'
      }));
      return;
    }
    list.forEach((row, i) => {
      const el = buildBoardRow(row, i);
      boardEl.appendChild(el);
      observeReveal(el);
    });
  }

  function renderBoardSkeleton() {
    if (!boardEl) return;
    boardEl.innerHTML = '';
    for (let i = 0; i < 5; i++) {
      const row = document.createElement('article');
      row.className = 'board-row is-skeleton';
      row.innerHTML = `
        <span class="rank-num" aria-hidden="true">${toArabicDigits(i + 1)}</span>
        <div class="board-info">
          <span class="board-name" style="width:40%;height:14px;background:rgba(42,59,44,.08);border-radius:6px;display:inline-block">&nbsp;</span>
          <span class="board-sub"  style="width:60%;height:10px;margin-top:6px;background:rgba(42,59,44,.06);border-radius:6px;display:inline-block">&nbsp;</span>
        </div>
        <span class="board-score"><b>&nbsp;</b></span>`;
      boardEl.appendChild(row);
    }
  }

  async function loadLeaderboardFromSupabase() {
    if (!boardEl) return;

    if (!navigator.onLine) {
      boardEl.innerHTML = '';
      boardEl.appendChild(renderEmptyState({
        icon: ICON_OFFLINE,
        title: 'تعذّر الاتصال',
        text: 'تحقّق من اتصالك بالإنترنت ثم أعد المحاولة.',
        ctaLabel: 'إعادة المحاولة',
        onCta: () => loadLeaderboardFromSupabase()
      }));
      return;
    }

    renderBoardSkeleton();
    const sb = await waitForSupabase();
    if (!sb) { renderBoard([]); return; }

    // Bug 2 fix: prefer RPC (returns COALESCE'd username), fall back to table.
    let rows = [];
    try {
      const { data, error } = await sb.rpc('get_leaderboard', { limit_count: 20 });
      if (!error && Array.isArray(data)) {
        rows = data;
      } else if (error) {
        console.warn('[أثر] RPC get_leaderboard فشل، استخدام الاستعلام الاحتياطي:', error.message);
      }
    } catch (err) {
      console.warn('[أثر] خطأ RPC:', err);
    }

    if (!rows.length) {
      const { data, error } = await sb
        .from('profiles')
        .select('id, username, points, created_at')
        .order('points', { ascending: false })
        .order('created_at', { ascending: true })
        .limit(20);
      if (error) {
        console.error('[أثر] فشل جلب لوحة الشرف:', error.message);
        renderBoard([]);
        return;
      }
      rows = data || [];
    }

    // Defensive: guarantee username is never an email prefix.
    rows = rows.map(r => ({
      id: r.id,
      username: (r.username && String(r.username).trim()) || 'عضو',
      points: Number(r.points) || 0,
      created_at: r.created_at
    }));

    renderBoard(rows);
  }

  /* ============================================================
     ١٢. متزامنة النقاط والإحصاءات
     ============================================================ */

  const pointsState = {
    el: null, totalEl: null, personalEl: null, referralEl: null,
    lastTotal: 0, lastPersonal: 0, lastReferral: 0
  };

  function injectTreeStatsIfMissing() {
    let el = $('#treeStats');
    if (!el && panels.tree) {
      el = document.createElement('div');
      el.className = 'tree-stats';
      el.id = 'treeStats';
      el.innerHTML = `
        <div class="tree-stat-primary">
          <span class="tree-stat-label">نقاط الأثر</span>
          <span class="tree-stat-value" id="treeStatsTotal">٠</span>
        </div>
        <div class="tree-stat-breakdown">
          <div class="tree-stat-chip"><span class="tree-stat-chip-label">أعمالك</span><span class="tree-stat-chip-value" id="treeStatsPersonal">٠</span></div>
          <div class="tree-stat-chip is-referral"><span class="tree-stat-chip-label">الأثر المُشارَك</span><span class="tree-stat-chip-value" id="treeStatsReferral">٠</span></div>
        </div>`;
      const stage = $('#treeStage');
      if (stage && stage.parentNode) stage.parentNode.insertBefore(el, stage);
    }
    pointsState.el = el;
    pointsState.totalEl = $('#treeStatsTotal');
    pointsState.personalEl = $('#treeStatsPersonal');
    pointsState.referralEl = $('#treeStatsReferral');
  }

  function animateValue(el, from, to, duration = 720) {
    if (!el) return;
    if (prefersReduced || from === to) { el.textContent = toArabicDigits(to); return; }
    const startTime = performance.now();
    const step = now => {
      const t = clamp((now - startTime) / duration, 0, 1);
      const v = Math.round(from + (to - from) * easeOutCubic(t));
      el.textContent = toArabicDigits(v);
      if (t < 1) requestAnimationFrame(step);
      else el.textContent = toArabicDigits(to);
    };
    requestAnimationFrame(step);
  }

  function applyPointsCounter(stats) {
    if (!pointsState.el) return;
    const total    = Number(stats && stats.total_points    != null ? stats.total_points    : 0);
    const personal = Number(stats && stats.personal_points != null ? stats.personal_points : 0);
    const referral = Number(stats && stats.referral_points != null ? stats.referral_points : 0);
    animateValue(pointsState.totalEl,    pointsState.lastTotal,    total);
    animateValue(pointsState.personalEl, pointsState.lastPersonal, personal);
    animateValue(pointsState.referralEl, pointsState.lastReferral, referral);
    pointsState.lastTotal    = total;
    pointsState.lastPersonal = personal;
    pointsState.lastReferral = referral;
    // Mirror into the top stats row
    statsState.totalPoints = total;
  }

  async function refreshStatsFromSupabase() {
    injectTreeStatsIfMissing();

    let stats = {
      total_points: 0,
      personal_points: 0,
      referral_points: 0,
      completed_count: 0
    };

    const sb = await waitForSupabase();
    if (!sb) {
      applyPointsCounter(stats);
      statsState.completedCount = 0;
      recomputeDerivedStats();
      return;
    }

    const { data: { user } } = await sb.auth.getUser();
    currentUserId = user ? user.id : null;

    if (user) {
      try {
        const { data: profileStats } = await sb
          .from('profile_stats')
          .select('total_points, personal_points, referral_points, referral_count')
          .eq('id', user.id)
          .maybeSingle();

        if (profileStats) {
          stats.total_points    = Number(profileStats.total_points)    || 0;
          stats.personal_points = Number(profileStats.personal_points) || 0;
          stats.referral_points = Number(profileStats.referral_points) || 0;
        } else {
          // Fallback: read from profiles table directly
          const { data: profile } = await sb
            .from('profiles')
            .select('points')
            .eq('id', user.id)
            .maybeSingle();
          if (profile) {
            stats.total_points = Number(profile.points) || 0;
            stats.personal_points = stats.total_points;
          }
        }

        const { count } = await sb
          .from('user_reads')
          .select('id', { count: 'exact', head: true })
          .eq('user_id', user.id);

        stats.completed_count = count || 0;
      } catch (err) {
        console.warn('[أثر] فشل تحميل الإحصاءات:', err);
      }
    }

    applyPointsCounter(stats);
    statsState.completedCount = stats.completed_count;
    recomputeDerivedStats();
  }

  /* ============================================================
     ١٣. شجرة الأثر — كانفس عالي الدقة
     ============================================================ */

  const treeState = {
    container: null,
    canvas: null,
    ctx: null,

    dpr: 1,
    cssWidth: 0,
    cssHeight: 0,

    rootProfile: null,
    referrals: [],
    nodes: [],
    branches: [],
    rootNode: null,
    bounds: null,

    view: {
      scale: 1,
      offsetX: 0,
      offsetY: 0
    },

    hovered: null,
    dragging: false,
    dragStart: null,
    pointerMoved: false,
    dragThreshold: 6,

    minScale: 0.35,
    maxScale: 2.8,

    rafId: null,
    centered: false,
    userHasPanned: false,
    lastSignature: ''
  };

  function resizeCanvas() {
    if (!treeState.canvas || !treeState.container || !treeState.ctx) return;

    const rect = treeState.container.getBoundingClientRect();
    if (rect.width < 10 || rect.height < 10) return;

    const dpr = window.devicePixelRatio || 1;

    treeState.dpr       = dpr;
    treeState.cssWidth  = Math.round(rect.width);
    treeState.cssHeight = Math.round(rect.height);

    treeState.canvas.width  = Math.round(treeState.cssWidth  * dpr);
    treeState.canvas.height = Math.round(treeState.cssHeight * dpr);

    treeState.canvas.style.width  = treeState.cssWidth  + 'px';
    treeState.canvas.style.height = treeState.cssHeight + 'px';

    treeState.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function screenToWorld(sx, sy) {
    return {
      x: (sx - treeState.cssWidth  / 2 - treeState.view.offsetX) / treeState.view.scale,
      y: (sy - treeState.cssHeight / 2 - treeState.view.offsetY) / treeState.view.scale
    };
  }

  function worldToScreen(wx, wy) {
    return {
      x: wx * treeState.view.scale + treeState.cssWidth  / 2 + treeState.view.offsetX,
      y: wy * treeState.view.scale + treeState.cssHeight / 2 + treeState.view.offsetY
    };
  }

  function buildTreeLayout(rootProfile, referrals) {
    const childrenOf = new Map();
    const nameById   = new Map();
    const depthById  = new Map();

    if (rootProfile && rootProfile.id) {
      nameById.set(rootProfile.id, rootProfile.username || 'أنت');
      depthById.set(rootProfile.id, 0);
    }

    (referrals || []).forEach(r => {
      nameById.set(r.node_id, r.username || 'عضو');
      depthById.set(r.node_id, Number(r.depth) || 0);
      const key = r.parent_id;
      if (!childrenOf.has(key)) childrenOf.set(key, []);
      childrenOf.get(key).push(r);
    });

    const nodes = [];
    const branches = [];

    const rootNode = {
      id:          (rootProfile && rootProfile.id) || 'root',
      parentId:    null,
      parentName:  null,
      parentDepth: null,
      viaName:     null,
      name:        (rootProfile && rootProfile.username) || 'أنت',
      depth:       0,
      x: 0, y: 0,
      isRoot:      true,
      isAnonymous: false,
      joinedAt:    (rootProfile && rootProfile.created_at) || null,
      points:      Number((rootProfile && rootProfile.points) || 0),
      radius:      46
    };
    nodes.push(rootNode);

    const MAX_DEPTH_LAYOUT = MAX_DEPTH;
    const VERTICAL_GAP = 190;

    function place(parentNode, depth, nearestNamedAncestor) {
      if (depth >= MAX_DEPTH_LAYOUT) return;

      const kids = childrenOf.get(parentNode.id) || [];
      if (!kids.length) return;

      const horizontalGap = Math.max(120, 340 / (depth + 1));
      const totalWidth = (kids.length - 1) * horizontalGap;
      const startX = parentNode.x - totalWidth / 2;
      const childY = parentNode.y + VERTICAL_GAP;

      const childDepth       = depth + 1;
      const childIsAnonymous = childDepth >= 2;

      const childViaName = childIsAnonymous
        ? (parentNode.isAnonymous ? nearestNamedAncestor : parentNode.name)
        : null;

      kids.forEach((kid, i) => {
        const kidX = startX + i * horizontalGap;
        const kidNode = {
          id:          kid.node_id,
          parentId:    parentNode.id,
          parentName:  parentNode.name,
          parentDepth: parentNode.depth,
          viaName:     childViaName,
          name:        kid.username || 'عضو',
          depth:       childDepth,
          x: kidX,
          y: childY,
          isRoot:      false,
          isAnonymous: childIsAnonymous,
          joinedAt:    kid.activated_at || null,
          points:      Number(kid.points_awarded || 0),
          radius:      Math.max(30, 42 - depth * 4)
        };
        nodes.push(kidNode);
        branches.push({ from: parentNode, to: kidNode, depth: childDepth });
        place(kidNode, childDepth, childViaName);
      });
    }

    place(rootNode, 0, rootNode.name);

    treeState.nodes      = nodes;
    treeState.branches   = branches;
    treeState.rootNode   = rootNode;

    if (nodes.length > 0) {
      let minX =  Infinity, maxX = -Infinity;
      let minY =  Infinity, maxY = -Infinity;
      for (const n of nodes) {
        if (n.x - n.radius < minX) minX = n.x - n.radius;
        if (n.x + n.radius > maxX) maxX = n.x + n.radius;
        if (n.y - n.radius < minY) minY = n.y - n.radius;
        if (n.y + n.radius + 60 > maxY) maxY = n.y + n.radius + 60;
      }
      treeState.bounds = { minX, maxX, minY, maxY };
    }
  }

  function centerTreeView() {
    if (!treeState.rootNode || !treeState.cssWidth) return;
    treeState.view.offsetX = 0;
    treeState.view.offsetY = -treeState.cssHeight * 0.30;
    treeState.view.scale   = 1;
    treeState.userHasPanned = false;
  }

  function drawBranch(ctx, branch) {
    const from = branch.from, to = branch.to, depth = branch.depth;

    const maxD = Math.max(treeState.nodes.reduce((m, n) => Math.max(m, n.depth), 1), 1);
    const t = clamp(depth / maxD, 0, 1);

    const r = Math.round(139 + (240 - 139) * t);
    const g = Math.round(79  + (225 - 79)  * t);
    const b = Math.round(51  + (200 - 51)  * t);

    const alpha = 1 - t * 0.35;
    const width = Math.max(1.2, 5 * (1 - t) + 1);

    const midX = (from.x + to.x) / 2;
    const midY = (from.y + to.y) / 2;
    const curveOffset = (to.x - from.x) * 0.04;

    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = `rgba(${r}, ${g}, ${b}, ${alpha})`;
    ctx.lineWidth = width;
    ctx.shadowColor = `rgba(193, 119, 83, ${alpha * 0.7})`;
    ctx.shadowBlur = 10;
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.quadraticCurveTo(midX + curveOffset, midY, to.x, to.y);
    ctx.stroke();
    ctx.restore();
  }

  function drawNode(ctx, node) {
    const x = node.x, y = node.y, radius = node.radius;
    const isRoot = node.isRoot, isAnonymous = node.isAnonymous;
    const name = node.name;
    const isHovered = treeState.hovered === node;
    const r = radius * (isHovered ? 1.10 : 1);

    const haloRadius = r * 3.6;
    const haloGradient = ctx.createRadialGradient(x, y, 0, x, y, haloRadius);
    if (isRoot) {
      haloGradient.addColorStop(0, 'rgba(216, 154, 120, 0.58)');
      haloGradient.addColorStop(0.42, 'rgba(193, 119, 83, 0.20)');
      haloGradient.addColorStop(1, 'rgba(193, 119, 83, 0)');
    } else if (isAnonymous) {
      haloGradient.addColorStop(0, 'rgba(180, 165, 140, 0.38)');
      haloGradient.addColorStop(0.5, 'rgba(140, 130, 110, 0.12)');
      haloGradient.addColorStop(1, 'rgba(140, 130, 110, 0)');
    } else {
      haloGradient.addColorStop(0, 'rgba(216, 154, 120, 0.44)');
      haloGradient.addColorStop(0.5, 'rgba(193, 119, 83, 0.14)');
      haloGradient.addColorStop(1, 'rgba(193, 119, 83, 0)');
    }
    ctx.fillStyle = haloGradient;
    ctx.beginPath();
    ctx.arc(x, y, haloRadius, 0, Math.PI * 2);
    ctx.fill();

    const lx = x - r * 0.35;
    const ly = y - r * 0.35;
    const bodyGradient = ctx.createRadialGradient(lx, ly, 0, x, y, r * 1.15);

    if (isRoot) {
      bodyGradient.addColorStop(0,    '#FFF8EA');
      bodyGradient.addColorStop(0.28, '#F2DDB8');
      bodyGradient.addColorStop(0.58, '#D89A78');
      bodyGradient.addColorStop(0.82, '#B86B42');
      bodyGradient.addColorStop(1,    '#6E3B1F');
    } else if (isAnonymous) {
      bodyGradient.addColorStop(0,    '#E8E2D2');
      bodyGradient.addColorStop(0.4,  '#D5CDB8');
      bodyGradient.addColorStop(0.78, '#9C9179');
      bodyGradient.addColorStop(1,    '#4A463B');
    } else {
      bodyGradient.addColorStop(0,    '#FCF5E7');
      bodyGradient.addColorStop(0.4,  '#EFDDBC');
      bodyGradient.addColorStop(0.78, '#C99E70');
      bodyGradient.addColorStop(1,    '#5E3923');
    }

    ctx.fillStyle = bodyGradient;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();

    ctx.save();
    ctx.strokeStyle = isRoot ? 'rgba(255, 236, 210, 0.78)' : 'rgba(255, 236, 210, 0.55)';
    ctx.lineWidth = Math.max(1, r * 0.075);
    ctx.beginPath();
    ctx.arc(x, y, r * 0.92, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();

    const initial = isAnonymous ? '✦' : ((name || '؟').trim().charAt(0) || '؟');
    const initialFontSize = Math.max(16, r * 0.92);
    ctx.save();
    ctx.font = `800 ${initialFontSize}px "Almarai", system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#FFF7F1';
    ctx.shadowColor = 'rgba(0, 0, 0, 0.35)';
    ctx.shadowBlur = 8;
    ctx.shadowOffsetY = 1;
    ctx.fillText(initial, x, y + 1);
    ctx.restore();

    const displayName = isAnonymous ? 'أثر متضاعف' : truncateText(name || 'عضو', 14);
    const labelFontSize = Math.max(13, r * 0.42);
    ctx.save();
    ctx.font = `700 ${labelFontSize}px "Almarai", system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    const textWidth = ctx.measureText(displayName).width;
    const padH = 14;
    const pillW = textWidth + padH * 2;
    const pillH = labelFontSize * 1.9;
    const pillY = y + r + 12;

    const pillGradient = ctx.createLinearGradient(0, pillY, 0, pillY + pillH);
    if (isRoot) {
      pillGradient.addColorStop(0, 'rgba(58, 42, 28, 0.88)');
      pillGradient.addColorStop(1, 'rgba(42, 30, 20, 0.94)');
    } else if (isAnonymous) {
      pillGradient.addColorStop(0, 'rgba(60, 56, 45, 0.85)');
      pillGradient.addColorStop(1, 'rgba(42, 38, 30, 0.92)');
    } else {
      pillGradient.addColorStop(0, 'rgba(46, 34, 24, 0.88)');
      pillGradient.addColorStop(1, 'rgba(30, 22, 14, 0.94)');
    }

    const pillX = x - pillW / 2;
    const pillR = pillH / 2;

    ctx.fillStyle = pillGradient;
    ctx.beginPath();
    ctx.moveTo(pillX + pillR, pillY);
    ctx.lineTo(pillX + pillW - pillR, pillY);
    ctx.quadraticCurveTo(pillX + pillW, pillY, pillX + pillW, pillY + pillR);
    ctx.lineTo(pillX + pillW, pillY + pillH - pillR);
    ctx.quadraticCurveTo(pillX + pillW, pillY + pillH, pillX + pillW - pillR, pillY + pillH);
    ctx.lineTo(pillX + pillR, pillY + pillH);
    ctx.quadraticCurveTo(pillX, pillY + pillH, pillX, pillY + pillH - pillR);
    ctx.lineTo(pillX, pillY + pillR);
    ctx.quadraticCurveTo(pillX, pillY, pillX + pillR, pillY);
    ctx.closePath();
    ctx.fill();

    ctx.strokeStyle = isRoot
      ? 'rgba(216, 154, 120, 0.75)'
      : (isAnonymous ? 'rgba(180, 165, 140, 0.48)' : 'rgba(216, 154, 120, 0.60)');
    ctx.lineWidth = 1.2;
    ctx.stroke();

    ctx.fillStyle = isRoot ? '#F8EBD5' : (isAnonymous ? '#E5DCC6' : '#F5E6D0');
    ctx.fillText(displayName, x, pillY + pillH / 2 + 0.5);
    ctx.restore();

    if (isHovered) {
      ctx.save();
      ctx.strokeStyle = 'rgba(255, 226, 200, 0.98)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(x, y, r + 6, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
  }

  function renderTree() {
    const ctx = treeState.ctx, canvas = treeState.canvas;
    const cssWidth = treeState.cssWidth, cssHeight = treeState.cssHeight;
    const dpr = treeState.dpr;
    if (!ctx || !canvas) return;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssWidth, cssHeight);

    ctx.save();
    ctx.translate(cssWidth / 2 + treeState.view.offsetX, cssHeight / 2 + treeState.view.offsetY);
    ctx.scale(treeState.view.scale, treeState.view.scale);

    for (const branch of treeState.branches) drawBranch(ctx, branch);
    for (const node of treeState.nodes) drawNode(ctx, node);

    ctx.restore();
  }

  async function refreshTreeData() {
    const sb = await waitForSupabase();
    if (!sb) return;

    const { data: { user } } = await sb.auth.getUser();

    if (!user) {
      treeState.rootProfile = null;
      treeState.referrals = [];
      buildTreeLayout(null, []);
      const sig = 'anon';
      if (sig !== treeState.lastSignature) {
        treeState.lastSignature = sig;
        resizeCanvas();
        centerTreeView();
        renderTree();
      }
      return;
    }

    let rootProfile = null;
    try {
      const { data: profile } = await sb
        .from('profiles')
        .select('username, created_at, points')
        .eq('id', user.id)
        .maybeSingle();

      rootProfile = {
        id: user.id,
        username: (profile && profile.username)
          || (user.user_metadata && user.user_metadata.username)
          || 'أنت',
        created_at: (profile && profile.created_at) || user.created_at || null,
        points: (profile && profile.points) || 0
      };
    } catch (_) {
      rootProfile = {
        id: user.id,
        username: (user.user_metadata && user.user_metadata.username) || 'أنت',
        created_at: user.created_at,
        points: 0
      };
    }

    let referrals = [];
    try {
      const { data: rows, error } = await sb.rpc('get_referral_tree', {
        root_user_id: user.id,
        max_depth: MAX_DEPTH
      });
      if (error) throw error;
      referrals = rows || [];
    } catch (err) {
      console.warn('[أثر] تعذّر جلب شجرة الإحالات:', err);
    }

    treeState.rootProfile = rootProfile;
    treeState.referrals = referrals;

    const sig = `${rootProfile.id}::${referrals.length}::${referrals.map(r => r.node_id).sort().join(',')}`;

    if (sig !== treeState.lastSignature) {
      treeState.lastSignature = sig;
      buildTreeLayout(rootProfile, referrals);
      resizeCanvas();
      centerTreeView();
      renderTree();
    }
  }

  function findNodeAtWorld(wx, wy) {
    const nodes = treeState.nodes;
    for (let i = nodes.length - 1; i >= 0; i--) {
      const n = nodes[i];
      const dx = n.x - wx;
      const dy = n.y - wy;
      if (dx * dx + dy * dy <= n.radius * n.radius) return n;
    }
    return null;
  }

  function bindTreeInteraction() {
    const canvas = treeState.canvas;
    if (!canvas) return;

    canvas.addEventListener('wheel', e => {
      e.preventDefault();
      closeNodePopover();

      const rect = canvas.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;

      const worldBefore = screenToWorld(cx, cy);

      const factor = Math.exp(-e.deltaY * 0.0015);
      const newScale = clamp(
        treeState.view.scale * factor,
        treeState.minScale,
        treeState.maxScale
      );
      treeState.view.scale = newScale;

      const worldAfter = screenToWorld(cx, cy);
      treeState.view.offsetX += (worldAfter.x - worldBefore.x) * treeState.view.scale;
      treeState.view.offsetY += (worldAfter.y - worldBefore.y) * treeState.view.scale;

      treeState.userHasPanned = true;

      const stage = treeState.container;
      if (stage) {
        stage.dataset.zoomed = (Math.abs(treeState.view.scale - 1) > 0.05).toString();
      }

      renderTree();
    }, { passive: false });

    canvas.addEventListener('pointerdown', e => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      treeState.dragging = true;
      treeState.pointerMoved = false;
      treeState.dragStart = {
        x: e.clientX,
        y: e.clientY,
        offsetX: treeState.view.offsetX,
        offsetY: treeState.view.offsetY
      };
      try { canvas.setPointerCapture(e.pointerId); } catch (_) {}
      if (treeState.container) treeState.container.classList.add('is-panning');
    });

    canvas.addEventListener('pointermove', e => {
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;

      if (treeState.dragging && treeState.dragStart) {
        const dx = e.clientX - treeState.dragStart.x;
        const dy = e.clientY - treeState.dragStart.y;

        if (!treeState.pointerMoved && Math.hypot(dx, dy) > treeState.dragThreshold) {
          treeState.pointerMoved = true;
          closeNodePopover();
        }

        if (treeState.pointerMoved) {
          treeState.view.offsetX = treeState.dragStart.offsetX + dx;
          treeState.view.offsetY = treeState.dragStart.offsetY + dy;
          treeState.userHasPanned = true;

          const stage = treeState.container;
          if (stage) stage.dataset.panned = 'true';

          renderTree();
        }
        return;
      }

      if (e.pointerType === 'touch') return;

      const world = screenToWorld(mx, my);
      const node = findNodeAtWorld(world.x, world.y);

      if (node !== treeState.hovered) {
        treeState.hovered = node;
        canvas.style.cursor = node ? 'pointer' : 'grab';
        renderTree();
      }
    }, { passive: true });

    const endInteraction = e => {
      if (!treeState.dragging) return;

      const wasDragged = treeState.pointerMoved;
      treeState.dragging = false;
      treeState.dragStart = null;
      if (treeState.container) treeState.container.classList.remove('is-panning');

      try { canvas.releasePointerCapture(e.pointerId); } catch (_) {}

      if (!wasDragged && e.type === 'pointerup') {
        const rect = canvas.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;
        const world = screenToWorld(mx, my);
        const node = findNodeAtWorld(world.x, world.y);

        if (node) {
          const screenPos = worldToScreen(node.x, node.y);
          openNodePopover(node, screenPos);
        } else {
          closeNodePopover();
        }
      }

      treeState.pointerMoved = false;
    };

    canvas.addEventListener('pointerup', endInteraction);
    canvas.addEventListener('pointercancel', endInteraction);

    canvas.addEventListener('pointerleave', () => {
      if (treeState.dragging) return;
      if (treeState.hovered) {
        treeState.hovered = null;
        renderTree();
      }
    });

    canvas.addEventListener('dragstart', e => e.preventDefault());
    canvas.addEventListener('selectstart', e => e.preventDefault());
  }

  /* ============================================================
     ١٤. بطاقة معلومات العقدة (Popover)
     ============================================================ */

  let activePopoverNode = null;
  let popoverHideTimer = null;

  function ensureNodePopover() {
    let p = document.getElementById('nodePopover');
    if (p) return p;

    p = document.createElement('div');
    p.id = 'nodePopover';
    p.className = 'node-popover';
    p.setAttribute('role', 'dialog');
    p.setAttribute('aria-hidden', 'true');
    p.hidden = true;
    p.innerHTML = `
      <div class="node-popover-arrow" aria-hidden="true"></div>
      <div class="node-popover-header">
        <div class="node-popover-avatar" id="popoverAvatar">؟</div>
        <div class="node-popover-text">
          <div class="node-popover-title" id="popoverTitle">—</div>
          <div class="node-popover-subtitle" id="popoverSubtitle">—</div>
        </div>
      </div>
      <div class="node-popover-body" id="popoverBody"></div>
    `;
    document.body.appendChild(p);
    return p;
  }

  function formatJoinTime(iso) {
    if (!iso) return '—';
    try {
      const d = new Date(iso);
      if (isNaN(d.getTime())) return '—';
      const months = ['يناير','فبراير','مارس','أبريل','مايو','يونيو','يوليو','أغسطس','سبتمبر','أكتوبر','نوفمبر','ديسمبر'];
      const dateStr = `${toArabicDigits(d.getDate())} ${months[d.getMonth()]} ${toArabicDigits(d.getFullYear())}`;
      const hours = d.getHours();
      const minutes = String(d.getMinutes()).padStart(2, '0');
      const period = hours < 12 ? 'ص' : 'م';
      const h12 = hours % 12 || 12;
      const timeStr = `${toArabicDigits(h12)}:${toArabicDigits(minutes)} ${period}`;
      return `${dateStr} · ${timeStr}`;
    } catch (_) { return '—'; }
  }

  function openNodePopover(node, screenPos) {
    if (!node) return;
    const p = ensureNodePopover();
    if (!p) return;
    clearTimeout(popoverHideTimer);

    const isRoot = !!node.isRoot;
    const isAnonymous = !!node.isAnonymous;

    const avatar   = p.querySelector('#popoverAvatar');
    const title    = p.querySelector('#popoverTitle');
    const subtitle = p.querySelector('#popoverSubtitle');
    const body     = p.querySelector('#popoverBody');

    p.dataset.type = isRoot ? 'root' : (isAnonymous ? 'indirect' : 'direct');
    if (avatar)   avatar.textContent   = '';
    if (title)    title.textContent    = '';
    if (subtitle) subtitle.textContent = '';
    if (body) { body.innerHTML = ''; body.hidden = false; }

    if (isRoot) {
      if (avatar)   avatar.textContent   = ((node.name || '').trim()[0] || 'أ').toUpperCase();
      if (title)    title.textContent    = node.name || 'أنت';
      if (subtitle) subtitle.textContent = 'صاحب الأثر (منبع الشجرة)';
      if (body)     body.hidden = true;
    } else if (isAnonymous) {
      if (avatar)   avatar.textContent   = '✨';
      if (title)    title.textContent    = 'أثر متضاعف';
      if (subtitle) subtitle.textContent = 'مجهول الهوية للخصوصية';

      const parentIsAnonymous = (node.parentDepth == null ? 0 : node.parentDepth) >= 2;
      const originLabel = parentIsAnonymous
        ? (node.viaName || (treeState.rootProfile && treeState.rootProfile.username) || 'صديق')
        : (node.parentName || (treeState.rootProfile && treeState.rootProfile.username) || 'صديق');

      if (body) {
        body.innerHTML = `
          <div class="node-popover-row">
            <span class="node-popover-row-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                <path d="M4 12a8 8 0 1 1 16 0"/>
                <path d="M8 12a4 4 0 1 1 8 0"/>
                <path d="M12 12v8"/>
                <path d="M12 20h-2.5"/>
                <path d="M12 20h2.5"/>
              </svg>
            </span>
            <span class="node-popover-row-label">امتدّ أثرُه من</span>
            <span class="node-popover-row-value">${escapeHTML(originLabel)}</span>
          </div>`;
      }
    } else {
      if (avatar)   avatar.textContent   = ((node.name || '').trim()[0] || '؟').toUpperCase();
      if (title)    title.textContent    = node.name || 'أثر مباشر';
      if (subtitle) subtitle.textContent = 'أثر مباشر';
      if (body) {
        const timeStr = formatJoinTime(node.joinedAt);
        body.innerHTML = `
          <div class="node-popover-row">
            <span class="node-popover-row-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                <rect x="3" y="4.5" width="18" height="16" rx="2.5"/>
                <path d="M3 10h18"/>
                <path d="M8 2.5v4"/>
                <path d="M16 2.5v4"/>
              </svg>
            </span>
            <span class="node-popover-row-label">انضم في</span>
            <span class="node-popover-row-value">${escapeHTML(timeStr)}</span>
          </div>`;
      }
    }

    p.hidden = false;
    p.classList.remove('is-visible');
    void p.offsetWidth;
    positionNodePopover(p, screenPos);
    requestAnimationFrame(() => {
      p.classList.add('is-visible');
      p.setAttribute('aria-hidden', 'false');
    });

    activePopoverNode = node;
  }

  function positionNodePopover(popoverEl, screenPos) {
    if (!popoverEl || !screenPos || !treeState.container) return;

    const containerRect = treeState.container.getBoundingClientRect();
    const nodeScreenX = containerRect.left + screenPos.x;
    const nodeScreenY = containerRect.top + screenPos.y;

    const popW = popoverEl.offsetWidth;
    const popH = popoverEl.offsetHeight;
    const margin = 12;
    const gap = 16;

    let left = nodeScreenX - popW / 2;
    let top = nodeScreenY - popH - gap;
    let placement = 'above';

    if (top < margin) {
      top = nodeScreenY + gap;
      placement = 'below';
    }

    if (left < margin) left = margin;
    if (left + popW > window.innerWidth - margin) {
      left = window.innerWidth - popW - margin;
    }

    popoverEl.style.left = `${left}px`;
    popoverEl.style.top = `${top}px`;
    popoverEl.dataset.placement = placement;

    const arrow = popoverEl.querySelector('.node-popover-arrow');
    if (arrow) {
      const arrowLeft = clamp(nodeScreenX - left - 7, 14, popW - 28);
      arrow.style.left = `${arrowLeft}px`;
      if (placement === 'above') {
        arrow.style.bottom = '-7px';
        arrow.style.top = 'auto';
      } else {
        arrow.style.top = '-7px';
        arrow.style.bottom = 'auto';
      }
    }
  }

  function closeNodePopover() {
    const p = document.getElementById('nodePopover');
    if (!p) return;
    p.classList.remove('is-visible');
    p.setAttribute('aria-hidden', 'true');
    activePopoverNode = null;
    clearTimeout(popoverHideTimer);
    popoverHideTimer = setTimeout(() => {
      if (!p.classList.contains('is-visible')) p.hidden = true;
    }, 320);
  }

  document.addEventListener('pointerdown', e => {
    const p = document.getElementById('nodePopover');
    if (!p || !p.classList.contains('is-visible')) return;
    if (p.contains(e.target)) return;
    if (e.target.id === 'impactTree') return;
    closeNodePopover();
  });

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeNodePopover();
  });

  /* ============================================================
     ١٥. نافذة "عن أثر"
     ============================================================ */

  const aboutTrigger = $('#aboutTrigger');
  const aboutModal = $('#aboutModal');
  const aboutDialog = $('#aboutDialog');
  let aboutLastFocused = null;

  function openAbout() {
    if (!aboutModal) return;
    aboutLastFocused = document.activeElement;
    aboutModal.classList.add('is-open');
    aboutModal.setAttribute('aria-hidden', 'false');
    document.body.classList.add('is-locked');
    setTimeout(() => { if (aboutDialog && aboutDialog.focus) aboutDialog.focus(); }, 260);
  }

  function closeAbout() {
    if (!aboutModal) return;
    aboutModal.classList.remove('is-open');
    aboutModal.setAttribute('aria-hidden', 'true');
    const anyOpen =
      (adminModal && adminModal.classList.contains('is-open')) ||
      (shareModal && shareModal.classList.contains('is-open')) ||
      (deedView.el && deedView.el.classList.contains('is-open'));
    if (!anyOpen) document.body.classList.remove('is-locked');
    if (aboutLastFocused && typeof aboutLastFocused.focus === 'function') {
      aboutLastFocused.focus();
    }
  }

  if (aboutTrigger) aboutTrigger.addEventListener('click', openAbout);
  if (aboutModal) {
    aboutModal.addEventListener('click', e => {
      if (e.target.closest('[data-about-close]')) closeAbout();
    });
  }

  /* ============================================================
     ١٦. نافذة المشاركة الاجتماعية
     ============================================================ */

  const shareModal = $('#shareModal');
  const shareDialog = $('#shareDialog');
  const shareWhatsapp = $('#shareWhatsapp');
  const shareX = $('#shareX');
  const shareTelegram = $('#shareTelegram');
  const shareCopy = $('#shareCopy');
  const shareUrlInput = $('#shareUrlInput');
  const shareUrlCopy = $('#shareUrlCopy');
  const sharePreviewRef = $('#sharePreviewRef');
  const sharePreviewText = $('#sharePreviewText');

  const shareState = { url: '', title: '', content: '' };
  let shareLastFocused = null;

  function buildShareMessage() {
    const ref = shareState.title || 'نصٌّ موثّق';
    return `${ref}\n\n${shareState.content}\n\nاقرأه كاملاً عبر منصة أثر:\n${shareState.url}`;
  }

  function openShareSheet(data) {
    if (!shareModal) return;

    shareState.title = data.title || '';
    shareState.content = data.content || '';
    shareState.url = data.url || '';

    if (sharePreviewRef)  sharePreviewRef.textContent = data.title || '—';
    if (sharePreviewText) sharePreviewText.textContent = data.content || '—';
    if (shareUrlInput)    shareUrlInput.value = data.url || '';

    shareLastFocused = document.activeElement;
    shareModal.classList.add('is-open');
    shareModal.setAttribute('aria-hidden', 'false');
    document.body.classList.add('is-locked');
    setTimeout(() => { if (shareDialog && shareDialog.focus) shareDialog.focus(); }, 260);
  }

  function closeShareSheet() {
    if (!shareModal) return;
    shareModal.classList.remove('is-open');
    shareModal.setAttribute('aria-hidden', 'true');
    const anyOpen =
      (adminModal && adminModal.classList.contains('is-open')) ||
      (aboutModal && aboutModal.classList.contains('is-open')) ||
      (deedView.el && deedView.el.classList.contains('is-open'));
    if (!anyOpen) document.body.classList.remove('is-locked');
    if (shareLastFocused && typeof shareLastFocused.focus === 'function') {
      shareLastFocused.focus();
    }
  }

  function openExternal(url) {
    const w = window.open(url, '_blank', 'noopener,noreferrer');
    if (!w) showToast('تعذّر فتح نافذة المشاركة');
  }

  if (shareWhatsapp) shareWhatsapp.addEventListener('click', () => {
    const msg = buildShareMessage();
    openExternal(`https://wa.me/?text=${encodeURIComponent(msg)}`);
    playClick(); haptic(10);
    setTimeout(closeShareSheet, 260);
  });

  if (shareX) shareX.addEventListener('click', () => {
    const msg = buildShareMessage();
    openExternal(`https://twitter.com/intent/tweet?text=${encodeURIComponent(msg)}`);
    playClick(); haptic(10);
    setTimeout(closeShareSheet, 260);
  });

  if (shareTelegram) shareTelegram.addEventListener('click', () => {
    const msg = buildShareMessage();
    openExternal(`https://t.me/share/url?url=${encodeURIComponent(shareState.url)}&text=${encodeURIComponent(msg)}`);
    playClick(); haptic(10);
    setTimeout(closeShareSheet, 260);
  });

  async function handleCopyShareUrl() {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(shareState.url);
      } else if (shareUrlInput) {
        shareUrlInput.select();
        document.execCommand('copy');
      }
      playChime();
      haptic([8, 40, 12]);
      showToast('تم نسخ الرابط ✦');
      setTimeout(closeShareSheet, 300);
    } catch (_) {
      showToast('تعذّر نسخ الرابط');
    }
  }

  if (shareCopy) shareCopy.addEventListener('click', handleCopyShareUrl);
  if (shareUrlCopy) shareUrlCopy.addEventListener('click', handleCopyShareUrl);

  if (shareModal) {
    shareModal.addEventListener('click', e => {
      if (e.target.closest('[data-share-close]')) closeShareSheet();
    });
  }

  /* ============================================================
     ١٧. لوحة الإدارة
     ============================================================ */

  const adminTrigger      = $('#adminTrigger');
  const adminModal        = $('#adminModal');
  const adminDialog       = $('#adminDialog');
  const adminForm         = $('#adminForm');
  const adminFormTitle    = $('#adminFormTitle');
  const adminEditBanner   = $('#adminEditBanner');
  const adminEditId       = $('#adminEditId');
  const adminCancelEdit   = $('#adminCancelEdit');
  const adminSubmitBtn    = $('#adminSubmitBtn');
  const adminSubmitText   = $('#adminSubmitText');
  const adminManageView   = $('#adminManageView');
  const adminList         = $('#adminList');
  const adminManageCount  = $('#adminManageCount');
  const adminRefreshBtn   = $('#adminRefreshList');
  const adminArchiveView  = $('#adminArchiveView');
  const adminArchiveList  = $('#adminArchiveList');
  const adminArchiveCount = $('#adminArchiveCount');
  const adminRefreshArchive = $('#adminRefreshArchive');
  const adminSegs         = $$('.admin-seg');
  const adminSegGlider    = $('#adminSegGlider');

  const inputType    = $('#verseType');
  const inputRef     = $('#verseRef');
  const inputContent = $('#verseContent');
  const inputPoints  = $('#versePoints');

  let currentAdminView = 'add';
  let adminEditingId = null;
  let adminVersesCache = [];
  let adminArchiveCache = [];
  let adminListBusy = false;
  let adminArchiveBusy = false;
  let adminLastFocused = null;

  function positionAdminGlider(activeSeg, animate = true) {
    if (!adminSegGlider || !activeSeg) return;
    if (!animate) adminSegGlider.style.transition = 'none';
    adminSegGlider.style.width = `${activeSeg.offsetWidth}px`;
    adminSegGlider.style.transform = `translateX(${activeSeg.offsetLeft}px)`;
    if (!animate) {
      void adminSegGlider.offsetWidth;
      requestAnimationFrame(() => { adminSegGlider.style.transition = ''; });
    }
  }

  function openAdminModal() {
    if (!adminModal) return;
    adminLastFocused = document.activeElement;
    adminModal.classList.add('is-open');
    adminModal.setAttribute('aria-hidden', 'false');
    document.body.classList.add('is-locked');
    resetAdminForm();

    requestAnimationFrame(() => requestAnimationFrame(() => {
      const active = adminSegs.find(s => s.classList.contains('is-active')) || adminSegs[0];
      if (active) positionAdminGlider(active, false);
    }));

    setAdminView('add', false);
    setTimeout(() => { if (inputType) inputType.focus(); }, 260);
  }

  function closeAdminModal() {
    if (!adminModal) return;
    adminModal.classList.remove('is-open');
    adminModal.setAttribute('aria-hidden', 'true');
    const anyOpen =
      (shareModal && shareModal.classList.contains('is-open')) ||
      (aboutModal && aboutModal.classList.contains('is-open')) ||
      (deedView.el && deedView.el.classList.contains('is-open'));
    if (!anyOpen) document.body.classList.remove('is-locked');
    resetAdminForm();
    if (adminLastFocused && typeof adminLastFocused.focus === 'function') adminLastFocused.focus();
  }

  function setAdminView(view, animate = true) {
    if (['add','manage','archive'].indexOf(view) === -1) return;
    currentAdminView = view;

    adminSegs.forEach(seg => {
      const on = seg.dataset.adminView === view;
      seg.classList.toggle('is-active', on);
      seg.setAttribute('aria-selected', on ? 'true' : 'false');
    });

    const activeSeg = adminSegs.find(s => s.dataset.adminView === view);
    if (activeSeg) positionAdminGlider(activeSeg, animate);

    if (adminForm)        adminForm.hidden        = view !== 'add';
    if (adminManageView)  adminManageView.hidden  = view !== 'manage';
    if (adminArchiveView) adminArchiveView.hidden = view !== 'archive';

    if (view === 'manage')  loadAdminVerses();
    if (view === 'archive') loadArchivedVerses();
  }

  function resetAdminForm() {
    adminEditingId = null;
    if (adminForm) adminForm.reset();
    if (adminEditId) adminEditId.value = '';
    if (inputPoints) inputPoints.value = '10';
    if (adminFormTitle) adminFormTitle.hidden = true;
    if (adminEditBanner) adminEditBanner.hidden = true;
    if (adminSubmitText) adminSubmitText.textContent = 'نشر النص';
  }

  function enterAdminEditMode(item) {
    if (!item) return;
    adminEditingId = item.id;
    if (inputType)    inputType.value    = item.type || 'ayah';
    if (inputRef)     inputRef.value     = item.reference || '';
    if (inputContent) inputContent.value = item.content || '';
    if (inputPoints)  inputPoints.value  = String(item.points != null ? item.points : 10);
    if (adminEditId)  adminEditId.value  = item.id;
    if (adminFormTitle)  adminFormTitle.hidden = false;
    if (adminEditBanner) adminEditBanner.hidden = false;
    if (adminSubmitText) adminSubmitText.textContent = 'تحديث النص';
    setAdminView('add', true);
    if (adminDialog && adminDialog.scrollTo) {
      adminDialog.scrollTo({ top: 0, behavior: prefersReduced ? 'auto' : 'smooth' });
    }
    setTimeout(() => { if (inputRef) inputRef.focus(); }, 220);
  }

  function exitAdminEditMode() {
    resetAdminForm();
    setAdminView('manage', true);
  }
  if (adminCancelEdit) adminCancelEdit.addEventListener('click', exitAdminEditMode);

  function renderListSkeleton(listEl) {
    if (!listEl) return;
    listEl.innerHTML = '';
    for (let i = 0; i < 3; i++) {
      const row = document.createElement('div');
      row.className = 'admin-item is-skeleton';
      row.innerHTML = `<div class="admin-item-info"><div class="admin-skel-line w40"></div><div class="admin-skel-line w90"></div><div class="admin-skel-line w70"></div></div><div class="admin-item-actions"></div>`;
      listEl.appendChild(row);
    }
  }

  function renderListEmpty(listEl, message) {
    if (!listEl) return;
    listEl.innerHTML = `<div class="admin-empty"><strong>${escapeHTML(message || 'لا توجد نصوص')}</strong><span>سيظهر هنا المحتوى عند توفّره.</span></div>`;
  }

  function renderAdminList(items) {
    if (!adminList) return;
    adminList.innerHTML = '';
    const list = Array.isArray(items) ? items : [];
    if (!list.length) { renderListEmpty(adminList, 'لا توجد نصوص منشورة حالياً'); return; }
    if (adminManageCount) adminManageCount.textContent = toArabicDigits(list.length);

    list.forEach((item, i) => {
      const row = document.createElement('div');
      row.className = 'admin-item';
      row.dataset.id = item.id;
      row.setAttribute('role', 'listitem');
      row.style.animationDelay = `${Math.min(i, 8) * 40}ms`;
      const isHadith = item.type === 'hadith';

      row.innerHTML = `
        <div class="admin-item-info">
          <div class="admin-item-head">
            <span class="admin-item-badge ${isHadith ? 'is-hadith' : 'is-ayah'}">${isHadith ? 'حديث شريف' : 'آية قرآنية'}</span>
            <span class="admin-item-ref"></span>
            <span class="admin-item-points">${toArabicDigits(item.points)} نقطة</span>
          </div>
          <p class="admin-item-content"></p>
        </div>
        <div class="admin-item-actions">
          <div class="admin-actions-default">
            <button class="admin-action admin-action-edit" type="button" data-action="edit" data-id="${item.id}">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9" /><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" /></svg>
              <span>تعديل</span>
            </button>
            <button class="admin-action admin-action-delete" type="button" data-action="delete" data-id="${item.id}">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18" /><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /><path d="M19 6 18 20a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" /><path d="M10 11v6" /><path d="M14 11v6" /></svg>
              <span>حذف</span>
            </button>
          </div>
          <div class="admin-actions-confirm">
            <button class="admin-action admin-action-confirm" type="button" data-action="confirm-delete" data-id="${item.id}"><span>تأكيد الحذف</span></button>
            <button class="admin-action admin-action-cancel" type="button" data-action="cancel-delete" data-id="${item.id}"><span>إلغاء</span></button>
          </div>
        </div>`;

      row.querySelector('.admin-item-ref').textContent = item.reference || '';
      row.querySelector('.admin-item-content').textContent = item.content || '';
      row._item = item;
      adminList.appendChild(row);
    });
  }

  function renderArchiveList(items) {
    if (!adminArchiveList) return;
    adminArchiveList.innerHTML = '';
    const list = Array.isArray(items) ? items : [];
    if (!list.length) { renderListEmpty(adminArchiveList, 'لا توجد نصوص مؤرشفة'); return; }
    if (adminArchiveCount) adminArchiveCount.textContent = toArabicDigits(list.length);

    list.forEach((item, i) => {
      const row = document.createElement('div');
      row.className = 'admin-item is-archived';
      row.dataset.id = item.id;
      row.setAttribute('role', 'listitem');
      row.style.animationDelay = `${Math.min(i, 8) * 40}ms`;
      const isHadith = item.type === 'hadith';

      row.innerHTML = `
        <div class="admin-item-info">
          <div class="admin-item-head">
            <span class="admin-item-badge ${isHadith ? 'is-hadith' : 'is-ayah'}">${isHadith ? 'حديث شريف' : 'آية قرآنية'}</span>
            <span class="admin-item-badge is-archived">مؤرشف</span>
            <span class="admin-item-ref"></span>
            <span class="admin-item-points">${toArabicDigits(item.points)} نقطة</span>
          </div>
          <p class="admin-item-content"></p>
        </div>
        <div class="admin-item-actions">
          <div class="admin-actions-default">
            <button class="admin-action admin-action-restore" type="button" data-action="restore" data-id="${item.id}">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5" /></svg>
              <span>استعادة</span>
            </button>
            <button class="admin-action admin-action-delete" type="button" data-action="delete" data-id="${item.id}">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18" /><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /><path d="M19 6 18 20a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" /><path d="M10 11v6" /><path d="M14 11v6" /></svg>
              <span>حذف</span>
            </button>
          </div>
          <div class="admin-actions-confirm">
            <button class="admin-action admin-action-confirm" type="button" data-action="confirm-delete" data-id="${item.id}"><span>تأكيد الحذف</span></button>
            <button class="admin-action admin-action-cancel" type="button" data-action="cancel-delete" data-id="${item.id}"><span>إلغاء</span></button>
          </div>
        </div>`;

      row.querySelector('.admin-item-ref').textContent = item.reference || '';
      row.querySelector('.admin-item-content').textContent = item.content || '';
      row._item = item;
      adminArchiveList.appendChild(row);
    });
  }

  async function loadAdminVerses() {
    if (!adminList || adminListBusy) return;
    adminListBusy = true;
    if (adminRefreshBtn) adminRefreshBtn.classList.add('is-loading');
    renderListSkeleton(adminList);

    const sb = await waitForSupabase();
    if (!sb) {
      adminListBusy = false;
      if (adminRefreshBtn) adminRefreshBtn.classList.remove('is-loading');
      renderListEmpty(adminList, 'تعذّر الاتصال بقاعدة البيانات');
      return;
    }

    const { data, error } = await sb.from('verses')
      .select('id, type, reference, content, points, created_at, is_archived')
      .eq('is_archived', false)
      .order('created_at', { ascending: false });

    adminListBusy = false;
    if (adminRefreshBtn) adminRefreshBtn.classList.remove('is-loading');

    if (error) {
      console.error('[أثر] فشل تحميل قائمة النصوص:', error.message);
      showToast('تعذّر تحميل قائمة النصوص');
      renderListEmpty(adminList, 'حدث خطأ أثناء التحميل');
      return;
    }
    adminVersesCache = data || [];
    renderAdminList(adminVersesCache);
  }

  async function loadArchivedVerses() {
    if (!adminArchiveList || adminArchiveBusy) return;
    adminArchiveBusy = true;
    if (adminRefreshArchive) adminRefreshArchive.classList.add('is-loading');
    renderListSkeleton(adminArchiveList);

    const sb = await waitForSupabase();
    if (!sb) {
      adminArchiveBusy = false;
      if (adminRefreshArchive) adminRefreshArchive.classList.remove('is-loading');
      renderListEmpty(adminArchiveList, 'تعذّر الاتصال بقاعدة البيانات');
      return;
    }

    const { data, error } = await sb.from('verses')
      .select('id, type, reference, content, points, created_at, is_archived')
      .eq('is_archived', true)
      .order('created_at', { ascending: false });

    adminArchiveBusy = false;
    if (adminRefreshArchive) adminRefreshArchive.classList.remove('is-loading');

    if (error) {
      console.error('[أثر] فشل تحميل الأرشيف:', error.message);
      showToast('تعذّر تحميل الأرشيف');
      renderListEmpty(adminArchiveList, 'حدث خطأ أثناء التحميل');
      return;
    }
    adminArchiveCache = data || [];
    renderArchiveList(adminArchiveCache);
  }

  if (adminRefreshBtn) adminRefreshBtn.addEventListener('click', () => { if (!adminListBusy) loadAdminVerses(); });
  if (adminRefreshArchive) adminRefreshArchive.addEventListener('click', () => { if (!adminArchiveBusy) loadArchivedVerses(); });

  function exitAllConfirmStates(root) {
    const ctx = root || document;
    $$('.admin-item.is-confirming', ctx).forEach(el => el.classList.remove('is-confirming'));
  }

  async function handleAdminDelete(id, btn, source) {
    if (!id) return;
    const sb = await waitForSupabase();
    if (!sb) { showToast('تعذّر الاتصال بقاعدة البيانات'); return; }
    if (btn) btn.disabled = true;
    const { error } = await sb.from('verses').delete().eq('id', id);
    if (btn) btn.disabled = false;

    if (error) {
      console.error('[أثر] فشل الحذف:', error.message);
      showToast('تعذّر حذف النص — ' + error.message);
      return;
    }

    const listEl = source === 'archive' ? adminArchiveList : adminList;
    adminVersesCache = adminVersesCache.filter(v => v.id !== id);
    adminArchiveCache = adminArchiveCache.filter(v => v.id !== id);

    const row = listEl ? listEl.querySelector(`.admin-item[data-id="${id}"]`) : null;
    if (row) {
      row.style.transition = 'opacity .35s ease, transform .35s ease';
      row.style.opacity = '0';
      row.style.transform = 'translateY(-6px)';
      setTimeout(() => row.remove(), 320);
    }

    setTimeout(() => {
      if (listEl && listEl.querySelectorAll('.admin-item').length === 0) {
        renderListEmpty(listEl, source === 'archive' ? 'لا توجد نصوص مؤرشفة' : 'لا توجد نصوص منشورة حالياً');
      }
    }, 340);

    loadVersesFromSupabase();
    showToast('تم حذف النص بنجاح ✦');
  }

  async function handleAdminRestore(id, btn) {
    if (!id) return;
    const sb = await waitForSupabase();
    if (!sb) { showToast('تعذّر الاتصال بقاعدة البيانات'); return; }
    if (btn) btn.disabled = true;
    const { error } = await sb.from('verses').update({ is_archived: false }).eq('id', id);
    if (btn) btn.disabled = false;

    if (error) {
      console.error('[أثر] فشل الاستعادة:', error.message);
      showToast('تعذّر استعادة النص — ' + error.message);
      return;
    }

    adminArchiveCache = adminArchiveCache.filter(v => v.id !== id);
    const row = adminArchiveList ? adminArchiveList.querySelector(`.admin-item[data-id="${id}"]`) : null;
    if (row) {
      row.style.transition = 'opacity .35s ease, transform .35s ease';
      row.style.opacity = '0';
      row.style.transform = 'translateY(-6px)';
      setTimeout(() => row.remove(), 320);
    }
    setTimeout(() => {
      if (adminArchiveList && adminArchiveList.querySelectorAll('.admin-item').length === 0) {
        renderListEmpty(adminArchiveList, 'لا توجد نصوص مؤرشفة');
      }
    }, 340);

    loadVersesFromSupabase();
    showToast('تم استعادة النص ✦');
  }

  function bindAdminListEvents(listEl, source) {
    if (!listEl) return;
    listEl.addEventListener('click', e => {
      const actionBtn = e.target.closest('[data-action]');
      if (!actionBtn) return;
      const action = actionBtn.dataset.action;
      const id = actionBtn.dataset.id;
      const row = actionBtn.closest('.admin-item');

      if (action === 'edit') {
        exitAllConfirmStates(listEl);
        const item = (row && row._item) || adminVersesCache.find(v => v.id === id);
        if (item) enterAdminEditMode(item);
        return;
      }
      if (action === 'delete') {
        exitAllConfirmStates(listEl);
        if (row) row.classList.add('is-confirming');
        if (row) {
          const confirmBtn = row.querySelector('[data-action="confirm-delete"]');
          if (confirmBtn) confirmBtn.focus();
        }
        return;
      }
      if (action === 'confirm-delete') { handleAdminDelete(id, actionBtn, source); return; }
      if (action === 'cancel-delete')  { if (row) row.classList.remove('is-confirming'); return; }
      if (action === 'restore')        { handleAdminRestore(id, actionBtn); return; }
    });
    listEl.addEventListener('keydown', e => {
      if (e.key === 'Escape') exitAllConfirmStates(listEl);
    });
  }
  bindAdminListEvents(adminList, 'manage');
  bindAdminListEvents(adminArchiveList, 'archive');

  if (adminSegs.length) {
    adminSegs.forEach(seg => {
      seg.addEventListener('click', () => {
        const view = seg.dataset.adminView;
        if (view && view !== currentAdminView) setAdminView(view, true);
      });
    });

    let adminGliderRaf = null;
    window.addEventListener('resize', () => {
      if (!adminModal || !adminModal.classList.contains('is-open')) return;
      if (adminGliderRaf) cancelAnimationFrame(adminGliderRaf);
      adminGliderRaf = requestAnimationFrame(() => {
        const active = adminSegs.find(s => s.classList.contains('is-active'));
        if (active) positionAdminGlider(active, false);
      });
    }, { passive: true });
  }

  if (adminTrigger) adminTrigger.addEventListener('click', openAdminModal);
  if (adminModal) {
    adminModal.addEventListener('click', e => {
      if (e.target.closest('[data-close]')) closeAdminModal();
    });
  }

  if (adminForm) {
    adminForm.addEventListener('submit', async e => {
      e.preventDefault();

      const editingId = adminEditingId || (adminEditId ? adminEditId.value : null);
      const isEditing = Boolean(editingId);

      const type  = (inputType ? inputType.value : 'ayah');
      const ref   = sanitizeText(inputRef ? inputRef.value.trim() : '').replace(/&#x2F;/g, '/');
      const content = sanitizeText(inputContent ? inputContent.value.trim() : '').replace(/&#x2F;/g, '/');
      const points  = clamp(parseInt(inputPoints ? inputPoints.value : '0', 10) || 0, 1, 999);

      if (!ref || !content) {
        showToast('يرجى إكمال المصدر والنص');
        if (!ref && inputRef) inputRef.focus();
        else if (inputContent) inputContent.focus();
        return;
      }

      const sb = await waitForSupabase();
      if (!sb) { showToast('تعذّر الاتصال بقاعدة البيانات'); return; }

      const previousLabel = (adminSubmitText && adminSubmitText.textContent) || (isEditing ? 'تحديث النص' : 'نشر النص');
      if (adminSubmitBtn) adminSubmitBtn.disabled = true;
      if (adminSubmitText) adminSubmitText.textContent = isEditing ? 'جارٍ التحديث…' : 'جارٍ النشر…';

      const payload = {
        type: type === 'hadith' ? 'hadith' : 'ayah',
        reference: ref,
        content: content,
        points: points
      };

      let dbError = null, row = null;

      if (isEditing) {
        const { data, error } = await sb.from('verses').update(payload).eq('id', editingId)
          .select('id, type, reference, content, points, created_at, is_archived').single();
        dbError = error; row = data;
      } else {
        const { data, error } = await sb.from('verses').insert(payload)
          .select('id, type, reference, content, points, created_at, is_archived').single();
        dbError = error; row = data;
      }

      if (adminSubmitBtn) adminSubmitBtn.disabled = false;
      if (adminSubmitText) adminSubmitText.textContent = previousLabel;

      if (dbError) {
        console.error('[أثر] فشل الحفظ:', dbError.message);
        showToast((isEditing ? 'تعذّر التحديث — ' : 'تعذّر النشر — ') + dbError.message);
        return;
      }

      if (isEditing) {
        adminVersesCache = adminVersesCache.map(v => v.id === row.id ? row : v);
        renderAdminList(adminVersesCache);
        resetAdminForm();
        setAdminView('manage', true);
        showToast(`تم تحديث «${row.reference}» ✦`);
      } else {
        adminVersesCache = [row].concat(adminVersesCache);
        resetAdminForm();
        closeAdminModal();
        showToast(`تم نشر «${row.reference}» ✦`);
      }

      await loadVersesFromSupabase();
    });
  }

  /* ============================================================
     ١٨. مساعدات المصادقة
     ============================================================ */

  async function checkIsAuthenticated() {
    const sb = await waitForSupabase();
    if (!sb) return false;
    try {
      const { data, error } = await sb.auth.getUser();
      if (error) return false;
      return !!(data && data.user);
    } catch (_) { return false; }
  }

  /* ============================================================
     ١٩. نافذة إتمام القراءة + الإحالة
     ============================================================ */

  const deedView = { el: null, referrer: null, verse: null, busy: false, timer: null, secondsRemaining: 0 };
  const REFERRAL_SHOWN_SESSION_KEY = 'athar_referral_shown';

  function wasReferralShownThisSession(deedId) {
    if (!deedId) return false;
    try {
      const shown = JSON.parse(sessionStorage.getItem(REFERRAL_SHOWN_SESSION_KEY) || '[]');
      return Array.isArray(shown) && shown.indexOf(deedId) !== -1;
    } catch (_) { return false; }
  }

  function markReferralShownThisSession(deedId) {
    if (!deedId) return;
    try {
      const shown = JSON.parse(sessionStorage.getItem(REFERRAL_SHOWN_SESSION_KEY) || '[]');
      const list = Array.isArray(shown) ? shown : [];
      if (list.indexOf(deedId) === -1) {
        list.push(deedId);
        sessionStorage.setItem(REFERRAL_SHOWN_SESSION_KEY, JSON.stringify(list));
      }
    } catch (_) {}
  }

  function stopDeedViewTimer() {
    if (deedView.timer) { clearInterval(deedView.timer); deedView.timer = null; }
    deedView.secondsRemaining = 0;
  }

  function startDeedViewTimer() {
    stopDeedViewTimer();
    const btn = $('#deedViewComplete');
    const btnText = $('#deedViewCompleteText');
    const spinner = $('#deedViewSpinner');
    if (!btn || !btnText) return;

    deedView.secondsRemaining = READING_DURATION;
    btn.disabled = true;
    if (spinner) spinner.hidden = true;
    btnText.textContent = `يرجى القراءة... (${deedView.secondsRemaining})`;

    deedView.timer = setInterval(() => {
      deedView.secondsRemaining -= 1;
      if (deedView.secondsRemaining <= 0) {
        stopDeedViewTimer();
        btn.disabled = false;
        btnText.textContent = 'إتمام الأثر';
        playChime();
        haptic([10, 30, 15]);
        return;
      }
      btnText.textContent = `يرجى القراءة... (${deedView.secondsRemaining})`;
    }, 1000);
  }

  function openDeedView(verse, referrerUsername) {
    const el = deedView.el || $('#deedView');
    if (!el || !verse) return;
    deedView.el = el;
    deedView.verse = verse;
    deedView.referrer = referrerUsername || null;

    const isHadith = verse.type === 'hadith';
    const badge   = $('#deedViewType');
    const text    = $('#deedViewText');
    const ref     = $('#deedViewRef');
    const pts     = $('#deedViewPoints');
    const refChip = $('#deedViewRefChip');
    const refName = $('#deedViewReferrer');

    if (badge) {
      badge.textContent = isHadith ? 'حديث شريف' : 'آية قرآنية';
      badge.classList.toggle('is-hadith', isHadith);
    }
    if (text) text.textContent = verse.content || '—';
    if (ref)  ref.textContent  = verse.reference || '—';
    if (pts)  pts.textContent  = toArabicDigits(verse.points || 0);

    if (referrerUsername) {
      if (refName) refName.textContent = referrerUsername;
      if (refChip) refChip.hidden = false;
    } else {
      if (refChip) refChip.hidden = true;
    }

    el.classList.add('is-open');
    el.setAttribute('aria-hidden', 'false');
    document.body.classList.add('is-locked');

    const btn = $('#deedViewComplete');
    if (btn) {
      btn.disabled = true;
      btn.classList.remove('is-cooldown');
    }
    deedView.busy = false;
    startDeedViewTimer();
  }

  function closeDeedView() {
    const el = deedView.el;
    if (!el) return;
    stopDeedViewTimer();
    el.classList.remove('is-open');
    el.setAttribute('aria-hidden', 'true');
    const anyOpen =
      (adminModal && adminModal.classList.contains('is-open')) ||
      (shareModal && shareModal.classList.contains('is-open')) ||
      (aboutModal && aboutModal.classList.contains('is-open'));
    if (!anyOpen) document.body.classList.remove('is-locked');
  }

  function captureReferralParams() {
    let params;
    try { params = new URLSearchParams(window.location.search); } catch (_) { return null; }
    const ref = (params.get('ref') || '').trim();
    const deed = (params.get('deed') || '').trim();
    if (!ref && !deed) return null;

    const payload = { ref: ref || null, deed: deed || null, capturedAt: Date.now() };
    try { localStorage.setItem(REFERRAL_KEY, JSON.stringify(payload)); } catch (_) {}

    try {
      const clean = new URL(window.location.href);
      clean.searchParams.delete('ref');
      clean.searchParams.delete('deed');
      window.history.replaceState({}, '', clean.pathname + clean.search + clean.hash);
    } catch (_) {}
    return payload;
  }

  function readPendingReferral() {
    try {
      const raw = localStorage.getItem(REFERRAL_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (parsed && parsed.capturedAt && Date.now() - parsed.capturedAt > 86400_000) {
        localStorage.removeItem(REFERRAL_KEY);
        return null;
      }
      return parsed;
    } catch (_) { return null; }
  }

  function clearPendingReferral() { try { localStorage.removeItem(REFERRAL_KEY); } catch (_) {} }

  async function maybeOpenDedicatedDeedView() {
    if (deedView.el && deedView.el.classList.contains('is-open')) return;
    if (deedView.busy) return;
    const pending = readPendingReferral();
    if (!pending || !pending.deed) return;
    if (wasReferralShownThisSession(pending.deed)) return;
    const sb = await waitForSupabase();
    if (!sb) return;
    const isAuth = await checkIsAuthenticated();
    if (!isAuth) return;

    try {
      const { data: { user } } = await sb.auth.getUser();
      if (user) {
        const { data: existing } = await sb.from('user_reads').select('id, read_at')
          .eq('user_id', user.id).eq('verse_id', pending.deed)
          .order('read_at', { ascending: false }).limit(1).maybeSingle();
        if (existing) {
          const readAt = new Date(existing.read_at || 0).getTime();
          if (readAt && readAt + COOLDOWN_MS > Date.now()) { clearPendingReferral(); return; }
        }
      }
    } catch (_) {}

    const { data: verse, error } = await sb.from('verses')
      .select('id, type, reference, content, points').eq('id', pending.deed).maybeSingle();
    if (error || !verse) { clearPendingReferral(); return; }
    markReferralShownThisSession(pending.deed);
    setTimeout(() => openDeedView(verse, pending.ref), 520);
  }

  const REFERRAL_PROMPT_KEY = 'athar_referral_prompted_at';
  const REFERRAL_PROMPT_COOLDOWN = 60 * 1000;
  let authPromptShownThisPage = false;

  async function handlePendingReferral(options) {
    const silent = options && options.silent;
    const pending = readPendingReferral();
    if (!pending || !pending.deed) return;
    const isAuth = await checkIsAuthenticated();
    if (isAuth) {
      authPromptShownThisPage = false;
      await maybeOpenDedicatedDeedView();
      return;
    }
    if (silent) return;
    if (authPromptShownThisPage) return;
    try {
      const last = Number(sessionStorage.getItem(REFERRAL_PROMPT_KEY) || 0);
      if (last && Date.now() - last < REFERRAL_PROMPT_COOLDOWN) {
        authPromptShownThisPage = true;
        return;
      }
    } catch (_) {}
    authPromptShownThisPage = true;
    const refName = (pending.ref || '').trim() || 'صديق';
    showToast(`سجّل الدخول أو أنشئ حساباً لإتمام الأثر الذي شاركه معك ${refName} ✦`, 4500);
    setTimeout(() => {
      const auth = window.AtharAuth;
      if (!auth || typeof auth.open !== 'function') return;
      try { if (auth.setView) auth.setView('signup'); } catch (_) {}
      try { auth.open(); } catch (_) {}
      try { sessionStorage.setItem(REFERRAL_PROMPT_KEY, String(Date.now())); } catch (_) {}
    }, 420);
  }

  /**
   * Bug 1 & 3 fix:
   * - No local `totalPoints += ...` (Bug 3). The DB triggers handle point
   *   credit; we just refresh from the source of truth afterwards.
   * - Explicit insert into `referrals` is attempted only if the pending row
   *   doesn't already exist (it is created by the auth trigger). This is a
   *   belt-and-braces guard for legacy accounts.
   */
  async function completeDeedFromView() {
    if (deedView.busy) return;
    const verse = deedView.verse;
    if (!verse) return;

    if (deedView.timer && deedView.secondsRemaining > 0) {
      showToast('يرجى إكمال القراءة أولاً');
      return;
    }

    const sb = await waitForSupabase();
    if (!sb) { showToast('تعذّر الاتصال بقاعدة البيانات'); return; }

    const { data: { user } } = await sb.auth.getUser();
    if (!user) {
      showToast('يرجى تسجيل الدخول أولاً');
      const auth = window.AtharAuth;
      if (auth && auth.open) {
        try { if (auth.setView) auth.setView('signin'); } catch (_) {}
        try { auth.open(); } catch (_) {}
      }
      return;
    }

    deedView.busy = true;
    const btn     = $('#deedViewComplete');
    const btnText = $('#deedViewCompleteText');
    const spinner = $('#deedViewSpinner');

    if (btn) btn.disabled = true;
    if (spinner) spinner.hidden = false;
    if (btnText) btnText.textContent = 'جارٍ الإتمام…';

    // Guard against duplicate completion within cooldown
    try {
      const { data: existing } = await sb.from('user_reads')
        .select('id, read_at')
        .eq('user_id', user.id)
        .eq('verse_id', verse.id)
        .order('read_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (existing) {
        const readAt = new Date(existing.read_at || 0).getTime();
        if (readAt && readAt + COOLDOWN_MS > Date.now()) {
          showToast('لقد أتممت هذا النص مسبقاً — يمكنك القراءة مجدداً بعد انتهاء المهلة');
          userReadsMap.set(verse.id, readAt);
          if (versesGrid) {
            const card = versesGrid.querySelector(`.verse-card[data-id="${verse.id}"]`);
            if (card) applyCooldownState(card, readAt + COOLDOWN_MS);
          }
          closeDeedView();
          deedView.busy = false;
          if (btn) btn.disabled = false;
          if (spinner) spinner.hidden = true;
          if (btnText) btnText.textContent = 'إتمام الأثر';
          return;
        }
      }
    } catch (_) {}

    // Insert the completion. DB triggers fire:
    //   - award_completion_points   → credits user.points
    //   - activate_referral_on_completion → flips referral pending → active
    const { error: insErr } = await sb.from('user_reads')
      .insert({ user_id: user.id, verse_id: verse.id });

    if (insErr) {
      console.error('[أثر] فشل الإتمام:', insErr.message);
      showToast('تعذّر إتمام العمل — حاول مرة أخرى');
      deedView.busy = false;
      if (btn) btn.disabled = false;
      if (spinner) spinner.hidden = true;
      if (btnText) btnText.textContent = 'إتمام الأثر';
      return;
    }

    // If this completion was reached via a pending referral link, make
    // sure the referral row exists and is active. The trigger already did
    // this if the auth-time trigger created the pending row; this block
    // is a defensive fallback for legacy rows.
    try {
      const pending = readPendingReferral();
      if (pending && pending.ref) {
        const { data: referrerProfile } = await sb
          .from('profiles')
          .select('id')
          .ilike('username', pending.ref)
          .maybeSingle();
        if (referrerProfile && referrerProfile.id !== user.id) {
          await sb.from('referrals').upsert({
            referrer_id: referrerProfile.id,
            referred_id: user.id,
            deed_id: verse.id,
            status: 'active',
            activated_at: new Date().toISOString()
          }, { onConflict: 'referrer_id,referred_id,deed_id' });
        }
      }
    } catch (err) {
      console.warn('[أثر] تعذّر تأكيد الإحالة (المُشغّل يتولّى الأمر):', err);
    }

    // Bug 3 fix: DO NOT bump points locally. Let the DB be the source of truth.
    // Just clear the referral and refresh everything from the DB.
    clearPendingReferral();
    userReadsMap.set(verse.id, Date.now());

    if (versesGrid) {
      const card = versesGrid.querySelector(`.verse-card[data-id="${verse.id}"]`);
      if (card && !card.dataset.cooldownExpiry) {
        applyCooldownState(card, Date.now() + COOLDOWN_MS);
      }
    }

    closeDeedView();
    deedView.busy = false;

    playChime();
    haptic([12, 40, 18]);
    showToast(deedView.referrer ? `وصل أثرك إلى ${deedView.referrer} ✦` : 'تم إتمام العمل — جزاك الله خيراً');

    // Refresh from the database — this is the ONLY source of truth for points.
    await refreshStatsFromSupabase();
    await refreshTreeData();
    await loadLeaderboardFromSupabase();
  }

  (function wireDeedView() {
    deedView.el = $('#deedView');
    if (!deedView.el) return;

    const deedShareBtn = $('#deedViewShare');
    if (deedShareBtn) {
      deedShareBtn.addEventListener('click', async () => {
        const verse = deedView.verse;
        if (!verse) return;
        const link = await buildShareLink(verse.reference, verse.id);
        openShareSheet({
          title: verse.reference,
          content: verse.content,
          url: link.url,
          verseId: verse.id
        });
      });
    }
  })();

  document.addEventListener('click', e => {
    if (e.target.closest('[data-deed-close]')) { closeDeedView(); return; }
    if (e.target.closest('#deedViewLater'))    { closeDeedView(); return; }
    if (e.target.closest('#deedViewComplete')) { completeDeedFromView(); return; }
  });

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && deedView.el && deedView.el.classList.contains('is-open')) closeDeedView();
  });

  /* ============================================================
     ٢٠. زر إعادة تمركز الشجرة
     ============================================================ */

  const treeResetBtn = $('#treeReset');
  if (treeResetBtn) {
    treeResetBtn.addEventListener('click', () => {
      centerTreeView();
      renderTree();
      if (treeState.container) {
        delete treeState.container.dataset.zoomed;
        delete treeState.container.dataset.panned;
      }
    });
  }

  /* ============================================================
     ٢١. ترويسة التمرير
     ============================================================ */

  const header = $('#siteHeader');
  if (header) {
    let ticking = false;
    const applyHeaderState = () => {
      header.classList.toggle('is-scrolled', window.scrollY > 14);
      ticking = false;
    };
    window.addEventListener('scroll', () => {
      if (!ticking) { ticking = true; requestAnimationFrame(applyHeaderState); }
    }, { passive: true });
    applyHeaderState();
  }

  /* ============================================================
     ٢٢. الروابط العميقة (Deep Link)
     ============================================================ */

  function handleInitialHash() {
    const hash = window.location.hash.replace('#', '').toLowerCase();
    if (!hash) return;
    let tab = null;
    if (hash === 'verses' || hash === 'الآيات-والأحاديث')    tab = $('#tab-verses');
    else if (hash === 'sadaqah' || hash === 'بوابات-الصدقة') tab = $('#tab-sadaqah');
    else if (hash === 'tree' || hash === 'شجرة-الأثر')        tab = $('#tab-tree');
    else if (hash === 'board' || hash === 'لوحة-الشرف')      tab = $('#tab-board');
    if (tab) activateTab(tab, false);
  }

  /* ============================================================
     ٢٣. التهيئة الرئيسية
     ============================================================ */

  async function init() {
    updateOnlineState();
    captureReferralParams();
    injectTreeStatsIfMissing();

    treeState.container = $('#treeStage');
    treeState.canvas = $('#impactTree');
    if (treeState.canvas) {
      treeState.ctx = treeState.canvas.getContext('2d', { alpha: true });
      bindTreeInteraction();
    }

    ensureNodePopover();
    initGlider();

    const activeTab = $('.tab.is-active') || tabs[0];
    if (activeTab) {
      const target = activeTab.dataset.target;
      Object.keys(panels).forEach(key => {
        if (panels[key]) panels[key].classList.toggle('is-active', key === target);
      });
    }

    statsState.totalVerses = 0;
    recomputeDerivedStats();
    handleInitialHash();

    loadVersesFromSupabase();
    loadLeaderboardFromSupabase();
    refreshStatsFromSupabase();
    refreshTreeData();

    const sb = await waitForSupabase();
    if (sb && sb.auth && sb.auth.onAuthStateChange) {
      let initialSessionHandled = false;

      sb.auth.onAuthStateChange((event) => {
        if (event === 'INITIAL_SESSION') {
          if (!initialSessionHandled) {
            initialSessionHandled = true;
            handlePendingReferral();
          }
        } else if (event === 'SIGNED_IN') {
          refreshStatsFromSupabase();
          loadVersesFromSupabase();
          refreshTreeData();
          try { sessionStorage.removeItem(REFERRAL_PROMPT_KEY); } catch (_) {}
          setTimeout(() => handlePendingReferral({ silent: true }), 400);
        } else if (event === 'SIGNED_OUT') {
          refreshStatsFromSupabase();
          loadVersesFromSupabase();
          refreshTreeData();
          userReadsMap.clear();
          try { sessionStorage.removeItem(REFERRAL_PROMPT_KEY); } catch (_) {}
          authPromptShownThisPage = false;
        }
      });

      setTimeout(() => {
        if (!initialSessionHandled) {
          initialSessionHandled = true;
          handlePendingReferral();
        }
      }, 2000);
    } else {
      setTimeout(() => handlePendingReferral(), 800);
    }

    let resizeRaf = null;
    window.addEventListener('resize', () => {
      if (resizeRaf) cancelAnimationFrame(resizeRaf);
      resizeRaf = requestAnimationFrame(() => {
        if (treeState.canvas && panels.tree && panels.tree.classList.contains('is-active')) {
          resizeCanvas();
          renderTree();
        }
        const popover = document.getElementById('nodePopover');
        if (activePopoverNode && popover && popover.classList.contains('is-visible')) {
          const screenPos = worldToScreen(activePopoverNode.x, activePopoverNode.y);
          positionNodePopover(popover, screenPos);
        }
      });
    }, { passive: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }

  /* ============================================================
     ٢٤. الواجهة العامة
     ============================================================ */

  window.Athar = {
    showToast: showToast,
    openAdmin: openAdminModal,
    closeAdmin: closeAdminModal,
    openAbout: openAbout,
    closeAbout: closeAbout,
    openShare: openShareSheet,
    closeShare: closeShareSheet,
    openDeedView: openDeedView,
    closeDeedView: closeDeedView,
    activateTab: target => {
      const t = tabs.find(x => x.dataset.target === target);
      if (t) activateTab(t, true);
    },
    refreshVerses: loadVersesFromSupabase,
    refreshLeaderboard: loadLeaderboardFromSupabase,
    refreshStats: refreshStatsFromSupabase,
    refreshTree: refreshTreeData,
    handlePendingReferral: handlePendingReferral,
    checkIsAuthenticated: checkIsAuthenticated,
    treeCenter: () => { centerTreeView(); renderTree(); },
    treeReset: () => {
      centerTreeView();
      renderTree();
      if (treeState.container) {
        delete treeState.container.dataset.zoomed;
        delete treeState.container.dataset.panned;
      }
    },
    treeZoomBy: factor => {
      const newScale = clamp(treeState.view.scale * factor, treeState.minScale, treeState.maxScale);
      treeState.view.scale = newScale;
      renderTree();
    },
    getStats: () => ({
      total: statsState.totalVerses,
      completed: statsState.completedCount,
      available: statsState.availableCount,
      points: statsState.totalPoints
    }),
    sound: {
      enable: () => { soundEnabled = true; try { localStorage.setItem(SOUND_KEY, 'on'); } catch (_) {} },
      disable: () => { soundEnabled = false; try { localStorage.setItem(SOUND_KEY, 'off'); } catch (_) {} },
      isEnabled: () => soundEnabled
    },
    sanitize: sanitizeText
  };

})();