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
// 1. Пробуем получить расписание из KV-кеша Worker'а
// 2. Если кеш пуст — парсим campus.syktsu.ru в браузере и сохраняем в кеш
// 3. Если campus недоступен — показываем что есть в кеше

async function loadData() {
  try {
    await loadWeeks();
    await loadSchedule();
    loadHomework();
  } catch (e) {
    showError('Не удалось загрузить данные: ' + e.message, () => syncAll());
  }
}

async function loadWeeks() {
  try {
    state.weeks = await apiFetch('/api/weeks', { group: state.group });
    findCurrentWeek();
    renderWeekNav();
  } catch (e) {
    // Кеш пуст — пробуем с campus
    await syncWeeksFromCampus();
  }
}

async function loadSchedule() {
  const content = document.getElementById('scheduleContent');
  content.innerHTML = '<div class="loading">Загрузка расписания...</div>';

  const w = state.weeks[state.currentWeekIdx];

  // 1. Пробуем из кеша Worker'а
  try {
    const params = { group: state.group };
    if (w) params.week = w.value;

    state.schedule = await apiFetch('/api/schedule', params);
    applyScheduleHeader();
    renderDayTabs();
    return;
  } catch (e) {
    // Кеш пуст
  }

  // 2. Парсим campus.syktsu.ru
  if (w) {
    try {
      state.schedule = await fetchScheduleFromCampus(state.group, w.value);
      applyScheduleHeader();
      renderDayTabs();
      // Сохраняем в кеш
      await apiPost('/api/upload', {
        type: 'schedule',
        group: state.group,
        weekCode: w.value,
        data: state.schedule,
      });
      return;
    } catch (e) {
      console.warn('Campus unavailable:', e.message);
    }
  }

  // 3. Полный синхрон
  await syncAll();
}

function applyScheduleHeader() {
  document.getElementById('groupName').textContent = state.schedule.group || state.group;
  if (state.schedule.weekStart) {
    document.getElementById('weekRange').textContent =
      state.schedule.weekStart + ' — ' + state.schedule.weekEnd;
  }
}

// ── Sync: загрузить всё из campus и сохранить в кеш ───────────

async function syncAll() {
  if (state.syncing) return;
  state.syncing = true;
  updateSyncUI('syncing');

  try {
    await syncWeeksFromCampus();

    const w = state.weeks[state.currentWeekIdx];
    if (w) {
      state.schedule = await fetchScheduleFromCampus(state.group, w.value);
      applyScheduleHeader();

      await apiPost('/api/upload', {
        type: 'schedule',
        group: state.group,
        weekCode: w.value,
        data: state.schedule,
      });
    }

    renderDayTabs();
    updateSyncUI('ok');
  } catch (e) {
    updateSyncUI('error', e.message);
    // Если есть хотя бы кеш — покажем его
    if (!state.schedule) {
      showError('Не удалось синхронизировать: ' + e.message, () => syncAll());
    }
  } finally {
    state.syncing = false;
  }
}

async function syncWeeksFromCampus() {
  const weeks = await fetchWeeksFromCampus(state.group);
  if (!weeks || weeks.length === 0) {
    throw new Error('Не удалось получить недели');
  }

  await apiPost('/api/upload', {
    type: 'weeks',
    group: state.group,
    weeks,
  });

  state.weeks = weeks;
  findCurrentWeek();
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
  const m = subject.match(/\((л|пр|пз|лаб|с)\)/);
  if (!m) return '';
  const map = {
    'л': 'лекция',
    'пр': 'практика',
    'пз': 'практическое занятие',
    'лаб': 'лабораторная',
    'с': 'семинар',
  };
  return map[m[1]] || m[1];
}

function parsePairCell(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const subject = lines[0] || '';
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

  return { subject, teacher, room, type: parsePairType(subject) };
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

      let subject = '', teacher = '', room = '', type = '';

      const colspanMatch = rest.match(/<td\s+colspan="2">([\s\S]*?)<\/td>/);
      if (colspanMatch) {
        const parsed = parsePairCell(cleanHtml(colspanMatch[1]));
        ({ subject, teacher, room, type } = parsed);
      } else {
        const cols = [];
        const colRegex = /<td[^>]*>([\s\S]*?)<\/td>/g;
        let cm;
        while ((cm = colRegex.exec(rest)) !== null) {
          cols.push(cleanHtml(cm[1]));
        }
        if (cols.length >= 2) {
          const parsed = parsePairCell(cols[0] || cols[1]);
          ({ subject, teacher, room, type } = parsed);
        }
      }

      pairs.push({ num, time, subject, teacher, room, type });
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

function findCurrentWeek() {
  const today = new Date();
  let found = -1;

  for (let i = 0; i < state.weeks.length; i++) {
    const w = state.weeks[i];
    if (w.dates.length >= 2) {
      const start = parseDate(w.dates[0]);
      const end = parseDate(w.dates[1]);
      if (today >= start && today <= end) {
        found = i;
        break;
      }
    }
  }

  state.currentWeekIdx = found >= 0 ? found : 0;
}

function renderWeekNav() {
  const label = document.getElementById('weekLabel');
  const w = state.weeks[state.currentWeekIdx];
  if (w) label.textContent = w.text;

  document.getElementById('prevWeek').onclick = () => {
    if (state.currentWeekIdx > 0) {
      state.currentWeekIdx--;
      renderWeekNav();
      loadSchedule();
    }
  };

  document.getElementById('nextWeek').onclick = () => {
    if (state.currentWeekIdx < state.weeks.length - 1) {
      state.currentWeekIdx++;
      renderWeekNav();
      loadSchedule();
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
      const typeClass = p.type
        ? (p.type.includes('лекц') ? 'лекция'
          : p.type.includes('лабор') ? 'лабораторная'
          : p.type.includes('семинар') ? 'семинар'
          : 'практика')
        : '';

      pairsHtml += `
        <div class="pair-card">
          <div class="pair-top">
            <div style="display:flex;align-items:center;gap:8px;">
              <span class="pair-num">${p.num}</span>
              <span class="pair-time">${p.time}</span>
            </div>
            ${p.type ? `<span class="pair-type ${typeClass}">${p.type}</span>` : ''}
          </div>
          <div class="pair-subject">${escHtml(p.subject)}</div>
          ${p.teacher ? `<div class="pair-teacher">${escHtml(p.teacher)}</div>` : ''}
          ${p.room ? `<div class="pair-room">${escHtml(p.room)}</div>` : ''}
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

    return `
      <div class="hw-card ${cardClass}">
        <div class="hw-info">
          <div class="hw-subject">${escHtml(hw.subject)}</div>
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
    modal.classList.remove('hidden');
  };

  document.getElementById('closeSettings').onclick = () => modal.classList.add('hidden');
  modal.onclick = (e) => { if (e.target === modal) modal.classList.add('hidden'); };

  document.getElementById('saveSettings').onclick = () => {
    state.group = document.getElementById('groupInput').value.trim() || DEFAULT_GROUP;
    state.apiBase = document.getElementById('apiUrlInput').value.trim();
    localStorage.setItem('group', state.group);
    localStorage.setItem('apiBase', state.apiBase);
    modal.classList.add('hidden');
    state.selectedDay = null;
    loadData();
  };
}

// ── Homework Modal ────────────────────────────────────────────

function setupHomeworkModal() {
  const modal = document.getElementById('homeworkModal');

  document.getElementById('addHomeworkBtn').onclick = () => {
    document.getElementById('hwSubject').value = '';
    document.getElementById('hwTask').value = '';
    document.getElementById('hwDueDate').value = '';
    document.getElementById('hwAuthor').value = localStorage.getItem('hwAuthor') || '';
    modal.classList.remove('hidden');
    document.getElementById('hwSubject').focus();
  };

  document.getElementById('closeHomework').onclick = () => modal.classList.add('hidden');
  modal.onclick = (e) => { if (e.target === modal) modal.classList.add('hidden'); };

  document.getElementById('saveHomework').onclick = async () => {
    const subject = document.getElementById('hwSubject').value.trim();
    const task = document.getElementById('hwTask').value.trim();
    const dueDate = document.getElementById('hwDueDate').value;
    const author = document.getElementById('hwAuthor').value.trim();

    if (!subject) return;

    if (author) localStorage.setItem('hwAuthor', author);

    try {
      const result = await apiPost('/api/hw', {
        group: state.group,
        subject,
        task,
        dueDate,
        author,
      });

      state.homework.push(result.item);
      renderHomework();
      modal.classList.add('hidden');
    } catch (e) {
      console.warn('HW save failed:', e.message);
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

function parseDate(str) {
  const [d, m, y] = str.split('.');
  return new Date(parseInt(y), parseInt(m) - 1, parseInt(d));
}

function escHtml(str) {
  const d = document.createElement('div');
  d.textContent = str || '';
  return d.innerHTML;
}
