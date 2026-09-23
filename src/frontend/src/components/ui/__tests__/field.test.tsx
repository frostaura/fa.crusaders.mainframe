import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { Field, FieldDescription, FieldError, FieldLabel } from "../field";
import { Input } from "../input";
import { Textarea } from "../textarea";

const strict = { reactStrictMode: true };

describe("Field wiring", () => {
  it("labels the control and describes it with the help text only when there is no error", () => {
    render(
      <Field>
        <FieldLabel>Email</FieldLabel>
        <Input type="email" />
        <FieldDescription>We send receipts here.</FieldDescription>
      </Field>,
      strict,
    );
    const input = screen.getByRole("textbox", { name: "Email" });
    const help = screen.getByText("We send receipts here.");
    expect(input).toHaveAttribute("aria-describedby", help.id);
    expect(input).not.toHaveAttribute("aria-invalid");
    expect(input).toHaveAccessibleDescription("We send receipts here.");
  });

  it("an error sets aria-invalid and joins the describedby after the help text", () => {
    render(
      <Field>
        <FieldLabel>Display name</FieldLabel>
        <Input />
        <FieldDescription>Shown on the booking grid.</FieldDescription>
        <FieldError>Enter a name.</FieldError>
      </Field>,
      strict,
    );
    const input = screen.getByRole("textbox", { name: "Display name" });
    expect(input).toHaveAttribute("aria-invalid", "true");
    const ids = input.getAttribute("aria-describedby")!.split(" ");
    expect(ids).toHaveLength(2);
    expect(document.getElementById(ids[0])).toHaveTextContent("Shown on the booking grid.");
    expect(document.getElementById(ids[1])).toHaveTextContent("Enter a name.");
    expect(input).toHaveAccessibleDescription("Shown on the booking grid. Enter a name.");
  });

  it("an empty FieldError renders nothing and leaves the control valid, with no dangling reference", () => {
    render(
      <Field>
        <FieldLabel>Phone</FieldLabel>
        <Input />
        <FieldError>{""}</FieldError>
      </Field>,
      strict,
    );
    const input = screen.getByRole("textbox", { name: "Phone" });
    expect(input).not.toHaveAttribute("aria-invalid");
    expect(input).not.toHaveAttribute("aria-describedby");
  });

  it("clearing the error removes aria-invalid and the reference", () => {
    const view = (error?: string) => (
      <Field>
        <FieldLabel>Code</FieldLabel>
        <Input />
        <FieldError>{error}</FieldError>
      </Field>
    );
    const { rerender } = render(view("Wrong code."), strict);
    expect(screen.getByRole("textbox", { name: "Code" })).toHaveAttribute("aria-invalid", "true");
    rerender(view(undefined));
    const input = screen.getByRole("textbox", { name: "Code" });
    expect(input).not.toHaveAttribute("aria-invalid");
    expect(input).not.toHaveAttribute("aria-describedby");
  });

  it("`invalid` on the Field marks the control without a rendered message", () => {
    render(<Field invalid><FieldLabel>Amount</FieldLabel><Input /></Field>, strict);
    expect(screen.getByRole("textbox", { name: "Amount" })).toHaveAttribute("aria-invalid", "true");
  });

  it("a control's own id and describedby are kept, the field's parts appended", () => {
    render(
      <>
        <p id="outside">Outside note</p>
        <Field>
          <FieldLabel htmlFor="mine">Reason</FieldLabel>
          <Textarea id="mine" aria-describedby="outside" />
          <FieldDescription>Visible to the member.</FieldDescription>
        </Field>
      </>,
      strict,
    );
    const area = screen.getByRole("textbox", { name: "Reason" });
    expect(area.id).toBe("mine");
    expect(area.getAttribute("aria-describedby")!.split(" ")[0]).toBe("outside");
    expect(area).toHaveAccessibleDescription("Outside note Visible to the member.");
  });

  it("two fields never share ids", () => {
    render(
      <>
        <Field><FieldLabel>First</FieldLabel><Input /></Field>
        <Field><FieldLabel>Second</FieldLabel><Input /></Field>
      </>,
      strict,
    );
    expect(screen.getByRole("textbox", { name: "First" }).id).not.toBe(screen.getByRole("textbox", { name: "Second" }).id);
  });

  it("the error carries words and an icon, never colour alone", () => {
    render(<Field><FieldLabel>X</FieldLabel><Input /><FieldError>Too long.</FieldError></Field>, strict);
    const error = screen.getByText("Too long.").closest("[data-slot=field-error]")!;
    expect(error.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
    expect(error.className).toContain("text-danger-strong");
  });
});

describe("Input and Textarea", () => {
  it("wear the control edge at 44px, 16px text on phones, and keep the house focus outline", () => {
    render(<><Input aria-label="a" /><Textarea aria-label="b" /></>, strict);
    const input = screen.getByRole("textbox", { name: "a" });
    const area = screen.getByRole("textbox", { name: "b" });
    for (const el of [input, area]) {
      expect(el.className).toContain("border-control");
      expect(el.className).toContain("text-base");
      expect(el.className).toContain("sm:text-sm");
      expect(el.className).not.toMatch(/outline-none|focus-visible:ring/);
    }
    expect(input.className).toContain("h-touch");
    expect(input).toHaveAttribute("type", "text");
  });

  it("work outside a Field", () => {
    render(<Input aria-label="Search" placeholder="Name" />, strict);
    const input = screen.getByRole("textbox", { name: "Search" });
    expect(input).not.toHaveAttribute("aria-describedby");
    expect(input.id).toBe("");
  });
});
