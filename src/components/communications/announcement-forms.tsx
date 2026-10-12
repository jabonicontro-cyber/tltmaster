"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Megaphone } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ConfirmDialog, Dialog } from "@/components/ui/dialog";
import { Checkbox, Field, FormError, Input, Select, Textarea } from "@/components/ui/form";
import { DEPARTMENTS } from "@/lib/employees";
import { announcementReceipt, editAnnouncement, publishAnnouncement, withdrawAnnouncement } from "@/app/(app)/communications/actions";

export function PublishAnnouncement() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [department, setDepartment] = useState("");
  const [requiresAck, setRequiresAck] = useState(false);
  const [key, setKey] = useState(() => crypto.randomUUID());
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  return (
    <>
      <Button icon={<Megaphone className="size-4" />} onClick={() => { setOpen(true); setError(null); }}>New announcement</Button>
      <Dialog open={open} onOpenChange={setOpen} size="lg" title="New announcement" description="Published inside Taviron only. Nothing is emailed or texted."
        footer={<>
          <Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button>
          <Button loading={pending} onClick={async () => {
            setPending(true); setError(null);
            const r = await publishAnnouncement({ title, body, department: department ? (department as keyof typeof DEPARTMENTS) : null, requiresAck, clientKey: key });
            setPending(false);
            if (!r.ok) return setError(r.error);
            toast.success(r.message ?? "Published.");
            setOpen(false); setTitle(""); setBody(""); setDepartment(""); setRequiresAck(false); setKey(crypto.randomUUID());
            router.push(`/communications/announcements/${r.data.id}`);
          }}>Publish</Button>
        </>}>
        <div className="space-y-4">
          <Field label="Title" htmlFor="an-title" required><Input id="an-title" maxLength={150} value={title} onChange={(e) => setTitle(e.target.value)} /></Field>
          <Field label="Announcement" htmlFor="an-body" required><Textarea id="an-body" rows={8} maxLength={8000} value={body} onChange={(e) => setBody(e.target.value)} /></Field>
          <Field label="Audience" htmlFor="an-dept" hint="A department audience uses the department on each person's employee record.">
            <Select id="an-dept" value={department} onChange={(e) => setDepartment(e.target.value)}>
              <option value="">Everyone in the company</option>
              {Object.entries(DEPARTMENTS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </Select>
          </Field>
          <Checkbox label="Everyone must acknowledge it (creates an alert that stays open until all have)" checked={requiresAck} onChange={(e) => setRequiresAck(e.target.checked)} />
          <FormError message={error} />
        </div>
      </Dialog>
    </>
  );
}

/** Records that the viewer opened the announcement (reading is not acknowledging). */
export function MarkAnnouncementRead({ id }: { id: string }) {
  useEffect(() => { void announcementReceipt({ id, acknowledge: false }); }, [id]);
  return null;
}

export function AcknowledgeAnnouncement({ id }: { id: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  return (
    <Button loading={pending} onClick={async () => {
      setPending(true);
      const r = await announcementReceipt({ id, acknowledge: true });
      setPending(false);
      if (!r.ok) return toast.error(r.error);
      toast.success(r.message ?? "Acknowledged.");
      router.refresh();
    }}>I have read and understood this</Button>
  );
}

export function ManageAnnouncement({ id, title, body }: { id: string; title: string; body: string }) {
  const router = useRouter();
  const [mode, setMode] = useState<"edit" | "withdraw" | null>(null);
  const [t, setT] = useState(title);
  const [b, setB] = useState(body);
  return (
    <div className="flex gap-2">
      <Button variant="secondary" onClick={() => { setT(title); setB(body); setMode("edit"); }}>Edit</Button>
      <Button variant="danger" onClick={() => setMode("withdraw")}>Withdraw</Button>
      <ConfirmDialog
        open={mode !== null}
        onOpenChange={(o) => !o && setMode(null)}
        title={mode === "edit" ? "Edit announcement" : "Withdraw this announcement?"}
        description={mode === "edit" ? "The earlier version is kept in the history." : "People will no longer see it. The record is kept."}
        confirmLabel={mode === "edit" ? "Save" : "Withdraw"}
        tone={mode === "edit" ? "primary" : "danger"}
        onConfirm={async () => {
          const r = mode === "edit" ? await editAnnouncement({ id, title: t, body: b }) : await withdrawAnnouncement(id);
          if (!r.ok) return r.error;
          toast.success(r.message ?? "Saved.");
          setMode(null);
          router.refresh();
        }}
      >
        {mode === "edit" && (
          <div className="space-y-3">
            <Field label="Title" htmlFor="ane-title"><Input id="ane-title" maxLength={150} value={t} onChange={(e) => setT(e.target.value)} /></Field>
            <Field label="Announcement" htmlFor="ane-body"><Textarea id="ane-body" rows={8} maxLength={8000} value={b} onChange={(e) => setB(e.target.value)} /></Field>
          </div>
        )}
      </ConfirmDialog>
    </div>
  );
}
