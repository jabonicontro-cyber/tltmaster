import "server-only";
import { once } from "node:events";
import { crc32, createDeflateRaw } from "node:zlib";

// A small streaming ZIP writer (PKWARE APPNOTE 6.3, no ZIP64) for the data download: entries are written one after
// another and never held together in memory. Spreadsheets are deflated while they stream (sizes and checksum follow in
// a data descriptor); photos and documents are already compressed and are stored as they are. A zip stays under 4 GB:
// the caller checks `size` before adding a file.

export const ZIP_LIMIT = 3_900_000_000;

type Entry = { name: Buffer; crc: number; csize: number; usize: number; method: number; flags: number; offset: number; time: number; date: number };

function dosTime(d: Date): { time: number; date: number } {
  const year = Math.max(1980, d.getUTCFullYear());
  return {
    time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | Math.floor(d.getUTCSeconds() / 2),
    date: ((year - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate(),
  };
}

const UTF8 = 0x0800;
const DESCRIPTOR = 0x0008;

export class ZipWriter {
  private entries: Entry[] = [];
  private offset = 0;

  /** Bytes written so far. */
  get size(): number {
    return this.offset;
  }

  private header(e: Entry, crc: number, csize: number, usize: number): Buffer {
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0);
    h.writeUInt16LE(20, 4);
    h.writeUInt16LE(e.flags, 6);
    h.writeUInt16LE(e.method, 8);
    h.writeUInt16LE(e.time, 10);
    h.writeUInt16LE(e.date, 12);
    h.writeUInt32LE(crc >>> 0, 14);
    h.writeUInt32LE(csize, 18);
    h.writeUInt32LE(usize, 22);
    h.writeUInt16LE(e.name.length, 26);
    h.writeUInt16LE(0, 28);
    return Buffer.concat([h, e.name]);
  }

  private emit(b: Uint8Array): Uint8Array {
    this.offset += b.length;
    return b;
  }

  /** A file already in memory, stored without compression (photos, PDFs). */
  *stored(name: string, data: Uint8Array, when = new Date()): Generator<Uint8Array> {
    const { time, date } = dosTime(when);
    const crc = crc32(data);
    const e: Entry = { name: Buffer.from(name, "utf8"), crc, csize: data.length, usize: data.length, method: 0, flags: UTF8, offset: this.offset, time, date };
    yield this.emit(this.header(e, crc, data.length, data.length));
    yield this.emit(data);
    this.entries.push(e);
  }

  /** A file produced piece by piece (a spreadsheet read page by page), deflated as it streams. */
  async *deflated(name: string, pieces: AsyncIterable<string | Uint8Array>, when = new Date()): AsyncGenerator<Uint8Array> {
    const { time, date } = dosTime(when);
    const e: Entry = { name: Buffer.from(name, "utf8"), crc: 0, csize: 0, usize: 0, method: 8, flags: UTF8 | DESCRIPTOR, offset: this.offset, time, date };
    yield this.emit(this.header(e, 0, 0, 0));
    const deflate = createDeflateRaw();
    let crc = 0;
    let usize = 0;
    let failure: unknown = null;
    const feeding = (async () => {
      try {
        for await (const piece of pieces) {
          const buf = typeof piece === "string" ? Buffer.from(piece, "utf8") : piece;
          if (!buf.length) continue;
          crc = crc32(buf, crc);
          usize += buf.length;
          if (!deflate.write(buf)) await once(deflate, "drain");
        }
      } catch (err) {
        failure = err;
      } finally {
        deflate.end();
      }
    })();
    let csize = 0;
    for await (const out of deflate) {
      csize += (out as Buffer).length;
      yield this.emit(out as Buffer);
    }
    await feeding;
    if (failure) throw failure;
    e.crc = crc;
    e.csize = csize;
    e.usize = usize;
    const d = Buffer.alloc(16);
    d.writeUInt32LE(0x08074b50, 0);
    d.writeUInt32LE(crc >>> 0, 4);
    d.writeUInt32LE(csize, 8);
    d.writeUInt32LE(usize, 12);
    yield this.emit(d);
    this.entries.push(e);
  }

  /** The central directory and its end record: the zip is complete after this. */
  *finish(): Generator<Uint8Array> {
    const start = this.offset;
    for (const e of this.entries) {
      const c = Buffer.alloc(46);
      c.writeUInt32LE(0x02014b50, 0);
      c.writeUInt16LE(20, 4);
      c.writeUInt16LE(20, 6);
      c.writeUInt16LE(e.flags, 8);
      c.writeUInt16LE(e.method, 10);
      c.writeUInt16LE(e.time, 12);
      c.writeUInt16LE(e.date, 14);
      c.writeUInt32LE(e.crc >>> 0, 16);
      c.writeUInt32LE(e.csize, 20);
      c.writeUInt32LE(e.usize, 24);
      c.writeUInt16LE(e.name.length, 28);
      c.writeUInt32LE(e.offset, 42);
      yield this.emit(Buffer.concat([c, e.name]));
    }
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(this.entries.length, 8);
    end.writeUInt16LE(this.entries.length, 10);
    end.writeUInt32LE(this.offset - start, 12);
    end.writeUInt32LE(start, 16);
    yield this.emit(end);
  }
}

/** An async sequence of byte chunks as a web stream (pulled: nothing is produced faster than the browser reads). */
export function toStream(chunks: AsyncIterable<Uint8Array>): ReadableStream<Uint8Array> {
  const it = chunks[Symbol.asyncIterator]();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done } = await it.next();
        if (done) controller.close();
        else controller.enqueue(value);
      } catch (err) {
        controller.error(err);
      }
    },
    async cancel() {
      await it.return?.();
    },
  });
}
