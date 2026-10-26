// Shareable moment cards: one PNG per insight, in the viewer's language and mode.
// 1080 x 1350 (portrait, the size social feeds show best).

const W = 1080, H = 1350;
const SIGNAL = "#ffbf3c";
const PL = 105, PW = 68;

function wrap(ctx, text, maxWidth) {
  const words = String(text || "").split(/\s+/);
  const lines = [];
  let line = "";
  for (const w of words) {
    const test = line ? `${line} ${w}` : w;
    if (ctx.measureText(test).width > maxWidth && line) {
      lines.push(line);
      line = w;
    } else {
      line = test;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

async function loadLogo() {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = "logo.svg";
  });
}

/** Draw the moment on a flat mini pitch with the Telestrator's drawings. */
function drawPitch(ctx, x0, y0, w, frame, drawings, roster, colors) {
  const s = w / (PL + 8);
  const h = (PW + 8) * s;
  const P = (x, y) => [x0 + (x + 4) * s, y0 + (y + 4) * s];
  roundRect(ctx, x0, y0, w, h, 28);
  const g = ctx.createLinearGradient(0, y0, 0, y0 + h);
  g.addColorStop(0, "#1b5845");
  g.addColorStop(1, "#13402f");
  ctx.fillStyle = g;
  ctx.fill();
  ctx.save();
  ctx.clip();
  for (let i = 0; i < 14; i += 2) {
    const [a] = P(i * PL / 14, 0), [b] = P((i + 1) * PL / 14, 0);
    ctx.fillStyle = "rgba(255,255,255,0.035)";
    ctx.fillRect(a, y0, b - a, h);
  }
  ctx.restore();
  ctx.strokeStyle = "rgba(255,255,255,0.8)";
  ctx.lineWidth = 3;
  const line = (pts) => { ctx.beginPath(); pts.forEach(([x, y], i) => { const [X, Y] = P(x, y); i ? ctx.lineTo(X, Y) : ctx.moveTo(X, Y); }); ctx.stroke(); };
  line([[0, 0], [PL, 0], [PL, PW], [0, PW], [0, 0]]);
  line([[PL / 2, 0], [PL / 2, PW]]);
  const [cx, cy] = P(PL / 2, PW / 2);
  ctx.beginPath(); ctx.arc(cx, cy, 9.15 * s, 0, Math.PI * 2); ctx.stroke();
  for (const side of [0, 1]) {
    const x = side ? PL : 0, d = side ? -1 : 1;
    line([[x, PW / 2 - 20.16], [x + d * 16.5, PW / 2 - 20.16], [x + d * 16.5, PW / 2 + 20.16], [x, PW / 2 + 20.16]]);
    line([[x, PW / 2 - 9.16], [x + d * 5.5, PW / 2 - 9.16], [x + d * 5.5, PW / 2 + 9.16], [x, PW / 2 + 9.16]]);
  }
  // zones under the players
  for (const d of drawings) {
    if (d.type !== "zone" || !d.points?.length) continue;
    ctx.beginPath();
    d.points.forEach(([x, y], i) => { const [X, Y] = P(x, y); i ? ctx.lineTo(X, Y) : ctx.moveTo(X, Y); });
    ctx.closePath();
    ctx.fillStyle = "rgba(255,191,60,0.22)";
    ctx.fill();
    ctx.setLineDash([12, 9]);
    ctx.strokeStyle = SIGNAL;
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.setLineDash([]);
  }
  for (const d of drawings) {
    if (d.type === "circle" && frame[d.player]) {
      const [X, Y] = P(...frame[d.player]);
      ctx.beginPath(); ctx.arc(X, Y, 2.8 * s, 0, Math.PI * 2);
      ctx.strokeStyle = SIGNAL; ctx.lineWidth = 5; ctx.stroke();
    }
  }
  // players
  for (const [pid, [x, y]] of Object.entries(frame)) {
    const p = roster[pid];
    if (!p) continue;
    const [X, Y] = P(x, y);
    ctx.beginPath(); ctx.arc(X, Y, 1.35 * s, 0, Math.PI * 2);
    ctx.fillStyle = colors[p.team]; ctx.fill();
    ctx.lineWidth = 2; ctx.strokeStyle = "rgba(255,255,255,0.7)"; ctx.stroke();
    ctx.fillStyle = "#fff";
    ctx.font = `800 ${Math.round(1.5 * s)}px Archivo, system-ui, sans-serif`;
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(String(p.number), X, Y + 1);
  }
  // arrows and links on top
  for (const d of drawings) {
    let a, b;
    if (d.type === "arrow") { a = d.from; b = d.to; }
    else if (d.type === "link" && frame[d.players?.[0]] && frame[d.players?.[1]]) { a = frame[d.players[0]]; b = frame[d.players[1]]; }
    else continue;
    const [X0, Y0] = P(...a), [X1, Y1] = P(...b);
    ctx.save();
    ctx.strokeStyle = d.style === "shot" ? "#ffffff" : SIGNAL;
    ctx.lineWidth = d.style === "shot" ? 7 : 6;
    ctx.lineCap = "round";
    if (d.type === "link" || d.style === "pass" || d.style === "run") ctx.setLineDash(d.style === "run" ? [3, 14] : [18, 12]);
    ctx.beginPath(); ctx.moveTo(X0, Y0); ctx.lineTo(X1, Y1); ctx.stroke();
    ctx.restore();
    if (d.type === "arrow") {
      const ang = Math.atan2(Y1 - Y0, X1 - X0), L = 26;
      ctx.beginPath();
      ctx.moveTo(X1, Y1);
      ctx.lineTo(X1 - Math.cos(ang - 0.42) * L, Y1 - Math.sin(ang - 0.42) * L);
      ctx.lineTo(X1 - Math.cos(ang + 0.42) * L, Y1 - Math.sin(ang + 0.42) * L);
      ctx.closePath();
      ctx.fillStyle = d.style === "shot" ? "#ffffff" : SIGNAL;
      ctx.fill();
    }
  }
  return h;
}

export async function makeShareCard({ card, moment, prefs, roster, colors, start, typeLabel, ui }) {
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const ctx = c.getContext("2d");
  await document.fonts?.ready;
  const lang = prefs.lang;
  const rtl = lang === "ar";
  const font = (w, px) => `${w} ${px}px ${rtl ? '"Noto Kufi Arabic", ' : ""}Archivo, system-ui, sans-serif`;

  // stage
  const bg = ctx.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, "#3b0d4f");
  bg.addColorStop(1, "#1f0a2e");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);
  ctx.save();
  ctx.globalAlpha = 0.06;
  ctx.fillStyle = "#fff";
  ctx.beginPath(); ctx.moveTo(620, 0); ctx.lineTo(700, 0); ctx.lineTo(240, H); ctx.lineTo(160, H); ctx.closePath(); ctx.fill();
  ctx.restore();

  // header
  const logo = await loadLogo();
  if (logo) ctx.drawImage(logo, 60, 52, 72, 72);
  ctx.fillStyle = "#fff";
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.font = "800 52px Archivo, system-ui, sans-serif";
  ctx.fillText("chalk", 146, 90);
  ctx.font = "600 26px Archivo, system-ui, sans-serif";
  ctx.fillStyle = "rgba(255,255,255,0.7)";
  ctx.textAlign = "right";
  ctx.fillText(`${start.home.name} v ${start.away.name}`, W - 60, 76);
  ctx.fillText("Synthetic match", W - 60, 110);

  // tag
  ctx.textAlign = "left";
  ctx.font = "800 30px Archivo, system-ui, sans-serif";
  const tag = `${card.clock}  ${typeLabel}`;
  const tw = ctx.measureText(tag).width + 56;
  ctx.fillStyle = SIGNAL;
  ctx.beginPath(); ctx.moveTo(60, 170); ctx.lineTo(60 + tw, 170); ctx.lineTo(60 + tw - 18, 226); ctx.lineTo(60, 226); ctx.closePath(); ctx.fill();
  ctx.fillStyle = "#1d0d00";
  ctx.fillText(tag, 84, 199);

  // pitch
  const frame = moment?.geometry?.frame || {};
  const ph = drawPitch(ctx, 60, 260, W - 120, frame, card.drawings || [], roster, colors);

  // words
  const v = card.variants?.[prefs.persona]?.[lang] || card.variants?.analyst?.en || {};
  const head = lang === "en" ? card.headline : v.caption;
  const body = lang === "en" ? v.caption : "";
  let y = 260 + ph + 70;
  ctx.direction = rtl ? "rtl" : "ltr";
  ctx.textAlign = rtl ? "right" : "left";
  const tx = rtl ? W - 60 : 60;
  ctx.fillStyle = "#fff";
  ctx.font = font(800, rtl ? 46 : 54);
  for (const l of wrap(ctx, head, W - 120).slice(0, 3)) { ctx.fillText(l, tx, y); y += rtl ? 70 : 64; }
  if (body) {
    y += 8;
    ctx.fillStyle = "rgba(255,255,255,0.78)";
    ctx.font = font(500, 34);
    for (const l of wrap(ctx, body, W - 120).slice(0, 3)) { ctx.fillText(l, tx, y); y += 48; }
  }
  ctx.direction = "ltr";

  // footer
  ctx.textAlign = "left";
  const fy = H - 92;
  ctx.font = "700 28px Archivo, system-ui, sans-serif";
  const verified = card.var?.final === "verified";
  const badge = verified ? `✓ ${ui.ok}` : ui.safe;
  const bw = ctx.measureText(badge).width + 44;
  roundRect(ctx, 60, fy - 28, bw, 56, 28);
  ctx.fillStyle = verified ? "rgba(70,200,130,0.2)" : "rgba(255,191,60,0.2)";
  ctx.fill();
  ctx.fillStyle = verified ? "#7ee2a8" : SIGNAL;
  ctx.fillText(badge, 82, fy + 1);
  ctx.font = "500 24px Archivo, system-ui, sans-serif";
  ctx.fillStyle = "rgba(255,255,255,0.6)";
  ctx.fillText("Explained, drawn and fact-checked by four AI agents", 60 + bw + 28, fy - 14);
  ctx.fillText("Microsoft Agent Framework on Microsoft Foundry", 60 + bw + 28, fy + 18);

  return new Promise((resolve) => c.toBlob(resolve, "image/png"));
}

export async function shareOrDownload(blob, name) {
  const file = new File([blob], name, { type: "image/png" });
  try {
    if (navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file], title: "CHALK moment" });
      return "shared";
    }
  } catch { /* fall back to a download */ }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  return "downloaded";
}
