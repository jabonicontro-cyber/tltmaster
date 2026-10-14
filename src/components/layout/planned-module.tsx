import type { ReactNode } from "react";
import { Construction } from "lucide-react";
import { Card, CardBody } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";

/**
 * Honest placeholder for modules scheduled in later phases. It explains what
 * the module will do and what it depends on; it has no buttons that pretend
 * to work.
 */
export function PlannedModule({ title, phase, summary, features, dependsOn }: { title: string; phase: string; summary: ReactNode; features: string[]; dependsOn?: ReactNode }) {
  return (
    <>
      <PageHeader title={title} description={summary} />
      <Card>
        <CardBody className="space-y-4">
          <div className="flex items-start gap-3 rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-amber-950">
            <Construction className="mt-0.5 size-5 shrink-0" aria-hidden />
            <div>
              <p className="font-semibold">Coming soon — scheduled for {phase}</p>
              <p className="text-sm">Nothing on this page is live. No data is shown or changed here.</p>
            </div>
          </div>
          <div>
            <h2 className="mb-2 text-[15px] font-semibold text-ink">What it will do</h2>
            <ul className="list-disc space-y-1 pl-5 text-[15px]">
              {features.map((f) => (
                <li key={f}>{f}</li>
              ))}
            </ul>
          </div>
          {dependsOn && (
            <div>
              <h2 className="mb-1 text-[15px] font-semibold text-ink">Depends on</h2>
              <div className="text-[15px]">{dependsOn}</div>
            </div>
          )}
        </CardBody>
      </Card>
    </>
  );
}
