/**
 * Original illustration (drawn for Taviron, no third-party artwork): a tri-axle
 * dump truck in side profile — navy body, silver detailing, an electric-blue rim
 * light along the top edges and a cool headlight glow. Decorative only.
 */
export function DumpTruck({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 680 280" className={className} aria-hidden focusable="false">
      <defs>
        <linearGradient id="dt-body" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#1d3a5c" />
          <stop offset="0.55" stopColor="#13283f" />
          <stop offset="1" stopColor="#0b1726" />
        </linearGradient>
        <linearGradient id="dt-cab" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#21436a" />
          <stop offset="1" stopColor="#0e1e31" />
        </linearGradient>
        <linearGradient id="dt-glass" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#5fb3ff" stopOpacity="0.55" />
          <stop offset="0.5" stopColor="#163150" stopOpacity="0.9" />
          <stop offset="1" stopColor="#0b1726" />
        </linearGradient>
        <linearGradient id="dt-rim" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#168bff" stopOpacity="0" />
          <stop offset="0.35" stopColor="#168bff" stopOpacity="0.9" />
          <stop offset="1" stopColor="#8cc8ff" />
        </linearGradient>
        <radialGradient id="dt-tire" cx="0.5" cy="0.5" r="0.5">
          <stop offset="0.55" stopColor="#0a0f17" />
          <stop offset="0.85" stopColor="#141c27" />
          <stop offset="1" stopColor="#05080d" />
        </radialGradient>
        <radialGradient id="dt-lamp" cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" stopColor="#e8f4ff" />
          <stop offset="0.35" stopColor="#8cc8ff" stopOpacity="0.8" />
          <stop offset="1" stopColor="#168bff" stopOpacity="0" />
        </radialGradient>
        <radialGradient id="dt-shadow" cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" stopColor="#000" stopOpacity="0.55" />
          <stop offset="1" stopColor="#000" stopOpacity="0" />
        </radialGradient>
      </defs>

      {/* ground shadow */}
      <ellipse cx="330" cy="248" rx="330" ry="18" fill="url(#dt-shadow)" />

      {/* chassis rail */}
      <rect x="40" y="186" width="590" height="14" rx="3" fill="#0b1726" />
      <rect x="40" y="186" width="590" height="2" fill="#c7d1de" opacity="0.18" />

      {/* dump body: tapered box with ribs */}
      <path d="M36 82 L398 66 L404 184 L54 184 Z" fill="url(#dt-body)" stroke="#c7d1de" strokeOpacity="0.22" />
      {[110, 170, 230, 290, 350].map((x) => (
        <path key={x} d={`M${x} ${80 - (x - 36) * 0.044} L${x + 3} 184`} stroke="#c7d1de" strokeOpacity="0.1" strokeWidth="2" />
      ))}
      <path d="M44 120 L401 108" stroke="#c7d1de" strokeOpacity="0.12" strokeWidth="2" />
      {/* tailgate hinge and cab shield */}
      <rect x="30" y="80" width="10" height="106" rx="2" fill="#0e1e31" stroke="#c7d1de" strokeOpacity="0.2" />
      <path d="M398 66 L432 70 L432 98 L401 98 Z" fill="#14294a" stroke="#c7d1de" strokeOpacity="0.2" />
      {/* hoist cylinder */}
      <path d="M392 184 L408 132" stroke="#9aa8b9" strokeOpacity="0.55" strokeWidth="6" strokeLinecap="round" />

      {/* exhaust stack */}
      <rect x="440" y="40" width="7" height="148" rx="2" fill="#c7d1de" opacity="0.55" />
      <rect x="439" y="36" width="9" height="8" rx="2" fill="#c7d1de" opacity="0.8" />

      {/* cab and hood */}
      <path d="M452 186 L452 92 Q454 70 478 68 L556 68 L586 114 L636 124 Q652 128 652 146 L652 186 Z" fill="url(#dt-cab)" stroke="#c7d1de" strokeOpacity="0.28" />
      <path d="M476 80 L550 80 L574 116 L476 116 Z" fill="url(#dt-glass)" stroke="#c7d1de" strokeOpacity="0.35" />
      <path d="M520 80 L520 116" stroke="#0b1726" strokeWidth="3" />
      {/* door, grille, bumper, steps */}
      <path d="M470 124 L548 124 L548 176 L470 176 Z" fill="none" stroke="#c7d1de" strokeOpacity="0.16" />
      <rect x="532" y="140" width="10" height="3" rx="1.5" fill="#c7d1de" opacity="0.5" />
      {[132, 141, 150, 159, 168].map((y) => (
        <rect key={y} x="640" y={y} width="12" height="3" rx="1" fill="#c7d1de" opacity="0.35" />
      ))}
      <rect x="628" y="180" width="32" height="12" rx="3" fill="#9aa8b9" opacity="0.6" />
      <rect x="560" y="186" width="40" height="6" rx="2" fill="#c7d1de" opacity="0.3" />

      {/* rim light along the top edges */}
      <path d="M36 82 L398 66" stroke="url(#dt-rim)" strokeWidth="2.5" strokeLinecap="round" />
      <path d="M452 92 Q454 70 478 68 L556 68 L586 114 L636 124 Q652 128 652 146" fill="none" stroke="url(#dt-rim)" strokeWidth="2.5" strokeLinecap="round" />

      {/* headlight and marker lamps */}
      <circle cx="648" cy="140" r="26" fill="url(#dt-lamp)" opacity="0.85" />
      <rect x="644" y="134" width="8" height="10" rx="2" fill="#e8f4ff" />
      {[60, 150, 240, 330].map((x) => (
        <rect key={x} x={x} y="178" width="6" height="3" rx="1.5" fill="#f5a524" opacity="0.7" />
      ))}

      {/* wheels: steer axle and three rear axles */}
      {[140, 210, 280, 590].map((cx) => (
        <g key={cx}>
          <circle cx={cx} cy="212" r="32" fill="url(#dt-tire)" />
          <circle cx={cx} cy="212" r="14" fill="#1b2a3c" stroke="#c7d1de" strokeOpacity="0.55" strokeWidth="2" />
          <circle cx={cx} cy="212" r="4" fill="#c7d1de" opacity="0.7" />
          <path d={`M${cx - 30} 200 A 32 32 0 0 1 ${cx + 30} 200`} fill="none" stroke="#168bff" strokeOpacity="0.35" strokeWidth="1.5" />
        </g>
      ))}
      {/* fenders */}
      <path d="M548 186 Q590 160 632 186" fill="none" stroke="#c7d1de" strokeOpacity="0.35" strokeWidth="4" />
      <path d="M100 186 Q210 160 320 186" fill="none" stroke="#c7d1de" strokeOpacity="0.2" strokeWidth="4" />
    </svg>
  );
}
