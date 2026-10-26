"""Fictional clubs, squads and formations.

Every name here is invented for the synthetic data set. Coordinates use a
105 x 68 m pitch. Formation shapes are written for a team attacking towards
x = 105; the engine mirrors them for the away side.
"""

from __future__ import annotations

from dataclasses import dataclass, field

# Formation shapes: (role, x, y) for a compact block centred on its own half.
# Attacking towards x = 105, a player's right hand points to y = 68 (the near touchline),
# so right-sided roles sit at large y.
# The engine shifts the block with the ball, so these are relative anchors.
FORMATIONS: dict[str, list[tuple[str, float, float]]] = {
    "4-3-3": [
        ("GK", 5, 34),
        ("LB", 24, 8), ("CB", 20, 26), ("CB", 20, 42), ("RB", 24, 60),
        ("CM", 38, 20), ("DM", 34, 34), ("CM", 38, 48),
        ("LW", 54, 10), ("ST", 58, 34), ("RW", 54, 58),
    ],
    "4-2-3-1": [
        ("GK", 5, 34),
        ("LB", 24, 8), ("CB", 20, 26), ("CB", 20, 42), ("RB", 24, 60),
        ("DM", 33, 26), ("DM", 33, 42),
        ("LAM", 47, 12), ("CAM", 48, 34), ("RAM", 47, 56),
        ("ST", 58, 34),
    ],
    "4-4-2": [
        ("GK", 5, 34),
        ("LB", 24, 8), ("CB", 20, 26), ("CB", 20, 42), ("RB", 24, 60),
        ("LM", 40, 10), ("CM", 37, 27), ("CM", 37, 41), ("RM", 40, 58),
        ("ST", 56, 26), ("ST", 56, 42),
    ],
    "5-3-2": [
        ("GK", 5, 34),
        ("LWB", 28, 6), ("CB", 18, 22), ("CB", 17, 34), ("CB", 18, 46), ("RWB", 28, 62),
        ("CM", 36, 22), ("CM", 33, 34), ("CM", 36, 46),
        ("ST", 54, 28), ("ST", 54, 40),
    ],
}


@dataclass
class Player:
    pid: str
    name: str
    short: str
    number: int
    position: str
    # 0-1 skill ratings that tilt outcomes a little
    passing: float = 0.7
    finishing: float = 0.5
    pace: float = 0.6  # maps to top speed 29-35 km/h
    defending: float = 0.5


@dataclass
class Manager:
    name: str
    short: str
    style: str  # one line on how the team plays, shown on the line-ups


@dataclass
class Team:
    key: str  # "home" | "away"
    name: str
    short: str
    color: str
    formation: str
    starters: list[Player]
    bench: list[Player] = field(default_factory=list)
    manager: Manager | None = None
    max_subs: int = 5
    # Tactical dials the script can change during the match
    press: float = 0.45  # 0 passive .. 1 relentless
    directness: float = 0.4  # 0 patient .. 1 long balls
    line_height: float = 0.5  # 0 deep block .. 1 high line


# Classic numbering: 2 right-back, 3 left-back, 7 right wing, 11 left wing. The player ids
# stay as they were, so the match itself is unchanged; only the shirts follow the positions.
SHIRT = {"LB": {2: 3}, "RB": {3: 2}, "LW": {7: 11}, "RW": {11: 7}}


def _p(team: str, n: int, name: str, short: str, pos: str, **kw) -> Player:
    number = SHIRT.get(pos, {}).get(n, n)
    return Player(pid=f"{team[0]}{n}", name=name, short=short, number=number, position=pos, **kw)


def default_teams() -> tuple[Team, Team]:
    """Two fictional clubs with contrasting styles."""
    home = Team(
        key="home",
        name="Ashvale Rovers",
        short="ASH",
        color="#e4572e",
        formation="4-3-3",
        press=0.45,
        directness=0.35,
        line_height=0.55,
        starters=[
            _p("home", 1, "Mateo Lindqvist", "Lindqvist", "GK", passing=0.55, defending=0.8),
            _p("home", 2, "Kofi Asante-Brie", "Asante-Brie", "LB", pace=0.8, defending=0.6),
            _p("home", 4, "Ruben Okafor", "Okafor", "CB", defending=0.8, pace=0.55),
            _p("home", 5, "Idris Kallal", "Kallal", "CB", defending=0.82, passing=0.75),
            _p("home", 3, "Theo Marchetti", "Marchetti", "RB", pace=0.75),
            _p("home", 8, "Sami Haddadi", "Haddadi", "CM", passing=0.88, finishing=0.45),
            _p("home", 6, "Jonah Whitcombe", "Whitcombe", "DM", passing=0.8, defending=0.75),
            _p("home", 10, "Elias Brandt", "Brandt", "CM", passing=0.9, finishing=0.6),
            _p("home", 7, "Nico Varga", "Varga", "LW", pace=0.92, finishing=0.6),
            _p("home", 9, "Yaw Mensah-Cole", "Mensah-Cole", "ST", finishing=0.82, pace=0.7),
            _p("home", 11, "Aurelien Dufay", "Dufay", "RW", pace=0.85, finishing=0.62),
        ],
        bench=[
            _p("home", 14, "Callum Reyes", "Reyes", "CM", passing=0.78),
            _p("home", 17, "Tariq El Mansouri", "El Mansouri", "ST", finishing=0.75, pace=0.88),
            _p("home", 15, "Bram de Wit", "de Wit", "CB", defending=0.78),
            _p("home", 13, "Oskar Vahl", "Vahl", "GK", defending=0.74),
            _p("home", 12, "Jamal Okoye-Price", "Okoye-Price", "LB", pace=0.78),
            _p("home", 16, "Leo Castellanos", "Castellanos", "DM", defending=0.74, passing=0.76),
            _p("home", 18, "Ravi Anand", "Anand", "CAM", passing=0.83, finishing=0.6),
            _p("home", 19, "Mikkel Strand", "Strand", "RW", pace=0.86, finishing=0.58),
            _p("home", 21, "Yusuf Demiral-Hart", "Demiral-Hart", "LM", pace=0.8),
        ],
        manager=Manager("Ines Varela", "Varela", "High press, quick wingers"),
    )
    away = Team(
        key="away",
        name="Kestrel Bay FC",
        short="KES",
        color="#2e86ab",
        formation="4-3-3",
        press=0.4,
        directness=0.55,
        line_height=0.45,
        starters=[
            _p("away", 1, "Ilya Sorensen", "Sorensen", "GK", passing=0.5, defending=0.78),
            _p("away", 2, "Dario Pellegrino", "Pellegrino", "LB", pace=0.72),
            _p("away", 5, "Owen Nakamura-Hale", "Nakamura-Hale", "CB", defending=0.8),
            _p("away", 4, "Malik Benali", "Benali", "CB", defending=0.78, pace=0.6),
            _p("away", 3, "Finn O'Rourke", "O'Rourke", "RB", pace=0.7),
            _p("away", 8, "Lucas Ferreira-Lind", "Ferreira-Lind", "CM", passing=0.82),
            _p("away", 6, "Emeka Obi", "Obi", "DM", defending=0.8, passing=0.72),
            _p("away", 10, "Rayan Chaouch", "Chaouch", "CM", passing=0.86, finishing=0.65),
            _p("away", 7, "Kai Holmberg", "Holmberg", "LW", pace=0.88, finishing=0.58),
            _p("away", 9, "Adebayo Lorne", "Lorne", "ST", finishing=0.8, pace=0.74),
            _p("away", 11, "Jules Moreau-Vance", "Moreau-Vance", "RW", pace=0.9, finishing=0.6),
        ],
        bench=[
            _p("away", 19, "Nkem Nkemelu", "Nkemelu", "CAM", passing=0.84, finishing=0.62),
            _p("away", 16, "Viktor Aalto", "Aalto", "DM", defending=0.76),
            _p("away", 20, "Hamza Trabelsi-Roy", "Trabelsi-Roy", "ST", finishing=0.78, pace=0.8),
            _p("away", 13, "Arne Lindgren", "Lindgren", "GK", defending=0.73),
            _p("away", 12, "Teo Vasquez", "Vasquez", "RB", pace=0.74),
            _p("away", 14, "Gideon Osei", "Osei", "CB", defending=0.77),
            _p("away", 15, "Paulo Brennan", "Brennan", "CM", passing=0.8),
            _p("away", 17, "Sacha Mbeki", "Mbeki", "LM", pace=0.84),
            _p("away", 18, "Elio Ferraz", "Ferraz", "RW", pace=0.87, finishing=0.6),
        ],
        manager=Manager("Tomasz Rehn", "Rehn", "Compact block, direct counters"),
    )
    return home, away
