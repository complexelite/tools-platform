import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

const apiBase = '/firecrawl';
const modes = [
  { id: 'scrape', title: 'Scrape', kicker: 'One page', icon: '↗', copy: 'Extract clean, readable content from a page.' },
  { id: 'search', title: 'Search', kicker: 'Find pages', icon: '⌕', copy: 'Search the web and bring useful page content back.' },
  { id: 'crawl', title: 'Crawl', kicker: 'Whole site', icon: '◎', copy: 'Follow a site from one starting URL and collect its pages.' },
  { id: 'map', title: 'Map', kicker: 'Discover URLs', icon: '⌘', copy: 'Find the pages available across a domain.' },
];

function safeUrl(raw) {
  try { const u = new URL(raw); return ['http:', 'https:'].includes(u.protocol) ? u.toString() : null; } catch { return null; }
}
function titleOf(item) { return item?.metadata?.title || item?.title || item?.url || item?.source || 'Untitled result'; }
function urlOf(item) { return item?.metadata?.sourceURL || item?.url || item?.source || ''; }
function snippetOf(item) { return item?.description || item?.metadata?.description || item?.markdown || item?.content || ''; }
function downloadJson(value, name) {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' });
  const href = URL.createObjectURL(blob); const link = document.createElement('a');
  link.href = href; link.download = `${name}-${new Date().toISOString().slice(0, 10)}.json`; link.click(); URL.revokeObjectURL(href);
}

function App() {
  const historyKey = `ce-firecrawl-history:${document.getElementById('root')?.dataset.userId || 'session'}`;
  const [mode, setMode] = useState('scrape');
  const [url, setUrl] = useState('');
  const [query, setQuery] = useState('');
  const [limit, setLimit] = useState('10');
  const [formats, setFormats] = useState(['markdown']);
  const [onlyMain, setOnlyMain] = useState(true);
  const [maxDepth, setMaxDepth] = useState('2');
  const [status, setStatus] = useState({ busy: false, message: '' });
  const [health, setHealth] = useState('checking');
  const [result, setResult] = useState(null);
  const [job, setJob] = useState(null);
  const [resultFilter, setResultFilter] = useState('');
  const [history, setHistory] = useState(() => {
    try { return JSON.parse(localStorage.getItem(historyKey) || '[]'); } catch { return []; }
  });

  useEffect(() => { setLimit(mode === 'search' ? '10' : mode === 'map' ? '100' : '50'); }, [mode]);

  const selectedMode = modes.find((item) => item.id === mode);
  const results = useMemo(() => {
    const data = result?.data;
    const list = Array.isArray(data) ? data
      : Array.isArray(data?.web) ? data.web
      : Array.isArray(data?.results) ? data.results
      : Array.isArray(data?.links) ? data.links.map((url) => typeof url === 'string' ? { url } : url)
      : Array.isArray(result?.links) ? result.links.map((url) => typeof url === 'string' ? { url } : url)
      : [];
    const needle = resultFilter.trim().toLowerCase();
    if (!needle) return list;
    return list.filter((item) => `${titleOf(item)} ${urlOf(item)} ${snippetOf(item)}`.toLowerCase().includes(needle));
  }, [result, resultFilter]);

  useEffect(() => {
    let alive = true;
    fetch(`${apiBase}/v0/health/readiness`, { credentials: 'same-origin' })
      .then((r) => { if (alive) setHealth(r.ok ? 'online' : 'offline'); })
      .catch(() => { if (alive) setHealth('offline'); });
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    if (!job?.id || ['completed', 'failed', 'cancelled'].includes(job.status)) return undefined;
    const timer = window.setInterval(async () => {
      try {
        const response = await fetch(`${apiBase}/v2/crawl/${encodeURIComponent(job.id)}`, { credentials: 'same-origin' });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Could not read crawl status.');
        setJob(data);
        if (['completed', 'failed', 'cancelled'].includes(data.status)) {
          setResult(data);
          setStatus({ busy: false, message: data.status === 'completed' ? 'Crawl complete' : `Crawl ${data.status}` });
        }
      } catch (error) { setStatus({ busy: true, message: error.message }); }
    }, 3000);
    return () => window.clearInterval(timer);
  }, [job?.id, job?.status]);

  function addHistory(kind, value) {
    const entry = { id: `${Date.now()}`, kind, target: value, at: new Date().toISOString() };
    const next = [entry, ...history].slice(0, 6);
    setHistory(next); localStorage.setItem(historyKey, JSON.stringify(next));
  }

  async function request(path, body, method = 'POST') {
    const response = await fetch(`${apiBase}${path}`, {
      method, credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.success === false) throw new Error(data.error || data.message || `Firecrawl returned ${response.status}.`);
    return data;
  }

  async function run(event) {
    event.preventDefault(); setResult(null); setJob(null); setResultFilter('');
    setStatus({ busy: true, message: 'Connecting to Firecrawl…' });
    try {
      let data;
      if (mode === 'search') {
        if (!query.trim()) throw new Error('Enter a search query first.');
        data = await request('/v2/search', { query: query.trim(), limit: Math.min(100, Math.max(1, Number(limit) || 10)), scrapeOptions: { formats: ['markdown'] } });
        addHistory('Search', query.trim());
      } else {
        const normalized = safeUrl(url.trim());
        if (!normalized) throw new Error('Enter a complete http or https URL.');
        if (mode === 'scrape') {
          data = await request('/v2/scrape', { url: normalized, formats: formats.length ? formats : ['markdown'], onlyMainContent: onlyMain });
          addHistory('Scrape', normalized);
        } else if (mode === 'map') {
          data = await request('/v2/map', { url: normalized, limit: Math.min(5000, Math.max(1, Number(limit) || 100)) });
          addHistory('Map', normalized);
        } else {
          data = await request('/v2/crawl', { url: normalized, limit: Math.min(1000, Math.max(1, Number(limit) || 50)), maxDiscoveryDepth: Math.min(10, Math.max(1, Number(maxDepth) || 2)), scrapeOptions: { formats: ['markdown'], onlyMainContent: onlyMain } });
          addHistory('Crawl', normalized);
          setJob(data);
          if (data.id && !['completed', 'failed', 'cancelled'].includes(data.status)) {
            setStatus({ busy: true, message: 'Crawl running · checking for updates every 3 seconds' });
            return;
          }
        }
      }
      setResult(data); setStatus({ busy: false, message: 'Completed successfully' });
    } catch (error) { setStatus({ busy: false, message: error.message || 'The request could not be completed.' }); }
  }

  async function cancelCrawl() {
    if (!job?.id) return;
    try {
      await request(`/v2/crawl/${encodeURIComponent(job.id)}`, undefined, 'DELETE');
      setJob({ ...job, status: 'cancelled' }); setStatus({ busy: false, message: 'Crawl cancelled' });
    } catch (error) { setStatus({ busy: false, message: error.message }); }
  }

  function toggleFormat(value) { setFormats((current) => current.includes(value) ? current.filter((item) => item !== value) : [...current, value]); }
  const crawlActive = mode === 'crawl' && job?.id && !['completed', 'failed', 'cancelled'].includes(job.status);

  return <div className="app-shell">
    <header className="topbar">
      <a className="brand" href="/"><span className="brand-symbol"><i></i></span><span>COMPLEX ELITE <small>MEDIA GROUP</small></span></a>
      <div className="topbar-right"><span className="crumb">Tools <b>/</b> Firecrawl</span><span className={`health ${health}`}><i></i>{health === 'online' ? 'API online' : health === 'offline' ? 'API unavailable' : 'Checking API'}</span><form method="post" action="/auth/logout"><button className="signout">Sign out</button></form></div>
    </header>
    <main className="workspace">
      <section className="intro"><div><span className="overline">WEB DATA WORKSPACE <i></i> SELF-HOSTED</span><h1>Turn the web into<br/><em>useful data.</em></h1><p>Search, scrape, map, or crawl pages through your private Firecrawl service.</p></div><div className="intro-mark" aria-hidden="true"><div className="hex hex-a"></div><div className="hex hex-b"></div><div className="hex-core"><span>CE</span></div><i className="node node-a"></i><i className="node node-b"></i><i className="node node-c"></i></div></section>
      <div className="layout">
        <section className="control-panel">
          <div className="panel-heading"><div><span className="panel-step">01 · CHOOSE AN ACTION</span><h2>What do you need?</h2></div><span className="api-badge">API v2</span></div>
          <div className="mode-grid" role="tablist" aria-label="Firecrawl action">
            {modes.map((item) => <button key={item.id} className={`mode-card ${mode === item.id ? 'selected' : ''}`} role="tab" aria-selected={mode === item.id} onClick={() => { setMode(item.id); setStatus({ busy: false, message: '' }); setResult(null); setJob(null); }}><span className="mode-icon">{item.icon}</span><span className="mode-title">{item.title}</span><span className="mode-kicker">{item.kicker}</span></button>)}
          </div>
          <form className="request-form" onSubmit={run}>
            <div className="form-title"><div><span className="panel-step">02 · CONFIGURE</span><h3>{selectedMode.title} a {mode === 'search' ? 'query' : 'website'}</h3></div><span className="form-count">{mode === 'search' ? 'FIND' : 'EXTRACT'}</span></div>
            {mode === 'search' ? <label className="field"><span>Search the web</span><div className="input-wrap"><span className="input-glyph">⌕</span><input autoComplete="off" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="e.g. AI workflow automation tools" /></div></label> : <label className="field"><span>{mode === 'scrape' ? 'Page URL' : mode === 'crawl' ? 'Starting URL' : 'Website URL'}</span><div className="input-wrap"><span className="input-glyph">↗</span><input type="url" autoComplete="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com" /></div><small>{mode === 'crawl' ? 'Starts here, then follows links within the site.' : mode === 'map' ? 'Find pages published on this domain.' : 'We’ll extract the main readable page content.'}</small></label>}
            <p className="mode-copy">{selectedMode.copy}</p>
            {(mode === 'search' || mode === 'map' || mode === 'crawl') && <label className="field compact-field"><span>{mode === 'search' ? 'Results' : mode === 'map' ? 'Maximum URLs' : 'Maximum pages'}</span><div className="input-wrap short-input"><input type="number" min="1" max={mode === 'map' ? '5000' : mode === 'crawl' ? '1000' : '100'} value={limit} onChange={(e) => setLimit(e.target.value)} /></div></label>}
            {mode === 'crawl' && <label className="field compact-field"><span>Link depth</span><div className="input-wrap short-input"><input type="number" min="1" max="10" value={maxDepth} onChange={(e) => setMaxDepth(e.target.value)} /></div></label>}
            {mode === 'scrape' && <div className="option-block"><div className="option-title">Return content as</div><div className="format-options">{[['markdown','Markdown'],['links','Links'],['html','HTML']].map(([value,label]) => <label key={value} className="check-option"><input type="checkbox" checked={formats.includes(value)} onChange={() => toggleFormat(value)} /><span className="custom-check">✓</span>{label}</label>)}</div><label className="toggle-option"><input type="checkbox" checked={onlyMain} onChange={(e) => setOnlyMain(e.target.checked)} /><span className="toggle-ui"></span><span>Focus on main page content</span></label></div>}
            {mode === 'crawl' && <label className="toggle-option crawl-toggle"><input type="checkbox" checked={onlyMain} onChange={(e) => setOnlyMain(e.target.checked)} /><span className="toggle-ui"></span><span>Focus on main page content</span></label>}
            <div className="form-bottom"><p><span className="lock">◈</span> Requests stay inside your signed-in Tools session.</p><button className="run-button" disabled={status.busy}>{status.busy ? <><span className="spinner"></span> Working</> : <>{mode === 'scrape' ? 'Scrape page' : mode === 'search' ? 'Search the web' : mode === 'crawl' ? 'Start crawl' : 'Map website'} <span>→</span></>}</button></div>
            {status.message && <div className={`notice ${status.busy ? 'busy' : ''}`} role="status" aria-live="polite"><span className={status.busy ? 'spinner' : 'notice-dot'}></span>{status.message}{crawlActive && <button type="button" onClick={cancelCrawl}>Cancel crawl</button>}</div>}
          </form>
          {history.length > 0 && <div className="recent"><div className="recent-title">RECENT REQUESTS <span>Stored in this browser only</span></div>{history.slice(0,4).map((item) => <button key={item.id} className="recent-item" onClick={() => { if(item.kind==='Search') {setMode('search');setQuery(item.target);} else {setMode(item.kind.toLowerCase());setUrl(item.target);} }}><span className="recent-icon">↺</span><span><b>{item.kind}</b><small>{item.target}</small></span><span className="recent-time">{new Date(item.at).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})}</span></button>)}</div>}
        </section>
        <section className="results-panel">
          <div className="results-header"><div><span className="panel-step">03 · OUTPUT</span><h2>Your results</h2></div><div className="result-actions">{result && <button onClick={() => downloadJson(result, `firecrawl-${mode}`)}>Export JSON <span>↓</span></button>}</div></div>
          {job?.id && <div className="job-banner"><span className={`job-dot ${job.status === 'completed' ? 'done' : ''}`}></span><div><b>{job.status === 'completed' ? 'Crawl completed' : `Crawl ${job.status || 'queued'}`}</b><small>Job {job.id}{job.total ? ` · ${job.completed || 0} of ${job.total} pages` : ''}</small></div><span className="job-state">{job.status}</span></div>}
          {!result && <div className="empty-state"><div className="empty-graphic"><div className="empty-ring ring-one"></div><div className="empty-ring ring-two"></div><span>✳</span><i></i></div><h3>Ready when you are</h3><p>Choose an action, enter a target, and Firecrawl will return structured web data here.</p><div className="endpoint-note"><span className="endpoint-dot"></span><span><b>Private endpoint</b><small>tools.complexelite.com/firecrawl/v2</small></span><span className="arrow">↗</span></div></div>}
          {result && <div className="result-content">
            <div className="result-summary"><span className="success-icon">✓</span><div><b>{mode === 'scrape' ? titleOf(result.data) : `${results.length} ${mode === 'map' ? 'URLs' : 'results'} returned`}</b><small>{mode === 'scrape' ? urlOf(result.data) : `Completed · ${new Date().toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}`}</small></div><button className="icon-button" title="Copy JSON" onClick={() => navigator.clipboard?.writeText(JSON.stringify(result, null, 2)).catch(()=>{})}>⧉</button></div>
            {results.length > 0 && <div className="results-list"><div className="list-toolbar"><span>{results.length} {mode === 'map' ? 'pages discovered' : 'web results'}</span><div className="filter-input"><span>⌕</span><input value={resultFilter} onChange={(e) => setResultFilter(e.target.value)} placeholder="Filter results" /></div></div>{results.slice(0, 100).map((item, index) => <article className="result-item" key={`${urlOf(item)}-${index}`}><span className="result-index">{String(index + 1).padStart(2, '0')}</span><div className="result-copy"><b>{titleOf(item)}</b>{urlOf(item) && <a href={safeUrl(urlOf(item)) || '#'} target="_blank" rel="noreferrer">{urlOf(item)} ↗</a>}{snippetOf(item) && <p>{String(snippetOf(item)).slice(0, 300)}</p>}</div></article>)}</div>}
            {mode === 'scrape' && <div className="scrape-output">{result.data?.markdown && <Output title="Markdown" text={result.data.markdown} />}{result.data?.links && <Output title="Links" text={JSON.stringify(result.data.links, null, 2)} />}{result.data?.html && <Output title="HTML source" text={result.data.html} />}{!result.data?.markdown && !result.data?.links && !result.data?.html && <Output title="Response" text={JSON.stringify(result, null, 2)} />}</div>}
            {mode === 'crawl' && results.length === 0 && job?.status === 'completed' && <div className="results-list"><div className="list-toolbar"><span>{Array.isArray(result.data) ? result.data.length : 0} pages collected</span></div>{(Array.isArray(result.data) ? result.data : []).slice(0,80).map((item,index)=><article className="result-item" key={`${urlOf(item)}-${index}`}><span className="result-index">{String(index+1).padStart(2,'0')}</span><div className="result-copy"><b>{titleOf(item)}</b><a href={safeUrl(urlOf(item))||'#'} target="_blank" rel="noreferrer">{urlOf(item)} ↗</a><p>{String(snippetOf(item)).slice(0,220)}</p></div></article>)}</div>}
          </div>}
          <div className="results-footer"><span>FIRECRAWL SELF-HOSTED</span><a href="https://docs.firecrawl.dev/api-reference/introduction" target="_blank" rel="noreferrer">API documentation ↗</a></div>
        </section>
      </div>
      <footer className="page-footer"><span>Complex Elite Media Group <b>·</b> Private web data workspace</span><span>Built on Firecrawl v2.11.162</span></footer>
    </main>
  </div>;
}

function Output({ title, text }) {
  const [copied, setCopied] = useState(false);
  return <section className="output-card"><div className="output-head"><b>{title}</b><button onClick={async () => { try { await navigator.clipboard.writeText(text); setCopied(true); window.setTimeout(()=>setCopied(false),1600); } catch {} }}>{copied ? 'Copied' : 'Copy'}</button></div><pre>{text}</pre></section>;
}

createRoot(document.getElementById('root')).render(<App />);
