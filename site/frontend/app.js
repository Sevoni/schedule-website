// ── Config ────────────────────────────────────────────────────

const DEFAULT_API = 'https://kampussgu.dpdns.org';
const DEFAULT_GROUP = '131-ибо';
const CAMPUS_URL = 'https://campus.syktsu.ru/schedule/group/';
const CAMPUS_CLASSROOM_URL = 'https://campus.syktsu.ru/schedule/classroom/';

// Страница открыта через Яндекс.Перевод (translated.turbopages.org).
// В прокси прямой коннект на наш домен блокируется их CSP (connect-src),
// поэтому API-запросы идут относительным путём ./api/... через прокси
// (same-origin, без CORS). Ведущая точка в суффиксе исключает коллизию
// с доменами вида attackerturbopages.org.
const IS_TURBOPAGES = location.hostname.endsWith('.turbopages.org');

// Таймаут HTTP-запросов (campus + API воркера), мс. Зависший запрос обрывается
// через AbortController, чтобы не «висеть» бесконечно (задача №14). 15 c —
// campus.syktsu.ru иногда отвечает медленно, но дольше ждать нет смысла.
// Переопределяется per-call через opts.timeout (0 — отключить таймаут).
const FETCH_TIMEOUT_MS = 15000;

function fetchTimeout(url, opts = {}) {
  const { timeout = FETCH_TIMEOUT_MS, signal, ...rest } = opts;
  const controller = new AbortController();

  // Если вызывающий передал свой signal — не перезаписываем, а отменяем
  // внутренний контроллер вместе с внешним (для будущих вызовов; сейчас
  // signal никто не передаёт). Слушатель снимаем в finally — без утечек.
  const onOuterAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) {
      controller.abort();
    } else {
      signal.addEventListener('abort', onOuterAbort, { once: true });
    }
  }

  const timer = timeout > 0 ? setTimeout(() => controller.abort(), timeout) : null;

  return fetch(url, { ...rest, signal: controller.signal }).finally(() => {
    if (timer) clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onOuterAbort);
  });
}

// Удаляет перечисленные ключи из query-строки URL, не трогая остальные.
// Используется для синхронной зачистки токенов (?token=, ?owner=) из адресной
// строки сразу после их чтения — до сетевых запросов (безопасность).
// Hash-токены (#invite=, #owner=) зачищаются через history.replaceState.
function clearUrlParams(keysToRemove) {
  const params = new URLSearchParams(location.search);
  let changed = false;
  for (const k of keysToRemove) {
    if (params.has(k)) { params.delete(k); changed = true; }
  }
  if (!changed) return;
  const rest = params.toString();
  history.replaceState(null, '', location.pathname + (rest ? '?' + rest : ''));
}

const DAY_NAMES = ['Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота', 'Воскресенье'];
const DAY_SHORT = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];

// ── State ─────────────────────────────────────────────────────

let state = {
  // В прокси Яндекса — base текущей страницы (translated.turbopages.org/proxy_u/<hash>/https/kampussgu.dpdns.org/),
  // иначе обычный API-домен. Все apiFetch/apiPost/apiPut/apiDelete строят URL через state.apiBase.
  // Трейлинг-слэш убираем: код конкатенирует apiBase + '/api/...', иначе получится //api/ (404 у Cloudflare).
  apiBase: IS_TURBOPAGES ? new URL('./', location.href).href.replace(/\/+$/, '') : DEFAULT_API,
  group: (localStorage.getItem('group') || '').toLowerCase(),
  // campusEnabled: по умолчанию true. При false topical загрузки из кампуса не происходит — только из БД.
  // В прокси Яндекса campus.syktsu.ru недоступен по CORS — отключаем синхронизацию (без записи в localStorage).
  campusEnabled: IS_TURBOPAGES ? false : localStorage.getItem('campusEnabled') !== '0',
  // subgroupFilter: 'any' — показывать обе подгруппы; '1'/'2' — только свою.
  subgroupFilter: localStorage.getItem('subgroupFilter') || 'any',
  lastSyncAt: localStorage.getItem('lastSyncAt') || '',
  campusUpdatedAt: localStorage.getItem('campusUpdatedAt') || '',
  tgChatId: localStorage.getItem('tgChatId') || '',
  tgBotUsername: localStorage.getItem('tgBotUsername') || '',
  tgSubgroup: localStorage.getItem('tgSubgroup') || '',
  // writerGroup — группа, для которой сервер подтвердил роль редактора
  // (HttpOnly-cookie __Host-writer_tokens, которую JS не видит). Роль
  // восстанавливается через GET /api/writer/status. В localStorage токены
  // НЕ хранятся (закрывает XSS-кражу) — старые ключи writerTokens/writerToken
  // мигрируются в куку один раз (migrateLegacyWriterTokens).
  writerGroup: '',
  // ownerCode — никогда не хранится в localStorage/state: код владельца живёт
  // в HttpOnly-cookie на сервере, JS его не знает. Поле оставлено для памяти.
  ownerRole: false,
  ownerCode: '',
  schedule: null,
  scheduleCache: {},
  weeks: [],
  currentWeekIdx: -1,
  selectedDay: null,
  homework: [],
  // Глобальные объявления owner'а (колокольчик). Общие для всех групп.
  announcements: [],
  syncing: false,
  // Тема оформления: 'dark' | 'light' | 'auto'. По умолчанию — системная (auto):
  // при первом открытии берётся prefers-color-scheme, ручной выбор сохраняется.
  theme: localStorage.getItem('theme') || 'auto',
  // Цвет акцента (кнопки). Хранится как hex. По умолчанию синий из :root.
  accent: localStorage.getItem('accent') || '',
  // Флаг «свежести» списка недель: ставится когда bootstrap или
  // syncWeeksFromCampus обновили state.weeks за последние 60 секунд. Между
  // ними бывает гонка (оба тянут недели параллельно), что приводит к
  // двойному запросу в воркер. По этому флагу syncAll пропускает
  // syncWeeksFromCampus, если недели уже только что освежены.
  weeksFreshUntil: 0,
};

// ── Клиентский кеш недель в localStorage (TTL 1ч) ──────────────
// Избавляет от /api/weeks при повторных открытиях в течение часа.
// Кеш хранится per-group: `weeksCache:{group}` = { ts, weeks }.
const WEEKS_CACHE_TTL_MS = 60 * 60 * 1000; // 1 час
const SCHEDULE_CACHE_TTL_MS = 5 * 60 * 1000; // 5 минут для расписаний
const HW_CACHE_TTL_MS = 5 * 60 * 1000; // 5 минут для домашки
const SUBJECTS_CACHE_TTL_MS = 10 * 60 * 1000; // 10 минут для предметов

function weeksCacheKey() {
  return 'weeksCache:' + state.group;
}
function loadWeeksFromCache() {
  try {
    const raw = localStorage.getItem(weeksCacheKey());
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.weeks)) return null;
    if (typeof parsed.ts !== 'number') return null;
    if (Date.now() - parsed.ts > WEEKS_CACHE_TTL_MS) return null;
    return parsed.weeks;
  } catch (e) {
    return null;
  }
}
function saveWeeksToCache(weeks) {
  try {
    localStorage.setItem(weeksCacheKey(), JSON.stringify({ ts: Date.now(), weeks }));
  } catch (e) { /* квота — игнорируем */ }
}

// Кеш расписаний per-group: `schedCache:{group}` = { ts, data: {weekCode: data} }
function schedCacheKey() {
  return 'schedCache:' + state.group;
}
function loadSchedFromCache() {
  try {
    const raw = localStorage.getItem(schedCacheKey());
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !parsed.data || typeof parsed.ts !== 'number') return null;
    if (Date.now() - parsed.ts > SCHEDULE_CACHE_TTL_MS) return null;
    return parsed.data;
  } catch (e) {
    return null;
  }
}
function saveSchedToCache(map) {
  try {
    localStorage.setItem(schedCacheKey(), JSON.stringify({ ts: Date.now(), data: map }));
  } catch (e) { /* квота — игнорируем */ }
}
function invalidateSchedCache() {
  try {
    localStorage.removeItem(schedCacheKey());
  } catch (e) { /* ignore */ }
}
function invalidateWeeksCache() {
  try {
    localStorage.removeItem(weeksCacheKey());
  } catch (e) { /* ignore */ }
}

// Кеш ДЗ per-group: `hwCache:{group}` = { ts, data }
// TTL 5 минут — синхронизация с бэкендом приносит свежий список в ответе
// sync-from-campus, после чего кеш обновляется (см. saveHwToCache).
function hwCacheKey() {
  return 'hwCache:' + state.group;
}
function loadHwFromCache() {
  try {
    const raw = localStorage.getItem(hwCacheKey());
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.data) || typeof parsed.ts !== 'number') return null;
    if (Date.now() - parsed.ts > HW_CACHE_TTL_MS) return null;
    return parsed.data;
  } catch (e) {
    return null;
  }
}
function saveHwToCache(data) {
  try {
    localStorage.setItem(hwCacheKey(), JSON.stringify({ ts: Date.now(), data }));
  } catch (e) { /* квота — игнорируем */ }
}
function invalidateHwCache() {
  try {
    localStorage.removeItem(hwCacheKey());
  } catch (e) { /* ignore */ }
}

// Кеш предметов per-group: `subjCache:{group}` = { ts, data }
// TTL 10 минут — предметы меняются редко (только при изменении расписания
// на бэкенде, который возвращает subjects в ответе sync-from-campus).
function subjCacheKey() {
  return 'subjCache:' + state.group;
}
function loadSubjectsFromCache() {
  try {
    const raw = localStorage.getItem(subjCacheKey());
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.data) || typeof parsed.ts !== 'number') return null;
    if (Date.now() - parsed.ts > SUBJECTS_CACHE_TTL_MS) return null;
    return parsed.data;
  } catch (e) {
    return null;
  }
}
function saveSubjectsToCache(data) {
  try {
    localStorage.setItem(subjCacheKey(), JSON.stringify({ ts: Date.now(), data }));
  } catch (e) { /* квота — игнорируем */ }
}
function invalidateSubjectsCache() {
  try {
    localStorage.removeItem(subjCacheKey());
  } catch (e) { /* ignore */ }
}

// Валидация номера группы: 3 цифры, (опционально буква), дефис, 3-4 буквы.
const GROUP_RE = /^\d{3}[а-яА-ЯёЁ]?-[а-яА-ЯёЁ]{3,4}$/i;
function isValidGroup(g) {
  return typeof g === 'string' && GROUP_RE.test(g.trim());
}

// isWriter — true, если сервер подтвердил роль редактора для текущей группы
// (writerGroup) или пользователь owner. Чисто UI-флаг: показывать кнопки
// редактирования или нет. Авторизацию всё равно проверяет бэкенд
// (requireWriter) — фронтенд здесь не критичен.
function isWriter() {
  return state.writerGroup === state.group || state.ownerRole;
}
function isOwner() {
  return state.ownerRole;
}
function getAuthToken() {
  // Токенов в JS больше нет: роль writer подтверждает HttpOnly-cookie
  // __Host-writer_tokens, прикрепляемая браузером сама. Bearer-заголовок
  // не шлём — GET'ы остаются reader-кэшируемыми (без preflight).
  return '';
}

// Проверяет у сервера роль редактора для группы (GET /api/writer/status,
// куку прикладывает браузер). state.writerGroup обновляется по ответу;
// при падении роли прячем UI редактирования и показываем toast.
async function refreshWriterStatus(group) {
  const target = group || state.group;
  let isW = false;
  try {
    const resp = await fetchTimeout(state.apiBase + '/api/writer/status?group=' + encodeURIComponent(target), {
      headers: { 'Cache-Control': 'no-store' },
    });
    const data = await resp.json().catch(() => ({}));
    isW = data.isWriter === true;
  } catch (e) {
    // Сеть недоступна — роль оставляем как есть; следующее действие решит на сервере.
    console.warn('[refreshWriterStatus] network error:', e.message);
    return;
  }
  const was = isWriter();
  state.writerGroup = isW ? target : '';
  if (isWriter() !== was) {
    refreshEditVisibility();
    if (was && !isW) {
      const section = document.getElementById('inviteSection');
      if (section) section.style.display = 'none';
      const divider = document.getElementById('inviteDivider');
      if (divider) divider.style.display = 'none';
      showToast('Права на редактирование отозваны', 'warn');
    }
  }
}

// Разовый перенос старых токенов из localStorage в HttpOnly-cookie.
// До перехода на куку токены лежали в localStorage (ключи writerTokens /
// writerToken) — отправляем их на /api/invite/verify (сервер сам поставит
// куку), затем чистим localStorage. Вызывается при старте до loadData.
async function migrateLegacyWriterTokens() {
  let legacy = {};
  try {
    legacy = JSON.parse(localStorage.getItem('writerTokens') || '{}') || {};
  } catch (_) {
    legacy = {};
  }
  const oldToken = localStorage.getItem('writerToken');
  if (oldToken && legacy && typeof legacy === 'object') {
    const grp = (localStorage.getItem('group') || '').toLowerCase();
    if (grp && !legacy[grp]) legacy[grp] = oldToken;
  }
  const entries = Object.entries(legacy);
  if (entries.length === 0) return;
  for (const [group, token] of entries) {
    if (!token) continue;
    try {
      await fetchTimeout(state.apiBase + '/api/invite/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      });
    } catch (e) {
      console.warn('[migrateLegacyWriterTokens] verify failed:', e.message);
    }
  }
  localStorage.removeItem('writerTokens');
  localStorage.removeItem('writerToken');
  if (entries.length) {
    console.log('[migrate] writer-токены перенесены из localStorage в HttpOnly-cookie');
  }
}

// ── Тема и акцент ───────────────────────────────────────────
function resolveTheme() {
  if (state.theme === 'auto') {
    const prefersLight = window.matchMedia &&
      window.matchMedia('(prefers-color-scheme: light)').matches;
    return prefersLight ? 'light' : 'dark';
  }
  return state.theme === 'light' ? 'light' : 'dark';
}

function applyTheme() {
  const t = resolveTheme();
  document.documentElement.setAttribute('data-theme', t);
  // Следим за системной темой, только если выбран auto.
  if (window._themeMq) {
    window._themeMq.removeEventListener('change', window._themeMqHandler);
  }
  if (state.theme === 'auto') {
    if (!window._themeMq) {
      window._themeMq = window.matchMedia('(prefers-color-scheme: light)');
    }
    window._themeMqHandler = () => {
      document.documentElement.setAttribute('data-theme', resolveTheme());
    };
    window._themeMq.addEventListener('change', window._themeMqHandler);
  }
  // Вспышка при ручной смене темы (не при загрузке).
  if (window._themeApplied) {
    const sweep = document.getElementById('themeSweep');
    if (sweep) {
      sweep.classList.remove('theme-sweep-anim');
      void sweep.offsetWidth;
      sweep.classList.add('theme-sweep-anim');
    }
  }
  window._themeApplied = true;
}

function applyAccent() {
  if (state.accent) {
    document.documentElement.style.setProperty('--accent', state.accent);
    // accent-dim — чуть темнее для hover/gradients.
    document.documentElement.style.setProperty('--accent-dim', shade(state.accent, -0.18));
    // ВАЖНО: переменную --accent-dim-text (акцентный цвет ТЕКСТА, напр. автор задания)
    // намеренно НЕ переопределяем: shade(accent, -0.18) для тёмных/жёлтых акцентов
    // даёт цвет с контрастом < 4.5:1 на карточках. Её фиксированные значения заданы
    // в style.css для каждой темы и гарантируют читаемость при любом акценте.
  } else {
    document.documentElement.style.removeProperty('--accent');
    document.documentElement.style.removeProperty('--accent-dim');
  }
}

// Затемнение/осветление hex-цвета на долю f (-1..1).
function shade(hex, f) {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (!m) return hex;
  let r = parseInt(m[1], 16), g = parseInt(m[2], 16), b = parseInt(m[3], 16);
  const adj = (c) => {
    const v = Math.round(f < 0 ? c * (1 + f) : c + (255 - c) * f);
    return Math.max(0, Math.min(255, v));
  };
  r = adj(r); g = adj(g); b = adj(b);
  return '#' + [r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('');
}

// Заглушка для совместимости: иконки через <use href="#icon-x"> рендерятся
// сами из инлайн-спрайта в index.html. Вызывается после обновлений DOM на всякий случай.
function refreshIcons() {}

// Системная настройка «меньше движения»: используется для отключения
// JS-управляемых анимаций (карусель, пружинный overscroll) и ускорения
// задержек, ждущих завершения CSS-transition.
function prefersReducedMotion() {
  return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

// Делегированный обработчик анимаций клика для кнопок с data-anim.
function setupAnimations() {
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-anim]');
    if (!btn) return;
    const type = btn.getAttribute('data-anim');
    const map = { spin: 'anim-spin', scale: 'anim-scale', ring: 'anim-ring', 'slide-right': 'anim-slide-right', 'slide-left': 'anim-slide-left' };
    const cls = map[type];
    if (!cls) return;
    btn.classList.remove(cls);
    // reflow, чтобы перезапустить transition
    void btn.offsetWidth;
    btn.classList.add(cls);
    setTimeout(() => btn.classList.remove(cls), 600);
  });
}

let editingHwId = null;
let originalHwFields = null;

function getHwFormValues() {
  const sel = document.getElementById('hwSubject');
  const isCustom = sel.value === '__custom__';
  const subject = isCustom
    ? document.getElementById('hwSubjectCustom').value.trim()
    : decodePairValue(sel.value).subject;
  const pairType = document.getElementById('hwPairType').value;
  const subgroup = document.getElementById('hwSubgroup').value || 'any';
  const task = document.getElementById('hwTask').value.trim();
  const author = document.getElementById('hwAuthor').value.trim();
  const modeRadio = document.querySelector('input[name="hwDueMode"]:checked');
  const dueMode = modeRadio ? modeRadio.value : 'date';
  const dueDate = calState.selectedDate;
  return { subject, pairType, subgroup, task, author, dueMode, dueDate };
}

function updateSaveBtnState() {
  const btn = document.getElementById('saveHomework');
  if (!originalHwFields) { btn.disabled = false; return; }
  const current = getHwFormValues();
  const changed = Object.keys(originalHwFields).some(k => originalHwFields[k] !== current[k]);
  btn.disabled = !changed;
}

// Множество id ДЗ, отмеченных пользователем как выполненные (локально, per-группа).
// Хранится в localStorage — при очистке браузера отметки сбрасываются.
let doneHwIds = loadDoneHw();

function doneHwKey() {
  return 'doneHw:' + state.group;
}

function loadDoneHw() {
  try {
    const raw = localStorage.getItem(doneHwKey());
    return new Set(raw ? JSON.parse(raw) : []);
  } catch (e) {
    return new Set();
  }
}

function saveDoneHw() {
  try {
    localStorage.setItem(doneHwKey(), JSON.stringify([...doneHwIds]));
  } catch (e) { /* квота/недоступность — игнорируем */ }
}

// Точечно обновляет UI отметки «выполнено» после смены doneHwIds — вместо
// полного перерендера дня/списка (сохраняет фокус и скролл). Нижний список
// заданий и элементы пар в расписании обновляются без пересоздания родителя.
function updateHwDoneState(id) {
  const done = doneHwIds.has(id);

  // Расписание: переключаем класс .done у элемента пары с этим ДЗ (визуал
  // отметки целиком описан в CSS через .pair-hw-item.done — style.css 529–541).
  // Элемент не пересоздаётся, поэтому фокус и скролл сохраняются.
  document.querySelectorAll('.pair-hw-item').forEach(item => {
    const btn = item.querySelector('.pair-hw-done');
    if (btn && btn.dataset.id === id) {
      item.classList.toggle('done', done);
      btn.title = done ? 'Снять отметку «выполнено»' : 'Отметить выполненным';
    }
  });

  // Нижний список ДЗ: выполненные скрываются из списка, при снятии — возвращаются.
  const list = document.getElementById('homeworkList');
  if (!list) return;
  const hwBtn = Array.from(list.querySelectorAll('.hw-done')).find(b => b.dataset.id === id);
  if (hwBtn) {
    const card = hwBtn.closest('.hw-card');
    if (card) card.remove();
    if (!list.querySelector('.hw-card')) {
      list.innerHTML = '<div class="no-homework">Нет заданий</div>';
    }
  } else if (!done) {
    // Карточки в списке нет, а отметка снята — вернём её. Перерисовывается
    // только нижний список (день не затрагивается).
    renderHomework();
  }
}

// ── Init ──────────────────────────────────────────────────────

// Возвращает расписание недели, которая календарно содержит сегодняшнюю дату
// (а не неделю, на которой сейчас находится пользователь).
function getCurrentWeekSchedule() {
  const today = new Date();
  for (const w of state.weeks) {
    if (!w.dates || w.dates.length < 2) continue;
    const start = parseDate(w.dates[0]);
    const end = parseDate(w.dates[1]);
    if (today >= start && today <= end) {
      return state.scheduleCache[w.value] || null;
    }
  }
  return null;
}

document.addEventListener('DOMContentLoaded', async () => {
  // Тема и акцент — применяем максимально рано, до рендера.
  applyTheme();
  applyAccent();
  setupAnimations();
  refreshIcons();

  setupSettingsModal();
  setupHomeworkModal();
  setupTgSection();
  setupInviteSection();
  setupAnnouncements();
  setupStartPage();

  // PWA: регистрация service worker (офлайн-шелл, см. frontend/sw.js).
  // Fire-and-forget: не блокирует загрузку. ВАЖНО: '?v=' держим синхронно
  // со SW_VERSION внутри sw.js и бампаем вместе с ним при изменении статики.
  // Query нужен потому, что зонный дефолт CF на кастомном домене перебивает
  // Cache-Control для .js (max-age=14400) — свежий URL после бампа обходит
  // и HTTP-кэш браузера, и edge-кэш Cloudflare.
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('/sw.js?v=v2').catch((e) => {
      console.warn('[sw] registration failed:', e.message);
    });
  }

  // Объявления глобальные (не зависят от группы) — фоновая проверка
  // непрочитанных для красной точки на колокольчике. Fire-and-forget:
  // не блокирует загрузку, работает и на стартовой странице без группы.
  refreshAnnouncementsBadge();

  // Если группы нет в localStorage — сразу показываем стартовую страницу,
  // чтобы не мелькало расписание группы по умолчанию из HTML, пока идут
  // сетевые проверки ?token=/?owner= ниже.
  const startPageShown = !state.group;
  if (startPageShown) showStartPage();

  // Одноразовая миграция старых токенов из localStorage в HttpOnly-cookie
  // (до перехода на куку токены жили в localStorage). Сервер сам поставит куку.
  migrateLegacyWriterTokens();

  // Если в URL есть ?token= или #invite= — это переход по ссылке-приглашению.
  // Валидируем через бэкенд, при успехе сервер ставит HttpOnly-cookie.
  await consumeInviteTokenFromUrl();

  // Если в URL есть ?owner= или #owner= — сразу пробуем стать владельцем
  // (альтернатива ручному вводу кода в настройках).
  await consumeOwnerCodeFromUrl();

  // Переход по #invite=/#owner= на уже открытой странице (например, клик по
  // ссылке в той же вкладке) НЕ перезагружает документ — DOMContentLoaded не
  // срабатывает, и токен остаётся непрочитанным. Обрабатываем hashchange.
  // После зачистки hash (replaceState) событие сработает ещё раз с пустым
  // hash — функции выйдут рано, рекурсии нет.
  window.addEventListener('hashchange', async () => {
    const before = state.group;
    const startShown = !document.getElementById('startPage').classList.contains('hidden');
    await consumeInviteTokenFromUrl();
    await consumeOwnerCodeFromUrl();
    // Группа могла прийти из ссылки-приглашения, пока пользователь сидел на
    // стартовой странице той же вкладки — дорисовываем то, что в init делает
    // код после consumeInviteTokenFromUrl().
    if (state.group !== before) {
      if (startShown) hideStartPage();
      await loadData();
      refreshEditVisibility();
    }
  });

  document.getElementById('syncBtn').onclick = () => {
    if (!isWriter()) {
      showToast('Только просмотр. Введите ссылку-приглашение в настройках, чтобы редактировать.', 'warn');
      return;
    }
    // Принудительная синхронизация — игнорируем свежесть campusUpdatedAt.
    syncAll(null, { forceSync: true });
  };

  // Если группы нет (нет в localStorage и не пришла из приглашения) —
  // остаёмся на стартовой странице с выбором группы.
  if (!state.group) {
    refreshEditVisibility();
    return;
  }

  // Группа могла прийти из ссылки-приглашения — убираем стартовую страницу.
  if (startPageShown) hideStartPage();

  loadData();
  refreshEditVisibility();
});

// Проверяет ?token= (или #invite=) в URL, валидирует, сохраняет writerToken
// per-group, чистит URL. Поддерживаются оба формата ссылок:
//   - старые/розданные (LEGACY):  /?token=<invToken>  (попадал в логи серверов)
//   - новые:                       /#invite=<invToken>  (hash не попадает в логи
//     серверов; генерируется только этот формат — см. copyInviteLink и
//     handleInviteCreate в воркере). Legacy-формат продолжает работать для уже
//     выданных ссылок, но при его использовании логируется console.warn.
async function consumeInviteTokenFromUrl() {
  let token = new URLSearchParams(location.search).get('token');
  let fromHash = false;
  if (!token) {
    const hashMatch = (location.hash || '').match(/^#invite=([^&]+)/);
    if (hashMatch) {
      try {
        token = decodeURIComponent(hashMatch[1]);
      } catch (_) {
        // Битая %-последовательность (например, #invite=%zz): URIError здесь
        // прервал бы стартовую цепочку init. Считаем, что ссылки нет.
        console.warn('[invite] некорректный #invite= в URL, ссылка проигнорирована');
        token = '';
      }
      fromHash = true;
    }
  }
  if (!token) return;

  // Legacy query-формат (?token=): уже распределённые ссылки продолжают
  // работать, но новые ссылки генерируются только в #-формате (#invite=).
  // Однократно логируем факт использования legacy-ссылки и передаём источник
  // на бэкенд (source: 'legacy') — воркер залогирует это в wrangler tail без
  // самого токена, чтобы владелец видел, какие группы ещё сидят на legacy и
  // что их ссылки пора отозвать и перевыпустить (легаси-токен уже мог попасть
  // в логи серверов/историю браузера до зачистки URL).
  if (!fromHash) {
    console.warn(
      '[deprecated] legacy ?token= link used; please migrate to #-format. ' +
      'Токен уже мог попасть в логи сервера/историю браузера — попросите владельца отозвать и перевыпустить ссылку.'
    );
  }

  // Чистим URL ДО сетевой верификации: токен не должен висеть в адресной
  // строке ни секунды (история браузера, скриншоты, логи расширений).
  if (fromHash) {
    history.replaceState(null, '', location.pathname + location.search);
  } else {
    clearUrlParams(['token']);
  }

  // Роль владельца живёт в HttpOnly-cookie, которую JS не видит, а
  // state.ownerRole восстанавливается только позже (restoreOwnerRole в
  // loadData). Запускаем лёгкую проверку /api/owner/status параллельно с
  // верификацией токена: владельцу не нужно перескакивать на группу из
  // приглашения, он остаётся на своей группе (и ролью владельца после
  // перезагрузки снова подтвердит кука).
  const ownerCheck = fetchTimeout(state.apiBase + '/api/owner/status', {
    headers: { 'Cache-Control': 'no-store' },
  })
    .then(r => r.json().catch(() => ({ isOwner: false })))
    .then(d => d.isOwner === true)
    .catch(() => false);

  try {
    const resp = await fetchTimeout(state.apiBase + '/api/invite/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, source: fromHash ? 'hash' : 'legacy' }),
    });
    const data = await resp.json();
    const isOwner = await ownerCheck;
    if (resp.ok && data.ok && data.group) {
      // Токен подтверждён — сервер поставил HttpOnly-cookie __Host-writer_tokens
      // (JS её не видит). Роль редактора для группы фиксируем в state.writerGroup;
      // в localStorage токен не кладём. ownerRole не трогаем — он глобальный.
      const group = data.group.toLowerCase();
      state.writerGroup = group;

      // Подставляем группу из приглашения — но только не владельцу: он не
      // должен переезжать на чужую группу, а после перезагрузки — тем более
      // «залипать» на ней редактором. Токен он всё равно получил и может
      // редактировать ту группу, выбрав её вручную.
      if (!isOwner) {
        state.group = group;
        localStorage.setItem('group', group);
      }

      showToast('Доступ на редактирование получен (' + data.group + ')', 'ok');
    } else {
      showToast('Ссылка-приглашение недействительна или отозвана', 'warn');
    }
  } catch (e) {
    showToast('Не удалось проверить ссылку: ' + e.message, 'warn');
  }
}

// Проверяет ?owner=<code> (или #owner=<code>) в URL, валидирует через бэкенд,
// сохраняет как owner-токен. Чистит URL. Возвращает true, если успешно стали owner.
// Поддерживаются оба формата:
//   - старые/розданные (LEGACY):  /?owner=<code>   (попадал в логи серверов)
//   - новые:                       /#owner=<code>   (hash не попадает в логи
//     серверов). Новые ссылки генерируются только в #-формате; legacy-формат
//     продолжает работать для уже выданных ссылок, но при его использовании
//     логируется console.warn.
async function consumeOwnerCodeFromUrl() {
  let code = (new URLSearchParams(location.search).get('owner') || '').trim();
  let fromHash = false;
  if (!code) {
    const hashMatch = (location.hash || '').match(/^#owner=([^&]+)/);
    if (hashMatch) {
      try {
        code = decodeURIComponent(hashMatch[1]).trim();
      } catch (_) {
        // Битая %-последовательность (например, #owner=%zz): URIError здесь
        // прервал бы стартовую цепочку init. Считаем, что ссылки нет.
        console.warn('[owner] некорректный #owner= в URL, ссылка проигнорирована');
        code = '';
      }
      fromHash = true;
    }
  }
  if (!code) return false;

  // Legacy query-формат (?owner=): уже распределённые ссылки продолжают
  // работать, но новые ссылки генерируются только в #-формате (#owner=).
  // Однократно логируем факт использования legacy-ссылки и передаём источник
  // на бэкенд (source: 'legacy') — воркер залогирует это в wrangler tail без
  // самого кода, чтобы владелец знал: legacy-код ещё используется, и его стоит
  // сменить/перевыпустить (легаси-код уже мог попасть в логи серверов/историю
  // браузера до зачистки URL).
  if (!fromHash) {
    console.warn(
      '[deprecated] legacy ?owner= link used; please migrate to #-format. ' +
      'Код владельца уже мог попасть в логи сервера/историю браузера — владельцу стоит сменить OWNER_CODE.'
    );
  }

  // Чистим URL ДО сетевой верификации, в любом случае (успех или нет —
  // код не должен висеть в адресной строке ни секунды).
  if (fromHash) {
    history.replaceState(null, '', location.pathname + location.search);
  } else {
    clearUrlParams(['owner']);
  }

  const ok = await becomeOwner(code, { silent: false, source: fromHash ? 'hash' : 'legacy' });
  return ok;
}

// Стать владельцем: отправляет код на /api/owner/login. Бэкенд вернёт ok,
// если code === env.OWNER_CODE, и поставит HttpOnly-cookie (код JS не виден).
// При успехе ownerRole=true. Возвращает Promise<boolean>.
// Опционально показывает toast (silent=false) — для авто-claim из ссылки.
async function becomeOwner(code, opts = {}) {
  const silent = opts.silent !== false; // по умолчанию показываем toast
  if (!code) return false;
  try {
    // opts.source ('hash'|'legacy') приходит из consumeOwnerCodeFromUrl и
    // передаётся на бэкенд для observability (воркер логирует legacy-использование
    // без самого кода). Ручной ввод кода в настройках source не задаёт —
    // поле в body просто отсутствует, API-поведение не меняется.
    const body = { code };
    if (opts.source) body.source = opts.source;
    const resp = await fetchTimeout(state.apiBase + '/api/owner/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await resp.json().catch(() => ({}));
    if (resp.ok && data.ok) {
      state.ownerRole = true;
      state.ownerCode = '';
      const section = document.getElementById('inviteSection');
      if (section) section.classList.add('is-owner');
      // Код уже не храним нигде, кроме серверной HttpOnly-cookie.
      showToast('Права владельца активированы', 'ok');
      refreshEditVisibility();
      if (setupInviteSection._loadInvites) setupInviteSection._loadInvites();
      return true;
    } else {
      if (!silent) showToast('Неверный код владельца', 'warn');
      return false;
    }
  } catch (e) {
    if (!silent) showToast('Ошибка активации владельца: ' + e.message, 'warn');
    return false;
  }
}

// Восстановление роли владельца после перезагрузки страницы. JS не видит
// HttpOnly-cookie __Host-owner_code, поэтому роль приходит с сервера через лёгкий
// /api/owner/status (без обращения к D1). Без этого вызова права owner
// пропадали бы при загрузке из тёплых клиентских кешей, когда /api/bootstrap
// не дёргается вовсе. При ошибке сети роль оставляем как есть — следующий
// bootstrap/действие всё равно вернёт актуальное значение.
async function restoreOwnerRole() {
  try {
    const resp = await fetchTimeout(state.apiBase + '/api/owner/status', {
      headers: { 'Cache-Control': 'no-store' },
    });
    const data = await resp.json().catch(() => ({}));
    const wasOwner = state.ownerRole;
    state.ownerRole = data.isOwner === true;
    if (state.ownerRole !== wasOwner) refreshEditVisibility();
  } catch (e) {
    console.warn('[restoreOwnerRole] network error:', e.message);
  }
}

// UI-гейтинг: показываем/прятаем элементы редактирования в зависимости от isWriter.
// Вызывается после загрузки и при изменении writerToken.
function refreshEditVisibility() {
  const writer = isWriter();
  // Кнопка «+ Добавить» в разделе ДЗ.
  const addBtn = document.getElementById('addHomeworkBtn');
  if (addBtn) addBtn.style.display = writer ? '' : 'none';

  // Кнопка синхронизации: для reader — прячем.
  const syncBtn = document.getElementById('syncBtn');
  if (syncBtn) syncBtn.style.display = writer ? '' : 'none';

  // Переключатель кампуса: для reader — прячем.
  const campusToggle = document.getElementById('campusToggle');
  if (campusToggle) {
    const toggleLabel = campusToggle.closest('label');
    if (toggleLabel) toggleLabel.style.display = writer ? '' : 'none';
  }

  // Перерисовка списка ДЗ (там есть кнопки выполнено/редактировать) — скроются через render.
  if (state.homework && state.homework.length) renderHomework();

  // Перерисовка текущего дня (кнопки + на парах скроются/появятся через render).
  refreshScheduleView();

  // Обновляем блок роли в настройках (на случай смены writer/owner).
  renderRoleStatus();
}

// Заполняет блок «Ваша роль» в настройках (роль больше не показывается в шапке).
// Для owner добавляет кнопку «Выйти из роли владельца» (сбрасывает HttpOnly-cookie).
function renderRoleStatus() {
  const el = document.getElementById('roleStatus');
  if (!el) return;
  let role, icon, cls, desc;
  if (isOwner()) {
    role = 'Владелец'; icon = 'crown'; cls = 'role-owner';
    desc = 'Полный доступ: редактирование, ссылки-приглашения.';
  } else if (isWriter()) {
    role = 'Редактор'; icon = 'pencil'; cls = 'role-writer';
    desc = 'Можно редактировать расписание и ДЗ.';
  } else {
    role = 'Только чтение'; icon = 'eye'; cls = 'role-reader';
    desc = 'Откройте ссылку-приглашение, чтобы редактировать.';
  }
  el.className = 'role-status ' + cls;
  el.innerHTML =
    '<svg class="role-icon"><use href="#icon-' + icon + '"></use></svg>' +
    '<div><div class="role-label">' + role + '</div>' +
    '<div class="role-desc">' + desc + '</div>' +
    (isOwner() ? '<button id="ownerLogoutBtn" class="btn-secondary role-action">Выйти из роли владельца</button>'
               : (isWriter() ? '<button id="writerLogoutBtn" class="btn-secondary role-action">Выйти из роли редактора</button>' : '')) +
    '</div>';
  const logoutBtn = el.querySelector('#ownerLogoutBtn');
  if (logoutBtn) {
    logoutBtn.onclick = async () => {
      try {
        await apiPost('/api/owner/logout', {});
      } catch (e) {
        console.warn('owner logout error:', e.message);
      }
      state.ownerRole = false;
      refreshEditVisibility();
    };
  }
  const writerLogoutBtn = el.querySelector('#writerLogoutBtn');
  if (writerLogoutBtn) {
    writerLogoutBtn.onclick = async () => {
      try {
        await apiPost('/api/writer/logout', { group: state.group });
      } catch (e) {
        console.warn('writer logout error:', e.message);
      }
      state.writerGroup = '';
      refreshEditVisibility();
    };
  }
  refreshIcons();
}

// ── Start Page (Google-style group picker) ─────────────────────
//
// Показывается, когда у пользователя нет сохранённой группы
// и нет ссылки-приглашения в URL. Стиль — как Google: по центру,
// поле ввода, кнопка.

function showStartPage() {
  document.getElementById('startPage').classList.remove('hidden');
  document.querySelector('.container').style.display = 'none';
  const input = document.getElementById('startGroupInput');
  input.value = state.group || '';
  input.focus();
}

function hideStartPage() {
  const el = document.getElementById('startPage');
  el.classList.add('fade-out');
  document.documentElement.classList.remove('no-group');
  document.querySelector('.container').style.display = '';
  setTimeout(() => {
    el.classList.add('hidden');
    el.classList.remove('fade-out');
  }, 300);
}

function setupStartPage() {
  const input = document.getElementById('startGroupInput');
  const btn = document.getElementById('startGroupBtn');
  const errEl = document.getElementById('startGroupError');

  function submitGroup() {
    const group = input.value.trim();
    if (!group) {
      errEl.textContent = 'Введите номер группы';
      errEl.classList.remove('hidden');
      input.focus();
      return;
    }
    if (!isValidGroup(group)) {
      errEl.textContent = 'Формат: 3 цифры, дефис, 3-4 буквы (напр. 131-ИБо)';
      errEl.classList.remove('hidden');
      input.focus();
      return;
    }
    errEl.classList.add('hidden');
    const normalizedGroup = group.toLowerCase();
    if (normalizedGroup !== state.group) resetSyncMetaForGroup();
    state.group = normalizedGroup;
    localStorage.setItem('group', normalizedGroup);
    applyGroupDisplay(normalizedGroup);
    hideStartPage();
    loadData();
    refreshEditVisibility();
  }

  btn.onclick = submitGroup;
  input.onkeydown = (e) => {
    if (e.key === 'Enter') submitGroup();
  };
}

// ── Main data loading ─────────────────────────────────────────
//
// Поведение:
//  1. При загрузке сайта берём из БД: предыдущую неделю, текущую и две следующих,
//     и сразу отрисовываем (БД — источник первым делом, кампус НЕ блокирует экран).
//     Параллельно (если campusEnabled) в фоне запускается полная логика синхронизации
//     как по кнопке синхронизации: check-campus-update, при изменении — текущая + 5 недель вперёд
//     из кампуса, запись в БД, пересчёт ДЗ. Экран обновляется, только если данные
//     реально изменились. Если в БД пусто (первый визит) — кампус используется как
//     запасной источник (синхронизация выполняется ожидаемо, не в фоне).
//  2. loadSchedule(idx) — переключение недели. Назад → из БД, при отсутствии из кампуса.
//     Вперёд > 2 недель от текущей → из БД + фоне кампус-обновление.
//  3. syncAll() — кнопка обновления. Якорь = неделя пользователя, но не раньше
//     реальной текущей (max(currentWeekIdx, realCurrentIdx)). Качает якорь +
//     5 недель вперёд из кампуса (при изменении по check-campus-update). Неделю не меняем.

async function loadData() {
  try {
    // Роль владельца живёт только в HttpOnly-cookie, которую JS не видит.
    // Восстанавливаем её отдельным лёгким запросом: при тёплых клиентских
    // кешах /api/bootstrap не вызывается, и без этого права owner после
    // перезагрузки страницы пропадали бы.
    await restoreOwnerRole();
    // Роль редактора — тоже в HttpOnly-cookie (__Host-writer_tokens).
    // Восстанавливаем аналогично: /api/writer/status читает куку на сервере.
    await refreshWriterStatus();
    state.scheduleCache = {};
    applyGroupDisplay(state.group);

    // 0) Пробуем загрузить всё одним запросом /api/bootstrap (weeks +
    //    schedules + hw + subjects + campusUpdatedAt) — экономия 3-4
    //    вызовов воркера при холодном старте. Сначала из клиентских кешей:
    //    если есть свежие hw/subjects и кеш расписаний — берём их и вообще
    //    не дёргаем воркер синхронно, идём сразу к отрисовке. Фон всё равно
    //    досинхронизирует через syncAll.
    const cachedWeeks = loadWeeksFromCache();
    const cachedSched = loadSchedFromCache();
    const cachedHw = loadHwFromCache();
    const cachedSubj = loadSubjectsFromCache();

    let usedCacheOnly = false;
    if (cachedWeeks && cachedWeeks.length && cachedWeeks.every((w) => w.dates && w.dates.length >= 2)) {
      // Есть недели в кеше — рендерим сразу. Помечаем их свежими, чтобы
      // syncAll не дёргал syncWeeksFromCampus повторно в этом же сеансе.
      state.weeks = cachedWeeks;
      markWeeksFresh();
      if (cachedSched) {
        for (const w of state.weeks) {
          if (cachedSched[w.value]) state.scheduleCache[w.value] = cachedSched[w.value];
        }
      }
      if (cachedHw) state.homework = cachedHw;
      if (cachedSubj) setLoadedSubjects(cachedSubj);

      findCurrentWeek();
      renderWeekNav();

      // Если расписания/ДЗ/предметов в кеше достаточно — сразу рисуем и
      // в фоне подсасываем syncAll; синхронного запроса к воркеру нет.
      if (cachedSched && cachedHw && cachedSubj) {
        await loadInitialSchedules();
        recalcNextPairDates();
        renderHomework();
        usedCacheOnly = true;
      } else {
        // Кеш недель есть, но остальное протухло — подгрузим одним
        // /api/bootstrap без weeks (их уже взяли из кеша).
        await bootstrapFromApi({
          weeks: false,
          schedWeeks: getInitialWeekIndices().map((i) => state.weeks[i].value).filter(Boolean),
        });
        findCurrentWeek();
        renderWeekNav();
        await loadInitialSchedules();
        recalcNextPairDates();
      }
    } else {
      // Холодный старт: weeks в кеше пусты. Сначала bootstrap с weeks=true,
      // затем (когда state.weeks заполнен) дозагрузим schedules тем же
      // /api/bootstrap (weeks:false) одним запросом. Это два вызова вместо
      // четырёх (weeks + schedules + hw + subjects по отдельности).
      await bootstrapFromApi({ weeks: true, schedWeeks: [] });
      if (state.weeks.length === 0 && state.campusEnabled) {
        // БД пуста — тянем недели из кампуса. Если campus недоступен —
        // не крашим loadData, а дойдём до «Нет данных» ниже.
        try {
          await syncWeeksFromCampus(true);
        } catch (e) {
          console.warn('[loadData] syncWeeksFromCampus failed:', e.message);
        }
      }
      if (state.weeks.length === 0) {
        showError(
          isWriter() ? 'Нет данных о неделях. Включите загрузку из кампуса в настройках и нажмите кнопку синхронизации.'
                     : 'Нет данных о неделях. Попросите редактора группы синхронизировать данные.',
          isWriter() ? () => syncAll(null, { forceSync: true }) : null
        );
        return;
      }
      // Теперь недели известны — дозагружаем стартовые расписания.
      findCurrentWeek();
      renderWeekNav();
      const schedWeeks = getInitialWeekIndices().map((i) => state.weeks[i].value).filter(Boolean);
      if (schedWeeks.length > 0) {
        await bootstrapFromApi({ weeks: false, schedWeeks });
      }
      await loadInitialSchedules();
      recalcNextPairDates();
    }

    if (state.campusEnabled && isWriter()) {
      // Фон: полноценная синхронизация как по кнопке синхронизации. При свежих данных
      // (campusUpdatedAt < 5 мин) ранний выход в syncAll. Недели не трогаем,
      // если только что их обновили через bootstrap (markWeeksFresh).
      const cur = findRealCurrentIdx();
      syncAll(cur).catch((e) => console.warn('[openSync] error:', e.message));
    }
  } catch (e) {
    showError(
      'Не удалось загрузить данные: ' + e.message,
      isWriter() ? () => syncAll(null, { forceSync: true }) : null
    );
  }
}

// /api/bootstrap — один запрос вместо 4 (weeks + schedules + hw + subjects).
// Опции:
//   opts.weeks      — тянуть weeks (true/false). Если false — только schedules/hw/subjects.
//   opts.schedWeeks — массив weekCode для расписаний. Если пусто — пропускаем schedules.
// При неудаче (старый воркер без эндпоинта или 500) — графтов на старую
// схему: loadWeeks + /api/schedules + /api/hw + /api/subjects отдельными
// запросами. Это гарантирует совместимость со старой версией воркера.
async function bootstrapFromApi(opts = {}) {
  const wantWeeks = opts.weeks !== false;
  const schedWeeks = Array.isArray(opts.schedWeeks) ? opts.schedWeeks.filter(Boolean) : [];

  try {
    const params = { group: state.group };
    if (schedWeeks.length > 0) params.weeks = schedWeeks.join(',');
    const data = await apiFetch('/api/bootstrap', params);

    // Роль владельца восстанавливается из HttpOnly-cookie: воркер сам сверяет
    // cookie и отдаёт isOwner. JS код владельца не видит и не хранит.
    const wasOwner = state.ownerRole;
    state.ownerRole = data.isOwner === true;
    if (state.ownerRole !== wasOwner) refreshEditVisibility();

    if (wantWeeks && Array.isArray(data.weeks) && data.weeks.length) {
      state.weeks = data.weeks;
      saveWeeksToCache(data.weeks);
      markWeeksFresh();
    }
    if (data.schedules && typeof data.schedules === 'object') {
      for (const w of state.weeks) {
        if (data.schedules[w.value]) state.scheduleCache[w.value] = data.schedules[w.value];
      }
      saveSchedToCache(state.scheduleCache);
    }
    if (Array.isArray(data.hw)) {
      state.homework = data.hw;
      renderHomework();
      saveHwToCache(data.hw);
    }
    if (Array.isArray(data.subjects)) {
      setLoadedSubjects(data.subjects);
      saveSubjectsToCache(data.subjects);
    }
    if (typeof data.campusUpdatedAt === 'string' && data.campusUpdatedAt) {
      state.campusUpdatedAt = data.campusUpdatedAt;
      localStorage.setItem('campusUpdatedAt', state.campusUpdatedAt);
    }
    return true;
  } catch (e) {
    console.warn('[bootstrap] failed, falling back to legacy load:', e.message);
    await bootstrapLegacyFallback(opts);
    return false;
  }
}

// Graphт на старую схему: 4 отдельных запроса. Используется если воркер
// без /api/bootstrap (старая версия) или вернул 404/500.
async function bootstrapLegacyFallback(opts = {}) {
  const wantWeeks = opts.weeks !== false;
  const schedWeeks = Array.isArray(opts.schedWeeks) ? opts.schedWeeks.filter(Boolean) : [];

  if (wantWeeks && state.weeks.length === 0) {
    try {
      state.weeks = await apiFetch('/api/weeks', { group: state.group });
      if (state.weeks && state.weeks.length) saveWeeksToCache(state.weeks);
    } catch (e) {
      state.weeks = [];
    }
  }

  if (schedWeeks.length > 0) {
    try {
      const dbMap = await apiFetch('/api/schedules', { group: state.group, weeks: schedWeeks.join(',') });
      for (const w of state.weeks) {
        if (dbMap && dbMap[w.value]) state.scheduleCache[w.value] = dbMap[w.value];
      }
      saveSchedToCache(state.scheduleCache);
    } catch (e) {
      console.warn('[fallback] /api/schedules failed:', e.message);
    }
  }

  try {
    state.homework = await apiFetch('/api/hw', { group: state.group });
    renderHomework();
    saveHwToCache(state.homework);
  } catch (e) {
    console.warn('[fallback] /api/hw failed:', e.message);
    state.homework = [];
  }

  try {
    const res = await apiFetch('/api/subjects', { group: state.group });
    setLoadedSubjects(res.subjects);
    saveSubjectsToCache(loadedSubjects);
  } catch (e) {
    loadedSubjects = [];
  }
}

// Помечает «weeks свежие» на 60 секунд — чтобы syncAll не дёргал
// syncWeeksFromCampus повторно сразу после bootstrap/refreshWeeksFromApi.
function markWeeksFresh() {
  state.weeksFreshUntil = Date.now() + 60 * 1000;
}
function isWeeksFresh() {
  return state.weeksFreshUntil && Date.now() < state.weeksFreshUntil;
}

// Список недель, которые надо загрузить с кампуса/из БД при первом открытии:
// от (currentIdx-1) до (currentIdx+2) включительно.
function getInitialWeekIndices() {
  const cur = findRealCurrentIdx();
  const from = Math.max(0, cur - 1);
  const to = Math.min(state.weeks.length - 1, cur + 2);
  const result = [];
  for (let i = from; i <= to; i++) result.push(i);
  return result;
}

// Скелетон-заглушка для контейнера расписания: серые блоки в форме
// «заголовок дня + карточки пар» вместо текста «Загрузка расписания...».
// aria-hidden прячет визуальные блоки от скринридеров — для них оставлен
// скрытый текст с role="status" (полит-анонс о начале загрузки).
function skeletonScheduleHTML() {
  const card = (subjW, lineW) => `
    <div class="skeleton-card" aria-hidden="true">
      <div class="skeleton-row">
        <span class="skeleton skeleton-w20 skeleton-h16"></span>
        <span class="skeleton skeleton-w35 skeleton-h16"></span>
      </div>
      <span class="skeleton ${subjW} skeleton-h16"></span>
      <div class="skeleton-row">
        <span class="skeleton ${lineW} skeleton-h12"></span>
      </div>
    </div>`;
  return `
    <div class="schedule-skeleton">
      <span class="visually-hidden" role="status">Загрузка расписания...</span>
      <div class="skeleton skeleton-day" aria-hidden="true"></div>
      ${card('skeleton-w60', 'skeleton-w45')}
      ${card('skeleton-w55', 'skeleton-w40')}
      ${card('skeleton-w65', 'skeleton-w35')}
    </div>`;
}

// Загрузка исходных расписаний (БД + фоне синхронизация) при открытии страницы.
// БД — источник отрисовки «первым и немедленным»: экран показываем сразу из
// кэша/БД. Кампус никогда не блокирует отрисовку: синхронизацию запускает
// loadData() после этой функции; здесь только отрисовываем из того, что
// уже есть в state.scheduleCache (заполненном через /api/bootstrap или кеш).
async function loadInitialSchedules() {
  const indices = getInitialWeekIndices();
  if (indices.length === 0) return;

  const content = document.getElementById('scheduleContent');
  content.innerHTML = skeletonScheduleHTML();

  // Если все стартовые недели уже в кеше (от bootstrap или предыдущего
  // открытия) — сохраняем кеш и сразу рисуем. Никакого запроса к воркеру.
  const missing = indices.filter((i) => !state.scheduleCache[state.weeks[i].value]);
  if (missing.length > 0) {
    // Только для недостающих — один /api/schedules. Если все на месте —
    // этот запрос пропускается полностью.
    try {
      const weeksParam = missing.map((i) => state.weeks[i].value).join(',');
      const dbMap = await apiFetch('/api/schedules', { group: state.group, weeks: weeksParam });
      for (const w of state.weeks) {
        if (dbMap && dbMap[w.value]) state.scheduleCache[w.value] = dbMap[w.value];
      }
      saveSchedToCache(state.scheduleCache);
    } catch (e) {
      console.warn('[loadInitial] /api/schedules failed:', e.message);
    }
  } else {
    console.log('[loadInitial] all weeks in cache — skipping /api/schedules');
    saveSchedToCache(state.scheduleCache);
  }

  // Отрисовываем из кэша/БД сразу, НЕ дожидаясь кампуса.
  const cur = findRealCurrentIdx();
  state.currentWeekIdx = cur;

  // Если реальной текущей недели нет ни в БД, ни в кеше — качаем её с кампуса,
  // чтобы остаться на текущей неделе. Если кампус недоступен или неделя пустая —
  // остаёмся на текущей неделе с надписью «нет данных» (без перекидывания на другую).
  const curWeek = state.weeks[cur];
  if (curWeek && !state.scheduleCache[curWeek.value] && state.campusEnabled) {
    try {
      const campusData = await fetchScheduleFromCampus(state.group, curWeek.value);
      const hasPairs = campusData.days && Object.values(campusData.days).some(d => d.pairs && d.pairs.length > 0);
      if (hasPairs) {
        // Пишем в БД только если есть права writer — reader не должен ловить 403.
        if (isWriter()) {
          await uploadSchedulesToBackend([{ weekCode: curWeek.value, data: campusData }]);
        }
        state.scheduleCache[curWeek.value] = campusData;
        saveSchedToCache(state.scheduleCache);
        state.schedule = campusData;
        applyScheduleHeader();
        renderWeekNav();
        renderDayTabs();
        return;
      }
    } catch (e) {
      console.warn('[loadInitial] campus fetch failed:', e.message);
    }
  }

  function renderFromCache() {
    const curWeek = state.weeks[state.currentWeekIdx];
    if (curWeek && state.scheduleCache[curWeek.value]) {
      state.schedule = state.scheduleCache[curWeek.value];
      applyScheduleHeader();
      renderDayTabs();
      return true;
    }
    // Никогда не перекидываем пользователя на другую неделю: остаёмся на текущей,
    // а «нет данных» рисуется ниже (сохранённая текущая неделя + надпись).
    return false;
  }

  const renderedFromDb = renderFromCache();

  if (!renderedFromDb) {
    state.schedule = { group: state.group, weekStart: '', weekEnd: '', days: {} };
    state.selectedDay = null;
    document.getElementById('dayTabs').innerHTML = '';
    content.innerHTML = '<div class="no-pairs">Нет данных для этой недели. Нажмите кнопку синхронизации в шапке.</div>';
    applyScheduleHeader();
  }

  // Синхронизацию кампуса (syncAll) запускает loadData() — в одном месте,
  // чтобы не дублировать вызовы. Здесь только отрисовка из того, что есть.
}

// Фоновая синхронизация: скачивает из кампуса недели по списку индексов,
// сравнивает с тем, что уже есть в dbMap (если есть), и при наличии изменений
// загружает в БД. Если текущая на экране неделя обновилась — перерисуем её.
async function backgroundSync(campusIndices, dbMap) {
  if (!state.campusEnabled || campusIndices.length === 0) return;

  try {
    const fetched = await Promise.all(
      campusIndices.map(async (i) => {
        try {
          const data = await fetchScheduleFromCampus(state.group, state.weeks[i].value);
          const hasPairs = data.days && Object.values(data.days).some(d => d.pairs && d.pairs.length > 0);
          if (!hasPairs) return null;
          return { idx: i, weekCode: state.weeks[i].value, data };
        } catch (e) {
          console.warn('[bgSync] failed', state.weeks[i]?.value, e.message);
          return null;
        }
      })
    );

    const valid = fetched.filter(Boolean);
    if (valid.length === 0) return;
    for (const v of valid) state.scheduleCache[v.weekCode] = v.data;

    // Загружаем в БД только изменённые/отсутствующие
    const toUpload = [];
    for (const v of valid) {
      const existing = dbMap ? dbMap.get(v.idx) : null;
      if (!existing || JSON.stringify(stripComparable(existing)) !== JSON.stringify(stripComparable(v.data))) {
        toUpload.push({ weekCode: v.weekCode, data: v.data });
      }
    }

    if (toUpload.length > 0) {
      await uploadSchedulesToBackend(toUpload);
      console.log('[bgSync] uploaded', toUpload.length, 'weeks');
    }

    // Если текущая открытая неделя изменилась — перерисуем
    const currentWeek = state.weeks[state.currentWeekIdx];
    const match = currentWeek && valid.find(v => v.weekCode === currentWeek.value);
    if (match) {
      state.schedule = match.data;
      state.scheduleCache[match.weekCode] = match.data;
      applyScheduleHeader();
      renderDayTabs();
    }
  } catch (e) {
    console.warn('[bgSync] error:', e.message);
  }
}

// Загрузка расписания для произвольной недели (при навигации).
//  - Назад: из БД; если нет — из кампуса и пишем в БД.
//  - Вперёд, дальше чем на +2 от текущей: из БД, параллельно обновляем из кампуса.
//  - Вперёд в пределах текущая/+2: эти недели уже должны быть загружены из БД
//    при открытии; если по какой-то причине нет — берём из кампуса и пишем в БД.
// Счётчик поколений запросов loadSchedule: защита от гонки при быстром
// перелистывании. Каждый вызов захватывает reqSeq; после каждого await
// проверяем isStale() — если пользователь уже переключил неделю дальше,
// устаревший запрос отменяет отрисовку, чтобы не перезаписать экран.
let scheduleReqSeq = 0;

async function loadSchedule(targetIdx, direction) {
  if (targetIdx < 0 || targetIdx >= state.weeks.length) return;
  const reqSeq = ++scheduleReqSeq;
  const isStale = () => reqSeq !== scheduleReqSeq;
  state.currentWeekIdx = targetIdx;
  // Направление для анимации сдвига: 'next' (вправо) / 'prev' (влево).
  if (direction) animateSchedule(direction);

  const w = state.weeks[targetIdx];

  // 1) Сначала смотрим в кэш (недели, загруженные при открытии / прошлых
  //    перелистываниях). Если есть — рисуем мгновенно, БЕЗ спиннера и БЕЗ
  //    лишнего запроса к БД. Фоновая подгрузка соседних недель — чтобы
  //    следующее перелистывание тоже было мгновенным.
  const cached = state.scheduleCache[w.value];
  if (cached) {
    state.schedule = cached;
    applyScheduleHeader();
    renderDayTabs();

    // Префетч соседних неделей из БД (фон, без блокировки экрана):
    // подкачаем по 2 недели в обе стороны от текущей, если их нет в кеше.
    prefetchNearbyWeeks(targetIdx);

    const cur = findRealCurrentIdx();
    const distance = targetIdx - cur;

    // Вперёд дальше +2 от текущей → фоне тянем из кампуса и обновляем БД при изменениях
    if (distance > 2 && state.campusEnabled) {
      backgroundSyncSingle(targetIdx, cached);
    }
    return;
  }

  const content = document.getElementById('scheduleContent');
  content.innerHTML = skeletonScheduleHTML();

  // 2) Нет в кэше → из БД. Запрашиваем сразу 3 недели одной /api/schedules
  //    (текущую + ±1), чтобы следующее перелистывание уже было в кеше.
  //    Один RTT вместо потенциально трёх.
  let dbData = null;
  try {
    const wantIdx = [targetIdx - 1, targetIdx, targetIdx + 1]
      .filter((i) => i >= 0 && i < state.weeks.length && !state.scheduleCache[state.weeks[i].value]);
    if (wantIdx.length === 0) {
      // На всякий случай: целевой недели нет в кеше, но соседние все есть и
      // способ не нашёл индекс — запросим одну целевую.
      wantIdx.push(targetIdx);
    }
    const weeksParam = wantIdx.map((i) => state.weeks[i].value).join(',');
    const dbMap = await apiFetch('/api/schedules', { group: state.group, weeks: weeksParam });
    if (dbMap) {
      for (const i of wantIdx) {
        const wv = state.weeks[i].value;
        if (dbMap[wv]) state.scheduleCache[wv] = dbMap[wv];
      }
      dbData = state.scheduleCache[w.value];
      saveSchedToCache(state.scheduleCache);
    }
  } catch (e) {
    dbData = null;
  }

  // Пока ждали /api/schedules, пользователь мог переключить неделю дальше —
  // тогда устаревший запрос не должен рисовать свой результат.
  if (isStale()) return;

  if (dbData) {
    state.schedule = dbData;
    applyScheduleHeader();
    renderDayTabs();

    const cur = findRealCurrentIdx();
    const distance = targetIdx - cur;

    // Вперёд дальше +2 от текущей → фоне тянем из кампуса и обновляем БД при изменениях
    if (distance > 2 && state.campusEnabled) {
      backgroundSyncSingle(targetIdx, dbData);
    }
    return;
  }

  // 3) Нет в БД → из кампуса, пишем в БД.
  if (state.campusEnabled) {
    try {
      const campusData = await fetchScheduleFromCampus(state.group, w.value);
      const hasPairs = campusData.days && Object.values(campusData.days).some(d => d.pairs && d.pairs.length > 0);
      if (hasPairs) {
        await uploadSchedulesToBackend([{ weekCode: w.value, data: campusData }]);
      }
      state.scheduleCache[w.value] = campusData;
      saveSchedToCache(state.scheduleCache);
      // Пока тянули кампус, неделя могла смениться — не рисуем устаревшее.
      if (isStale()) return;
      state.schedule = campusData;
      applyScheduleHeader();
      renderDayTabs();
      return;
    } catch (e) {
      console.warn('Campus unavailable:', e.message);
    }
  }

  // Пока шли кампусные запросы, неделя могла смениться — устаревший запрос
  // не должен выводить «Нет данных» поверх уже отрисованной другой недели.
  if (isStale()) return;

  state.schedule = { group: state.group, weekStart: '', weekEnd: '', days: {} };
  state.selectedDay = null;
  document.getElementById('dayTabs').innerHTML = '';
  content.innerHTML = '<div class="no-pairs">Нет данных для этой недели.</div>';
  applyScheduleHeader();
}

// Фоновая подгрузка соседних недель из БД одним /api/schedules, чтобы
// следующее перелистывание было мгновенным (0 запросов). Качаем по 2
// недели в обе стороны от текущей, для которых НЕТ кеша. fire-and-forget.
async function prefetchNearbyWeeks(centerIdx) {
  try {
    const wantIdx = [];
    for (let off = -2; off <= 2; off++) {
      const i = centerIdx + off;
      if (i < 0 || i >= state.weeks.length) continue;
      if (state.scheduleCache[state.weeks[i].value]) continue;
      wantIdx.push(i);
    }
    if (wantIdx.length === 0) return;
    const weeksParam = wantIdx.map((i) => state.weeks[i].value).join(',');
    const dbMap = await apiFetch('/api/schedules', { group: state.group, weeks: weeksParam });
    if (!dbMap) return;
    for (const i of wantIdx) {
      const wv = state.weeks[i].value;
      if (dbMap[wv]) state.scheduleCache[wv] = dbMap[wv];
    }
    saveSchedToCache(state.scheduleCache);
  } catch (e) {
    console.warn('[prefetch] failed:', e.message);
  }
}

// Фоновое обновление одной недели из кампуса (для случая «идём вперёд дальше +2»).
async function backgroundSyncSingle(idx, dbData) {
  if (!state.campusEnabled) return;
  try {
    const w = state.weeks[idx];
    const data = await fetchScheduleFromCampus(state.group, w.value);
    const hasPairs = data.days && Object.values(data.days).some(d => d.pairs && d.pairs.length > 0);
    if (!hasPairs) return;

    const changed = !dbData || JSON.stringify(stripComparable(dbData)) !== JSON.stringify(stripComparable(data));
    if (changed) {
      if (isWriter()) {
        await uploadSchedulesToBackend([{ weekCode: w.value, data }]);
      }
      // loadHomework()/loadSubjects() НЕ нужны: ДЗ и предметы группы не
      // зависят от конкретной недели, а их списки уже загружены в state.
      // Экономия 2 вызовов воркера при каждом прокруте вперёд > +2 недель.
      recalcNextPairDates();
    }

    // Если пользователь всё ещё на этой неделе — обновим экран
    if (state.weeks[state.currentWeekIdx] && state.weeks[state.currentWeekIdx].value === w.value) {
      state.schedule = data;
      state.scheduleCache[w.value] = data;
      applyScheduleHeader();
      renderDayTabs();
    }
  } catch (e) {
    console.warn('[bgSyncSingle] error:', e.message);
  }
}

// Обновляет отображение группы: заголовок в шапке + title страницы.
function applyGroupDisplay(groupName) {
  document.getElementById('groupName').textContent = groupName || state.group;
  document.title = 'kampussgu — ' + (groupName || state.group);
}

function applyScheduleHeader() {
  const displayGroup = (state.schedule && state.schedule.group) || state.group;
  applyGroupDisplay(displayGroup);
  if (state.schedule && state.schedule.weekStart) {
    document.getElementById('weekRange').textContent =
      state.schedule.weekStart + ' — ' + state.schedule.weekEnd;
  } else {
    document.getElementById('weekRange').textContent = '';
  }
}

// ── Sync Meta (для блока в настройках) ────────────────────────

function saveSyncMeta(campusUpdatedAt) {
  const now = new Date();
  state.lastSyncAt = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}T${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}:${String(now.getSeconds()).padStart(2,'0')}`;
  if (campusUpdatedAt) state.campusUpdatedAt = campusUpdatedAt;
  localStorage.setItem('lastSyncAt', state.lastSyncAt);
  localStorage.setItem('campusUpdatedAt', state.campusUpdatedAt);
}

// Сброс меты синхронизации при смене группы: даты старой группы не должны
// отображаться для новой, пока она не синхронизировалась (и не подтянулась
// свежая мета из /api/status либо bootstrap).
function resetSyncMetaForGroup() {
  state.lastSyncAt = '';
  state.campusUpdatedAt = '';
  localStorage.removeItem('lastSyncAt');
  localStorage.removeItem('campusUpdatedAt');
  const ls = document.getElementById('lastSyncInfo');
  if (ls) ls.textContent = '—';
  const cu = document.getElementById('campusUpdatedInfo');
  if (cu) cu.textContent = '—';
}

// ── Sync (кнопка обновления) ──────────────────────────────────
//
// Новый поток (логика перенесена на бэкенд-проверку):
//  1. Якорь синхронизации = неделя пользователя (state.currentWeekIdx),
//     но не раньше реальной текущей календарной недели
//     (anchorIdx = max(currentWeekIdx, realCurrentIdx)). Для авто-открытия
//     передаётся override = реальная текущая, чтобы не зависеть от renderFromCache.
//  2. Качаем с кампуса HTML недели-якоря, параллельно парсим её и
//     извлекаем campusUpdatedAt («Расписание обновлено ...»).
//  3. Шлём POST /api/check-campus-update { group, campusUpdatedAt }.
//     - needUpdate:false → расписание уже актуально, стоп.
//     - needUpdate:true  → качаем с кампуса ещё 5 недель вперёд от якоря
//       (параллельно), парсим, шлём всё одним батчем на /api/sync-from-campus.
//     Бэкенд сам сохраняет, обновляет предметы/ДЗ, записывает дату.
//  Пользователь НЕ перемещается на другую неделю.

async function syncAll(anchorIdxOverride = null, opts = {}) {
  // opts.forceSync = true → игнорируем свежесть campusUpdatedAt. Используется
  // при явном клике на кнопку синхронизации. При авто-открытии страницы (forceSync=false) —
  // пропускаем все запросы, если campusUpdatedAt свежее 5 минут (экономия
  // 2 вызовов воркера: check-campus-update + sync-from-campus).
  const forceSync = !!opts.forceSync;
  if (state.syncing) return;
  if (!state.campusEnabled) {
    updateSyncUI('error', 'Загрузка из кампуса отключена в настройках');
    return;
  }

  // Ранний выход для авто-синхронизации при свежих данных. campusUpdatedAt
  // — это timestamp последнего изменения кампуса (см. extractCampusUpdatedAt).
  // Если он свежее CAMPUS_UPDATED_FRESH_MS —Faculty не имеет смысла дёргать.
  const CAMPUS_UPDATED_FRESH_MS = 5 * 60 * 1000; // 5 минут
  if (!forceSync) {
    const ts = parseCampusUpdatedAtTs(state.campusUpdatedAt);
    if (ts && (Date.now() - ts) < CAMPUS_UPDATED_FRESH_MS) {
      console.log('[syncAll] skip — campusUpdatedAt is fresh (', state.campusUpdatedAt, ')');
      updateSyncUI('ok');
      return;
    }
  }

  // Лёгкий шорткат для forceSync=true (наминация синхронизации): если campusUpdatedAt
  // свежий, всё равно спрашиваем бэкенд, но не качаем неделю-якорь из кампуса
  // и не делаем syncWeeksFromCampus — экономия 6+ campus-запросов. Бэкенд сам
  // скажет needUpdate, если что-то поменялось снаружи нашего кеша.
  const tsFresh = parseCampusUpdatedAtTs(state.campusUpdatedAt);
  const campusFresh = tsFresh && (Date.now() - tsFresh) < CAMPUS_UPDATED_FRESH_MS;

  state.syncing = true;
  updateSyncUI('syncing');

  // Сохраняем выбранную неделю, чтобы остаться на ней
  const savedWeekValue = state.weeks[state.currentWeekIdx]?.value;
  let savedIdx = state.currentWeekIdx;

  try {
    // Обновляем список недель, сохраняя выбор. Пропускаем, если недели
    // только что освежены (bootstrap или syncWeeksFromCampus) — экономия
    // одного campus-запроса + /api/upload.
    if (!isWeeksFresh()) {
      await syncWeeksFromCampus(true);
    } else {
      console.log('[syncAll] weeks are fresh — skipping syncWeeksFromCampus');
    }

    if (savedWeekValue) {
      const idx = state.weeks.findIndex(w => w.value === savedWeekValue);
      if (idx >= 0) savedIdx = idx;
      state.currentWeekIdx = savedIdx;
    }
    renderWeekNav();

    const realCurrentIdx = findRealCurrentIdx();

    // Якорь синхронизации: для кнопки — неделя пользователя, но не раньше
    // реальной текущей; для авто-открытия передаётся override = реальная
    // текущая, чтобы не зависеть от того, на какую неделю переключил renderFromCache.
    const anchorIdx = anchorIdxOverride != null
      ? anchorIdxOverride
      : Math.max(state.currentWeekIdx, realCurrentIdx);

    // 1) Качаем неделю-якорь, парсим + извлекаем campusUpdatedAt.
    //    Если campusUpdatedAt по нашему кешу свежий (forceSync= true <5 мин),
    //    пропускаем этот campus-запрос и сразу спрашиваем бэкенд (который
    //    сравнит с тем, что он знает). Бэкенд скажет needUpdate, если что-то
    //    реально поменялось — тогда и пойдём на campus.
    const currentWeekCode = state.weeks[anchorIdx]?.value;
    if (!currentWeekCode) {
      throw new Error('Не удалось определить текущую неделю');
    }

    let currentData = state.scheduleCache[currentWeekCode] || null;
    let campusUpdatedAt = state.campusUpdatedAt || '';

    if (!campusFresh) {
      currentData = await fetchScheduleFromCampus(state.group, currentWeekCode);
      campusUpdatedAt = currentData.campusUpdatedAt || '';
      state.scheduleCache[currentWeekCode] = currentData;
    } else {
      console.log('[syncAll] campusUpdatedAt fresh — skipping anchor fetch from campus');
    }

    // 2) Спрашиваем бэкенд, нужно ли обновление
    const check = await apiPost('/api/check-campus-update', {
      group: state.group,
      campusUpdatedAt,
    });

    if (!check.needUpdate) {
      // Расписание уже актуально. Обновляем только экран текущей недели.
      const currentWeek = state.weeks[state.currentWeekIdx];
      if (currentWeek && currentWeek.value === currentWeekCode && currentData) {
        state.schedule = currentData;
        state.scheduleCache[currentWeekCode] = currentData;
        applyScheduleHeader();
        renderDayTabs();
      }
      saveSyncMeta(campusUpdatedAt);
      updateSyncUI('ok');
      return;
    }

    // 3) Нужно обновление: качаем якорь (если ещё не качали в этом вызове)
    //    и +5 недель вперёд от якоря (параллельно).
    if (!currentData) {
      currentData = await fetchScheduleFromCampus(state.group, currentWeekCode);
      campusUpdatedAt = currentData.campusUpdatedAt || campusUpdatedAt;
      state.scheduleCache[currentWeekCode] = currentData;
    }
    const extraIndices = collectForwardRange(anchorIdx + 1, 4);
    const extraResults = await Promise.all(
      extraIndices.map(async (i) => {
        try {
          const w = state.weeks[i];
          const data = await fetchScheduleFromCampus(state.group, w.value);
          return { weekCode: w.value, data };
        } catch (e) {
          console.warn(`Failed to fetch week ${state.weeks[i]?.value}:`, e.message);
          return null;
        }
      })
    );

    const validExtra = extraResults.filter(Boolean);
    for (const s of validExtra) state.scheduleCache[s.weekCode] = s.data;

    // Собираем полный батч: якорь + 5 следующих
    const schedules = [{ weekCode: currentWeekCode, data: currentData }, ...validExtra];

    // 4) Шлём батч на бэкенд, он сам сохраняет и обновляет ДЗ/предметы
    const syncRes = await apiPost('/api/sync-from-campus', {
      group: state.group,
      campusUpdatedAt,
      schedules,
    });

    // Используем обновлённые списки сразу из ответа бэкенда — отдельные
    // запросы /api/hw и /api/subjects НЕ нужны (экономия 2 вызова воркера
    // после каждой успешной синхронизации).
    const hwProvided = Array.isArray(syncRes.hw);
    const subjectsProvided = Array.isArray(syncRes.subjects);
    if (hwProvided) {
      state.homework = syncRes.hw;
      renderHomework();
      saveHwToCache(syncRes.hw); // свежий список ДЗ в клиентский кеш
    }
    if (subjectsProvided) {
      setLoadedSubjects(syncRes.subjects);
      saveSubjectsToCache(loadedSubjects); // свежий список предметов
    }

    // Обновляем экран той недели, на которой находится пользователь
    const currentWeek = state.weeks[state.currentWeekIdx];
    if (currentWeek) {
      const match = schedules.find(s => s.weekCode === currentWeek.value);
      if (match) {
        state.schedule = match.data;
        state.scheduleCache[currentWeek.value] = match.data;
        applyScheduleHeader();
      }
    }

    renderWeekNav();
    renderDayTabs();
    updateSyncUI('ok');
    // Пересчёт nextPair (может догрузить ещё недели и обновить ДЗ на бэкенде)
    await recalcNextPairDates();
    // Если бэкенд НЕ вернул hw/subjects (старая версия воркера или ошибка)
    // — подтянем финальную авторитетную версию из БД. Иначе пропускаем:
    // у нас уже есть актуальные данные из ответа sync-from-campus.
    if (!hwProvided) await loadHomework();
    if (!subjectsProvided) loadSubjects();
    // Сохраняем клиентский кеш расписаний после синхронизации (он мог
    // пополниться новыми неделями из батча). Дополнительно обнулим его,
    // если была реальная запись в БД, — иначе повторные открытия будут
    // брать устаревшие данные. Проще: пересохраняем новым состоянием.
    saveSchedToCache(state.scheduleCache);
    // Если реальных изменений не было — сохраняем старую дату обновления
    // кампуса, чтобы она не прыгала при мета-обновлениях без изменения расписания.
    saveSyncMeta(syncRes.updated > 0 ? campusUpdatedAt : undefined);
  } catch (e) {
    updateSyncUI('error', e.message);
    if (!state.schedule) {
      showError(
        'Не удалось синхронизировать: ' + e.message,
        isWriter() ? () => syncAll(null, { forceSync: true }) : null
      );
    }
  } finally {
    state.syncing = false;
  }
}

// Собрать диапазон индексов: startIdx..(startIdx + ahead) включительно,
// ограниченный длиной state.weeks. Используется при обновлении вперёд.
function collectForwardRange(startIdx, ahead) {
  const result = [];
  const to = Math.min(state.weeks.length - 1, startIdx + ahead);
  for (let i = startIdx; i <= to; i++) result.push(i);
  return result;
}

async function syncWeeksFromCampus(preserveWeek = false) {
  const weeks = await fetchWeeksFromCampus(state.group);
  if (!weeks || weeks.length === 0) {
    throw new Error('Не удалось получить недели');
  }

  await apiPost('/api/upload', {
    type: 'weeks',
    group: state.group,
    weeks,
  });

  const savedWeekValue = preserveWeek ? state.weeks[state.currentWeekIdx]?.value : null;
  state.weeks = weeks;
  saveWeeksToCache(weeks);

  if (preserveWeek && savedWeekValue) {
    const idx = state.weeks.findIndex(w => w.value === savedWeekValue);
    state.currentWeekIdx = idx >= 0 ? idx : state.currentWeekIdx;
  } else {
    findCurrentWeek();
  }
  renderWeekNav();
}

// ── Fetch from campus (в браузере) ────────────────────────────

async function fetchWeeksFromCampus(group) {
  const formData = new URLSearchParams();
  formData.set('num_group', group);
  formData.set('searchdata', 'ИСКАТЬ');

  const resp = await fetchTimeout(CAMPUS_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
    body: formData.toString(),
  });

  if (!resp.ok) throw new Error('Campus: ' + resp.status);
  const html = await resp.text();
  const weeks = parseWeekOptions(html);
  // Заодно извлекаем дату обновления (на случай, если она пригодится позже)
  weeks._campusUpdatedAt = extractCampusUpdatedAt(html);
  return weeks;
}

// Извлекает дату обновления расписания с кампуса.
// Строка вида "Расписание обновлено 03.07.2026 11:18:53." в <i>.
// Возвращает ISO-строку или '' если не нашлось.
function extractCampusUpdatedAt(html) {
  const m = html.match(/Расписание обновлено\s+(\d{2}\.\d{2}\.\d{4})\s+(\d{2}:\d{2}:\d{2})/);
  if (!m) return '';
  const [_, date, time] = m;
  // dd.MM.yyyy HH:mm:ss -> ISO (считаем локальное время кампуса, UTC+3/Syktyvkar)
  const [d, mo, y] = date.split('.');
  const iso = `${y}-${mo}-${d}T${time}`;
  return iso;
}

// Парсит campusUpdatedAt-строку (формат "yyyy-MM-ddTHH:mm:ss", локальное время
// кампуса UTC+3) в timestamp UTC. Возвращает null при неудаче. Используется
// для оценки «свежести» данных и пропуска фоновой синхронизации.
function parseCampusUpdatedAtTs(iso) {
  if (!iso) return null;
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})/);
  if (!m) {
    // Возможно, это ISO с Z (после saveSyncMeta). Пробуем стандартный парсер.
    const d = new Date(iso);
    return isNaN(d.getTime()) ? null : d.getTime();
  }
  const [_, y, mo, d, h, mi, s] = m;
  // Считаем кампус локальным временем UTC+3 (Сыктывкар). Переводим в UTC.
  const utcMs = Date.UTC(+y, +mo - 1, +d, +h - 3, +mi, +s);
  return isNaN(utcMs) ? null : utcMs;
}

async function fetchScheduleFromCampus(group, weekCode) {
  const formData = new URLSearchParams();
  formData.set('num_group', group);
  if (weekCode) {
    formData.set('weeks', weekCode);
  } else {
    formData.set('searchdata', 'ИСКАТЬ');
  }

  const resp = await fetchTimeout(CAMPUS_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
    body: formData.toString(),
  });

  if (!resp.ok) throw new Error('Campus: ' + resp.status);
  const html = await resp.text();
  const data = parseScheduleHTML(html);
  data.campusUpdatedAt = extractCampusUpdatedAt(html);
  return data;
}

// ── Определение занятости аудитории ───────────────────────────
//
// Логика: для сегодняшнего/завтрашнего дня запрашиваем расписание
// конкретной аудитории с campus.syktsu.ru. Смотрим на пару,
// стоящую непосредственно перед текущей (по времени) в тот же день.
//  - предыдущая пара есть  → «возможно открыта» + показ текста пары
//  - предыдущая пара пуста → «закрыта»
//  - нет данных вовсе       → ничего не показываем

// Кеш результатов на время жизни страницы: room -> Promise<parsed>|parsed
const classroomCache = {};

// Парсит HTML расписания аудитории, сохраняя сырой текст пары так,
// как он написан на сайте. Возвращает { days: { [date]: [{num,time,raw}] } }.
function parseClassroomHTML(html) {
  const result = { days: {} };

  const tableMatch = html.match(/<table\s[^>]*class="schedule"[^>]*>([\s\S]*?)<\/table>/);
  if (!tableMatch) return result;
  const rawTable = tableMatch[1];

  const dayHeaderRegex = /class="dayofweek[^"]*"[^>]*>([^<]*)<br>\((\d{2}\.\d{2}\.\d{4})\)/g;
  const dayHeaders = [];
  let dm;
  while ((dm = dayHeaderRegex.exec(rawTable)) !== null) {
    dayHeaders.push({ date: dm[2], start: dm.index, end: dm.index + dm[0].length });
  }

  for (let i = 0; i < dayHeaders.length; i++) {
    const dayDate = dayHeaders[i].date;
    const contentStart = dayHeaders[i].end;
    const contentEnd = (i + 1 < dayHeaders.length) ? dayHeaders[i + 1].start : rawTable.length;
    const dayContent = rawTable.slice(contentStart, contentEnd);

    const slots = [];
    const pairRegex = /<td>(\d)<\/td><td>(\d{2}:\d{2})<\/td>([\s\S]*?)(?=<td>\d<\/td>|<\/tr>)/g;
    let pm;
    while ((pm = pairRegex.exec(dayContent)) !== null) {
      const num = parseInt(pm[1]);
      const time = pm[2];
      const cellMatch = pm[3].match(/<td[^>]*>([\s\S]*?)<\/td>/);
      const raw = cellMatch ? cleanHtml(cellMatch[1]).replace(/\n/g, ', ').replace(/,\s*,/g, ',').trim() : '';
      slots.push({ num, time, raw });
    }
    result.days[dayDate] = slots;
  }
  return result;
}

async function fetchClassroomFromCampus(room) {
  if (classroomCache[room] !== undefined) return classroomCache[room];

  const promise = (async () => {
    const formData = new URLSearchParams();
    formData.set('num_aud', room);
    formData.set('searchdata', 'ИСКАТЬ');
    const resp = await fetchTimeout(CAMPUS_CLASSROOM_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
      body: formData.toString(),
    });
    if (!resp.ok) throw new Error('Campus classroom: ' + resp.status);
    const html = await resp.text();
    return parseClassroomHTML(html);
  })();

  classroomCache[room] = promise;
  try {
    const data = await promise;
    classroomCache[room] = data;
    return data;
  } catch (e) {
    delete classroomCache[room];
    throw e;
  }
}

// Возвращает статус аудитории для конкретной пары указанного дня:
//  { status: 'open', prev: 'текст пары' } — предыдущая пара есть
//  { status: 'closed' }                   — предыдущая пара пуста
//  null                                   — нет данных
async function getRoomStatus(room, dayDate, pairTime) {
  let data;
  try {
    data = await fetchClassroomFromCampus(room);
  } catch (e) {
    return null;
  }
  const slots = data && data.days ? data.days[dayDate] : null;
  if (!slots || !slots.length) return null;

  const idx = slots.findIndex(s => s.time === pairTime);
  if (idx <= 0) return null; // текущая не найдена или это первая пара дня

  const prev = slots[idx - 1];
  if (prev && prev.raw) {
    return { status: 'open', prev: prev.raw };
  }
  return { status: 'closed' };
}

// ── HTML Parser ───────────────────────────────────────────────

function cleanHtml(text) {
  return text
    .replace(/<br\s*\/?>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/[\t ]+/g, ' ')
    .replace(/\n\s*\n/g, '\n')
    .trim();
}

function parseWeekOptions(html) {
  const selectMatch = html.match(/<select\s+name="weeks"[^>]*>([\s\S]*?)<\/select>/);
  if (!selectMatch) return [];

  const options = [];
  const optRegex = /<option\s+value="(\d+_[^"]+)"[^>]*>([\s\S]*?)<\/option>/g;
  let m;
  while ((m = optRegex.exec(selectMatch[1])) !== null) {
    const rawValue = m[1];
    // WeekCode format: {weekNum}_{groupLabel} (e.g. "50_131-ИБо").
    // Campus returns groupLabel in whatever case the user typed, so we
    // normalize it to lowercase — otherwise different inputs produce
    // different DB keys for the same week of the same group.
    const underscoreIdx = rawValue.indexOf('_');
    const value = underscoreIdx >= 0
      ? rawValue.slice(0, underscoreIdx) + '_' + rawValue.slice(underscoreIdx + 1).toLowerCase()
      : rawValue;
    const text = m[2].replace(/<[^>]+>/g, '').trim();
    const dates = text.match(/\d{2}\.\d{2}\.\d{4}/g) || [];
    options.push({ value, text, weekNum: value.split('_')[0], dates });
  }
  return options;
}

function parsePairType(subject) {
  const m = subject.match(/\((л|пр|пз|лаб|с|зчО|зач|экз)\.?\)/);
  return m ? m[1] : '';
}

const PAIR_TYPE_NAMES = {
  'л': 'лекция',
  'пр': 'практика',
  'пз': 'практическое занятие',
  'лаб': 'лабораторная',
  'с': 'семинар',
  'зчО': 'зачёт с оценкой',
  'зач': 'зачёт',
  'экз': 'экзамен',
};

const ALLOWED_PAIR_TYPES = ['л', 'пр', 'лаб', 'зчО', 'зач', 'экз'];

function parsePairCell(html) {
  const subgroupMatch = html.match(/<b>\s*(подгруппа\s*\d)\s*<\/b>/i);
  const subgroup = subgroupMatch ? subgroupMatch[1].trim() : '';

  const text = html
    .replace(/<b>[^<]*<\/b>/g, '')
    .replace(/<br\s*\/?>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/\n\s*\n/g, '\n')
    .trim();

  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const rawSubject = lines[0] || '';
  const type = parsePairType(rawSubject);
  const subject = rawSubject.replace(/\s*\((?:л|пр|пз|лаб|с|зчО|зач|экз)\.?\)\s*$/, '').trim();
  let teacher = '';
  let room = '';

  if (lines.length > 1) {
    const lastLine = lines[lines.length - 1];
    const roomMatch = lastLine.match(/(\d+\/\d+|\d+)$/);
    if (roomMatch) {
      room = roomMatch[1];
      teacher = lastLine.replace(roomMatch[0], '').trim().replace(/,+$/, '').trim();
    } else {
      teacher = lastLine;
    }
  }

  return { subject, teacher, room, type, subgroup };
}

const RESERVED_DAY_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function parseScheduleHTML(html) {
  const result = {
    group: '',
    weekStart: '',
    weekEnd: '',
    days: {},
  };

  const headerMatch = html.match(/на\s+неделю\s+c\s+(\d{2}\.\d{2}\.\d{4})\s+по\s+(\d{2}\.\d{2}\.\d{4})/);
  if (headerMatch) {
    result.weekStart = headerMatch[1];
    result.weekEnd = headerMatch[2];
  }

  const groupMatch = html.match(/для\s+группы\s+([^\s<]+)/);
  if (groupMatch) result.group = groupMatch[1];

  const tableMatch = html.match(/<table\s[^>]*class="schedule"[^>]*>([\s\S]*?)<\/table>/);
  if (!tableMatch) return result;

  const rawTable = tableMatch[1];

  const dayHeaderRegex = /class="dayofweek[^"]*"[^>]*>([^<]*)<br>\((\d{2}\.\d{2}\.\d{4})\)/g;
  const dayHeaders = [];
  let dm;
  while ((dm = dayHeaderRegex.exec(rawTable)) !== null) {
    dayHeaders.push({
      name: cleanHtml(dm[1]),
      date: dm[2],
      start: dm.index,
      end: dm.index + dm[0].length,
    });
  }

  for (let i = 0; i < dayHeaders.length; i++) {
    const dayName = dayHeaders[i].name;
    if (RESERVED_DAY_KEYS.has(dayName)) continue;
    const dayDate = dayHeaders[i].date;
    const contentStart = dayHeaders[i].end;
    const contentEnd = (i + 1 < dayHeaders.length)
      ? dayHeaders[i + 1].start
      : rawTable.length;
    const dayContent = rawTable.slice(contentStart, contentEnd);

    const pairs = [];
    const pairRegex = /<td>(\d)<\/td><td>(\d{2}:\d{2})<\/td>([\s\S]*?)(?=<td>\d<\/td>|<\/tr>)/g;
    let pm;

    while ((pm = pairRegex.exec(dayContent)) !== null) {
      const num = parseInt(pm[1]);
      const time = pm[2];
      const rest = pm[3];

      const colspanMatch = rest.match(/<td\s+colspan="2">([\s\S]*?)<\/td>/);
      if (colspanMatch) {
        const parsed = parsePairCell(colspanMatch[1]);
        pairs.push({ num, time, ...parsed });
      } else {
        const tdRegex = /<td([^>]*)>([\s\S]*?)<\/td>/g;
        let tm;
        while ((tm = tdRegex.exec(rest)) !== null) {
          const attrs = tm[1];
          const content = tm[2];
          if (content.trim()) {
            const parsed = parsePairCell(content);
            pairs.push({ num, time, ...parsed });
          }
        }
      }
    }

    result.days[dayName] = { date: dayDate, pairs };
  }

  return result;
}

// ── API helpers ───────────────────────────────────────────────

// Показывает toast о превышении лимита запросов (HTTP 429 от Воркера).
// retryAfter — секунды до конца окна (из заголовка Retry-After), может быть 0.
function rateLimitToast(retryAfter) {
  const sec = parseInt(retryAfter, 10) || 0;
  const msg = sec > 0
    ? `Слишком много запросов. Повторите через ${sec} сек.`
    : 'Слишком много запросов. Повторите чуть позже.';
  showToast(msg, 'warn');
}

// Если сервер вернул 403 — роль редактора могла отозвана (ссылка отозвана /
// токен истёк). Проверяем актуальное состояние по /api/writer/status:
// refreshWriterStatus сам спрячет UI и покажет toast при реальной потере роли.
async function invalidateWriterAccess() {
  await refreshWriterStatus();
}

async function apiFetch(path, params = {}) {
  const url = new URL(state.apiBase + path);
  for (const [k, v] of Object.entries(params)) {
    if (v) url.searchParams.set(k, v);
  }
  // GET без Authorization: кука (owner/writer) прикладывается браузером сама,
  // а без неё запрос остаётся reader-кэшируемым и без preflight.
  const resp = await fetchTimeout(url.toString(), { headers: {} });
  if (resp.status === 429) {
    rateLimitToast(resp.headers.get('Retry-After'));
    throw new Error('Слишком много запросов');
  }
  if (!resp.ok) {
    throw new Error('API ' + resp.status);
  }
  return resp.json();
}

async function apiPost(path, body) {
  const headers = { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' };
  const resp = await fetchTimeout(state.apiBase + path, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  if (resp.status === 429) {
    rateLimitToast(resp.headers.get('Retry-After'));
    throw new Error('Слишком много запросов');
  }
  const data = await resp.json();
  if (!resp.ok) {
    if (resp.status === 403) await invalidateWriterAccess();
    throw new Error(data.error || 'API ' + resp.status);
  }
  return data;
}

async function apiDelete(path, params = {}) {
  const url = new URL(state.apiBase + path);
  for (const [k, v] of Object.entries(params)) {
    if (v) url.searchParams.set(k, v);
  }
  const headers = { 'X-Requested-With': 'fetch' };
  const resp = await fetchTimeout(url.toString(), { method: 'DELETE', headers });
  if (resp.status === 429) {
    rateLimitToast(resp.headers.get('Retry-After'));
    throw new Error('Слишком много запросов');
  }
  const data = await resp.json();
  if (!resp.ok) {
    if (resp.status === 403) await invalidateWriterAccess();
    throw new Error(data.error || 'API ' + resp.status);
  }
  return data;
}

async function apiPut(path, body) {
  const headers = { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' };
  const resp = await fetchTimeout(state.apiBase + path, {
    method: 'PUT',
    headers,
    body: JSON.stringify(body),
  });
  if (resp.status === 429) {
    rateLimitToast(resp.headers.get('Retry-After'));
    throw new Error('Слишком много запросов');
  }
  const data = await resp.json();
  if (!resp.ok) {
    if (resp.status === 403) await invalidateWriterAccess();
    throw new Error(data.error || 'API ' + resp.status);
  }
  return data;
}

// Единая точка отправки расписаний на бэкенд.
// schedules: [{ weekCode, data }]. Бэкенд сам сравнивает с KV, сохраняет
// изменённые, обновляет предметы/ДЗ и записывает campusUpdatedAt.
async function uploadSchedulesToBackend(schedules) {
  if (!schedules || schedules.length === 0) return null;
  const withMeta = schedules.find(s => s.data && s.data.campusUpdatedAt);
  const campusUpdatedAt = withMeta ? withMeta.data.campusUpdatedAt : '';
  return apiPost('/api/sync-from-campus', {
    group: state.group,
    campusUpdatedAt,
    schedules,
  });
}

// ── Weeks ─────────────────────────────────────────────────────

// Индекс «реальной» текущей недели по календарю.
//  - если сегодня попадает в диапазон недели — её индекс;
//  - иначе — ближайшая прошедшая неделя (последняя, чей старт <= сегодня),
//    чтобы при «дырках» в расписании или слегка устаревшем списке недель
//    мы не проваливались на самую первую недель (индекс 0), а оставались
//    максимально близко к текущей дате.
//  - иначе 0.
function findRealCurrentIdx() {
  const today = new Date();
  if (today.getDay() === 0) today.setDate(today.getDate() + 1);
  let lastPast = -1;
  for (let i = 0; i < state.weeks.length; i++) {
    const w = state.weeks[i];
    if (!w.dates || w.dates.length < 2) continue;
    const start = parseDate(w.dates[0]);
    const end = parseDate(w.dates[1]);
    if (today >= start && today <= end) return i;
    if (today >= start) lastPast = i;
  }
  return lastPast >= 0 ? lastPast : 0;
}

function findCurrentWeek() {
  state.currentWeekIdx = findRealCurrentIdx();
}

// Убираем поле parsedAt для сравнения расписаний «тело vs тело».
function stripComparable(data) {
  if (!data || typeof data !== 'object') return data;
  const { parsedAt, ...rest } = data;
  return rest;
}

function getWeeksToSync() {
  // Не используется напрямую после рефакторинга, оставлено для совместимости.
  return collectForwardRange(findRealCurrentIdx(), 4);
}

// ── Поиск следующей даты пары в кэше расписаний ──────────────
// Ищет ближайшую дату пары subject + pairType среди дней сегодня или позже.
// Возвращает {date: 'yyyy-MM-dd', weekCode} или null.

function findNextPairInCache(subject, pairType, createdAt, subgroup) {
  if (!subject) return null;
  const baseLower = subject.trim().toLowerCase();
  const t = pairType || 'any';
  const subNum = (subgroup || 'any').replace(/\D/g, ''); // "1" / "2" / "" (любая)

  const fmt = (dt) => {
    const y = dt.getFullYear();
    const m = String(dt.getMonth() + 1).padStart(2, '0');
    const d = String(dt.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  };

  // Якорная дата — ДЕНЬ СОЗДАНИЯ ДЗ. «Следующая пара» ищется строго ПОСЛЕ
  // него, поэтому ДЗ всегда попадает на первую пару этого предмета после дня
  // создания и не «переезжает» вперёд каждый день при открытии сайта.
  let anchor = createdAt ? new Date(createdAt) : new Date();
  if (isNaN(anchor.getTime())) anchor = new Date();
  anchor.setHours(0, 0, 0, 0);
  const anchorStr = fmt(anchor);

  // Перебираем недели по порядку из state.weeks
  for (let i = 0; i < state.weeks.length; i++) {
    const w = state.weeks[i];
    const data = state.scheduleCache[w.value];
    if (!data || !data.days) continue;

    for (const dayInfo of Object.values(data.days)) {
      const dayDate = parseDate(dayInfo.date);
      if (!dayDate) continue;
      const dayStr = fmt(dayDate);
      if (dayStr <= anchorStr) continue; // день создания и раньше — исключаем

      const has = (dayInfo.pairs || []).some(p => {
        if (!p.subject) return false;
        if (p.subject.trim().toLowerCase() !== baseLower) return false;
        if (t !== 'any' && p.type !== t) return false;
        // Для конкретной подгруппы учитываем только пары этой подгруппы.
        if (subNum) {
          const pairSub = (p.subgroup || '').replace(/\D/g, '');
          if (pairSub && pairSub !== subNum) return false;
        }
        return true;
      });
      if (has) return { date: dayStr, weekCode: w.value };
    }
  }
  return null;
}

// ── Пересчёт dueDate для ДЗ с nextPair (клиентский) ───────────
// Для каждого ДЗ с dueMode='nextPair':
//   - Если dueDate < сегодня → не трогаем (просроченные не перемещаем)
//   - Ищем ближайшую дату пары в scheduleCache
//   - Если нашли и дата изменилась → PUT /api/hw
//   - Если не нашли → загружаем ещё 2 недели из кампуса, повторяем
//   - Если кампус закончился → dueDate = null (показать "Следующая пара")

async function recalcNextPairDates() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const fmt = (dt) => {
    const y = dt.getFullYear();
    const m = String(dt.getMonth() + 1).padStart(2, '0');
    const d = String(dt.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  };
  const todayStr = fmt(today);

  // Фильтруем: nextPair и dueDate >= сегодня (или null/пусто)
  const items = state.homework.filter(h => {
    if (h.dueMode !== 'nextPair') return false;
    if (!h.dueDate) return true; // нет даты — надо проверить
    return h.dueDate >= todayStr; // просроченные не трогаем
  });

  console.log('[recalc] today:', todayStr, 'nextPair items:', items.length, 'of', state.homework.length, 'total');
  if (items.length === 0) return;

  // Множество weekCode, которые мы уже запросили (чтобы не запрашивать повторно)
  const fetchedWeekCodes = new Set(Object.keys(state.scheduleCache));
  console.log('[recalc] cached weeks:', [...fetchedWeekCodes]);

  // Накопитель изменений для батча: { id -> newDueDate }. Все обновления
  // отправим ОДНИМ запросом PUT /api/hw/batch, а не N запросами PUT /api/hw
  // (экономия N-1 вызовов воркера на каждом пересчёте).
  const pendingUpdates = new Map();

  let changed = true;
  let iterations = 0;
  const maxIterations = 20; // защита от бесконечного цикла

  while (changed && iterations < maxIterations) {
    changed = false;
    iterations++;
    const stillMissing = [];

    for (const hw of items) {
      // Если уже dueDate=null и мы уже проверили все недели — пропускаем
      if (!hw.dueDate && fetchedWeekCodes.size === state.weeks.length) continue;

       const found = findNextPairInCache(hw.subject, hw.pairType, hw.createdAt, hw.subgroup);
      console.log('[recalc]', hw.subject, hw.pairType, '→ dueDate:', hw.dueDate, '→ found:', found);
      if (found) {
        if (found.date !== hw.dueDate) {
          // Дата изменилась — откладываем в батч (не делаем запрос сразу).
          pendingUpdates.set(hw.id, found.date);
          hw.dueDate = found.date;
          changed = true;
        }
        // else: дата совпала, ничего не делаем
      } else {
        // Не нашли — надо загрузить ещё недели
        stillMissing.push(hw);
      }
    }

    if (stillMissing.length === 0) break;

    // Есть ДЗ, для которых пара не найдена — загрузим ещё 2 недели из кампуса
    if (!state.campusEnabled) break;

    // Ищем индекс последней закэшированной недели
    let lastCachedIdx = -1;
    for (let i = state.weeks.length - 1; i >= 0; i--) {
      if (state.scheduleCache[state.weeks[i].value]) {
        lastCachedIdx = i;
        break;
      }
    }

    // Следующие 2 недели после последней закэшированной
    const nextIndices = [];
    for (let i = lastCachedIdx + 1; i < state.weeks.length && nextIndices.length < 2; i++) {
      const wc = state.weeks[i].value;
      if (!fetchedWeekCodes.has(wc)) {
        nextIndices.push(i);
      }
    }

    if (nextIndices.length === 0) break; // кампус закончился

    // Скачиваем параллельно
    const fetched = await Promise.all(
      nextIndices.map(async (i) => {
        try {
          const wc = state.weeks[i].value;
          fetchedWeekCodes.add(wc);
          const data = await fetchScheduleFromCampus(state.group, wc);
          const hasPairs = data.days && Object.values(data.days).some(d => d.pairs && d.pairs.length > 0);
          if (!hasPairs) return null;
          return { weekCode: wc, data };
        } catch (e) {
          console.warn('fetch more weeks failed:', e.message);
          return null;
        }
      })
    );

    const valid = fetched.filter(Boolean);
    if (valid.length === 0) break;

    // Обновляем кэш
    for (const v of valid) state.scheduleCache[v.weekCode] = v.data;

    // Отправляем в KV (fire-and-forget, не ждём результат)
    if (isWriter()) {
      uploadSchedulesToBackend(valid).catch(e => console.warn('upload more weeks failed:', e.message));
    }
  }

  // Для ДЗ, которые так и не нашли — ставим dueDate=null
  for (const hw of items) {
    if (hw.dueDate && hw.dueDate !== null) {
      const found = findNextPairInCache(hw.subject, hw.pairType, hw.createdAt, hw.subgroup);
       if (!found && hw.dueDate !== null) {
        // Пары больше нет в расписании — обнуляем (тоже добавляем в батч).
        pendingUpdates.set(hw.id, null);
        hw.dueDate = null;
      }
    }
  }

  // Отправляем ВСЕ накопленные изменения одним батч-запросом, а не N запросами.
  if (pendingUpdates.size > 0) {
    const updates = [...pendingUpdates.entries()].map(([id, dueDate]) => ({ id, dueDate }));
    console.log('[recalc] sending batch update for', updates.length, 'items');
    try {
      const resp = await apiPut('/api/hw/batch', { group: state.group, updates });
      // Сервер возвращает обновлённый список всех ДЗ группы — берём его как
      // авторитетный источник (на случай если на бэкенде что-то另行 менялось).
      if (resp && Array.isArray(resp.items)) {
        state.homework = resp.items;
      }
    } catch (e) {
      console.warn('HW batch update failed:', e.message);
      // Fallback на старую схему поодиночных PUT /api/hw — на случай если
      // воркер ещё не обновлён (старая версия без /api/hw/batch).
      for (const [id, dueDate] of pendingUpdates.entries()) {
        try {
          await apiPut('/api/hw', { id, group: state.group, dueDate });
        } catch (e2) {
          console.warn('HW single update fallback failed:', e2.message);
        }
      }
    }
  }


  // Обновляем стейт
  state.homework = [...state.homework];
  renderHomework();
  refreshScheduleView();
}

function renderWeekNav() {
  const label = document.getElementById('weekLabel');
  const w = state.weeks[state.currentWeekIdx];
  if (w) {
    const paren = w.text.indexOf(' (');
    if (paren >= 0) {
      label.innerHTML = `<span>${escHtml(w.text.slice(0, paren))}</span><span class="week-dates">${escHtml(w.text.slice(paren + 1))}</span>`;
    } else {
      label.textContent = w.text;
    }
  }

  document.getElementById('prevWeek').onclick = () => {
    if (state.currentWeekIdx > 0) {
      loadSchedule(state.currentWeekIdx - 1, 'prev');
      renderWeekNav();
    }
  };

  document.getElementById('nextWeek').onclick = () => {
    if (state.currentWeekIdx < state.weeks.length - 1) {
      loadSchedule(state.currentWeekIdx + 1, 'next');
      renderWeekNav();
    }
  };
}

// Карусель смены недели/дня: старый слой уезжает в сторону, новый въезжает
// Плавное открытие/закрытие модалки (double rAF, чтобы transition сработал
// от начального кадра, а не мгновенно).
// originEl — кнопка-источник: модалка «вырастает» из неё (transform-origin).

// ── Focus management для модалок ───────────────────────────────
// При открытии модалки сохраняем элемент, на котором был фокус (кнопку-триггер),
// переносим фокус внутрь; при закрытии возвращаем фокус на сохранённый элемент.
// Ловушка Tab удерживает фокус внутри открытой модалки (циклический обход).
let lastFocusedEl = null;
let modalFocusTrapBound = false;
const MODAL_FOCUSABLE_SELECTOR = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function getModalFocusable(modal) {
  if (!modal) return [];
  return Array.prototype.filter.call(
    modal.querySelectorAll(MODAL_FOCUSABLE_SELECTOR),
    (el) => el.offsetParent !== null && !el.closest('.hidden')
  );
}

function focusFirstModalElement(modal) {
  if (!modal) return;
  // Фокус уже внутри модалки (например, openHwModal сам фокусит hwTask) — не трогаем.
  if (modal.contains(document.activeElement)) return;
  const focusable = getModalFocusable(modal);
  if (focusable.length) {
    focusable[0].focus();
  } else {
    modal.setAttribute('tabindex', '-1');
    modal.focus();
  }
}

function restoreModalFocus() {
  if (!lastFocusedEl) return;
  if (lastFocusedEl.isConnected && lastFocusedEl.offsetParent !== null) {
    lastFocusedEl.focus();
  }
  lastFocusedEl = null;
}

// Ловушка Tab: последний элемент → первый (и наоборот для Shift+Tab);
// если фокус каким-то образом ушёл из модалки — возвращаем его внутрь.
function setupModalFocusTrap() {
  if (modalFocusTrapBound) return;
  modalFocusTrapBound = true;
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return;
    const modal = document.querySelector('.modal.is-open');
    if (!modal) return;
    const focusable = getModalFocusable(modal);
    if (!focusable.length) {
      e.preventDefault();
      focusFirstModalElement(modal);
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!modal.contains(e.target)) {
      e.preventDefault();
      (e.shiftKey ? last : first).focus();
      return;
    }
    if (e.shiftKey && e.target === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && e.target === last) {
      e.preventDefault();
      first.focus();
    }
  });
}

// Счётчик одновременно открытых модалок: прокрутка фона блокируется при
// первой открытой модалке и снимается только когда закрыта последняя
// (модалки могут открываться одна поверх другой, напр. просмотр ДЗ → форма).
let openModalCount = 0;

function openModal(modal, originEl) {
  if (!modal) return;
  lastFocusedEl = originEl ||
    (document.activeElement && document.activeElement !== document.body ? document.activeElement : null);
  modal.classList.remove('hidden');

  // Блокируем прокрутку фона на ВСЕХ экранах (не только ≤400px), пока
  // открыта хотя бы одна модалка. Синхронно — до rAF, чтобы при быстрой
  // смене «закрыть одну → открыть другую» не было кадра со свободным скроллом.
  openModalCount += 1;
  if (openModalCount === 1) {
    document.body.classList.add('modal-open');
  }

  const content = modal.querySelector('.modal-content');

  requestAnimationFrame(() => {
    if (content) {
      content.style.transition = 'none';
      content.classList.remove('from-origin');
      content.style.setProperty('--from-x', '0px');
      content.style.setProperty('--from-y', '0px');
      void content.offsetWidth;
      content.style.transition = '';
    }

    if (content && originEl) {
      const cr = content.getBoundingClientRect();
      const br = originEl.getBoundingClientRect();
      const ox = br.left + br.width / 2 - (cr.left + cr.width / 2);
      const oy = br.top + br.height / 2 - (cr.top + cr.height / 2);

      content.style.transition = 'none';
      content.style.transformOrigin = 'center center';
      content.style.setProperty('--from-x', ox + 'px');
      content.style.setProperty('--from-y', oy + 'px');
      content.classList.add('from-origin');
      void content.offsetWidth;
      content.style.transition = '';
    }
    void (content ? content.offsetWidth : 0);
    modal.classList.add('is-open');
    focusFirstModalElement(modal);
  });
}

function closeModal(modal) {
  if (!modal) return;
  modal.classList.remove('is-open');
  // Снимаем блокировку прокрутки только когда закрыта последняя модалка.
  openModalCount = Math.max(0, openModalCount - 1);
  if (openModalCount === 0) {
    document.body.classList.remove('modal-open');
  }
  restoreModalFocus();
  // При «меньше движения» переход уже мгновенный — прячем оверлей сразу,
  // иначе прозрачный некликабельный слой висел бы ещё 240ms.
  setTimeout(() => modal.classList.add('hidden'), prefersReducedMotion() ? 0 : 240);
}

// с противоположной. Между ними — момент, когда видны оба частично.
// direction: 'next' или 'prev'.
function animateSchedule(direction) {
  const el = document.getElementById('scheduleContent');
  if (!el) return;

  // «Меньше движения»: карусель отключается целиком — новый контент
  // появляется мгновенно в renderDaySchedule, оверлей не создаётся.
  if (prefersReducedMotion()) return;

  // Убираем предыдущий leaving-оверлей, если анимация ещё не завершилась.
  const prev = document.querySelector('.week-leaving-fixed');
  if (prev) prev.remove();

  // Клонируем ТЕКУЩЕЕ содержимое в отдельный fixed-оверлей поверх расписания.
  // Оверлей живёт в <body>, поэтому последующий renderDaySchedule (innerHTML=)
  // его не стирает — старый день/неделя уезжают в сторону целиком.
  const rect = el.getBoundingClientRect();
  const leaving = document.createElement('div');
  leaving.className = 'week-leaving-fixed';
  leaving.style.top = rect.top + 'px';
  leaving.style.left = rect.left + 'px';
  leaving.style.width = rect.width + 'px';
  leaving.style.minHeight = rect.height + 'px';
  leaving.innerHTML = el.innerHTML;
  document.body.appendChild(leaving);

  const cls = direction === 'prev' ? 'anim-prev' : 'anim-next';
  leaving.classList.add(cls);
  el.classList.remove('anim-next', 'anim-prev');
  void el.offsetWidth; // reflow — перезапуск анимации
  el.classList.add(cls);

  // Новый контент (добавится renderDaySchedule после этой функции)
  // анимируется въездом через CSS `.anim-next` / `.anim-prev` на #scheduleContent.
  // Снимаем класс чуть раньше удаления оверлея, чтобы не было «дёрга».
  setTimeout(() => {
    el.classList.remove('anim-next', 'anim-prev');
  }, 300);
  setTimeout(() => {
    if (leaving.parentNode) leaving.remove();
  }, 380);
}

// ── Schedule rendering ────────────────────────────────────────

function renderDayTabs() {
  const tabs = document.getElementById('dayTabs');
  tabs.innerHTML = '';

  const days = Object.keys(state.schedule.days);
  const effNow = new Date();
  if (effNow.getDay() === 0) effNow.setDate(effNow.getDate() + 1);
  const todayName = DAY_NAMES[effNow.getDay() === 0 ? 6 : effNow.getDay() - 1];

  let defaultDay = days[0];
  for (const d of days) {
    if (state.schedule.days[d].pairs.some(p => p.subject)) {
      defaultDay = d;
      break;
    }
  }

  if (!state.selectedDay || !days.includes(state.selectedDay)) {
    state.selectedDay = days.includes(todayName) ? todayName : defaultDay;
  }

  days.forEach(day => {
    const tab = document.createElement('button');
    tab.className = 'day-tab';
    if (day === state.selectedDay) tab.classList.add('active');
    if (day === todayName) tab.classList.add('today');

    const dayIdx = DAY_NAMES.indexOf(day);
    tab.textContent = dayIdx >= 0 ? DAY_SHORT[dayIdx] : day.slice(0, 2);
    tab.title = day + ' (' + state.schedule.days[day].date + ')';

    tab.onclick = () => selectDay(day);

    tabs.appendChild(tab);
  });

  renderDaySchedule(state.selectedDay);
}

function selectDay(day) {
  if (!state.schedule || !state.schedule.days[day]) return;
  if (day === state.selectedDay) return;
  const prevDay = state.selectedDay;
  state.selectedDay = day;
  document.querySelectorAll('.day-tab').forEach(t => t.classList.remove('active'));
  const tabs = document.querySelectorAll('.day-tab');
  const keys = Object.keys(state.schedule.days);
  tabs[keys.indexOf(day)].classList.add('active');
  // Направление сдвига зависит от порядка дня в неделе.
  const dir = keys.indexOf(day) >= keys.indexOf(prevDay) ? 'next' : 'prev';
  animateSchedule(dir);
  renderDaySchedule(day);
}

// Горячие клавиши: ←/→ — недели, 1–6 — дни недели.
function setupKeyboardShortcuts() {
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
    // Esc закрывает ЛЮБУЮ открытую модалку (настройки, форму ДЗ, просмотр ДЗ),
    // даже если фокус внутри поля ввода модалки (потому и стоит до проверки
    // INPUT/TEXTAREA/SELECT). Закрываем через кнопку «×» модалки — на неё
    // повешена специфичная очистка (resetDeleteState у формы, анимация у
    // настроек и т.п.); если кнопки нет — просто closeModal.
    if (e.key === 'Escape') {
      const open = document.querySelector('.modal.is-open');
      if (open) {
        const closeBtn = open.querySelector('.modal-header .icon-btn');
        if (closeBtn) closeBtn.click();
        else closeModal(open);
        return;
      }
    }
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
    const modalOpen = document.querySelector('.modal.is-open');
    if (modalOpen) return;
    if (e.key === 'ArrowLeft') {
      const btn = document.getElementById('prevWeek');
      if (btn && state.currentWeekIdx > 0) {
        e.preventDefault();
        btn.click();
      }
      return;
    }
    if (e.key === 'ArrowRight') {
      const btn = document.getElementById('nextWeek');
      if (btn && state.currentWeekIdx < state.weeks.length - 1) {
        e.preventDefault();
        btn.click();
      }
      return;
    }
    if (/^[1-6]$/.test(e.key)) {
      if (!state.schedule || !state.schedule.days) return;
      const keys = Object.keys(state.schedule.days);
      const day = keys[Number(e.key) - 1];
      if (day) {
        e.preventDefault();
        selectDay(day);
      }
    }
  });
}

// Видима ли пара с учётом выбранного фильтра подгруппы.
//  - 'any'         → показываем всегда
//  - пара без подгруппы (общая) → показываем всегда (относится ко всем)
//  - иначе → только если подгруппа пары совпадает с выбранной
function pairVisibleForSubgroupFilter(p) {
  const f = state.subgroupFilter || 'any';
  if (f === 'any') return true;
  const s = (p.subgroup || '').replace(/\D/g, '');
  return !s || s === f;
}

function renderDaySchedule(day) {
  const content = document.getElementById('scheduleContent');
  const dayData = state.schedule.days[day];

  if (!dayData) {
    content.innerHTML = '<div class="no-pairs">Нет данных</div>';
    return;
  }

  let pairsHtml = '';
  const activePairs = dayData.pairs.filter(p => p.subject && pairVisibleForSubgroupFilter(p));

  if (activePairs.length === 0) {
      pairsHtml = '<div class="no-pairs"><svg class="icon" style="width:32px;height:32px"><use href="#icon-party-popper"></use></svg><br>Нет пар</div>';
  } else {
    for (const p of activePairs) {
      const typeFullName = PAIR_TYPE_NAMES[p.type] || p.type || '';

      const hwItems = getHwForPair(p.subject, p.type, dayData.date, p.subgroup);
      let hwHtml = '';
      if (hwItems.length) {
        hwHtml = '<div class="pair-hw">' + hwItems.map(hw => {
          let dc = '';
          if (hw.dueDate) {
            const d = new Date(hw.dueDate);
            d.setHours(0, 0, 0, 0);
            const now = new Date(); now.setHours(0, 0, 0, 0);
            const df = Math.ceil((d - now) / 86400000);
            if (df < 0) dc = ' overdue';
            else if (df <= 2) dc = ' due-soon';
          }
          const done = doneHwIds.has(hw.id);
          const dueText = (hw.author ? escHtml(hw.author) : '');
          return `<div class="pair-hw-item${dc}${done ? ' done' : ''}"><span class="pair-hw-done" data-id="${escHtml(hw.id)}" title="Отметить выполненным"><svg class="icon" style="width:16px;height:16px"><use href="#icon-check"></use></svg></span><span class="pair-hw-task">${hwTaskMarkup(hw.task, 'задание', hw.id)}</span>${dueText ? `<span class="pair-hw-due">${dueText}</span>` : ''}</div>`;
        }).join('') + '</div>';
      }

      const baseSubj = p.subject;
      const pairTypeCode = p.type || '';
      const subgroupNum = p.subgroup ? p.subgroup.replace(/\D/g, '') : '';

      pairsHtml += `
        <div class="pair-card${p.subgroup ? ' has-subgroup' : ''}">
          <div class="pair-top">
            <div style="display:flex;align-items:center;gap:8px;">
              <span class="pair-num">${escHtml(p.num)}</span>
              <span class="pair-time">${escHtml(p.time)}</span>
            </div>
            <div style="display:flex;align-items:center;gap:6px;">
              ${p.subgroup ? `<span class="pair-subgroup">${escHtml(p.subgroup)}</span>` : ''}
              ${typeFullName ? `<span class="pair-type" data-type="${escHtml(p.type || '')}">${escHtml(typeFullName)}</span>` : ''}
              ${isWriter() ? `<button class="pair-add-hw" data-subj="${escHtml(baseSubj)}" data-type="${escHtml(pairTypeCode)}" data-subgroup="${subgroupNum}" title="Добавить ДЗ" data-anim="scale"><svg class="icon" style="width:16px;height:16px"><use href="#icon-plus"></use></svg></button>` : ''}
            </div>
          </div>
          <div class="pair-subject">${escHtml(p.subject)}</div>
          ${p.teacher ? `<div class="pair-teacher">${escHtml(p.teacher)}</div>` : ''}
          ${p.room ? `<div class="pair-room" data-room="${escHtml(p.room)}" data-time="${escHtml(p.time)}">${escHtml(p.room)}<span class="room-status"></span></div>` : ''}
          ${hwHtml}
        </div>`;
    }
  }

   content.innerHTML = `
     <div class="day-schedule">
       <div class="day-header">
         ${escHtml(day)}
         <span class="day-date">${escHtml(dayData.date)}</span>
       </div>
       ${pairsHtml}
     </div>`;

   attachHwViewLinks(content);

    content.querySelectorAll('.pair-add-hw').forEach(btn => {
    btn.onclick = (e) => {
      e.stopPropagation();
      openHwModal(btn.dataset.subj, btn.dataset.type, btn.dataset.subgroup, null, btn);
    };
  });

  content.querySelectorAll('.pair-hw-done').forEach(btn => {
    btn.onclick = (e) => {
      e.stopPropagation();
      const id = btn.dataset.id;
      if (doneHwIds.has(id)) {
        doneHwIds.delete(id);
      } else {
        doneHwIds.add(id);
      }
      saveDoneHw();
      // Точечное обновление — не перерисовываем весь день, чтобы не терялись
      // фокус на кнопке и скролл.
      updateHwDoneState(id);
    };
  });

  loadRoomStatuses(day, dayData);
}

// Загружает статусы аудиторий (открыта/закрыта) для сегодняшнего и
// завтрашнего календарного дня. Работает только при включённой
// синхронизации с кампусом. Данные нигде не сохраняются.
function loadRoomStatuses(day, dayData) {
  if (!state.campusEnabled) return;
  if (!dayData || !dayData.date) return;

  const today = new Date(); today.setHours(0, 0, 0, 0);
  const tomorrow = new Date(today); tomorrow.setDate(tomorrow.getDate() + 1);
  const dayDate = parseDate(dayData.date); dayDate.setHours(0, 0, 0, 0);

  const isToday = dayDate.getTime() === today.getTime();
  const isTomorrow = dayDate.getTime() === tomorrow.getTime();
  if (!isToday && !isTomorrow) return;

  const content = document.getElementById('scheduleContent');
  const els = Array.from(content.querySelectorAll('.pair-room[data-room]'));

  els.forEach(el => {
    const room = el.dataset.room;
    const time = el.dataset.time;
    const badge = el.querySelector('.room-status');
    if (!room || !badge) return;

    getRoomStatus(room, dayData.date, time).then(res => {
      if (!res) return; // нет данных — ничего не пишем
      if (res.status === 'open') {
        badge.className = 'room-status open';
        badge.textContent = 'возможно открыта';
        badge.title = 'Показать предыдущую пару в аудитории';
        // Доступность с клавиатуры: span получает роль кнопки только в состоянии
        // open; Enter/Space вызывают тот же обработчик, что и клик.
        badge.setAttribute('role', 'button');
        badge.tabIndex = 0;
        badge.onclick = (e) => {
          e.stopPropagation();
          showRoomPrevPair(room, res.prev, badge);
        };
        badge.onkeydown = (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            showRoomPrevPair(room, res.prev);
          }
        };
      } else if (res.status === 'closed') {
        badge.className = 'room-status closed';
        badge.textContent = 'закрыта';
        // Закрытая аудитория — просто информация: убираем интерактивность.
        badge.removeAttribute('role');
        badge.removeAttribute('tabindex');
        badge.onclick = null;
        badge.onkeydown = null;
      }
    }).catch(() => {});
  });
}

function showRoomPrevPair(room, prevText, originEl) {
  const modal = document.getElementById('roomPrevModal');
  if (!modal) return;
  document.getElementById('roomPrevTitle').textContent = 'Аудитория ' + room;
  document.getElementById('roomPrevText').textContent = 'Предыдущая пара:\n' + prevText;
  openModal(modal, originEl);
}

// Закрытие модалки «Предыдущая пара» (крестик, кнопка ОК, клик по фону).
{
  const modal = document.getElementById('roomPrevModal');
  if (modal) {
    const close = () => closeModal(modal);
    document.getElementById('closeRoomPrev').onclick = close;
    document.getElementById('roomPrevOk').onclick = close;
    modal.onclick = (e) => { if (e.target === modal) close(); };
  }
}

// ── Sync UI ───────────────────────────────────────────────────

function updateSyncUI(status, errorMsg) {
  const el = document.getElementById('syncStatus');
  if (!el) return;

  if (status === 'syncing') {
    el.innerHTML = '<span class="sync-icon spinning"><svg class="icon" style="width:16px;height:16px"><use href="#icon-refresh-cw"></use></svg></span> Синхронизация...';
    el.className = 'sync-status syncing';
  } else if (status === 'ok') {
    el.innerHTML = '<span class="sync-icon"><svg class="icon" style="width:16px;height:16px"><use href="#icon-check"></use></svg></span> ' + new Date().toLocaleTimeString('ru');
    el.className = 'sync-status ok';
  } else if (status === 'error') {
    el.innerHTML = '<span class="sync-icon"><svg class="icon" style="width:16px;height:16px"><use href="#icon-x-circle"></use></svg></span> Ошибка. <button id="syncRetryBtn" class="sync-retry">Повторить</button>';
    el.className = 'sync-status error';
    // Навешиваем обработчик через addEventListener (а не через inline onclick),
    // чтобы строгая CSP (script-src 'self') не блокировала кнопку.
    const retryBtn = el.querySelector('#syncRetryBtn');
    if (retryBtn) retryBtn.addEventListener('click', () => syncAll(null, { forceSync: true }));
  }
}

// ── Subjects ─────────────────────────────────────────────────

let loadedSubjects = [];

// Защита: отбрасываем записи без валидного subject (чтобы не падало .toLowerCase()).
function setLoadedSubjects(arr) {
  loadedSubjects = (Array.isArray(arr) ? arr : []).filter(s => s && typeof s.subject === 'string');
}

async function loadSubjects() {
  // Сначала кеш (TTL 10 мин) — экономия /api/subjects при повторных открытиях.
  const cached = loadSubjectsFromCache();
  if (cached) {
    setLoadedSubjects(cached);
    return;
  }
  try {
    const res = await apiFetch('/api/subjects', { group: state.group });
    setLoadedSubjects(res.subjects);
    saveSubjectsToCache(loadedSubjects);
  } catch (e) {
    loadedSubjects = [];
  }
  // Если из БД ничего нет — собираем из расписания текущей (календарно) недели
  if (loadedSubjects.length === 0) {
    const sched = getCurrentWeekSchedule() || state.schedule;
    if (sched) {
      const map = new Map(); // subject -> { types:Set, sub:Map<type,Set<code>> }
      for (const day of Object.values(sched.days)) {
        for (const p of (day.pairs || [])) {
          if (!p.subject) continue;
          if (!map.has(p.subject)) map.set(p.subject, { types: new Set(), sub: new Map() });
          const info = map.get(p.subject);
          if (p.type) info.types.add(p.type);
          const sub = (p.subgroup || '').replace(/\D/g, '');
          if (sub) {
            if (!info.sub.has(p.type)) info.sub.set(p.type, new Set());
            info.sub.get(p.type).add(sub);
          }
        }
      }
      loadedSubjects = [...map.entries()].map(([subject, info]) => {
        const subgroups = {};
        for (const [t, codes] of info.sub) {
          if (codes.size) subgroups[t] = [...codes].sort();
        }
        return { subject, pairTypes: [...info.types].sort(), subgroups };
      }).sort((a, b) => a.subject.localeCompare(b.subject, 'ru'));
    }
  }
}

function getTodaySubjectPairs() {
  const sched = getCurrentWeekSchedule();
  if (!sched) return [];
  const todayName = DAY_NAMES[new Date().getDay() === 0 ? 6 : new Date().getDay() - 1];
  const day = sched.days[todayName];
  if (!day) return [];
  const seen = new Set();
  const result = [];
  for (const p of day.pairs) {
    if (!p.subject) continue;
    if (!pairVisibleForSubgroupFilter(p)) continue;
    const subNum = (p.subgroup || '').replace(/\D/g, '');
    const key = p.subject + '\u0001' + (p.type || '') + '\u0001' + subNum;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(p);
  }
  return result;
}

// Возвращает пару, которая идёт прямо сейчас (по реальному времени), либо null.
// Окно пары: [время начала, время начала следующей пары); если пар после нет — [начало, начало + 2ч].
function getCurrentPair() {
  const sched = getCurrentWeekSchedule();
  if (!sched) return null;
  const todayName = DAY_NAMES[new Date().getDay() === 0 ? 6 : new Date().getDay() - 1];
  const day = sched.days[todayName];
  if (!day) return null;

  const pairs = day.pairs
    .filter(p => p.subject && p.time)
    .map(p => {
      const [h, m] = p.time.split(':').map(Number);
      return { pair: p, startMin: h * 60 + m };
    })
    .sort((a, b) => a.startMin - b.startMin);

  if (pairs.length === 0) return null;

  const now = new Date();
  const nowMin = now.getHours() * 60 + now.getMinutes();

  for (let i = 0; i < pairs.length; i++) {
    const cur = pairs[i];

    // Текущее время раньше начала этой (и всех следующих) пар — дальше не смотрим
    if (nowMin < cur.startMin) return null;

    // Окончание окна: начало следующей пары, либо +2ч, если пар после нет
    const endMin = (i + 1 < pairs.length)
      ? pairs[i + 1].startMin
      : cur.startMin + 120;

    // Попали в окно — возвращаем сразу, последующие пары не считаются
    if (nowMin < endMin) return cur.pair;
  }
  return null; // позже последней пары + 2ч
}

function getAllSubjects() {
  const sched = getCurrentWeekSchedule();
  if (!sched) return { today: [], all: [] };

  const todayName = DAY_NAMES[new Date().getDay() === 0 ? 6 : new Date().getDay() - 1];
  const allSet = new Set();
  const todaySet = new Set();

  for (const [day, data] of Object.entries(sched.days)) {
    for (const p of data.pairs) {
      if (!p.subject) continue;
      allSet.add(p.subject);
      if (day === todayName) todaySet.add(p.subject);
    }
  }

  const today = [...todaySet];
  const rest = [...allSet].filter(s => !todaySet.has(s));
  return { today, all: [...today, ...rest] };
}

function normalizeDateToISO(str) {
  if (!str) return '';
  str = str.trim();
  let m = str.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = str.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  return str;
}

function getHwForSubject(subj) {
  if (!subj) return [];
  const base = subj.trim().toLowerCase();
  return state.homework.filter(h => {
    const hBase = (h.subject || '').toLowerCase();
    if (hBase !== base) return false;
    return true;
  });
}

function getHwForPair(subject, pairType, dayDate, pairSubgroup) {
  if (!subject) return [];
  const base = subject.trim().toLowerCase();
  const dISO = normalizeDateToISO(dayDate);
  const pairSub = (pairSubgroup || '').replace(/\D/g, ''); // "1" / "2" / "" (общая)
  return state.homework.filter(h => {
    if (!h.dueDate) return false;
    if ((h.subject || '').trim().toLowerCase() !== base) return false;
    if (h.pairType && h.pairType !== 'any' && h.pairType !== pairType) return false;
    if (normalizeDateToISO(h.dueDate) !== dISO) return false;
    // Фильтр по подгруппе:
    //  - ДЗ "any" (обе) показывается на всех парах;
    //  - ДЗ для подгруппы N — только на парах подгруппы N;
    //  - общая пара (без подгруппы) получает только ДЗ "any".
    const hwSub = h.subgroup || 'any';
    if (hwSub === 'any') return true;
    if (!pairSub) return false;
    return hwSub === pairSub;
  });
}

// Убирает токены разметки из текста — для карточек/превью (только чистый текст).
function stripMarkdown(src) {
  let t = String(src || '');
  t = t.replace(/```[\s\S]*?```/g, ''); // блочный код
  const out = [];
  for (const line of t.split('\n')) {
    const tr = line.trim();
    if (tr.includes('|')) {
      // разделитель таблицы |---|---| — целиком удаляем
      if (/^[\s:|\-]+$/.test(tr)) continue;
      out.push(tr.replace(/^\|/, '').replace(/\|$/, '').split('|').map(s => s.trim()).join(' '));
      continue;
    }
    out.push(line);
  }
  t = out.join('\n');
  t = t.replace(/^\s{0,3}#{1,6}\s+/gm, '');          // заголовки
  t = t.replace(/^\s{0,3}([-*+]|\d+\.)\s+/gm, '');    // пункты списков
  t = t.replace(/\*\*([^*]+)\*\*/g, '$1');            // жирный
  t = t.replace(/\*([^*\n]+)\*/g, '$1');              // курсив
  t = t.replace(/`([^`\n]+)`/g, '$1');                // код
  t = t.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');      // ссылки
  t = t.replace(/[ \t]+$/gm, '');
  t = t.replace(/\n{3,}/g, '\n\n');
  return t.trim();
}

// Мини-разметка → HTML. Вход СНАЧАЛА экранируется (escHtml),
// затем парсятся только наши токены — рендер чужого HTML невозможен.
function mdInline(t) {
  return t
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, txt, url) => {
      const u = url.trim().replace(/["']/g, '');
      if (u.startsWith('//')) return m;
      if (/^(https?:\/\/|mailto:|\/|#)/i.test(u)) {
        return '<a href="' + u + '" target="_blank" rel="noopener noreferrer">' + txt + '</a>';
      }
      return m;
    });
}

function mdTable(lines) {
  const splitRow = (s) => {
    let r = s.trim();
    if (r.startsWith('|')) r = r.slice(1);
    if (r.endsWith('|')) r = r.slice(0, -1);
    return r.split('|').map(c => c.trim());
  };
  const head = splitRow(lines[0]);
  const body = lines.slice(2).filter(l => l.trim()).map(splitRow);
  let h = '<div class="hw-table-wrap"><table><thead><tr>'
    + head.map(c => '<th>' + mdInline(c) + '</th>').join('') + '</tr></thead><tbody>';
  h += body.map(r => '<tr>' + r.map(c => '<td>' + mdInline(c) + '</td>').join('') + '</tr>').join('');
  return h + '</tbody></table></div>';
}

function mdBlocks(text) {
  let html = '';
  for (const b of text.split(/\n{2,}/)) {
    const lines = b.split('\n').map(l => l.trim());
    if (!b.trim()) continue;
    // Таблица: первая строка с |, вторая — разделитель |---|---|
    if (lines.length >= 2 && lines[0].includes('|')
      && lines[1].includes('-') && /^[\s:|\-]+$/.test(lines[1])) {
      html += mdTable(lines);
      continue;
    }
    // Списки
    if (lines.every(l => /^([-*+]|\d+\.)\s/.test(l))) {
      const ordered = /^\d+\.\s/.test(lines[0]);
      html += '<' + (ordered ? 'ol' : 'ul') + '>'
        + lines.map(l => '<li>' + mdInline(l.replace(/^([-*+]|\d+\.)\s+/, '')) + '</li>').join('')
        + '</' + (ordered ? 'ol' : 'ul') + '>';
      continue;
    }
    // Обычный текст с переносами; заголовки (#, ##, ...) рендерятся на любой строке
    let para = [];
    const flush = () => {
      const t = para.join('<br>');
      if (t.trim()) html += '<p>' + mdInline(t) + '</p>';
      para = [];
    };
    for (const line of lines) {
      const hm = line.match(/^(#{1,6})\s+(.*)$/);
      if (hm) {
        flush();
        const tag = 'h' + Math.min(hm[1].length + 2, 6);
        html += '<' + tag + '>' + mdInline(hm[2]) + '</' + tag + '>';
      } else {
        para.push(line);
      }
    }
    flush();
  }
  return html;
}

function hwMarkdownToHtml(src) {
  const esc = escHtml(String(src || ''));
  let html = '';
  let idx = 0;
  const re = /```([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(esc)) !== null) {
    html += mdBlocks(esc.slice(idx, m.index));
    html += '<pre class="hw-code"><code>' + m[1].replace(/^\n/, '').replace(/\n$/, '') + '</code></pre>';
    idx = m.index + m[0].length;
  }
  html += mdBlocks(esc.slice(idx));
  return html;
}

function hwTaskMarkup(task, fallback, hwId) {
  const clean = stripMarkdown(task || fallback || '');
  if (clean.length <= 120) {
    return `<span class="hw-text">${escHtml(clean)}</span>`;
  }
  return `<button type="button" class="hw-text hw-view-link" data-hw-id="${escHtml(hwId || '')}" title="Открыть задание">`
    + `${escHtml(clean.slice(0, 120))}… <span class="hw-open-hint">открыть</span>`
    + `</button>`;
}

// Окно просмотра ДЗ с отрендеренной разметкой
let hwViewingId = null;

function openHwViewer(hwId, originEl) {
  const hw = state.homework.find(h => h.id === hwId);
  if (!hw) return;
  hwViewingId = hwId;
  const modal = document.getElementById('hwViewModal');

  const typeName = hw.pairType && hw.pairType !== 'any' ? (PAIR_TYPE_NAMES[hw.pairType] || hw.pairType) : '';
  const subLabel = hw.subgroup && hw.subgroup !== 'any' ? 'подгруппа ' + hw.subgroup : '';
  let dueLabel = '';
  if (hw.dueDate) dueLabel = 'Срок: ' + hw.dueDate;
  else if (hw.dueMode === 'nextPair') dueLabel = 'Следующая пара';

  const chips = [];
  if (typeName) chips.push('<span class="hw-view-chip">' + escHtml(typeName) + '</span>');
  if (subLabel) chips.push('<span class="hw-view-chip">' + escHtml(subLabel) + '</span>');
  if (dueLabel) chips.push('<span class="hw-view-chip hw-view-chip-due">' + escHtml(dueLabel) + '</span>');
  if (hw.author) chips.push('<span class="hw-view-chip">' + escHtml(hw.author) + '</span>');

  modal.querySelector('.modal-header h2').textContent = hw.subject || 'Задание';
  document.getElementById('hwViewMeta').innerHTML = chips.join('');
  document.getElementById('hwViewTask').innerHTML = hwMarkdownToHtml(hw.task);

  const doneBtn = document.getElementById('hwViewDone');
  const editBtn = document.getElementById('hwViewEdit');
  if (isWriter()) {
    editBtn.classList.remove('hidden');
  } else {
    editBtn.classList.add('hidden');
  }

  function renderDoneBtn() {
    const now = doneHwIds.has(hw.id);
    doneBtn.classList.toggle('active', now);
    doneBtn.textContent = now ? 'Выполнено' : 'Отметить выполненным';
  }
  renderDoneBtn();

  doneBtn.onclick = () => {
    if (doneHwIds.has(hw.id)) {
      doneHwIds.delete(hw.id);
    } else {
      doneHwIds.add(hw.id);
    }
    saveDoneHw();
    renderDoneBtn();
    // Точечно синхронизируем расписание и нижний список за модалкой — без
    // полного перерендера дня (фокус/скролл фона не теряются).
    updateHwDoneState(hw.id);
  };

  editBtn.onclick = () => {
    closeModal(modal);
    openHwModal(null, null, null, hw, editBtn);
  };

  document.getElementById('closeHwView').onclick = () => closeModal(modal);
  modal.onclick = (e) => {
    if (e.target === modal) closeModal(modal);
  };

  openModal(modal, originEl);
}

// Клик по усечённому тексту длинного ДЗ → окно просмотра
function attachHwViewLinks(container) {
  container.querySelectorAll('.hw-view-link').forEach(el => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      if (el.dataset.hwId) openHwViewer(el.dataset.hwId, el);
    });
  });
}

setupKeyboardShortcuts();
setupModalFocusTrap();

// ── Calendar widget ──────────────────────────────────────────

let calState = { year: 0, month: 0, selectedDate: '' };

function renderCalendar(year, month, selectedDateStr) {
  const grid = document.getElementById('hwCalGrid');
  const title = document.getElementById('hwCalTitle');
  const monthNames = [
    'Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь',
    'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь',
  ];

  title.textContent = monthNames[month] + ' ' + year;

  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const daysInPrev = new Date(year, month, 0).getDate();
  const today = new Date();
  const todayStr = formatDateISO(today);
  const selected = selectedDateStr || '';

  const dayHeaders = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
  let html = '';
  for (const h of dayHeaders) {
    html += '<div class="cal-day-header">' + h + '</div>';
  }

  // Дни предыдущего месяца (недоступны — плейсхолдер)
  const startOffset = firstDay === 0 ? 6 : firstDay - 1;
  for (let i = startOffset - 1; i >= 0; i--) {
    const d = daysInPrev - i;
    html += '<div class="cal-day other-month" data-date="" aria-hidden="true">' + d + '</div>';
  }

  // Дни текущего месяца — настоящие кнопки (доступны с клавиатуры).
  // Roving tabindex: выбранный день (или первый доступный) получает tabindex=0,
  // остальные — -1, чтобы в Tab-порядке был только один элемент календаря.
  let anchorSet = false;
  for (let d = 1; d <= daysInMonth; d++) {
    const date = new Date(year, month, d);
    const dateStr = formatDateISO(date);
    if (dateStr < todayStr) {
      // Прошлое недоступно — не кнопка.
      html += '<div class="cal-day other-month" data-date="" aria-hidden="true" title="Прошедшая дата">' + d + '</div>';
      continue;
    }
    let cls = 'cal-day';
    if (dateStr === todayStr) cls += ' today';
    if (dateStr === selected) cls += ' selected';
    let tabIndex = '-1';
    if (dateStr === selected) {
      tabIndex = '0';
      anchorSet = true;
    } else if (!anchorSet) {
      tabIndex = '0';
      anchorSet = true;
    }
    const ariaSelected = dateStr === selected ? 'true' : 'false';
    const ariaCurrent = dateStr === todayStr ? ' aria-current="date"' : '';
    html += '<button type="button" class="' + cls + '" data-date="' + dateStr +
      '" tabindex="' + tabIndex + '" aria-selected="' + ariaSelected + '"' + ariaCurrent + '>' + d + '</button>';
  }

  // Дни следующего месяца (недоступны — плейсхолдер)
  const totalCells = startOffset + daysInMonth;
  const remaining = (7 - (totalCells % 7)) % 7;
  for (let d = 1; d <= remaining; d++) {
    html += '<div class="cal-day other-month" data-date="" aria-hidden="true">' + d + '</div>';
  }

  grid.innerHTML = html;

  grid.querySelectorAll('.cal-day[data-date]').forEach(el => {
    if (el.dataset.date) el.onclick = () => selectCalendarDay(el.dataset.date);
  });
}

// Выбор дня в календаре (клик по кнопке или навигация стрелками):
// подсветка, roving tabindex, aria-selected, подпись и состояние сохранения.
function selectCalendarDay(dateStr) {
  document.querySelectorAll('.hw-cal-grid button.cal-day').forEach(btn => {
    const isSel = btn.dataset.date === dateStr;
    btn.classList.toggle('selected', isSel);
    btn.setAttribute('aria-selected', isSel ? 'true' : 'false');
    btn.tabIndex = isSel ? 0 : -1;
  });
  document.getElementById('hwDateSelected').textContent = formatDateDisplay(dateStr);
  calState.selectedDate = dateStr;
  updateSaveBtnState();
}

// Клавиатурная навигация по календарю: ←/→ — день, ↑/↓ — неделя,
// Home/End — начало/конец месяца. Enter/Space работают нативно (кнопки).
function onCalGridKeydown(e) {
  const grid = document.getElementById('hwCalGrid');
  const buttons = Array.prototype.slice.call(grid.querySelectorAll('button.cal-day'));
  if (!buttons.length) return;
  const idx = buttons.indexOf(document.activeElement);
  if (idx === -1) return; // фокус не на дне календаря — не перехватываем

  const dayOfMonth = (btn) => Number(btn.dataset.date.split('-')[2]);
  const moveTo = (btn) => {
    btn.focus();
    selectCalendarDay(btn.dataset.date);
  };

  let target = null;
  switch (e.key) {
    case 'ArrowLeft':
      if (idx > 0) target = buttons[idx - 1];
      break;
    case 'ArrowRight':
      if (idx < buttons.length - 1) target = buttons[idx + 1];
      break;
    case 'ArrowUp':
      // Та же колонка неделей выше (грид строго по 7 колонок).
      if (dayOfMonth(buttons[idx]) - 7 >= 1) {
        target = buttons.find(b => dayOfMonth(b) === dayOfMonth(buttons[idx]) - 7) || null;
      }
      break;
    case 'ArrowDown':
      if (dayOfMonth(buttons[idx]) + 7 <= new Date(calState.year, calState.month + 1, 0).getDate()) {
        target = buttons.find(b => dayOfMonth(b) === dayOfMonth(buttons[idx]) + 7) || null;
      }
      break;
    case 'Home':
      target = buttons[0];
      break;
    case 'End':
      target = buttons[buttons.length - 1];
      break;
    default:
      return; // другие клавиши не трогаем
  }
  if (target) {
    e.preventDefault();
    moveTo(target);
  } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' ||
             e.key === 'ArrowUp' || e.key === 'ArrowDown' ||
             e.key === 'Home' || e.key === 'End') {
    e.preventDefault();
  }
}

function formatDateISO(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function formatDateDisplay(str) {
  if (!str) return '—';
  const [y, m, d] = str.split('-');
  return `${d}.${m}.${y}`;
}

// Единый переключатель режима сдачи: ставит radio, показывает/прячет календарь
// и при необходимости рендерит его (иначе при открытии сразу на «Дата»
// календарь мог не появиться).
function setHwDueMode(mode) {
  const dateWrap = document.getElementById('hwDateWrap');
  document.querySelectorAll('input[name="hwDueMode"]').forEach(r => {
    if (r.value === mode) r.checked = true;
  });
  const showDate = mode === 'date';
  dateWrap.classList.toggle('hidden', !showDate);
  if (showDate && !calState.year) {
    const now = new Date();
    calState.year = now.getFullYear();
    calState.month = now.getMonth();
    calState.selectedDate = '';
    renderCalendar(calState.year, calState.month, '');
    const dateSelectedEl = document.getElementById('hwDateSelected');
    if (dateSelectedEl) dateSelectedEl.textContent = '—';
  }
}

// ── Subject+Type encoded option values ────────────────────────
const PV_SEP = '\u0001';
function encodePairValue(s, t, sub) {
  if (sub) return s + PV_SEP + (t || '') + PV_SEP + sub;
  if (t) return s + PV_SEP + t;
  return s;
}
function decodePairValue(v) {
  if (!v || v === '__custom__') return { subject: v, type: '', subgroup: '' };
  const parts = v.split(PV_SEP);
  return { subject: parts[0] || '', type: parts[1] || '', subgroup: parts[2] || '' };
}

// Только название предмета для свёрнутого отображения селекта.
function shortLabel(val) {
  if (!val || val === '__custom__') return 'Другой...';
  return decodePairValue(val).subject;
}

// Возвращает всем опциям полный текст (с типом/подгруппой) — для раскрытого списка.
function restoreFullOptions() {
  const sel = document.getElementById('hwSubject');
  if (!sel) return;
  for (const o of sel.options) {
    if (o.dataset.full) o.textContent = o.dataset.full;
  }
}

// Свёрнутый вид: у выбранной опции показываем только название предмета,
// у остальных — полный текст (он виден при раскрытии списка).
function collapseSelected() {
  const sel = document.getElementById('hwSubject');
  if (!sel) return;
  restoreFullOptions();
  const opt = [...sel.options].find(o => o.value === sel.value);
  if (opt) opt.textContent = shortLabel(sel.value);
}

// Подгруппа сегодняшнего занятия выбранного предмета/типа ("" — если нет).
function getTodaySubgroupFor(subject, pairType) {
  const base = (subject || '').trim().toLowerCase();
  if (!base) return '';
  for (const p of getTodaySubjectPairs()) {
    if (!p.subject || p.subject.trim().toLowerCase() !== base) continue;
    if (pairType && pairType !== 'any' && p.type !== pairType) continue;
    const sub = (p.subgroup || '').replace(/\D/g, '');
    if (sub) return sub;
  }
  return '';
}

// Показывает/прячет селектор подгруппы в зависимости от того, есть ли у
// выбранного предмета+типа разбиение на подгруппы (по loadedSubjects).
// preSubgroup — явно заданная подгруппа (например, с кнопки «+» на паре).
function updateSubgroupVisibility(preSubgroup) {
  const subject = decodePairValue(document.getElementById('hwSubject').value).subject;
  const pairType = document.getElementById('hwPairType').value; // 'any' или код
  const entry = loadedSubjects.find(s => s.subject.toLowerCase() === (subject || '').toLowerCase());

  let available = [];
  if (entry && entry.subgroups) {
    if (!pairType || pairType === 'any') {
      // «Любой» тип пары — подгруппы не показываем, по умолчанию «любая».
      available = [];
    } else {
      available = entry.subgroups[pairType] || [];
    }
  }

  const wrap = document.getElementById('hwSubgroupWrap');
  const sel = document.getElementById('hwSubgroup');

  if (available.length === 0) {
    wrap.classList.add('hidden');
    sel.innerHTML = '<option value="any">Обе подгруппы</option>';
    sel.value = 'any';
    return;
  }

  wrap.classList.remove('hidden');
  sel.innerHTML = '';
  for (const s of available) {
    const o = document.createElement('option');
    o.value = s;
    o.textContent = 'Подгруппа ' + s;
    sel.appendChild(o);
  }
  const anyO = document.createElement('option');
  anyO.value = 'any';
  anyO.textContent = 'Обе подгруппы';
  sel.appendChild(anyO);

  // Приоритет: явно переданная подгруппа (кнопка «+»), иначе — подгруппа
  // сегодняшнего занятия этого предмета/типа, иначе «любая».
  let selected = 'any';
  if (preSubgroup && available.includes(preSubgroup)) {
    selected = preSubgroup;
  } else {
    const todaySub = getTodaySubgroupFor(subject, pairType);
    if (todaySub && available.includes(todaySub)) selected = todaySub;
  }
  sel.value = selected;
}

// ── Homework Modal ────────────────────────────────────────────

function setupHomeworkModal() {
  const modal = document.getElementById('homeworkModal');
  const sel = document.getElementById('hwSubject');
  const customWrap = document.getElementById('hwSubjectCustomWrap');
  const pairTypeWrap = document.getElementById('hwPairTypeWrap');

  document.getElementById('addHomeworkBtn').onclick = (e) => {
    editingHwId = null;
    const cur = getCurrentPair();
    if (cur) {
      const sub = cur.subgroup ? cur.subgroup.replace(/\D/g, '') : '';
      openHwModal(cur.subject, cur.type || '', sub, null, e.currentTarget);
    } else {
      openHwModal(undefined, undefined, undefined, null, e.currentTarget);
    }
  };

  // Кнопка закрытия и клик по фону переопределены ниже (со сбросом состояния удаления).

  // Предмет → управление custom / pairType / subgroup / dueMode
  sel.onchange = () => {
    const val = sel.value;
    if (val === '__custom__') {
      customWrap.classList.remove('hidden');
      pairTypeWrap.classList.add('hidden');
      document.getElementById('hwSubjectCustom').focus();
      // Disable nextPair for custom subjects
      document.querySelectorAll('input[name="hwDueMode"]').forEach(r => {
        if (r.value === 'nextPair') r.disabled = true;
      });
      setHwDueMode('date');
    } else {
      customWrap.classList.add('hidden');
      pairTypeWrap.classList.remove('hidden');
      setPairTypeFromSelected(val);
      document.querySelectorAll('input[name="hwDueMode"]').forEach(r => r.disabled = false);
    }
    const { subgroup: sub } = decodePairValue(val);
    updateSubgroupVisibility(sub || undefined);
  };

  // При раскрытии списка показываем полные подписи (тип/подгруппа),
  // в свёрнутом виде — только название предмета.
  sel.addEventListener('focus', restoreFullOptions);
  sel.addEventListener('mousedown', restoreFullOptions);
  sel.addEventListener('change', collapseSelected);
  sel.addEventListener('blur', collapseSelected);

  // Смена типа пары → пересчёт доступных подгрупп
  document.getElementById('hwPairType').onchange = () => updateSubgroupVisibility();

  // Due mode radio
  document.querySelectorAll('input[name="hwDueMode"]').forEach(r => {
    r.onchange = () => {
      const checked = document.querySelector('input[name="hwDueMode"]:checked');
      if (checked) setHwDueMode(checked.value);
      updateSaveBtnState();
    };
  });

  // Calendar navigation
  document.getElementById('hwCalPrev').onclick = () => {
    const { year, month } = calState;
    const newMonth = month === 0 ? 11 : month - 1;
    const newYear = month === 0 ? year - 1 : year;
    renderCalendar(newYear, newMonth, calState.selectedDate);
    calState.year = newYear;
    calState.month = newMonth;
  };

  document.getElementById('hwCalNext').onclick = () => {
    const { year, month } = calState;
    const newMonth = month === 11 ? 0 : month + 1;
    const newYear = month === 11 ? year + 1 : year;
    renderCalendar(newYear, newMonth, calState.selectedDate);
    calState.year = newYear;
    calState.month = newMonth;
  };

  // Клавиатурная навигация по дням календаря (свойство onkeydown — без дублей).
  document.getElementById('hwCalGrid').onkeydown = onCalGridKeydown;

  // Save
  const deleteBtn = document.getElementById('deleteHomework');
  const deleteConfirm = document.getElementById('deleteConfirm');
  let deleteTimer = null;

  function resetDeleteState() {
    if (deleteTimer) {
      clearInterval(deleteTimer);
      deleteTimer = null;
    }
    deleteConfirm.classList.remove('confirming');
    document.getElementById('deleteWarning').classList.add('hidden');
    deleteBtn.textContent = 'Удалить';
    deleteBtn.disabled = false;
  }

  document.getElementById('saveHomework').onclick = async () => {
    const isCustom = sel.value === '__custom__';
    const subject = isCustom
      ? document.getElementById('hwSubjectCustom').value.trim()
      : decodePairValue(sel.value).subject;

    if (!subject) return;

    const taskEl = document.getElementById('hwTask');
    const task = taskEl.value.trim();
    const taskError = document.getElementById('hwTaskError');
    if (!task) {
      taskError.classList.remove('hidden');
      taskEl.focus();
      return;
    }
    taskError.classList.add('hidden');

    const author = document.getElementById('hwAuthor').value.trim();

    // Определяем dueMode
    const modeRadio = document.querySelector('input[name="hwDueMode"]:checked');
    const dueMode = modeRadio ? modeRadio.value : 'date';
    const dueDate = calState.selectedDate;
    let pairType = document.getElementById('hwPairType').value;
    const subgroup = document.getElementById('hwSubgroup').value || 'any';

    if (!isCustom) {
      // При выборе из select — pairType уже правильно установлен в onchange/onmount
    }

    if (author) localStorage.setItem('hwAuthor', author);

    const saveBtn = document.getElementById('saveHomework');
    const originalLabel = saveBtn.textContent;
    saveBtn.disabled = true;
    saveBtn.innerHTML = '<span class="spinner"></span>Сохранение…';

    try {
      let result;
      if (editingHwId) {
        result = await apiPut('/api/hw', {
          id: editingHwId,
          group: state.group,
          subject,
          pairType,
          subgroup,
          task,
          dueMode,
          dueDate,
          author,
        });
        const idx = state.homework.findIndex(h => h.id === editingHwId);
        if (idx >= 0) state.homework[idx] = result.item;
      } else {
        result = await apiPost('/api/hw', {
          group: state.group,
          subject: isCustom ? subject : subject,
          pairType,
          subgroup,
          task,
          dueMode,
          dueDate,
          author,
        });
        state.homework.push(result.item);
      }
      editingHwId = null;
      originalHwFields = null;
      renderHomework();
      if (state.schedule) renderDayTabs();
      resetDeleteState();
      closeModal(modal);
      invalidateHwCache(); // ДЗ изменилось — сбрасываем клиентский кеш
    } catch (e) {
      console.warn('HW save failed:', e.message);
      showToast('Не удалось сохранить ДЗ: ' + (e.message || 'ошибка сети'), 'error');
      saveBtn.disabled = false;
      saveBtn.textContent = originalLabel;
    } finally {
      saveBtn.disabled = false;
      if (saveBtn.querySelector('.spinner')) {
        saveBtn.textContent = editingHwId ? 'Сохранить' : 'Добавить';
      }
    }
  };

  // Delete (только в режиме редактирования)
  deleteBtn.onclick = () => {
    if (deleteBtn.textContent === 'Удалить') {
      deleteConfirm.classList.add('confirming');
      document.getElementById('deleteWarning').classList.remove('hidden');
      deleteBtn.disabled = true;
      let remaining = 5;
      deleteBtn.textContent = 'Подтвердить удаление (' + remaining + ')';
      deleteTimer = setInterval(() => {
        remaining -= 1;
        if (remaining <= 0) {
          clearInterval(deleteTimer);
          deleteTimer = null;
          deleteBtn.disabled = false;
          deleteBtn.textContent = 'Подтвердить удаление';
        } else {
          deleteBtn.textContent = 'Подтвердить удаление (' + remaining + ')';
        }
      }, 1000);
    } else if (deleteBtn.textContent === 'Подтвердить удаление') {
      doDelete();
    } else {
      resetDeleteState();
    }
  };

  async function doDelete() {
    if (!editingHwId) return;
    const id = editingHwId;
    deleteBtn.disabled = true;
    const originalLabel = deleteBtn.textContent;
    deleteBtn.innerHTML = '<span class="spinner"></span>Удаление…';
    try {
      await apiDelete('/api/hw', { id, group: state.group });
      state.homework = state.homework.filter(h => h.id !== id);
      editingHwId = null;
      originalHwFields = null;
      renderHomework();
      if (state.schedule) renderDayTabs();
      resetDeleteState(); // не оставляем визуал подтверждения удаления на след. раз
      closeModal(modal);
      invalidateHwCache(); // ДЗ изменилось — сбрасываем клиентский кеш
    } catch (e) {
      console.warn('HW delete failed:', e.message);
      showToast('Не удалось удалить ДЗ: ' + (e.message || 'ошибка сети'), 'error');
      deleteBtn.disabled = false;
      deleteBtn.textContent = originalLabel;
    }
  }

  // Сбрасываем состояние удаления при любом закрытии модалки
  document.getElementById('closeHomework').onclick = () => {
    editingHwId = null;
    originalHwFields = null;
    resetDeleteState();
    closeModal(modal);
  };
  const prevModalClick = modal.onclick;
  modal.onclick = (e) => {
    if (e.target === modal) {
      editingHwId = null;
      originalHwFields = null;
      resetDeleteState();
      closeModal(modal);
    }
    if (prevModalClick) prevModalClick(e);
  };
}

function populatePairTypeSelect(subject) {
  const sel = document.getElementById('hwPairType');
  sel.innerHTML = '';
  const entry = loadedSubjects.find(s => s.subject.toLowerCase() === (subject || '').toLowerCase());
  const types = entry ? entry.pairTypes.filter(t => ALLOWED_PAIR_TYPES.includes(t)) : [];
  for (const t of types) {
    const o = document.createElement('option');
    o.value = t;
    o.textContent = (PAIR_TYPE_NAMES[t] || t) + ' (' + t + '.)';
    sel.appendChild(o);
  }
  const anyO = document.createElement('option');
  anyO.value = 'any';
  anyO.textContent = 'Любой';
  sel.appendChild(anyO);
}

function setPairTypeFromSelected(val) {
  const sel = document.getElementById('hwPairType');
  const { subject: rawSubject, type: explicitType } = decodePairValue(val);
  populatePairTypeSelect(rawSubject);
  sel.disabled = false;
  if (val === '__custom__') {
    sel.value = 'any';
    return;
  }
  if (explicitType && ALLOWED_PAIR_TYPES.includes(explicitType)) {
    let opt = [...sel.options].find(o => o.value === explicitType);
    if (!opt) {
      opt = document.createElement('option');
      opt.value = explicitType;
      opt.textContent = (PAIR_TYPE_NAMES[explicitType] || explicitType) + ' (' + explicitType + '.)';
      sel.insertBefore(opt, sel.querySelector('option[value="any"]'));
    }
    sel.value = explicitType;
  } else {
    const todayPairs = getTodaySubjectPairs();
    const match = todayPairs.find(p => p.subject.toLowerCase() === rawSubject.toLowerCase() && p.type);
    if (match && ALLOWED_PAIR_TYPES.includes(match.type)) {
      let opt = [...sel.options].find(o => o.value === match.type);
      if (!opt) {
        opt = document.createElement('option');
        opt.value = match.type;
        opt.textContent = (PAIR_TYPE_NAMES[match.type] || match.type) + ' (' + match.type + '.)';
        sel.insertBefore(opt, sel.querySelector('option[value="any"]'));
      }
      sel.value = match.type;
    } else {
      sel.value = 'any';
    }
  }
}

function openHwModal(preSubject, prePairType, preSubgroup, existingHw, originEl) {
  const modal = document.getElementById('homeworkModal');
  const sel = document.getElementById('hwSubject');
  const customWrap = document.getElementById('hwSubjectCustomWrap');
  const pairTypeWrap = document.getElementById('hwPairTypeWrap');
  const titleEl = modal.querySelector('.modal-header h2');

  editingHwId = existingHw ? existingHw.id : null;
  titleEl.textContent = existingHw ? 'Редактировать задание' : 'Новое задание';
  const saveBtn = document.getElementById('saveHomework');
  saveBtn.disabled = false;
  saveBtn.textContent = existingHw ? 'Сохранить' : 'Добавить';
  const deleteBtn = document.getElementById('deleteHomework');
  const deleteConfirm = document.getElementById('deleteConfirm');
  // Сброс состояния удаления — могло остаться от предыдущего открытия
  // (doDelete закрывает модалку без resetDeleteState).
  deleteConfirm.classList.add('hidden');
  deleteConfirm.classList.remove('confirming');
  document.getElementById('deleteWarning').classList.add('hidden');
  deleteBtn.textContent = 'Удалить';
  deleteBtn.disabled = false;
  if (existingHw) {
    deleteConfirm.classList.remove('hidden');
  } else {
    deleteBtn.disabled = true;
  }

  // Build subject list from loadedSubjects + today + current schedule
  sel.innerHTML = '';

  const todayPairs = getTodaySubjectPairs();
  if (todayPairs.length) {
    const og = document.createElement('optgroup');
    og.label = 'Сегодня';
    for (const p of todayPairs) {
      const o = document.createElement('option');
      const typeHint = p.type ? ' (' + (PAIR_TYPE_NAMES[p.type] || p.type) + ')' : '';
      const subNum = (p.subgroup || '').replace(/\D/g, '');
      const subHint = subNum ? ' · ' + subNum + ' подгр.' : '';
      o.value = encodePairValue(p.subject, p.type, subNum || undefined);
      o.textContent = p.subject + typeHint + subHint;
      o.dataset.full = o.textContent;
      og.appendChild(o);
    }
    sel.appendChild(og);
  }

  // Все предметы из loadedSubjects (кроме тех, что сегодня)
  const todayBases = new Set(todayPairs.map(p => p.subject));
  const allItems = loadedSubjects.filter(s => !todayBases.has(s.subject));
  if (allItems.length) {
    const og = document.createElement('optgroup');
    og.label = 'Все предметы';
    for (const s of allItems) {
      const o = document.createElement('option');
      o.value = s.subject;
      const typeHint = s.pairTypes.length ? ' (' + s.pairTypes.join(', ') + ')' : '';
      o.textContent = s.subject + typeHint;
      o.dataset.full = o.textContent;
      og.appendChild(o);
    }
    sel.appendChild(og);
  }

  // Другой
  const co = document.createElement('option');
  co.value = '__custom__';
  co.textContent = 'Другой...';
  co.dataset.full = 'Другой...';
  sel.appendChild(co);

  // Preselect
  if (existingHw) {
    const match = loadedSubjects.find(s => s.subject.toLowerCase() === (existingHw.subject || '').toLowerCase());
    const todayMatch = todayPairs.find(p => {
      if (p.subject.toLowerCase() !== existingHw.subject.toLowerCase()) return false;
      if (existingHw.pairType && existingHw.pairType !== 'any' && p.type !== existingHw.pairType) return false;
      const pSub = (p.subgroup || '').replace(/\D/g, '');
      const hwSub = (existingHw.subgroup || '').replace(/\D/g, '');
      if (hwSub && pSub && pSub !== hwSub) return false;
      return true;
    });
    if (todayMatch) {
      const subNum = (todayMatch.subgroup || '').replace(/\D/g, '');
      sel.value = encodePairValue(todayMatch.subject, todayMatch.type, subNum || undefined);
    } else if (match) {
      sel.value = match.subject;
    } else {
      sel.value = '__custom__';
      customWrap.classList.remove('hidden');
      document.getElementById('hwSubjectCustom').value = existingHw.subject;
    }
    pairTypeWrap.classList.remove('hidden');
    setPairTypeFromSelected(sel.value === '__custom__' ? '' : sel.value);
    document.getElementById('hwPairType').value = (existingHw.pairType && existingHw.pairType !== 'any') ? existingHw.pairType : 'any';
    document.getElementById('hwSubgroup').value = (existingHw.subgroup && existingHw.subgroup !== 'any') ? existingHw.subgroup : 'any';

    document.getElementById('hwTask').value = existingHw.task || '';
    document.getElementById('hwTaskError').classList.add('hidden');
    document.getElementById('hwAuthor').value = existingHw.author || '';

    document.querySelectorAll('input[name="hwDueMode"]').forEach(r => r.disabled = false);
    if (existingHw.dueMode === 'date' && existingHw.dueDate) {
      // Календарь всегда открывается на текущем месяце (сброс при переоткрытии),
      // но сохраняем выбранную дату для подсветки.
      const now = new Date();
      calState.year = now.getFullYear();
      calState.month = now.getMonth();
      calState.selectedDate = existingHw.dueDate;
      renderCalendar(calState.year, calState.month, existingHw.dueDate);
      document.getElementById('hwDateSelected').textContent = existingHw.dueDate;
    }
    setHwDueMode(existingHw.dueMode === 'date' ? 'date' : 'nextPair');

    updateSubgroupVisibility(existingHw.subgroup);
    originalHwFields = getHwFormValues();
    saveBtn.disabled = true;
  } else if (preSubject) {
    originalHwFields = null;
    const match = loadedSubjects.find(s => s.subject.toLowerCase() === preSubject.toLowerCase());
    const todayMatch = todayPairs.find(p => {
      if (p.subject.toLowerCase() !== preSubject.toLowerCase()) return false;
      if (prePairType && prePairType !== 'any' && p.type !== prePairType) return false;
      const pSub = (p.subgroup || '').replace(/\D/g, '');
      const preSub = (preSubgroup || '').replace(/\D/g, '');
      if (preSub && pSub && pSub !== preSub) return false;
      return true;
    });
    if (todayMatch) {
      const subNum = (todayMatch.subgroup || '').replace(/\D/g, '');
      sel.value = encodePairValue(todayMatch.subject, todayMatch.type, subNum || undefined);
    } else if (match) {
      sel.value = match.subject;
      setPairTypeFromSelected(match.subject);
      if (prePairType && prePairType !== 'any') {
        document.getElementById('hwPairType').value = prePairType;
        document.getElementById('hwPairType').disabled = false;
      }
    } else {
      // custom
      sel.value = '__custom__';
      customWrap.classList.remove('hidden');
      document.getElementById('hwSubjectCustom').value = preSubject;
    }

    if (sel.value !== '__custom__') {
      pairTypeWrap.classList.remove('hidden');
    }

    // Сброс form
    document.getElementById('hwTask').value = '';
    document.getElementById('hwTaskError').classList.add('hidden');
    document.getElementById('hwAuthor').value = localStorage.getItem('hwAuthor') || '';

    // Due mode
    document.querySelectorAll('input[name="hwDueMode"]').forEach(r => r.disabled = false);
    if (sel.value === '__custom__') {
      document.querySelectorAll('input[name="hwDueMode"]').forEach(r => {
        if (r.value === 'nextPair') r.disabled = true;
      });
    }
    setHwDueMode(sel.value === '__custom__' ? 'date' : 'nextPair');

    // Calendar init
    const today = new Date();
    calState.year = today.getFullYear();
    calState.month = today.getMonth();
    calState.selectedDate = '';
    renderCalendar(calState.year, calState.month, '');
    document.getElementById('hwDateSelected').textContent = '—';

    if (preSubject && prePairType) {
      const preSub = (preSubgroup || '').replace(/\D/g, '') || undefined;
      setPairTypeFromSelected(encodePairValue(preSubject, prePairType, preSub));
      if (prePairType !== 'any') {
        document.getElementById('hwPairType').value = prePairType;
      }
    }

    // Подгруппы: показываем только если у предмета+типа есть разбиение,
    // авто-выбираем подгруппу сегодняшнего занятия (или переданную с кнопки «+»).
    updateSubgroupVisibility(preSubgroup);
  } else {
    originalHwFields = null;
    sel.value = todayPairs.length ? encodePairValue(todayPairs[0].subject, todayPairs[0].type, (todayPairs[0].subgroup || '').replace(/\D/g, '') || undefined) : (allItems.length ? allItems[0].subject : '__custom__');
    if (sel.value !== '__custom__') {
      customWrap.classList.add('hidden');
      setPairTypeFromSelected(sel.value);
    } else {
      customWrap.classList.remove('hidden');
      pairTypeWrap.classList.add('hidden');
    }

    if (sel.value !== '__custom__') {
      pairTypeWrap.classList.remove('hidden');
    }

    // Сброс form
    document.getElementById('hwTask').value = '';
    document.getElementById('hwTaskError').classList.add('hidden');
    document.getElementById('hwAuthor').value = localStorage.getItem('hwAuthor') || '';

    // Due mode
    document.querySelectorAll('input[name="hwDueMode"]').forEach(r => r.disabled = false);
    if (sel.value === '__custom__') {
      document.querySelectorAll('input[name="hwDueMode"]').forEach(r => {
        if (r.value === 'nextPair') r.disabled = true;
      });
    }
    setHwDueMode(sel.value === '__custom__' ? 'date' : 'nextPair');

    // Calendar init
    const today = new Date();
    calState.year = today.getFullYear();
    calState.month = today.getMonth();
    calState.selectedDate = '';
    renderCalendar(calState.year, calState.month, '');
    document.getElementById('hwDateSelected').textContent = '—';

    // Подгруппы
    updateSubgroupVisibility(preSubgroup);
  }

  const watchEls = [sel, document.getElementById('hwPairType'),
    document.getElementById('hwSubgroup'), document.getElementById('hwTask'),
    document.getElementById('hwAuthor'), document.getElementById('hwSubjectCustom')];
  watchEls.forEach(el => {
    el.addEventListener('input', updateSaveBtnState);
    el.addEventListener('change', updateSaveBtnState);
  });

  openModal(modal, originEl);
  collapseSelected();
  document.getElementById('hwTask').focus();
}

// ── Homework (API) ────────────────────────────────────────────

async function loadHomework() {
  // Сначала кеш (TTL 5 мин) — экономия /api/hw при повторных открытиях.
  const cached = loadHwFromCache();
  if (cached) {
    state.homework = cached;
    renderHomework();
    refreshScheduleView();
    return;
  }
  try {
    state.homework = await apiFetch('/api/hw', { group: state.group });
    saveHwToCache(state.homework);
  } catch (e) {
    console.warn('HW load failed:', e.message);
    state.homework = [];
  }
  renderHomework();
  refreshScheduleView();
}

// Перерисовывает текущий день расписания (вместе с ДЗ) после изменения
// списка ДЗ, чтобы домашка появилась в списке пар без переключения дня/недели.
function refreshScheduleView() {
  if (state.schedule && state.selectedDay) {
    renderDaySchedule(state.selectedDay);
  }
}

// Возвращает сегодняшние пары, совпадающие с ДЗ по предмету/типу/подгруппе.
function getTodayPairsForHw(hw) {
  const sched = getCurrentWeekSchedule();
  if (!sched) return [];
  const todayName = DAY_NAMES[new Date().getDay() === 0 ? 6 : new Date().getDay() - 1];
  const day = sched.days[todayName];
  if (!day) return [];
  const base = (hw.subject || '').trim().toLowerCase();
  const hwType = hw.pairType || 'any';
  const hwSub = (hw.subgroup || 'any').replace(/\D/g, '');
  return day.pairs.filter(p => {
    if (!p.subject) return false;
    if ((p.subject || '').trim().toLowerCase() !== base) return false;
    if (hwType !== 'any' && hwType !== (p.type || '')) return false;
    const pSub = (p.subgroup || '').replace(/\D/g, '');
    if (hwSub && pSub && hwSub !== pSub) return false;
    if (hwSub && !pSub) return false;
    return true;
  });
}

// true, если все совпадающие с ДЗ пары сегодня уже закончились
// (прошло >= 90 минут с начала каждой).
function isHwPairFinished(hw) {
  const pairs = getTodayPairsForHw(hw);
  if (pairs.length === 0) return false;
  if (!pairs.every(p => !!p.time)) return false;
  const now = new Date();
  const nowMin = now.getHours() * 60 + now.getMinutes();
  return pairs.every(p => {
    const [h, m] = p.time.split(':').map(Number);
    const startMin = h * 60 + m;
    return nowMin >= startMin + 90;
  });
}

function renderHomework() {
  const list = document.getElementById('homeworkList');
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const sorted = [...state.homework].sort((a, b) => {
    if (!a.dueDate) return 1;
    if (!b.dueDate) return -1;
    return new Date(a.dueDate) - new Date(b.dueDate);
  });

   // Просроченные ДЗ убираем из общего списка внизу. Их всё ещё можно увидеть
   // на дне сдачи — при переходе на прошедший день через расписание.
   const f = state.subgroupFilter || 'any';
    const visible = sorted.filter(hw => {
      // Выполненное ДЗ скрываем из нижнего списка (но оно остаётся в меню дней).
      if (doneHwIds.has(hw.id)) return false;
      // Фильтр подгруппы — проверяем ПЕРВЫМ делом (до dueDate),
      // иначе ДЗ без даты всегда проходит мимо фильтра.
      if (f !== 'any') {
        const hwSub = hw.subgroup || 'any';
        if (hwSub !== 'any' && hwSub !== f) return false;
      }
      if (!hw.dueDate) return true;
       const due = new Date(hw.dueDate);
       due.setHours(0, 0, 0, 0);
       if (due < today) return false;
       // Сегодняшнее ДЗ на пару, которая уже прошла (>= 1.5ч с начала) — скрываем.
       if (due.getTime() === today.getTime() && isHwPairFinished(hw)) return false;
      return true;
    });

  if (visible.length === 0) {
    list.innerHTML = '<div class="no-homework">Нет заданий</div>';
    return;
  }

  list.innerHTML = visible.map(hw => {
    let cardClass = '';
    let dueClass = '';
    let dueText = '';

    if (hw.dueDate) {
      const due = new Date(hw.dueDate);
      due.setHours(0, 0, 0, 0);
      const diff = Math.ceil((due - today) / 86400000);

      if (diff < 0) {
        cardClass = 'overdue';
        dueClass = 'overdue';
        dueText = 'Просрочено (' + escHtml(hw.dueDate) + ')';
      } else if (diff === 0) {
        cardClass = 'due-soon';
        dueText = 'Сегодня!';
      } else if (diff <= 2) {
        cardClass = 'due-soon';
        dueText = 'Через ' + diff + ' дн. (' + escHtml(hw.dueDate) + ')';
      } else {
        dueText = escHtml(hw.dueDate);
      }
    } else if (hw.dueMode === 'nextPair') {
      dueText = 'Следующая пара';
    }

    const authorHtml = hw.author
      ? '<div class="hw-author">— ' + escHtml(hw.author) + '</div>'
      : '';

    const subjectHtml = escHtml(hw.subject) +
      (hw.pairType && hw.pairType !== 'any' ? ' <span class="hw-pair-type">(' + escHtml(hw.pairType) + ')</span>' : '') +
      (hw.subgroup && hw.subgroup !== 'any' ? ' <span class="hw-pair-type">· подгруппа ' + escHtml(hw.subgroup) + '</span>' : '');

    return `
      <div class="hw-card ${cardClass}">
        <div class="hw-info">
          <div class="hw-subject">${subjectHtml}</div>
           <div class="hw-task">${hwTaskMarkup(hw.task, '', hw.id)}</div>
           ${dueText ? `<div class="hw-due ${dueClass}">${dueText}</div>` : ''}
           ${authorHtml}
         </div>
        <div class="hw-actions">
            <button class="hw-done" data-id="${escHtml(hw.id)}" title="Отметить выполненным"><svg class="icon" style="width:18px;height:18px"><use href="#icon-check"></use></svg></button>
            ${isWriter() ? `<button class="hw-edit" data-id="${escHtml(hw.id)}" title="Редактировать"><svg class="icon" style="width:18px;height:18px"><use href="#icon-pencil"></use></svg></button>` : ''}
        </div>
      </div>`;
   }).join('');

   attachHwViewLinks(list);

   list.querySelectorAll('.hw-done').forEach(btn => {
     btn.onclick = () => {
       doneHwIds.add(btn.dataset.id);
       saveDoneHw();
       // Убираем карточку из списка точечно (и обновляем день, если виден) —
       // без полного перерендера, чтобы не терялись фокус и скролл.
       updateHwDoneState(btn.dataset.id);
     };
   });

    list.querySelectorAll('.hw-edit').forEach(btn => {
      btn.onclick = () => {
        const hw = state.homework.find(h => h.id === btn.dataset.id);
        if (hw) openHwModal(null, null, null, hw, btn);
      };
    });
}

// ── Settings Modal ────────────────────────────────────────────

// ── Telegram notifications UI ──────────────────────────────────

// Рендер статуса из уже известного state (без запроса).
// Актуализация через settings refresh (setupSettingsModal).
function setupTgSection() {
  const statusEl = document.getElementById('tgStatus');
  const linkEl = document.getElementById('tgBotLink');

  if (state.tgBotUsername) {
    linkEl.href = 'https://t.me/' + state.tgBotUsername;
    linkEl.textContent = '@' + state.tgBotUsername;
  } else {
    linkEl.textContent = '(бот не настроен)';
  }

  function renderTgStatus() {
    if (state.tgChatId) {
      const subLabel = state.tgSubgroup === '1' ? 'подгруппа 1'
        : state.tgSubgroup === '2' ? 'подгруппа 2'
        : 'обе подгруппы';
      statusEl.innerHTML = '<svg class="icon inline-icon"><use href="#icon-check-circle"></use></svg> Уведомления включены — ' + escHtml(state.group) + ', ' + escHtml(subLabel);
      statusEl.className = 'tg-status tg-ok';
    } else {
      statusEl.innerHTML = '<svg class="icon inline-icon"><use href="#icon-info"></use></svg> Уведомления не настроены';
      statusEl.className = 'tg-status';
    }
  }

  renderTgStatus();
}
setupTgSection._refresh = function () {
  const statusEl = document.getElementById('tgStatus');
  if (!statusEl) return;
  if (state.tgChatId) {
    const subLabel = state.tgSubgroup === '1' ? 'подгруппа 1'
      : state.tgSubgroup === '2' ? 'подгруппа 2'
      : 'обе подгруппы';
    statusEl.innerHTML = '<svg class="icon inline-icon"><use href="#icon-check-circle"></use></svg> Уведомления включены — ' + escHtml(state.group) + ', ' + escHtml(subLabel);
    statusEl.className = 'tg-status tg-ok';
  } else {
    statusEl.innerHTML = '<svg class="icon inline-icon"><use href="#icon-info"></use></svg> Уведомления не настроены';
    statusEl.className = 'tg-status';
  }
};

// ── Invite links UI (writer/owner) ────────────────────────────
// Видно только когда isWriter(). Содержит:
//  - кнопку «Создать ссылку-приглашение» (writer и owner)
//  - список активных ссылок с кнопками «Отозвать»
// Права владельца (owner) получают через ссылку #owner=<code> (legacy — ?owner=<code>)
// либо ручным вводом кода в настройках (см. becomeOwner / consumeOwnerCodeFromUrl).
// Новые ссылки генерируются только в #-формате; legacy query-формат — только для
// уже выданных ссылок (логируется console.warn).

function setupInviteSection() {
  const section = document.getElementById('inviteSection');
  if (!section) return;

  const createBtn = document.getElementById('inviteCreateBtn');
  const inviteLabelInput = document.getElementById('inviteLabelInput');
  const inviteMsg = document.getElementById('inviteMsg');
  const listEl = document.getElementById('inviteList');

  // ── Создать ссылку-приглашение ──
  function showInviteLink(link) {
    inviteMsg.innerHTML = '<svg class="icon inline-icon"><use href="#icon-check-circle"></use></svg> Ссылка готова: <a href="' + escHtml(link) + '" target="_blank" rel="noopener">' + escHtml(link) + '</a> ' +
      '<button id="copyInviteBtn" class="btn-secondary">Копировать</button>';
    inviteMsg.className = 'invite-msg tg-ok';
    const cp = document.getElementById('copyInviteBtn');
    if (cp) cp.onclick = () => copyToClipboard(link, 'Ссылка скопирована');
  }

  if (createBtn) createBtn.onclick = async () => {
    if (!isOwner()) {
      showToast('Создавать ссылки может только владелец', 'warn');
      return;
    }
    createBtn.disabled = true;
    try {
      const label = (inviteLabelInput.value || '').trim();
      const resp = await apiPost('/api/invite/create', { group: state.group, label });
      showInviteLink(resp.link);
      inviteLabelInput.value = '';
      if (setupInviteSection._loadInvites) setupInviteSection._loadInvites();
    } catch (e) {
      inviteMsg.textContent = 'Ошибка: ' + (e.message || 'не удалось создать ссылку');
      inviteMsg.className = 'invite-msg tg-warn';
    } finally {
      createBtn.disabled = false;
    }
  };

  // ── Загрузить список ссылок ──
  async function loadInvites() {
    if (!isWriter()) { listEl.innerHTML = '<div class="no-homework">Нет доступа</div>'; return; }
    try {
      const data = await apiFetch('/api/invite', { group: state.group });
      if (!data.items || data.items.length === 0) {
        listEl.innerHTML = '<div class="no-homework">Нет активных ссылок</div>';
        return;
      }
      listEl.innerHTML = data.items.map(it => {
        const created = it.createdAt ? formatDateTime(it.createdAt) : '';
        const label = it.label ? escHtml(it.label) : '';
        return `
          <div class="invite-item" data-id="${escHtml(it.id)}">
            <div class="invite-meta">
              <button type="button" class="invite-id invite-copy" title="Нажмите, чтобы скопировать ссылку">#${escHtml(it.id)}</button>
              <span class="invite-label-text">${label || '<i>без названия</i>'}</span>
              <span class="invite-date">${created}</span>
            </div>
            <div class="invite-actions">
              <button class="rename-btn" data-id="${escHtml(it.id)}" title="Переименовать"><svg class="icon" style="width:16px;height:16px"><use href="#icon-pencil"></use></svg></button>
              <button class="revoke-btn" data-id="${escHtml(it.id)}" title="Отозвать">Отозвать</button>
            </div>
            <div class="rename-wrap hidden" data-id="${escHtml(it.id)}">
              <input type="text" class="rename-input" placeholder="Новое название" value="${label}">
              <button class="save-rename-btn btn-secondary" data-id="${escHtml(it.id)}">Сохранить</button>
              <button class="cancel-rename-btn btn-secondary" data-id="${escHtml(it.id)}">Отмена</button>
            </div>
          </div>`;
      }).join('');

      // Отозвать
      listEl.querySelectorAll('.revoke-btn').forEach(btn => {
        btn.onclick = async () => {
          const id = btn.dataset.id;
          btn.disabled = true;
          try {
            await apiDelete('/api/invite', { id, group: state.group });
            showToast('Ссылка отозвана', 'ok');
            if (setupInviteSection._loadInvites) setupInviteSection._loadInvites();
          } catch (e) {
            inviteMsg.textContent = 'Ошибка отзыва: ' + (e.message || 'не удалось отозвать');
            inviteMsg.className = 'invite-msg tg-warn';
            btn.disabled = false;
          }
        };
      });

      // Копировать ссылку по клику на id
      listEl.querySelectorAll('.invite-copy').forEach(el => {
        el.onclick = () => copyInviteLink(el);
      });

      // Переименовать — показать inline-поле
      listEl.querySelectorAll('.rename-btn').forEach(btn => {
        btn.onclick = () => {
          const id = btn.dataset.id;
          const row = listEl.querySelector(`.invite-item[data-id="${cssEscape(id)}"]`);
          if (!row) return;
          row.querySelector('.invite-meta').style.display = 'none';
          row.querySelector('.invite-actions').style.display = 'none';
          const wrap = row.querySelector(`.rename-wrap[data-id="${cssEscape(id)}"]`);
          wrap.classList.remove('hidden');
          wrap.querySelector('.rename-input').focus();
        };
      });

      // Отмена переименования
      listEl.querySelectorAll('.cancel-rename-btn').forEach(btn => {
        btn.onclick = () => {
          const id = btn.dataset.id;
          const row = listEl.querySelector(`.invite-item[data-id="${cssEscape(id)}"]`);
          if (!row) return;
          row.querySelector('.invite-meta').style.display = '';
          row.querySelector('.invite-actions').style.display = '';
          row.querySelector(`.rename-wrap[data-id="${cssEscape(id)}"]`).classList.add('hidden');
        };
      });

      // Сохранить переименование
      listEl.querySelectorAll('.save-rename-btn').forEach(btn => {
        btn.onclick = async () => {
          const id = btn.dataset.id;
          const row = listEl.querySelector(`.invite-item[data-id="${cssEscape(id)}"]`);
          if (!row) return;
          const newLabel = row.querySelector('.rename-input').value.trim();
          btn.disabled = true;
          try {
            await apiPut('/api/invite', { id, group: state.group, label: newLabel });
            showToast('Название обновлено', 'ok');
            if (setupInviteSection._loadInvites) setupInviteSection._loadInvites();
          } catch (e) {
            inviteMsg.textContent = 'Ошибка переименования: ' + (e.message || 'не удалось переименовать');
            inviteMsg.className = 'invite-msg tg-warn';
            btn.disabled = false;
          }
        };
      });
    } catch (e) {
      listEl.innerHTML = '<div class="no-homework">Ошибка загрузки: ' + escHtml(e.message) + '</div>';
    }
  }

  // Экспортируем для вызова извне (refresh при открытии настроек).
  setupInviteSection._loadInvites = loadInvites;
  setupInviteSection._refresh = () => {
    // Секция приглашений доступна ТОЛЬКО владельцу (owner).
    // Writer вообще не взаимодействует со ссылками — только редактирует
    // расписание и ДЗ. Поэтому для writer/reader секция скрыта.
    const show = isOwner();
    section.style.display = show ? '' : 'none';
    section.classList.toggle('is-owner', show);
    // Разделитель перед секцией прячем вместе с ней, чтобы у не-владельца
    // не оставалось «пустой» линии-разделителя в настройках.
    const divider = document.getElementById('inviteDivider');
    if (divider) divider.style.display = show ? '' : 'none';
    if (show) loadInvites();
  };
}

// ── Объявления (колокольчик в шапке) ────────────────────────────
//
// Глобальные объявления owner'а: GET /api/announcements публичный
// (CDN-кеш), POST/PUT/DELETE — только owner. Непрочитанность считается
// ЛОКАЛЬНО: в localStorage храним метку announcementsLastSeen —
// createdAt/updatedAt самого свежего просмотренного объявления. Красная
// точка горит, пока есть объявление новее метки; открытие модалки
// помечает всё просмотренным.

const ANN_SEEN_KEY = 'announcementsLastSeen';
let editingAnnouncementId = null;

// Метка «новизны» объявления: правка (updatedAt) делает его непрочитанным снова.
function announcementItemTs(it) {
  return it.updatedAt || it.createdAt || '';
}

function loadAnnouncementsSeen() {
  try { return localStorage.getItem(ANN_SEEN_KEY) || ''; } catch (e) { return ''; }
}

function saveAnnouncementsSeen(ts) {
  try { localStorage.setItem(ANN_SEEN_KEY, ts); } catch (e) { /* квота — игнорируем */ }
}

function updateAnnouncementsBadge() {
  const dot = document.getElementById('bellDot');
  if (!dot) return;
  const seen = loadAnnouncementsSeen();
  const hasNew = state.announcements.some((it) => announcementItemTs(it) > seen);
  dot.classList.toggle('hidden', !hasNew);
}

// Фоновая проверка при загрузке страницы (fire-and-forget): зажигаем точку,
// не открывая модалку. Ошибка сети/воркера — точка просто не зажжётся.
async function refreshAnnouncementsBadge() {
  try {
    const res = await apiFetch('/api/announcements');
    state.announcements = Array.isArray(res.items) ? res.items : [];
    updateAnnouncementsBadge();
  } catch (e) {
    console.warn('[announcements] badge refresh failed:', e.message);
  }
}

function resetAnnouncementForm() {
  editingAnnouncementId = null;
  const ta = document.getElementById('announcementText');
  const saveBtn = document.getElementById('saveAnnouncement');
  const cancelBtn = document.getElementById('cancelAnnouncementEdit');
  if (ta) ta.value = '';
  if (saveBtn) saveBtn.textContent = 'Опубликовать';
  if (cancelBtn) cancelBtn.classList.add('hidden');
}

function renderAnnouncements() {
  const listEl = document.getElementById('announcementList');
  if (!listEl) return;

  if (!state.announcements.length) {
    listEl.innerHTML = '<div class="announcement-empty">Объявлений нет</div>';
    return;
  }

  const seen = loadAnnouncementsSeen();
  listEl.innerHTML = state.announcements.map((it) => {
    const isNew = announcementItemTs(it) > seen;
    const date = it.createdAt ? formatDateTime(it.createdAt) : '';
    const edited = it.updatedAt
      ? '<span class="announcement-edited">изменено ' + escHtml(formatDateTime(it.updatedAt)) + '</span>'
      : '';
    // Кнопки управления — только для owner (сервер всё равно отклонит
    // чужие POST/PUT/DELETE, здесь лишь косметика интерфейса).
    const actions = isOwner()
      ? '<span class="announcement-actions">' +
        '<button type="button" class="icon-btn ann-edit" data-id="' + escHtml(it.id) + '" title="Редактировать" data-anim="scale"><svg class="icon"><use href="#icon-pencil"></use></svg></button>' +
        '<button type="button" class="icon-btn ann-delete" data-id="' + escHtml(it.id) + '" title="Удалить" data-anim="scale"><svg class="icon"><use href="#icon-trash-2"></use></svg></button>' +
        '</span>'
      : '';
    return (
      '<div class="announcement-item' + (isNew ? ' is-new' : '') + '">' +
        '<div class="announcement-text">' + escHtml(it.text) + '</div>' +
        '<div class="announcement-meta">' +
          '<span>' + escHtml(date) + '</span>' + edited + actions +
        '</div>' +
      '</div>'
    );
  }).join('');

  listEl.querySelectorAll('.ann-edit').forEach((btn) => {
    btn.onclick = () => {
      const item = state.announcements.find((a) => a.id === btn.dataset.id);
      if (!item) return;
      editingAnnouncementId = item.id;
      document.getElementById('announcementText').value = item.text;
      document.getElementById('saveAnnouncement').textContent = 'Сохранить';
      document.getElementById('cancelAnnouncementEdit').classList.remove('hidden');
      document.getElementById('announcementText').focus();
    };
  });

  listEl.querySelectorAll('.ann-delete').forEach((btn) => {
    btn.onclick = async () => {
      btn.disabled = true;
      try {
        await apiDelete('/api/announcements', { id: btn.dataset.id });
        showToast('Объявление удалено', 'ok');
        await loadAnnouncementsList();
      } catch (e) {
        showToast('Ошибка удаления: ' + (e.message || 'не удалось удалить'), 'warn');
        btn.disabled = false;
      }
    };
  });
}

// Загружает список с сервера, перерисовывает и помечает всё просмотренным.
async function loadAnnouncementsList() {
  const listEl = document.getElementById('announcementList');
  try {
    const res = await apiFetch('/api/announcements');
    state.announcements = Array.isArray(res.items) ? res.items : [];
  } catch (e) {
    if (listEl) listEl.innerHTML = '<div class="announcement-empty">Не удалось загрузить объявления</div>';
    return;
  }
  renderAnnouncements();
  // Открытие модалки = просмотр: гасим точку. Метку ставим по самому
  // свежему объявлению (createdAt/updatedAt сервера, не локальные часы).
  let maxTs = loadAnnouncementsSeen();
  for (const it of state.announcements) {
    const ts = announcementItemTs(it);
    if (ts > maxTs) maxTs = ts;
  }
  if (maxTs) saveAnnouncementsSeen(maxTs);
  updateAnnouncementsBadge();
}

function setupAnnouncements() {
  const modal = document.getElementById('announcementsModal');
  const bellBtn = document.getElementById('bellBtn');
  if (!modal || !bellBtn) return;

  const textarea = document.getElementById('announcementText');
  const saveBtn = document.getElementById('saveAnnouncement');
  const cancelBtn = document.getElementById('cancelAnnouncementEdit');
  const msgEl = document.getElementById('announcementMsg');

  bellBtn.onclick = () => {
    // Блок формы owner'а — виден только при активной роли (косметика:
    // права проверяет сервер на каждом запросе).
    document.getElementById('announcementOwnerBlock').style.display = isOwner() ? '' : 'none';
    resetAnnouncementForm();
    renderAnnouncements(); // мгновенно из кеша state, затем обновим с сервера
    openModal(modal, bellBtn);
    loadAnnouncementsList();
  };

  // Закрытие с «обратным звонком» колокольчика (по аналогии с
  // closeSettingsWithAnim: анимация на кнопке-источнике, затем closeModal).
  function closeAnnouncementsWithAnim() {
    bellBtn.classList.remove('anim-ring-reverse');
    void bellBtn.offsetWidth; // reflow — перезапуск анимации
    bellBtn.classList.add('anim-ring-reverse');
    setTimeout(() => bellBtn.classList.remove('anim-ring-reverse'), 600);
    closeModal(modal);
  }

  document.getElementById('closeAnnouncements').onclick = () => closeAnnouncementsWithAnim();
  modal.onclick = (e) => { if (e.target === modal) closeAnnouncementsWithAnim(); };

  cancelBtn.onclick = resetAnnouncementForm;

  saveBtn.onclick = async () => {
    if (!isOwner()) {
      showToast('Публиковать объявления может только владелец', 'warn');
      return;
    }
    const text = textarea.value.trim();
    if (!text) {
      showToast('Введите текст объявления', 'warn');
      return;
    }
    saveBtn.disabled = true;
    msgEl.classList.add('hidden');
    try {
      if (editingAnnouncementId) {
        await apiPut('/api/announcements', { id: editingAnnouncementId, text });
        showToast('Объявление обновлено', 'ok');
      } else {
        await apiPost('/api/announcements', { text });
        showToast('Объявление опубликовано', 'ok');
      }
      resetAnnouncementForm();
      await loadAnnouncementsList();
    } catch (e) {
      msgEl.textContent = 'Ошибка: ' + (e.message || 'не удалось сохранить объявление');
      msgEl.className = 'invite-msg tg-warn';
      msgEl.classList.remove('hidden');
    } finally {
      saveBtn.disabled = false;
    }
  };
}

// ── Копирование в буфер обмена (с fallback) ───────────────────
function copyToClipboard(text, okMsg) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(
      () => { if (okMsg) showToast(okMsg, 'ok'); },
      () => showToast('Не удалось скопировать', 'warn')
    );
  } else {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); if (okMsg) showToast(okMsg, 'ok'); }
    catch (e) { showToast('Не удалось скопировать', 'warn'); }
    document.body.removeChild(ta);
  }
}

// Палитра акцентных цветов для кнопок.
const ACCENT_PALETTE = [
  '#6c8cff', '#4a65cc', '#3b82f6', '#0ea5e9', '#06b6d4',
  '#10b981', '#22c55e', '#84cc16', '#eab308', '#f59e0b',
  '#f97316', '#ef4444', '#ec4899', '#d946ef', '#8b5cf6',
];

// Галочка-иконка для выбранного цвета (SVG-элемент, не влезает в innerHTML из-за use).
function makeSwatchCheck() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'icon swatch-check');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '3');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', 'M20 6 9 17l-5-5');
  svg.appendChild(p);
  return svg;
}

// Строит выбор цвета кнопок (swatch-кнопки). Выбранный цвет сохраняется сразу.
function buildAccentPicker() {
  const wrap = document.getElementById('accentPicker');
  if (!wrap) return;
  wrap.innerHTML = '';
  ACCENT_PALETTE.forEach((hex) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'accent-swatch' + (state.accent === hex ? ' selected' : '');
    b.style.background = hex;
    b.style.color = hex;
    b.title = hex;
    b.setAttribute('aria-label', 'Цвет ' + hex);
    if (state.accent === hex) b.appendChild(makeSwatchCheck());
    b.onclick = () => {
      state.accent = hex;
      localStorage.setItem('accent', hex);
      applyAccent();
      wrap.querySelectorAll('.accent-swatch.selected').forEach((s) => {
        s.classList.remove('selected');
        if (s.firstChild) s.removeChild(s.firstChild);
      });
      b.classList.add('selected');
      b.appendChild(makeSwatchCheck());
      refreshIcons();
    };
    wrap.appendChild(b);
  });
}

function setupSettingsModal() {
  const modal = document.getElementById('settingsModal');
  let syncMetaLoaded = false;

  const groupInput = document.getElementById('groupInput');
  const saveGroupBtn = document.getElementById('saveGroupBtn');

  function updateSaveGroupBtnState() {
    const current = groupInput.value.trim().toLowerCase();
    saveGroupBtn.disabled = (current === state.group);
  }

  groupInput.addEventListener('input', updateSaveGroupBtnState);
  groupInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !saveGroupBtn.disabled) {
      e.preventDefault();
      saveGroupBtn.click();
    }
  });

    document.getElementById('settingsBtn').onclick = () => {
      groupInput.value = state.group;
      updateSaveGroupBtnState();
      // Если блок подтверждения сброса отметок остался открытым с прошлого раза — прячем.
      if (typeof resetDoneHideConfirm === 'function') resetDoneHideConfirm();
      document.getElementById('campusToggle').checked = state.campusEnabled;
      document.getElementById('subgroupFilter').value = state.subgroupFilter || 'any';
      document.getElementById('lastSyncInfo').textContent = formatDateTime(state.lastSyncAt);
      document.getElementById('campusUpdatedInfo').textContent = formatDateTime(state.campusUpdatedAt);
      // Тема
      const themeRadios = document.querySelectorAll('input[name="theme-mode"]');
      themeRadios.forEach((r) => { r.checked = (r.value === (state.theme || 'auto')); });
      // Акцент
      buildAccentPicker();
      // Роль (вынесена из шапки)
      renderRoleStatus();
      openModal(modal, document.getElementById('settingsBtn'));

    // Обновляем видимость секции приглашений под текущего пользователя.
    if (setupInviteSection._refresh) setupInviteSection._refresh();

    // Обновляем статус привязки под текущую группу.
    const statusEl = document.getElementById('tgStatus');
    const linkEl = document.getElementById('tgBotLink');
    apiPost('/api/tg/status', { group: state.group, chatId: state.tgChatId || '' }).then(res => {
      state.tgBotUsername = res.botUsername || state.tgBotUsername || '';
      if (state.tgBotUsername) {
        localStorage.setItem('tgBotUsername', state.tgBotUsername);
        linkEl.href = 'https://t.me/' + state.tgBotUsername;
        linkEl.textContent = '@' + state.tgBotUsername;
      }
      if (res.subscribed) {
        state.tgChatId = state.tgChatId || '';
        localStorage.setItem('tgChatId', state.tgChatId);
        localStorage.setItem('tgSubgroup', state.tgSubgroup || 'any');
        const subLabel = state.tgSubgroup === '1' ? 'подгруппа 1'
          : state.tgSubgroup === '2' ? 'подгруппа 2'
          : 'обе подгруппы';
        statusEl.innerHTML = '<svg class="icon inline-icon"><use href="#icon-check-circle"></use></svg> Уведомления включены — ' + escHtml(state.group) + ', ' + escHtml(subLabel);
        statusEl.className = 'tg-status tg-ok';
      } else {
        state.tgChatId = '';
        state.tgSubgroup = '';
        localStorage.removeItem('tgChatId');
        localStorage.removeItem('tgSubgroup');
        statusEl.innerHTML = '<svg class="icon inline-icon"><use href="#icon-info"></use></svg> Уведомления не настроены';
        statusEl.className = 'tg-status';
      }
      if (setupTgSection._refresh) setupTgSection._refresh();
    }).catch(() => {});

    if (!syncMetaLoaded) {
      syncMetaLoaded = true;
      apiFetch('/api/status', { group: state.group }).then(res => {
        if (res.lastSync) {
          state.lastSyncAt = res.lastSync;
          localStorage.setItem('lastSyncAt', state.lastSyncAt);
          document.getElementById('lastSyncInfo').textContent = formatDateTime(state.lastSyncAt);
        }
        if (res.campusUpdatedAt) {
          state.campusUpdatedAt = res.campusUpdatedAt;
          localStorage.setItem('campusUpdatedAt', state.campusUpdatedAt);
          document.getElementById('campusUpdatedInfo').textContent = formatDateTime(state.campusUpdatedAt);
        }
      }).catch(() => {});
    }
  };

  function closeSettingsWithAnim() {
    const btn = document.getElementById('settingsBtn');
    btn.classList.remove('anim-spin-reverse');
    void btn.offsetWidth;
    btn.classList.add('anim-spin-reverse');
    setTimeout(() => btn.classList.remove('anim-spin-reverse'), 600);
    closeModal(modal);
  }
  document.getElementById('closeSettings').onclick = () => closeSettingsWithAnim();
  modal.onclick = (e) => { if (e.target === modal) closeSettingsWithAnim(); };

  // Переключение темы в реальном времени (без перезагрузки).
  document.querySelectorAll('input[name="theme-mode"]').forEach((r) => {
    r.addEventListener('change', () => {
      if (!r.checked) return;
      state.theme = r.value;
      localStorage.setItem('theme', state.theme);
      applyTheme();
      renderRoleStatus();
    });
  });

  // Встроенное подтверждение сброса отметок «выполнено» (без нативного confirm):
  // клик по кнопке показывает блок «Точно сбросить?» с кнопками Сбросить/Отмена.
  const resetDoneBtn = document.getElementById('resetDoneHw');
  const resetDoneConfirm = document.getElementById('resetDoneConfirm');

  function resetDoneShowConfirm() {
    document.getElementById('resetDoneGroup').textContent = state.group;
    resetDoneBtn.classList.add('hidden');
    resetDoneConfirm.classList.remove('hidden');
  }

  function resetDoneHideConfirm() {
    resetDoneConfirm.classList.add('hidden');
    resetDoneBtn.classList.remove('hidden');
  }

  resetDoneBtn.onclick = resetDoneShowConfirm;
  document.getElementById('resetDoneYes').onclick = () => {
    doneHwIds.clear();
    saveDoneHw();
    renderHomework();
    if (state.schedule) renderDayTabs();
    showToast('Отметки выполненных ДЗ сброшены', 'ok');
    resetDoneHideConfirm();
  };
  document.getElementById('resetDoneNo').onclick = resetDoneHideConfirm;

  // Мгновенное переключение подгруппы — без кнопки «Сохранить».
  document.getElementById('subgroupFilter').addEventListener('change', function() {
    state.subgroupFilter = this.value || 'any';
    localStorage.setItem('subgroupFilter', state.subgroupFilter);
    renderHomework();
    if (state.schedule) renderDayTabs();
  });

  // Мгновенное переключение кампуса — без кнопки «Сохранить».
  document.getElementById('campusToggle').addEventListener('change', function() {
    state.campusEnabled = this.checked;
    localStorage.setItem('campusEnabled', state.campusEnabled ? '1' : '0');
  });

  // Кнопка-стрелка рядом с полем группы: сохраняет ТОЛЬКО группу.
  document.getElementById('saveGroupBtn').onclick = () => {
    const rawGroup = document.getElementById('groupInput').value.trim() || DEFAULT_GROUP;
    if (!isValidGroup(rawGroup)) {
      showToast('Формат: 3 цифры, дефис, 3-4 буквы (напр. 131-ИБо)', 'warn');
      return;
    }
    const newGroup = rawGroup.toLowerCase();
    const groupChanged = newGroup.toLowerCase() !== state.group;

    // Смена группы: сбрасываем даты «последняя синхронизация» и «обновлено на
    // кампусе» старой группы, чтобы для новой группы не показывались чужое
    // время. syncMetaLoaded=false — при следующем открытии настроек /api/status
    // запросит мету уже для новой группы.
    if (groupChanged) {
      resetSyncMetaForGroup();
      syncMetaLoaded = false;
    }

    state.group = newGroup.toLowerCase();
    localStorage.setItem('group', state.group);
    closeModal(modal);

    // Смена группы: роль редактора подтверждается сервером для новой группы
    // (HttpOnly-cookie __Host-writer_tokens прикладывается браузером сама).
    if (groupChanged && !state.ownerRole) {
      refreshEditVisibility();
      state.scheduleCache = {};
      invalidateSchedCache();
      invalidateHwCache();
      invalidateSubjectsCache();
      invalidateWeeksCache();
    }

    if (groupChanged && !state.ownerRole) {
      // loadData() ниже тоже проверит роль — здесь fire-and-forget для раннего
      // скрытия/показа кнопок редактирования до завершения загрузки.
      refreshWriterStatus(newGroup.toLowerCase());
    }

    // Полный сброс состояния — чтобы старые данные группы не мелькали.
    state.homework = [];
    state.weeks = [];
    state.schedule = null;
    state.selectedDay = null;
    if (groupChanged) {
      doneHwIds = loadDoneHw();
    }

    // Показываем загрузку в UI (скелетон вместо текста).
    document.getElementById('scheduleContent').innerHTML = skeletonScheduleHTML();
    document.getElementById('homeworkList').innerHTML = '';
    document.getElementById('weekLabel').textContent = 'Загрузка...';
    document.getElementById('dayTabs').innerHTML = '';

    loadData();

    if (groupChanged) {
      apiPost('/api/tg/status', { group: state.group, chatId: state.tgChatId || '' }).then(res => {
        if (res.subscribed) {
          localStorage.setItem('tgChatId', state.tgChatId || '');
          localStorage.setItem('tgSubgroup', state.tgSubgroup || 'any');
        } else {
          state.tgChatId = '';
          state.tgSubgroup = '';
          localStorage.removeItem('tgChatId');
          localStorage.removeItem('tgSubgroup');
        }
      }).catch(() => {});
    }
  };
}

// ── Helpers ───────────────────────────────────────────────────

function showError(msg, retryFn) {
  const content = document.getElementById('scheduleContent');
  content.innerHTML = `
    <div class="error-msg">
      ${escHtml(msg)}
      ${retryFn ? '<br><button id="retryBtn">Синхронизировать</button>' : ''}
    </div>`;
  if (retryFn) {
    document.getElementById('retryBtn').onclick = retryFn;
  }
}

let toastTimer = null;
function showToast(msg, kind) {
  const el = document.getElementById('toast');
  if (!el) return;
  // Сначала убираем display:none, потом задаём роль и меняем контент —
  // чтобы мутация происходила в уже видимом live-регионе и озвучивалась скринридером.
  el.className = 'toast' + (kind ? ' toast-' + kind : '');
  // Ошибки — прерывающая озвучка (role=alert/assertive), остальное — вежливая (status/polite).
  const isError = kind === 'error';
  el.setAttribute('role', isError ? 'alert' : 'status');
  el.setAttribute('aria-live', isError ? 'assertive' : 'polite');
  el.textContent = msg;
  // force reflow so transition runs on repeated calls
  void el.offsetWidth;
  el.classList.add('toast-show');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('toast-show'), 4000);
}

function parseDate(str) {
  const [d, m, y] = str.split('.');
  return new Date(parseInt(y), parseInt(m) - 1, parseInt(d));
}

// Копирует пригласительную ссылку в буфер обмена несколькими способами
// (clipboard API → execCommand → contentEditable) и показывает тост о результате.
// Полный токен в DOM не хранится — подтягиваем его отдельным запросом по id
// (/api/invite?id=...) только в момент копирования.
async function copyInviteLink(el) {
  const item = el.closest('.invite-item');
  const id = item ? item.dataset.id : '';
  if (!id) {
    showToast('Нет id ссылки для копирования', 'warn');
    return;
  }

  let token = '';
  try {
    const data = await apiFetch('/api/invite', { group: state.group, id });
    token = data.item && data.item.token;
  } catch (e) {
    showToast('Не удалось получить токен', 'warn');
    return;
  }
  if (!token) {
    showToast('Не удалось получить токен', 'warn');
    return;
  }

  const origin = DEFAULT_API.replace(/\/api\/?$/, '').replace(/\/+$/, '');
  const link = origin + '/#invite=' + encodeURIComponent(token);

  function done(ok) {
    if (ok) showToast('Ссылка скопирована', 'ok');
    else showToast('Не удалось скопировать ссылку. Попробуйте ещё раз.', 'warn');
  }

  if (navigator.clipboard && navigator.clipboard.writeText && window.isSecureContext) {
    navigator.clipboard.writeText(link).then(() => done(true), () => fallbackCopy(link, done));
  } else {
    fallbackCopy(link, done);
  }
}

function fallbackCopy(text, done) {
  // textarea + execCommand
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '-1000px';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    if (ok) { done(true); return; }
  } catch (e) { /* fall through */ }

  // contentEditable + execCommand (более надёжно в некоторых браузерах)
  try {
    const range = document.createRange();
    const span = document.createElement('span');
    span.textContent = text;
    span.style.position = 'fixed';
    span.style.top = '-1000px';
    span.contentEditable = 'true';
    document.body.appendChild(span);
    range.selectNodeContents(span);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    const ok = document.execCommand('copy');
    document.body.removeChild(span);
    done(ok);
    return;
  } catch (e) { /* fall through */ }

  done(false);
}

// Rubber‑band overscroll (iOS‑like bounce)
(function(){
  // «Меньше движения»: физическая «пружинная» анимация отключается —
  // скролл остаётся обычным.
  if (prefersReducedMotion()) return;

  var el = document.querySelector('.container') || document.body;
  var offset = 0, raf = null;
  var DAMP = 0.35, DECAY = 0.82, THR = 0.5;

  function atTop(){ return window.scrollY <= 0; }
  function atBottom(){
    return window.scrollY >= document.documentElement.scrollHeight - window.innerHeight - 1;
  }
  function spring(){
    offset *= DECAY;
    el.style.transform = offset ? 'translateY('+offset+'px)' : '';
    if(Math.abs(offset) < THR){ el.style.transform = ''; offset = 0; raf = null; }
    else raf = requestAnimationFrame(spring);
  }
  function push(dy){
    offset += dy * DAMP;
    el.style.transform = 'translateY('+offset+'px)';
    if(!raf) raf = requestAnimationFrame(spring);
  }

  function insideOpenModal(target){
    if(!target || target.closest) return target.closest('.modal.is-open');
    return null;
  }

  window.addEventListener('wheel', function(e){
    if(insideOpenModal(e.target)) return;
    if((atTop() && e.deltaY < 0) || (atBottom() && e.deltaY > 0)){
      push(-e.deltaY); e.preventDefault();
    }
  }, {passive:false});

  var ty = 0;
  window.addEventListener('touchstart', function(e){
    if(insideOpenModal(e.target)) { ty = null; return; }
    ty = e.touches[0].clientY;
  }, {passive:true});
  window.addEventListener('touchmove', function(e){
    if(insideOpenModal(e.target)) { ty = null; return; }
    if(ty == null) return;
    var dy = e.touches[0].clientY - ty;
    if((atTop() && dy > 0) || (atBottom() && dy < 0)){ push(dy * 0.5); e.preventDefault(); }
    ty = e.touches[0].clientY;
  }, {passive:false});
  window.addEventListener('touchend', function(){
    if(raf) cancelAnimationFrame(raf);
    raf = requestAnimationFrame(spring);
  });
})();

function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Экранирует строку для безопасного использования в CSS-селекторе [data-id="..."].
// id ссылок — hex (первые 8 символов uuid), но на всякий случай экранируем.
function cssEscape(str) {
  return String(str).replace(/["\\]/g, '\\$&');
}

function formatDateTime(iso) {
  if (!iso) return '—';
  const m = iso.match(/(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})/);
  if (!m) return '—';
  const [_, y, mo, d, h, mi, s] = m;
  // lastSync хранится в UTC (с Z), campusUpdatedAt — локальное время кампуса (без Z).
  // Конвертируем в локальное время браузера, если строка заканчивается на Z или содержит T...Z
  if (iso.endsWith('Z') || /T\d{2}:\d{2}:\d{2}\.\d+Z$/.test(iso)) {
    const dt = new Date(iso);
    return `${String(dt.getDate()).padStart(2,'0')}.${String(dt.getMonth()+1).padStart(2,'0')}.${dt.getFullYear()} ${String(dt.getHours()).padStart(2,'0')}:${String(dt.getMinutes()).padStart(2,'0')}:${String(dt.getSeconds()).padStart(2,'0')}`;
  }
  return `${d}.${mo}.${y} ${h}:${mi}:${s}`;
}
