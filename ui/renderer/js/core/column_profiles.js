// The column lists a user can set (order, which are shown), one registry for every table that has a ⚙: 商品列表 and
// 實際庫存 (quote_presentation.js), 成交明細 (tick_details_columns.js). The column settings panel
// (components/column_settings_editor.js) edits any of them by name; each profile owns its options, its stored
// settings and its own "keep at least one" rule.
//
// A profile is { title, options() -> [{ key, label, unavailable? }], read() -> { order, visible }, write({ order,
// visible }), required }: `required` is the keys of which at least one stays shown (the last one shown cannot be
// unticked). An `unavailable` option is listed greyed out and never shown (its source has no such figure).
const profiles = new Map();

export function registerColumnProfile(name, profile) {
  profiles.set(String(name), Object.freeze({ ...profile, required: Object.freeze([...(profile.required || [])]) }));
}

export function columnProfile(name) {
  return profiles.get(String(name)) || null;
}

// Whether `key` is the last shown one of its profile's required keys (its box cannot be unticked).
export function isLastRequired(profile, key, selected) {
  const required = profile?.required || [];
  return required.includes(key) && selected.has(key) && !required.some((other) => other !== key && selected.has(other));
}
