/**
 * MAIN-world helper for YouTube: capture timedtext URLs that already carry pot,
 * and expose ytInitialPlayerResponse without extension-isolated fetch failures.
 */
(function () {
  "use strict";
  if (window.__LT_YT_BRIDGE__) return;
  window.__LT_YT_BRIDGE__ = true;

  const state = {
    timedtextUrls: [],
    max: 12
  };

  function remember(url) {
    if (!url || typeof url !== "string") return;
    if (!/\/api\/timedtext/i.test(url)) return;
    if (state.timedtextUrls[0] === url) return;
    state.timedtextUrls.unshift(url);
    if (state.timedtextUrls.length > state.max) state.timedtextUrls.length = state.max;
  }

  function scanResourceEntries(entries) {
    for (const entry of entries || []) {
      try {
        if (entry && typeof entry.name === "string") remember(entry.name);
      } catch (_) {
        /* ignore malformed performance entries */
      }
    }
  }

  try {
    const origFetch = window.fetch;
    if (typeof origFetch === "function") {
      window.fetch = function (...args) {
        try {
          const input = args[0];
          const url = typeof input === "string" ? input : input && input.url;
          remember(url);
        } catch (_) {}
        return origFetch.apply(this, args);
      };
    }
  } catch (_) {}

  try {
    const XO = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
      try {
        remember(String(url || ""));
      } catch (_) {}
      return XO.call(this, method, url, ...rest);
    };
  } catch (_) {}

  // Injection often happens after the player has already requested captions.
  // Resource Timing retains the full pot-bearing URL, so scan both past and
  // future entries instead of waiting for another caption request.
  try {
    scanResourceEntries(performance.getEntriesByType("resource"));
    if (typeof PerformanceObserver === "function") {
      const observer = new PerformanceObserver((list) => {
        try {
          scanResourceEntries(list.getEntries());
        } catch (_) {}
      });
      observer.observe({ type: "resource", buffered: true });
    }
  } catch (_) {}

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== "lt-yt-ext") return;

    if (data.type === "LT_YT_GET_PLAYER") {
      let pr = null;
      try {
        pr = window.ytInitialPlayerResponse || null;
      } catch (_) {
        pr = null;
      }
      try {
        const player = document.getElementById("movie_player");
        const live = typeof player?.getPlayerResponse === "function"
          ? player.getPlayerResponse()
          : null;
        if (live?.videoDetails?.videoId) pr = live;
      } catch (_) {
        /* keep initial response */
      }
      window.postMessage({ source: "lt-yt-page", type: "LT_YT_PLAYER", payload: pr, id: data.id }, "*");
      return;
    }

    if (data.type === "LT_YT_GET_TIMEDTEXT") {
      window.postMessage(
        {
          source: "lt-yt-page",
          type: "LT_YT_TIMEDTEXT",
          urls: state.timedtextUrls.slice(),
          id: data.id
        },
        "*"
      );
    }
  });
})();
