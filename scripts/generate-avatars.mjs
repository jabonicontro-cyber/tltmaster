#!/usr/bin/env node
// Generates Taviron's illustrated avatars for trucking and aggregate-hauling
// professionals (drivers in hi-vis and caps, loader operators and managers in
// hard hats, mechanics in coveralls, dispatchers with headsets). Original
// artwork drawn here as plain SVG — no third-party art, no photographs of real
// people. Writes public/avatars/avatar-NN.svg and .png (PNG rendered with the
// project's Playwright Chromium).
//
//   node scripts/generate-avatars.mjs            # SVG + PNG
//   PW_CHROMIUM_PATH=/opt/pw-browsers/chromium node scripts/generate-avatars.mjs
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "avatars");

const SKIN = { light: "#f3d2b8", fair: "#e9bf9b", medium: "#d39b73", tan: "#b97a52", brown: "#8d5a3b", dark: "#5f3b27" };
const HAIR = { black: "#1f1a17", dark: "#3b2a1e", brown: "#6b4426", auburn: "#8a3f22", blonde: "#d4ad6a", gray: "#9a9a9a", white: "#d9d9d9" };
const BG = ["#dfe7ef", "#e8e2d4", "#dde8df", "#ece0d6", "#e2e0ec", "#e3e9e6"];

/** Each avatar is chosen, not random, so every one reads as a believable person. */
const PEOPLE = [
  { skin: "fair", hair: "short", hairColor: "dark", hat: "cap", hatColor: "#1f3b5c", top: "vest", vest: "#f26b1d", shirt: "#2b3a4f", beard: "full" },
  { skin: "brown", hair: "buzz", hairColor: "black", hat: "hardhat", hatColor: "#f2c230", top: "vest", vest: "#c6e23a", shirt: "#3d4a5c" },
  { skin: "medium", hair: "ponytail", hairColor: "dark", hat: "cap", hatColor: "#b23a2e", top: "vest", vest: "#c6e23a", shirt: "#5a6472" },
  { skin: "light", hair: "short", hairColor: "brown", hat: "beanie", hatColor: "#5b6168", top: "coveralls", coverall: "#2f5d8a", beard: "stubble" },
  { skin: "dark", hair: "bun", hairColor: "black", hat: "cap", hatColor: "#222222", top: "coveralls", coverall: "#27476b" },
  { skin: "medium", hair: "side", hairColor: "black", top: "polo", shirt: "#2e6b4e", headset: true, glasses: true },
  { skin: "fair", hair: "long", hairColor: "brown", top: "shirt", shirt: "#4f7fb0", headset: true },
  { skin: "light", hair: "sides", hairColor: "gray", hat: "hardhat", hatColor: "#f4f4f2", top: "jacket", jacket: "#8a5a2b", beard: "mustache", beardColor: "gray" },
  { skin: "light", hair: "long", hairColor: "blonde", top: "shirt", shirt: "#a9c4dd", glasses: true },
  { skin: "tan", hair: "short", hairColor: "dark", hat: "hardhat", hatColor: "#f28c28", top: "vest", vest: "#f26b1d", shirt: "#3b3f45" },
  { skin: "dark", hair: "buzz", hairColor: "black", top: "flannel", shirt: "#a23b2a", beard: "full" },
  { skin: "medium", hair: "short", hairColor: "black", hat: "cap", hatColor: "#6d7178", top: "jacket", jacket: "#6e5a3c", beard: "mustache" },
  { skin: "brown", hair: "short", hairColor: "black", hat: "cap", hatColor: "#2f5d8a", top: "coveralls", coverall: "#5b6f86", glasses: true },
  { skin: "fair", hair: "braid", hairColor: "auburn", hat: "hardhat", hatColor: "#f2c230", top: "vest", vest: "#f26b1d", shirt: "#2b3a4f" },
  { skin: "brown", hair: "curly", hairColor: "black", hat: "hardhat", hatColor: "#f4f4f2", top: "vest", vest: "#c6e23a", shirt: "#24364f" },
  { skin: "light", hair: "sides", hairColor: "white", hat: "cap", hatColor: "#b23a2e", top: "flannel", shirt: "#3d5a80", beard: "full", beardColor: "white" },
  { skin: "dark", hair: "side", hairColor: "black", top: "polo", shirt: "#1f3b5c" },
  { skin: "medium", hair: "bun", hairColor: "brown", hat: "beanie", hatColor: "#2e6b4e", top: "coveralls", coverall: "#2f5d8a" },
  { skin: "fair", hair: "short", hairColor: "auburn", hat: "hardhat", hatColor: "#f2c230", top: "vest", vest: "#c6e23a", shirt: "#4a4f57", beard: "full" },
  { skin: "tan", hair: "sides", hairColor: "gray", top: "sweater", shirt: "#6b5b4b", headset: true, glasses: true },
];

const shade = (hex, f) => {
  const n = parseInt(hex.slice(1), 16);
  const c = [n >> 16, (n >> 8) & 255, n & 255].map((v) => Math.max(0, Math.min(255, Math.round(v * f))));
  return `#${c.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
};

const TORSO = "M28 256 C 32 206 78 186 128 186 C 178 186 224 206 228 256 Z";

function top(p) {
  const out = [];
  if (p.top === "vest") {
    out.push(`<path d="${TORSO}" fill="${p.shirt}"/>`);
    out.push(`<clipPath id="v"><path d="M28 256 C 32 208 70 190 104 187 L 116 256 Z M228 256 C 224 208 186 190 152 187 L 140 256 Z"/></clipPath>`);
    out.push(`<g clip-path="url(#v)"><rect x="0" y="180" width="256" height="80" fill="${p.vest}"/><rect x="0" y="226" width="256" height="9" fill="#e6eaee"/><rect x="88" y="186" width="9" height="70" fill="#e6eaee"/><rect x="159" y="186" width="9" height="70" fill="#e6eaee"/></g>`);
    out.push(`<path d="M108 188 L128 214 L148 188" fill="none" stroke="${shade(p.shirt, 0.7)}" stroke-width="5" stroke-linejoin="round"/>`);
  } else if (p.top === "coveralls") {
    out.push(`<path d="${TORSO}" fill="${p.coverall}"/>`);
    out.push(`<path d="M104 188 L128 222 L152 188" fill="${shade(p.coverall, 0.75)}"/>`);
    out.push(`<line x1="128" y1="222" x2="128" y2="256" stroke="${shade(p.coverall, 0.7)}" stroke-width="3"/>`);
    out.push(`<rect x="146" y="226" width="34" height="14" rx="3" fill="#f4f4f2"/><rect x="151" y="231" width="24" height="3" rx="1.5" fill="#b23a2e"/>`);
  } else if (p.top === "jacket") {
    out.push(`<path d="${TORSO}" fill="${p.jacket}"/>`);
    out.push(`<path d="M100 188 L118 206 L128 256 L138 206 L156 188 L128 196 Z" fill="#e9e4da"/>`);
    out.push(`<path d="M96 188 L114 214 L104 222 Z M160 188 L142 214 L152 222 Z" fill="${shade(p.jacket, 0.78)}"/>`);
    out.push(`<line x1="128" y1="214" x2="128" y2="256" stroke="${shade(p.jacket, 0.65)}" stroke-width="3"/>`);
  } else if (p.top === "flannel") {
    out.push(`<clipPath id="f"><path d="${TORSO}"/></clipPath>`);
    out.push(`<g clip-path="url(#f)"><rect x="0" y="180" width="256" height="80" fill="${p.shirt}"/>`);
    for (let x = 20; x < 256; x += 26) out.push(`<rect x="${x}" y="180" width="8" height="80" fill="${shade(p.shirt, 0.6)}" opacity="0.8"/>`);
    for (let y = 196; y < 256; y += 22) out.push(`<rect x="0" y="${y}" width="256" height="7" fill="${shade(p.shirt, 0.6)}" opacity="0.7"/>`);
    out.push(`</g><path d="M106 188 L128 210 L150 188" fill="none" stroke="${shade(p.shirt, 0.5)}" stroke-width="5" stroke-linejoin="round"/>`);
  } else if (p.top === "sweater") {
    out.push(`<path d="${TORSO}" fill="${p.shirt}"/><path d="M106 186 C 112 198 144 198 150 186" fill="none" stroke="${shade(p.shirt, 0.75)}" stroke-width="7"/>`);
  } else {
    // polo or button shirt
    out.push(`<path d="${TORSO}" fill="${p.shirt}"/>`);
    out.push(`<path d="M104 186 L122 204 L128 192 L134 204 L152 186 Z" fill="${shade(p.shirt, 0.82)}"/>`);
    out.push(`<line x1="128" y1="204" x2="128" y2="${p.top === "polo" ? 222 : 256}" stroke="${shade(p.shirt, 0.7)}" stroke-width="2.5"/>`);
    if (p.top === "polo") out.push(`<circle cx="128" cy="212" r="2" fill="${shade(p.shirt, 0.6)}"/>`);
  }
  return out.join("");
}

function hairBack(p) {
  const c = HAIR[p.hairColor];
  if (p.hair === "long") return `<path d="M76 110 C 70 170 80 214 98 222 L 158 222 C 176 214 186 170 180 110 Z" fill="${c}"/>`;
  if (p.hair === "braid") return `<path d="M160 130 C 176 160 172 196 166 214" fill="none" stroke="${c}" stroke-width="13" stroke-linecap="round" stroke-dasharray="10 3"/>`;
  if (p.hair === "ponytail") return `<path d="M168 104 C 196 120 192 168 176 190" fill="none" stroke="${c}" stroke-width="16" stroke-linecap="round"/>`;
  return "";
}

function hairFront(p) {
  const c = HAIR[p.hairColor];
  if (p.hat === "hardhat" || p.hat === "cap" || p.hat === "beanie") {
    // Only what shows under a hat: sideburns or tied hair.
    return `<path d="M80 100 C 80 118 84 128 88 134 L 92 102 Z M176 100 C 176 118 172 128 168 134 L 164 102 Z" fill="${c}"/>`
      + (p.hair === "bun" ? `<circle cx="128" cy="54" r="0" fill="${c}"/>` : "");
  }
  switch (p.hair) {
    case "buzz": return `<path d="M82 108 C 80 62 176 62 174 108 C 168 86 150 76 128 76 C 106 76 88 86 82 108 Z" fill="${c}" opacity="0.85"/>`;
    case "sides": return `<path d="M80 96 C 80 118 84 128 88 134 L 92 96 Z M176 96 C 176 118 172 128 168 134 L 164 96 Z" fill="${c}"/><path d="M90 82 C 104 66 152 66 166 82 C 150 74 106 74 90 82 Z" fill="${c}" opacity="0.6"/>`;
    case "side": return `<path d="M80 112 C 74 58 182 56 176 112 C 172 90 158 80 140 78 C 120 82 100 86 80 112 Z" fill="${c}"/>`;
    case "curly": return Array.from({ length: 9 }, (_, i) => `<circle cx="${86 + i * 10.5}" cy="${74 - Math.sin((i / 8) * Math.PI) * 14}" r="15" fill="${c}"/>`).join("") + `<circle cx="82" cy="98" r="11" fill="${c}"/><circle cx="174" cy="98" r="11" fill="${c}"/>`;
    case "bun": return `<circle cx="128" cy="52" r="17" fill="${c}"/><path d="M80 112 C 76 60 180 60 176 112 C 168 84 150 74 128 74 C 106 74 88 84 80 112 Z" fill="${c}"/>`;
    case "long": case "ponytail": case "braid":
      return `<path d="M78 120 C 72 60 184 60 178 120 C 172 88 150 74 128 74 C 106 74 86 88 78 120 Z" fill="${c}"/>`;
    default: return `<path d="M80 110 C 76 60 180 60 176 110 C 170 84 150 74 128 74 C 106 74 86 84 80 110 Z" fill="${c}"/>`;
  }
}

function hat(p) {
  const c = p.hatColor;
  if (p.hat === "hardhat") {
    return `<path d="M76 104 C 76 44 180 44 180 104 Z" fill="${c}"/><rect x="121" y="47" width="14" height="57" rx="5" fill="${shade(c, 1.12)}"/>`
      + `<ellipse cx="128" cy="104" rx="64" ry="9" fill="${shade(c, 0.88)}"/><path d="M84 92 C 100 86 156 86 172 92" fill="none" stroke="${shade(c, 0.85)}" stroke-width="2"/>`;
  }
  if (p.hat === "cap") {
    return `<path d="M80 102 C 80 50 176 50 176 102 Z" fill="${c}"/><path d="M96 74 C 106 64 150 64 160 74 L 160 100 L 96 100 Z" fill="#f4f4f2" opacity="0.92"/>`
      + `<path d="M74 103 Q128 88 182 103 Q128 116 74 103 Z" fill="${shade(c, 0.75)}"/><circle cx="128" cy="53" r="4" fill="${shade(c, 0.75)}"/>`;
  }
  if (p.hat === "beanie") {
    return `<path d="M80 100 C 80 48 176 48 176 100 Z" fill="${c}"/><rect x="78" y="88" width="100" height="18" rx="8" fill="${shade(c, 0.85)}"/>`;
  }
  return "";
}

function face(p) {
  const s = SKIN[p.skin];
  const ink = "#2b1d14";
  const browC = p.hat === "hardhat" || p.hat === "cap" || p.hat === "beanie" ? HAIR[p.hairColor] : HAIR[p.hairColor];
  const out = [];
  out.push(`<rect x="110" y="146" width="36" height="46" rx="14" fill="${shade(s, 0.9)}"/>`); // neck
  out.push(`<ellipse cx="80" cy="122" rx="9" ry="13" fill="${shade(s, 0.95)}"/><ellipse cx="176" cy="122" rx="9" ry="13" fill="${shade(s, 0.95)}"/>`); // ears
  out.push(`<ellipse cx="128" cy="118" rx="47" ry="55" fill="${s}"/>`); // head
  out.push(`<path d="M106 106 Q114 101 121 105 M135 105 Q142 101 150 106" fill="none" stroke="${browC}" stroke-width="4" stroke-linecap="round"/>`);
  out.push(`<circle cx="113" cy="119" r="4.6" fill="${ink}"/><circle cx="143" cy="119" r="4.6" fill="${ink}"/>`);
  out.push(`<path d="M128 124 Q124 136 130 138" fill="none" stroke="${shade(s, 0.75)}" stroke-width="3" stroke-linecap="round"/>`);
  if (p.beard === "full") {
    const b = HAIR[p.beardColor ?? p.hairColor];
    out.push(`<path d="M82 118 C 84 172 108 186 128 186 C 148 186 172 172 174 118 C 166 146 146 152 128 152 C 110 152 90 146 82 118 Z" fill="${b}"/>`);
    out.push(`<path d="M116 150 Q128 158 140 150" fill="none" stroke="${shade(b, 1.6)}" stroke-width="3" stroke-linecap="round"/>`);
  } else if (p.beard === "mustache") {
    out.push(`<path d="M112 144 C 120 137 136 137 144 144 C 136 142 120 142 112 144 Z" fill="${HAIR[p.beardColor ?? p.hairColor]}" stroke="${HAIR[p.beardColor ?? p.hairColor]}" stroke-width="4" stroke-linejoin="round"/>`);
    out.push(`<path d="M118 152 Q128 157 138 152" fill="none" stroke="${ink}" stroke-width="3" stroke-linecap="round"/>`);
  } else {
    if (p.beard === "stubble") out.push(`<path d="M86 128 C 90 170 112 178 128 178 C 144 178 166 170 170 128 C 162 152 144 158 128 158 C 112 158 94 152 86 128 Z" fill="${shade(s, 0.78)}" opacity="0.55"/>`);
    out.push(`<path d="M114 146 Q128 157 142 146" fill="none" stroke="${ink}" stroke-width="3.2" stroke-linecap="round"/>`);
  }
  if (p.glasses) out.push(`<g fill="none" stroke="${ink}" stroke-width="3"><rect x="99" y="109" width="27" height="20" rx="7"/><rect x="130" y="109" width="27" height="20" rx="7"/><path d="M126 117 L130 117"/></g>`);
  return out.join("");
}

function headset(p) {
  if (!p.headset) return "";
  return `<path d="M76 118 C 72 52 184 52 180 118" fill="none" stroke="#2b2f36" stroke-width="7"/>`
    + `<rect x="66" y="108" width="18" height="28" rx="7" fill="#2b2f36"/><rect x="172" y="108" width="18" height="28" rx="7" fill="#2b2f36"/>`
    + `<path d="M76 134 C 84 158 100 160 112 156" fill="none" stroke="#2b2f36" stroke-width="4" stroke-linecap="round"/><circle cx="114" cy="155" r="5" fill="#2b2f36"/>`;
}

export function avatarSvg(p, i) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">`
    + `<rect width="256" height="256" fill="${BG[i % BG.length]}"/>`
    + hairBack(p) + top(p) + face(p) + hairFront(p) + hat(p) + headset(p)
    + `</svg>`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  mkdirSync(OUT, { recursive: true });
  const files = PEOPLE.map((p, i) => {
    const name = `avatar-${String(i + 1).padStart(2, "0")}`;
    const svg = avatarSvg(p, i);
    writeFileSync(join(OUT, `${name}.svg`), svg);
    return { name, svg };
  });
  const { chromium } = await import("playwright");
  const browser = await chromium.launch(process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {});
  const page = await browser.newPage({ viewport: { width: 256, height: 256 } });
  for (const f of files) {
    await page.setContent(`<html><body style="margin:0">${f.svg}</body></html>`);
    await page.locator("svg").screenshot({ path: join(OUT, `${f.name}.png`) });
  }
  await browser.close();
  console.log(`Wrote ${files.length} avatars to ${OUT}`);
}
