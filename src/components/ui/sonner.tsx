import * as React from "react";
import { Toaster as Sonner, type ToasterProps } from "sonner";
import { cn } from "@/lib/utils";
import { useUiText } from "@/i18n";

export function Toaster(props: ToasterProps): React.ReactElement {
  const uiText = useUiText();
  const { className, style, toastOptions, ...sonnerProps } = props;
  const classNames = toastOptions?.classNames;

  return (
    <Sonner
      className={cn("tuda-toaster", className)}
      duration={2400}
      gap={8}
      visibleToasts={3}
      offset={16}
      mobileOffset={12}
      containerAriaLabel={uiText("通知")}
      style={{ "--width": "22rem", ...style } as React.CSSProperties}
      toastOptions={{
        ...toastOptions,
        classNames: {
          ...classNames,
          toast: cn("tuda-toast", classNames?.toast),
          content: cn("tuda-toast__content", classNames?.content),
          title: cn("tuda-toast__title", classNames?.title),
          description: cn("tuda-toast__description", classNames?.description),
          icon: cn("tuda-toast__icon", classNames?.icon),
          actionButton: cn("tuda-toast__action", classNames?.actionButton),
          cancelButton: cn("tuda-toast__cancel", classNames?.cancelButton),
          closeButton: cn("tuda-toast__close", classNames?.closeButton)
        }
      }}
      {...sonnerProps}
    />
  );
}
