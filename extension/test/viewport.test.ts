import { expect, test } from "vitest";
import { focusBox } from "../src/webview/viewport";

test("a small box is centred and the view is not smaller than the viewport", () => {
  expect(focusBox({ x: 100, y: 100, width: 50, height: 20 }, { width: 800, height: 400 }))
    .toEqual({ x: -275, y: -90, width: 800, height: 400 });
});

test("a big box gets the margin and the viewport's aspect ratio", () => {
  const v = focusBox({ x: 0, y: 0, width: 2000, height: 300 }, { width: 800, height: 400 });
  expect(v.width).toBe(2160);
  expect(v.height).toBe(1080);
  expect(v.x + v.width / 2).toBe(1000);
  expect(v.y + v.height / 2).toBe(150);
});

test("a tall box widens the view to keep the aspect ratio", () => {
  const v = focusBox({ x: 0, y: 0, width: 100, height: 1000 }, { width: 800, height: 400 });
  expect(v.height).toBe(1160);
  expect(v.width).toBe(2320);
});

test("a 0×0 viewport (not laid out yet) still returns box plus margin", () => {
  expect(focusBox({ x: 10, y: 10, width: 100, height: 40 }, { width: 0, height: 0 }))
    .toEqual({ x: -70, y: -70, width: 260, height: 200 });
});
