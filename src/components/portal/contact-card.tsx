import { Clock, Mail, Phone } from "lucide-react";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import type { PortalCompany } from "@/lib/portal";

/** The company's own contact details and hours, as it entered them in Settings → Customer Portal. */
export function ContactCard({ company }: { company: Pick<PortalCompany, "name" | "contact_email" | "contact_phone" | "hours"> }) {
  if (!company.contact_email && !company.contact_phone && !company.hours) return null;
  return (
    <Card>
      <CardHeader title={`Contact ${company.name}`} />
      <CardBody className="grid gap-3 text-sm sm:grid-cols-3">
        {company.contact_phone ? (
          <a href={`tel:${company.contact_phone.replace(/[^\d+]/g, "")}`} className="flex items-center gap-2 text-ink hover:underline"><Phone className="size-4 text-muted" aria-hidden />{company.contact_phone}</a>
        ) : null}
        {company.contact_email ? (
          <a href={`mailto:${company.contact_email}`} className="flex items-center gap-2 break-all text-ink hover:underline"><Mail className="size-4 text-muted" aria-hidden />{company.contact_email}</a>
        ) : null}
        {company.hours ? <p className="flex items-start gap-2 whitespace-pre-line text-ink"><Clock className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden />{company.hours}</p> : null}
      </CardBody>
    </Card>
  );
}

