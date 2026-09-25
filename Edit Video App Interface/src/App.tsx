import { useEffect, useMemo, useRef, useState } from 'react'

/* ------------------------------------------------------------------ *
 *  Lumen — a desktop non-linear video editor interface
 * ------------------------------------------------------------------ */

type Tool = 'select' | 'razor' | 'hand' | 'zoom' | 'text' | 'transition'

type Clip = {
  id: string
  name: string
  track: number
  start: number // in seconds
  duration: number
  kind: 'video' | 'audio' | 'title'
  color: string
  thumb?: string
}

type MediaAsset = {
  id: string
  name: string
  duration: string
  kind: 'video' | 'audio' | 'image'
  thumb: string
  meta: string
}

const AMBER = '#ffb020'

const FPS = 30
const TIMELINE_SECONDS = 96

const IMG = {
  cliff: 'https://images.unsplash.com/photo-1628015893843-5f7f6f6ccb01?w=480&h=270&fit=crop&auto=format',
  river: 'https://images.unsplash.com/photo-1475070929565-c985b496cb9f?w=480&h=270&fit=crop&auto=format',
  bridge: 'https://images.unsplash.com/photo-1618285545010-a44e4ffcd45b?w=480&h=270&fit=crop&auto=format',
  fog: 'https://images.unsplash.com/photo-1661124280301-ca0e33ceb438?w=480&h=270&fit=crop&auto=format',
  field: 'https://images.unsplash.com/photo-1636036567661-145deb7cc6ee?w=480&h=270&fit=crop&auto=format',
  host: 'https://images.unsplash.com/photo-1615104603156-3dc403ca7cc8?w=480&h=270&fit=crop&auto=format',
}

const MEDIA: MediaAsset[] = [
  { id: 'm1', name: 'establishing_cliff_4k.mov', duration: '00:14:08', kind: 'video', thumb: IMG.cliff, meta: '3840×2160 · ProRes' },
  { id: 'm2', name: 'river_dolly_02.mov', duration: '00:09:22', kind: 'video', thumb: IMG.river, meta: '3840×2160 · ProRes' },
  { id: 'm3', name: 'host_interview_A.mp4', duration: '02:41:15', kind: 'video', thumb: IMG.host, meta: '1920×1080 · H.264' },
  { id: 'm4', name: 'valley_fog_drone.mov', duration: '00:31:04', kind: 'video', thumb: IMG.fog, meta: '3840×2160 · ProRes' },
  { id: 'm5', name: 'stone_bridge_pan.mov', duration: '00:12:18', kind: 'video', thumb: IMG.bridge, meta: '3840×2160 · ProRes' },
  { id: 'm6', name: 'window_field_bts.mov', duration: '00:22:11', kind: 'image', thumb: IMG.field, meta: '6000×4000 · RAW' },
]

const CLIPS: Clip[] = [
  { id: 'c1', name: 'establishing_cliff', track: 0, start: 0, duration: 14, kind: 'video', color: '#3d6fe0', thumb: IMG.cliff },
  { id: 'c2', name: 'valley_fog_drone', track: 0, start: 14, duration: 18, kind: 'video', color: '#3d6fe0', thumb: IMG.fog },
  { id: 'c3', name: 'river_dolly_02', track: 0, start: 32, duration: 9, kind: 'video', color: '#3d6fe0', thumb: IMG.river },
  { id: 'c4', name: 'host_interview_A', track: 0, start: 41, duration: 26, kind: 'video', color: '#3d6fe0', thumb: IMG.host },
  { id: 'c5', name: 'stone_bridge_pan', track: 0, start: 67, duration: 13, kind: 'video', color: '#3d6fe0', thumb: IMG.bridge },
  { id: 't1', name: 'Lower Third — Ep.04', track: 1, start: 44, duration: 12, kind: 'title', color: '#8b7bff' },
  { id: 't2', name: 'Chapter 02', track: 1, start: 12, duration: 8, kind: 'title', color: '#8b7bff' },
  { id: 'a1', name: 'score_ambient_bed.wav', track: 2, start: 0, duration: 52, kind: 'audio', color: '#2f9e8f' },
  { id: 'a2', name: 'vo_narration_04.wav', track: 3, start: 41, duration: 26, kind: 'audio', color: '#2f9e8f' },
  { id: 'a3', name: 'foley_river.wav', track: 3, start: 32, duration: 9, kind: 'audio', color: '#2f9e8f' },
]

const TRACKS = [
  { id: 0, label: 'V2', type: 'video' as const, name: 'Main' },
  { id: 1, label: 'V1', type: 'video' as const, name: 'Titles' },
  { id: 2, label: 'A1', type: 'audio' as const, name: 'Score' },
  { id: 3, label: 'A2', type: 'audio' as const, name: 'Dialogue' },
]

function fmtTC(totalSeconds: number) {
  const s = Math.max(0, totalSeconds)
  const hh = Math.floor(s / 3600)
  const mm = Math.floor((s % 3600) / 60)
  const ss = Math.floor(s % 60)
  const ff = Math.floor((s * FPS) % FPS)
  const p = (n: number) => n.toString().padStart(2, '0')
  return `${p(hh)}:${p(mm)}:${p(ss)}:${p(ff)}`
}

/* ------------------------------- Icons ------------------------------- */
function Icon({ path, size = 18, stroke = 1.6 }: { path: string; size?: number; stroke?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round">
      <path d={path} />
    </svg>
  )
}
const P = {
  cursor: 'M5 3l6 16 2.5-6.5L20 10 5 3z',
  razor: 'M6 3v10m0 0a3 3 0 103 3M6 13l12-10M18 21a3 3 0 100-6 3 3 0 000 6z',
  hand: 'M6 11V6a1.5 1.5 0 013 0v4m0-4V5a1.5 1.5 0 013 0v5m0-4a1.5 1.5 0 013 0v4m0 0a1.5 1.5 0 013 0v3a6 6 0 01-6 6h-2a6 6 0 01-5-2.7L5 15a1.5 1.5 0 012.3-1.9L9 15',
  zoom: 'M11 19a8 8 0 100-16 8 8 0 000 16zm10 2l-4.3-4.3M8 11h6M11 8v6',
  text: 'M5 5h14M12 5v14M9 19h6',
  transition: 'M3 12h6m6 0h6M12 3v6m0 6v6M9 9l6 6m0-6l-6 6',
  play: 'M6 4l14 8-14 8V4z',
  pause: 'M8 5v14M16 5v14',
  skipBack: 'M19 5v14L9 12l10-7zM5 5v14',
  skipFwd: 'M5 5v14l10-7L5 5zM19 5v14',
  loop: 'M4 9a8 8 0 0114-5l2 2M20 15a8 8 0 01-14 5l-2-2M17 3v4h-4M7 21v-4h4',
  volume: 'M11 5L6 9H3v6h3l5 4V5zM16 9a3 3 0 010 6M19 6a7 7 0 010 12',
  search: 'M11 19a8 8 0 100-16 8 8 0 000 16zm10 2l-4.3-4.3',
  plus: 'M12 5v14M5 12h14',
  video: 'M3 6h13v12H3zM16 10l5-3v10l-5-3',
  music: 'M9 18V6l10-2v12M9 18a3 3 0 11-6 0 3 3 0 016 0zm10-2a3 3 0 11-6 0 3 3 0 016 0z',
  image: 'M3 5h18v14H3zM3 15l5-5 4 4 3-3 6 6',
  wand: 'M15 4V2M15 10V8M12 7h-2M20 7h-2M17 3l-1.5 1.5M13.5 8.5L12 10M3 21l9-9M17 11l1.5 1.5',
  layers: 'M12 3l9 5-9 5-9-5 9-5zM3 13l9 5 9-5M3 17l9 5 9-5',
  scissors: 'M6 6a3 3 0 100 6 3 3 0 000-6zm0 6a3 3 0 100 6 3 3 0 000-6zm2.5-4.5L20 18M8.5 16.5L20 6',
  settings: 'M12 15a3 3 0 100-6 3 3 0 000 6zM19.4 15a1.6 1.6 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.6 1.6 0 00-2.7.7 1.6 1.6 0 01-3.2 0 1.6 1.6 0 00-2.7-.7l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.6 1.6 0 00-.7-2.7 1.6 1.6 0 010-3.2 1.6 1.6 0 00.7-2.7l-.1-.1a2 2 0 112.8-2.8l.1.1a1.6 1.6 0 002.7-.7 1.6 1.6 0 013.2 0 1.6 1.6 0 002.7.7l.1-.1a2 2 0 112.8 2.8l-.1.1a1.6 1.6 0 00.7 2.7 1.6 1.6 0 010 3.2z',
  export: 'M12 15V3m0 0L8 7m4-4l4 4M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2',
  undo: 'M9 14L4 9l5-5M4 9h11a5 5 0 010 10h-3',
  redo: 'M15 14l5-5-5-5M20 9H9a5 5 0 000 10h3',
  crop: 'M6 2v16h16M2 6h16v16M6 6h12v12',
  color: 'M12 21a9 9 0 110-18 7 7 0 010 14h-1.5a1.5 1.5 0 00-1 2.6c.3.3.5.7.5 1.1M8 12a1 1 0 100-2 1 1 0 000 2zm3-4a1 1 0 100-2 1 1 0 000 2zm5 0a1 1 0 100-2 1 1 0 000 2z',
  speed: 'M12 20a8 8 0 100-16 8 8 0 000 16zM12 12l3-3M12 12v-4',
  chevron: 'M9 6l6 6-6 6',
  grip: 'M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01',
  bell: 'M18 8a6 6 0 10-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 01-3.4 0',
}

/* ------------------------------- App ------------------------------- */
export default function App() {
  const [tool, setTool] = useState<Tool>('select')
  const [playing, setPlaying] = useState(false)
  const [loop, setLoop] = useState(true)
  const [playhead, setPlayhead] = useState(23.4) // seconds
  const [zoom, setZoom] = useState(15) // px per second
  const [mediaTab, setMediaTab] = useState<'media' | 'effects' | 'audio'>('media')
  const [inspectorTab, setInspectorTab] = useState<'video' | 'color' | 'audio'>('video')
  const [selectedClip, setSelectedClip] = useState<string | null>('c4')
  const [query, setQuery] = useState('')

  const rafRef = useRef<number | null>(null)
  const lastRef = useRef<number>(0)

  // playback loop
  useEffect(() => {
    if (!playing) return
    lastRef.current = performance.now()
    const tick = (now: number) => {
      const dt = (now - lastRef.current) / 1000
      lastRef.current = now
      setPlayhead((p) => {
        let next = p + dt
        if (next >= TIMELINE_SECONDS) next = loop ? 0 : TIMELINE_SECONDS
        return next
      })
      rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
    }
  }, [playing, loop])

  // keyboard: space to play/pause
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === 'Space' && !(e.target as HTMLElement)?.matches('input,textarea')) {
        e.preventDefault()
        setPlaying((p) => !p)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const activeMedia = MEDIA.filter((m) => m.name.toLowerCase().includes(query.toLowerCase()))
  const selected = CLIPS.find((c) => c.id === selectedClip) ?? null

  // Which clip is under the playhead on the top video track — drives the monitor
  const programClip = useMemo(() => {
    return (
      CLIPS.filter((c) => c.track === 0).find((c) => playhead >= c.start && playhead < c.start + c.duration) ??
      CLIPS[0]
    )
  }, [playhead])

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-[var(--color-ink)] text-[var(--color-fg)] text-[13px]">
      <TitleBar />
      <MenuBar tool={tool} setTool={setTool} />

      {/* main working area */}
      <div className="grid min-h-0 flex-1 grid-cols-[64px_320px_1fr_300px]">
        <ToolRail tool={tool} setTool={setTool} />
        <MediaPanel
          tab={mediaTab}
          setTab={setMediaTab}
          media={activeMedia}
          query={query}
          setQuery={setQuery}
        />
        <MonitorPanel
          clip={programClip}
          playhead={playhead}
          playing={playing}
          setPlaying={setPlaying}
          loop={loop}
          setLoop={setLoop}
          setPlayhead={setPlayhead}
        />
        <Inspector tab={inspectorTab} setTab={setInspectorTab} clip={selected} />
      </div>

      <Timeline
        clips={CLIPS}
        playhead={playhead}
        setPlayhead={setPlayhead}
        zoom={zoom}
        setZoom={setZoom}
        selectedClip={selectedClip}
        setSelectedClip={setSelectedClip}
        tool={tool}
      />
      <StatusBar playhead={playhead} tool={tool} zoom={zoom} />
    </div>
  )
}

/* ------------------------------ TitleBar ------------------------------ */
function TitleBar() {
  return (
    <div className="flex h-9 shrink-0 items-center justify-between border-b border-[var(--color-line)] bg-[var(--color-panel)] px-3">
      <div className="flex items-center gap-2">
        <div className="flex gap-1.5 pr-2">
          <span className="h-3 w-3 rounded-full bg-[#ff5f56]" />
          <span className="h-3 w-3 rounded-full bg-[#ffbd2e]" />
          <span className="h-3 w-3 rounded-full bg-[#27c93f]" />
        </div>
        <div className="flex items-center gap-2 pl-1">
          <div className="grid h-5 w-5 place-items-center rounded-[5px] bg-[var(--color-amber)] text-[11px] font-bold text-black">
            L
          </div>
          <span className="text-[12px] font-semibold tracking-tight">Lumen Studio</span>
        </div>
      </div>
      <div className="flex items-center gap-2 text-[12px] text-[var(--color-fg-dim)]">
        <span className="font-medium text-[var(--color-fg)]">Nordland_Ep04</span>
        <span className="text-[var(--color-fg-mute)]">·</span>
        <span>3840×2160 · 30 fps</span>
        <span className="ml-1 rounded-full bg-[var(--color-elev)] px-2 py-0.5 text-[11px] text-[var(--color-fg-dim)]">
          Autosaved 2m ago
        </span>
      </div>
      <div className="flex items-center gap-2">
        <button className="grid h-7 w-7 place-items-center rounded-md text-[var(--color-fg-dim)] transition hover:bg-[var(--color-elev)] hover:text-[var(--color-fg)]">
          <Icon path={P.bell} size={16} />
        </button>
        <div className="flex -space-x-2">
          <span className="grid h-6 w-6 place-items-center rounded-full border border-[var(--color-panel)] bg-[#8b7bff] text-[10px] font-semibold text-white">MK</span>
          <span className="grid h-6 w-6 place-items-center rounded-full border border-[var(--color-panel)] bg-[#2f9e8f] text-[10px] font-semibold text-white">JD</span>
        </div>
        <button className="flex items-center gap-1.5 rounded-md bg-[var(--color-amber)] px-3 py-1.5 text-[12px] font-semibold text-black transition hover:brightness-110">
          <Icon path={P.export} size={15} stroke={2} />
          Export
        </button>
      </div>
    </div>
  )
}

/* ------------------------------ MenuBar ------------------------------ */
function MenuBar({ tool, setTool }: { tool: Tool; setTool: (t: Tool) => void }) {
  return (
    <div className="flex h-10 shrink-0 items-center gap-1 border-b border-[var(--color-line)] bg-[var(--color-panel-2)] px-3">
      <MenuButton icon={P.undo} label="Undo" />
      <MenuButton icon={P.redo} label="Redo" />
      <Sep />
      <MenuButton icon={P.scissors} label="Split" onClick={() => setTool('razor')} active={tool === 'razor'} />
      <MenuButton icon={P.wand} label="Auto-cut" />
      <MenuButton icon={P.speed} label="Speed" />
      <MenuButton icon={P.transition} label="Transition" onClick={() => setTool('transition')} active={tool === 'transition'} />
      <Sep />
      <div className="flex items-center gap-2 rounded-md bg-[var(--color-elev)] px-2.5 py-1.5">
        <Icon path={P.wand} size={15} />
        <span className="text-[12px] font-medium">Enhance with AI</span>
        <span className="rounded bg-[var(--color-amber-soft)] px-1.5 py-0.5 text-[10px] font-semibold text-[var(--color-amber)]">BETA</span>
      </div>
      <div className="ml-auto flex items-center gap-1">
        {(['Edit', 'Color', 'Audio', 'Deliver'] as const).map((w, i) => (
          <button
            key={w}
            className={`rounded-md px-3 py-1.5 text-[12px] font-medium transition ${
              i === 0
                ? 'bg-[var(--color-elev)] text-[var(--color-fg)]'
                : 'text-[var(--color-fg-dim)] hover:text-[var(--color-fg)]'
            }`}
          >
            {w}
          </button>
        ))}
      </div>
    </div>
  )
}
function MenuButton({ icon, label, onClick, active }: { icon: string; label: string; onClick?: () => void; active?: boolean }) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[12px] transition ${
        active
          ? 'bg-[var(--color-amber-soft)] text-[var(--color-amber)]'
          : 'text-[var(--color-fg-dim)] hover:bg-[var(--color-elev)] hover:text-[var(--color-fg)]'
      }`}
    >
      <Icon path={icon} size={15} />
      {label}
    </button>
  )
}
function Sep() {
  return <div className="mx-1 h-5 w-px bg-[var(--color-line)]" />
}

/* ------------------------------ ToolRail ------------------------------ */
function ToolRail({ tool, setTool }: { tool: Tool; setTool: (t: Tool) => void }) {
  const tools: { id: Tool; icon: string; label: string; key: string }[] = [
    { id: 'select', icon: P.cursor, label: 'Select', key: 'V' },
    { id: 'razor', icon: P.razor, label: 'Razor', key: 'C' },
    { id: 'hand', icon: P.hand, label: 'Hand', key: 'H' },
    { id: 'zoom', icon: P.zoom, label: 'Zoom', key: 'Z' },
    { id: 'text', icon: P.text, label: 'Text', key: 'T' },
    { id: 'transition', icon: P.transition, label: 'Transition', key: 'X' },
  ]
  return (
    <div className="flex flex-col items-center gap-1 border-r border-[var(--color-line)] bg-[var(--color-panel)] py-3">
      {tools.map((t) => (
        <button
          key={t.id}
          onClick={() => setTool(t.id)}
          title={`${t.label} (${t.key})`}
          className={`group relative grid h-10 w-10 place-items-center rounded-lg transition ${
            tool === t.id
              ? 'bg-[var(--color-amber)] text-black'
              : 'text-[var(--color-fg-dim)] hover:bg-[var(--color-elev)] hover:text-[var(--color-fg)]'
          }`}
        >
          <Icon path={t.icon} size={19} />
        </button>
      ))}
      <div className="my-2 h-px w-8 bg-[var(--color-line)]" />
      <button className="grid h-10 w-10 place-items-center rounded-lg text-[var(--color-fg-dim)] transition hover:bg-[var(--color-elev)] hover:text-[var(--color-fg)]">
        <Icon path={P.crop} size={19} />
      </button>
      <button className="grid h-10 w-10 place-items-center rounded-lg text-[var(--color-fg-dim)] transition hover:bg-[var(--color-elev)] hover:text-[var(--color-fg)]">
        <Icon path={P.color} size={19} />
      </button>
      <div className="mt-auto">
        <button className="grid h-10 w-10 place-items-center rounded-lg text-[var(--color-fg-dim)] transition hover:bg-[var(--color-elev)] hover:text-[var(--color-fg)]">
          <Icon path={P.settings} size={19} />
        </button>
      </div>
    </div>
  )
}

/* ---------------------------- Media Panel ---------------------------- */
function MediaPanel({
  tab,
  setTab,
  media,
  query,
  setQuery,
}: {
  tab: 'media' | 'effects' | 'audio'
  setTab: (t: 'media' | 'effects' | 'audio') => void
  media: MediaAsset[]
  query: string
  setQuery: (q: string) => void
}) {
  const tabs = [
    { id: 'media' as const, label: 'Media', icon: P.video },
    { id: 'effects' as const, label: 'Effects', icon: P.wand },
    { id: 'audio' as const, label: 'Audio', icon: P.music },
  ]
  const effects = [
    { name: 'Cinematic Fade', tag: 'Transition', c: '#8b7bff' },
    { name: 'Film Grain 35mm', tag: 'Overlay', c: '#ff6b8b' },
    { name: 'Cross Dissolve', tag: 'Transition', c: '#8b7bff' },
    { name: 'Gaussian Blur', tag: 'Blur', c: '#34d3c2' },
    { name: 'Light Leaks', tag: 'Overlay', c: '#ff6b8b' },
    { name: 'Glitch Warp', tag: 'Distort', c: '#ffb020' },
  ]
  return (
    <div className="flex min-h-0 flex-col border-r border-[var(--color-line)] bg-[var(--color-panel)]">
      {/* tab row */}
      <div className="flex shrink-0 items-center gap-1 border-b border-[var(--color-line)] px-2 pt-2">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`flex items-center gap-1.5 rounded-t-md px-3 py-2 text-[12px] font-medium transition ${
              tab === t.id
                ? 'border-b-2 border-[var(--color-amber)] text-[var(--color-fg)]'
                : 'border-b-2 border-transparent text-[var(--color-fg-dim)] hover:text-[var(--color-fg)]'
            }`}
          >
            <Icon path={t.icon} size={15} />
            {t.label}
          </button>
        ))}
      </div>

      {/* search / actions */}
      <div className="flex shrink-0 items-center gap-2 px-3 py-2.5">
        <div className="flex flex-1 items-center gap-2 rounded-md border border-[var(--color-line)] bg-[var(--color-ink)] px-2.5 py-1.5">
          <Icon path={P.search} size={14} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search bins…"
            className="w-full bg-transparent text-[12px] text-[var(--color-fg)] placeholder:text-[var(--color-fg-mute)] focus:outline-none"
          />
        </div>
        <button className="grid h-8 w-8 shrink-0 place-items-center rounded-md border border-[var(--color-line)] text-[var(--color-fg-dim)] transition hover:border-[var(--color-amber)] hover:text-[var(--color-amber)]">
          <Icon path={P.plus} size={16} />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
        {tab === 'media' && (
          <>
            <SectionLabel>Project bin · {media.length} clips</SectionLabel>
            <div className="grid grid-cols-2 gap-2">
              {media.map((m) => (
                <MediaCard key={m.id} m={m} />
              ))}
            </div>
          </>
        )}
        {tab === 'effects' && (
          <>
            <SectionLabel>Effects library</SectionLabel>
            <div className="flex flex-col gap-1.5">
              {effects.map((e) => (
                <div
                  key={e.name}
                  className="group flex cursor-grab items-center gap-3 rounded-md border border-[var(--color-line-soft)] bg-[var(--color-panel-2)] px-3 py-2.5 transition hover:border-[var(--color-line)]"
                >
                  <span className="h-8 w-8 shrink-0 rounded-md" style={{ background: `linear-gradient(135deg, ${e.c}, transparent)` }} />
                  <div className="min-w-0">
                    <div className="truncate text-[12px] font-medium">{e.name}</div>
                    <div className="text-[11px] text-[var(--color-fg-mute)]">{e.tag}</div>
                  </div>
                  <Icon path={P.grip} size={16} />
                </div>
              ))}
            </div>
          </>
        )}
        {tab === 'audio' && (
          <>
            <SectionLabel>Audio & music</SectionLabel>
            <div className="flex flex-col gap-1.5">
              {['Ambient Bed — Nordic', 'Tension Riser 04', 'Wind Foley Loop', 'Sub Impact Hit', 'Warm Vinyl Crackle'].map(
                (name, i) => (
                  <div
                    key={name}
                    className="flex items-center gap-3 rounded-md border border-[var(--color-line-soft)] bg-[var(--color-panel-2)] px-3 py-2.5"
                  >
                    <button className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-[var(--color-elev)] text-[var(--color-amber)]">
                      <Icon path={P.play} size={13} />
                    </button>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[12px] font-medium">{name}</div>
                      <MiniWave seed={i} />
                    </div>
                    <span className="font-mono text-[11px] text-[var(--color-fg-mute)]">0:{(18 + i * 7) % 60}</span>
                  </div>
                ),
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function MediaCard({ m }: { m: MediaAsset }) {
  return (
    <div className="group cursor-grab overflow-hidden rounded-lg border border-[var(--color-line-soft)] bg-[var(--color-panel-2)] transition hover:border-[var(--color-line)]">
      <div className="relative aspect-video overflow-hidden bg-[var(--color-elev)]">
        <img src={m.thumb} alt={m.name} className="h-full w-full object-cover transition duration-500 group-hover:scale-105" />
        <div className="absolute inset-x-0 bottom-0 flex items-center justify-between bg-gradient-to-t from-black/80 to-transparent px-1.5 pb-1 pt-4">
          <span className="rounded bg-black/60 px-1 py-0.5 font-mono text-[9px] text-white/90">{m.duration}</span>
          <span className="grid h-4 w-4 place-items-center rounded bg-black/60 text-white/90">
            <Icon path={m.kind === 'image' ? P.image : P.video} size={10} />
          </span>
        </div>
      </div>
      <div className="px-2 py-1.5">
        <div className="truncate text-[11px] font-medium text-[var(--color-fg)]">{m.name}</div>
        <div className="truncate text-[10px] text-[var(--color-fg-mute)]">{m.meta}</div>
      </div>
    </div>
  )
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-2 mt-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--color-fg-mute)]">
      {children}
    </div>
  )
}

function MiniWave({ seed }: { seed: number }) {
  const bars = Array.from({ length: 28 }, (_, i) => 20 + ((Math.sin(i * 1.3 + seed) + 1) / 2) * 80)
  return (
    <div className="mt-1 flex h-3 items-center gap-[2px]">
      {bars.map((h, i) => (
        <span key={i} className="w-[2px] rounded-full bg-[var(--color-teal)]/50" style={{ height: `${h}%` }} />
      ))}
    </div>
  )
}

/* ---------------------------- Monitor Panel ---------------------------- */
function MonitorPanel({
  clip,
  playhead,
  playing,
  setPlaying,
  loop,
  setLoop,
  setPlayhead,
}: {
  clip: Clip
  playhead: number
  playing: boolean
  setPlaying: (v: boolean | ((p: boolean) => boolean)) => void
  loop: boolean
  setLoop: (v: boolean | ((p: boolean) => boolean)) => void
  setPlayhead: (v: number) => void
}) {
  const pct = (playhead / TIMELINE_SECONDS) * 100
  return (
    <div className="flex min-h-0 flex-col bg-[var(--color-ink)]">
      <div className="flex shrink-0 items-center justify-between px-4 py-2.5">
        <div className="flex items-center gap-2">
          <span className="text-[12px] font-semibold">Program</span>
          <span className="text-[11px] text-[var(--color-fg-mute)]">Timeline · Nordland_Ep04</span>
        </div>
        <div className="flex items-center gap-1.5 text-[11px] text-[var(--color-fg-dim)]">
          <button className="rounded bg-[var(--color-elev)] px-2 py-1 font-medium text-[var(--color-fg)]">Fit</button>
          <button className="rounded px-2 py-1 hover:bg-[var(--color-elev)]">100%</button>
          <button className="rounded px-2 py-1 hover:bg-[var(--color-elev)]">Full</button>
        </div>
      </div>

      {/* viewport */}
      <div className="flex min-h-0 flex-1 items-center justify-center px-6">
        <div className="relative aspect-video w-full max-w-[840px] overflow-hidden rounded-xl border border-[var(--color-line)] bg-black shadow-2xl shadow-black/60">
          <img src={clip.thumb} alt={clip.name} className="h-full w-full object-cover" />
          {/* letterbox + safe area guides */}
          <div className="pointer-events-none absolute inset-0">
            <div className="absolute inset-[6%] rounded-sm border border-white/15" />
            <div className="absolute inset-[12%] rounded-sm border border-dashed border-white/10" />
          </div>
          {/* overlay title example */}
          <div className="pointer-events-none absolute bottom-8 left-8">
            <div className="mb-1.5 h-[3px] w-10 bg-[var(--color-amber)]" />
            <div className="text-[22px] font-semibold leading-tight text-white drop-shadow">Chapter 04 — The Fjord</div>
            <div className="text-[13px] text-white/70">Directed field recording · Nordland</div>
          </div>
          {/* HUD */}
          <div className="absolute left-3 top-3 flex items-center gap-2">
            {playing && (
              <span className="flex items-center gap-1.5 rounded bg-black/50 px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-[#ff5f56] backdrop-blur">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[#ff5f56]" /> Playing
              </span>
            )}
          </div>
          <div className="absolute right-3 top-3 rounded bg-black/50 px-2 py-1 font-mono text-[11px] text-white/90 backdrop-blur">
            {fmtTC(playhead)}
          </div>
        </div>
      </div>

      {/* transport */}
      <div className="shrink-0 px-6 py-3">
        {/* scrub bar */}
        <div
          className="group relative mb-3 h-1.5 cursor-pointer rounded-full bg-[var(--color-elev)]"
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect()
            setPlayhead(((e.clientX - r.left) / r.width) * TIMELINE_SECONDS)
          }}
        >
          <div className="absolute inset-y-0 left-0 rounded-full bg-[var(--color-amber)]" style={{ width: `${pct}%` }} />
          <div
            className="absolute top-1/2 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-[var(--color-ink)] bg-white shadow"
            style={{ left: `${pct}%` }}
          />
        </div>

        <div className="flex items-center justify-between">
          <span className="font-mono text-[13px] font-medium text-[var(--color-fg)]">{fmtTC(playhead)}</span>

          <div className="flex items-center gap-1">
            <TransportBtn icon={P.skipBack} onClick={() => setPlayhead(Math.max(0, playhead - 5))} />
            <button
              onClick={() => setPlaying((p) => !p)}
              className="grid h-11 w-11 place-items-center rounded-full bg-[var(--color-amber)] text-black transition hover:brightness-110"
            >
              <Icon path={playing ? P.pause : P.play} size={20} stroke={2.2} />
            </button>
            <TransportBtn icon={P.skipFwd} onClick={() => setPlayhead(Math.min(TIMELINE_SECONDS, playhead + 5))} />
            <TransportBtn icon={P.loop} onClick={() => setLoop((l) => !l)} active={loop} />
          </div>

          <div className="flex items-center gap-2 text-[var(--color-fg-dim)]">
            <Icon path={P.volume} size={16} />
            <input type="range" defaultValue={72} className="w-20" />
          </div>
        </div>
      </div>
    </div>
  )
}

function TransportBtn({ icon, onClick, active }: { icon: string; onClick?: () => void; active?: boolean }) {
  return (
    <button
      onClick={onClick}
      className={`grid h-9 w-9 place-items-center rounded-full transition ${
        active ? 'text-[var(--color-amber)]' : 'text-[var(--color-fg-dim)] hover:bg-[var(--color-elev)] hover:text-[var(--color-fg)]'
      }`}
    >
      <Icon path={icon} size={18} />
    </button>
  )
}

/* ------------------------------ Inspector ------------------------------ */
function Inspector({
  tab,
  setTab,
  clip,
}: {
  tab: 'video' | 'color' | 'audio'
  setTab: (t: 'video' | 'color' | 'audio') => void
  clip: Clip | null
}) {
  const tabs = [
    { id: 'video' as const, label: 'Transform', icon: P.crop },
    { id: 'color' as const, label: 'Color', icon: P.color },
    { id: 'audio' as const, label: 'Audio', icon: P.volume },
  ]
  return (
    <div className="flex min-h-0 flex-col border-l border-[var(--color-line)] bg-[var(--color-panel)]">
      <div className="shrink-0 border-b border-[var(--color-line)] px-4 py-3">
        <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--color-fg-mute)]">Inspector</div>
        <div className="mt-1 flex items-center gap-2">
          <span className="h-2 w-2 rounded-full" style={{ background: clip?.color ?? 'var(--color-fg-mute)' }} />
          <span className="truncate text-[13px] font-semibold">{clip?.name ?? 'No clip selected'}</span>
        </div>
      </div>

      <div className="flex shrink-0 border-b border-[var(--color-line)]">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`flex flex-1 items-center justify-center gap-1.5 py-2.5 text-[11px] font-medium transition ${
              tab === t.id
                ? 'border-b-2 border-[var(--color-amber)] text-[var(--color-fg)]'
                : 'border-b-2 border-transparent text-[var(--color-fg-dim)] hover:text-[var(--color-fg)]'
            }`}
          >
            <Icon path={t.icon} size={14} />
            {t.label}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {!clip ? (
          <div className="mt-10 text-center text-[12px] text-[var(--color-fg-mute)]">
            Select a clip on the timeline to edit its properties.
          </div>
        ) : tab === 'video' ? (
          <div className="flex flex-col gap-5">
            <Group title="Transform">
              <Slider label="Scale" value={100} min={0} max={200} unit="%" />
              <Row>
                <NumberField label="Position X" value={0} />
                <NumberField label="Position Y" value={0} />
              </Row>
              <Slider label="Rotation" value={0} min={-180} max={180} unit="°" />
              <Slider label="Opacity" value={100} min={0} max={100} unit="%" />
            </Group>
            <Group title="Speed & Duration">
              <Slider label="Speed" value={100} min={10} max={400} unit="%" accent />
              <Toggle label="Optical flow interpolation" on />
              <Toggle label="Reverse clip" />
            </Group>
          </div>
        ) : tab === 'color' ? (
          <div className="flex flex-col gap-5">
            <Group title="Color Wheels">
              <div className="grid grid-cols-3 gap-3">
                {['Lift', 'Gamma', 'Gain'].map((w) => (
                  <div key={w} className="flex flex-col items-center gap-1.5">
                    <div className="relative h-16 w-16 rounded-full bg-[conic-gradient(from_0deg,#ff6b6b,#ffd93b,#6bcB77,#4d96ff,#b06bff,#ff6b6b)]">
                      <div className="absolute inset-[3px] rounded-full bg-[var(--color-panel-2)]" />
                      <div className="absolute left-1/2 top-1/2 h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white shadow" />
                    </div>
                    <span className="text-[11px] text-[var(--color-fg-dim)]">{w}</span>
                  </div>
                ))}
              </div>
            </Group>
            <Group title="Primaries">
              <Slider label="Temperature" value={20} min={-100} max={100} accent />
              <Slider label="Tint" value={-8} min={-100} max={100} />
              <Slider label="Contrast" value={12} min={-100} max={100} />
              <Slider label="Saturation" value={108} min={0} max={200} unit="%" />
            </Group>
            <div className="flex items-center gap-2 rounded-md border border-[var(--color-line)] bg-[var(--color-panel-2)] px-3 py-2.5">
              <Icon path={P.layers} size={15} />
              <span className="text-[12px]">LUT: <span className="font-medium">Fjord_Teal.cube</span></span>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-5">
            <Group title="Levels">
              <Slider label="Volume" value={-4} min={-60} max={12} unit="dB" accent />
              <Slider label="Pan" value={0} min={-100} max={100} />
              <div className="flex items-end gap-1 pt-1">
                <VuMeter label="L" level={0.72} />
                <VuMeter label="R" level={0.64} />
              </div>
            </Group>
            <Group title="Effects">
              <Toggle label="Noise reduction" on />
              <Toggle label="De-esser" />
              <Toggle label="Voice isolation (AI)" on />
              <Toggle label="Normalize loudness" />
            </Group>
          </div>
        )}
      </div>
    </div>
  )
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-2.5 flex items-center justify-between">
        <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--color-fg-mute)]">{title}</span>
        <Icon path={P.chevron} size={13} />
      </div>
      <div className="flex flex-col gap-3.5">{children}</div>
    </div>
  )
}
function Row({ children }: { children: React.ReactNode }) {
  return <div className="grid grid-cols-2 gap-2">{children}</div>
}

function Slider({
  label,
  value,
  min,
  max,
  unit = '',
  accent,
}: {
  label: string
  value: number
  min: number
  max: number
  unit?: string
  accent?: boolean
}) {
  const [v, setV] = useState(value)
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-[12px] text-[var(--color-fg-dim)]">{label}</span>
        <span className={`font-mono text-[11px] ${accent ? 'text-[var(--color-amber)]' : 'text-[var(--color-fg)]'}`}>
          {v}
          {unit}
        </span>
      </div>
      <input type="range" min={min} max={max} value={v} onChange={(e) => setV(Number(e.target.value))} className="w-full" />
    </div>
  )
}

function NumberField({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <div className="mb-1.5 text-[11px] text-[var(--color-fg-dim)]">{label}</div>
      <input
        defaultValue={value}
        className="w-full rounded-md border border-[var(--color-line)] bg-[var(--color-ink)] px-2.5 py-1.5 font-mono text-[12px] text-[var(--color-fg)] focus:border-[var(--color-amber)] focus:outline-none"
      />
    </div>
  )
}

function Toggle({ label, on }: { label: string; on?: boolean }) {
  const [v, setV] = useState(!!on)
  return (
    <button onClick={() => setV(!v)} className="flex items-center justify-between">
      <span className="text-[12px] text-[var(--color-fg-dim)]">{label}</span>
      <span className={`relative h-[18px] w-8 rounded-full transition ${v ? 'bg-[var(--color-amber)]' : 'bg-[var(--color-elev)]'}`}>
        <span
          className={`absolute top-[2px] h-[14px] w-[14px] rounded-full bg-white transition-all ${v ? 'left-[16px]' : 'left-[2px]'}`}
        />
      </span>
    </button>
  )
}

function VuMeter({ label, level }: { label: string; level: number }) {
  const segs = 16
  const lit = Math.round(level * segs)
  return (
    <div className="flex flex-1 flex-col items-center gap-1">
      <div className="flex h-24 w-full flex-col-reverse gap-[2px]">
        {Array.from({ length: segs }).map((_, i) => {
          const active = i < lit
          const color = i > segs - 3 ? '#ff6b8b' : i > segs - 7 ? '#ffb020' : '#34d3c2'
          return (
            <span
              key={i}
              className="w-full rounded-[1px] transition"
              style={{ flex: 1, background: active ? color : 'var(--color-elev)' }}
            />
          )
        })}
      </div>
      <span className="text-[10px] text-[var(--color-fg-mute)]">{label}</span>
    </div>
  )
}

/* ------------------------------- Timeline ------------------------------- */
function Timeline({
  clips,
  playhead,
  setPlayhead,
  zoom,
  setZoom,
  selectedClip,
  setSelectedClip,
  tool,
}: {
  clips: Clip[]
  playhead: number
  setPlayhead: (v: number) => void
  zoom: number
  setZoom: (v: number) => void
  selectedClip: string | null
  setSelectedClip: (id: string) => void
  tool: Tool
}) {
  const laneRef = useRef<HTMLDivElement>(null)
  const width = TIMELINE_SECONDS * zoom
  const trackH = 56
  const rulerSecs = zoom < 12 ? 10 : 5

  const scrubTo = (clientX: number) => {
    const el = laneRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const x = clientX - r.left + el.scrollLeft
    setPlayhead(Math.max(0, Math.min(TIMELINE_SECONDS, x / zoom)))
  }

  return (
    <div className="flex h-[300px] shrink-0 flex-col border-t border-[var(--color-line)] bg-[var(--color-panel)]">
      {/* timeline header */}
      <div className="flex h-11 shrink-0 items-center justify-between border-b border-[var(--color-line)] px-3">
        <div className="flex items-center gap-1">
          <span className="text-[12px] font-semibold">Timeline</span>
          <span className="ml-2 rounded bg-[var(--color-elev)] px-2 py-0.5 font-mono text-[11px] text-[var(--color-fg-dim)]">
            {fmtTC(playhead)}
          </span>
          <div className="mx-2 h-4 w-px bg-[var(--color-line)]" />
          <THeaderBtn icon={P.scissors} label="Split" />
          <THeaderBtn icon={P.layers} label="New track" />
          <THeaderBtn icon={P.wand} label="Ripple delete" />
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1.5 text-[var(--color-fg-dim)]">
            <button onClick={() => setZoom(Math.max(6, zoom - 3))} className="grid h-6 w-6 place-items-center rounded hover:bg-[var(--color-elev)]">
              <Icon path="M5 12h14" size={14} />
            </button>
            <input
              type="range"
              min={6}
              max={40}
              value={zoom}
              onChange={(e) => setZoom(Number(e.target.value))}
              className="w-24"
            />
            <button onClick={() => setZoom(Math.min(40, zoom + 3))} className="grid h-6 w-6 place-items-center rounded hover:bg-[var(--color-elev)]">
              <Icon path={P.plus} size={14} />
            </button>
          </div>
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* track headers */}
        <div className="w-[130px] shrink-0 border-r border-[var(--color-line)] bg-[var(--color-panel-2)]">
          <div className="h-7 border-b border-[var(--color-line)]" />
          {TRACKS.map((t) => (
            <div key={t.id} className="flex items-center gap-2 border-b border-[var(--color-line-soft)] px-2.5" style={{ height: trackH }}>
              <span
                className={`grid h-6 w-7 shrink-0 place-items-center rounded font-mono text-[11px] font-semibold ${
                  t.type === 'video' ? 'bg-[#20304e] text-[#8fb2ff]' : 'bg-[#1b3a35] text-[#6fe0d0]'
                }`}
              >
                {t.label}
              </span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-[11px] font-medium">{t.name}</div>
                <div className="mt-0.5 flex gap-1 text-[var(--color-fg-mute)]">
                  <span className="grid h-4 w-4 place-items-center rounded-sm bg-[var(--color-elev)] text-[9px] font-bold">M</span>
                  <span className="grid h-4 w-4 place-items-center rounded-sm bg-[var(--color-elev)] text-[9px] font-bold">S</span>
                  <span className="grid h-4 w-4 place-items-center rounded-sm bg-[var(--color-elev)]">
                    <Icon path="M12 3v18M5 12h14" size={9} />
                  </span>
                </div>
              </div>
            </div>
          ))}
        </div>

        {/* lanes + ruler */}
        <div ref={laneRef} className="relative min-w-0 flex-1 overflow-x-auto overflow-y-hidden">
          <div style={{ width }} className="relative">
            {/* ruler */}
            <div
              className="sticky top-0 z-20 h-7 cursor-ew-resize border-b border-[var(--color-line)] bg-[var(--color-panel-2)]"
              onMouseDown={(e) => {
                scrubTo(e.clientX)
                const move = (ev: MouseEvent) => scrubTo(ev.clientX)
                const up = () => {
                  window.removeEventListener('mousemove', move)
                  window.removeEventListener('mouseup', up)
                }
                window.addEventListener('mousemove', move)
                window.addEventListener('mouseup', up)
              }}
            >
              {Array.from({ length: Math.floor(TIMELINE_SECONDS / rulerSecs) + 1 }).map((_, i) => {
                const sec = i * rulerSecs
                return (
                  <div key={i} className="absolute top-0 h-full" style={{ left: sec * zoom }}>
                    <div className="h-2 w-px bg-[var(--color-line)]" />
                    <span className="absolute left-1 top-1.5 font-mono text-[9px] text-[var(--color-fg-mute)]">{fmtTC(sec).slice(3, 8)}</span>
                  </div>
                )
              })}
            </div>

            {/* track lanes */}
            <div className="relative">
              {TRACKS.map((t) => (
                <div
                  key={t.id}
                  className="relative border-b border-[var(--color-line-soft)]"
                  style={{ height: trackH, background: t.id % 2 ? 'var(--color-panel)' : 'var(--color-panel-2)' }}
                >
                  {clips
                    .filter((c) => c.track === t.id)
                    .map((c) => (
                      <TimelineClip
                        key={c.id}
                        clip={c}
                        zoom={zoom}
                        trackH={trackH}
                        selected={selectedClip === c.id}
                        onSelect={() => setSelectedClip(c.id)}
                        tool={tool}
                      />
                    ))}
                </div>
              ))}
            </div>

            {/* playhead */}
            <div className="pointer-events-none absolute top-0 bottom-0 z-30" style={{ left: playhead * zoom }}>
              <div className="absolute -left-[6px] top-0 h-0 w-0 border-l-[6px] border-r-[6px] border-t-[7px] border-l-transparent border-r-transparent border-t-[var(--color-amber)]" />
              <div className="h-full w-px bg-[var(--color-amber)]" />
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function TimelineClip({
  clip,
  zoom,
  trackH,
  selected,
  onSelect,
  tool,
}: {
  clip: Clip
  zoom: number
  trackH: number
  selected: boolean
  onSelect: () => void
  tool: Tool
}) {
  const left = clip.start * zoom
  const w = clip.duration * zoom
  const isAudio = clip.kind === 'audio'
  const isTitle = clip.kind === 'title'

  return (
    <div
      onClick={onSelect}
      className={`absolute top-1 overflow-hidden rounded-md border transition ${
        tool === 'razor' ? 'cursor-col-resize' : 'cursor-grab'
      } ${selected ? 'border-[var(--color-amber)] ring-1 ring-[var(--color-amber)]' : 'border-black/40'}`}
      style={{ left, width: w, height: trackH - 8, background: clip.color }}
    >
      {/* filmstrip for video */}
      {clip.kind === 'video' && clip.thumb && (
        <div className="absolute inset-0 flex opacity-70">
          {Array.from({ length: Math.max(1, Math.round(w / 52)) }).map((_, i) => (
            <div key={i} className="h-full shrink-0" style={{ width: 52 }}>
              <img src={clip.thumb} alt="" className="h-full w-full object-cover" />
            </div>
          ))}
        </div>
      )}

      {/* audio waveform */}
      {isAudio && (
        <div className="absolute inset-x-0 bottom-0 top-4 flex items-center gap-[1.5px] px-1">
          {Array.from({ length: Math.max(4, Math.round(w / 4)) }).map((_, i) => {
            const h = 25 + ((Math.sin(i * 0.7) + Math.sin(i * 1.9)) + 2) / 4 * 70
            return <span key={i} className="w-[1.5px] rounded-full bg-white/60" style={{ height: `${h}%` }} />
          })}
        </div>
      )}

      {/* gradient scrim + label */}
      <div className="absolute inset-0 bg-gradient-to-b from-black/45 via-transparent to-black/25" />
      <div className="absolute left-0 right-0 top-0 flex items-center gap-1 px-1.5 py-1">
        {isTitle && <Icon path={P.text} size={11} />}
        {isAudio && <Icon path={P.music} size={11} />}
        <span className="truncate text-[10px] font-semibold text-white drop-shadow">{clip.name}</span>
      </div>

      {/* trim handles when selected */}
      {selected && (
        <>
          <span className="absolute inset-y-0 left-0 w-1.5 cursor-w-resize bg-[var(--color-amber)]" />
          <span className="absolute inset-y-0 right-0 w-1.5 cursor-e-resize bg-[var(--color-amber)]" />
        </>
      )}
    </div>
  )
}

function THeaderBtn({ icon, label }: { icon: string; label: string }) {
  return (
    <button className="flex items-center gap-1.5 rounded px-2 py-1 text-[11px] text-[var(--color-fg-dim)] transition hover:bg-[var(--color-elev)] hover:text-[var(--color-fg)]">
      <Icon path={icon} size={13} />
      {label}
    </button>
  )
}

/* ------------------------------- StatusBar ------------------------------- */
function StatusBar({ playhead, tool, zoom }: { playhead: number; tool: Tool; zoom: number }) {
  return (
    <div className="flex h-7 shrink-0 items-center justify-between border-t border-[var(--color-line)] bg-[var(--color-panel-2)] px-3 text-[11px] text-[var(--color-fg-mute)]">
      <div className="flex items-center gap-4">
        <span className="capitalize">Tool: <span className="text-[var(--color-fg-dim)]">{tool}</span></span>
        <span>Playhead: <span className="font-mono text-[var(--color-fg-dim)]">{fmtTC(playhead)}</span></span>
        <span>Zoom: <span className="text-[var(--color-fg-dim)]">{Math.round((zoom / 15) * 100)}%</span></span>
      </div>
      <div className="flex items-center gap-4">
        <span className="flex items-center gap-1.5">
          <span className="h-1.5 w-1.5 rounded-full bg-[var(--color-teal)]" /> GPU · Metal
        </span>
        <span>Cache 2.4 GB</span>
        <span className="text-[var(--color-fg-dim)]">Space to play · V/C/H tools</span>
      </div>
    </div>
  )
}
