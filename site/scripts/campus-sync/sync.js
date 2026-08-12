#!/usr/bin/env node
// ── Campus sync через прокси Яндекса (translated.turbopages.org) ─────────
// Скрипт для GitHub Actions: кампус (campus.syktsu.ru) принимает запросы
// только из России, поэтому HTML качается через прокси Яндекс.Перевода:
//   https://translated.turbopages.org/proxy_u/<pair>.<uuid>/https/campus.syktsu.ru/...
// Прокси GET-only (POST → 415/405), но кампус принимает поиск через query:
//   ?num_group=<группа>&searchdata=ИСКАТЬ  — недели + якорная неделя
//   ?num_group=<группа>&weeks=<код недели> — конкретная неделя
// Хэш <uuid> минтается GET'ом translate.yandex.com (302 → Location),
// без кук и JS (проверено). Парсер — порт из frontend/app.js с ослабленными
// regex под прокси-разметку (перестановка атрибутов, инжекция tr_page).
//
// Запуск:
//   node sync.js                          # parse + печать сводки
//   GROUP=131-ИБо AHEAD_WEEKS=4 node sync.js
// Выход: 0 при успехе, 1 при ошибке. В конце печатается JSON-сводка.

const CAMPUS_BASE = 'https://campus.syktsu.ru/schedule/group/';
const MINT_URL = 'https://translate.yandex.com/translate?url=';

function log(...args) { console.log(...args); }
function fail(msg) { console.error('[ERROR] ' + msg); process.exit(1); }

// ── Прокси: mint хэша + fetch страницы ───────────────────────────────────

async function mintProxyPrefix() {
  const target = encodeURIComponent(CAMPUS_BASE);
  const resp = await fetch(MINT_URL + target + '&lang=en-ru', {
    redirect: 'manual',
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
  });
  const location = resp.headers.get('location') || '';
  // Location: https://translated.turbopages.org/proxy_u/<pair>.<uuid>/https/campus.syktsu.ru/schedule/group/
  // [^?]+ — весь путь до query (включая слэши), т.е. полный прокси-URL целевой страницы.
  const m = location.match(/https:\/\/translated\.turbopages\.org\/proxy_u\/[^/]+\/https\/[^?]+/);
  if (resp.status !== 302 || !m) {
    throw new Error('Не удалось заминтить прокси-хэш (status=' + resp.status + ', location=' + location.slice(0, 120) + ')');
  }
  return m[0].replace(/\/+$/, '');
}

async function fetchCampusHtml(prefix, group, weekCode) {
  const params = new URLSearchParams();
  params.set('num_group', group);
  if (weekCode) params.set('weeks', weekCode);
  else params.set('searchdata', 'ИСКАТЬ');
  const url = prefix + '/?' + params.toString();
  const resp = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
  });
  if (!resp.ok) throw new Error('Прокси-кампус: HTTP ' + resp.status + ' для ' + url.slice(0, 150));
  const buf = await resp.arrayBuffer();
  return decodeCampusHtml(buf, resp.headers.get('content-type') || '');
}

// Прокси нормализует кодировку в UTF-8, но кампус напрямую отдаёт
// windows-1251 — определяем по заголовку и meta charset (лат1-чтение
// буфера сохраняет байты 1:1, ASCII-паттерны работают при любой кодировке).
function decodeCampusHtml(buf, contentType) {
  const ascii = Buffer.from(buf).toString('latin1');
  const headerUtf8 = /charset=["']?utf-?8/i.test(contentType);
  const metaUtf8 = /charset=["']?utf-?8/i.test(ascii);
  const meta1251 = /charset=["']?(windows-1251|cp1251)/i.test(ascii);
  if (meta1251 && !headerUtf8 && !metaUtf8) return new TextDecoder('windows-1251').decode(buf);
  return new TextDecoder('utf-8').decode(buf);
}

// ── HTML Parser (порт из frontend/app.js) ────────────────────────────────

function cleanHtml(text) {
  return text
    .replace(/<br\s*\/?>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/\u00a0/g, ' ')
    .replace(/[\t ]+/g, ' ')
    .replace(/\n\s*\n/g, '\n')
    .trim();
}

// Прокси переставляет атрибуты: <select id="weeks" name="weeks"> —
// поэтому regex ослаблены (name/value ищутся в любом месте тега).
function parseWeekOptions(html) {
  const selectMatch = html.match(/<select[^>]*\bname="weeks"[^>]*>([\s\S]*?)<\/select>/);
  if (!selectMatch) return [];

  const options = [];
  const optRegex = /<option[^>]*\bvalue="(\d+_[^"]+)"[^>]*>([\s\S]*?)<\/option>/g;
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

function parsePairType(subject) {
  const m = subject.match(/\((л|пр|пз|лаб|с|зчО|зач|экз)\.?\)/);
  return m ? m[1] : '';
}

function parsePairCell(html) {
  const subgroupMatch = html.match(/<b>\s*(подгруппа\s*\d)\s*<\/b>/i);
  const subgroup = subgroupMatch ? subgroupMatch[1].trim() : '';

  const text = html
    .replace(/<b>[^<]*<\/b>/g, '')
    .replace(/<br\s*\/?>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/\u00a0/g, ' ')
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
  const result = { group: '', weekStart: '', weekEnd: '', days: {} };

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

  const dayHeaderRegex = /class="dayofweek[^"]*"[^>]*>([^<]*)<br\s*\/?>\((\d{2}\.\d{2}\.\d{4})\)/g;
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

function extractCampusUpdatedAt(html) {
  const m = html.match(/Расписание обновлено\s+(\d{2}\.\d{2}\.\d{4})\s+(\d{2}:\d{2}:\d{2})/);
  if (!m) return '';
  const [_, date, time] = m;
  const [d, mo, y] = date.split('.');
  return `${y}-${mo}-${d}T${time}`;
}

// ── Main ─────────────────────────────────────────────────────────────────

function parseDateDDMMYYYY(s) {
  const [d, mo, y] = s.split('.');
  return new Date(+y, +mo - 1, +d);
}

function findCurrentWeek(weeks) {
  if (!weeks.length) return 0;
  const now = new Date();
  for (let i = 0; i < weeks.length; i++) {
    const [from, to] = weeks[i].dates;
    if (from && to) {
      const f = parseDateDDMMYYYY(from);
      const t = parseDateDDMMYYYY(to);
      if (now >= f && now <= t) return i;
    }
  }
  return 0;
}

async function main() {
  const group = (process.env.GROUP || process.env.CAMPUS_GROUP || '131-ИБо').trim().toLowerCase();
  const ahead = Math.max(0, parseInt(process.env.AHEAD_WEEKS || '4', 10) || 0);

  log('=== Campus sync через прокси Яндекса ===');
  log('Группа: ' + group + ', недель вперёд: ' + ahead);
  log('');

  log('[1/3] Минтим прокси-хэш...');
  const prefix = await mintProxyPrefix();
  log('      префикс: ' + prefix.slice(0, 90) + '…');

  log('[2/3] Качаем недели (' + CAMPUS_BASE + '?...searchdata)…');
  const weeksHtml = await fetchCampusHtml(prefix, group);
  const weeks = parseWeekOptions(weeksHtml);
  if (!weeks.length) {
    throw new Error('Не удалось распарсить список недель — группа не найдена или разметка изменилась');
  }
  const campusUpdatedAt = extractCampusUpdatedAt(weeksHtml);
  log('      недель: ' + weeks.length + (campusUpdatedAt ? ', обновлено: ' + campusUpdatedAt : ', обновлено: не найдено'));
  log('      первые: ' + weeks.slice(0, 2).map(w => w.text).join(' | '));
  log('      последняя: ' + weeks[weeks.length - 1].text);

  const currentIdx = findCurrentWeek(weeks);
  log('');
  log('[3/3] Качаем расписание: текущая (' + (currentIdx + 1) + '-я из списка) + ' + ahead + ' вперёд…');

  const indices = [];
  for (let i = currentIdx; i < Math.min(weeks.length, currentIdx + 1 + ahead); i++) indices.push(i);

  const parsed = [];
  for (const i of indices) {
    const w = weeks[i];
    const html = await fetchCampusHtml(prefix, group, w.value);
    const data = parseScheduleHTML(html);
    data.campusUpdatedAt = extractCampusUpdatedAt(html);
    let totalPairs = 0;
    const daysSummary = {};
    for (const [dayName, day] of Object.entries(data.days)) {
      const nonEmpty = day.pairs.filter(p => p.subject);
      totalPairs += nonEmpty.length;
      if (nonEmpty.length) {
        daysSummary[dayName] = nonEmpty.map(p => p.num + ' ' + p.time + ' ' + p.subject + (p.type ? ' (' + p.type + ')' : '') + (p.teacher ? ' — ' + p.teacher : '')).join('; ');
      }
    }
    parsed.push({
      weekCode: w.value,
      weekText: w.text,
      weekStart: data.weekStart,
      weekEnd: data.weekEnd,
      days: Object.keys(data.days).length,
      pairs: totalPairs,
      daysSummary,
    });
    log('  ' + w.value + ' [' + w.text + ']: дней=' + Object.keys(data.days).length + ', пар=' + totalPairs);
    for (const [dayName, s] of Object.entries(daysSummary)) {
      log('      ' + dayName + ': ' + s);
    }
  }

  const summary = {
    ok: true,
    group,
    weeksTotal: weeks.length,
    campusUpdatedAt,
    parsedWeeks: parsed.length,
    totalPairs: parsed.reduce((acc, p) => acc + p.pairs, 0),
    weeks: parsed.map(p => ({ weekCode: p.weekCode, weekText: p.weekText, pairs: p.pairs })),
  };
  log('');
  log('=== СВОДКА (JSON) ===');
  log(JSON.stringify(summary, null, 2));
  log('=== ГОТОВО ===');
}

main().catch((e) => {
  fail(e && e.message ? e.message : String(e));
});
