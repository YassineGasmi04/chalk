// Club crests: original badges for CHALK's fictional clubs, drawn in SVG.
// Ashvale Rovers: a shield with an ash tree. Kestrel Bay FC: a roundel with a kestrel over the bay.
// Any other club gets a shield with its initials.

const cache = new Map();

function shade(hex, amt) {
  const n = parseInt(hex.slice(1), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => Math.round(amt < 0 ? c * (1 + amt) : c + (255 - c) * amt));
  return `#${ch.map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}

function ashvale(c) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 116">
  <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${shade(c, 0.18)}"/><stop offset="1" stop-color="${shade(c, -0.25)}"/></linearGradient></defs>
  <path d="M50 3 L94 14 V56 C94 84 74 103 50 113 C26 103 6 84 6 56 V14 Z" fill="#1d0a2b"/>
  <path d="M50 9 L88 18.5 V56 C88 80 71 97 50 106 C29 97 12 80 12 56 V18.5 Z" fill="url(#g)"/>
  <path d="M12 32 H88" stroke="#1d0a2b" stroke-width="3"/>
  <text x="50" y="28" text-anchor="middle" font-family="Archivo, Arial, sans-serif" font-weight="800" font-size="11" fill="#fff" letter-spacing="1.5">ASHVALE</text>
  <path d="M48 92 V62 M52 92 V62" stroke="#fff" stroke-width="3.2" stroke-linecap="round"/>
  <path d="M50 66 L36 56 M50 72 L64 60 M50 78 L38 72" stroke="#fff" stroke-width="2.4" stroke-linecap="round"/>
  <ellipse cx="50" cy="50" rx="17" ry="12" fill="#fff"/>
  <ellipse cx="35" cy="57" rx="9" ry="7" fill="#fff"/>
  <ellipse cx="65" cy="57" rx="9" ry="7" fill="#fff"/>
  <ellipse cx="50" cy="42" rx="10" ry="8" fill="#fff"/>
  <path d="M36 94 H64" stroke="#fff" stroke-width="3" stroke-linecap="round"/>
</svg>`;
}

function kestrel(c) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${shade(c, 0.2)}"/><stop offset="1" stop-color="${shade(c, -0.3)}"/></linearGradient>
  <path id="arc" d="M18 50 A32 32 0 0 1 82 50"/></defs>
  <circle cx="50" cy="50" r="48" fill="#0d1b2a"/>
  <circle cx="50" cy="50" r="43" fill="url(#g)"/>
  <circle cx="50" cy="50" r="31" fill="none" stroke="#fff" stroke-width="1.5" opacity="0.55"/>
  <text font-family="Archivo, Arial, sans-serif" font-weight="800" font-size="9.5" fill="#fff" letter-spacing="2"><textPath href="#arc" startOffset="50%" text-anchor="middle">KESTREL BAY</textPath></text>
  <path d="M50 44 C44 38 34 35 23 38 C33 40 39 44 43 49 C38 49 33 51 30 55 C37 53 42 53 46 55 L50 62 L54 55 C58 53 63 53 70 55 C67 51 62 49 57 49 C61 44 67 40 77 38 C66 35 56 38 50 44 Z" fill="#fff"/>
  <circle cx="50" cy="45" r="2.6" fill="#fff"/>
  <path d="M28 70 Q34 66 40 70 T52 70 T64 70 T76 70" stroke="#fff" stroke-width="2.4" fill="none" stroke-linecap="round"/>
  <path d="M33 77 Q39 73 45 77 T57 77 T69 77" stroke="#fff" stroke-width="2.4" fill="none" stroke-linecap="round" opacity="0.7"/>
  <text x="50" y="90" text-anchor="middle" font-family="Archivo, Arial, sans-serif" font-weight="800" font-size="8" fill="#fff" letter-spacing="2">FC</text>
</svg>`;
}

function generic(name, c) {
  const initials = name.split(/\s+/).filter((w) => /^[A-Z]/.test(w)).map((w) => w[0]).join("").slice(0, 3);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 116">
  <path d="M50 3 L94 14 V56 C94 84 74 103 50 113 C26 103 6 84 6 56 V14 Z" fill="#1d0a2b"/>
  <path d="M50 9 L88 18.5 V56 C88 80 71 97 50 106 C29 97 12 80 12 56 V18.5 Z" fill="${c}"/>
  <text x="50" y="68" text-anchor="middle" font-family="Archivo, Arial, sans-serif" font-weight="800" font-size="28" fill="#fff">${initials}</text>
</svg>`;
}

/** A data URL of the club's crest, for <img src>. */
export function crestURL(name, color) {
  const key = `${name}|${color}`;
  if (!cache.has(key)) {
    const svg = /^ashvale/i.test(name) ? ashvale(color) : /^kestrel/i.test(name) ? kestrel(color) : generic(name, color);
    cache.set(key, `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);
  }
  return cache.get(key);
}

export function crestImg(name, color, cls = "crest") {
  return `<img class="${cls}" src="${crestURL(name, color)}" alt="">`;
}
