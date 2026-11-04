/** Navigation links for drivers (UX7): opens the phone's maps app with directions to the place. */

export type LoadPickup = { name: string; kind: string; address: string; latitude: number | string | null; longitude: number | string | null };

/** A directions link: by coordinates when the place has them (exact), otherwise by address. Null when neither is known. */
export function directionsUrl(place: { address?: string | null; latitude?: number | string | null; longitude?: number | string | null }): string | null {
  const lat = place.latitude === null || place.latitude === undefined || place.latitude === "" ? NaN : Number(place.latitude);
  const lng = place.longitude === null || place.longitude === undefined || place.longitude === "" ? NaN : Number(place.longitude);
  const valid = Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && !(lat === 0 && lng === 0);
  const destination = valid ? `${lat},${lng}` : (place.address ?? "").trim();
  if (!destination) return null;
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(destination)}`;
}

/** A tel: link with only the characters a dialer uses; null when there are too few digits to be a number. */
export function telUrl(phone: string | null | undefined): string | null {
  const cleaned = (phone ?? "").replace(/[^\d+]/g, "");
  return cleaned.replace(/\D/g, "").length >= 7 ? `tel:${cleaned}` : null;
}
