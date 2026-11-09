import { notFound } from "next/navigation";

/** Any other address under a portal (a mistyped link) gets the portal's own "not available" page, in the portal shell. */
export default function PortalUnknownPage(): never {
  notFound();
}
