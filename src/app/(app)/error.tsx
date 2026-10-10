"use client";

import { Button } from "@/components/ui/button";
import { ErrorState } from "@/components/ui/states";

export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <ErrorState
      title="This page could not be loaded"
      description={
        <>
          The server could not complete the request. Nothing was changed. Try again; if the problem continues, contact your administrator
          {error.digest ? ` and mention reference ${error.digest}` : ""}.
        </>
      }
      action={<Button onClick={reset}>Try again</Button>}
    />
  );
}
