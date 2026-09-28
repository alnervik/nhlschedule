/* NHL-schema — statiskt fantasyverktyg. Ingen build, inga beroenden. */

const API = 'https://api-web.nhle.com/v1';
const $ = (sel) => document.querySelector(sel);

const state = {
  schedule: null,   // { season, updated, teams, games }
  weeks: [],        // [{ label, number, start, end }] — kommer från data/weeks.json
  pick: '0',        // index i weeks, 'season' eller 'custom'
  custom: { start: null, end: null },
  offMax: 6,
  minGp: 0,
  division: 'all',
  sort: { key: 'score', dir: -1 },
  pinned: new Set(),

  tab: 'schedule',  // 'schedule', 'scorers' eller 'bangers'
  players: null,    // { season, updated, rosterSource, players } från data/players.json
  maxOwn: 50,
  minOff: null,     // null = auto: högsta antalet offnights i perioden − 1
  minPlayerGp: 3,
  rowCount: 25,
  playerSort: {
    scorers: { key: 'ppg', dir: -1 },
    bangers: { key: 'shb', dir: -1 },
  },
};

const TABS = ['schedule', 'scorers', 'bangers'];

/* Poängen väger ihop kolumnerna till ett tal: en match är värd 1, en match på
   en offnight lite mer, en match mot ett tröttkört lag lite mer, och en match
   dagen efter en annan match lite mindre. */
const WEIGHT = { game: 1, off: 0.25, tired: 0.15, b2b: -0.3 };
const scoreOf = (r) =>
  r.gp * WEIGHT.game + r.off * WEIGHT.off + r.tired * WEIGHT.tired + r.b2b * WEIGHT.b2b;

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

  const optional = async (url) => {
    try {
      const res = await fetch(url, { cache: 'no-cache' });
      if (res.ok) return await res.json();
    } catch { /* valfri */ }
    return null;
  };
  const [file, players] = await Promise.all([optional('data/weeks.json'), optional('data/players.json')]);
  state.players = players;
  // Försäsongen ger bara några matcher per spelare, så GP-kravet sänks.
  if (players?.gameType === 'preseason') {
    state.minPlayerGp = 1;
    $('#minPlayerGp').value = 1;
  }

  start(schedule, file?.weeks);
}

/* Veckorna kommer från data/weeks.json och är därmed samma för alla som
   öppnar sidan. Saknas filen faller vi tillbaka på mån–sön. */
function start(schedule, weeks) {
  state.schedule = schedule;
  state.weeks = weeks?.length
    ? weeks.map((w) => ({ ...w }))
    : defaultWeeks(schedule.games);

  $('#seasonLabel').textContent = seasonLabel(schedule.season);
  $('#stamp').textContent = schedule.updated
    ? `Uppdaterat ${new Intl.DateTimeFormat('sv-SE', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(schedule.updated))}`
    : '';

  fillWeekPicker();
  fillDivisionPicker();
  state.pick = String(pickCurrentWeek());
  $('#weekPick').value = state.pick;

  const fromHash = location.hash.slice(1);
  setTab(TABS.includes(fromHash) ? fromHash : 'schedule');
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

  // En dag utan matcher är ingen offnight — det finns inget att plocka upp.
  const offNight = new Map(days.map((d) => {
    const n = gamesByDay.get(d).length;
    return [d, n > 0 && n <= state.offMax];
  }));

  const rows = state.schedule.teams.map((team) => {
    let gp = 0, off = 0, b2b = 0, tired = 0;
    const cells = days.map((day) => {
      const g = playsOn.get(`${team.abbrev}|${day}`);
      if (!g) return null;
      const home = g.home === team.abbrev;
      const opp = home ? g.away : g.home;
      const isOff = offNight.get(day);
      const back = playsOn.has(`${team.abbrev}|${addDays(day, -1)}`);
      const oppBack = playsOn.has(`${opp}|${addDays(day, -1)}`);
      gp++;
      if (isOff) off++;
      if (back) b2b++;
      if (oppBack) tired++;
      return { home, opp, b2b: back, tired: oppBack, off: isOff };
    });
    const row = { team, cells, gp, off, b2b, tired };
    row.score = scoreOf(row);
    return row;
  });

  return { days, gamesByDay, offNight, rows, label, start, end };
}

/* ── Rendering ──────────────────────────────────────────────── */

/* Kolumnerna till vänster om rutnätet, i ordning. `heat` styr färgskalan:
   warm = mer är bättre (gult), cool = mer är sämre (blått). */
const STATS = [
  { key: 'score', label: 'Poäng', title: 'Matcher viktade med offnights, trötta motståndare och B2B', heat: 'warm', dec: 1 },
  { key: 'gp',    label: 'Matcher', title: 'Matcher i perioden', heat: 'warm' },
  { key: 'off',   label: 'Offnights', title: 'Matcher på offnights — de som är lättast att få in i laguppställningen', heat: 'warm' },
  { key: 'b2b',   label: 'B2B', title: 'Matcher laget spelar dagen efter en annan match', heat: 'cool' },
  { key: 'tired', label: 'Trötta', title: 'Matcher mot ett lag som spelade dagen innan', heat: 'warm' },
];

function render() {
  if (state.tab === 'schedule') renderSchedule();
  else renderPlayers();
}

function renderSchedule() {
  const t = buildTable();

  const visible = t.rows
    .filter((r) => r.gp >= state.minGp)
    .filter((r) => state.division === 'all' || r.team.division === state.division)
    .sort(compare);

  renderReadout(t, visible);
  renderHead(t);
  renderBody(t, visible);
  layoutFrozen();
  $('#clearPins').hidden = state.pinned.size === 0 || state.tab !== 'schedule';
}

function compare(a, b) {
  const { key, dir } = state.sort;
  if (key === 'team') return a.team.abbrev.localeCompare(b.team.abbrev) * dir;
  const diff = (a[key] - b[key]) * dir;
  return diff || b.off - a.off || b.gp - a.gp || a.team.abbrev.localeCompare(b.team.abbrev);
}

/* Färgskalan sätts relativt urvalet, så den fungerar lika bra för en vecka
   som för hela grundserien. Nivå 0 = ingen färg. */
function ramp(values) {
  const used = values.filter((v) => v > 0);
  const max = Math.max(...used, 0);
  const min = Math.min(...used, max);
  return (v) => {
    if (!(v > 0)) return 0;
    if (max === min) return 3;
    return 1 + Math.round(3 * (v - min) / (max - min));
  };
}

function renderReadout(t, visible) {
  const total = t.days.reduce((n, d) => n + t.gamesByDay.get(d).length, 0);
  const offDays = t.days.filter((d) => t.offNight.get(d));
  const offText = offDays.length
    ? offDays.map((d) => `${fmtWeekday.format(toDate(d))} ${shortDate(d)} (${t.gamesByDay.get(d).length})`).join(', ')
    : 'inga';
  $('#readout').innerHTML =
    `<b>${t.label}</b> · ${fmtLong.format(toDate(t.start))} – ${fmtLong.format(toDate(t.end))} · `
    + `${t.days.length} ${t.days.length === 1 ? 'dag' : 'dagar'} · ${total} matcher · ${visible.length} lag i listan<br>`
    + `<b>${offDays.length}</b> offnights (≤ ${state.offMax} matcher): ${offText}`;
}

function renderHead(t) {
  const arrow = (key) => (state.sort.key === key ? ` <span class="arrow">${state.sort.dir < 0 ? '▼' : '▲'}</span>` : '');

  let frz = 0;
  const teamCol = `<th class="col-team frozen sortable" data-frz="${frz++}" data-sort="team">Lag${arrow('team')}</th>`;
  const statCols = STATS.map((s, i) =>
    `<th class="num frozen sortable${i === STATS.length - 1 ? ' frozen-last' : ''}" `
    + `data-frz="${frz++}" data-sort="${s.key}" title="${s.title}">${s.label}${arrow(s.key)}</th>`).join('');

  const dayCols = t.days.map((d) => {
    const n = t.gamesByDay.get(d).length;
    const cls = t.offNight.get(d) ? ' is-off' : '';
    return `<th class="col-day${cls}">`
      + `<span class="day-name">${fmtWeekday.format(toDate(d))}</span>`
      + `<span class="day-date">${shortDate(d)}</span>`
      + `<span class="day-load">${n}</span></th>`;
  }).join('');

  $('#gridHead').innerHTML = `<tr>${teamCol}${statCols}${dayCols}</tr>`;

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
  const scales = Object.fromEntries(STATS.map((s) => [s.key, ramp(visible.map((r) => r[s.key]))]));

  $('#gridBody').innerHTML = visible.map((r) => {
    let frz = 0;
    const teamCol = `<td class="col-team frozen" data-frz="${frz++}">
        <button class="team-btn" data-team="${r.team.abbrev}">
          <span class="team-abv">${r.team.abbrev}</span>
          <span class="team-name">${r.team.name ?? ''}</span>
        </button>
      </td>`;

    const statCols = STATS.map((s, i) => {
      const v = r[s.key];
      const level = scales[s.key](v);
      const cls = `num frozen${i === STATS.length - 1 ? ' frozen-last' : ''} ${level ? `${s.heat}-${level}` : 'zero'}`;
      return `<td class="${cls}" data-frz="${frz++}">${s.dec ? v.toFixed(s.dec) : v}</td>`;
    }).join('');

    const dayCols = r.cells.map((c, i) => {
      if (!c) return '<td class="cell"></td>';
      const off = c.off ? ' is-off' : '';
      const cls = `chip ${c.home ? 'chip-home' : 'chip-away'}${c.b2b ? ' b2b' : ''}`;
      const text = c.home ? c.opp : `@${c.opp}`;
      const title = c.b2b ? ' title="Andra matchen på två dagar"' : '';
      const tired = c.tired ? '<span class="tired" title="Motståndaren spelade dagen innan">🥱</span>' : '';
      return `<td class="cell${off}"><span class="${cls}"${title}>${text}</span>${tired}</td>`;
    }).join('');

    return `<tr class="${state.pinned.has(r.team.abbrev) ? 'is-pinned' : ''}">${teamCol}${statCols}${dayCols}</tr>`;
  }).join('');

  for (const btn of $('#gridBody').querySelectorAll('.team-btn')) {
    btn.addEventListener('click', () => {
      const abv = btn.dataset.team;
      state.pinned.has(abv) ? state.pinned.delete(abv) : state.pinned.add(abv);
      render();
    });
  }
}

/* De frysta kolumnerna limmas fast till vänster. Bredderna varierar med
   innehåll och skärm, så offseten mäts efter varje rendering. */
function layoutFrozen() {
  const heads = [...$('#gridHead').querySelectorAll('th.frozen')];
  if (!heads.length) return;

  let left = 0;
  const offsets = heads.map((th) => {
    const at = left;
    left += th.getBoundingClientRect().width;
    return at;
  });

  for (const cell of $('#grid').querySelectorAll('.frozen')) {
    cell.style.left = `${offsets[Number(cell.dataset.frz)] ?? 0}px`;
  }
}

/* ── Spelarflikarna: scorers och bangers ────────────────────── */
/* Streamingkandidater: spelare med låg roster% på lag som har många
   offnights i vald period. Statistiken är per match för säsongen. */

const per = (n) => (r) => (r.gp ? r[n] / r.gp : 0);
const fmtToi = (sec) => {
  const s = Math.round(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
const fmtOwn = (v) => (v === null || v === undefined ? '–' : v > 0 && v < 0.5 ? '<1%' : `${Math.round(v)}%`);

const PLAYER_COLS = [
  { key: 'own',   label: 'Roster%', title: 'Andel ESPN-ligor där spelaren är ägd', fmt: fmtOwn, heat: 'own' },
  { key: 'gp',    label: 'GP', title: 'Spelade matcher i säsongen', fmt: (v) => v },
  { key: 'toiPg', label: 'TOI/GP', title: 'Istid per match', fmt: fmtToi, heat: 'warm' },
  { key: 'gpg',   label: 'Mål/GP', fmt: (v) => v.toFixed(2), heat: 'warm' },
  { key: 'apg',   label: 'Assist/GP', fmt: (v) => v.toFixed(2), heat: 'warm' },
  { key: 'ppg',   label: 'Poäng/GP', fmt: (v) => v.toFixed(2), heat: 'warm', tabs: ['scorers'] },
  { key: 'ppg',   label: 'Poäng/GP', fmt: (v) => v.toFixed(2), tabs: ['bangers'] },
  { key: 'sogpg', label: 'Skott/GP', fmt: (v) => v.toFixed(2), heat: 'warm' },
  { key: 'ppppg', label: 'PPP/GP', title: 'Powerplaypoäng per match', fmt: (v) => v.toFixed(2), heat: 'warm', tabs: ['scorers'] },
  { key: 'ppPct', label: 'PP%', title: 'Andel av lagets powerplaytid som spelaren är på isen', fmt: (v) => `${Math.round(v * 100)}%`, heat: 'warm', tabs: ['scorers'] },
  { key: 'hitpg', label: 'Hits/GP', fmt: (v) => v.toFixed(2), heat: 'warm', tabs: ['bangers'] },
  { key: 'blkpg', label: 'Block/GP', fmt: (v) => v.toFixed(2), heat: 'warm', tabs: ['bangers'] },
  { key: 'shb',   label: 'S+H+B/GP', title: 'Skott + hits + blockeringar per match', fmt: (v) => v.toFixed(2), heat: 'warm', tabs: ['bangers'] },
  { key: 'games', label: 'Matcher', title: 'Lagets matcher i perioden', fmt: (v) => v, heat: 'warm', sep: true },
  { key: 'off',   label: 'Offnights', title: 'Lagets matcher på offnights i perioden', fmt: (v) => v, heat: 'warm' },
];

function playerRows() {
  const t = buildTable();
  const byTeam = new Map(t.rows.map((r) => [r.team.abbrev, r]));
  const maxOff = Math.max(0, ...t.rows.map((r) => r.off));
  const minOff = state.minOff ?? Math.max(0, maxOff - 1);

  const rows = (state.players?.players ?? []).map((p) => {
    const team = byTeam.get(p.team);
    return {
      ...p,
      games: team?.gp ?? 0,
      off: team?.off ?? 0,
      toiPg: per('toi')(p),
      gpg: per('g')(p),
      apg: per('a')(p),
      ppg: per('p')(p),
      sogpg: per('sog')(p),
      ppppg: per('ppp')(p),
      hitpg: per('hit')(p),
      blkpg: per('blk')(p),
      shb: p.gp ? (p.sog + p.hit + p.blk) / p.gp : 0,
    };
  }).filter((r) => r.games > 0
    && r.off >= minOff
    && r.gp >= state.minPlayerGp
    && (r.own === null || r.own === undefined || r.own < state.maxOwn));

  return { t, rows, minOff, maxOff };
}

function renderPlayers() {
  const data = state.players;
  const empty = !data?.players?.length;
  $('#playerTables').hidden = empty;
  $('#playersEmpty').hidden = !empty;

  if (empty) {
    $('#playerReadout').textContent = '';
    $('#playersEmptyText').innerHTML = data
      ? `Säsongen ${seasonLabel(data.season)} har inga spelade matcher än. Listorna fylls på när de första `
        + 'matcherna är spelade och <code>data/players.json</code> har uppdaterats.'
      : 'Kör <code>node scripts/fetch-players.mjs</code> för att skapa <code>data/players.json</code>.';
    return;
  }

  const { t, rows, minOff } = playerRows();
  const teams = [...new Set(rows.map((r) => r.team))].sort();
  const source = data.rosterSource
    ? `Roster% från ${data.rosterSource} (inte Yahoo, men följer den väl)`
    : 'Roster% saknas i datan — ingen filtrering på ägande';
  $('#playerReadout').innerHTML =
    `<b>${t.label}</b> · ${fmtLong.format(toDate(t.start))} – ${fmtLong.format(toDate(t.end))} · `
    + `lag med minst <b>${minOff}</b> offnights: ${teams.join(', ') || 'inga'}<br>`
    + `${source}. Statistik från NHL, säsong ${seasonLabel(data.season)}`
    + `${data.gameType === 'preseason' ? ' — <b>försäsongen</b>, tills grundserien kommit igång' : ''}`
    + `, minst ${state.minPlayerGp} GP.`;

  const cols = PLAYER_COLS.filter((c) => !c.tabs || c.tabs.includes(state.tab));
  renderPlayerTable($('#fwdTable'), rows.filter((r) => r.pos !== 'D'), cols);
  renderPlayerTable($('#defTable'), rows.filter((r) => r.pos === 'D'), cols);
}

function comparePlayers(a, b) {
  const { key, dir } = state.playerSort[state.tab];
  if (key === 'name') return a.name.localeCompare(b.name, 'sv') * dir;
  const av = a[key] ?? Infinity;  // okänd roster% hamnar sist oavsett riktning
  const bv = b[key] ?? Infinity;
  if (av === bv) return b.off - a.off || a.name.localeCompare(b.name, 'sv');
  if (av === Infinity) return 1;
  if (bv === Infinity) return -1;
  return (av - bv) * dir;
}

/* Roster%: lägre är bättre, och 0 % ska vara starkast — därför en egen skala. */
function ownRamp(values) {
  const known = values.filter((v) => v !== null && v !== undefined);
  const max = Math.max(...known, 0);
  const min = Math.min(...known, max);
  return (v) => {
    if (v === null || v === undefined) return 0;
    if (max === min) return 4;
    return 1 + Math.round(3 * (max - v) / (max - min));
  };
}

function renderPlayerTable(table, all, cols) {
  const rows = all.sort(comparePlayers).slice(0, state.rowCount);
  const sort = state.playerSort[state.tab];
  const arrow = (key) => (sort.key === key ? ` <span class="arrow">${sort.dir < 0 ? '▼' : '▲'}</span>` : '');

  const scales = Object.fromEntries(cols.filter((c) => c.heat).map((c) => [
    c.key,
    c.heat === 'own' ? ownRamp(rows.map((r) => r.own)) : ramp(rows.map((r) => r[c.key])),
  ]));

  const head = `<thead><tr>`
    + `<th class="col-player frozen sortable" data-sort="name">Spelare${arrow('name')}</th>`
    + '<th>Lag</th><th>Pos</th>'
    + cols.map((c) => `<th class="num sortable${c.sep ? ' sep' : ''}${c.key === sort.key ? ' is-sorted' : ''}" `
      + `data-sort="${c.key}"${c.title ? ` title="${c.title}"` : ''}>${c.label}${arrow(c.key)}</th>`).join('')
    + '</tr></thead>';

  const body = rows.length
    ? rows.map((r) => {
      const cells = cols.map((c) => {
        const v = r[c.key];
        const level = scales[c.key]?.(v) ?? 0;
        const heat = c.heat === 'own' ? 'cool' : 'warm';
        const cls = `num${c.sep ? ' sep' : ''}${level ? ` ${heat}-${level}` : ''}${c.key === sort.key ? ' is-sorted' : ''}`;
        return `<td class="${cls}">${c.fmt(v)}</td>`;
      }).join('');
      return `<tr><td class="col-player frozen">${r.name}</td>`
        + `<td class="col-abv">${r.team}</td><td class="col-pos">${r.pos}</td>${cells}</tr>`;
    }).join('')
    : `<tr><td class="none" colspan="${cols.length + 3}">Inga spelare matchar filtren.</td></tr>`;

  table.innerHTML = `${head}<tbody>${body}</tbody>`;

  for (const th of table.querySelectorAll('.sortable')) {
    th.addEventListener('click', () => {
      const key = th.dataset.sort;
      const cur = state.playerSort[state.tab];
      state.playerSort[state.tab] = cur.key === key
        ? { key, dir: -cur.dir }
        : { key, dir: key === 'name' || key === 'own' ? 1 : -1 };
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

/* ── Reservveckor ───────────────────────────────────────────── */
/* Används bara när data/weeks.json saknas, t.ex. vid direkthämtning från
   API:t. Riktiga fantasyveckor redigeras i filen. */
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
  for (const name of ['schedule', 'players', 'empty']) {
    $(`#view-${name}`).hidden = name !== view;
  }
  $('#tabs').hidden = view === 'empty';
  $('#toolbar').hidden = view === 'empty';
}

function setTab(tab) {
  state.tab = tab;
  const group = tab === 'schedule' ? 'schedule' : 'players';
  for (const btn of document.querySelectorAll('.tab')) {
    btn.classList.toggle('is-active', btn.dataset.tab === tab);
  }
  for (const el of document.querySelectorAll('[data-for]')) el.hidden = el.dataset.for !== group;
  show(group);
  render();
}

function wire() {
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
  $('#offMax').addEventListener('change', (e) => { state.offMax = Number(e.target.value) || 6; render(); });
  $('#minGp').addEventListener('change', (e) => { state.minGp = Number(e.target.value) || 0; render(); });
  $('#divPick').addEventListener('change', (e) => { state.division = e.target.value; render(); });
  $('#clearPins').addEventListener('click', () => { state.pinned.clear(); render(); });

  $('#fetchLive').addEventListener('click', fetchLive);

  for (const btn of document.querySelectorAll('.tab')) {
    btn.addEventListener('click', () => {
      history.replaceState(null, '', btn.dataset.tab === 'schedule' ? location.pathname : `#${btn.dataset.tab}`);
      setTab(btn.dataset.tab);
    });
  }

  window.addEventListener('hashchange', () => {
    const tab = location.hash.slice(1);
    if (state.schedule && TABS.includes(tab)) setTab(tab);
  });

  const num = (id, key, fallback) => $(id).addEventListener('change', (e) => {
    const v = e.target.value === '' ? fallback : Number(e.target.value);
    state[key] = Number.isFinite(v) ? v : fallback;
    render();
  });
  num('#maxOwn', 'maxOwn', 50);
  num('#minOff', 'minOff', null);
  num('#minPlayerGp', 'minPlayerGp', 3);
  num('#rowCount', 'rowCount', 25);

  let resizing;
  window.addEventListener('resize', () => {
    clearTimeout(resizing);
    resizing = setTimeout(() => { if (state.tab === 'schedule') layoutFrozen(); }, 100);
  });
}

boot();
