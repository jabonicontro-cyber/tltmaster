import { Field, Select } from "@/components/ui/form";

export type BaseOption = { id: string; name: string; code: string };

/**
 * "Dispatch base" picker for trucks, trailers and drivers. Shown only when the company has more than one active base;
 * otherwise the database puts new records at the default base and nothing changes for single-base companies.
 */
export function BaseField({ bases, defaultValue, className }: { bases?: BaseOption[]; defaultValue?: string | null; className?: string }) {
  if (!bases || bases.length < 2) return null;
  return (
    <Field label="Dispatch base" htmlFor="base_id" className={className} hint="Where it is dispatched from. People limited to other bases will not see it.">
      <Select id="base_id" name="base_id" defaultValue={defaultValue ?? bases[0].id}>
        {bases.map((b) => (
          <option key={b.id} value={b.id}>
            {b.name} ({b.code})
          </option>
        ))}
      </Select>
    </Field>
  );
}
