"use client";

import { useEffect } from "react";
import { PRODUCT_NAME } from "@/lib/product";

/**
 * Sets the browser tab title from the client. Only for views that cannot export metadata themselves: a nested
 * not-found page renders after the record page's metadata was sent, so the tab would otherwise keep that page's
 * title ("Order · Taviron"). Metadata streams in (appended to the body), possibly after this effect ran, so the title
 * is re-applied whenever a title element changes while this view is shown.
 */
export function DocumentTitle({ title }: { title: string }) {
  useEffect(() => {
    const wanted = `${title} · ${PRODUCT_NAME}`;
    const apply = () => {
      if (document.title !== wanted) document.title = wanted;
    };
    apply();
    const observer = new MutationObserver(apply);
    observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
    return () => observer.disconnect();
  }, [title]);
  return null;
}
