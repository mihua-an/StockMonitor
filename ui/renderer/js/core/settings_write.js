// A versioned settings write (PUT with expected_revision): the same record and the same words on every settings page.
// Apart from settings_ui.js, which the page-independent motion and message code imports: that one reaches no API.
import { apiJsonPut } from "./api.js";

/** What the settings service said is wrong: each problem's message (or its code and service), "" when it named none. */
export function describeSettingsProblems(problems) {
  return (problems || []).map((p) => p.message || `${p.code}${p.service_id ? ` (${p.service_id})` : ""}`).join("；");
}

/** Save `values` over revision `expectedRevision` of the setting at `path`. A refusal or a failed request goes to
 *  `recordFailure("saving", target, detail)` and is answered, never thrown: {ok, conflict (another window saved first),
 *  result, text (the message for the user, starting with `label` when there is one)}. */
export async function saveVersionedSetting({ path, expectedRevision, values, label = "", recordFailure }) {
  const target = `PUT ${path}`;
  try {
    const result = await apiJsonPut(path, { expected_revision: expectedRevision ?? null, values, summary: "settings page" });
    if (result?.ok) return { ok: true, conflict: false, result, text: "" };
    recordFailure("saving", target, result);
    const conflict = result?.error === "REVISION_CONFLICT";
    return { ok: false, conflict, result, text: conflict
      ? `${label}保存衝突：其他視窗已保存新版本，已重新載入，請確認後再保存`
      : `${label}保存失敗：${describeSettingsProblems(result?.problems) || result?.error || "未知錯誤"}` };
  } catch (error) {
    recordFailure("saving", target, error);
    return { ok: false, conflict: false, result: null, text: `${label}保存失敗：${error?.message || error}` };
  }
}
