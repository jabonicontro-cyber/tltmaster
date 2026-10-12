// Illustrated avatars people can choose instead of a photo: trucking and
// aggregate-hauling professionals (public/avatars, original artwork from
// scripts/generate-avatars.mjs). Illustrations, not photographs of real people.
export const AVATAR_KEYS = Array.from({ length: 20 }, (_, i) => `avatar-${String(i + 1).padStart(2, "0")}`);

export const isAvatarKey = (v: string) => AVATAR_KEYS.includes(v);

/** Public URL of an avatar's PNG, or "" for none / an unknown key. */
export const avatarUrl = (key: string | null | undefined) => (key && isAvatarKey(key) ? `/avatars/${key}.png` : "");

/**
 * Where a person's picture comes from, in order: their own profile photo (when they have a login and
 * uploaded or chose one), else the illustrated avatar on their employee record, else initials.
 * `photoUpdatedAt` versions the URL so a new photo shows at once.
 */
export function personPhoto(userId: string | null | undefined, photoUpdatedAt: string | null | undefined, avatarKey: string | null | undefined) {
  return {
    src: userId && photoUpdatedAt ? `/people/photo/${userId}?v=${encodeURIComponent(photoUpdatedAt)}` : "",
    fallbackSrc: avatarUrl(avatarKey),
  };
}

/** Photo URL for a linked person given photoVersions(): versioned when known, "" when they have none. */
export function employeePhotoSrc(userId: string | null, versions: Map<string, string> | null): string {
  if (!userId) return "";
  if (versions === null) return `/people/photo/${userId}`; // function not installed: previous behaviour
  const v = versions.get(userId);
  return v ? `/people/photo/${userId}?v=${encodeURIComponent(v)}` : "";
}
