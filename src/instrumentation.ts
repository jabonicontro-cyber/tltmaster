// Server errors go to Sentry when SENTRY_DSN is set (LR4; src/lib/monitoring/sentry.ts). Without it nothing is sent.
import type { Instrumentation } from "next";

export const onRequestError: Instrumentation.onRequestError = async (error, request, context) => {
  if (!process.env.SENTRY_DSN) return;
  const { reportServerError } = await import("@/lib/monitoring/sentry");
  await reportServerError({ error, path: request.path, method: request.method, route: context.routePath, routeType: context.routeType });
};
