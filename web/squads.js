// Squads: who is on the pitch and in which role, the bench, substitutions used (5 allowed),
// cards and goals, and a shape predictor: when a player comes on, code predicts the team's
// new formation from the roles on the pitch, then confirms or rejects it against what happens.

import { FORMATIONS, shapeOf } from "./formations.js";

const CONFIRM_WINDOW_S = 6 * 60; // how long a prediction waits for a formation change

export class SquadTracker {
  constructor(start) {
    this.start = start;
    this.reset();
  }

  reset() {
    const s = this.start;
    this.slots = { home: s.home.players.map((p) => p.pid), away: s.away.players.map((p) => p.pid) };
    this.formation = { home: s.home.formation, away: s.away.formation };
    this.subs = { home: [], away: [] };
    this.cards = {}; // pid -> { yellow, red, clock }
    this.goals = {}; // pid -> [clock]
    this.on = {}; // pid -> clock they came on
    this.off = {}; // pid -> clock they went off
    this.sentOff = new Set();
    this.preds = [];
  }

  natural(pid) {
    for (const side of ["home", "away"]) {
      const p = [...this.start[side].players, ...this.start[side].bench].find((x) => x.pid === pid);
      if (p) return p.position;
    }
    return null;
  }

  roleOf(pid) {
    for (const side of ["home", "away"]) {
      const i = this.slots[side].indexOf(pid);
      if (i >= 0) return (FORMATIONS[this.formation[side]] || [])[i] || this.natural(pid);
    }
    return this.natural(pid);
  }

  onPitch(side) {
    return this.slots[side].filter((pid) => !this.sentOff.has(pid));
  }

  /** Apply one match event; returns a new prediction when a substitution produced one. */
  apply(ev) {
    const side = ev.team;
    switch (ev.type) {
      case "substitution": {
        const i = this.slots[side].indexOf(ev.player_off);
        if (i < 0) return null;
        const pred = this.predict(side, i, ev);
        this.slots[side][i] = ev.player;
        this.subs[side].push({ on: ev.player, off: ev.player_off, clock: ev.clock, t: ev.t });
        this.on[ev.player] = ev.clock;
        this.off[ev.player_off] = ev.clock;
        if (pred) this.preds.push(pred);
        return pred;
      }
      case "formation_change": {
        this.formation[side] = ev.to;
        for (const p of this.preds) {
          if (p.team === side && p.status === "pending" && ev.t - p.t <= CONFIRM_WINDOW_S) {
            p.status = p.to === ev.to ? "confirmed" : "different";
            p.actual = ev.to;
            p.resolvedClock = ev.clock;
            p.resolvedT = ev.t;
          }
        }
        return null;
      }
      case "card": {
        const c = (this.cards[ev.player] ||= { yellow: 0, red: 0 });
        if (ev.card === "red") { c.red = 1; this.sentOff.add(ev.player); } else c.yellow++;
        c.clock = ev.clock;
        return null;
      }
      case "goal":
        (this.goals[ev.player] ||= []).push(ev.clock);
        return null;
      default:
        return null;
    }
  }

  predict(side, slot, ev) {
    const outPos = this.natural(ev.player_off), inPos = this.natural(ev.player);
    const from = this.formation[side];
    const roles = FORMATIONS[from];
    if (!roles) return null;
    let to;
    let reason;
    if (outPos === inPos) {
      to = from;
      reason = "like";
    } else {
      const now = this.slots[side].map((pid, i) => (i === slot ? inPos : roles[i]))
        .filter((_, i) => !this.sentOff.has(this.slots[side][i]));
      to = shapeOf(now);
      const outfield = to.split("-").reduce((a, b) => a + Number(b), 0);
      if (!/^\d+(-\d+)+$/.test(to) || outfield < 8) to = from;
      reason = to === from ? "fits" : "change";
    }
    return { team: side, t: ev.t, clock: ev.clock, from, to, on: ev.player, off: ev.player_off, inPos, outPos,
             reason, men: 11 - [...this.sentOff].filter((pid) => pid[0] === side[0]).length, status: "pending" };
  }

  /** Close predictions that waited long enough without a formation change. */
  expire(T) {
    for (const p of this.preds) {
      if (p.status === "pending" && T - p.t > CONFIRM_WINDOW_S) {
        p.status = p.to === this.formation[p.team] ? "held" : "unconfirmed";
        p.resolvedT = p.t + CONFIRM_WINDOW_S;
      }
    }
  }

  /** The prediction worth showing at time T: pending, or resolved in the last 75 seconds of match time. */
  current(T) {
    for (let i = this.preds.length - 1; i >= 0; i--) {
      const p = this.preds[i];
      if (p.status === "pending") return p;
      if (T - (p.resolvedT ?? p.t) < 75) return p;
    }
    return null;
  }
}
