// Player portraits: an original illustrated head-and-shoulders picture for every
// fictional player, generated from their id (same player, same face, every time),
// wearing their club's shirt and number. No photos, no real people.

const SKIN = ["#f3d2b8", "#e9b995", "#d69d72", "#bd7d52", "#94603e", "#714530", "#4e2f20"];
const HAIR = ["#17110d", "#2a1c13", "#47301e", "#6e4b2c", "#a47a47", "#d9b36f", "#3b3b3e"];
const cache = new Map();

function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}
function shade(hex, amt) {
  const n = parseInt(hex.slice(1), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => Math.round(amt < 0 ? c * (1 + amt) : c + (255 - c) * amt));
  return `#${ch.map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}

/** SVG markup (viewBox 0 0 120 120) of a player's portrait. */
export function avatarSVG({ pid, name = "", number = "", color = "#7d3cff", keeper = false, coach = false }) {
  const r = rng(hash(`${pid}|${name}`));
  const pick = (a) => a[Math.floor(r() * a.length)];
  const skin = pick(SKIN), hair = pick(HAIR);
  const dark = shade(skin, -0.22), shirt = coach ? "#1b1a2a" : keeper ? "#2fd47a" : color;
  const hx = 60, hy = 52, rx = 20 + r() * 3, ry = 25 + r() * 3;
  const style = Math.floor(r() * 7);
  const beard = r() < 0.32;
  const brow = 1.6 + r() * 1.2;
  const id = `a${hash(pid) % 1e6}`;
  let hairSvg = "";
  const top = hy - ry;
  switch (style) {
    case 0: // buzz
      hairSvg = `<path d="M${hx - rx} ${hy - 4} Q${hx - rx} ${top - 3} ${hx} ${top - 3} Q${hx + rx} ${top - 3} ${hx + rx} ${hy - 4} Q${hx + rx - 3} ${top + 8} ${hx} ${top + 6} Q${hx - rx + 3} ${top + 8} ${hx - rx} ${hy - 4}Z" fill="${hair}" opacity="0.85"/>`;
      break;
    case 1: // short crop with a fringe
      hairSvg = `<path d="M${hx - rx - 1} ${hy - 9} Q${hx - rx - 3} ${top - 6} ${hx} ${top - 7} Q${hx + rx + 3} ${top - 6} ${hx + rx + 1} ${hy - 9} L${hx + rx - 3} ${top + 9} Q${hx + 4} ${top + 4} ${hx - 6} ${top + 10} Q${hx - rx + 4} ${top + 7} ${hx - rx + 1} ${hy - 9}Z" fill="${hair}"/>`;
      break;
    case 2: { // curls
      let c = "";
      for (let a = Math.PI * 1.05; a <= Math.PI * 1.95; a += 0.17) {
        c += `<circle cx="${(hx + Math.cos(a) * (rx + 1)).toFixed(1)}" cy="${(hy - 6 + Math.sin(a) * (ry - 1)).toFixed(1)}" r="${(5.2 + r() * 2).toFixed(1)}" fill="${hair}"/>`;
      }
      hairSvg = `<ellipse cx="${hx}" cy="${top + 6}" rx="${rx - 2}" ry="9" fill="${hair}"/>${c}`;
      break;
    }
    case 3: // high fade
      hairSvg = `<path d="M${hx - rx + 1} ${hy - 6} Q${hx - rx + 2} ${top - 9} ${hx} ${top - 11} Q${hx + rx - 2} ${top - 9} ${hx + rx - 1} ${hy - 6} Q${hx + rx - 4} ${top + 8} ${hx} ${top + 6} Q${hx - rx + 4} ${top + 8} ${hx - rx + 1} ${hy - 6}Z" fill="${hair}"/>
        <path d="M${hx - rx} ${hy - 2} Q${hx - rx} ${top + 6} ${hx - rx + 6} ${top + 4}" stroke="${hair}" stroke-width="3" fill="none" opacity="0.45"/>
        <path d="M${hx + rx} ${hy - 2} Q${hx + rx} ${top + 6} ${hx + rx - 6} ${top + 4}" stroke="${hair}" stroke-width="3" fill="none" opacity="0.45"/>`;
      break;
    case 4: // tied back with a bun
      hairSvg = `<circle cx="${hx + 2}" cy="${top - 7}" r="7" fill="${hair}"/>
        <path d="M${hx - rx - 1} ${hy - 8} Q${hx - rx - 2} ${top - 4} ${hx} ${top - 4} Q${hx + rx + 2} ${top - 4} ${hx + rx + 1} ${hy - 8} Q${hx + rx - 3} ${top + 7} ${hx} ${top + 5} Q${hx - rx + 3} ${top + 7} ${hx - rx - 1} ${hy - 8}Z" fill="${hair}"/>`;
      break;
    case 5: // shaved, with a sheen
      hairSvg = `<ellipse cx="${hx - 6}" cy="${top + 7}" rx="7" ry="3.5" fill="#ffffff" opacity="0.18"/>`;
      break;
    default: // swept
      hairSvg = `<path d="M${hx - rx - 1} ${hy - 10} Q${hx - rx - 4} ${top - 8} ${hx + 4} ${top - 8} Q${hx + rx + 5} ${top - 6} ${hx + rx + 1} ${hy - 10} Q${hx + rx - 3} ${top + 7} ${hx + 8} ${top + 4} Q${hx - 4} ${top + 8} ${hx - rx + 2} ${hy - 10}Z" fill="${hair}"/>`;
  }
  const ey = hy - 1 + r() * 2, ex = 7.5 + r() * 1.5;
  const beardSvg = beard ? `<path d="M${hx - rx + 2} ${hy + 4} Q${hx - rx + 4} ${hy + ry - 2} ${hx} ${hy + ry + 1} Q${hx + rx - 4} ${hy + ry - 2} ${hx + rx - 2} ${hy + 4} Q${hx + rx - 6} ${hy + 15} ${hx} ${hy + 16} Q${hx - rx + 6} ${hy + 15} ${hx - rx + 2} ${hy + 4}Z" fill="${hair}" opacity="0.8"/>` : "";
  const num = String(number);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120">
  <defs>
    <radialGradient id="${id}f" cx="0.38" cy="0.32" r="0.8"><stop offset="0" stop-color="${shade(skin, 0.12)}"/><stop offset="1" stop-color="${skin}"/></radialGradient>
    <linearGradient id="${id}s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${shade(shirt, 0.15)}"/><stop offset="1" stop-color="${shade(shirt, -0.3)}"/></linearGradient>
  </defs>
  <path d="M8 120 Q10 96 34 89 L48 84 Q60 92 72 84 L86 89 Q110 96 112 120Z" fill="url(#${id}s)"/>
  <path d="M48 84 Q60 99 72 84 L68 83 Q60 91 52 83Z" fill="${shade(shirt, -0.45)}"/>
  ${coach ? `<path d="M50 85 L60 120 L70 85 Q60 92 50 85Z" fill="#f2f0f7"/><path d="M57 92 L60 88 L63 92 L61 116 L60 119 L59 116Z" fill="${color}"/>
  <path d="M34 92 L52 120 M86 92 L68 120" stroke="#0d0c17" stroke-width="2.5"/>`
    : `<path d="M22 104 L18 120 M98 104 L102 120" stroke="${shade(shirt, -0.35)}" stroke-width="3"/>
  <text x="${num.length > 1 ? 79 : 81}" y="110" font-family="Archivo, Arial, sans-serif" font-weight="800" font-size="13" fill="#ffffff" opacity="0.92">${num}</text>`}
  <rect x="52" y="${hy + ry - 8}" width="16" height="${86 - (hy + ry - 8)}" rx="6" fill="${dark}"/>
  <ellipse cx="${hx - rx}" cy="${hy + 2}" rx="3.8" ry="5.5" fill="${dark}"/>
  <ellipse cx="${hx + rx}" cy="${hy + 2}" rx="3.8" ry="5.5" fill="${dark}"/>
  <ellipse cx="${hx}" cy="${hy}" rx="${rx}" ry="${ry}" fill="url(#${id}f)"/>
  ${beardSvg}
  <rect x="${hx - ex - 4}" y="${ey - 7}" width="8.5" height="${brow}" rx="1" fill="${hair}" transform="rotate(-6 ${hx - ex} ${ey - 6})"/>
  <rect x="${hx + ex - 4.5}" y="${ey - 7}" width="8.5" height="${brow}" rx="1" fill="${hair}" transform="rotate(6 ${hx + ex} ${ey - 6})"/>
  <ellipse cx="${hx - ex}" cy="${ey}" rx="2.3" ry="2.6" fill="#1a1412"/>
  <ellipse cx="${hx + ex}" cy="${ey}" rx="2.3" ry="2.6" fill="#1a1412"/>
  <circle cx="${hx - ex + 0.8}" cy="${ey - 0.9}" r="0.7" fill="#fff"/>
  <circle cx="${hx + ex + 0.8}" cy="${ey - 0.9}" r="0.7" fill="#fff"/>
  <path d="M${hx - 1} ${ey + 3} Q${hx - 3.5} ${ey + 10} ${hx} ${ey + 11} Q${hx + 2} ${ey + 11} ${hx + 2.5} ${ey + 10}" stroke="${dark}" stroke-width="1.6" fill="none" stroke-linecap="round"/>
  <path d="M${hx - 5.5} ${ey + 16} Q${hx} ${ey + 19} ${hx + 5.5} ${ey + 16}" stroke="${shade(skin, -0.45)}" stroke-width="1.8" fill="none" stroke-linecap="round"/>
  ${hairSvg}
</svg>`;
}

/** A data URL for <img src> and canvas drawing. Cached per player. */
export function avatarURL(p) {
  const key = `${p.pid}|${p.color}|${p.number}|${p.coach ? 1 : 0}`;
  if (!cache.has(key)) cache.set(key, `data:image/svg+xml;charset=utf-8,${encodeURIComponent(avatarSVG(p))}`);
  return cache.get(key);
}
