// ── Config ────────────────────────────────────────────────────

const DEFAULT_API = 'https://schedule-worker.campus-schedule-syktyvkar.workers.dev';
const DEFAULT_GROUP = '131-ИБо';
const CAMPUS_URL = 'https://campus.syktsu.ru/schedule/group/';

const DAY_NAMES = ['Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота', 'Воскресенье'];
const DAY_SHORT = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];

// ── State ─────────────────────────────────────────────────────

let state = {
  apiBase: localStorage.getItem('apiBase') || DEFAULT_API,
  group: localStorage.getItem('group') || DEFAULT_GROUP,
  // campusEnabled: по умолчанию true. При false topical загрузки из кампуса не происходит — только из БД.
  campusEnabled: localStorage.getItem('campusEnabled') !== '0',
  schedule: null,
  weeks: [],
  currentWeekIdx: -1,
  selectedDay: null,
  homework: [],
  syncing: false,
};

// ── Init ──────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  setupSettingsModal();
  setupHomeworkModal();

  document.getElementById('syncBtn').onclick = () => syncAll();
  loadData();
});

// ── Main data loading ─────────────────────────────────────────
//
// Поведение:
//  1. При загрузке сайта берём из БД: предыдущую неделю, текущую и две следующих.
//     Параллельно (если campusEnabled) идём в кампус за текущей и двумя следующими
//     (предыдущую из кампуса НЕ тянем). Если расписание изменилось или его не было
//     в БД — оно записывается в БД и текущий экран обновляется.
//  2. loadSchedule(idx) — переключение недели. Назад → из БД, при отсутствии из кампуса.
//     Вперёд > 2 недель от текущей → из БД + фоне кампус-обновление.
//  3. syncAll() — кнопка обновления. На прошлой неделе → только её из кампуса.
//     На текущей/будущей → текущую + 2 следующих из кампуса. Неделю не меняем.

async function loadData() {
  try {
    await loadWeeks();
    if (state.weeks.length === 0) {
      // Кеш недель пуст — пробуем взять недели из кампуса (если разрешено)
      if (state.campusEnabled) {
        await syncWeeksFromCampus(true);
      }
    }
    if (state.weeks.length === 0) {
      showError('Нет данных о неделях. Включите загрузку из кампуса в настройках и нажмите 🔄.', () => syncAll());
      return;
    }
    findCurrentWeek();
    renderWeekNav();
    await loadInitialSchedules();
    loadHomework();
    loadSubjects();
  } catch (e) {
    showError('Не удалось загрузить данные: ' + e.message, () => syncAll());
  }
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

// Загрузка исходных расписаний (БД + фоне кампус) при открытии страницы.
async function loadInitialSchedules() {
  const indices = getInitialWeekIndices();
  if (indices.length === 0) return;

  const content = document.getElementById('scheduleContent');
  content.innerHTML = '<div class="loading">Загрузка расписания...</div>';

  // 1) Из БД параллельно по всем стартовым неделям
  const dbResults = await Promise.all(
    indices.map(async (i) => {
      try {
        const data = await apiFetch('/api/schedule', { group: state.group, week: state.weeks[i].value });
        return { idx: i, data };
      } catch (e) {
        return { idx: i, data: null };
      }
    })
  );

  const dbMap = new Map();
  for (const r of dbResults) if (r.data) dbMap.set(r.idx, r.data);

  // 2) Параллельно из кампуса: текущая + 2 следующих (previous НЕ грузим)
  const campusIndices = indices.filter(i => {
    const cur = findRealCurrentIdx();
    return i >= cur;
  });

  if (state.campusEnabled && campusIndices.length > 0) {
    backgroundSync(campusIndices, dbMap);
  }

  // 3) Если есть данные для текущей недели в БД — показываем сразу
  const cur = findRealCurrentIdx();
  state.currentWeekIdx = cur;
  const currentData = dbMap.get(cur);
  if (currentData) {
    state.schedule = currentData;
    applyScheduleHeader();
    renderDayTabs();
  } else {
    // Текущей недели в БД нет, но из кампуса может подтянуться через backgroundSync.
    // Если кампус отключён или campusIndices пусто — покажем что-нибудь из БД.
    let fallbackIdx = indices.find(i => dbMap.has(i));
    if (fallbackIdx !== undefined) {
      state.currentWeekIdx = fallbackIdx;
      state.schedule = dbMap.get(fallbackIdx);
      applyScheduleHeader();
      renderDayTabs();
    } else if (!state.campusEnabled || campusIndices.length === 0) {
      content.innerHTML = '<div class="no-pairs">Нет данных. Нажмите 🔄 для синхронизации.</div>';
    }
  }
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

    // Загружаем в БД только изменённые/отсутствующие
    const toUpload = [];
    for (const v of valid) {
      const existing = dbMap ? dbMap.get(v.idx) : null;
      if (!existing || JSON.stringify(stripComparable(existing)) !== JSON.stringify(stripComparable(v.data))) {
        toUpload.push({ weekCode: v.weekCode, data: v.data });
      }
    }

    if (toUpload.length > 0) {
      await apiPost('/api/upload', {
        type: 'schedule-batch',
        group: state.group,
        schedules: toUpload,
      });
      console.log('[bgSync] uploaded', toUpload.length, 'weeks');
      loadHomework();
      loadSubjects();
    }

    // Если текущая открытая неделя изменилась — перерисуем
    const currentWeek = state.weeks[state.currentWeekIdx];
    const match = currentWeek && valid.find(v => v.weekCode === currentWeek.value);
    if (match) {
      state.schedule = match.data;
      applyScheduleHeader();
      renderDayTabs();
    }
  } catch (e) {
    console.warn('[bgSync] error:', e.message);
  }
}

async function loadWeeks() {
  try {
    state.weeks = await apiFetch('/api/weeks', { group: state.group });
    findCurrentWeek();
    renderWeekNav();
  } catch (e) {
    // Кеш пуст — оставляем недели пустыми, разберёмся дальше
    state.weeks = [];
    state.currentWeekIdx = -1;
  }
}

// Загрузка расписания для произвольной недели (при навигации).
//  - Назад: из БД; если нет — из кампуса и пишем в БД.
//  - Вперёд, дальше чем на +2 от текущей: из БД, параллельно обновляем из кампуса.
//  - Вперёд в пределах текущая/+2: эти недели уже должны быть загружены из БД
//    при открытии; если по какой-то причине нет — берём из кампуса и пишем в БД.
async function loadSchedule(targetIdx) {
  if (targetIdx < 0 || targetIdx >= state.weeks.length) return;
  state.currentWeekIdx = targetIdx;

  const w = state.weeks[targetIdx];
  const content = document.getElementById('scheduleContent');
  content.innerHTML = '<div class="loading">Загрузка расписания...</div>';

  // 1) Из БД
  let dbData = null;
  try {
    dbData = await apiFetch('/api/schedule', { group: state.group, week: w.value });
  } catch (e) {
    dbData = null;
  }

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

  // 2) Нет в БД
  if (state.campusEnabled) {
    try {
      const campusData = await fetchScheduleFromCampus(state.group, w.value);
      const hasPairs = campusData.days && Object.values(campusData.days).some(d => d.pairs && d.pairs.length > 0);
      if (hasPairs) {
        await apiPost('/api/upload', {
          type: 'schedule-batch',
          group: state.group,
          schedules: [{ weekCode: w.value, data: campusData }],
        });
      }
      state.schedule = campusData;
      applyScheduleHeader();
      renderDayTabs();
      return;
    } catch (e) {
      console.warn('Campus unavailable:', e.message);
    }
  }

  content.innerHTML = '<div class="no-pairs">Нет данных для этой недели.</div>';
  applyScheduleHeader();
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
      await apiPost('/api/upload', {
        type: 'schedule-batch',
        group: state.group,
        schedules: [{ weekCode: w.value, data }],
      });
      loadHomework();
      loadSubjects();
    }

    // Если пользователь всё ещё на этой неделе — обновим экран
    if (state.weeks[state.currentWeekIdx] && state.weeks[state.currentWeekIdx].value === w.value) {
      state.schedule = data;
      applyScheduleHeader();
      renderDayTabs();
    }
  } catch (e) {
    console.warn('[bgSyncSingle] error:', e.message);
  }
}

function applyScheduleHeader() {
  document.getElementById('groupName').textContent = (state.schedule && state.schedule.group) || state.group;
  if (state.schedule && state.schedule.weekStart) {
    document.getElementById('weekRange').textContent =
      state.schedule.weekStart + ' — ' + state.schedule.weekEnd;
  } else {
    document.getElementById('weekRange').textContent = '';
  }
}

// ── Sync (кнопка обновления) ──────────────────────────────────
//
// При обновлении пользователь НЕ перемещается на другую неделю.
//  - Если текущая выбранная неделя в прошлом (до текущей по календарю):
//    из кампуса качается только она и перезаписывает запись в БД.
//  - Если текущая или будущая: качаем текущую + 2 следующих из кампуса,
//    перезаписываем в БД только изменившиеся.

async function syncAll() {
  if (state.syncing) return;
  if (!state.campusEnabled) {
    updateSyncUI('error', 'Загрузка из кампуса отключена в настройках');
    return;
  }
  state.syncing = true;
  updateSyncUI('syncing');

  // Сохраняем выбранную неделю, чтобы остаться на ней
  const savedWeekValue = state.weeks[state.currentWeekIdx]?.value;
  let savedIdx = state.currentWeekIdx;

  try {
    // Обновляем список недель, сохраняя выбор
    await syncWeeksFromCampus(true);

    if (savedWeekValue) {
      const idx = state.weeks.findIndex(w => w.value === savedWeekValue);
      if (idx >= 0) savedIdx = idx;
      state.currentWeekIdx = savedIdx;
    }
    renderWeekNav();

    const realCurrentIdx = findRealCurrentIdx();
    const userIsOnPast = savedIdx < realCurrentIdx;

    const weekIndices = userIsOnPast
      ? [savedIdx]
      : collectForwardRange(savedIdx, 2);

    const results = await Promise.all(
      weekIndices.map(async (i) => {
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

    const validSchedules = results.filter(Boolean);
    if (validSchedules.length === 0) {
      throw new Error('Не удалось получить расписание ни для одной недели');
    }

    await apiPost('/api/upload', {
      type: 'schedule-batch',
      group: state.group,
      schedules: validSchedules,
    });

    // Обновляем только ту неделю, на которой находится пользователь
    const currentWeek = state.weeks[state.currentWeekIdx];
    if (currentWeek) {
      const match = validSchedules.find(s => s.weekCode === currentWeek.value);
      if (match) {
        state.schedule = match.data;
        applyScheduleHeader();
      }
    }

    renderWeekNav();
    renderDayTabs();
    updateSyncUI('ok');
    loadHomework();
    loadSubjects();
  } catch (e) {
    updateSyncUI('error', e.message);
    if (!state.schedule) {
      showError('Не удалось синхронизировать: ' + e.message, () => syncAll());
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

  const resp = await fetch(CAMPUS_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
    body: formData.toString(),
  });

  if (!resp.ok) throw new Error('Campus: ' + resp.status);
  const html = await resp.text();
  return parseWeekOptions(html);
}

async function fetchScheduleFromCampus(group, weekCode) {
  const formData = new URLSearchParams();
  formData.set('num_group', group);
  if (weekCode) {
    formData.set('weeks', weekCode);
  } else {
    formData.set('searchdata', 'ИСКАТЬ');
  }

  const resp = await fetch(CAMPUS_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
    body: formData.toString(),
  });

  if (!resp.ok) throw new Error('Campus: ' + resp.status);
  const html = await resp.text();
  return parseScheduleHTML(html);
}

// ── HTML Parser ───────────────────────────────────────────────

function cleanHtml(text) {
  return text
    .replace(/<br\s*\/?>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
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
    const value = m[1];
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

function parseScheduleHTML(html) {
  const result = {
    group: '',
    weekStart: '',
    weekEnd: '',
    days: {},
    parsedAt: new Date().toISOString(),
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

async function apiFetch(path, params = {}) {
  const url = new URL(state.apiBase + path);
  for (const [k, v] of Object.entries(params)) {
    if (v) url.searchParams.set(k, v);
  }
  const resp = await fetch(url.toString());
  if (!resp.ok) throw new Error('API ' + resp.status);
  return resp.json();
}

async function apiPost(path, body) {
  const resp = await fetch(state.apiBase + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error || 'API ' + resp.status);
  return data;
}

async function apiDelete(path, params = {}) {
  const url = new URL(state.apiBase + path);
  for (const [k, v] of Object.entries(params)) {
    if (v) url.searchParams.set(k, v);
  }
  const resp = await fetch(url.toString(), { method: 'DELETE' });
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error || 'API ' + resp.status);
  return data;
}

// ── Weeks ─────────────────────────────────────────────────────

// Индекс «реальной» текущей недели по календарю (или 0, если не нашлось).
function findRealCurrentIdx() {
  const today = new Date();
  for (let i = 0; i < state.weeks.length; i++) {
    const w = state.weeks[i];
    if (w.dates.length >= 2) {
      const start = parseDate(w.dates[0]);
      const end = parseDate(w.dates[1]);
      if (today >= start && today <= end) return i;
    }
  }
  return 0;
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

function renderWeekNav() {
  const label = document.getElementById('weekLabel');
  const w = state.weeks[state.currentWeekIdx];
  if (w) label.textContent = w.text;

  document.getElementById('prevWeek').onclick = () => {
    if (state.currentWeekIdx > 0) {
      loadSchedule(state.currentWeekIdx - 1);
      renderWeekNav();
    }
  };

  document.getElementById('nextWeek').onclick = () => {
    if (state.currentWeekIdx < state.weeks.length - 1) {
      loadSchedule(state.currentWeekIdx + 1);
      renderWeekNav();
    }
  };
}

// ── Schedule rendering ────────────────────────────────────────

function renderDayTabs() {
  const tabs = document.getElementById('dayTabs');
  tabs.innerHTML = '';

  const days = Object.keys(state.schedule.days);
  const todayName = DAY_NAMES[new Date().getDay() === 0 ? 6 : new Date().getDay() - 1];

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

    tab.onclick = () => {
      state.selectedDay = day;
      document.querySelectorAll('.day-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      renderDaySchedule(day);
    };

    tabs.appendChild(tab);
  });

  renderDaySchedule(state.selectedDay);
}

function renderDaySchedule(day) {
  const content = document.getElementById('scheduleContent');
  const dayData = state.schedule.days[day];

  if (!dayData) {
    content.innerHTML = '<div class="no-pairs">Нет данных</div>';
    return;
  }

  let pairsHtml = '';
  const activePairs = dayData.pairs.filter(p => p.subject);

  if (activePairs.length === 0) {
    pairsHtml = '<div class="no-pairs">Нет пар 🎉</div>';
  } else {
    for (const p of activePairs) {
      const typeClass = PAIR_TYPE_NAMES[p.type] || '';
      const typeFullName = PAIR_TYPE_NAMES[p.type] || p.type || '';

      const hwItems = getHwForSubject(p.subject);
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
          return `<div class="pair-hw-item${dc}"><span class="pair-hw-task">${escHtml(hw.task || 'задание')}</span>${hw.dueDate ? `<span class="pair-hw-due">${escHtml(hw.dueDate)}</span>` : ''}</div>`;
        }).join('') + '</div>';
      }

      const baseSubj = p.subject;
      const pairTypeCode = p.type || '';

      pairsHtml += `
        <div class="pair-card${p.subgroup ? ' has-subgroup' : ''}">
          <div class="pair-top">
            <div style="display:flex;align-items:center;gap:8px;">
              <span class="pair-num">${p.num}</span>
              <span class="pair-time">${p.time}</span>
            </div>
            <div style="display:flex;align-items:center;gap:6px;">
              ${p.subgroup ? `<span class="pair-subgroup">${escHtml(p.subgroup)}</span>` : ''}
              ${typeFullName ? `<span class="pair-type ${typeClass}">${typeFullName}</span>` : ''}
              <button class="pair-add-hw" data-subj="${escHtml(baseSubj)}" data-type="${pairTypeCode}" title="Добавить ДЗ">+</button>
            </div>
          </div>
          <div class="pair-subject">${escHtml(p.subject)}</div>
          ${p.teacher ? `<div class="pair-teacher">${escHtml(p.teacher)}</div>` : ''}
          ${p.room ? `<div class="pair-room">${escHtml(p.room)}</div>` : ''}
          ${hwHtml}
        </div>`;
    }
  }

  content.innerHTML = `
    <div class="day-schedule">
      <div class="day-header">
        ${day}
        <span class="day-date">${dayData.date}</span>
      </div>
      ${pairsHtml}
    </div>`;

  content.querySelectorAll('.pair-add-hw').forEach(btn => {
    btn.onclick = (e) => {
      e.stopPropagation();
      openHwModal(btn.dataset.subj, btn.dataset.type);
    };
  });
}

// ── Sync UI ───────────────────────────────────────────────────

function updateSyncUI(status, errorMsg) {
  const el = document.getElementById('syncStatus');
  if (!el) return;

  if (status === 'syncing') {
    el.innerHTML = '<span class="sync-icon spinning">⟳</span> Синхронизация...';
    el.className = 'sync-status syncing';
  } else if (status === 'ok') {
    el.innerHTML = '<span class="sync-icon">✓</span> ' + new Date().toLocaleTimeString('ru');
    el.className = 'sync-status ok';
  } else if (status === 'error') {
    el.innerHTML = '<span class="sync-icon">✕</span> Ошибка. <button onclick="syncAll()" class="sync-retry">Повторить</button>';
    el.className = 'sync-status error';
  }
}

// ── Subjects ─────────────────────────────────────────────────

let loadedSubjects = [];

async function loadSubjects() {
  try {
    const res = await apiFetch('/api/subjects', { group: state.group });
    loadedSubjects = res.subjects || [];
  } catch (e) {
    loadedSubjects = [];
  }
  // Если из БД ничего нет — собираем из текущего расписания
  if (loadedSubjects.length === 0 && state.schedule) {
    const map = new Map();
    for (const day of Object.values(state.schedule.days)) {
      for (const p of (day.pairs || [])) {
        if (!p.subject) continue;
        if (!map.has(p.subject)) map.set(p.subject, new Set());
        if (p.type) map.get(p.subject).add(p.type);
      }
    }
    loadedSubjects = [...map.entries()]
      .map(([subject, types]) => ({ subject, pairTypes: [...types].sort() }))
      .sort((a, b) => a.subject.localeCompare(b.subject, 'ru'));
  }
}

function getTodaySubjectPairs() {
  if (!state.schedule) return [];
  const todayName = DAY_NAMES[new Date().getDay() === 0 ? 6 : new Date().getDay() - 1];
  const day = state.schedule.days[todayName];
  if (!day) return [];
  const seen = new Set();
  const result = [];
  for (const p of day.pairs) {
    if (!p.subject) continue;
    if (seen.has(p.subject)) continue;
    seen.add(p.subject);
    result.push(p);
  }
  return result;
}

function getAllSubjects() {
  if (!state.schedule) return { today: [], all: [] };

  const todayName = DAY_NAMES[new Date().getDay() === 0 ? 6 : new Date().getDay() - 1];
  const allSet = new Set();
  const todaySet = new Set();

  for (const [day, data] of Object.entries(state.schedule.days)) {
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

function getHwForSubject(subj) {
  if (!subj) return [];
  const base = subj.trim().toLowerCase();
  return state.homework.filter(h => {
    const hBase = (h.subject || '').toLowerCase();
    if (hBase !== base) return false;
    return true;
  });
}

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

  // Дни предыдущего месяца
  const startOffset = firstDay === 0 ? 6 : firstDay - 1;
  for (let i = startOffset - 1; i >= 0; i--) {
    const d = daysInPrev - i;
    html += '<div class="cal-day other-month" data-date="">' + d + '</div>';
  }

  for (let d = 1; d <= daysInMonth; d++) {
    const date = new Date(year, month, d);
    const dateStr = formatDateISO(date);
    let cls = 'cal-day';
    if (dateStr === todayStr) cls += ' today';
    if (dateStr === selected) cls += ' selected';
    if (dateStr < todayStr) cls += ' other-month'; // прошлое недоступно
    html += '<div class="' + cls + '" data-date="' + dateStr + '">' + d + '</div>';
  }

  // Дни следующего месяца
  const totalCells = startOffset + daysInMonth;
  const remaining = (7 - (totalCells % 7)) % 7;
  for (let d = 1; d <= remaining; d++) {
    html += '<div class="cal-day other-month" data-date="">' + d + '</div>';
  }

  grid.innerHTML = html;

  grid.querySelectorAll('.cal-day').forEach(el => {
    const dateStr = el.dataset.date;
    if (!dateStr) return;
    if (dateStr < todayStr) {
      el.style.cursor = 'default';
      el.title = 'Прошедшая дата';
      return;
    }
    el.onclick = () => {
      document.querySelectorAll('.cal-day.selected').forEach(c => c.classList.remove('selected'));
      el.classList.add('selected');
      document.getElementById('hwDateSelected').textContent = formatDateDisplay(dateStr);
      calState.selectedDate = dateStr;
    };
  });
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

// ── Homework Modal ────────────────────────────────────────────

function setupHomeworkModal() {
  const modal = document.getElementById('homeworkModal');
  const sel = document.getElementById('hwSubject');
  const customWrap = document.getElementById('hwSubjectCustomWrap');
  const pairTypeWrap = document.getElementById('hwPairTypeWrap');

  document.getElementById('addHomeworkBtn').onclick = () => openHwModal();

  document.getElementById('closeHomework').onclick = () => modal.classList.add('hidden');
  modal.onclick = (e) => { if (e.target === modal) modal.classList.add('hidden'); };

  // Предмет → управление custom / pairType / dueMode
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
      const dateRadio = document.querySelector('input[name="hwDueMode"][value="date"]');
      if (dateRadio) dateRadio.checked = true;
      document.getElementById('hwDateWrap').classList.remove('hidden');
    } else {
      customWrap.classList.add('hidden');
      pairTypeWrap.classList.remove('hidden');
      setPairTypeFromSelected(val);
      document.querySelectorAll('input[name="hwDueMode"]').forEach(r => r.disabled = false);
    }
  };

  // Due mode radio
  document.querySelectorAll('input[name="hwDueMode"]').forEach(r => {
    r.onchange = () => {
      const dateWrap = document.getElementById('hwDateWrap');
      if (document.querySelector('input[name="hwDueMode"]:checked')?.value === 'date') {
        dateWrap.classList.remove('hidden');
      } else {
        dateWrap.classList.add('hidden');
      }
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

  // Save
  document.getElementById('saveHomework').onclick = async () => {
    const isCustom = sel.value === '__custom__';
    const subject = isCustom
      ? document.getElementById('hwSubjectCustom').value.trim()
      : (sel.options[sel.selectedIndex]?.textContent || sel.value);

    if (!subject) return;

    const task = document.getElementById('hwTask').value.trim();
    const author = document.getElementById('hwAuthor').value.trim();

    // Определяем dueMode
    const modeRadio = document.querySelector('input[name="hwDueMode"]:checked');
    const dueMode = modeRadio ? modeRadio.value : 'date';
    const dueDate = calState.selectedDate;
    let pairType = document.getElementById('hwPairType').value;

    if (!isCustom) {
      // При выборе из select — pairType уже правильно установлен в onchange/onmount
    }

    if (author) localStorage.setItem('hwAuthor', author);

    try {
      const result = await apiPost('/api/hw', {
        group: state.group,
        subject: isCustom ? subject : subject,
        pairType,
        task,
        dueMode,
        dueDate,
        author,
      });

      state.homework.push(result.item);
      renderHomework();
      if (state.schedule) renderDayTabs();
      modal.classList.add('hidden');
    } catch (e) {
      console.warn('HW save failed:', e.message);
    }
  };
}

function setPairTypeFromSelected(val) {
  const sel = document.getElementById('hwPairType');
  sel.disabled = false;
  const todayPairs = getTodaySubjectPairs();
  const match = todayPairs.find(p => p.subject === val && p.type);
  if (match) {
    sel.value = match.type;
  } else {
    sel.value = 'any';
  }
}

function openHwModal(preSubject, prePairType) {
  const modal = document.getElementById('homeworkModal');
  const sel = document.getElementById('hwSubject');
  const customWrap = document.getElementById('hwSubjectCustomWrap');
  const pairTypeWrap = document.getElementById('hwPairTypeWrap');

  // Build subject list from loadedSubjects + today + current schedule
  sel.innerHTML = '';

  const todayPairs = getTodaySubjectPairs();
  if (todayPairs.length) {
    const og = document.createElement('optgroup');
    og.label = 'Сегодня';
    for (const p of todayPairs) {
      const o = document.createElement('option');
      const typeHint = p.type ? ' (' + (PAIR_TYPE_NAMES[p.type] || p.type) + ')' : '';
      o.value = p.subject;
      o.textContent = p.subject + typeHint;
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
      og.appendChild(o);
    }
    sel.appendChild(og);
  }

  // Другой
  const co = document.createElement('option');
  co.value = '__custom__';
  co.textContent = 'Другой...';
  sel.appendChild(co);

  // Preselect
  if (preSubject) {
    const match = loadedSubjects.find(s => s.subject.toLowerCase() === preSubject.toLowerCase());
    const todayMatch = todayPairs.find(p => p.subject.toLowerCase() === preSubject.toLowerCase());
    if (todayMatch) {
      sel.value = preSubject;
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
  } else {
    sel.value = todayPairs.length ? todayPairs[0].subject : (allItems.length ? allItems[0].subject : '__custom__');
    if (sel.value !== '__custom__') {
      customWrap.classList.add('hidden');
      setPairTypeFromSelected(sel.value);
    } else {
      customWrap.classList.remove('hidden');
      pairTypeWrap.classList.add('hidden');
    }
  }

  if (sel.value !== '__custom__') {
    pairTypeWrap.classList.remove('hidden');
  }

  // Сброс form
  document.getElementById('hwTask').value = '';
  document.getElementById('hwAuthor').value = localStorage.getItem('hwAuthor') || '';

  // Due mode
  document.querySelectorAll('input[name="hwDueMode"]').forEach(r => r.disabled = false);
  const defaultMode = document.querySelector('input[name="hwDueMode"][value="nextPair"]');
  if (defaultMode) defaultMode.checked = true;
  if (sel.value === '__custom__') {
    document.querySelector('input[name="hwDueMode"][value="nextPair"]').checked = false;
    document.querySelector('input[name="hwDueMode"][value="date"]').checked = true;
  }
  document.getElementById('hwDateWrap').classList.add('hidden');

  // Calendar init
  const today = new Date();
  calState.year = today.getFullYear();
  calState.month = today.getMonth();
  calState.selectedDate = '';
  renderCalendar(calState.year, calState.month, '');
  document.getElementById('hwDateSelected').textContent = '—';

  if (preSubject && prePairType) {
    setPairTypeFromSelected(preSubject);
    if (prePairType !== 'any') {
      document.getElementById('hwPairType').value = prePairType;
    }
  }

  modal.classList.remove('hidden');
  document.getElementById('hwTask').focus();
}

// ── Homework (API) ────────────────────────────────────────────

async function loadHomework() {
  try {
    state.homework = await apiFetch('/api/hw', { group: state.group });
    renderHomework();
  } catch (e) {
    console.warn('HW load failed:', e.message);
    state.homework = [];
    renderHomework();
  }
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

  if (sorted.length === 0) {
    list.innerHTML = '<div class="no-homework">Нет заданий</div>';
    return;
  }

  list.innerHTML = sorted.map(hw => {
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
        dueText = 'Просрочено (' + hw.dueDate + ')';
      } else if (diff === 0) {
        cardClass = 'due-soon';
        dueText = 'Сегодня!';
      } else if (diff <= 2) {
        cardClass = 'due-soon';
        dueText = 'Через ' + diff + ' дн. (' + hw.dueDate + ')';
      } else {
        dueText = hw.dueDate;
      }
    }

    const authorHtml = hw.author
      ? '<div class="hw-author">— ' + escHtml(hw.author) + '</div>'
      : '';

    const subjectHtml = escHtml(hw.subject) +
      (hw.pairType && hw.pairType !== 'any' ? ' <span class="hw-pair-type">(' + escHtml(hw.pairType) + ')</span>' : '');
    const dueModeHint = hw.dueMode === 'nextPair' ? '<span class="hw-mode-hint" title="Автоматически">↻</span>' : '';

    return `
      <div class="hw-card ${cardClass}">
        <div class="hw-info">
          <div class="hw-subject">${subjectHtml} ${dueModeHint}</div>
          <div class="hw-task">${escHtml(hw.task)}</div>
          ${dueText ? `<div class="hw-due ${dueClass}">${dueText}</div>` : ''}
          ${authorHtml}
        </div>
        <button class="hw-delete" data-id="${hw.id}" title="Удалить">✕</button>
      </div>`;
  }).join('');

  list.querySelectorAll('.hw-delete').forEach(btn => {
    btn.onclick = async () => {
      try {
        await apiDelete('/api/hw', { id: btn.dataset.id, group: state.group });
        state.homework = state.homework.filter(h => h.id !== btn.dataset.id);
        renderHomework();
        if (state.schedule) renderDayTabs();
      } catch (e) {
        console.warn('HW delete failed:', e.message);
      }
    };
  });
}

// ── Settings Modal ────────────────────────────────────────────

function setupSettingsModal() {
  const modal = document.getElementById('settingsModal');

  document.getElementById('settingsBtn').onclick = () => {
    document.getElementById('groupInput').value = state.group;
    document.getElementById('apiUrlInput').value = state.apiBase;
    document.getElementById('campusToggle').checked = state.campusEnabled;
    modal.classList.remove('hidden');
  };

  document.getElementById('closeSettings').onclick = () => modal.classList.add('hidden');
  modal.onclick = (e) => { if (e.target === modal) modal.classList.add('hidden'); };

  document.getElementById('saveSettings').onclick = () => {
    state.group = document.getElementById('groupInput').value.trim() || DEFAULT_GROUP;
    state.apiBase = document.getElementById('apiUrlInput').value.trim();
    state.campusEnabled = document.getElementById('campusToggle').checked;
    localStorage.setItem('group', state.group);
    localStorage.setItem('apiBase', state.apiBase);
    localStorage.setItem('campusEnabled', state.campusEnabled ? '1' : '0');
    modal.classList.add('hidden');
    state.selectedDay = null;
    loadData();
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

function parseDate(str) {
  const [d, m, y] = str.split('.');
  return new Date(parseInt(y), parseInt(m) - 1, parseInt(d));
}

function escHtml(str) {
  const d = document.createElement('div');
  d.textContent = str || '';
  return d.innerHTML;
}
