import { describe, it, expect } from "vitest";
import { growIncludeParams } from "../src/tools/grow";

describe("growIncludeParams", () => {
  it("asks for custom_field_values when requested", () => {
    expect(growIncludeParams(true)).toEqual({ include: "custom_field_values" });
  });

  it("sends no include param by default, so existing calls are unchanged", () => {
    // Grow omits custom_field_values unless asked; not sending `include` keeps
    // the payload (and the response size) exactly as it was before this change.
    expect(growIncludeParams(false)).toEqual({});
    expect(growIncludeParams(undefined)).toEqual({});
  });
});
