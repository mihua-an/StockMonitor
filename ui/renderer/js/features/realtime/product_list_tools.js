// The product list shell's two tool buttons (product_list.js productListShellMarkup), mounted by each broker's list
// component on its own mount.
import { HOLDINGS_COLUMN_PROFILE, PRODUCT_COLUMN_PROFILE } from "../market/quote_presentation.js";
import { holdingsLedgerOfPage } from "./ledger_holdings.js";
import { openColumnSettings } from "../../core/components/column_settings_editor.js";

/**
 * The shell's two tool buttons, mounted by the list that mounts the shell (both brokers' lists): ✎ opens the
 * watch-page editor window; ⚙ opens the column settings panel (column_settings_editor.js) beside the list, on the
 * column list of the page the list shows -- a holdings page (實際庫存／模擬庫存) has its own.
 *
 * In a dashboard slot the buttons sit in the slot's own tab row (`actionsHost`, like every other component's
 * controls); elsewhere they stay at the end of the list's page tabs. They are the shell's nodes either way: the
 * returned unmount puts them back in the shell, so a list parked and mounted again brings them along, and unbinds.
 */
export function mountProductListTools(host, { activePageId, actionsHost = null }) {
  const tools = host.querySelector('[data-role="product-list-tools"]');
  if (!tools) return () => {};
  const shellSpot = tools.parentNode;
  const onClick = (event) => {
    const button = event.target?.closest?.('[data-role="product-page-edit"], [data-role="product-column-settings"]');
    if (!button || !tools.contains(button)) return;
    if (button.dataset.role === "product-page-edit") {
      Promise.resolve(window.desktopAPI?.openWatchPageEditor?.())
        .catch((error) => console.warn("[product list: opening the watch-page editor] failed", error));
      return;
    }
    const profile = holdingsLedgerOfPage(activePageId()) ? HOLDINGS_COLUMN_PROFILE : PRODUCT_COLUMN_PROFILE;
    openColumnSettings(profile, host);
  };
  tools.addEventListener("click", onClick);
  if (actionsHost) actionsHost.replaceChildren(tools);
  return () => {
    tools.removeEventListener("click", onClick);
    if (tools.parentNode !== shellSpot) shellSpot.appendChild(tools);
  };
}
