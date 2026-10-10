// Development-only mail catcher: a minimal SMTP server that stores every
// message Supabase Auth sends (sign-up verification, invitations, password
// resets) as .dev-stack/mail/<time>-<n>.json, so these flows can be tested
// locally without a real mail provider. Never use in production.
import net from "node:net";
import fs from "node:fs";
import path from "node:path";

const port = Number(process.env.MAILBOX_PORT ?? 54325);
const dir = process.env.MAILBOX_DIR ?? path.resolve(".dev-stack/mail");
fs.mkdirSync(dir, { recursive: true });
let n = 0;

function decodeQP(s) {
  return s.replace(/=\r?\n/g, "").replace(/=([0-9A-F]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

function store(from, to, data) {
  const [head, ...rest] = data.split(/\r?\n\r?\n/);
  let body = rest.join("\n\n");
  if (/content-transfer-encoding:\s*quoted-printable/i.test(head)) body = decodeQP(body);
  if (/content-transfer-encoding:\s*base64/i.test(head)) body = Buffer.from(body.replace(/\s+/g, ""), "base64").toString("utf8");
  const subject = (head.match(/^subject:\s*(.*)$/im) ?? [])[1] ?? "";
  const file = path.join(dir, `${Date.now()}-${n++}.json`);
  fs.writeFileSync(file, JSON.stringify({ from, to, subject, body, received_at: new Date().toISOString() }, null, 2));
}

net
  .createServer((socket) => {
    let from = "";
    let to = [];
    let inData = false;
    let buf = "";
    let data = "";
    const say = (line) => socket.write(line + "\r\n");
    say("220 tlt-dev-mailbox ESMTP");
    socket.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      let i;
      while ((i = buf.indexOf("\r\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (inData) {
          if (line === ".") {
            inData = false;
            store(from, to, data);
            data = "";
            say("250 OK stored");
          } else data += (line.startsWith("..") ? line.slice(1) : line) + "\r\n";
          continue;
        }
        const cmd = line.slice(0, 4).toUpperCase();
        if (cmd === "EHLO") { say("250-tlt-dev-mailbox"); say("250-AUTH PLAIN LOGIN"); say("250 8BITMIME"); }
        else if (cmd === "HELO") say("250 tlt-dev-mailbox");
        else if (cmd === "AUTH") say("235 Authentication successful");
        else if (cmd === "MAIL") { from = line.replace(/^MAIL FROM:\s*/i, "").replace(/[<>]/g, ""); to = []; say("250 OK"); }
        else if (cmd === "RCPT") { to.push(line.replace(/^RCPT TO:\s*/i, "").replace(/[<>]/g, "")); say("250 OK"); }
        else if (cmd === "DATA") { inData = true; say("354 End data with <CR><LF>.<CR><LF>"); }
        else if (cmd === "RSET") { from = ""; to = []; say("250 OK"); }
        else if (cmd === "NOOP") say("250 OK");
        else if (cmd === "QUIT") { say("221 Bye"); socket.end(); }
        else say("250 OK");
      }
    });
    socket.on("error", () => {});
  })
  .listen(port, "127.0.0.1", () => console.log(`dev mailbox (SMTP) on 127.0.0.1:${port}, storing in ${dir}`));
