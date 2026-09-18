/* ============================================================
   ATHAR — أثر | Supabase Authentication & Admin Gate
   js/auth.js
   ============================================================ */

(() => {
  'use strict';

  /* ------------------------------------------------------------
     الثوابت
     ------------------------------------------------------------ */
  const SUPABASE_URL      = 'https://yzdsysagnaedddtkjluq.supabase.co';
  const SUPABASE_ANON_KEY = 'sb_publishable_-n9NXEkMaW33kxEat7YxqQ_JvCqCjFb';
  const ADMIN_EMAIL       = 'mohd.hisham.mohsen@gmail.com';

  const REFERRAL_STORAGE_KEY = 'athar_pending_referral';

  const ROLE_MEMBER = 'عضو';
  const ROLE_ADMIN  = 'مشرف';

  /* ------------------------------------------------------------
     أدوات مساعدة
     ------------------------------------------------------------ */
  const $  = (sel, ctx = document) => ctx.querySelector(sel);
  const $$ = (sel, ctx = document) => Array.from(ctx.querySelectorAll(sel));

  function toast(message, duration = 2800) {
    if (window.Athar && typeof window.Athar.showToast === 'function') {
      window.Athar.showToast(message, duration);
    } else {
      console.info('[Athar]', message);
    }
  }

  function normalizeEmail(value) {
    return typeof value === 'string' ? value.trim().toLowerCase() : '';
  }

  function humanizeAuthError(error) {
    if (!error) return 'حدث خطأ غير متوقع، حاول مرة أخرى.';
    const code = error.code || '';
    const msg  = (error.message || '').toLowerCase();
    if (code === 'invalid_credentials' || msg.includes('invalid login credentials')) return 'البريد أو كلمة المرور غير صحيحة.';
    if (code === 'email_not_confirmed' || msg.includes('email not confirmed')) return 'يرجى تأكيد بريدك الإلكتروني أولاً من الرسالة المرسلة إليك.';
    if (code === 'user_already_exists' || msg.includes('already registered')) return 'هذا البريد مسجّل مسبقاً، يمكنك تسجيل الدخول.';
    if (code === 'weak_password' || msg.includes('password')) return 'كلمة المرور ضعيفة، اختر ٦ أحرف على الأقل.';
    if (code === 'over_email_send_rate_limit' || msg.includes('rate limit')) return 'تم إرسال رسائل كثيرة، حاول بعد قليل.';
    if (msg.includes('network') || msg.includes('fetch')) return 'تعذّر الاتصال بالخادم، تحقّق من الإنترنت.';
    return error.message || 'حدث خطأ، حاول مرة أخرى.';
  }

  /* ------------------------------------------------------------
     مراجع DOM
     ------------------------------------------------------------ */
  const slot         = $('#authSlot');
  const openBtn      = $('#authOpenBtn');
  const userBox      = $('#authUser');
  const avatarEl     = $('#authAvatar');
  const emailDisplay = $('#authEmailDisplay');
  const authRoleEl   = $('#authRoleDisplay');
  const logoutBtn    = $('#authLogoutBtn');

  const modal      = $('#authModal');
  const dialog     = $('#authDialog');
  const modalTitle = $('#authModalTitle');
  const segments   = $$('.auth-seg');
  const segGlider  = $('#authSegGlider');

  const form          = $('#authForm');
  const usernameInput = $('#authUsername');
  const emailInput    = $('#authEmail');
  const passInput     = $('#authPassword');
  const passHint      = $('#authPasswordHint');
  const feedback      = $('#authFeedback');
  const submitBtn     = $('#authSubmitBtn');
  const submitText    = $('#authSubmitText');
  const spinner       = $('#authSpinner');

  if (!slot || !modal || !form) return;

  /* ------------------------------------------------------------
     تهيئة عميل Supabase
     ------------------------------------------------------------ */
  let supabase = null;
  if (typeof window.supabase !== 'undefined' && typeof window.supabase.createClient === 'function') {
    supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
        storageKey: 'athar.auth'
      }
    });
    window.AtharSupabase = supabase;
    window.dispatchEvent(new CustomEvent('athar:supabase-ready', { detail: { client: supabase } }));
  }

  /* ------------------------------------------------------------
     حالة الواجهة
     ------------------------------------------------------------ */
  let currentView = 'signin';
  let lastFocused = null;

  /* ------------------------------------------------------------
     منطق الأدوار — مصدر واحد للحقيقة
     ------------------------------------------------------------ */
  function resolveRole(user) {
    const email = normalizeEmail(user && user.email);
    const isAdmin = !!email && email === normalizeEmail(ADMIN_EMAIL);
    return {
      label: isAdmin ? ROLE_ADMIN : ROLE_MEMBER,
      isAdmin
    };
  }

  function isAdminUser(user) {
    return resolveRole(user).isAdmin;
  }

  /* ------------------------------------------------------------
     التحكم بالنافذة
     ------------------------------------------------------------ */
  function setView(view, animate = true) {
    if (view !== 'signin' && view !== 'signup') return;
    currentView = view;

    segments.forEach(seg => {
      const on = seg.dataset.authView === view;
      seg.classList.toggle('is-active', on);
      seg.setAttribute('aria-selected', on ? 'true' : 'false');
    });

    if (segGlider) {
      const idx = segments.findIndex(s => s.dataset.authView === view);
      if (idx >= 0) {
        if (!animate) segGlider.style.transition = 'none';
        segGlider.style.transform = `translateX(${idx * -100}%)`;
        if (!animate) {
          void segGlider.offsetWidth;
          requestAnimationFrame(() => { segGlider.style.transition = ''; });
        }
      }
    }

    if (modalTitle) modalTitle.textContent = view === 'signin' ? 'تسجيل الدخول' : 'إنشاء حساب';
    if (submitText) submitText.textContent = view === 'signin' ? 'دخول' : 'إنشاء الحساب';
    if (passInput)  passInput.setAttribute('autocomplete', view === 'signin' ? 'current-password' : 'new-password');
    if (passHint)   passHint.hidden = view === 'signin';

    if (usernameInput) {
      const usernameField = usernameInput.closest('.field') || usernameInput.parentElement;
      if (usernameField) usernameField.hidden = (view === 'signin');
    }

    clearFeedback();
    setTimeout(() => (view === 'signup' && usernameInput ? usernameInput.focus() : emailInput && emailInput.focus()), 120);
  }

  function openModal() {
    if (!modal) return;
    lastFocused = document.activeElement;
    modal.classList.add('is-open');
    modal.setAttribute('aria-hidden', 'false');
    document.body.classList.add('is-locked');
    setView('signin', false);
    form.reset();
    clearFeedback();
    setTimeout(() => emailInput && emailInput.focus(), 280);
  }

  function closeModal() {
    if (!modal) return;
    modal.classList.remove('is-open');
    modal.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('is-locked');
    form.reset();
    clearFeedback();
    if (lastFocused && typeof lastFocused.focus === 'function') lastFocused.focus();
  }

  /* ------------------------------------------------------------
     التغذية الراجعة
     ------------------------------------------------------------ */
  function setFeedback(message, type = 'error') {
    if (!feedback) return;
    feedback.textContent = message;
    feedback.classList.remove('is-error', 'is-success');
    feedback.classList.add('is-visible', type === 'success' ? 'is-success' : 'is-error');
  }

  function clearFeedback() {
    if (!feedback) return;
    feedback.textContent = '';
    feedback.classList.remove('is-visible', 'is-error', 'is-success');
  }

  function setLoading(isLoading) {
    if (!submitBtn) return;
    submitBtn.disabled = isLoading;
    submitBtn.classList.toggle('is-loading', isLoading);
    submitBtn.style.opacity = isLoading ? '.85' : '';
    if (spinner) spinner.hidden = !isLoading;
    if (submitText) submitText.style.opacity = isLoading ? '.6' : '';
  }

  /* ------------------------------------------------------------
     بوابة الإدارة
     ------------------------------------------------------------ */
  function applyAdminGate(user) {
    const trigger = document.getElementById('adminTrigger');
    if (!trigger) return;
    const isAdmin = isAdminUser(user);
    trigger.hidden = !isAdmin;
    trigger.setAttribute('aria-hidden', isAdmin ? 'false' : 'true');
  }

  /* ------------------------------------------------------------
     حالات المصادقة — Logged Out / Logged In
     ------------------------------------------------------------ */
  function showLoggedOut() {
    if (openBtn) {
      openBtn.hidden = false;
      openBtn.removeAttribute('aria-hidden');
    }
    if (userBox) {
      userBox.hidden = true;
      userBox.setAttribute('aria-hidden', 'true');
    }
    if (avatarEl)     avatarEl.textContent = '';
    if (emailDisplay) emailDisplay.textContent = '';
    if (authRoleEl) {
      authRoleEl.textContent = '';
      authRoleEl.classList.remove('is-admin');
    }
    applyAdminGate(null);
  }

  function showLoggedIn(user) {
    if (!user) return showLoggedOut();

    const displayName = (user.user_metadata && user.user_metadata.username)
                      || user.email
                      || ROLE_MEMBER;
    const initial = (String(displayName).trim()[0] || 'أ').toUpperCase();

    if (avatarEl)     avatarEl.textContent     = initial;
    if (emailDisplay) emailDisplay.textContent = displayName;

    const role = resolveRole(user);
    if (authRoleEl) {
      authRoleEl.textContent = role.label;
      authRoleEl.classList.toggle('is-admin', role.isAdmin);
    }

    if (openBtn) {
      openBtn.hidden = true;
      openBtn.setAttribute('aria-hidden', 'true');
    }
    if (userBox) {
      userBox.hidden = false;
      userBox.removeAttribute('aria-hidden');
    }

    applyAdminGate(user);
  }

  /* ------------------------------------------------------------
     التسجيل / الدخول / الخروج
     ------------------------------------------------------------ */
  async function handleSignUp(email, password, rawUsername) {
    // Bug 2 fix: NEVER fall back to email prefix on the client. If the
    // user left the field blank, we still send an empty string and let
    // the server-side trigger decide the fallback (or reject).
    const username = (rawUsername || '').trim();

    let referrerUsername = null;
    let referralDeedId   = null;

    try {
      const raw = localStorage.getItem(REFERRAL_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        const age = parsed && parsed.capturedAt ? Date.now() - parsed.capturedAt : 0;
        if (!parsed || !parsed.capturedAt || age < 86400_000) {
          referrerUsername = (parsed && parsed.ref  ? parsed.ref  : '').trim() || null;
          referralDeedId   = (parsed && parsed.deed ? parsed.deed : '').trim() || null;
        }
      }
    } catch (_) {}

    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: {
          username: username,          // ← real username from form
          referred_by: referrerUsername,
          referral_deed: referralDeedId
        },
        emailRedirectTo: window.location.origin + window.location.pathname
      }
    });

    if (error) {
      setFeedback(humanizeAuthError(error), 'error');
      toast('تعذّر إنشاء الحساب — ' + humanizeAuthError(error));
      return;
    }

    if (data.session) {
      setFeedback('تم إنشاء الحساب وتسجيل الدخول بنجاح.', 'success');
      toast(`مرحباً بك يا ${username || 'عضو'} ✦`);
      closeModal();
    } else {
      setFeedback('تم إنشاء الحساب — يرجى تأكيد بريدك الإلكتروني.', 'success');
      toast('تحقّق من بريدك الإلكتروني لتأكيد الحساب');
    }
  }

  async function handleSignIn(email, password) {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      setFeedback(humanizeAuthError(error), 'error');
      toast('تعذّر تسجيل الدخول — ' + humanizeAuthError(error));
      return;
    }
    setFeedback('تم تسجيل الدخول بنجاح.', 'success');
    toast('أهلاً بعودتك ✦');
    closeModal();
  }

  async function handleLogout() {
    if (!supabase) return;
    const { error } = await supabase.auth.signOut();
    if (error) {
      toast('تعذّر تسجيل الخروج — حاول مرة أخرى');
      return;
    }
    toast('تم تسجيل الخروج بنجاح');
  }

  /* ------------------------------------------------------------
     ربط الأحداث
     ------------------------------------------------------------ */
  if (openBtn)   openBtn.addEventListener('click', openModal);
  if (logoutBtn) logoutBtn.addEventListener('click', handleLogout);

  modal.addEventListener('click', e => {
    if (e.target.closest('[data-auth-close]')) closeModal();
  });

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && modal.classList.contains('is-open')) closeModal();
  });

  segments.forEach(seg => {
    seg.addEventListener('click', () => {
      const view = seg.dataset.authView;
      if (view && view !== currentView) setView(view, true);
    });
  });

  form.addEventListener('submit', async e => {
    e.preventDefault();
    if (!supabase) {
      setFeedback('خدمة الحساب غير مهيّأة بعد. يرجى التحقق من المفاتيح.', 'error');
      return;
    }
    clearFeedback();

    const email    = (emailInput ? emailInput.value : '').trim().toLowerCase();
    const password = (passInput ? passInput.value : '');
    const username = (usernameInput ? usernameInput.value : '').trim();

    if (currentView === 'signup') {
      // Bug 2 fix: require a real username at signup.
      if (!username || username.length < 2) {
        setFeedback('يرجى كتابة الاسم الكريم (حرفان على الأقل).', 'error');
        if (usernameInput) usernameInput.focus();
        return;
      }
    }

    if (!email || email.indexOf('@') === -1 || email.indexOf('.') === -1) {
      setFeedback('يرجى إدخال بريد إلكتروني صحيح.', 'error');
      if (emailInput) emailInput.focus();
      return;
    }
    if (!password || password.length < 6) {
      setFeedback('كلمة المرور يجب أن تكون ٦ أحرف على الأقل.', 'error');
      if (passInput) passInput.focus();
      return;
    }

    setLoading(true);
    try {
      if (currentView === 'signup') {
        await handleSignUp(email, password, username);
      } else {
        await handleSignIn(email, password);
      }
    } catch (err) {
      setFeedback(humanizeAuthError(err), 'error');
    } finally {
      setLoading(false);
    }
  });

  /* ------------------------------------------------------------
     الجلسة الأولية ومراقبة الحالة
     ------------------------------------------------------------ */
  async function bootstrapSession() {
    if (!supabase) { showLoggedOut(); return; }
    try {
      const { data, error } = await supabase.auth.getSession();
      if (error || !data || !data.session || !data.session.user) showLoggedOut();
      else showLoggedIn(data.session.user);
    } catch (_) {
      showLoggedOut();
    }
  }

  if (supabase) {
    supabase.auth.onAuthStateChange((event, session) => {
      if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED' || event === 'INITIAL_SESSION') {
        if (session && session.user) showLoggedIn(session.user);
        else showLoggedOut();
      } else if (event === 'SIGNED_OUT') {
        showLoggedOut();
      } else if (event === 'USER_UPDATED' && session && session.user) {
        showLoggedIn(session.user);
      }
    });
  }

  function init() {
    showLoggedOut();
    bootstrapSession();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }

  /* ------------------------------------------------------------
     الواجهة العامة
     ------------------------------------------------------------ */
  window.AtharAuth = {
    open: openModal,
    close: closeModal,
    setView: setView,
    logout: handleLogout,
    applyAdminGate: applyAdminGate,
    resolveRole: resolveRole,
    isAdmin: isAdminUser,
    getUser: async () => {
      if (!supabase) return null;
      const { data } = await supabase.auth.getUser();
      return (data && data.user) || null;
    }
  };
})();