"""The offline crew: rule-based versions of every agent.

Used when no model is configured, as VAR's last-resort fallback after an
overturned retry, and in tests. Outputs follow exactly the same JSON
contracts as the model-backed agents, so the rest of the pipeline cannot
tell the difference.
"""

from __future__ import annotations

import math
from typing import Any


class _Safe(dict):
    def __missing__(self, key: str) -> str:
        return "?"


def _fmt(template: str, values: dict[str, Any]) -> str:
    return template.format_map(_Safe(values))


def _ordinal_goal(n: int) -> str:
    return {1: "first", 2: "second", 3: "third", 4: "fourth"}.get(n, f"number {n}")


OUTCOME_EN = {"saved": "saved", "off_target": "off target", "blocked": "blocked", "goal": "scored"}


# ===================================================================== recap
def recap(payload: dict[str, Any]) -> dict[str, Any]:
    m = payload["moment"]
    f = m["facts"]
    v = dict(f)
    winner, loser = f.get("winner"), f.get("loser")
    if winner and winner != "draw":
        headline = _fmt("{winner} beat {loser} {score}", v)
        first = _fmt("{winner} beat {loser} {score}.", v)
    else:
        headline = _fmt("Honours even at {score}", v)
        first = _fmt("{final_score_text}: honours even.", v)
    parts = [first]
    if f.get("turning_point_text"):
        parts.append(_fmt("The turning point came at {turning_point_text}.", v))
    parts.append(_fmt("{potm_name} was the player of the match with {potm_goals} goals from {potm_shots} shots.", v)
                 if f.get("potm_goals") else _fmt("{potm_name} was the player of the match.", v))
    parts.append(_fmt("On expected goals it finished {xg_text}.", v))
    claims = [
        {"text": _fmt("Final score {final_score_text}.", v), "fact_keys": ["final_score_text"]},
        {"text": _fmt("Expected goals: {xg_text}.", v), "fact_keys": ["xg_text", "home_xg", "away_xg"]},
        {"text": _fmt("{potm_name}: {potm_goals} goals, {potm_shots} shots.", v),
         "fact_keys": ["potm_name", "potm_goals", "potm_shots"]},
    ]
    return {"headline": headline, "story": " ".join(parts), "claims": claims,
            "focus_players": [f["potm_id"]] if f.get("potm_id") else [],
            "turning_point": f.get("turning_point_clock")}


# =================================================================== analyst
def analyst(payload: dict[str, Any]) -> dict[str, Any]:
    m = payload["moment"]
    if m["type"] == "full_time":
        return recap(payload)
    f = dict(m["facts"])
    t = m["type"]
    team = m.get("team_name") or "The game"
    opp = m.get("opponent_name") or "the opposition"
    v = {**f, "team": team, "opp": opp}
    ids = m.get("players", [])
    claims: list[dict[str, Any]] = []
    brief = ""

    if "xg" in f:  # pundits say 0.46, not 0.461
        v["xg"] = round(float(f["xg"]), 2)
    np_ = int(f.get("buildup_passes", 0) or 0)
    v["passes_txt"] = "one pass" if np_ == 1 else ("no passes" if np_ == 0 else f"{np_} passes")

    if t == "goal":
        n = int(f.get("scorer_goals_today", 1))
        headline = {
            "opening goal": "{scorer} opens the scoring",
            "equaliser": "{scorer} levels it at {score}",
            "goes ahead": "{scorer} puts {team} ahead",
            "pulls one back": "{scorer} pulls one back",
        }.get(f.get("goal_effect"), "{scorer} makes it {score}")
        headline = _fmt(headline, v)
        parts = []
        if f.get("won_in_opponent_half"):
            parts.append(_fmt("{team} won the ball in {opp}'s half and scored {buildup_seconds} seconds later.", v))
            claims.append({"text": _fmt("The move started with a ball win in the opponent's half, {buildup_seconds} seconds before the goal.", v),
                           "fact_keys": ["won_in_opponent_half", "buildup_seconds"]})
        elif f.get("buildup_passes", 0) >= 5:
            parts.append(_fmt("A {buildup_passes}-pass move, {buildup_seconds} seconds from start to finish, pulled {opp} apart.", v))
            claims.append({"text": _fmt("{team} strung {buildup_passes} passes together before the shot.", v),
                           "fact_keys": ["buildup_passes", "buildup_seconds"]})
        else:
            parts.append(_fmt("Direct and quick: {passes_txt} and {buildup_seconds} seconds from the start of the move to the finish.", v))
            claims.append({"text": _fmt("The attack took {buildup_seconds} seconds and {passes_txt}.", v),
                           "fact_keys": ["buildup_passes", "buildup_seconds"]})
        xg = float(f.get("xg", 0))
        if xg < 0.1:
            parts.append(_fmt("At {xg} xG this was a hard chance, so the finish did the work.", v))
        elif xg >= 0.3:
            parts.append(_fmt("At {xg} xG it was a big chance, exactly what the move was built to create.", v))
        else:
            parts.append(_fmt("A {xg} xG chance from {shot_distance_m} m, struck at {shot_speed_kmh} km/h.", v))
        claims.append({"text": _fmt("The shot was worth {xg} xG from {shot_distance_m} m.", v),
                       "fact_keys": ["xg", "shot_distance_m"]})
        if n == 3:
            parts.append(f"{f.get('scorer')} completes his hat-trick.")
        elif n >= 2:
            parts.append(f"It is {f.get('scorer')}'s {_ordinal_goal(n)} goal of the match.")
            claims.append({"text": f"{f.get('scorer')} has scored {n} today.", "fact_keys": ["scorer_goals_today"]})
        if f.get("opponent_players_on_pitch") == 10:
            parts.append(_fmt("{opp} are down to 10 men.", v))
        story = " ".join(parts[:3])
        brief = "Draw the last passes of the build-up, the shot, and ring the scorer."

    elif t == "big_chance":
        headline = _fmt("Big chance for {shooter}", v)
        out = OUTCOME_EN.get(f.get("outcome"), f.get("outcome"))
        story = _fmt("{shooter} had a {xg} xG chance from {shot_distance_m} m and it was " + out + ".", v)
        if f.get("pressured"):
            story += " A defender was closing him down as he shot."
        story += _fmt(" {team} have built {team_xg_total} xG so far.", v)
        claims = [{"text": _fmt("The chance was worth {xg} xG.", v), "fact_keys": ["xg", "shot_distance_m"]},
                  {"text": _fmt("{team} are on {team_xg_total} xG for the match.", v), "fact_keys": ["team_xg_total"]}]
        brief = "Draw the move and the shot, ring the shooter."

    elif t == "rocket_shot":
        headline = _fmt("{shooter} hits it at {shot_speed_kmh} km/h", v)
        story = _fmt("{shooter} struck it at {shot_speed_kmh} km/h from {shot_distance_m} m, the hardest shot of the match so far.", v)
        claims = [{"text": _fmt("Shot speed {shot_speed_kmh} km/h from {shot_distance_m} m.", v),
                   "fact_keys": ["shot_speed_kmh", "shot_distance_m"]}]
        if f.get("previous_fastest_kmh"):
            claims.append({"text": _fmt("The previous fastest shot was {previous_fastest_kmh} km/h.", v),
                           "fact_keys": ["previous_fastest_kmh"]})
        brief = "Draw the shot."

    elif t == "red_card":
        headline = _fmt("{player} sent off", v)
        story = _fmt("{team} are down to {players_left} with {minutes_remaining} minutes left. "
                     "They had {team_possession_last5_pct}% of the ball in the five minutes before; "
                     "keeping it with a player fewer is now the test.", v)
        claims = [{"text": _fmt("{team} have {players_left} players left.", v), "fact_keys": ["players_left"]},
                  {"text": _fmt("There are {minutes_remaining} minutes of normal time left.", v), "fact_keys": ["minutes_remaining"]},
                  {"text": _fmt("{team} had {team_possession_last5_pct}% possession just before the card.", v),
                   "fact_keys": ["team_possession_last5_pct"]}]
        brief = "Ring the player sent off and show the gap he leaves."

    elif t == "press_surge":
        headline = _fmt("{team} turn up the press", v)
        story = _fmt("{team} made {pressures_last5} pressures in the last five minutes, {ratio} times their usual rate. "
                     "That won the ball back {turnovers_won_last5} times, {high_turnovers_last5} of them in {opp}'s half.", v)
        claims = [{"text": _fmt("{pressures_last5} pressures in the last five minutes against an average of {pressures_avg_per5}.", v),
                   "fact_keys": ["pressures_last5", "pressures_avg_per5", "ratio"]},
                  {"text": _fmt("{turnovers_won_last5} ball wins, {high_turnovers_last5} of them high up the pitch.", v),
                   "fact_keys": ["turnovers_won_last5", "high_turnovers_last5"]}]
        brief = "Shade the pressing zone and ring the front pressers."

    elif t == "momentum_swing":
        headline = _fmt("Momentum swings to {team}", v)
        story = _fmt("{team} have taken over: {possession_last5_pct}% of the ball and {field_tilt_last5_pct}% of the final-third passes "
                     "in the last five minutes, with {shots_last5} shots.", v)
        claims = [{"text": _fmt("{possession_last5_pct}% possession in the last five minutes.", v), "fact_keys": ["possession_last5_pct"]},
                  {"text": _fmt("{field_tilt_last5_pct}% field tilt over the same spell.", v), "fact_keys": ["field_tilt_last5_pct"]}]
        brief = "Shade the area where the team on top is now playing."

    elif t == "chaos_spike":
        headline = "The game breaks open"
        story = _fmt("Control is gone: {turnovers_per_min_last5} turnovers a minute over the last five minutes, "
                     "with the ball changing hands faster than either side can set up.", v)
        claims = [{"text": _fmt("{turnovers_per_min_last5} turnovers per minute in the last five minutes.", v),
                   "fact_keys": ["turnovers_per_min_last5"]},
                  {"text": _fmt("Chaos index {chaos_index}, where 1 is this match's normal tempo.", v), "fact_keys": ["chaos_index"]}]
        brief = "Shade where the ball keeps changing hands."

    elif t == "tactical_shift":
        headline = _fmt("{team} switch to {to_formation}", v)
        story = _fmt("{team} change shape from {from_formation} to {to_formation}. "
                     "It puts two holding midfielders behind a line of three attacking midfielders.", v) \
            if f.get("to_formation") == "4-2-3-1" else _fmt("{team} change shape from {from_formation} to {to_formation}.", v)
        claims = [{"text": _fmt("New shape: {to_formation}, from {from_formation}.", v),
                   "fact_keys": ["to_formation", "from_formation"]}]
        brief = "Shade the new midfield block."

    elif t == "substitution":
        headline = _fmt("{player_on} comes on", v)
        story = _fmt("{player_on} replaces {player_off}, who leaves after {player_off_touches} touches and {player_off_passes} passes.", v)
        claims = [{"text": _fmt("{player_off} had {player_off_touches} touches.", v), "fact_keys": ["player_off_touches"]}]
        brief = "Ring the new player."

    elif t == "hardest_pass":
        headline = _fmt("Pass of the match by {passer}", v)
        story = _fmt("{passer} found {receiver} with a pass rated {difficulty} out of 100 for difficulty, the hardest completed pass so far. "
                     "It travelled {distance_m} m and beat {lines_broken} lines.", v)
        claims = [{"text": _fmt("Difficulty {difficulty}, previous best {previous_best}.", v), "fact_keys": ["difficulty", "previous_best"]},
                  {"text": _fmt("{distance_m} m, {lines_broken} lines broken.", v), "fact_keys": ["distance_m", "lines_broken"]}]
        if f.get("nearest_defender_to_passer_m") is not None:
            claims.append({"text": _fmt("A defender was {nearest_defender_to_passer_m} m from the passer.", v),
                           "fact_keys": ["nearest_defender_to_passer_m"]})
        brief = "Draw the pass and link the passer to the nearest defender."

    elif t == "speed_burst":
        headline = _fmt("{player} hits {speed_kmh} km/h", v)
        story = _fmt("{player} reached {speed_kmh} km/h, the fastest sprint of the match so far.", v)
        claims = [{"text": _fmt("Top speed {speed_kmh} km/h.", v), "fact_keys": ["speed_kmh"]}]
        if f.get("previous_match_top_kmh"):
            story += _fmt(" The previous best was {previous_match_top_kmh} km/h.", v)
            claims.append({"text": _fmt("Previous match top speed {previous_match_top_kmh} km/h.", v),
                           "fact_keys": ["previous_match_top_kmh"]})
        brief = "Ring the runner."

    else:  # milestone
        headline = m.get("title", "Milestone")
        if f.get("milestone") == "50 passes":
            story = _fmt("{player} completes his 50th pass at {pass_accuracy_pct}% accuracy.", v)
            claims = [{"text": _fmt("50 passes at {pass_accuracy_pct}% accuracy.", v), "fact_keys": ["passes", "pass_accuracy_pct"]}]
        else:
            story = _fmt("{player} has two goals today.", v)
            claims = [{"text": _fmt("{player} has scored {goals}.", v), "fact_keys": ["goals"]}]
        brief = "Ring the player."

    return {"headline": headline, "story": story, "claims": claims,
            "focus_players": [p for p in ids if p in payload.get("players", {})][:3],
            "drawing_brief": brief}


# =============================================================== telestrator
def _team_points(geo: dict[str, Any], players: dict[str, Any], team: str | None) -> list[tuple[str, list[float]]]:
    frame = geo.get("frame") or geo.get("players") or {}
    return [(pid, pos) for pid, pos in frame.items() if team and players.get(pid, {}).get("team") == team]


def _hull(points: list[list[float]]) -> list[list[float]]:
    """Order points around their centroid so they draw as a clean polygon."""
    cx = sum(p[0] for p in points) / len(points)
    cy = sum(p[1] for p in points) / len(points)
    return sorted(points, key=lambda p: math.atan2(p[1] - cy, p[0] - cx))


def telestrator(payload: dict[str, Any]) -> dict[str, Any]:
    m = payload["moment"]
    geo = payload["geometry"]
    players = payload.get("players", {})
    f = m["facts"]
    t = m["type"]
    team = m.get("team")
    frame = geo.get("frame") or geo.get("players") or {}
    out: list[dict[str, Any]] = []
    focus = [p for p in (payload.get("analysis") or {}).get("focus_players", []) if p in frame]

    if t in ("goal", "big_chance", "rocket_shot"):
        for seg in (geo.get("buildup") or [])[-3:]:
            out.append({"type": "arrow", "from": seg["from"], "to": seg["to"],
                        "style": "pass" if seg["kind"] == "pass" else "carry"})
        if geo.get("shot"):
            out.append({"type": "arrow", "from": geo["shot"]["from"], "to": geo["shot"]["to"], "style": "shot",
                        "label": f"xG {round(float(f['xg']), 2)}" if "xg" in f else f"{f.get('shot_speed_kmh')} km/h"})
        shooter = (m.get("players") or [None])[0]
        if shooter in frame:
            out.append({"type": "circle", "player": shooter})
    elif t in ("press_surge", "momentum_swing", "chaos_spike", "tactical_shift"):
        pts = _team_points(geo, players, team)
        d = 1 if team == "home" else -1
        if t == "chaos_spike" or not pts:
            # not one team's moment: shade the scramble around the ball
            ball = geo.get("ball") or [52.5, 34.0]
            pts = sorted(frame.items(), key=lambda kv: math.dist(kv[1], ball))[:5]
            chosen = pts
        elif t == "tactical_shift":
            mids = [(pid, pos) for pid, pos in pts
                    if players.get(pid, {}).get("position") in ("DM", "CAM", "RAM", "LAM", "CM")]
            chosen = mids or pts
        else:
            chosen = sorted(pts, key=lambda kv: -kv[1][0] * d)[:5]  # most advanced players
        if len(chosen) >= 3:
            label = {"press_surge": "Pressing trap", "momentum_swing": "Where they play now",
                     "chaos_spike": "Ball keeps turning over", "tactical_shift": f"New {f.get('to_formation', '')} block"}[t]
            out.append({"type": "zone", "points": _hull([pos for _, pos in chosen]), "label": label})
            for pid, _ in chosen[:2]:
                out.append({"type": "circle", "player": pid})
    elif t == "hardest_pass":
        if geo.get("pass"):
            out.append({"type": "arrow", "from": geo["pass"]["from"], "to": geo["pass"]["to"], "style": "pass",
                        "label": f"Difficulty {f.get('difficulty')}"})
        passer = (m.get("players") or [None])[0]
        if passer in frame:
            opp = [pid for pid in frame if players.get(pid, {}).get("team") not in (None, team)]
            if opp:
                nearest = min(opp, key=lambda p: math.dist(frame[p], frame[passer]))
                out.append({"type": "link", "players": [passer, nearest],
                            "label": f"{f.get('nearest_defender_to_passer_m')} m"})
    elif t == "red_card":
        pid = (m.get("players") or [None])[0]
        if pid in frame:
            out.append({"type": "circle", "player": pid, "label": "Sent off"})
            mates = [p for p, _ in _team_points(geo, players, team) if p != pid]
            if len(mates) >= 2:
                near = sorted(mates, key=lambda p: math.dist(frame[p], frame[pid]))[:2]
                out.append({"type": "link", "players": near, "label": "Gap to cover"})
    else:  # speed_burst, substitution, milestone
        pid = (m.get("players") or [None])[0]
        if pid in frame:
            label = f"{f['speed_kmh']} km/h" if t == "speed_burst" else None
            d = {"type": "circle", "player": pid}
            if label:
                d["label"] = label
            out.append(d)
    if not out and focus:
        out.append({"type": "circle", "player": focus[0]})
    return {"drawings": out[:5]}


# ======================================================================= VAR
def var_judge(payload: dict[str, Any]) -> dict[str, Any]:
    # Rule-based crew: the rulebook has already run; nothing more to judge.
    return {"verdict": "stands", "issues": []}


# ============================================================== personalizer
FR_OUTCOME = {"saved": "arrêtée", "off_target": "à côté", "blocked": "contrée"}
AR_OUTCOME = {"saved": "تصدى لها الحارس", "off_target": "خارج المرمى", "blocked": "صُدّت"}

TEMPLATES: dict[str, dict[str, tuple[str, str]]] = {
    # type: {lang: (analyst caption, casual caption)}
    "goal": {
        "en": ("{scorer} scores: {move_en}, {xg} xG, {shot_speed_kmh} km/h. It's {score}.",
               "Goal! {scorer} finishes it off and it's {score}."),
        "fr": ("But de {scorer} : {move_fr}, {xg} xG, frappe à {shot_speed_kmh} km/h. {score}.",
               "But ! {scorer} conclut et c'est {score}."),
        "ar": ("هدف {scorer}: {move_ar}، {xg} أهداف متوقعة، تسديدة بسرعة {shot_speed_kmh} كم/س. النتيجة {score}.",
               "هدف! {scorer} يُنهي الهجمة والنتيجة الآن {score}."),
    },
    "big_chance": {
        "en": ("{shooter}: {xg} xG from {shot_distance_m} m, {outcome_en}.", "So close! {shooter} had a great chance but it was {outcome_en}."),
        "fr": ("{shooter} : {xg} xG à {shot_distance_m} m, {outcome_fr}.", "Quelle occasion ! {shooter} était tout près, mais c'est {outcome_fr}."),
        "ar": ("{shooter}: فرصة بقيمة {xg} من مسافة {shot_distance_m} م، {outcome_ar}.", "يا لها من فرصة! {shooter} كان قريبًا جدًا لكن {outcome_ar}."),
    },
    "rocket_shot": {
        "en": ("{shooter} strikes at {shot_speed_kmh} km/h from {shot_distance_m} m.", "What a hit! {shooter} smashes it at {shot_speed_kmh} km/h."),
        "fr": ("{shooter} frappe à {shot_speed_kmh} km/h à {shot_distance_m} m.", "Quelle frappe ! {shooter} envoie un missile à {shot_speed_kmh} km/h."),
        "ar": ("{shooter} يسدد بسرعة {shot_speed_kmh} كم/س من {shot_distance_m} م.", "يا لها من قذيفة! {shooter} يسدد بسرعة {shot_speed_kmh} كم/س."),
    },
    "red_card": {
        "en": ("{player} off: {team} down to {players_left} with {minutes_remaining} minutes left.",
               "Red card for {player}! {team} must play the rest with {players_left} players."),
        "fr": ("{player} expulsé : {team} à {players_left} pour les {minutes_remaining} dernières minutes.",
               "Carton rouge pour {player} ! {team} doit finir à {players_left}."),
        "ar": ("طرد {player}: {team} بـ{players_left} لاعبين في آخر {minutes_remaining} دقيقة.",
               "بطاقة حمراء لـ{player}! {team} سيكمل المباراة بـ{players_left} لاعبين."),
    },
    "press_surge": {
        "en": ("{team}: {pressures_last5} pressures in five minutes ({ratio}x normal), {high_turnovers_last5} high regains.",
               "{team} are hunting the ball in packs and winning it back."),
        "fr": ("{team} : {pressures_last5} pressings en cinq minutes ({ratio}x la normale), {high_turnovers_last5} récupérations hautes.",
               "{team} presse très haut et récupère le ballon."),
        "ar": ("{team}: {pressures_last5} ضغطًا في خمس دقائق ({ratio} ضعف المعدل)، و{high_turnovers_last5} استعادات في نصف الخصم.",
               "{team} يضغط بقوة ويستعيد الكرة بسرعة."),
    },
    "momentum_swing": {
        "en": ("{team} on top: {possession_last5_pct}% possession, {field_tilt_last5_pct}% field tilt over five minutes.",
               "{team} have taken control of the game."),
        "fr": ("{team} domine : {possession_last5_pct}% de possession, {field_tilt_last5_pct}% d'inclinaison du terrain sur cinq minutes.",
               "{team} a pris le contrôle du match."),
        "ar": ("{team} يسيطر: استحواذ {possession_last5_pct}% و{field_tilt_last5_pct}% من التمريرات في الثلث الأخير خلال خمس دقائق.",
               "{team} يفرض سيطرته على المباراة."),
    },
    "chaos_spike": {
        "en": ("Chaos index {chaos_index}: {turnovers_per_min_last5} turnovers per minute.", "End to end! Nobody can keep the ball right now."),
        "fr": ("Indice de chaos {chaos_index} : {turnovers_per_min_last5} pertes de balle par minute.", "Ça va d'un but à l'autre ! Personne ne garde le ballon."),
        "ar": ("مؤشر الفوضى {chaos_index}: {turnovers_per_min_last5} فقدان للكرة في الدقيقة.", "مباراة مفتوحة! لا أحد يستطيع الاحتفاظ بالكرة الآن."),
    },
    "tactical_shift": {
        "en": ("{team} shift from {from_formation} to {to_formation}.", "{team} change their shape to {to_formation}."),
        "fr": ("{team} passe du {from_formation} au {to_formation}.", "{team} change de système : {to_formation}."),
        "ar": ("{team} يتحول من {from_formation} إلى {to_formation}.", "{team} يغيّر خطته إلى {to_formation}."),
    },
    "substitution": {
        "en": ("{player_on} on for {player_off} ({player_off_touches} touches).", "Change for {team}: {player_on} comes on."),
        "fr": ("{player_on} remplace {player_off} ({player_off_touches} ballons touchés).", "Changement pour {team} : {player_on} entre en jeu."),
        "ar": ("{player_on} بدلًا من {player_off} ({player_off_touches} لمسة).", "تبديل في {team}: دخول {player_on}."),
    },
    "hardest_pass": {
        "en": ("{passer} to {receiver}: difficulty {difficulty}, {distance_m} m, {lines_broken} lines broken.", "What a pass from {passer}!"),
        "fr": ("{passer} pour {receiver} : difficulté {difficulty}, {distance_m} m, {lines_broken} lignes franchies.", "Quelle passe de {passer} !"),
        "ar": ("{passer} إلى {receiver}: صعوبة {difficulty}، {distance_m} م، تجاوزت {lines_broken} خطوط.", "يا لها من تمريرة من {passer}!"),
    },
    "speed_burst": {
        "en": ("{player}: {speed_kmh} km/h, fastest sprint so far.", "{player} is flying: {speed_kmh} km/h!"),
        "fr": ("{player} : {speed_kmh} km/h, sprint le plus rapide du match.", "{player} s'envole : {speed_kmh} km/h !"),
        "ar": ("{player}: {speed_kmh} كم/س، أسرع انطلاقة حتى الآن.", "{player} ينطلق كالصاروخ: {speed_kmh} كم/س!"),
    },
    "full_time": {
        "en": ("Full-time: {final_score_text}. xG {xg_text}. Player of the match: {potm_name}.",
               "It's over! {final_score_text}, and {potm_name} was the star."),
        "fr": ("Fin du match : {final_score_text}. xG {xg_text}. Homme du match : {potm_name}.",
               "C'est fini ! {final_score_text}, et {potm_name} a été le héros du match."),
        "ar": ("نهاية المباراة: {final_score_text}. الأهداف المتوقعة {xg_text}. أفضل لاعب: {potm_name}.",
               "انتهت المباراة! {final_score_text}، و{potm_name} كان نجم اللقاء."),
    },
    "milestone": {
        "en": ("{title}.", "{title}!"),
        "fr": ("{title}.", "{title} !"),
        "ar": ("{title}.", "{title}!"),
    },
}
TAGS = {
    "en": {"analyst": "Insight", "casual": "Did you see?"},
    "fr": {"analyst": "Analyse", "casual": "Vous avez vu ?"},
    "ar": {"analyst": "تحليل", "casual": "هل رأيت؟"},
}


def personalizer(payload: dict[str, Any]) -> dict[str, Any]:
    m = payload["moment"]
    f = m["facts"]
    v = {**f, "team": m.get("team_name", ""), "title": m.get("title", "")}
    if "xg" in f:
        v["xg"] = round(float(f["xg"]), 2)
    np_ = int(f.get("buildup_passes", 0) or 0)
    v["move_en"] = "one-pass move" if np_ == 1 else f"{np_}-pass move"
    v["move_fr"] = "action en une passe" if np_ == 1 else f"action en {np_} passes"
    v["move_ar"] = "هجمة من تمريرة واحدة" if np_ == 1 else f"هجمة من {np_} تمريرات"
    v["outcome_en"] = OUTCOME_EN.get(f.get("outcome"), f.get("outcome", ""))
    v["outcome_fr"] = FR_OUTCOME.get(f.get("outcome"), f.get("outcome", ""))
    v["outcome_ar"] = AR_OUTCOME.get(f.get("outcome"), f.get("outcome", ""))
    tmpl = TEMPLATES.get(m["type"], TEMPLATES["milestone"])
    out: dict[str, Any] = {}
    for i, persona in enumerate(payload.get("personas", ["analyst", "casual"])):
        out[persona] = {}
        for lang in payload.get("languages", ["en", "fr", "ar"]):
            out[persona][lang] = {"caption": _fmt(tmpl[lang][min(i, 1)], v), "tag": TAGS[lang][persona]}
    return {"variants": out}


HANDLERS = {"analyst": analyst, "recap": recap, "telestrator": telestrator, "var": var_judge,
            "personalizer": personalizer}
