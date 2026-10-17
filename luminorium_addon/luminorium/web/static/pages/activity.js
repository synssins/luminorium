// Activity: the latest things Luminorium did, newest first.
"use strict";

(function () {
  const { el, onData, start } = L;
  const page = document.getElementById("page");

  function row(a) {
    const kind = /^Test|Testing/.test(a.message) ? ["Test", "test"] : /Playing|Stopped|show/i.test(a.message) ? ["Show", "show"]
      : /outside|failed|missed|stale/i.test(a.message) ? ["Note", "warn"] : ["Info", "info"];
    return el("div.list-row",
      el("span.mono.small.muted", { style: { width: "84px", flex: "none" } }, new Date(a.at * 1000).toLocaleTimeString()),
      el(`span.tag.${kind[1]}`, kind[0]),
      el("span", { style: { minWidth: "0" } }, a.message));
  }

  onData(({ status }) => {
    const items = status.activity || [];
    L.set(page, el("section.card",
      el("div.card-head", el("h2", "Latest 30 events"), el("span.small.muted", "Older entries are in the add-on's log")),
      items.length ? items.map(row) : el("div.empty", "Nothing yet.")));
  });
  start(3000);
})();
