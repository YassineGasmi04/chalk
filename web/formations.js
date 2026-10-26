// Formation slots, in the same order as the match engine (chalk/sim/teams.py), so a
// player's slot index tells us the role they are playing right now.
export const FORMATIONS = {
  "4-3-3": [
    "GK",
    "LB",
    "CB",
    "CB",
    "RB",
    "CM",
    "DM",
    "CM",
    "LW",
    "ST",
    "RW"
  ],
  "4-2-3-1": [
    "GK",
    "LB",
    "CB",
    "CB",
    "RB",
    "DM",
    "DM",
    "LAM",
    "CAM",
    "RAM",
    "ST"
  ],
  "4-4-2": [
    "GK",
    "LB",
    "CB",
    "CB",
    "RB",
    "LM",
    "CM",
    "CM",
    "RM",
    "ST",
    "ST"
  ],
  "5-3-2": [
    "GK",
    "LWB",
    "CB",
    "CB",
    "CB",
    "RWB",
    "CM",
    "CM",
    "CM",
    "ST",
    "ST"
  ]
};

// Where each slot stands, attacking towards x = 105 (metres): used to draw formations.
export const ANCHORS = {"4-3-3": [[5, 34], [24, 8], [20, 26], [20, 42], [24, 60], [38, 20], [34, 34], [38, 48], [54, 10], [58, 34], [54, 58]], "4-2-3-1": [[5, 34], [24, 8], [20, 26], [20, 42], [24, 60], [33, 26], [33, 42], [47, 12], [48, 34], [47, 56], [58, 34]], "4-4-2": [[5, 34], [24, 8], [20, 26], [20, 42], [24, 60], [40, 10], [37, 27], [37, 41], [40, 58], [56, 26], [56, 42]], "5-3-2": [[5, 34], [28, 6], [18, 22], [17, 34], [18, 46], [28, 62], [36, 22], [33, 34], [36, 46], [54, 28], [54, 40]]};

/** Broadcast role codes: what the graphics show. */
export const ROLE_CODE = { DM: "CDM", RAM: "RAM", LAM: "LAM" };
export const roleCode = (r) => ROLE_CODE[r] || r;

const LINE = {
  GK: "gk", RB: "def", CB: "def", LB: "def", RWB: "def", LWB: "def",
  DM: "dm", CM: "cm", RM: "wm", LM: "wm", CAM: "am", RAM: "am", LAM: "am", RW: "w", LW: "w", ST: "st",
};

/**
 * Predict a team's shape from the roles on the pitch (outfield only). Strikers decide
 * the top line; attacking midfielders make a band of three; wingers join the front
 * three or, with two strikers, drop into a midfield four.
 */
export function shapeOf(roles) {
  const n = { def: 0, dm: 0, cm: 0, wm: 0, am: 0, w: 0, st: 0 };
  for (const r of roles) if (LINE[r] && LINE[r] !== "gk") n[LINE[r]]++;
  let lines;
  if (n.st >= 2) lines = [n.def, n.dm + n.cm + n.wm + n.w + n.am, n.st];
  else if (n.am >= 1 && n.st >= 1) lines = [n.def, n.dm + n.cm + n.wm, n.am + n.w, n.st];
  else if (n.st >= 1) lines = [n.def, n.dm + n.cm + n.wm + n.am, n.w + n.st];
  else lines = [n.def, n.dm + n.cm + n.wm, n.am + n.w];
  return lines.filter((x) => x > 0).join("-");
}
