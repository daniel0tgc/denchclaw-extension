// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { PersonAvatar } from "./person-avatar";

describe("PersonAvatar", () => {
  it("renders initials when no src is provided", () => {
    const { getByLabelText } = render(<PersonAvatar name="Sarah Chen" />);
    const node = getByLabelText("Sarah Chen");
    expect(node.textContent).toBe("SC");
  });

  it("renders an img tag when src is set", () => {
    const { container } = render(
      <PersonAvatar src="https://example.com/avatar.jpg" name="Sarah Chen" />,
    );
    expect(container.querySelector("img")).not.toBeNull();
  });

  it("falls back to ? when name is null", () => {
    const { getByLabelText } = render(<PersonAvatar name={null} />);
    expect(getByLabelText("Avatar").textContent).toBe("?");
  });

  it("respects size prop", () => {
    const { getByLabelText } = render(<PersonAvatar name="X" size="lg" />);
    const node = getByLabelText("X");
    expect((node).style.width).toBe("48px");
  });

  it("uses email local-part when name is an email", () => {
    const { getByLabelText } = render(<PersonAvatar name="sarah.chen@acme.com" />);
    const node = getByLabelText("sarah.chen@acme.com");
    expect(node.textContent).toBe("SC");
  });
});
