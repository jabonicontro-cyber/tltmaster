/** "15:00–16:00" in a notice title as "3:00 PM–4:00 PM", like the load cards (UX15). */
export function twelveHour(text: string): string {
  return text.replace(/\b([01]?\d|2[0-3]):([0-5]\d)\b/g, (_, h: string, m: string) => {
    const hour = Number(h);
    return `${hour % 12 === 0 ? 12 : hour % 12}:${m} ${hour < 12 ? "AM" : "PM"}`;
  });
}
