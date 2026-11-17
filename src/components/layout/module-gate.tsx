import type { ReactNode } from "react";
import Link from "next/link";
import { EyeOff } from "lucide-react";
import { Card, CardBody } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { buttonClasses } from "@/components/ui/button";
import { moduleInfo, type ModuleKey } from "@/lib/modules";
import { can } from "@/lib/permissions";
import { requireAccess } from "@/server/auth";
import { moduleIsOn } from "@/server/modules";

/**
 * Wraps a module's pages (MOD1, docs/MODULES.md): while the company has the module switched off, its pages say so
 * instead of opening, with the way back for someone who manages settings. Nothing is deleted or hidden from the
 * database: switching the module on shows everything again. Permissions are checked by each page as before.
 */
export async function ModuleGate({ module, children }: { module: ModuleKey; children: ReactNode }) {
  if (await moduleIsOn(module)) return <>{children}</>;
  const access = await requireAccess();
  const info = moduleInfo(module);
  const owner = can(access, "settings.manage");
  return (
    <>
      <PageHeader title={info.label} />
      <Card>
        <CardBody className="flex items-start gap-3">
          <EyeOff className="mt-0.5 size-5 shrink-0 text-muted" aria-hidden />
          <div className="space-y-2">
            <p className="font-semibold text-ink">{info.label} is switched off for your company</p>
            <p className="text-sm text-muted">
              {owner
                ? "Your company doesn't use this area right now. Nothing was deleted: switch it back on in Settings and everything is here again."
                : "Your company doesn't use this area right now. Nothing was deleted. Ask the person who manages your company's settings if you need it."}
            </p>
            <div className="flex flex-wrap gap-2 pt-1">
              {owner && <Link href="/settings?tab=company#modules" className={buttonClasses("primary", "md")}>Open What you use</Link>}
              <Link href="/command-center" className={buttonClasses(owner ? "secondary" : "primary", "md")}>Go to Command Center</Link>
            </div>
          </div>
        </CardBody>
      </Card>
    </>
  );
}
