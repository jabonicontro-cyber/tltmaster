import "server-only";
import { capability } from "@/lib/ai/capabilities";
import { READING_JSON_SCHEMA, TICKET_READING_INSTRUCTIONS, checkReading, type TicketReading } from "@/lib/ai/ticket-reading";
import type { CapabilityRequest } from "./run";
import type { ImageMediaType } from "./types";

// "Read a ticket photo" as a capability request (docs/AI.md §17): one photo, no tools, a strict schema. The photo is
// the only content sent besides the instructions; ticket values, names and ids stay on the server.

export function ticketReadingRequest(image: { mediaType: ImageMediaType; base64: string }): CapabilityRequest<null, TicketReading> {
  return {
    capability: capability("ticket_reading"),
    instructions: TICKET_READING_INSTRUCTIONS,
    input: "Read this delivery ticket photo.",
    images: [image],
    output: { name: "ticket_reading", schema: READING_JSON_SCHEMA as unknown as Record<string, unknown> },
    tools: [],
    secrets: [],
    maxOutputTokens: 400,
    validate: (raw) => {
      const r = checkReading(raw);
      return r.ok ? { ok: true, value: r.value } : { ok: false, detail: r.findings.map((f) => f.detail).join(" ") };
    },
  };
}
