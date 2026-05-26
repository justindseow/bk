import type { ReactNode } from 'react'

interface WorkpaperFrameProps {
  title: string
  subtitle: string
  period?: string
  children: ReactNode
  footer?: ReactNode
}

export function WorkpaperFrame({ title, subtitle, period, children, footer }: WorkpaperFrameProps) {
  return (
    <section className="workpaper">
      <div className="paper-head">
        <div>
          <h2>{title}</h2>
          <p>{subtitle}</p>
        </div>
        {period ? <span>{period}</span> : null}
      </div>
      <div className="paper-body">{children}</div>
      {footer ? <div className="paper-footer">{footer}</div> : null}
    </section>
  )
}
