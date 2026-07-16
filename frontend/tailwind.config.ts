import type { Config } from "tailwindcss";
import animate from "tailwindcss-animate";

export default {
  prefix: "kl-",
  content: ["./src/**/*.{html,js,svelte,ts}"],
  corePlugins: {
    preflight: false,
  },
  theme: {
    extend: {
      colors: {
        border: "var(--kl-border)",
        input: "var(--kl-input)",
        ring: "var(--kl-ring)",
        background: "var(--kl-background)",
        foreground: "var(--kl-foreground)",
        primary: {
          DEFAULT: "var(--kl-primary)",
          foreground: "var(--kl-primary-foreground)",
        },
        secondary: {
          DEFAULT: "var(--kl-secondary)",
          foreground: "var(--kl-secondary-foreground)",
        },
        destructive: {
          DEFAULT: "var(--kl-destructive)",
          foreground: "var(--kl-destructive-foreground)",
        },
        muted: {
          DEFAULT: "var(--kl-muted)",
          foreground: "var(--kl-muted-foreground)",
        },
        accent: {
          DEFAULT: "var(--kl-accent)",
          foreground: "var(--kl-accent-foreground)",
        },
        popover: {
          DEFAULT: "var(--kl-popover)",
          foreground: "var(--kl-popover-foreground)",
        },
      },
      borderRadius: {
        lg: "var(--kl-radius-lg)",
        md: "var(--kl-radius-md)",
        sm: "var(--kl-radius-sm)",
      },
    },
  },
  plugins: [animate],
} satisfies Config;
