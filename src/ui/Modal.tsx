import type { ReactNode } from 'react'

/** Backdrop-dismissable dialog: a click outside closes, clicks inside don't. */
export function Modal({
  onClose,
  className,
  children,
}: {
  onClose: () => void
  className?: string
  children: ReactNode
}) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className={className ? `modal ${className}` : 'modal'} onClick={(e) => e.stopPropagation()}>
        {children}
      </div>
    </div>
  )
}
