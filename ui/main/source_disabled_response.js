"use strict";

// The desktop-side body for "this source is not selected in config/source_settings.json" (IPC replies). The HTTP
// equivalent (409 SOURCE_DISABLED with the source status contract) is service/market/shared/source_runtime.py's
// disabled_source(); config/js/source_settings.js only answers which sources are selected.
function sourceDisabledResponse(source, extra = {}) {
  return { ok: false, enabled: false, source, error: "SOURCE_DISABLED", ...extra };
}

module.exports = { sourceDisabledResponse };
