// @vitest-environment jsdom
import { act, createElement, Fragment } from "react";
import { createRoot } from "react-dom/client";
import { createRequire } from "node:module";
import { expect, it } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it("releases the page click lock after overlapping menu and dialog layers", async () => {
  const require = createRequire(import.meta.url);
  const dropdownRequire = createRequire(require.resolve("@radix-ui/react-dropdown-menu"));
  const menuRequire = createRequire(dropdownRequire.resolve("@radix-ui/react-menu"));
  const dialogRequire = createRequire(require.resolve("@radix-ui/react-dialog"));
  expect(menuRequire.resolve("@radix-ui/react-focus-scope")).toBe(dialogRequire.resolve("@radix-ui/react-focus-scope"));
  expect(menuRequire.resolve("@radix-ui/react-focus-guards")).toBe(dialogRequire.resolve("@radix-ui/react-focus-guards"));
  const MenuLayer = menuRequire("@radix-ui/react-dismissable-layer").DismissableLayer;
  const DialogLayer = dialogRequire("@radix-ui/react-dismissable-layer").DismissableLayer;
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container), original = document.body.style.pointerEvents;
  function View({ menu, dialog }: { menu: boolean; dialog: boolean }) {
    return createElement(Fragment, null,
      menu ? createElement(MenuLayer, { key: "menu", disableOutsidePointerEvents: true }, "menu") : null,
      dialog ? createElement(DialogLayer, { key: "dialog", disableOutsidePointerEvents: true }, "dialog") : null);
  }
  try {
    await act(async () => root.render(createElement(View, { menu: true, dialog: false })));
    expect(document.body.style.pointerEvents).toBe("none");
    await act(async () => root.render(createElement(View, { menu: true, dialog: true })));
    await act(async () => root.render(createElement(View, { menu: false, dialog: true })));
    await act(async () => root.render(createElement(View, { menu: false, dialog: false })));
    expect(document.body.style.pointerEvents).toBe(original);
  } finally {
    await act(async () => root.unmount()); container.remove(); document.body.style.pointerEvents = original;
  }
});
