import {
  type Ref,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";

import { FieldError } from "#/components/ui/field";

type TurnstileApi = {
  render: (
    container: HTMLElement,
    options: {
      sitekey: string;
      action: string;
      size: "flexible";
      callback: (token: string) => void;
      "expired-callback": () => void;
      "error-callback": () => void;
    },
  ) => string;
  reset: (widgetId: string) => void;
  remove: (widgetId: string) => void;
};

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

export type LoginTurnstileHandle = { reset: () => void };

export function LoginTurnstile({
  onToken,
  ref,
}: {
  onToken: (token: string | null) => void;
  ref: Ref<LoginTurnstileHandle>;
}) {
  const container = useRef<HTMLDivElement>(null);
  const widgetId = useRef<string | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const sitekey = import.meta.env.VITE_TURNSTILE_SITE_KEY;

  useImperativeHandle(ref, () => ({
    reset() {
      onToken(null);
      if (widgetId.current !== undefined) {
        window.turnstile?.reset(widgetId.current);
      }
    },
  }));

  useEffect(() => {
    if (!sitekey) return;

    function render() {
      if (!sitekey || !container.current || !window.turnstile) return;
      widgetId.current = window.turnstile.render(container.current, {
        sitekey,
        action: "login",
        size: "flexible",
        callback: (token) => {
          setError(null);
          onToken(token);
        },
        "expired-callback": () => {
          onToken(null);
          if (widgetId.current !== undefined) {
            window.turnstile?.reset(widgetId.current);
          }
        },
        "error-callback": () => {
          onToken(null);
          setError(
            "Security verification failed. Refresh the page to try again.",
          );
        },
      });
    }

    function onError() {
      onToken(null);
      setError(
        "Security verification could not load. Refresh the page to try again.",
      );
    }

    let script = document.querySelector<HTMLScriptElement>("#turnstile-script");
    if (!script) {
      script = document.createElement("script");
      script.id = "turnstile-script";
      script.src =
        "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
      script.async = true;
      script.defer = true;
      document.head.append(script);
    }
    if (window.turnstile) render();
    else script.addEventListener("load", render);
    script.addEventListener("error", onError);

    return () => {
      script.removeEventListener("load", render);
      script.removeEventListener("error", onError);
      if (widgetId.current !== undefined) {
        window.turnstile?.remove(widgetId.current);
        widgetId.current = undefined;
      }
    };
  }, [onToken, sitekey]);

  return (
    <div className="flex min-h-16 w-full flex-col items-center gap-2">
      <div ref={container} className="w-full" />
      {(!sitekey || error) && (
        <FieldError className="text-center">
          {error ??
            "Email sign-in is temporarily unavailable. Please try again later."}
        </FieldError>
      )}
    </div>
  );
}
