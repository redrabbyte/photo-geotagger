import { MapView } from './ui/MapView'
import { Timeline } from './ui/Timeline'
import { Filmstrip } from './ui/Filmstrip'
import { Inspector } from './ui/Inspector'
import { SourcesPanel } from './ui/SourcesPanel'
import { WriteBar } from './ui/WriteBar'
import { Toasts } from './ui/Toasts'
import { fsaSupported } from './services/fs/sources'
import './App.css'

export default function App() {
  return (
    <div className="app">
      {!fsaSupported() && (
        <div className="browser-warning">
          This app needs the File System Access API to read and edit local photos. Please use
          Chrome or Edge — in this browser, folders cannot be opened or written.
        </div>
      )}
      <WriteBar />
      <div className="app-main">
        <aside className="left">
          <SourcesPanel />
        </aside>
        <main className="center">
          <MapView />
        </main>
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
