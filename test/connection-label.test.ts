import { describe, expect, it } from "vitest";
import {
  centeredConnectionLabelLocation,
  connectionPathLocationAtProgress,
  pointAtConnectionPathProgress,
  projectPointToConnectionPath,
  sampleConnectionPath
} from "../src/components/canvas/connection-label";

describe("connection label path geometry", () => {
  it("samples the rounded smooth-step path commands", () => {
    const points = sampleConnectionPath("M0 0L20 0L 88,0Q 100,0 100,12L100 100");

    expect(points[0]).toEqual({ x: 0, y: 0 });
    expect(points.at(-1)).toEqual({ x: 100, y: 100 });
    expect(points.some((point) => point.x > 88 && point.x < 100 && point.y > 0 && point.y < 12)).toBe(true);
  });

  it("projects dragging onto the nearest connection segment", () => {
    const points = sampleConnectionPath("M 0 0 L 100 0 L 100 100");
    const projection = projectPointToConnectionPath(points, { x: 82, y: 64 });

    expect(projection.point).toEqual({ x: 100, y: 64 });
    expect(projection.progress).toBeCloseTo(0.82);
    expect(projection.side).toBe("left");
  });

  it("places horizontal labels above and vertical labels on the left in either direction", () => {
    const points = sampleConnectionPath("M 100 100 L 0 100 L 0 0");

    expect(projectPointToConnectionPath(points, { x: 50, y: 100 }).side).toBe("above");
    expect(projectPointToConnectionPath(points, { x: 0, y: 50 }).side).toBe("left");
    expect(projectPointToConnectionPath([...points].reverse(), { x: 50, y: 100 }).side).toBe("above");
    expect(projectPointToConnectionPath([...points].reverse(), { x: 0, y: 50 }).side).toBe("left");
  });

  it("uses the local direction of a curved path", () => {
    const points = sampleConnectionPath("M 0 0 Q 100 0 100 100");

    expect(connectionPathLocationAtProgress(points, 0.25)).toMatchObject({ side: "above", alongPathAlignment: 0 });
    expect(connectionPathLocationAtProgress(points, 0.75)).toMatchObject({ side: "left", alongPathAlignment: 0 });
    expect(connectionPathLocationAtProgress(sampleConnectionPath("M 0 0 L 100 -50"), 0.5))
      .toMatchObject({ side: "above", alongPathAlignment: -100 });
  });

  it("centers a result label on the visible route and clears the line across the label", () => {
    const size = { width: 60, height: 24 };
    const horizontal = sampleConnectionPath("M 20 0 L 100 8");
    expect(centeredConnectionLabelLocation(horizontal, size)).toEqual({
      point: { x: 60, y: 1 },
      side: "above",
      alongPathAlignment: -50
    });
    const vertical = sampleConnectionPath("M 10 20 L 0 100");
    expect(centeredConnectionLabelLocation(vertical, size)).toEqual({
      point: { x: 3.5, y: 60 },
      side: "left",
      alongPathAlignment: -50
    });
    const bend = sampleConnectionPath("M 0 0 L 100 0 L 100 12 L 200 12");
    expect(centeredConnectionLabelLocation(bend, size)).toEqual({
      point: { x: 100, y: 0 },
      side: "above",
      alongPathAlignment: -50
    });
  });

  it("keeps the same relative label position when the connection moves", () => {
    const original = sampleConnectionPath("M 0 0 L 100 0 L 100 100");
    const moved = sampleConnectionPath("M 40 30 L 240 30 L 240 130");
    const progress = projectPointToConnectionPath(original, { x: 100, y: 50 }).progress;

    expect(pointAtConnectionPathProgress(original, progress)).toEqual({ x: 100, y: 50 });
    expect(pointAtConnectionPathProgress(moved, progress)).toEqual({ x: 240, y: 55 });
  });
});
