// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { CompanyFavicon } from "./company-favicon";

describe("CompanyFavicon", () => {
  it("renders the Google s2 favicon URL when domain is set", () => {
    const { container } = render(<CompanyFavicon domain="acme.com" name="Acme" />);
    const img = container.querySelector("img");
    expect(img).not.toBeNull();
    expect(img?.getAttribute("src")).toContain("acme.com");
    expect(img?.getAttribute("src")).toContain("google.com/s2/favicons");
  });

  it("falls back to monogram when no domain is provided", () => {
    const { container, queryByLabelText } = render(<CompanyFavicon name="Acme" />);
    expect(container.querySelector("img")).toBeNull();
    expect(queryByLabelText("Acme")?.textContent).toBe("A");
  });

  it("normalizes a URL-shaped domain", () => {
    const { container } = render(<CompanyFavicon domain="https://acme.com/about" name="Acme" />);
    const img = container.querySelector("img");
    expect(img?.getAttribute("src")).toContain("acme.com");
    expect(img?.getAttribute("src")).not.toContain("https%3A");
  });
});
