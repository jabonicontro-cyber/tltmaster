// Generates a random JWT secret plus anon / service_role keys signed with it
// (the same shape Supabase uses). Development / CI only.
import crypto from "node:crypto";

const b64url = (buf) => Buffer.from(buf).toString("base64url");

function sign(payload, secret) {
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64url(JSON.stringify(payload));
  const sig = crypto.createHmac("sha256", secret).update(`${header}.${body}`).digest("base64url");
  return `${header}.${body}.${sig}`;
}

const secret = process.argv[2] || crypto.randomBytes(32).toString("hex");
const iat = Math.floor(Date.now() / 1000);
const exp = iat + 60 * 60 * 24 * 365 * 5;

console.log(`DEV_JWT_SECRET=${secret}`);
console.log(`DEV_ANON_KEY=${sign({ iss: "supabase", role: "anon", iat, exp }, secret)}`);
console.log(`DEV_SERVICE_ROLE_KEY=${sign({ iss: "supabase", role: "service_role", iat, exp }, secret)}`);
