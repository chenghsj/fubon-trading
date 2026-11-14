import * as React from "react"
import { cn } from "@/lib/utils"
import { ChevronDownIcon } from "lucide-react"
import "./form-control.css"

function NativeSelect({
  className,
  size = "compact",
  wrapperClassName,
  showIcon = true,
  ...props
}: Omit<React.ComponentProps<"select">, "size"> & { size?: "compact" | "sm" | "default"; wrapperClassName?: string; showIcon?: boolean }) {
  return (
    <div
      className={cn("group/native-select relative w-fit min-w-0 max-w-full", wrapperClassName)}
      data-slot="native-select-wrapper"
    >
      <select
        data-slot="native-select"
        data-size={size}
        data-icon={showIcon}
        className={cn(
          "block appearance-none rounded-md border border-input bg-transparent text-foreground shadow-sm transition-[color,box-shadow] outline-none selection:bg-primary selection:text-primary-foreground placeholder:text-muted-foreground disabled:pointer-events-none disabled:cursor-not-allowed",
          "focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring",
          "aria-invalid:border-destructive aria-invalid:ring-destructive",
          className
        )}
        {...props}
      />
      {showIcon && <ChevronDownIcon
        className="pointer-events-none absolute top-1/2 right-1.5 size-3 -translate-y-1/2 text-muted-foreground opacity-50 select-none"
        aria-hidden="true"
        data-slot="native-select-icon"
      />}
    </div>
  )
}

function NativeSelectOption({
  className,
  ...props
}: React.ComponentProps<"option">) {
  return (
    <option
      data-slot="native-select-option"
      className={cn("bg-[Canvas] text-[CanvasText]", className)}
      {...props}
    />
  )
}

function NativeSelectOptGroup({
  className,
  ...props
}: React.ComponentProps<"optgroup">) {
  return (
    <optgroup
      data-slot="native-select-optgroup"
      className={cn("bg-[Canvas] text-[CanvasText]", className)}
      {...props}
    />
  )
}

export { NativeSelect, NativeSelectOptGroup, NativeSelectOption }
