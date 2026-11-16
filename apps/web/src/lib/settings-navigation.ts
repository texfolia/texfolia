import {
  IconBrain,
  IconCreditCard,
  IconPlug,
  IconSettings,
  IconChartBar,
  IconUser,
} from "@tabler/icons-react";

export const settingsLinks = [
  { to: "/settings/account", label: "Account", icon: IconUser },
  { to: "/settings/preferences", label: "Preferences", icon: IconSettings },
  { to: "/settings/connections", label: "Connections", icon: IconPlug },
  { to: "/settings/ai", label: "AI", icon: IconBrain },
  { to: "/settings/billing", label: "Billing", icon: IconCreditCard },
  { to: "/settings/usage", label: "Usage", icon: IconChartBar },
] as const;
