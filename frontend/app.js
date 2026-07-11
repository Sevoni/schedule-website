const G = '131-ИБо';
const DAYS = ['Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота', 'Воскресенье'];
const DS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
const CAMPUS_URL = 'https://campus.syktsu.ru/schedule/group/';

let S = {
  group: localStorage.getItem('group') || G,
  schedule: null,
  weeks: [],
  weekIdx: -1,
  selDay: null,
  hw: [],
  syncing: false,
};

// ── Парсинг HTML ──

function clean(t) {
  if (!t) return '';
  t = t.replace(/<br\s*\/?>/gi, '\n');
  t = t.replace(/<[^>]+>/g, '');
  t = t.replace(/&nbsp;/g, ' ');
  t = t.replace(/\n\s*\n/g, '\n');
  return t.trim();
}

function ptype(s) {
  const m = s.match(/\((л|пр|пз|лаб|с)\)/);
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

function parseCell(t) {
  const lines = t.split('\n').map(l => l.trim()).filter(l => l);
  const subj = lines[0] || '';
  let tea = '', rm = '';

  if (lines.length > 1) {
    const last = lines[lines.length - 1];
    const rm_m = last.match(/(\d+\/\d+|\d+)$/);
    if (rm_m) {
      rm = rm_m[1];
      tea = last.substring(0, rm_m.index).trim().replace(/,$/, '').trim();
    } else {
      tea = last;
    }
  }

  return { subject: subj, teacher: tea, room: rm, type: ptype(subj) };
}

function parseWeeks(html) {
  const sm = html.match(/<select\s+name="weeks"[^>]*>([\s\S]*?)<\/select>/);
  if (!sm) return [];

  const opts = [];
  const re = /<option\s+value="(\d+_[^"]+)"[^>]*>([\s\S]*?)<\/option>/g;
  let m;

  while ((m = re.exec(sm[1])) !== null) {
    const text = clean(m[2]);
    const dates = text.match(/\d{2}\.\d{2}\.\d{4}/g) || [];
    opts.push({
      value: m[1],
      text: text,
      weekNum: m[1].split('_')[0],
      dates: dates,
    });
  }

  return opts;
}

function parseSchedule(html) {
  const R = {
    group: '',
    weekStart: '',
    weekEnd: '',
    days: {},
    parsedAt: new Date().toISOString(),
  };

  const hm = html.match(/на\s+неделю\s+c\s+(\d{2}\.\d{2}\.\d{4})\s+по\s+(\d{2}\.\d{2}\.\d{4})/);
  if (hm) {
    R.weekStart = hm[1];
    R.weekEnd = hm[2];
  }

  const gm = html.match(/для\s+группы\s+([^\s<]+)/);
  if (gm) {
    R.group = gm[1];
  } else {
    R.group = S.group;
  }

  const tm = html.match(/<table\s[^>]*class="schedule"[^>]*>([\s\S]*?)<\/table>/);
  if (!tm) return R;

  const raw = tm[1];

  // Дни недели
  const dhsRegex = /class="dayofweek[^"]*"[^>]*>([^<]*)<br>\((\d{2}\.\d{2}\.\d{4})\)/g;
  let dhs = [];
  let match;

  while ((match = dhsRegex.exec(raw)) !== null) {
    dhs.push({
      text: match[1],
      date: match[2],
      start: match.index,
      end: dhsRegex.lastIndex,
    });
  }

  for (let i = 0; i < dhs.length; i++) {
    const dm = dhs[i];
    const dn = clean(dm.text);
    const dd = dm.date;

    const cs = dm.end;
    const ce = (i + 1 < dhs.length) ? dhs[i + 1].start : raw.length;
    const dc = raw.substring(cs, ce);

    // Пары
    const pairs = [];
    const pmRegex = /<td>(\d)<\/td><td>(\d{2}:\d{2})<\/td>([\s\S]*?)(?=<td>\d<\/td>|<\/tr>)/g;
    let pMatch;

    while ((pMatch = pmRegex.exec(dc)) !== null) {
      const n = parseInt(pMatch[1]);
      const t = pMatch[2];
      const rest = pMatch[3];

      let s = '', te = '', r = '', ty = '';

      const cm = rest.match(/<td\s+colspan="2">([\s\S]*?)<\/td>/);
      if (cm) {
        const p = parseCell(clean(cm[1]));
        s = p.subject;
        te = p.teacher;
        r = p.room;
        ty = p.type;
      } else {
        const tdRegex = /<td[^>]*>([\s\S]*?)<\/td>/g;
        let cols = [];
        let tdMatch;

        while ((tdMatch = tdRegex.exec(rest)) !== null) {
          cols.push(clean(tdMatch[1]));
        }

        if (cols.length >= 2) {
          const p = parseCell(cols[0] || cols[1]);
          s = p.subject;
          te = p.teacher;
          r = p.room;
          ty = p.type;
        }
      }

      pairs.push({
        num: n,
        time: t,
        subject: s,
        teacher: te,
        room: r,
        type: ty,
      });
    }

    R.days[dn] = { date: dd, pairs: pairs };
  }

  return R;
}

// ── Утилиты ──

function pd(s) {
  const [a, b, c] = s.split('.');
  return new Date(+c, +b - 1, +a);
}

function esc(s) {
  const d = document.createElement('div');
  d.textContent = s || '';
  return d.innerHTML;
}

function enc(s) {
  return encodeURIComponent(s);
}

// ── Запросы к campus ──

async function campusPost(group, extra) {
  const fd = new URLSearchParams();
  fd.append('num_group', group);

  if (extra) {
    for (const [k, v] of Object.entries(extra)) {
      fd.append(k, v);
    }
  } else {
    fd.append('searchdata', 'ИСКАТЬ');
  }

  const r = await fetch(CAMPUS_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
    body: fd.toString(),
  });

  if (!r.ok) throw new Error('Сетевой сбой: ' + r.status);
  return await r.text();
}

// ── Загрузка данных ──

async function loadAll() {
  try {
    const html = await campusPost(S.group);
    S.weeks = parseWeeks(html);
    findWeek();
    renderWeekNav();

    const weekVal = S.weeks[S.weekIdx]?.value;
    let scheduleHtml = html;

    if (weekVal) {
      scheduleHtml = await campusPost(S.group, { weeks: weekVal, searchdata: 'ИСКАТЬ' });
    }

    S.schedule = parseSchedule(scheduleHtml);
    document.getElementById('groupName').textContent = S.schedule.group || S.group;

    if (S.schedule.weekStart) {
      document.getElementById('weekRange').textContent =
        S.schedule.weekStart + ' — ' + S.schedule.weekEnd;
    }

    renderDays();
  } catch (e) {
    document.getElementById('scheduleContent').innerHTML =
      '<div class="em">' + esc(e.message) + '<br><button onclick="doSync()">Повторить</button></div>';
  }
}

async function loadWeek() {
  try {
    const weekVal = S.weeks[S.weekIdx]?.value;
    const html = await campusPost(S.group, weekVal ? { weeks: weekVal, searchdata: 'ИСКАТЬ' } : null);
    S.schedule = parseSchedule(html);

    document.getElementById('groupName').textContent = S.schedule.group || S.group;

    if (S.schedule.weekStart) {
      document.getElementById('weekRange').textContent =
        S.schedule.weekStart + ' — ' + S.schedule.weekEnd;
    }

    renderDays();
  } catch (e) {
    // тихо
  }
}

async function doSync() {
  if (S.syncing) return;
  S.syncing = true;
  setSync('syncing');

  try {
    await loadAll();
    setSync('ok');
  } catch (e) {
    setSync('error', e.message);
  } finally {
    S.syncing = false;
  }
}

// ── Навигация по неделям ──

function findWeek() {
  const now = new Date();
  let f = -1;

  for (let i = 0; i < S.weeks.length; i++) {
    const w = S.weeks[i];
    if (w.dates.length >= 2) {
      const a = pd(w.dates[0]);
      const b = pd(w.dates[1]);
      if (now >= a && now <= b) {
        f = i;
        break;
      }
    }
  }

  S.weekIdx = f >= 0 ? f : 0;
}

function renderWeekNav() {
  document.getElementById('wl').textContent =
    S.weeks[S.weekIdx]?.text || 'Нет данных';

  document.getElementById('prevWeek').onclick = () => {
    if (S.weekIdx > 0) {
      S.weekIdx--;
      renderWeekNav();
      loadWeek();
    }
  };

  document.getElementById('nextWeek').onclick = () => {
    if (S.weekIdx < S.weeks.length - 1) {
      S.weekIdx++;
      renderWeekNav();
      loadWeek();
    }
  };
}

// ── Отрисовка дней ──

function renderDays() {
  const tabs = document.getElementById('dayTabs');
  const days = Object.keys(S.schedule.days);
  const tn = DAYS[new Date().getDay() === 0 ? 6 : new Date().getDay() - 1];

  let def = days[0];
  for (const d of days) {
    if (S.schedule.days[d].pairs.some(p => p.subject)) {
      def = d;
      break;
    }
  }

  if (!S.selDay || !days.includes(S.selDay)) {
    S.selDay = days.includes(tn) ? tn : def;
  }

  const key = days.join(',');

  if (tabs.dataset.key !== key) {
    tabs.dataset.key = key;
    tabs.innerHTML = '';

    days.forEach(day => {
      const t = document.createElement('button');
      t.className = 'dp';

      if (day === S.selDay) t.classList.add('on');
      if (day === tn) t.classList.add('td');

      const di = DAYS.indexOf(day);
      t.textContent = di >= 0 ? DS[di] : day.slice(0, 2);
      t.title = day + ' (' + S.schedule.days[day].date + ')';

      t.onclick = () => {
        S.selDay = day;
        document.querySelectorAll('.dp').forEach(x => x.classList.remove('on'));
        t.classList.add('on');
        renderDay(day);
      };

      tabs.appendChild(t);
    });
  } else {
    tabs.querySelectorAll('.dp').forEach(t => {
      const di = DS.indexOf(t.textContent);
      const day = di >= 0 ? DAYS[di] : t.title.split(' (')[0];
      t.classList.toggle('on', day === S.selDay);
    });
  }

  renderDay(S.selDay);
}

function renderDay(day) {
  const c = document.getElementById('scheduleContent');
  const dd = S.schedule.days[day];

  if (!dd) {
    c.innerHTML = '<div class="np">Нет данных</div>';
    return;
  }

  const ap = dd.pairs.filter(p => p.subject);
  const key = day + dd.date + ap.length;

  if (c.dataset.key === key) return;
  c.dataset.key = key;

  let h = '';

  if (!ap.length) {
    h = '<div class="np">Нет пар 🎉</div>';
  } else {
    for (const p of ap) {
      const tc = p.type
        ? (p.type.includes('лекц') ? 'l'
          : p.type.includes('лабор') ? 'lb'
          : p.type.includes('семинар') ? 's'
          : 'pr')
        : '';

      h += `
        <div class="pc">
          <div class="ptop">
            <div style="display:flex;align-items:center;gap:8px">
              <span class="pn">${p.num}</span>
              <span class="ptm">${p.time}</span>
            </div>
            ${p.type ? `<span class="ptp ${tc}">${p.type}</span>` : ''}
          </div>
          <div class="ps">${esc(p.subject)}</div>
          ${p.teacher ? `<div class="ptc">${esc(p.teacher)}</div>` : ''}
          ${p.room ? `<div class="pr">${esc(p.room)}</div>` : ''}
        </div>`;
    }
  }

  c.innerHTML = `
    <div class="ds">
      <div class="dh">${day}<span class="dd">${dd.date}</span></div>
      ${h}
    </div>`;
}

// ── Статус синхронизации ──

function setSync(st, msg) {
  const el = document.getElementById('syncStatus');

  if (st === 'syncing') {
    el.innerHTML = '<span class="si sp">⟳</span> Загрузка...';
    el.className = 'ss syncing';
  } else if (st === 'ok') {
    el.innerHTML = '<span class="si">✓</span> ' + new Date().toLocaleTimeString('ru');
    el.className = 'ss ok';
  } else if (st === 'error') {
    el.innerHTML = '<span class="si">✕</span> ' + esc(msg);
    el.className = 'ss error';
  }
}

// ── Домашние задания ──

function loadHwUI() {
  const l = document.getElementById('hwList');
  const now = new Date();
  now.setHours(0, 0, 0, 0);

  const sorted = [...S.hw].sort((a, b) => {
    if (!a.due) return 1;
    if (!b.due) return -1;
    return new Date(a.due) - new Date(b.due);
  });

  if (!sorted.length) {
    l.innerHTML = '<div class="nh">Нет заданий</div>';
    return;
  }

  l.innerHTML = sorted.map(hw => {
    let cc = '', dc = '', dt = '';

    if (hw.due) {
      const d = new Date(hw.due);
      d.setHours(0, 0, 0, 0);
      const df = Math.ceil((d - now) / 864e5);

      if (df < 0) {
        cc = 'overdue';
        dc = 'overdue';
        dt = 'Просрочено';
      } else if (df === 0) {
        cc = 'due-soon';
        dt = 'Сегодня!';
      } else if (df <= 2) {
        cc = 'due-soon';
        dt = 'Через ' + df + ' дн.';
      } else {
        dt = hw.due;
      }
    }

    return `
      <div class="hc ${cc}">
        <div class="hi">
          <div class="hsb">${esc(hw.subj)}</div>
          <div class="hsk">${esc(hw.task)}</div>
          ${dt ? `<div class="hdu ${dc}">${dt}</div>` : ''}
        </div>
        <button class="hdl" data-id="${hw.id}">✕</button>
      </div>`;
  }).join('');

  l.querySelectorAll('.hdl').forEach(b => {
    b.onclick = () => {
      S.hw = S.hw.filter(h => h.id !== b.dataset.id);
      saveHw();
      loadHwUI();
    };
  });
}

function saveHw() {
  localStorage.setItem('hw', JSON.stringify(S.hw));
}

// ── Настройки ──

function setupSet() {
  const m = document.getElementById('settingsModal');

  document.getElementById('settingsBtn').onclick = () => {
    document.getElementById('groupIn').value = S.group;
    m.classList.remove('hidden');
  };

  document.getElementById('closeSet').onclick = () => m.classList.add('hidden');

  m.onclick = e => {
    if (e.target === m) m.classList.add('hidden');
  };

  document.getElementById('saveSet').onclick = () => {
    S.group = document.getElementById('groupIn').value.trim() || G;
    localStorage.setItem('group', S.group);
    m.classList.add('hidden');
    S.selDay = null;
  };
}

// ── Модалка ДЗ ──

function setupHw() {
  const m = document.getElementById('hwModal');

  document.getElementById('addHwBtn').onclick = () => {
    document.getElementById('hwSubj').value = '';
    document.getElementById('hwTask').value = '';
    document.getElementById('hwDue').value = '';
    m.classList.remove('hidden');
    document.getElementById('hwSubj').focus();
  };

  document.getElementById('closeHw').onclick = () => m.classList.add('hidden');

  m.onclick = e => {
    if (e.target === m) m.classList.add('hidden');
  };

  document.getElementById('saveHw').onclick = () => {
    const s = document.getElementById('hwSubj').value.trim();
    const t = document.getElementById('hwTask').value.trim();
    const d = document.getElementById('hwDue').value;

    if (!s) return;

    S.hw.push({
      id: Date.now().toString(36),
      subj: s,
      task: t,
      due: d,
    });

    saveHw();
    loadHwUI();
    m.classList.add('hidden');
  };
}

// ── Инициализация ──

document.addEventListener('DOMContentLoaded', () => {
  loadHwUI();
  setupSet();
  setupHw();
  document.getElementById('syncBtn').onclick = doSync;
  loadAll();
});
