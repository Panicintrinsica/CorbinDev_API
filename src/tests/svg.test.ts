import { describe, expect, test } from "bun:test";
import { identifyImage } from "../media/image.ts";
import { MAX_SVG_BYTES, svgDimensions, svgProblem } from "../media/svg.ts";

const bytes = (text: string) => new TextEncoder().encode(text);
const plain = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="32"><rect width="64" height="32"/></svg>`;

describe("SVG identification", () => {
  test("is recognised, with its size", () => {
    expect(identifyImage(bytes(plain))).toEqual({
      mimeType: "image/svg+xml",
      extension: "svg",
      width: 64,
      height: 32,
    });
  });

  test("tolerates an XML prolog, comments and a doctype", () => {
    const doc = `<?xml version="1.0"?>\n<!-- made by hand -->\n<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "x">\n<svg viewBox="0 0 24 24"></svg>`;
    expect(identifyImage(bytes(doc))).toMatchObject({ extension: "svg", width: 24, height: 24 });
  });

  test("falls back to the viewBox when width/height are not pixels", () => {
    expect(svgDimensions(bytes(`<svg width="100%" viewBox="0 0 200 100"/>`))).toEqual({ width: 200, height: 100 });
  });

  test("HTML and other text are not SVG", () => {
    expect(identifyImage(bytes("<html><svg></svg></html>"))).toBeNull();
    expect(identifyImage(bytes("hello"))).toBeNull();
  });
});

describe("svgProblem", () => {
  test("accepts a plain SVG, including internal references", () => {
    expect(svgProblem(bytes(plain))).toBeNull();
    expect(svgProblem(bytes(`<svg><defs><linearGradient id="g"/></defs><use href="#g"/><rect fill="url(#g)"/></svg>`))).toBeNull();
  });

  test.each([
    ["script", `<svg><script>alert(1)</script></svg>`],
    ["event handler", `<svg onload="alert(1)"></svg>`],
    ["foreignObject", `<svg><foreignObject><div/></foreignObject></svg>`],
    ["javascript URL", `<svg><a href="javascript:alert(1)"/></svg>`],
    ["external image", `<svg><image href="https://evil.example/x.png"/></svg>`],
    ["protocol-relative", `<svg><image xlink:href="//evil.example/x.png"/></svg>`],
    ["external css", `<svg><rect style="fill:url(https://evil.example/x)"/></svg>`],
    ["entity", `<!DOCTYPE svg [<!ENTITY a "aaaa">]><svg>&a;</svg>`],
  ])("refuses %s", (_name, doc) => {
    expect(svgProblem(bytes(doc))).not.toBeNull();
  });

  test("refuses anything over 10MB", () => {
    const big = new Uint8Array(MAX_SVG_BYTES + 1);
    expect(svgProblem(big)).toContain("10MB");
  });
});
