import { useEffect, useState } from 'react'
import Overview from './pages/Overview'
import UnderTheHood from './pages/UnderTheHood'
import Explorer from './pages/Explorer'
import Notes from './pages/Notes'
import Search from './pages/Search'
import Filing from './pages/Filing'
import Analysis from './pages/Analysis'
import Analyses from './pages/Analyses'
import ModelPower from './components/ModelPower'
import Gate from './components/Gate'
import Users from './pages/Users'
import { signOut } from './auth'

const pages = [
  { id: 'overview', label: 'Overview', el: Overview },
  { id: 'search', label: 'Search filings', el: Search },
  { id: 'analyses', label: 'My analyses', el: Analyses },
  { id: 'build', label: 'Under the hood', el: UnderTheHood },
  { id: 'results', label: 'Test results', el: Explorer },
  { id: 'notes', label: 'Model notes', el: Notes },
  { id: 'users', label: 'Who’s online', el: Users },
] as const

type Route = { page: string; cik?: string; accession?: string; id?: string }

const readRoute = (): Route => {
  const parts = window.location.hash.replace('#/', '').split('/')
  if (parts[0] === 'filing' && /^\d+$/.test(parts[1] ?? '') && /^\d{10}-\d{2}-\d{6}$/.test(parts[2] ?? '')) {
    return { page: 'filing', cik: parts[1], accession: parts[2] }
  }
  if (parts[0] === 'analysis' && /^[0-9a-f]{16}$/.test(parts[1] ?? '')) return { page: 'analysis', id: parts[1] }
  if (parts[0] === 'how' || parts[0] === 'models') return { page: 'build' } // the old pages were folded into "Under the hood"
  return { page: pages.find((p) => p.id === parts[0])?.id ?? 'overview' }
}

function Shell() {
  const [route, setRoute] = useState<Route>(readRoute)

  useEffect(() => {
    const on = () => {
      setRoute(readRoute())
      window.scrollTo({ top: 0 })
    }
    window.addEventListener('hashchange', on)
    return () => window.removeEventListener('hashchange', on)
  }, [])

  const active = route.page === 'filing' ? 'search' : route.page === 'analysis' ? 'analyses' : route.page
  const Current = pages.find((p) => p.id === route.page)?.el

  return (
    <>
      <header className="topbar">
        <div className="topbar-inner">
          <a className="brand" href="#/overview" aria-label="FilingLens home">
            <span className="brand-mark" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="8" r="3.5" />
                <path d="M5 20c0-3.9 3.1-7 7-7s7 3.1 7 7" />
              </svg>
            </span>
            <span>
              FilingLens
              <small>See what happened in any SEC 8-K</small>
            </span>
          </a>
          <nav aria-label="Main">
            {pages.map((p) => (
              <a key={p.id} href={`#/${p.id}`} className={p.id === active ? 'active' : ''} aria-current={p.id === active ? 'page' : undefined}>
                {p.label}
              </a>
            ))}
          </nav>
          <ModelPower />
          <button type="button" className="linklike signout" onClick={() => void signOut()} title="Sign out of this browser">Sign out</button>
        </div>
      </header>
      <main className="container">
        {route.page === 'filing' ? <Filing key={route.accession} cik={route.cik!} accession={route.accession!} /> : route.page === 'analysis' ? <Analysis key={route.id} id={route.id!} /> : Current && <Current />}
      </main>
      <footer className="footer">
        <div className="container">
          Reads public SEC filings. A research tool, not financial or legal advice. Scores are estimates from months the AI never saw.
        </div>
      </footer>
    </>
  )
}

export default function App() {
  return (
    <Gate>
      <Shell />
    </Gate>
  )
}
