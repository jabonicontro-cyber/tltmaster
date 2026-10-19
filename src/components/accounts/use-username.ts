"use client";

import { useEffect, useRef, useState } from "react";
import { usernameFromName } from "@/lib/accounts";
import { isValidUsername, normalizeUsername } from "@/lib/usernames";

type Availability = { checking: boolean; valid?: boolean; available?: boolean };

/**
 * The username field of a new sign-in: filled in automatically from the person's name with a username the server
 * confirmed is free (base, base2 …), until staff type their own; "Suggest one" goes back to automatic. Every value is
 * checked for availability as it changes, and the database checks it again on create.
 */
export function useUsername({ name, initial = "", initialTouched = false, check, suggest }: {
  name: string;
  initial?: string;
  initialTouched?: boolean;
  check: (username: string) => Promise<{ valid: boolean; available: boolean } | null>;
  suggest: (name: string) => Promise<string | null>;
}) {
  const [username, setUsername] = useState(initial || usernameFromName(name));
  const [touched, setTouched] = useState(initialTouched);
  // The name a suggestion is being fetched for (derived "suggesting", so a superseded request can never stick).
  const [pendingFor, setPendingFor] = useState<string | null>(null);
  const [checked, setChecked] = useState<{ for: string; valid: boolean; available: boolean } | null>(null);
  const checkSeq = useRef(0);
  const suggestSeq = useRef(0);

  // Automatic: a free username for the current name (debounced; ignored once staff typed their own).
  useEffect(() => {
    if (touched || name.trim().length < 2) return;
    const n = ++suggestSeq.current;
    const t = setTimeout(async () => {
      setPendingFor(name);
      const r = await suggest(name).catch(() => null);
      if (n === suggestSeq.current) {
        setPendingFor(null);
        setUsername(r ?? usernameFromName(name));
      }
    }, 400);
    return () => clearTimeout(t);
  }, [name, touched, suggest]);

  const normalized = normalizeUsername(username);
  const wellFormed = Boolean(normalized) && isValidUsername(normalized);
  useEffect(() => {
    if (!wellFormed) return;
    const n = ++checkSeq.current;
    const t = setTimeout(async () => {
      const r = await check(normalized).catch(() => null);
      if (n === checkSeq.current) setChecked(r ? { for: normalized, ...r } : null);
    }, 350);
    return () => clearTimeout(t);
  }, [normalized, wellFormed, check]);

  const availability: Availability = !normalized
    ? { checking: false }
    : !wellFormed
      ? { checking: false, valid: false }
      : checked?.for === normalized
        ? { checking: false, valid: checked.valid, available: checked.available }
        : { checking: true };

  return {
    username,
    normalized,
    availability,
    automatic: !touched,
    suggesting: !touched && pendingFor === name,
    /** Staff typed a username: keep it as typed (lowercase, no spaces). */
    type(value: string) {
      setUsername(value.toLowerCase().replace(/\s/g, ""));
      setTouched(true);
    },
    /** Back to automatic: a free username from the name. */
    suggestAgain() {
      setTouched(false);
      setUsername(usernameFromName(name));
    },
    /** Follow the name immediately (before the server confirms a free one). */
    follow(newName: string) {
      if (!touched) setUsername(usernameFromName(newName));
    },
  };
}
