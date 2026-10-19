interface SpinnerProps {
  size?: number;
  label?: string;
  className?: string;
}

export function Spinner({ size = 12, label, className }: SpinnerProps) {
  return (
    <span
      className={`spinner${className === undefined ? "" : ` ${className}`}`}
      style={{ width: size, height: size }}
      role={label === undefined ? undefined : "status"}
      aria-label={label}
      aria-hidden={label === undefined ? true : undefined}
    />
  );
}
