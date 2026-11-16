import { Badge } from "@/components/ui/badge";
import { SubmitButton } from "@/components/ui/submit-button";
import { setCompanyPreset } from "@/app/admin/companies/lifecycle-actions";
import { PanelBody, PanelHeader } from "@/components/admin/ui";
import { MODULES, PRESETS, PRESET_KEYS, presetOf } from "@/lib/modules";

export type CompanyModules = { modules_off: string[]; can_set: boolean };

/**
 * Company page → Starting setup (MOD1, docs/MODULES.md): the preset a company starts from. A Taviron Admin picks it while
 * the company is being set up (or for a demo, to show a preset); after go-live only the company's owner changes what it
 * uses, in Settings → What you use. Nothing is deleted either way.
 */
export function StartingSetupCard({ companyId, state }: { companyId: string; state: CompanyModules }) {
  const current = presetOf(state.modules_off);
  const offLabels = MODULES.filter((m) => state.modules_off.includes(m.key)).map((m) => m.label);
  return (
    <section aria-label="Starting setup">
      <PanelHeader
        title="Starting setup"
        description="Which workflows the company starts with. The owner adjusts it any time in Settings → What you use; switching an area off hides it and never deletes anything."
        actions={<Badge tone={current === "full" ? "green" : "gray"}>{current ? PRESETS[current].label : "Owner's own choice"}</Badge>}
      />
      <PanelBody>
        <p className="mb-3 text-sm text-muted">{offLabels.length ? `Switched off: ${offLabels.join(", ")}.` : "Everything is switched on."}</p>
        {state.can_set ? (
          <form action={setCompanyPreset} className="flex flex-wrap items-end gap-3">
            <input type="hidden" name="id" value={companyId} />
            <fieldset className="flex flex-wrap gap-2">
              <legend className="sr-only">Starting point</legend>
              {PRESET_KEYS.map((k) => (
                <label key={k} className="flex cursor-pointer items-start gap-2 rounded-xl border border-line p-3 has-[:checked]:border-strong">
                  <input type="radio" name="preset" value={k} defaultChecked={current === k} className="mt-0.5" required />
                  <span>
                    <span className="block text-sm font-semibold text-ink">{PRESETS[k].label}</span>
                    <span className="block max-w-56 text-xs text-muted">{PRESETS[k].hint}</span>
                  </span>
                </label>
              ))}
            </fieldset>
            <SubmitButton variant="secondary" pendingLabel="Saving…">Use this starting point</SubmitButton>
          </form>
        ) : (
          <p className="text-sm text-muted">This company is live: its owner chooses what it uses in Settings.</p>
        )}
      </PanelBody>
    </section>
  );
}
