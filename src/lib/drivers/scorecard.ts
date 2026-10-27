// Driver scorecard (master plan B96): rows come from public.driver_scorecard, measured only from records. Shares are
// shown only with enough behind them, and never ranked (owner 2026-10-27: no leaderboard).

export interface ScoreRow {
  driver_id: string;
  driver_name: string;
  loads: number;
  on_time: number;
  own_tickets: number;
  same_day: number;
  reports: number;
}

/** A share as a whole percent, or null with fewer than three behind it (one late load should not read as 50%). */
export function share(part: number, whole: number, min = 3): number | null {
  return whole >= min ? Math.round((part / whole) * 100) : null;
}

export const SCORECARD_DAYS = 30;
