// Illustrated avatars people can choose instead of a photo: trucking and
// aggregate-hauling professionals (public/avatars, original artwork from
// scripts/generate-avatars.mjs). Illustrations, not photographs of real people.
export const AVATAR_KEYS = Array.from({ length: 20 }, (_, i) => `avatar-${String(i + 1).padStart(2, "0")}`);

export const isAvatarKey = (v: string) => AVATAR_KEYS.includes(v);

/** Public URL of an avatar's PNG, or "" for none / an unknown key. */
export const avatarUrl = (key: string | null | undefined) => (key && isAvatarKey(key) ? `/avatars/${key}.png` : "");
