import { describe, expect, it } from "vitest";
import { articlesForPath, routeScore, searchArticles, visibleArticles } from "@/lib/help/search";
import type { HelpArticle } from "@/lib/help/types";

const art = (id: string, over: Partial<HelpArticle> = {}): HelpArticle => ({
  id, title: id, summary: "", category: "dispatch", routes: [], permissions: [], audience: "", whatYouSee: [], tasks: [], prerequisites: [],
  troubleshooting: [], next: [], related: [], reviewed: "2026-10-20", ...over,
});

describe("help: context and visibility", () => {
  it("matches exact routes before prefixes, and longer prefixes before shorter", () => {
    expect(routeScore("/orders", "/orders")).toBe(1000);
    expect(routeScore("/orders/*", "/orders/123")).toBe(7);
    expect(routeScore("/orders/*", "/ordersX")).toBe(-1);
    const list = [art("orders", { routes: ["/orders"] }), art("order-detail", { routes: ["/orders/*"] }), art("load-build", { routes: ["/orders/*/load-build"] })];
    expect(articlesForPath(list, "/orders").map((a) => a.id)).toEqual(["orders", "order-detail"]);
    expect(articlesForPath(list, "/orders/abc?back=1").map((a) => a.id)).toEqual(["order-detail"]);
  });

  it("hides articles the person has no permission for", () => {
    const list = [art("payroll", { permissions: ["payroll.view" as never] }), art("profile")];
    expect(visibleArticles(list, []).map((a) => a.id)).toEqual(["profile"]);
    expect(visibleArticles(list, ["payroll.view" as never]).map((a) => a.id)).toEqual(["payroll", "profile"]);
  });
});

describe("help: search", () => {
  const list = [
    art("create-customer", { title: "Create a customer", tasks: [{ title: "Add a customer", steps: ["Select New customer"] }] }),
    art("dispatch-board", { title: "Dispatch board", summary: "Assign a truck and driver to each load." }),
    art("tickets", { title: "Delivery tickets", troubleshooting: [{ problem: "A ticket is stuck", fix: "Ask dispatch" }] }),
  ];
  it("needs every word, matches prefixes, ranks title hits first", () => {
    expect(searchArticles(list, "dispat").map((a) => a.id)).toEqual(["dispatch-board", "tickets"]); // title hit first; "Ask dispatch" in troubleshooting
    expect(searchArticles(list, "customer new").map((a) => a.id)).toEqual(["create-customer"]);
    expect(searchArticles(list, "truck driver").map((a) => a.id)).toEqual(["dispatch-board"]);
  });
  it("returns nothing for an empty query or no match", () => {
    expect(searchArticles(list, "   ")).toEqual([]);
    expect(searchArticles(list, "invoice payment")).toEqual([]);
  });
});
