const paths = {
  home: 'M3 10 12 3l9 7v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1Z',
  workflow: 'M3 3h6v6H3ZM15 15h6v6h-6ZM6 9v9h9M9 6h9v9',
  asset: 'M3 5h7l2 2h9v13H3ZM8 14h8M12 10v8',
  settings: 'M4 7h16M4 17h16M8 4v6M16 14v6',
  arrow: 'M4 12h15m-5-5 5 5-5 5',
  monitor: 'M3 4h18v13H3ZM8 21h8M12 17v4',
  check: 'm5 12 4 4L19 6',
  refresh: 'M20 9a8 8 0 0 0-14-3L3 9m0-5v5h5M4 15a8 8 0 0 0 14 3l3-3m0 5v-5h-5',
  moon: 'M20 14A8 8 0 0 1 10 4a9 9 0 1 0 10 10Z',
  sun: 'M12 1v3M12 20v3M1 12h3M20 12h3M4 4l2 2m12 12 2 2M4 20l2-2M18 6l2-2M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0',
} as const

export type IconName = keyof typeof paths

export function Icon({
  name,
  className = '',
}: {
  name: IconName
  className?: string
}) {
  return (
    <svg
      className={`icon ${className}`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name]} />
    </svg>
  )
}
