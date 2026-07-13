// ── Чистые функции (без DOM) ────────────────────────────────────

export const DAY_NAMES = ['Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота', 'Воскресенье'];
export const DAY_SHORT = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];

export function cleanHtml(text) {
  return text
    .replace(/<br\s*\/?>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/\n\s*\n/g, '\n')
    .trim();
}

export function parseWeekOptions(html) {
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

export function parsePairType(subject) {
  const m = subject.match(/\((л|пр|пз|лаб|с|зчО|зач|экз)\.?\)/);
  return m ? m[1] : '';
}

export const PAIR_TYPE_NAMES = {
  'л': 'лекция',
  'пр': 'практика',
  'пз': 'практическое занятие',
  'лаб': 'лабораторная',
  'с': 'семинар',
  'зчО': 'зачёт с оценкой',
  'зач': 'зачёт',
  'экз': 'экзамен',
};

export function parsePairCell(html) {
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

export function parseScheduleHTML(html) {
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

    const cleanPairs = pairs.filter(p => p.subject && p.subject.trim());
    result.days[dayName] = { date: dayDate, pairs: cleanPairs };
  }

  return result;
}

export function parseDate(str) {
  const [d, m, y] = str.split('.');
  return new Date(parseInt(y), parseInt(m) - 1, parseInt(d));
}

export function formatDateToISO(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function formatDateToDisplay(str) {
  if (!str) return '';
  const [y, m, d] = str.split('-');
  return `${d}.${m}.${y}`;
}

export function escHtml(str) {
  const d = document.createElement('div');
  d.textContent = str || '';
  return d.innerHTML;
}

export function extractBaseSubject(subject) {
  return subject.replace(/\s*\((?:л|пр|пз|лаб|с|зчО|зач|экз)\.?\)\s*$/, '').trim();
}

/**
 * Определить текущий семестр: весенний (с 31.01) или осенний (с 1.08).
 * Возвращает строку вида "2025-2026-весна" или "2026-2027-осень".
 */
export function getCurrentSemester() {
  const now = new Date();
  const y = now.getFullYear();
  const month = now.getMonth() + 1;
  const day = now.getDate();

  if (month > 8 || (month === 8 && day >= 1) || (month === 1 && day >= 31) || month === 2 || month === 3 || month === 4 || month === 5 || month === 6 || (month === 7 && day < 31)) {
    const isSpring = month >= 2 && month <= 7;
    if (isSpring || (month === 1 && day >= 31)) {
      return `${y-1}-${y}-весна`;
    }
    return `${y}-${y+1}-осень`;
  }
  return `${y-1}-${y}-осень`;
}

/**
 * Найти следующую дату пары по предмету.
 * Смотрит сначала в текущем расписании (state.schedule), затем пробует
 * подгрузить следующие недели из кеша Worker'а или из campus.syktsu.ru.
 *
 * @param {string} subject - базовое название предмета (без типа)
 * @param {object} opts
 * @param {object} opts.schedule - текущее расписание (state.schedule)
 * @param {Array} opts.weeks - список недель (state.weeks)
 * @param {number} opts.currentWeekIdx - индекс текущей недели
 * @param {Function} opts.fetchWeek - асинхронная функция (weekCode) => scheduleData
 * @param {Date} [opts.fromDate] - от какой даты искать (по умолчанию сегодня)
 * @returns {Promise<string|null>} дата в формате YYYY-MM-DD или null
 */
export async function findNextPairDate(subject, opts = {}) {
  const {
    schedule,
    weeks = [],
    currentWeekIdx = 0,
    fetchWeek = null,
    fromDate = new Date(),
  } = opts;

  if (!schedule || !subject) return null;

  const baseSubject = extractBaseSubject(subject).toLowerCase();

  // Собираем все дни текущей недели
  const allWeeksData = [{ idx: currentWeekIdx, data: schedule }];

  // Если есть функция загрузки, пробуем загрузить соседние недели
  if (fetchWeek && weeks.length > 0) {
    const indicesToTry = [];
    for (let i = currentWeekIdx + 1; i < Math.min(currentWeekIdx + 6, weeks.length); i++) {
      indicesToTry.push(i);
    }
    for (const idx of indicesToTry) {
      try {
        const data = await fetchWeek(weeks[idx].value);
        if (data && data.days && Object.keys(data.days).length > 0) {
          allWeeksData.push({ idx, data });
        }
      } catch (e) {
        // Не загрузилось — пропускаем
      }
    }
  }

  const todayStr = formatDateToISO(fromDate);

  // Ищем ближайший день в будущем (или сегодня, если пара ещё не прошла)
  for (const weekData of allWeeksData) {
    for (const [dayName, dayInfo] of Object.entries(weekData.data.days)) {
      const dayDateISO = formatDateToISO(parseDate(dayInfo.date));
      if (dayDateISO < todayStr) continue;

      const hasSubject = dayInfo.pairs.some(p => {
        if (!p.subject) return false;
        return extractBaseSubject(p.subject).toLowerCase() === baseSubject;
      });

      if (hasSubject) {
        return dayDateISO;
      }
    }
  }

  return null;
}

/**
 * Найти следующую дату пары для предмета, используя только локальные данные.
 * Не делает fetch — только смотрит в переданном расписании.
 */
export function findNextPairDateLocal(subject, schedule, fromDate = new Date()) {
  if (!schedule || !subject) return null;

  const baseSubject = extractBaseSubject(subject).toLowerCase();
  const todayStr = formatDateToISO(fromDate);

  for (const [dayName, dayInfo] of Object.entries(schedule.days)) {
    const dayDateISO = formatDateToISO(parseDate(dayInfo.date));
    if (dayDateISO < todayStr) continue;

    const hasSubject = dayInfo.pairs.some(p => {
      if (!p.subject) return false;
      return extractBaseSubject(p.subject).toLowerCase() === baseSubject;
    });

    if (hasSubject) {
      return dayDateISO;
    }
  }

  return null;
}

/**
 * Обновить dueDate для ДЗ с dueMode='nextPair' на основе текущего расписания.
 * Возвращает массив обновлённых ДЗ (с новыми dueDate).
 */
export function recalcHomeworkDates(homework, schedule, weeks, currentWeekIdx, fetchWeek) {
  if (!homework || !schedule) return [];

  const updated = [];

  for (const hw of homework) {
    if (hw.dueMode !== 'nextPair') continue;
    if (!hw.subject) continue;

    // Используем синхронную версию с текущим расписанием
    const newDate = findNextPairDateLocal(hw.subject, schedule);
    if (newDate && newDate !== hw.dueDate) {
      updated.push({ ...hw, dueDate: newDate });
    }
  }

  return updated;
}

/**
 * Получить все предметы для ДЗ.
 * Сначала предметы из БД (текущий семестр), потом из расписания как fallback.
 * Сортировка: сначала сегодняшние, потом остальные.
 */
export function getAllSubjects(schedule, savedSubjects = []) {
  if (!schedule) return { today: [], all: [] };

  const todayName = DAY_NAMES[new Date().getDay() === 0 ? 6 : new Date().getDay() - 1];

  // Предметы, которые есть сегодня в расписании
  const todayFromSchedule = new Set();
  if (schedule.days[todayName]) {
    for (const p of schedule.days[todayName].pairs) {
      if (p.subject) todayFromSchedule.add(p.subject);
    }
  }

  // Если есть сохранённые предметы из БД
  if (savedSubjects && savedSubjects.length > 0) {
    const today = savedSubjects.filter(s => todayFromSchedule.has(s));
    const rest = savedSubjects.filter(s => !todayFromSchedule.has(s));
    return { today, all: [...today, ...rest] };
  }

  // Fallback: предметы из расписания
  const allSet = new Set();
  const todaySet = new Set();

  for (const [day, data] of Object.entries(schedule.days)) {
    for (const p of data.pairs) {
      if (!p.subject) continue;
      const name = p.subject;
      allSet.add(name);
      if (day === todayName) todaySet.add(name);
    }
  }

  const today = [...todaySet];
  return { today, all: [...today, ...allSet].filter((v, i, a) => a.indexOf(v) === i) };
}

export function getHwForSubject(subj, homework) {
  if (!subj || !homework) return [];
  const base = extractBaseSubject(subj).toLowerCase();
  return homework.filter(h => {
    const hBase = (h.subject || '').toLowerCase();
    return hBase === base;
  });
}

export function getWeeksToSync(weeks, currentWeekIdx) {
  const today = new Date();
  const userIdx = currentWeekIdx;

  let realCurrentIdx = -1;
  for (let i = 0; i < weeks.length; i++) {
    const w = weeks[i];
    if (w.dates.length >= 2) {
      const start = parseDate(w.dates[0]);
      const end = parseDate(w.dates[1]);
      if (today >= start && today <= end) {
        realCurrentIdx = i;
        break;
      }
    }
  }
  if (realCurrentIdx < 0) realCurrentIdx = 0;

  let from, to;
  if (userIdx < realCurrentIdx) {
    from = userIdx;
    to = userIdx;
  } else if (userIdx === realCurrentIdx) {
    from = realCurrentIdx;
    to = Math.min(realCurrentIdx + 4, weeks.length - 1);
  } else {
    from = realCurrentIdx;
    to = Math.min(userIdx + 2, weeks.length - 1);
  }

  const result = [];
  for (let i = from; i <= to; i++) result.push(i);
  return result;
}
