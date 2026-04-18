// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { ConnectionStrengthChip } from "./connection-strength-chip";

describe("ConnectionStrengthChip", () => {
  it("renders Inner circle for high scores", () => {
    const { getByText } = render(<ConnectionStrengthChip score={1500} />);
    expect(getByText("Inner circle")).toBeInTheDocument();
  });

  it("renders Cold for zero/null scores", () => {
    const { getByText: getText0 } = render(<ConnectionStrengthChip score={0} />);
    expect(getText0("Cold")).toBeInTheDocument();
  });

  it("hides label when showLabel=false but keeps the dot", () => {
    const { container, queryByText } = render(
      <ConnectionStrengthChip score={250} showLabel={false} />,
    );
    expect(queryByText("Strong")).toBeNull();
    // Still rendered as a chip with the colored dot.
    expect(container.querySelector("span[title]")).toBeTruthy();
  });

  it("accepts a string score (DuckDB returns VARCHAR)", () => {
    const { getByText } = render(<ConnectionStrengthChip score="75.5" />);
    expect(getByText("Active")).toBeInTheDocument();
  });
});
