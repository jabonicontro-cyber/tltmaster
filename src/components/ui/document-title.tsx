"use client";

import { useEffect } from "react";
import { PRODUCT_NAME } from "@/lib/product";

/**
 * Sets the browser tab title from the client. Only for views that cannot export metadata themselves: a nested
 * not-found page renders after the record page's metadata was sent, so the tab would otherwise keep that page's
 * title ("Order · Taviron").
 */
export function DocumentTitle({ title }: { title: string }) {
  useEffect(() => {
    document.title = `${title} · ${PRODUCT_NAME}`;
  }, [title]);
  return null;
}
