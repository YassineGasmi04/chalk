// Player ratings out of 10, computed by code from the match events at full time.
// Everyone starts at 6.0. Goals, assists, shots on target, chance quality (xG), passing,
// ball wins and saves add to it; goals conceded while on the pitch, cards and defeat take
// away; a short cameo moves less far from 6.0. Transparent on purpose: every rating can
// be explained from the stats shown next to it.

const minuteOf = (clock) => {
  const m = String(clock || "0").match(/(\d+)(?:\+(\d+))?/);
  return m ? Number(m[1]) + Number(m[2] || 0) : 0;
};
const DEF = new Set(["GK", "RB", "CB", "LB", "RWB", "LWB"]);

export function playerRatings({ events, idx, start, squads }) {
  const end = events[idx];
  const endMin = Math.max(90, minuteOf(end.clock));
  const final = end.score;
  const s = {}; // pid -> raw counts
  const goals = [];
  const P = (pid) => (s[pid] ||= { goals: 0, assists: 0, sot: 0, xg: 0, passes: 0, comp: 0, won: 0, saves: 0 });
  for (let i = 0; i <= idx; i++) {
    const ev = events[i];
    if (!ev.player) continue;
    switch (ev.type) {
      case "pass": P(ev.player).passes++; if (ev.outcome === "complete") P(ev.player).comp++; break;
      case "shot":
        P(ev.player).xg += ev.xg || 0;
        if (ev.outcome === "saved" || ev.outcome === "goal") P(ev.player).sot++;
        if (ev.outcome === "goal" && ev.assist) P(ev.assist).assists++;
        break;
      case "goal": P(ev.player).goals++; goals.push({ team: ev.team, min: minuteOf(ev.clock) }); break;
      case "tackle": case "interception": P(ev.player).won++; break;
      case "save": P(ev.player).saves++; break;
    }
  }
  const out = [];
  for (const side of ["home", "away"]) {
    const team = start[side];
    const won = final[side] > final[side === "home" ? "away" : "home"];
    const lost = final[side] < final[side === "home" ? "away" : "home"];
    const played = [...team.players.map((p) => p.pid), ...squads.subs[side].map((x) => x.on)];
    for (const pid of played) {
      const p = [...team.players, ...team.bench].find((x) => x.pid === pid);
      if (!p) continue;
      const c = P(pid);
      const card = squads.cards[pid];
      const on = squads.on[pid] ? minuteOf(squads.on[pid]) : 0;
      const off = squads.off[pid] ? minuteOf(squads.off[pid]) : card?.red ? minuteOf(card.clock) : endMin;
      const minutes = Math.max(1, off - on);
      const conceded = goals.filter((g) => g.team !== side && g.min >= on && g.min <= off).length;
      let r = 6.0;
      r += 0.95 * c.goals + 0.6 * c.assists + 0.15 * Math.max(0, c.sot - c.goals) + 0.25 * c.xg;
      if (c.passes >= 8) r += (c.comp / c.passes - 0.8) * 2 + Math.min(0.3, c.comp * 0.006);
      r += Math.min(0.6, c.won * 0.035);
      if (p.position === "GK") r += 0.4 * c.saves;
      if (DEF.has(p.position)) r += conceded === 0 && minutes >= 60 ? 0.6 : -0.3 * conceded;
      r += won ? 0.25 : lost ? -0.35 : 0;
      if (card?.yellow) r -= 0.3;
      if (card?.red) r -= 2.5;
      if (minutes < 25) r = 6.0 + (r - 6.0) * 0.6;
      r = Math.max(4.0, Math.min(9.9, r)); // a 10 is reserved for the impossible
      out.push({ pid, side, name: p.name, short: p.short, number: p.number, position: p.position,
                 rating: Math.round(r * 10) / 10, minutes, ...c, conceded, sub: !!squads.on[pid], red: !!card?.red });
    }
  }
  const potm = out.reduce((best, x) => (!best || x.rating > best.rating ? x : best), null);
  return { list: out, potm };
}

export function ratingTone(r) {
  return r >= 8 ? "elite" : r >= 7 ? "good" : r >= 6 ? "ok" : "poor";
}
