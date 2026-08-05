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
