/* NHL-schema — statiskt fantasyverktyg. Ingen build, inga beroenden. */

const API = 'https://api-web.nhle.com/v1';
const $ = (sel) => document.querySelector(sel);

const state = {
  schedule: null,   // { season, updated, teams, games }
  weeks: [],        // [{ label, number, start, end }]
  pick: '0',        // index i weeks, 'season' eller 'custom'
  custom: { start: null, end: null },
  offMax: 8,
  minGp: 0,
  division: 'all',
  sort: { key: 'gp', dir: -1 },
  pinned: new Set(),
};

/* ── Datum, allt i UTC ──────────────────────────────────────── */
const toDate = (s) => new Date(`${s}T00:00:00Z`);
const toISO = (d) => d.toISOString().slice(0, 10);
const addDays = (s, n) => {
  const d = toDate(s);
  d.setUTCDate(d.getUTCDate() + n);
  return toISO(d);
};
const dayRange = (a, b) => {
  const out = [];
  for (let c = a; c <= b && out.length < 400; c = addDays(c, 1)) out.push(c);
  return out;
};

const fmtWeekday = new Intl.DateTimeFormat('sv-SE', { weekday: 'short', timeZone: 'UTC' });
const fmtLong = new Intl.DateTimeFormat('sv-SE', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const shortDate = (s) => {
  const d = toDate(s);
  return `${d.getUTCDate()}/${d.getUTCMonth() + 1}`;
};
const seasonLabel = (s) => `${s.slice(0, 4)}-${s.slice(6)}`;

/* ── Inläsning ──────────────────────────────────────────────── */
async function boot() {
  wire();
  let schedule = null;
  try {
    const res = await fetch('data/schedule.json', { cache: 'no-cache' });
    if (res.ok) schedule = await res.json();
  } catch { /* saknas eller file:// */ }

  if (!schedule) {
    show('empty');
    return;
  }

  let weeks = null;
  try {
    const res = await fetch('data/weeks.json', { cache: 'no-cache' });
    if (res.ok) weeks = (await res.json()).weeks;
  } catch { /* valfri */ }

  start(schedule, weeks);
}

function start(schedule, weeks) {
  state.schedule = schedule;
  state.weeks = weeks?.length ? weeks : defaultWeeks(schedule.games);

  $('#seasonLabel').textContent = seasonLabel(schedule.season);
  $('#stamp').textContent = schedule.updated
    ? `Uppdaterat ${new Intl.DateTimeFormat('sv-SE', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(schedule.updated))}`
    : '';

  fillWeekPicker();
  fillDivisionPicker();
  state.pick = String(pickCurrentWeek());
  $('#weekPick').value = state.pick;

  show('schedule');
  render();
}

function pickCurrentWeek() {
  const today = toISO(new Date());
  const i = state.weeks.findIndex((w) => today >= w.start && today <= w.end);
  if (i >= 0) return i;
  const next = state.weeks.findIndex((w) => w.start > today);
  return next >= 0 ? next : 0;
}

/* ── Urval ──────────────────────────────────────────────────── */
function activeRange() {
  const regular = state.schedule.games.filter((g) => g.type === 2).map((g) => g.date).sort();
  if (state.pick === 'season') {
    return { start: regular[0], end: regular[regular.length - 1], label: 'Hela grundserien' };
  }
  if (state.pick === 'custom') {
    const start = state.custom.start ?? regular[0];
    const end = state.custom.end ?? start;
    return { start, end: end < start ? start : end, label: 'Eget intervall' };
  }
  const w = state.weeks[Number(state.pick)] ?? state.weeks[0];
  return { start: w.start, end: w.end, label: w.label };
}

function buildTable() {
  const { start, end, label } = activeRange();
  const days = dayRange(start, end);
  const inRange = new Set(days);

  const gamesByDay = new Map(days.map((d) => [d, []]));
  const playsOn = new Map(); // "TOR|2026-10-07" -> match

  for (const g of state.schedule.games) {
    if (g.type !== 2) continue;
    playsOn.set(`${g.home}|${g.date}`, g);
    playsOn.set(`${g.away}|${g.date}`, g);
    if (inRange.has(g.date)) gamesByDay.get(g.date).push(g);
  }

  const offNight = new Map(days.map((d) => [d, gamesByDay.get(d).length <= state.offMax]));

  const rows = state.schedule.teams.map((team) => {
    let gp = 0, off = 0, b2b = 0;
    const cells = days.map((day) => {
      const g = playsOn.get(`${team.abbrev}|${day}`);
      if (!g) return null;
      gp++;
      if (offNight.get(day)) off++;
      const back = playsOn.has(`${team.abbrev}|${addDays(day, -1)}`);
      if (back) b2b++;
      return { home: g.home === team.abbrev, opp: g.home === team.abbrev ? g.away : g.home, b2b: back };
    });
    return { team, cells, gp, off, b2b };
  });

  return { days, gamesByDay, offNight, rows, label, start, end };
}

/* ── Rendering ──────────────────────────────────────────────── */
function render() {
  const t = buildTable();

  const visible = t.rows
    .filter((r) => r.gp >= state.minGp)
    .filter((r) => state.division === 'all' || r.team.division === state.division)
    .sort(compare);

  renderReadout(t, visible);
  renderHead(t);
  renderBody(t, visible);
  $('#clearPins').hidden = state.pinned.size === 0;
}

function compare(a, b) {
  const { key, dir } = state.sort;
  if (key === 'team') return a.team.abbrev.localeCompare(b.team.abbrev) * dir;
  const diff = (a[key] - b[key]) * dir;
  return diff || b.gp - a.gp || a.team.abbrev.localeCompare(b.team.abbrev);
}

function renderReadout(t, visible) {
  const total = t.days.reduce((n, d) => n + t.gamesByDay.get(d).length, 0);
  const offDays = t.days.filter((d) => t.offNight.get(d));
  const offText = offDays.length
    ? offDays.map((d) => `${fmtWeekday.format(toDate(d))} ${shortDate(d)}`).join(', ')
    : 'inga';
  $('#readout').innerHTML =
    `<b>${t.label}</b> · ${fmtLong.format(toDate(t.start))} – ${fmtLong.format(toDate(t.end))} · `
    + `${t.days.length} ${t.days.length === 1 ? 'dag' : 'dagar'} · ${total} matcher · ${visible.length} lag i listan<br>`
    + `Lediga kvällar (≤ ${state.offMax} matcher): ${offText}`;
}

function renderHead(t) {
  const arrow = (key) => (state.sort.key === key ? ` <span class="arrow">${state.sort.dir < 0 ? '▼' : '▲'}</span>` : '');
  const dayCols = t.days.map((d) => {
    const n = t.gamesByDay.get(d).length;
    const cls = t.offNight.get(d) ? ' class="is-off"' : '';
    return `<th${cls}>`
      + `<span class="day-name">${fmtWeekday.format(toDate(d))}</span>`
      + `<span class="day-date">${shortDate(d)}</span>`
      + `<span class="day-load">${n}</span></th>`;
  }).join('');

  $('#gridHead').innerHTML = `<tr>
    <th class="col-team sortable" data-sort="team">Lag${arrow('team')}</th>
    ${dayCols}
    <th class="num sortable" data-sort="gp" title="Matcher i perioden">Matcher${arrow('gp')}</th>
    <th class="num sortable" data-sort="off" title="Matcher på lediga kvällar">Lediga${arrow('off')}</th>
    <th class="num sortable" data-sort="b2b" title="Matcher dagen efter en match">B2B${arrow('b2b')}</th>
  </tr>`;

  for (const th of $('#gridHead').querySelectorAll('.sortable')) {
    th.addEventListener('click', () => {
      const key = th.dataset.sort;
      if (state.sort.key === key) state.sort.dir *= -1;
      else state.sort = { key, dir: key === 'team' ? 1 : -1 };
      render();
    });
  }
}

function renderBody(t, visible) {
  $('#gridBody').innerHTML = visible.map((r) => {
    const cells = r.cells.map((c, i) => {
      const off = t.offNight.get(t.days[i]) ? ' is-off' : '';
      if (!c) return `<td class="cell${off}"></td>`;
      const cls = `chip ${c.home ? 'chip-home' : 'chip-away'}${c.b2b ? ' b2b' : ''}`;
      const text = c.home ? c.opp : `@${c.opp}`;
      return `<td class="cell${off}"><span class="${cls}">${text}</span></td>`;
    }).join('');

    return `<tr class="${state.pinned.has(r.team.abbrev) ? 'is-pinned' : ''}">
      <td class="col-team">
        <button class="team-btn" data-team="${r.team.abbrev}">
          <span class="team-abv">${r.team.abbrev}</span>
          <span class="team-name">${r.team.name ?? ''}</span>
        </button>
      </td>
      ${cells}
      <td class="num${r.gp === 0 ? ' gp-0' : ''}">${r.gp}</td>
      <td class="num stat-2">${r.off}</td>
      <td class="num stat-2">${r.b2b}</td>
    </tr>`;
  }).join('');

  for (const btn of $('#gridBody').querySelectorAll('.team-btn')) {
    btn.addEventListener('click', () => {
      const abv = btn.dataset.team;
      state.pinned.has(abv) ? state.pinned.delete(abv) : state.pinned.add(abv);
      render();
    });
  }
}

/* ── Väljare ────────────────────────────────────────────────── */
function fillWeekPicker() {
  const opts = state.weeks.map((w, i) =>
    `<option value="${i}">${w.label} · ${fmtLong.format(toDate(w.start))} – ${fmtLong.format(toDate(w.end))}</option>`);
  $('#weekPick').innerHTML = opts.join('')
    + '<option value="season">Hela grundserien</option>'
    + '<option value="custom">Eget intervall…</option>';
}

function fillDivisionPicker() {
  const divs = [...new Set(state.schedule.teams.map((t) => t.division).filter(Boolean))].sort();
  $('#divPick').innerHTML = '<option value="all">Alla</option>'
    + divs.map((d) => `<option value="${d}">${d}</option>`).join('');
}

/* ── Veckoredigeraren ───────────────────────────────────────── */
function defaultWeeks(games) {
  const dates = games.filter((g) => g.type === 2).map((g) => g.date).sort();
  if (!dates.length) return [];
  const last = dates[dates.length - 1];
  const weeks = [];
  let start = dates[0];
  let n = 1;
  while (start <= last) {
    const toSunday = (7 - toDate(start).getUTCDay()) % 7;
    let end = addDays(start, toSunday);
    if (addDays(end, 1) > last) end = last;
    weeks.push({ label: `Vecka ${n}`, number: n, start, end });
    start = addDays(end, 1);
    n++;
  }
  return weeks;
}

function renderWeeks() {
  const counts = new Map();
  for (const g of state.schedule.games) {
    if (g.type === 2) counts.set(g.date, (counts.get(g.date) ?? 0) + 1);
  }

  const problems = [];
  const sorted = [...state.weeks].sort((a, b) => a.start.localeCompare(b.start));
  for (let i = 0; i < sorted.length; i++) {
    const w = sorted[i];
    if (w.end < w.start) problems.push(`${w.label}: slutdatum före startdatum`);
    const next = sorted[i + 1];
    if (!next) continue;
    if (next.start <= w.end) problems.push(`${w.label} överlappar ${next.label}`);
    else if (next.start !== addDays(w.end, 1)) problems.push(`Glapp mellan ${w.label} och ${next.label}`);
  }
  $('#weekWarn').innerHTML = problems.length
    ? `<span class="err">${problems.join(' · ')}</span>`
    : 'Veckorna hänger ihop utan glapp eller överlapp.';

  $('#weekBody').innerHTML = state.weeks.map((w, i) => {
    const days = dayRange(w.start, w.end);
    const games = days.reduce((n, d) => n + (counts.get(d) ?? 0), 0);
    const bad = w.end < w.start;
    return `<tr class="${bad ? 'bad' : ''}">
      <td><input type="text" value="${w.label}" data-i="${i}" data-k="label"></td>
      <td><input type="number" value="${w.number}" data-i="${i}" data-k="number"></td>
      <td><input type="date" value="${w.start}" data-i="${i}" data-k="start"></td>
      <td><input type="date" value="${w.end}" data-i="${i}" data-k="end"></td>
      <td class="num">${days.length}</td>
      <td class="num">${games}</td>
      <td><button class="row-del" data-del="${i}" title="Ta bort raden">×</button></td>
    </tr>`;
  }).join('');

  for (const input of $('#weekBody').querySelectorAll('input')) {
    input.addEventListener('change', () => {
      const w = state.weeks[Number(input.dataset.i)];
      const k = input.dataset.k;
      w[k] = k === 'number' ? Number(input.value) : input.value;
      renderWeeks();
      fillWeekPicker();
      $('#weekPick').value = state.pick;
    });
  }

  for (const btn of $('#weekBody').querySelectorAll('.row-del')) {
    btn.addEventListener('click', () => {
      state.weeks.splice(Number(btn.dataset.del), 1);
      state.pick = '0';
      renderWeeks();
      fillWeekPicker();
    });
  }
}

function downloadWeeks() {
  const payload = {
    season: state.schedule.season,
    weeks: [...state.weeks].sort((a, b) => a.start.localeCompare(b.start)),
  };
  const url = URL.createObjectURL(new Blob([`${JSON.stringify(payload, null, 2)}\n`], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = 'weeks.json';
  a.click();
  URL.revokeObjectURL(url);
}

/* ── Direkthämtning från NHL:s API ──────────────────────────── */
async function fetchLive() {
  const btn = $('#fetchLive');
  const err = $('#emptyErr');
  btn.disabled = true;
  err.textContent = '';
  try {
    const now = new Date();
    const y = now.getUTCFullYear();
    const season = now.getUTCMonth() >= 7 ? `${y}${y + 1}` : `${y - 1}${y}`;

    btn.textContent = 'Hämtar lag…';
    const st = await (await fetch(`${API}/standings/now`)).json();
    const teams = st.standings.map((t) => ({
      abbrev: t.teamAbbrev.default,
      name: t.teamName.default,
      conference: t.conferenceName,
      division: t.divisionName,
    })).sort((a, b) => a.abbrev.localeCompare(b.abbrev));

    const seen = new Map();
    let done = 0;
    await Promise.all(teams.map(async (team) => {
      const res = await fetch(`${API}/club-schedule-season/${team.abbrev}/${season}`);
      const data = await res.json();
      for (const g of data.games ?? []) {
        if (g.gameType !== 2 && g.gameType !== 3) continue;
        seen.set(g.id, {
          id: g.id, date: g.gameDate,
          home: g.homeTeam.abbrev, away: g.awayTeam.abbrev,
          type: g.gameType, start: g.startTimeUTC ?? null,
        });
      }
      btn.textContent = `Hämtar scheman… ${++done}/${teams.length}`;
    }));

    const games = [...seen.values()].sort((a, b) => a.date.localeCompare(b.date));
    if (!games.length) throw new Error('Inga matcher i svaret — schemat kanske inte är släppt än.');
    start({ season, updated: new Date().toISOString(), teams, games }, null);
  } catch (e) {
    err.textContent = `Hämtningen misslyckades: ${e.message}. Kör skriptet lokalt istället.`;
    btn.disabled = false;
    btn.textContent = 'Hämta från NHL:s API';
  }
}

/* ── Vyer och händelser ─────────────────────────────────────── */
function show(view) {
  for (const name of ['schedule', 'weeks', 'empty']) {
    $(`#view-${name}`).hidden = name !== view;
  }
  for (const tab of document.querySelectorAll('.tab')) {
    tab.classList.toggle('is-on', tab.dataset.view === view);
  }
  document.querySelector('.tabs').hidden = view === 'empty';
}

function wire() {
  for (const tab of document.querySelectorAll('.tab')) {
    tab.addEventListener('click', () => {
      const view = tab.dataset.view;
      show(view);
      if (view === 'weeks') renderWeeks();
      else render();
    });
  }

  $('#weekPick').addEventListener('change', (e) => {
    state.pick = e.target.value;
    const custom = state.pick === 'custom';
    for (const el of document.querySelectorAll('[data-custom]')) el.hidden = !custom;
    if (custom && !state.custom.start) {
      const r = activeRange();
      state.custom = { start: r.start, end: r.end };
      $('#fromDate').value = r.start;
      $('#toDate').value = r.end;
    }
    render();
  });

  $('#fromDate').addEventListener('change', (e) => { state.custom.start = e.target.value; render(); });
  $('#toDate').addEventListener('change', (e) => { state.custom.end = e.target.value; render(); });
  $('#offMax').addEventListener('change', (e) => { state.offMax = Number(e.target.value) || 8; render(); });
  $('#minGp').addEventListener('change', (e) => { state.minGp = Number(e.target.value) || 0; render(); });
  $('#divPick').addEventListener('change', (e) => { state.division = e.target.value; render(); });
  $('#clearPins').addEventListener('click', () => { state.pinned.clear(); render(); });

  $('#downloadWeeks').addEventListener('click', downloadWeeks);
  $('#regenWeeks').addEventListener('click', () => {
    state.weeks = defaultWeeks(state.schedule.games);
    state.pick = '0';
    renderWeeks();
    fillWeekPicker();
  });
  $('#addWeek').addEventListener('click', () => {
    const last = [...state.weeks].sort((a, b) => a.start.localeCompare(b.start)).at(-1);
    const start = last ? addDays(last.end, 1) : toISO(new Date());
    state.weeks.push({
      label: `Vecka ${state.weeks.length + 1}`,
      number: state.weeks.length + 1,
      start,
      end: addDays(start, 6),
    });
    renderWeeks();
    fillWeekPicker();
  });

  $('#fetchLive').addEventListener('click', fetchLive);
}

boot();
