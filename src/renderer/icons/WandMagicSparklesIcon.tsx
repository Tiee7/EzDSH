import { faWandMagicSparkles } from '@fortawesome/free-solid-svg-icons'

export interface WandMagicSparklesIconProps {
  className?: string
  size?: number
}

/**
 * The canonical AI action icon for the renderer.
 *
 * Keep the icon definition in Font Awesome's Free Solid pack and expose one
 * small component so every AI action uses the same geometry and semantics.
 */
export function WandMagicSparklesIcon({ className, size = 16 }: WandMagicSparklesIconProps): JSX.Element {
  const [width, height, , , pathData] = faWandMagicSparkles.icon
  const paths = Array.isArray(pathData) ? pathData : [pathData]
  const classes = ['ai-wand-magic-sparkles-icon', className].filter(Boolean).join(' ')
  return <svg className={classes} viewBox={`0 0 ${width} ${height}`} width={size} height={size} fill="currentColor" aria-hidden="true" focusable="false">{paths.map((path, index) => <path key={index} d={path} />)}</svg>
}
