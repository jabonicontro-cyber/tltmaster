// Reading the page again after a successful action (walkthrough P9, 2026-11-16).
//
// router.refresh() called inside the action's transition (useTransition / useFormAction) ties that transition to the
// server's new render of the whole page: the buttons stay disabled or spinning, and the screen keeps the old state,
// until the page has been rendered again, which takes seconds on long pages (My Day, a work order) on a busy server.
// Started just after the action instead, the action ends at once (the screen can show what was confirmed) and the
// page's fresh data follows when it arrives. The action's own revalidatePath still applies as before.

/** Ask for the page's fresh data once the current action has finished. */
export function refreshAfterAction(router: { refresh: () => void }): void {
  setTimeout(() => router.refresh(), 0);
}
