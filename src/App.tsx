import { useEffect, useState } from 'react'
import { MapView } from './ui/MapView'
import { Timeline } from './ui/Timeline'
import { Filmstrip } from './ui/Filmstrip'
import { Inspector } from './ui/Inspector'
import { SourcesPanel } from './ui/SourcesPanel'
import { WriteBar } from './ui/WriteBar'
import { Toasts } from './ui/Toasts'
import { useAutoLimits } from './ui/useAutoLimits'
import { fsaSupported } from './services/fs/sources'
import './App.css'

const MIN_PANEL_W = 180
const MAX_PANEL_W = 600

function usePanelWidth(key: string, initial: number): [number, (w: number) => void] {
  const [w, setW] = useState(() => {
    const stored = parseInt(localStorage.getItem(key) ?? '', 10)
    return Number.isFinite(stored) ? Math.min(MAX_PANEL_W, Math.max(MIN_PANEL_W, stored)) : initial
  })
  useEffect(() => {
    localStorage.setItem(key, String(w))
  }, [key, w])
  return [w, setW]
}

export default function App() {
  // Desktop: the side panels are resizable by dragging the divider next to
  // the map. On mobile the media query stacks everything full-width.
  const [leftW, setLeftW] = usePanelWidth('panelWidthLeft', 280)
  const [rightW, setRightW] = usePanelWidth('panelWidthRight', 300)
  useAutoLimits()

  const startResize = (side: 'left' | 'right') => (e: React.MouseEvent) => {
    e.preventDefault() // no text selection while dragging
    const startX = e.clientX
    const startW = side === 'left' ? leftW : rightW
    const apply = side === 'left' ? setLeftW : setRightW
    const onMove = (ev: MouseEvent) => {
      const dx = ev.clientX - startX
      apply(Math.min(MAX_PANEL_W, Math.max(MIN_PANEL_W, side === 'left' ? startW + dx : startW - dx)))
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  return (
    <div className="app">
      {!fsaSupported() && (
        <div className="browser-warning">
          This app needs the File System Access API to read and edit local photos, which only
          desktop Chrome or Edge provide. On this browser (including phones/tablets), folders
          cannot be opened or written.
        </div>
      )}
      <WriteBar />
      <div
        className="app-main"
        style={{ '--left-w': `${leftW}px`, '--right-w': `${rightW}px` } as React.CSSProperties}
      >
        <aside className="left">
          <SourcesPanel />
        </aside>
        <div className="panel-resizer" title="Drag to resize" onMouseDown={startResize('left')} />
        <main className="center">
          <MapView />
        </main>
        <div className="panel-resizer" title="Drag to resize" onMouseDown={startResize('right')} />
        <aside className="right">
          <Inspector />
        </aside>
      </div>
      <Timeline />
      <Filmstrip />
      <Toasts />
    </div>
  )
}
