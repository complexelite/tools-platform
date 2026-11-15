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
function downloadCsv(rows, name) {
  const list = Array.isArray(rows) ? rows : [];
  const keys = [...new Set(list.flatMap((row) => Object.keys(row || {})))];
  const quote = (value) => `"${String(value ?? '').replace(/"/g, '""').replace(/\s+/g, ' ').trim()}"`;
  const csv = [keys.map(quote).join(','), ...list.map((row) => keys.map((key) => quote(typeof row[key] === 'object' ? JSON.stringify(row[key]) : row[key])).join(','))].join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const href = URL.createObjectURL(blob); const link = document.createElement('a');
  link.href = href; link.download = `${name}-${new Date().toISOString().slice(0, 10)}.csv`; link.click(); URL.revokeObjectURL(href);
}
const workflows = [
  { id: 'handover', title: 'Client website handover', tag: 'REBUILD / MIGRATION', icon: '↗', text: 'Capture the old site’s page names, copy, business details and contact candidates before rebuilding it.' },
  { id: 'leads', title: 'Find business leads', tag: 'PROSPECTING', icon: '⌕', text: 'Search for companies by service or industry and location, then export a sourced prospect list.' },
  { id: 'audit', title: 'Website audit', tag: 'SEO / CONTENT', icon: '◎', text: 'Review crawlable pages for metadata, headings, status and internal-link opportunities.' },
  { id: 'competitors', title: 'Competitor research', tag: 'MARKET RESEARCH', icon: '◉', text: 'Discover competitor sites and compare their published services, positioning and page structure.' },
];
function contactCandidates(pages) {
  const found = new Map();
  for (const page of pages) {
    const text = `${page?.markdown || ''}\n${page?.metadata?.description || ''}`;
    for (const email of text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || []) found.set(`email:${email.toLowerCase()}`, { type: 'Email candidate', value: email, source: urlOf(page) });
    for (const phone of text.match(/(?:\+?\d[\d ()./-]{7,}\d)/g) || []) {
      const value = phone.trim().replace(/\s+/g, ' ');
      if (value.replace(/\D/g, '').length >= 9) found.set(`phone:${value.replace(/\D/g, '')}`, { type: 'Phone candidate', value, source: urlOf(page) });
    }
  }
  return [...found.values()];
}
function auditFindings(pages) {
  return pages.map((page) => {
    const meta = page?.metadata || {}; const markdown = page?.markdown || '';
    const title = meta.title || ''; const description = meta.description || '';
    const headings = [...markdown.matchAll(/^#{1,6}\s+(.+)$/gm)].map((match) => match[1].trim());
    const h1 = markdown.match(/^#\s+(.+)$/m)?.[1]?.trim() || '';
    const status = Number(meta.statusCode || meta.status_code || 0);
    const links = Array.isArray(page?.links) ? page.links.length : 0;
    return { url: urlOf(page), title: title || 'Missing / not returned', description: description || 'Missing / not returned', status: status || 'Not returned', h1: h1 || 'Not found in extracted Markdown', headings: headings.length, links, findings: [!title && 'Title missing from returned metadata', !description && 'Meta description missing from returned metadata', !h1 && 'No H1 found in extracted Markdown', status >= 400 && `Page returned status ${status}`].filter(Boolean) };
  });
}

function App() {
  const historyKey = `ce-firecrawl-history:${document.getElementById('root')?.dataset.userId || 'session'}`;
  const [mode, setMode] = useState('scrape');
  const [activeWorkflow, setActiveWorkflow] = useState('');
  const [industry, setIndustry] = useState('');
  const [location, setLocation] = useState('');
  const [includePaths, setIncludePaths] = useState('');
  const [excludePaths, setExcludePaths] = useState('');
  const [sitemap, setSitemap] = useState('include');
  const [advanced, setAdvanced] = useState(false);
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
  const [pollAttempt, setPollAttempt] = useState(0);
  const [resultFilter, setResultFilter] = useState('');
  const [savedCrawls, setSavedCrawls] = useState([]);
  const [storageStatus, setStorageStatus] = useState('checking');
  const [history, setHistory] = useState(() => {
    try { return JSON.parse(localStorage.getItem(historyKey) || '[]'); } catch { return []; }
  });

  async function refreshSavedCrawls(shouldUpdate = () => true) {
    const response = await fetch('/api/firecrawl/crawls', { credentials: 'same-origin' });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Storage is unavailable.');
    if (shouldUpdate()) { setSavedCrawls(data.crawls || []); setStorageStatus('connected'); }
    return data.crawls || [];
  }

  useEffect(() => { setLimit(activeWorkflow === 'audit' ? '25' : activeWorkflow === 'handover' ? '50' : mode === 'search' ? '10' : mode === 'map' ? '100' : '50'); }, [mode, activeWorkflow]);

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
    let alive = true;
    refreshSavedCrawls(() => alive)
      .catch(() => { if (alive) setStorageStatus('unavailable'); });
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    const hasPending = savedCrawls.some((item) => !['completed', 'failed', 'cancelled'].includes(item.status));
    if (!hasPending) return undefined;
    const timer = window.setInterval(() => refreshSavedCrawls().catch(() => {}), 5000);
    return () => window.clearInterval(timer);
  }, [savedCrawls.some((item) => !['completed', 'failed', 'cancelled'].includes(item.status))]);

  useEffect(() => {
    if (!job?.id || ['completed', 'failed', 'cancelled'].includes(job.status)) return undefined;
    let alive = true;
    let timer;
    let consecutiveFailures = 0;
    const poll = async () => {
      if (!alive) return;
      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), 12000);
      try {
        const response = await fetch(`${apiBase}/v2/crawl/${encodeURIComponent(job.id)}`, { credentials: 'same-origin', signal: controller.signal });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Could not read crawl status.');
        consecutiveFailures = 0;
        if (!alive) return;
        setJob(data);
        if (['completed', 'failed', 'cancelled'].includes(data.status)) {
          if (data.status === 'completed') {
            setStatus({ busy: true, message: 'Crawl complete · loading all result pages…' });
            try {
              const complete = await collectCrawlPages(data);
              setJob(complete); setResult(complete);
              try {
                await saveCrawl(complete, url, activeWorkflow || 'crawl');
                setStatus({ busy: false, message: `${complete.data.length} crawl result${complete.data.length === 1 ? '' : 's'} loaded and saved` });
              } catch (saveError) {
                const saved = await refreshSavedCrawls().catch(() => []);
                const serverSaved = saved.find((item) => item.job_id === complete.id && item.status === 'completed');
                setStatus({ busy: false, message: serverSaved ? `${complete.data.length} crawl results loaded and saved automatically` : `${complete.data.length} results loaded, but crawl history could not be saved: ${saveError.message}` });
              }
            } catch (error) {
              setResult(data); setStatus({ busy: false, message: `Crawl completed, but some result pages could not be loaded: ${error.message}` });
            }
          } else {
            setResult(data); setStatus({ busy: false, message: `Crawl ${data.status}` });
          }
          return;
        }
        const total = Number(data.total) || 0;
        const completed = Number(data.completed) || 0;
        const progress = total > 0 ? `${completed} of ${total} pages complete` : 'Discovering pages';
        setStatus({ busy: true, message: `Crawl in progress · ${progress} · checked just now` });
      } catch (error) {
        if (!alive) return;
        consecutiveFailures += 1;
        if (consecutiveFailures >= 4) {
          setStatus({ busy: false, message: 'Status checks are not reaching Firecrawl. The crawl may still be running; retry the status check or cancel it.' });
          return;
        }
        setStatus({ busy: true, message: `Checking crawl status · retry ${consecutiveFailures} of 4${error.name === 'AbortError' ? ' (request timed out)' : ''}` });
      } finally {
        window.clearTimeout(timeout);
      }
      if (alive) timer = window.setTimeout(poll, 3000);
    };
    timer = window.setTimeout(poll, 0);
    return () => { alive = false; window.clearTimeout(timer); };
  }, [job?.id, job?.status, pollAttempt]);

  function addHistory(kind, value) {
    const entry = { id: `${Date.now()}`, kind, target: value, at: new Date().toISOString() };
    const next = [entry, ...history].slice(0, 6);
    setHistory(next); localStorage.setItem(historyKey, JSON.stringify(next));
  }

  async function request(path, body, method = 'POST', extraHeaders = {}) {
    const response = await fetch(`${apiBase}${path}`, {
      method, credentials: 'same-origin', headers: { 'Content-Type': 'application/json', ...extraHeaders },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.success === false) throw new Error(data.error || data.message || `Firecrawl returned ${response.status}.`);
    return data;
  }

  async function collectCrawlPages(initial) {
    const crawlId = initial?.id;
    let page = initial;
    const collected = [];
    let pagesRead = 0;
    while (page && pagesRead < 200) {
      if (Array.isArray(page.data)) collected.push(...page.data);
      pagesRead += 1;
      if (!page.next) return { ...initial, ...page, id: crawlId || page.id, data: collected, next: null };
      const nextUrl = new URL(page.next, window.location.origin);
      if (!/^\/v2\/crawl\/[a-f\d-]+$/i.test(nextUrl.pathname)) throw new Error('Firecrawl returned an invalid crawl results cursor.');
      page = await request(`${nextUrl.pathname}${nextUrl.search}`);
    }
    return { ...initial, ...page, id: crawlId || page?.id, data: collected, next: page?.next || null };
  }

  async function saveCrawl(crawl, target, workflow) {
    const response = await fetch('/api/firecrawl/crawls', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ job_id: crawl.id, target, workflow, total: crawl.total, completed: crawl.completed, pages: (crawl.data || []).map((page) => ({ url: page?.url, metadata: page?.metadata, markdown: page?.markdown, links: page?.links })) }) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Database save failed.');
    setSavedCrawls((current) => [data.crawl, ...current.filter((item) => item.job_id !== data.crawl.job_id)].slice(0, 50));
    setStorageStatus('connected');
    return data.crawl;
  }

  async function openSavedCrawl(id) {
    try {
      const response = await fetch(`/api/firecrawl/crawls/${encodeURIComponent(id)}`, { credentials: 'same-origin' });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'Could not open saved crawl.');
      const item = data.crawl;
      setUrl(item.target); setMode('crawl'); setActiveWorkflow(item.workflow === 'crawl' ? '' : item.workflow); setJob({ id: item.job_id, status: item.status, total: item.total, completed: item.completed }); setResult(item.result); setResultFilter(''); setStatus({ busy: false, message: item.result?.truncated ? `${item.page_count} saved pages loaded; the workspace storage limit capped this result` : `${item.page_count} saved results loaded from the database` });
    } catch (error) { setStatus({ busy: false, message: error.message }); }
  }

  async function run(event) {
    event.preventDefault(); setResult(null); setJob(null); setResultFilter('');
    setStatus({ busy: true, message: 'Connecting to Firecrawl…' });
    try {
      let data;
      if (activeWorkflow === 'leads' || activeWorkflow === 'competitors') {
        const terms = activeWorkflow === 'leads' ? industry.trim() : query.trim();
        if (!terms) throw new Error(activeWorkflow === 'leads' ? 'Enter a business type or service.' : 'Enter a competitor topic or business type.');
        const builtQuery = [terms, location.trim(), activeWorkflow === 'leads' ? 'businesses website contact' : 'competitors services'].filter(Boolean).join(' ');
        data = await request('/v2/search', { query: builtQuery, limit: Math.min(100, Math.max(1, Number(limit) || 10)), sources: [{ type: 'web' }], scrapeOptions: { formats: ['markdown'] } });
        addHistory(activeWorkflow === 'leads' ? 'Lead search' : 'Competitor research', builtQuery);
      } else if (mode === 'search') {
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
          const isAudit = activeWorkflow === 'audit';
          const isHandover = activeWorkflow === 'handover';
          const pathList = (value) => value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
          data = await request('/v2/crawl', { url: normalized, limit: Math.min(1000, Math.max(1, Number(limit) || 50)), maxDiscoveryDepth: Math.min(10, Math.max(1, Number(maxDepth) || 2)), sitemap: isAudit || isHandover ? sitemap : 'include', ...(includePaths.trim() ? { includePaths: pathList(includePaths) } : {}), ...(excludePaths.trim() ? { excludePaths: pathList(excludePaths) } : {}), maxConcurrency: 1, scrapeOptions: { formats: isAudit ? ['markdown', 'rawHtml', 'links'] : ['markdown', 'links'], onlyMainContent: isHandover ? false : onlyMain } }, 'POST', { 'X-CE-Crawl-Workflow': activeWorkflow || 'crawl' });
          await refreshSavedCrawls().catch(() => {});
          addHistory(isAudit ? 'Website audit' : isHandover ? 'Client handover' : 'Crawl', normalized);
          setJob(data);
          if (data.id && !['completed', 'failed', 'cancelled'].includes(data.status)) {
            setStatus({ busy: true, message: 'Crawl running · checking for updates every 3 seconds' });
            return;
          }
          if (data.id && data.status === 'completed') {
            const complete = await collectCrawlPages(data);
            setJob(complete); setResult(complete);
            try { await saveCrawl(complete, normalized, activeWorkflow || 'crawl'); setStatus({ busy: false, message: `${complete.data.length} crawl result${complete.data.length === 1 ? '' : 's'} loaded and saved` }); }
            catch (saveError) {
              const saved = await refreshSavedCrawls().catch(() => []);
              const serverSaved = saved.find((item) => item.job_id === complete.id && item.status === 'completed');
              setStatus({ busy: false, message: serverSaved ? `${complete.data.length} crawl results loaded and saved automatically` : `${complete.data.length} results loaded, but crawl history could not be saved: ${saveError.message}` });
            }
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
  const crawledPages = Array.isArray(result?.data) ? result.data : [];
  const contacts = useMemo(() => contactCandidates(crawledPages), [result]);
  const auditRows = useMemo(() => auditFindings(crawledPages), [result]);
  const handoverHome = crawledPages.find((page) => {
    try { const current = new URL(urlOf(page)); const target = new URL(url || 'https://invalid.local'); return current.pathname === '/' || current.pathname.replace(/\/$/, '') === target.pathname.replace(/\/$/, ''); } catch { return false; }
  }) || crawledPages[0];

  return <div className="app-shell">
    <header className="topbar">
      <a className="brand" href="/"><span className="brand-symbol"><i></i></span><span>COMPLEX ELITE <small>MEDIA GROUP</small></span></a>
      <div className="topbar-right"><span className="crumb">Tools <b>/</b> Firecrawl</span><span className={`health ${health}`}><i></i>{health === 'online' ? 'API online' : health === 'offline' ? 'API unavailable' : 'Checking API'}</span><form method="post" action="/auth/logout"><button className="signout">Sign out</button></form></div>
    </header>
    <main className="workspace">
      <section className="intro"><div><span className="overline">WEB DATA WORKSPACE <i></i> SELF-HOSTED</span><h1>Turn the web into<br/><em>useful data.</em></h1><p>Search, scrape, map, or crawl pages through your private Firecrawl service.</p></div><div className="intro-mark" aria-hidden="true"><div className="hex hex-a"></div><div className="hex hex-b"></div><div className="hex-core"><span>CE</span></div><i className="node node-a"></i><i className="node node-b"></i><i className="node node-c"></i></div></section>
      <section className="workflow-section"><div className="workflow-heading"><div><span className="panel-step">BUILT FOR YOUR WORK</span><h2>Start with a workflow</h2></div><p>Guided presets for client delivery and business development.</p></div><div className="workflow-grid">{workflows.map((item) => <button key={item.id} className={`workflow-card ${activeWorkflow === item.id ? 'active' : ''}`} onClick={() => { setActiveWorkflow(item.id); setMode(item.id === 'leads' || item.id === 'competitors' ? 'search' : 'crawl'); setResult(null); setJob(null); setStatus({ busy: false, message: '' }); }}><span className="workflow-icon">{item.icon}</span><span className="workflow-tag">{item.tag}</span><b>{item.title}</b><small>{item.text}</small><span className="workflow-arrow">→</span></button>)}</div></section>
      <div className="layout">
        <section className="control-panel">
          <div className="panel-heading"><div><span className="panel-step">01 · CHOOSE AN ACTION</span><h2>What do you need?</h2></div><span className="api-badge">API v2</span></div>
          <div className="mode-grid" role="tablist" aria-label="Firecrawl action">
            {modes.map((item) => <button key={item.id} className={`mode-card ${mode === item.id && !activeWorkflow ? 'selected' : ''}`} role="tab" aria-selected={mode === item.id && !activeWorkflow} onClick={() => { setActiveWorkflow(''); setMode(item.id); setStatus({ busy: false, message: '' }); setResult(null); setJob(null); }}><span className="mode-icon">{item.icon}</span><span className="mode-title">{item.title}</span><span className="mode-kicker">{item.kicker}</span></button>)}
          </div>
          <form className="request-form" onSubmit={run}>
            <div className="form-title"><div><span className="panel-step">02 · CONFIGURE</span><h3>{selectedMode.title} a {mode === 'search' ? 'query' : 'website'}</h3></div><span className="form-count">{mode === 'search' ? 'FIND' : 'EXTRACT'}</span></div>
            {mode === 'search' && activeWorkflow === 'leads' ? <><label className="field"><span>Business type or service</span><div className="input-wrap"><span className="input-glyph">⌕</span><input autoComplete="off" value={industry} onChange={(e) => setIndustry(e.target.value)} placeholder="e.g. independent dental practices" /></div></label><label className="field"><span>Target area (optional)</span><div className="input-wrap"><span className="input-glyph">⌖</span><input autoComplete="off" value={location} onChange={(e) => setLocation(e.target.value)} placeholder="e.g. Canterbury, UK" /></div></label><p className="mode-copy">Find public business pages. These are web prospects, not verified decision-makers; review each source before outreach.</p></> : mode === 'search' ? <label className="field"><span>{activeWorkflow === 'competitors' ? 'Industry, company or topic' : 'Search the web'}</span><div className="input-wrap"><span className="input-glyph">⌕</span><input autoComplete="off" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={activeWorkflow === 'competitors' ? 'e.g. UK web design agencies' : 'e.g. AI workflow automation tools'} /></div></label> : <label className="field"><span>{activeWorkflow === 'handover' ? 'Client’s current website' : activeWorkflow === 'audit' ? 'Website to audit' : mode === 'scrape' ? 'Page URL' : mode === 'crawl' ? 'Starting URL' : 'Website URL'}</span><div className="input-wrap"><span className="input-glyph">↗</span><input type="url" autoComplete="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com" /></div><small>{activeWorkflow === 'handover' ? 'Collects page names, available copy and contact candidates with source URLs.' : activeWorkflow === 'audit' ? 'Checks a bounded sample of crawlable pages and reports evidence returned by Firecrawl.' : mode === 'crawl' ? 'Starts here, then follows links within the site.' : mode === 'map' ? 'Find pages published on this domain.' : 'We’ll extract the main readable page content.'}</small></label>}
            <p className="mode-copy">{selectedMode.copy}</p>
            {(mode === 'search' || mode === 'map' || mode === 'crawl') && <label className="field compact-field"><span>{mode === 'search' ? 'Results' : mode === 'map' ? 'Maximum URLs' : 'Maximum pages'}</span><div className="input-wrap short-input"><input type="number" min="1" max={mode === 'map' ? '5000' : mode === 'crawl' ? '1000' : '100'} value={limit} onChange={(e) => setLimit(e.target.value)} /></div></label>}
            {mode === 'crawl' && <label className="field compact-field"><span>Link depth</span><div className="input-wrap short-input"><input type="number" min="1" max="10" value={maxDepth} onChange={(e) => setMaxDepth(e.target.value)} /></div></label>}
            {mode === 'scrape' && <div className="option-block"><div className="option-title">Return content as</div><div className="format-options">{[['markdown','Markdown'],['links','Links'],['html','HTML']].map(([value,label]) => <label key={value} className="check-option"><input type="checkbox" checked={formats.includes(value)} onChange={() => toggleFormat(value)} /><span className="custom-check">✓</span>{label}</label>)}</div><label className="toggle-option"><input type="checkbox" checked={onlyMain} onChange={(e) => setOnlyMain(e.target.checked)} /><span className="toggle-ui"></span><span>Focus on main page content</span></label></div>}
            {mode === 'crawl' && <label className="toggle-option crawl-toggle"><input type="checkbox" checked={onlyMain} onChange={(e) => setOnlyMain(e.target.checked)} /><span className="toggle-ui"></span><span>Focus on main page content</span></label>}
            {mode === 'crawl' && <div className="advanced-options"><button type="button" className="advanced-toggle" onClick={() => setAdvanced((value) => !value)}>{advanced ? '− Hide' : '+ Show'} crawl options <span>Path filters · sitemap</span></button>{advanced && <div className="advanced-fields"><label className="field"><span>Include paths (optional, one per line)</span><textarea value={includePaths} onChange={(e) => setIncludePaths(e.target.value)} placeholder="/services/\n/about" rows="2" /></label><label className="field"><span>Exclude paths (optional, one per line)</span><textarea value={excludePaths} onChange={(e) => setExcludePaths(e.target.value)} placeholder="/blog/\n/privacy" rows="2" /></label><label className="field"><span>Sitemap handling</span><select value={sitemap} onChange={(e) => setSitemap(e.target.value)}><option value="include">Use sitemap and discovered links</option><option value="only">Use sitemap URLs only</option><option value="skip">Skip sitemap</option></select></label><small>Crawls are limited to one concurrent page request to keep load predictable.</small></div>}</div>}
            <div className="form-bottom"><p><span className="lock">◈</span> Requests stay inside your signed-in Tools session.</p><button className="run-button" disabled={status.busy || crawlActive}>{status.busy ? <><span className="spinner"></span> Working</> : crawlActive ? 'Crawl active' : <>{mode === 'scrape' ? 'Scrape page' : mode === 'search' ? 'Search the web' : mode === 'crawl' ? 'Start crawl' : 'Map website'} <span>→</span></>}</button></div>
            {status.message && <div className={`notice ${status.busy ? 'busy' : ''}`} role="status" aria-live="polite"><span className={status.busy ? 'spinner' : 'notice-dot'}></span>{status.message}{crawlActive && !status.busy && <button type="button" onClick={() => { setStatus({ busy: true, message: 'Checking crawl status…' }); setPollAttempt((value) => value + 1); }}>Check status</button>}{crawlActive && <button type="button" onClick={cancelCrawl}>Cancel crawl</button>}</div>}
          </form>
          <div className="saved-crawls"><div className="recent-title">SAVED CRAWLS <span className={storageStatus}>{storageStatus === 'connected' ? 'Dokploy database connected' : storageStatus === 'checking' ? 'Connecting…' : 'Database unavailable'}</span></div>{savedCrawls.length === 0 ? <p className="saved-empty">{storageStatus === 'connected' ? 'Your crawl appears here as soon as Firecrawl accepts it.' : storageStatus === 'unavailable' ? 'Crawl history could not connect to storage.' : 'Loading saved crawl history…'}</p> : savedCrawls.slice(0,8).map((item) => <button key={item.id} className="recent-item saved-crawl-item" onClick={() => openSavedCrawl(item.id)}><span className="recent-icon">↺</span><span><b>{item.workflow === 'handover' ? 'Client handover' : item.workflow === 'audit' ? 'Website audit' : 'Crawl'} · {item.status === 'completed' ? `${item.page_count} pages${item.truncated ? ' · capped' : ''}` : item.status}</b><small>{item.target}</small></span><span className="recent-time">{new Date(item.created_at).toLocaleDateString()}</span></button>)}</div>
          {history.length > 0 && <div className="recent"><div className="recent-title">RECENT REQUESTS <span>Stored in this browser only</span></div>{history.slice(0,4).map((item) => <button key={item.id} className="recent-item" onClick={() => { if(item.kind==='Search') {setActiveWorkflow('');setMode('search');setQuery(item.target);} else {setActiveWorkflow('');setMode(item.kind.toLowerCase());setUrl(item.target);} }}><span className="recent-icon">↺</span><span><b>{item.kind}</b><small>{item.target}</small></span><span className="recent-time">{new Date(item.at).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})}</span></button>)}</div>}
        </section>
        <section className="results-panel">
          <div className="results-header"><div><span className="panel-step">03 · OUTPUT</span><h2>Your results</h2></div><div className="result-actions">{result && <><button onClick={() => downloadJson(result, `firecrawl-${activeWorkflow || mode}`)}>Export JSON <span>↓</span></button>{activeWorkflow === 'handover' && <><button onClick={() => downloadCsv(crawledPages.map((page) => ({ title: titleOf(page), url: urlOf(page), description: page?.metadata?.description || '', page_copy_markdown: page?.markdown || '' })), 'client-page-inventory')}>Page inventory CSV ↓</button><button onClick={() => downloadCsv(contacts, 'contact-candidates')}>Contacts CSV ↓</button></>}{activeWorkflow === 'leads' && <button onClick={() => downloadCsv(results.map((item) => ({ company_or_page: titleOf(item), website: urlOf(item), summary: snippetOf(item), source: urlOf(item) })), 'business-prospects')}>Prospects CSV ↓</button>}{activeWorkflow === 'audit' && <button onClick={() => downloadCsv(auditRows, 'website-audit')}>Audit CSV ↓</button>}</>}</div></div>
          {job?.id && <div className="job-banner"><span className={`job-dot ${job.status === 'completed' ? 'done' : ''}`}></span><div><b>{job.status === 'completed' ? 'Crawl completed' : `Crawl ${job.status || 'queued'}`}</b><small>Job {job.id}{job.total ? ` · ${job.completed || 0} of ${job.total} pages` : ''}</small></div><span className="job-state">{job.status}</span></div>}
          {!result && <div className="empty-state"><div className="empty-graphic"><div className="empty-ring ring-one"></div><div className="empty-ring ring-two"></div><span>✳</span><i></i></div><h3>Ready when you are</h3><p>Choose an action, enter a target, and Firecrawl will return structured web data here.</p><div className="endpoint-note"><span className="endpoint-dot"></span><span><b>Private endpoint</b><small>tools.complexelite.com/firecrawl/v2</small></span><span className="arrow">↗</span></div></div>}
          {result && <div className="result-content">
            {activeWorkflow === 'handover' && <div className="workflow-output"><div className="workflow-output-head"><div><span className="panel-step">CLIENT SITE HANDOVER</span><h3>Business snapshot & page inventory</h3></div><span className="scope-chip">{crawledPages.length} pages collected</span></div><p className="scope-note">Use this as a starting brief for the replacement site. Expand a page below to review its captured copy. Contact details are pattern-matched candidates and should be confirmed with the client.</p><div className="business-snapshot"><div><small>BUSINESS / SITE NAME</small><b>{handoverHome?.metadata?.ogSiteName || titleOf(handoverHome) || 'Not found in crawl'}</b></div><div><small>HOMEPAGE SUMMARY</small><p>{handoverHome?.metadata?.description || 'No description returned in metadata.'}</p></div><div><small>REFERENCE WEBSITE</small><a href={safeUrl(url) || '#'} target="_blank" rel="noreferrer">{url || '—'} ↗</a></div></div><div className="handover-stats"><div><b>{crawledPages.length}</b><small>Pages captured</small></div><div><b>{new Set(crawledPages.map((page) => { try { return new URL(urlOf(page)).pathname; } catch { return urlOf(page); } })).size}</b><small>Page paths</small></div><div><b>{contacts.length}</b><small>Contact candidates</small></div></div><div className="handover-pages">{crawledPages.map((page, index) => <details key={`${urlOf(page)}-${index}`}><summary><span>{String(index + 1).padStart(2, '0')}</span><b>{titleOf(page)}</b><small>{urlOf(page)}</small></summary><div className="handover-page-copy"><p>{page?.metadata?.description || 'No page description returned.'}</p><pre>{page?.markdown || 'No Markdown copy returned for this page.'}</pre></div></details>)}</div>{contacts.length > 0 && <div className="candidate-list">{contacts.map((item, index) => <div key={`${item.type}-${item.value}-${index}`}><b>{item.type}</b><span>{item.value}</span><a href={safeUrl(item.source) || '#'} target="_blank" rel="noreferrer">Source page ↗</a></div>)}</div>}{contacts.length === 0 && <div className="scope-note">No email or phone candidates were detected in the returned text.</div>}</div>}
            {activeWorkflow === 'audit' && <div className="workflow-output"><div className="workflow-output-head"><div><span className="panel-step">CRAWL-BASED REVIEW</span><h3>Page-level findings</h3></div><span className="scope-chip">{auditRows.length} pages checked</span></div><p className="scope-note">This checks crawl-visible metadata, extracted headings, links and returned status only. It does not measure rankings, traffic, Core Web Vitals, security or accessibility.</p><div className="audit-table-wrap"><table className="audit-table"><thead><tr><th>Page</th><th>Status</th><th>Title</th><th>Description</th><th>H1</th><th>Headings</th><th>Links</th><th>Findings</th></tr></thead><tbody>{auditRows.map((row, index) => <tr key={`${row.url}-${index}`}><td><a href={safeUrl(row.url) || '#'} target="_blank" rel="noreferrer">{row.url || `Page ${index + 1}`}</a></td><td>{row.status}</td><td>{row.title}</td><td>{row.description}</td><td>{row.h1}</td><td>{row.headings}</td><td>{row.links}</td><td>{row.findings.length ? row.findings.join(' · ') : 'No basic metadata or H1 gaps detected'}</td></tr>)}</tbody></table></div></div>}
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
