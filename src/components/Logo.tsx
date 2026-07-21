// NeurlX wordmark — "Neurl" in foreground, "X" highlighted in primary accent.
// Uses semantic tokens so light + dark modes stay in brand.
import { cn } from "@/lib/utils";

interface LogoProps {
  className?: string;
  size?: "sm" | "md" | "lg";
  showTagline?: boolean;
}

const SIZE = {
  sm: { mark: "w-6 h-6", text: "text-sm", tag: "text-[9px]" },
  md: { mark: "w-8 h-8", text: "text-base", tag: "text-[10px]" },
  lg: { mark: "w-12 h-12", text: "text-2xl", tag: "text-xs" },
} as const;

export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden="true">
      <rect x="0.5" y="0.5" width="31" height="31" rx="7"
        className="fill-primary/10 stroke-primary/40" strokeWidth="1" />
      {/* Left beam — foreground */}
      <path d="M8 8 L14.5 16 L8 24" className="stroke-foreground" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" fill="none" />
      {/* Right beam — primary accent */}
      <path d="M24 8 L17.5 16 L24 24" className="stroke-primary" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" fill="none" />
      {/* Crossover node */}
      <circle cx="16" cy="16" r="1.6" className="fill-primary" />
    </svg>
  );
}

export function Logo({ className, size = "md", showTagline = false }: LogoProps) {
  const s = SIZE[size];
  return (
    <div className={cn("flex items-center gap-2 min-w-0", className)}>
      <LogoMark className={cn("shrink-0", s.mark)} />
      <div className="min-w-0 leading-tight">
        <div className={cn("font-semibold tracking-tight truncate", s.text)}>
          <span>Neurl</span>
          <span className="text-primary">X</span>
        </div>
        {showTagline && (
          <div className={cn("font-mono uppercase tracking-[0.14em] text-muted-foreground truncate", s.tag)}>
            Neural precision, executed.
          </div>
        )}
      </div>
    </div>
  );
}
