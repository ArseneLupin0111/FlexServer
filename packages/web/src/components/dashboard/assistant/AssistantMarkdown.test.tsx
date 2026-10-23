import "../../../test/setup";
import { cleanup, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it } from "vitest";
import { AssistantMarkdown } from "./AssistantMarkdown";

afterEach(() => {
  cleanup();
});

describe("AssistantMarkdown semantic rendering", () => {
  it("renders strong emphasis as a real strong element, not literal asterisks", () => {
    render(<AssistantMarkdown content={"Ship **hardening** now"} />);

    const strong = screen.getByText("hardening");
    expect(strong.tagName).toBe("STRONG");
    expect(screen.queryByText(/\*\*/)).toBeNull();
  });

  it("renders headings, lists, and fenced code semantically", () => {
    render(
      <AssistantMarkdown
        content={"## Findings\n\n- one\n- two\n\n```bash\nuptime\n```"}
      />,
    );

    expect(
      screen.getByRole("heading", { level: 2, name: "Findings" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("list")).toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(2);

    const code = screen.getByText("uptime");
    expect(code.tagName).toBe("CODE");
    expect(code.closest("pre")).not.toBeNull();
  });

  it("renders inline code as code elements", () => {
    render(<AssistantMarkdown content={"Run `docker ps` first."} />);

    const code = screen.getByText("docker ps");
    expect(code.tagName).toBe("CODE");
    expect(code.closest("pre")).toBeNull();
  });

  it("renders GFM tables inside a localized horizontal scroll wrapper", () => {
    render(
      <AssistantMarkdown
        content={"| Check | Result |\n| --- | --- |\n| ssh | ok |"}
      />,
    );

    const table = screen.getByRole("table");
    expect(table.className).toContain("amd-table");
    const wrap = table.parentElement;
    expect(wrap?.className).toContain("amd-table-wrap");
    expect(screen.getByRole("columnheader", { name: "Check" })).toBeInTheDocument();
    expect(screen.getByRole("cell", { name: "ok" })).toBeInTheDocument();
  });

  it("renders GFM strikethrough and task lists", () => {
    render(<AssistantMarkdown content={"~~old~~ new\n\n- [x] done"} />);

    expect(screen.getByText("old").tagName).toBe("DEL");
    const checkbox = document.querySelector(
      "input[type='checkbox']",
    ) as HTMLInputElement | null;
    expect(checkbox).not.toBeNull();
    expect(checkbox?.checked).toBe(true);
  });
});

describe("AssistantMarkdown safety", () => {
  it("never renders raw HTML from markdown content", () => {
    render(
      <AssistantMarkdown
        content={'<script>window.amdPwned = true;</script><b>bold</b>'}
      />,
    );

    expect(document.querySelector("script")).toBeNull();
    expect(document.querySelector("b")).toBeNull();
    expect((window as { amdPwned?: boolean }).amdPwned).toBeUndefined();
  });

  it("never renders img elements, so remote images cannot load", () => {
    render(
      <AssistantMarkdown content={"![logo](https://images.example/logo.png)"} />,
    );

    expect(document.querySelector("img")).toBeNull();
    expect(screen.getByText(/image: logo/)).toBeInTheDocument();
  });

  it("drops unsafe link protocols and keeps their label as plain text", () => {
    render(
      <AssistantMarkdown content={"[bad](javascript:alert(1))"} />,
    );

    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText("bad")).toBeInTheDocument();
  });

  it("hardens safe links to new tabs with noopener noreferrer", () => {
    render(
      <AssistantMarkdown content={"[docs](https://example.com/docs)"} />,
    );

    const link = screen.getByRole("link", { name: "docs" });
    expect(link).toHaveAttribute("href", "https://example.com/docs");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });
});
