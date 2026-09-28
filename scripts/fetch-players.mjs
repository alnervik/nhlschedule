#!/usr/bin/env node
// Hämtar utespelarnas statistik för säsongen och skriver data/players.json.
// Statistiken kommer från NHL:s stats-API, roster% från ESPN:s öppna
// fantasy-API (Yahoos API kräver godkänd utvecklaransökan).
//
//   node scripts/fetch-players.mjs              # nuvarande säsong
//   node scripts/fetch-players.mjs 20262027     # given säsong

import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const STATS = 'https://api.nhle.com/stats/rest/en/skater';
const WEB = 'https://api-web.nhle.com/v1';
const ESPN = 'https://lm-api-reads.fantasy.espn.com/apis/v3/games/fhl/seasons';
const ESPN_TEAMS = 'https://site.api.espn.com/apis/site/v2/sports/hockey/nhl/teams';
const DATA = path.resolve('data');

const TEAMS = [
  'ANA', 'BOS', 'BUF', 'CAR', 'CBJ', 'CGY', 'CHI', 'COL', 'DAL', 'DET', 'EDM',
  'FLA', 'LAK', 'MIN', 'MTL', 'NJD', 'NSH', 'NYI', 'NYR', 'OTT', 'PHI', 'PIT',
  'SEA', 'SJS', 'STL', 'TBL', 'TOR', 'UTA', 'VAN', 'VGK', 'WPG', 'WSH',
];

// ESPN har egna förkortningar för några lag.
const ESPN_ABBREV = { NJ: 'NJD', LA: 'LAK', SJ: 'SJS', TB: 'TBL', UTAH: 'UTA', WAS: 'WSH', VEG: 'VGK' };

const seasonArg = process.argv.slice(2).find((a) => /^\d{8}$/.test(a));

function currentSeason(now = new Date()) {
  const y = now.getUTCFullYear();
  // Ny säsong räknas från augusti.
  return now.getUTCMonth() >= 7 ? `${y}${y + 1}` : `${y - 1}${y}`;
}

async function getJSON(url, headers = {}, tries = 3) {
  for (let i = 1; i <= tries; i++) {
    try {
      const res = await fetch(url, { headers: { accept: 'application/json', ...headers } });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      return await res.json();
    } catch (err) {
      if (i === tries) throw new Error(`${url}: ${err.message}`);
      await new Promise((r) => setTimeout(r, 500 * i));
    }
  }
}

// gameTypeId 1 = försäsong, 2 = grundserie.
const report = async (name, season, gameType) => {
  const exp = encodeURIComponent(`seasonId=${season} and gameTypeId=${gameType}`);
  const data = await getJSON(`${STATS}/${name}?limit=-1&cayenneExp=${exp}`);
  return data.data ?? [];
};

// "Tim Stützle" och "Tim Stutzle", "J.T. Miller" och "JT Miller" ska bli samma.
const norm = (s) => (s ?? '')
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/[.'’-]/g, '').replace(/\s+/g, ' ').trim();

/* Nuvarande lag och position per spelare, från lagens trupper. Täcker även
   spelare som bytt lag under säsongen. */
async function getRosters() {
  const byId = new Map();
  for (const team of TEAMS) {
    try {
      const r = await getJSON(`${WEB}/roster/${team}/current`);
      for (const p of [...(r.forwards ?? []), ...(r.defensemen ?? [])]) {
        byId.set(p.id, { team, pos: p.positionCode });
      }
    } catch (err) {
      console.warn(`trupp ${team}: ${err.message}`);
    }
  }
  return byId;
}

async function getOwnership(season) {
  const year = season.slice(4);
  const filter = { players: { limit: 3000, sortPercOwned: { sortPriority: 1, sortAsc: false } } };
  const data = await getJSON(
    `${ESPN}/${year}/segments/0/leaguedefaults/1?view=kona_player_info`,
    { 'x-fantasy-filter': JSON.stringify(filter) },
  );

  const teamById = new Map();
  try {
    const t = await getJSON(ESPN_TEAMS);
    for (const { team } of t.sports?.[0]?.leagues?.[0]?.teams ?? []) {
      teamById.set(Number(team.id), ESPN_ABBREV[team.abbreviation] ?? team.abbreviation);
    }
  } catch (err) {
    console.warn(`ESPN:s laglista: ${err.message}`);
  }

  const byName = new Map();
  for (const { player } of data.players ?? []) {
    if (!player?.fullName) continue;
    const entry = {
      team: teamById.get(player.proTeamId) ?? null,
      d: player.defaultPositionId === 4,
      own: player.ownership?.percentOwned ?? 0,
    };
    const key = norm(player.fullName);
    byName.set(key, [...(byName.get(key) ?? []), entry]);
  }
  return byName;
}

// Samma namn kan finnas två gånger (Elias Pettersson i VAN) — då avgör lag och position.
function matchOwnership(byName, p) {
  let hits = byName.get(norm(p.name));
  if (!hits?.length) return null;
  const narrow = (test) => {
    const left = hits.filter(test);
    if (left.length) hits = left;
  };
  if (hits.length > 1) narrow((h) => h.team === p.team);
  if (hits.length > 1) narrow((h) => h.d === (p.pos === 'D'));
  return hits.length === 1 ? Math.round(hits[0].own * 10) / 10 : null;
}

async function main() {
  const season = seasonArg ?? currentSeason();
  console.log(`Säsong ${season.slice(0, 4)}-${season.slice(6)}`);

  const fetchStats = (type) => Promise.all([
    report('summary', season, type), report('realtime', season, type), report('powerplay', season, type),
  ]);

  /* Innan grundserien kommit igång (ingen spelare har tre matcher än) används
     försäsongen, så att flikarna inte står tomma de första dagarna. */
  let gameType = 'regular';
  let [summary, realtime, pp] = await fetchStats(2);
  if (!summary.some((s) => s.gamesPlayed >= 3)) {
    const pre = await fetchStats(1);
    if (pre[0].length) {
      [summary, realtime, pp] = pre;
      gameType = 'preseason';
      console.log('Grundserien har knappt börjat – använder försäsongen');
    }
  }
  const rt = new Map(realtime.map((r) => [r.playerId, r]));
  const ppById = new Map(pp.map((r) => [r.playerId, r]));
  console.log(`NHL: ${summary.length} utespelare med statistik`);

  const rosters = summary.length ? await getRosters() : new Map();

  const players = summary.map((s) => {
    const r = rosters.get(s.playerId);
    const teams = (s.teamAbbrevs ?? '').split(',').filter(Boolean);
    const gp = s.gamesPlayed ?? 0;
    return {
      id: s.playerId,
      name: s.skaterFullName,
      team: r?.team ?? teams[teams.length - 1] ?? '',
      pos: r?.pos ?? s.positionCode,
      gp,
      toi: Math.round((s.timeOnIcePerGame ?? 0) * gp), // sekunder totalt
      g: s.goals ?? 0,
      a: s.assists ?? 0,
      p: s.points ?? 0,
      ppp: s.ppPoints ?? 0,
      sog: s.shots ?? 0,
      hit: rt.get(s.playerId)?.hits ?? 0,
      blk: rt.get(s.playerId)?.blockedShots ?? 0,
      ppPct: Math.round((ppById.get(s.playerId)?.ppTimeOnIcePctPerGame ?? 0) * 1000) / 1000,
      own: null,
    };
  }).filter((p) => p.gp > 0);

  let rosterSource = null;
  if (players.length) {
    try {
      const byName = await getOwnership(season);
      let hit = 0;
      for (const p of players) {
        p.own = matchOwnership(byName, p);
        if (p.own !== null) hit++;
      }
      rosterSource = 'ESPN';
      console.log(`ESPN: roster% för ${hit} av ${players.length} spelare`);
    } catch (err) {
      console.warn(`ESPN misslyckades (${err.message}) – roster% saknas`);
    }
  }

  await mkdir(DATA, { recursive: true });
  const payload = { season, gameType, updated: new Date().toISOString(), rosterSource, players };
  await writeFile(path.join(DATA, 'players.json'), `${JSON.stringify(payload)}\n`);
  console.log(`data/players.json · ${players.length} spelare`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
