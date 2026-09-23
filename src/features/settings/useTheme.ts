import { useEffect, useState } from 'react'

export type Theme = 'dark' | 'light' | 'system'
const storageKey = 'frame-studio.theme.v1'

function readTheme(): Theme {
  try {
    const saved = localStorage.getItem(storageKey)
    if (saved === 'dark' || saved === 'light' || saved === 'system')
      return saved
  } catch {
    /* A blocked preference store must not prevent startup. */
  }
  return 'dark'
}

export function useTheme() {
  const [theme, setTheme] = useState<Theme>(readTheme)
  const [storageError, setStorageError] = useState(false)

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = () => {
      document.documentElement.dataset.theme =
        theme === 'system' ? (media.matches ? 'dark' : 'light') : theme
    }
    apply()
    media.addEventListener('change', apply)
    return () => media.removeEventListener('change', apply)
  }, [theme])

  const changeTheme = (next: Theme) => {
    setTheme(next)
    try {
      localStorage.setItem(storageKey, next)
      setStorageError(false)
    } catch {
      setStorageError(true)
    }
  }

  return { theme, changeTheme, storageError }
}
