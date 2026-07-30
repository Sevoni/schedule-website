#!/usr/bin/env node

const CAMPUS_URL = 'https://campus.syktsu.ru/schedule/group/';

function cleanHtml(text) {
  return text
    .replace(/<br\s*\/?>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/[\t ]+/g, ' ')
    .replace(/\n\s*\n/g, '\n')
    .trim();
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

function parseWeekOptions(html) {
  const selectMatch = html.match(/<select\s+name="weeks"[^>]*>([\s\S]*?)<\/select>/);
  if (!selectMatch) return [];

  const options = [];
  const optRegex = /<option\s+value="(\d+_[^"]+)"[^>]*>([\s\S]*?)<\/option>/g;
  let m;
  while ((m = optRegex.exec(selectMatch[1])) !== null) {
    const rawValue = m[1];
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

function extractCampusUpdatedAt(html) {
  const m = html.match(/Расписание обновлено\s+(\d{2}\.\d{2}\.\d{4})\s+(\d{2}:\d{2}:\d{2})/);
  if (!m) return '';
  const [_, date, time] = m;
  const [d, mo, y] = date.split('.');
  return `${y}-${mo}-${d}T${time}`;
}

async function fetchCampus(group, weekCode) {
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

  if (!resp.ok) throw new Error(`Campus HTTP ${resp.status}`);
  return await resp.text();
}

async function fetchWeeks(group) {
  const html = await fetchCampus(group, null);
  const weeks = parseWeekOptions(html);
  weeks._campusUpdatedAt = extractCampusUpdatedAt(html);
  return weeks;
}

async function fetchSchedule(group, weekCode) {
  const html = await fetchCampus(group, weekCode);
  const data = parseScheduleHTML(html);
  data.campusUpdatedAt = extractCampusUpdatedAt(html);
  return data;
}

async function main() {
  const group = process.argv[2] || '131-ИБо';
  const weekFilter = process.argv[3] || null;

  console.error(`Группа: ${group}`);
  if (weekFilter) console.error(`Неделя: ${weekFilter}`);

  try {
    const weeks = await fetchWeeks(group);
    console.error(`Найдено недель: ${weeks.length}`);

    const allData = { group, weeks, schedules: [] };

    const weeksToFetch = weekFilter
      ? weeks.filter(w => w.weekNum === weekFilter || w.value === weekFilter)
      : weeks;

    for (const w of weeksToFetch) {
      console.error(`Загружаю неделю ${w.value}...`);
      const sched = await fetchSchedule(group, w.value);
      allData.schedules.push({ week: w, schedule: sched });
    }

    console.log(JSON.stringify(allData, null, 2));
  } catch (err) {
    console.error('Ошибка:', err.message);
    process.exit(1);
  }
}

main();
