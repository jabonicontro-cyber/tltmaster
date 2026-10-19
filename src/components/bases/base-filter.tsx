import { FilterSelect } from "@/components/ui/filter-bar";
import type { BaseOption } from "./base-field";

/** "Base" filter for lists; shown only when the company has two or more active bases. */
export function BaseFilter({ bases, value }: { bases?: BaseOption[]; value?: string }) {
  if (!bases || bases.length < 2) return null;
  return <FilterSelect name="base" label="Base" value={value} options={[{ value: "", label: "All bases" }, ...bases.map((b) => ({ value: b.id, label: b.name }))]} />;
}
