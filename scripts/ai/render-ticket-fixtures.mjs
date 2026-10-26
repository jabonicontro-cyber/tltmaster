// Renders the fictional ticket images for the "Read a ticket photo" evaluation (src/lib/ai/ticket-reading.ts,
// TICKET_EVAL_CASES) into tests/fixtures/ai-tickets/. Everything printed is invented. Re-run after changing a case and
// bump the capability's evalVersion. Usage: node scripts/ai/render-ticket-fixtures.mjs
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

const out = resolve("tests/fixtures/ai-tickets");
mkdirSync(out, { recursive: true });

const page = (body) => `<!doctype html><html><head><style>
  body { margin: 0; background: #e7e2d6; font-family: "Courier New", monospace; }
  .t { width: 560px; margin: 24px; padding: 22px 26px; background: #fbf8ef; border: 1px solid #c9c2ad; transform: rotate(-1.2deg); box-shadow: 0 4px 14px rgb(0 0 0 / .18); color: #222; }
  h1 { font-size: 20px; margin: 0 0 2px; letter-spacing: .04em; } .sub { font-size: 12px; margin-bottom: 14px; }
  table { width: 100%; border-collapse: collapse; font-size: 15px; } td { padding: 5px 4px; border-bottom: 1px dotted #b8b09a; } td:first-child { width: 44%; color: #555; }
  .hand { font-family: "Comic Sans MS", cursive; color: #1d3c8f; font-size: 18px; } .smudge { filter: blur(4.5px); opacity: .8; }
  .sig { margin-top: 18px; font-size: 12px; color: #555; }
</style></head><body>${body}</body></html>`;

const rows = (r) => `<table>${r.map(([k, v, cls = ""]) => `<tr><td>${k}</td><td class="${cls}">${v}</td></tr>`).join("")}</table>`;

const FIXTURES = {
  "scale-ticket.png": page(`<div class="t"><h1>RIVERBEND AGGREGATE - SCALE HOUSE</h1><div class="sub">Pit 2 · Inbound/Outbound weighing · Customer copy</div>${rows([
    ["Ticket No.", "SC-204518"], ["Date", "09/14/2026"], ["Time out", "10:42"], ["Truck", "T-27"], ["Customer", "Demo Customer A"], ["Product", "3/4 Clean Rock"],
    ["Gross", "36.44 TN"], ["Tare", "15.08 TN"], ["Net", "21.36 TN"],
  ])}<div class="sig">Weighmaster: ______________ (fictional)</div></div>`),
  "load-ticket.png": page(`<div class="t"><h1>DELIVERY TICKET</h1><div class="sub">Haul / count ticket · Fictional sample</div>${rows([
    ["Ticket #", "88031"], ["Date", "Sept 15, 2026"], ["Truck / unit", "112"], ["Material", "Fill Dirt"], ["Quantity", "1 Load", "hand"], ["Job", "Sample Job 14"],
  ])}<div class="sig">Received by: ______________</div></div>`),
  "smudged-date.png": page(`<div class="t"><h1>RIVERBEND AGGREGATE - SCALE HOUSE</h1><div class="sub">Pit 2 · Customer copy</div>${rows([
    ["Ticket No.", "SC-204777"], ["Date", "09/1?/2026", "smudge"], ["Truck", "T-31"], ["Product", "Class 5 Base"],
    ["Gross", "34.12 TN"], ["Tare", "15.22 TN"], ["Net", "18.90 TN"],
  ])}</div>`),
  "no-number.png": page(`<div class="t"><h1>YARD DELIVERY SLIP</h1><div class="sub">Fictional sample · no ticket number on this form</div>${rows([
    ["Date", "2026-09-16"], ["Truck", "45"], ["Material", "Washed Sand"], ["Quantity", "12 yd", "hand"], ["Notes", "Dumped at north stockpile"],
  ])}</div>`),
  "not-a-ticket.png": `<!doctype html><html><body style="margin:0;width:608px;height:420px;background:linear-gradient(135deg,#9aa49a,#5f6b63);"><div style="position:absolute;left:180px;top:150px;width:240px;height:120px;border-radius:60px;background:#3d4741;opacity:.6"></div></body></html>`,
};

const browser = await chromium.launch(process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {});
const p = await browser.newPage({ viewport: { width: 650, height: 470 }, deviceScaleFactor: 1.5 });
for (const [name, html] of Object.entries(FIXTURES)) {
  await p.setContent(html);
  await p.screenshot({ path: `${out}/${name}` });
  console.log("wrote", name);
}
await browser.close();
