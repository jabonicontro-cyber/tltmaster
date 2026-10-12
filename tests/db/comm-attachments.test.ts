// Communications attachments at the database layer: reserving a path, the
// storage.objects policies (insert only at the reserved path, read only files of
// messages the caller may read), confirmation, sending with files, history rules
// for members who join or leave, deletion, and tenancy.
// Needs the Supabase Storage schema (scripts/dev-stack: DEV_STORAGE=1).
import { createHash, randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { pgError, pool, withSession, type Session } from "./helpers";

afterAll(() => pool.end());

const hasStorage = (await pool.query("select to_regclass('storage.objects') is not null as ok")).rows[0].ok as boolean;
if (!hasStorage) console.warn("Supabase Storage is not installed in this database: communications attachment tests are skipped.");

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const begin = async (s: Session, conv: string, name = "photo.jpg", mime = "image/jpeg", size = 2048, key = randomUUID()) =>
  (await s.query<{ r: { attachment_id: string; object_path: string; status: string } }>(
    "select public.comm_begin_attachment($1, $2, $3, $4, $5, $6) as r", [conv, key, name, mime, size, sha(key)])).rows[0].r;
const putObject = (s: Session, path: string, size = 2048, mime = "image/jpeg") =>
  s.query("insert into storage.objects (bucket_id, name, owner_id, metadata) values ('comm-attachments', $1, auth.uid()::text, $2::jsonb)", [path, JSON.stringify({ size, mimetype: mime })]);
const confirm = (s: Session, id: string) => s.query("select public.comm_confirm_attachment($1)", [id]);
const sendFiles = async (s: Session, conv: string, body: string, ids: string[], key: string | null = null) =>
  (await s.query<{ r: { id: string; duplicate: boolean } }>("select public.comm_send_files($1, $2, null, $3, $4::uuid[]) as r", [conv, body, key, ids])).rows[0].r;
const canSeeObject = async (s: Session, path: string) => (await s.query("select 1 from storage.objects where bucket_id = 'comm-attachments' and name = $1", [path])).rowCount === 1;
const canSeeRow = async (s: Session, id: string) => (await s.query("select 1 from public.message_attachments where id = $1", [id])).rowCount === 1;

async function uploaded(s: Session, conv: string, name = "photo.jpg") {
  const r = await begin(s, conv, name);
  await putObject(s, r.object_path);
  await confirm(s, r.attachment_id);
  return r;
}

async function group(s: Session) {
  const a = await s.createUser("dispatcher");
  const b = await s.createUser("office");
  const c = await s.createUser("mechanic");
  await s.as(a);
  const g = (await s.query<{ id: string }>("select public.comm_create_group('Yard', $1::uuid[]) as id", [[b]])).rows[0].id;
  return { a, b, c, g };
}

describe.skipIf(!hasStorage)("communications attachments", () => {
  it("reserve, upload only to the reserved path, confirm, and send; members read, others never", async () => {
    await withSession(async (s) => {
      const { a, b, c, g } = await group(s);
      await s.as(a);
      const key = randomUUID();
      const r = await begin(s, g, "gate code.jpg", "image/jpeg", 2048, key);
      expect(r.object_path).toMatch(new RegExp(`^[0-9a-f-]{36}/comm-attachments/${r.attachment_id}\\.jpg$`));
      expect(await begin(s, g, "gate code.jpg", "image/jpeg", 2048, key)).toEqual(r); // idempotent
      expect((await pgError(begin(s, g, "x.gif", "image/gif"))).message).toMatch(/JPEG, PNG, WebP images or PDF/);
      expect((await pgError(begin(s, g, "big.pdf", "application/pdf", 11 * 1024 * 1024))).message).toMatch(/10 MB/);
      // Not at another path, not before reserving.
      expect((await pgError(putObject(s, r.object_path.replace(r.attachment_id, randomUUID())))).code).toBe("42501");
      expect((await pgError(confirm(s, r.attachment_id))).message).toMatch(/did not arrive/);
      await putObject(s, r.object_path);
      await confirm(s, r.attachment_id);
      // A non-member cannot reserve in the conversation.
      await s.as(c);
      expect((await pgError(begin(s, g))).code).toBe("42501");

      await s.as(a);
      const m = await sendFiles(s, g, "", [r.attachment_id], randomUUID());
      const body = (await s.query<{ body: string }>("select body from public.messages where id = $1", [m.id])).rows[0].body;
      expect(body).toBe("Shared a file: gate code.jpg");
      await s.as(b);
      expect(await canSeeRow(s, r.attachment_id)).toBe(true);
      expect(await canSeeObject(s, r.object_path)).toBe(true);
      await s.as(c);
      expect(await canSeeRow(s, r.attachment_id)).toBe(false);
      expect(await canSeeObject(s, r.object_path)).toBe(false);
      // Nobody can delete or replace a stored file.
      await s.as(a);
      await pgError(s.query("delete from storage.objects where bucket_id = 'comm-attachments' and name = $1", [r.object_path]));
      await s.query("update storage.objects set metadata = '{}'::jsonb where bucket_id = 'comm-attachments' and name = $1", [r.object_path]);
      await s.asAdmin();
      expect((await s.query("select metadata ->> 'size' as size from storage.objects where bucket_id = 'comm-attachments' and name = $1", [r.object_path])).rows[0].size).toBe("2048");
    });
  });

  it("files follow message history rules: new members without shared history and removed members lose access", async () => {
    await withSession(async (s) => {
      const { a, b, c, g } = await group(s);
      await s.as(a);
      const r = await uploaded(s, g, "site plan.jpg");
      await sendFiles(s, g, "Site plan", [r.attachment_id]);
      await s.query("select public.comm_add_members($1, $2::uuid[], false)", [g, [c]]);
      await s.as(c);
      expect(await canSeeRow(s, r.attachment_id)).toBe(false);
      expect(await canSeeObject(s, r.object_path)).toBe(false);
      // Removed member: keeps history up to removal (the file was sent before).
      await s.as(a);
      await s.query("select public.comm_remove_member($1, $2, 'Moved crews')", [g, b]);
      const later = await uploaded(s, g, "later.jpg");
      await sendFiles(s, g, "After", [later.attachment_id]);
      await s.as(b);
      expect(await canSeeRow(s, r.attachment_id)).toBe(true);
      expect(await canSeeRow(s, later.attachment_id)).toBe(false);
      expect((await pgError(begin(s, g))).code).toBe("42501");
    });
  });

  it("a file belongs to its uploader, its conversation, and is attached once; deleted messages hide their files", async () => {
    await withSession(async (s) => {
      const { a, b, g } = await group(s);
      await s.as(a);
      const r = await uploaded(s, g);
      const other = (await s.query<{ id: string }>("select public.comm_open_direct($1) as id", [b])).rows[0].id;
      expect((await pgError(sendFiles(s, other, "Wrong place", [r.attachment_id]))).message).toMatch(/not ready/);
      await s.as(b);
      expect((await pgError(sendFiles(s, g, "Not mine", [r.attachment_id]))).message).toMatch(/not ready/);
      await s.as(a);
      const key = randomUUID();
      const m = await sendFiles(s, g, "Mine", [r.attachment_id], key);
      expect((await sendFiles(s, g, "Mine", [r.attachment_id], key)).duplicate).toBe(true); // double submit
      expect((await pgError(sendFiles(s, g, "Again", [r.attachment_id]))).message).toMatch(/not ready/);
      await s.query("select public.comm_delete_message($1)", [m.id]);
      await s.as(b);
      expect(await canSeeRow(s, r.attachment_id)).toBe(false);
      expect(await canSeeObject(s, r.object_path)).toBe(false);
    });
  });

  it("another company cannot reserve, read or send files in a conversation", async () => {
    await withSession(async (s) => {
      const { a, g } = await group(s);
      await s.as(a);
      const r = await uploaded(s, g);
      await sendFiles(s, g, "Ours", [r.attachment_id]);
      const other = await s.createCompany(`Other ${Math.random().toString(36).slice(2, 6)}`);
      const outsider = await s.createUser("owner", { companyId: other });
      await s.as(outsider);
      expect((await pgError(begin(s, g))).code).toBe("P0002");
      expect(await canSeeRow(s, r.attachment_id)).toBe(false);
      expect(await canSeeObject(s, r.object_path)).toBe(false);
      expect((await pgError(putObject(s, `${other}/comm-attachments/${randomUUID()}.jpg`))).code).toBe("42501");
    });
  });
});
