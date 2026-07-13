import { useStore } from '../state/store'

export function Toasts() {
  const notices = useStore((s) => s.notices)
  if (notices.length === 0) return null
  return (
    <div className="toasts">
      {notices.map((n) => (
        <div key={n.id} className={`toast toast-${n.kind}`} onClick={() => useStore.getState().dismissNotice(n.id)}>
          {n.text}
        </div>
      ))}
    </div>
  )
}
