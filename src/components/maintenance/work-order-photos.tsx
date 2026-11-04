"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { PhotoPicker, uploadPhotos } from "@/components/ui/photo-picker";

/**
 * Photos on a work order (UX9): what the driver sent with an inspection defect and what the shop adds. Each opens a
 * one-minute signed link through /maintenance/photos/[id] (the database checks who may see it).
 */
export function WorkOrderPhotos({ workOrderId, photos, canAdd }: { workOrderId: string; photos: string[]; canAdd: boolean }) {
  const router = useRouter();
  const [files, setFiles] = useState<File[]>([]);
  const [busy, start] = useTransition();
  const room = Math.max(0, 8 - photos.length);
  const send = () => start(async () => {
    const failed = await uploadPhotos("/maintenance/photos", { work_order: workOrderId }, files.slice(0, room));
    if (failed) toast.warning(`${failed} photo${failed === 1 ? "" : "s"} could not be sent.`);
    else toast.success(files.length === 1 ? "Photo added." : "Photos added.");
    setFiles([]);
    router.refresh();
  });
  if (!photos.length && !canAdd) return null;
  return (
    <section aria-label="Photos" className="rounded-panel bg-card p-5 shadow-card ring-1 ring-line/60 sm:p-6">
      <h2 className="text-base font-semibold text-ink">Photos</h2>
      {photos.length ? (
        <ul className="mt-3 grid grid-cols-3 gap-2 sm:grid-cols-4">
          {photos.map((p, i) => (
            <li key={p}>
              <a href={`/maintenance/photos/${p}`} target="_blank" rel="noopener noreferrer" className="block aspect-square overflow-hidden rounded-lg border border-line">
                {/* eslint-disable-next-line @next/next/no-img-element -- short-lived signed link */}
                <img src={`/maintenance/photos/${p}`} alt={`Work order photo ${i + 1}`} loading="lazy" className="size-full object-cover" />
              </a>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-1 text-sm text-muted">No photos yet.</p>
      )}
      {canAdd && room > 0 && (
        <div className="mt-3 space-y-2">
          <PhotoPicker id={`wo-photos-${workOrderId}`} label="Add photos" files={files} onChange={setFiles} max={room} />
          {files.length > 0 && <Button size="sm" onClick={send} loading={busy}>Send {files.length} photo{files.length === 1 ? "" : "s"}</Button>}
        </div>
      )}
    </section>
  );
}
