import type { ReactNode } from 'react'

interface Props {
  big: string
  title: string
  children?: ReactNode
  tone?: 'blue' | 'green' | 'violet' | 'amber'
}

export default function Stat({ big, title, children, tone = 'blue' }: Props) {
  return (
    <div className={`card stat tone-${tone}`}>
      <div className="stat-big">{big}</div>
      <div className="stat-title">{title}</div>
      {children && <p className="muted">{children}</p>}
    </div>
  )
}
