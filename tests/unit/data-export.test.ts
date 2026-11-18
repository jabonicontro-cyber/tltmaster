import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, inflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { EXPORT_SHEETS, csvRows, exportCell, exportFolder, extensionOf, filesParts, parsePart, readme, safeName } from "@/lib/data-export";
import { ZipWriter } from "@/server/data-export/zip";

// Download all your data (EX1): what the zip holds and how it is written. The database rules are in
// tests/db/data-export.test.ts; the download itself in tests/e2e/data-export.spec.ts.

/** Read a zip back through its central directory, checking each entry's checksum. */
function unzip(buf: Buffer): Map<string, Buffer> {
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  const out = new Map<string, Buffer>();
  for (let i = 0; i < count; i++) {
    expect(buf.readUInt32LE(p)).toBe(0x02014b50);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const offset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    const start = offset + 30 + buf.readUInt16LE(offset + 26) + buf.readUInt16LE(offset + 28);
    const raw = buf.subarray(start, start + csize);
    const data = method === 8 ? inflateRawSync(raw) : Buffer.from(raw);
    expect(crc32(data) >>> 0, name).toBe(crc);
    out.set(name, data);
    p += 46 + nameLen;
  }
  return out;
}

async function collect(gen: AsyncIterable<Uint8Array> | Iterable<Uint8Array>): Promise<Buffer> {
  const parts: Uint8Array[] = [];
  for await (const c of gen) parts.push(c);
  return Buffer.concat(parts);
}

describe("data export helpers", () => {
  it("accepts only the spreadsheets or a numbered files part", () => {
    expect(parsePart("spreadsheets")).toEqual({ kind: "spreadsheets" });
    expect(parsePart("files-3")).toEqual({ kind: "files", n: 3 });
    for (const bad of ["files-0", "files-", "files-1x", "everything", "", null, "../spreadsheets"]) expect(parsePart(bad)).toBeNull();
    expect(filesParts(0)).toBe(0);
    expect(filesParts(200)).toBe(1);
    expect(filesParts(201)).toBe(2);
  });

  it("writes cells a spreadsheet can never run as a formula, and lists and details as text", () => {
    expect(exportCell("=HYPERLINK(\"x\")")).toBe("\"'=HYPERLINK(\"\"x\"\")\"");
    expect(exportCell("+1 555")).toBe("'+1 555");
    expect(exportCell("@SUM(A1)")).toBe("'@SUM(A1)");
    expect(exportCell(-12.5)).toBe("-12.5");
    expect(exportCell(null)).toBe("");
    expect(exportCell(true)).toBe("true");
    expect(exportCell(["a", "b"])).toBe("\"[\"\"a\"\",\"\"b\"\"]\"");
    expect(csvRows(["id", "name"], [{ id: "1", name: "Line\nbreak" }, { id: "2" }])).toBe("1,\"Line\nbreak\"\r\n2,\r\n");
  });

  it("names files safely: no folders, no dots climbing out, never empty", () => {
    expect(safeName("../../etc/passwd")).toBe("etc-passwd");
    expect(safeName("T-1042 / scale")).toBe("T-1042-scale");
    expect(safeName("....")).toBe("file");
    expect(safeName("")).toBe("file");
    expect(extensionOf("c/orders/x.PDF")).toBe(".pdf");
    expect(extensionOf("c/orders/x")).toBe("");
    expect(exportFolder("Northfield Aggregates (Demo)", "2026-11-17")).toBe("Northfield-Aggregates-Demo-data-2026-11-17".toLowerCase());
  });

  it("lists every spreadsheet once in the README", () => {
    const text = readme("Demo Co", "2026-11-17", { customers: 3 });
    for (const s of EXPORT_SHEETS) expect(text).toContain(s.file);
    expect(text).toContain("(3)");
    expect(new Set(EXPORT_SHEETS.map((s) => s.file)).size).toBe(EXPORT_SHEETS.length);
    expect(text).not.toMatch(/—/);
  });
});

describe("zip writer", () => {
  it("writes stored and streamed, deflated entries that read back exactly", async () => {
    const zip = new ZipWriter();
    const photo = Buffer.from(Array.from({ length: 5000 }, (_, i) => (i * 7) % 256));
    async function* pages() {
      yield "id,name\r\n";
      for (let i = 0; i < 3000; i++) yield `${i},Customer ${i}\r\n`;
    }
    const bytes = await collect((async function* () {
      yield* zip.stored("folder/ticket-photos/ticket-1.jpg", photo, new Date("2026-11-17T12:00:00Z"));
      yield* zip.deflated("folder/customers.csv", pages());
      yield* zip.deflated("folder/empty.csv", (async function* () {})());
      yield* zip.finish();
    })());
    expect(zip.size).toBe(bytes.length);
    const files = unzip(bytes);
    expect([...files.keys()]).toEqual(["folder/ticket-photos/ticket-1.jpg", "folder/customers.csv", "folder/empty.csv"]);
    expect(files.get("folder/ticket-photos/ticket-1.jpg")!.equals(photo)).toBe(true);
    const csv = files.get("folder/customers.csv")!.toString("utf8");
    expect(csv.split("\r\n")).toHaveLength(3002);
    expect(csv.startsWith("id,name\r\n0,Customer 0\r\n")).toBe(true);
    expect(files.get("folder/empty.csv")!.length).toBe(0);
    // A standard unzip tool reads it too (where one is installed).
    if (existsSync("/usr/bin/unzip")) {
      const file = join(mkdtempSync(join(tmpdir(), "zip-")), "t.zip");
      writeFileSync(file, bytes);
      expect(execFileSync("/usr/bin/unzip", ["-t", file]).toString()).toMatch(/No errors detected/);
    }
  });
});
