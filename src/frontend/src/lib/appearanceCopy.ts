import type { OverridableRole } from "./themeOverrides";

export const APPEARANCE_COPY = {
  title: "Appearance",
  description:
    "Repaint the app in your own colours. Changes apply straight away, on this device, for your account only. "
    + "A colour that would make text or a control hard to read is not applied, and we say why.",
  themeLabel: "Editing",
  light: "Light theme",
  dark: "Dark theme",
  accentLabel: "Accent colour",
  accentHint: "Sets buttons, links, focus ring and soft highlights together.",
  advanced: "Fine-tune individual colours",
  reset: "Reset",
  resetAll: "Reset all colours",
  refusedHeading: "Not applied",
  usingDefault: "Default",
} as const;

export const ROLE_LABELS: Record<OverridableRole, string> = {
  "bg-app": "Page background",
  "bg-surface": "Cards",
  "bg-muted": "Sunken areas",
  "bg-raised": "Menus and dialogs",
  "text-primary": "Main text",
  "text-secondary": "Secondary text",
  "text-muted": "Faint text",
  border: "Dividers",
  control: "Field edges",
  primary: "Primary button",
  "primary-ink": "Primary button text",
  "primary-hover": "Primary button hover",
  "accent-strong": "Links and highlights",
  "accent-soft": "Soft highlight fill",
  ring: "Focus ring",
};
