import { LoadingState } from "@/components/ui/states";

// Planning checks every truck, trailer and driver against every open load; say what is happening while it runs.
export default function Loading() {
  return <LoadingState label="Planning the day — checking every truck, trailer and driver against the hard rules…" />;
}
