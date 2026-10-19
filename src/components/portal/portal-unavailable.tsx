/** The whole page when a portal link leads nowhere (wrong slug, portal off, not entitled). Reveals nothing more. */
export function PortalUnavailable() {
  return (
    <div className="mx-auto max-w-md py-12 text-center">
      <h1 className="text-xl font-bold text-ink">This customer portal is not available</h1>
      <p className="mt-2 text-sm text-muted">The link may be wrong, or the portal is not open yet. Contact the company directly.</p>
    </div>
  );
}
