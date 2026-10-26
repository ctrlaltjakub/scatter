'use client';

import { useEffect, useRef, useState } from 'react';
import { Globe, LoaderCircle } from 'lucide-react';
import type { ProviderAccount } from '@/store/types';
import { useSettingsStore } from '@/store/useSettingsStore';
import { searchSearxng } from '@/providers/localSearch';
import { validSearchEndpoint } from '@/providers/modelSearch';

/** Connection preferences are configuration, not graph content: no canvas
 * undo entry is created when configuring or testing search. */
export function LocalSearchConnection({ account }: { account: ProviderAccount }) {
  const update = useSettingsStore((s) => s.updateProvider);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [testing, setTesting] = useState(false);
  const request = useRef<AbortController | null>(null);
  const endpoint = account.webSearchEndpoint ?? '';
  const mode = account.serverSearch?.kind ?? 'searxng';
  useEffect(() => {
    setResult(null); setTesting(false);
    return () => { request.current?.abort(); request.current = null; };
  }, [endpoint, mode]);

  const test = async () => {
    if (testing || !validSearchEndpoint(endpoint)) return;
    const controller = new AbortController();
    request.current = controller; setTesting(true); setResult(null);
    try {
      await searchSearxng(endpoint, 'SearXNG search engine', { signal: controller.signal, maxResults: 1 });
      if (!controller.signal.aborted) setResult({ ok: true, text: 'Search connection works. Models with vision and tool calling can now fill the main or secondary role.' });
    } catch (error) {
      if (!controller.signal.aborted) setResult({ ok: false, text: error instanceof Error ? error.message : 'Search connection failed.' });
    } finally {
      if (request.current === controller) { request.current = null; setTesting(false); }
    }
  };

  return (
    <div className="settings-local-search">
      <h4><Globe size={15} aria-hidden="true" /> Web search for this connection</h4>
      <p className="field-help">
        Use <strong>server-managed search</strong> when your API supports it, or connect SearXNG directly.
        Search is enabled only for requests with <strong>Web search on</strong>.
      </p>
      <div className="field-row"><label className="field-label" htmlFor={`search-mode-${account.id}`}>Search connection</label>
        <select className="input" id={`search-mode-${account.id}`} value={mode} onChange={event => {
          setResult(null);
          update(account.id, { serverSearch: event.target.value === 'searxng' ? undefined : event.target.value === 'lmstudio-mcp'
            ? { kind: 'lmstudio-mcp', server: '', tools: [] } : event.target.value === 'localai'
            ? { kind: 'localai', servers: [] } : { kind: 'responses-mcp', url: '', tools: [] } });
        }}><option value="searxng">Browser-managed · SearXNG</option><option value="lmstudio-mcp">Server-managed · LM Studio MCP</option><option value="responses-mcp">Server-managed · Responses + remote MCP</option><option value="localai">Server-managed · LocalAI</option></select>
      </div>
      {account.serverSearch?.kind === 'lmstudio-mcp' && <div key="lmstudio-mcp">
        <div className="field-row"><label className="field-label" htmlFor={`lm-mcp-server-${account.id}`}>MCP server name</label>
          <input className="input" id={`lm-mcp-server-${account.id}`} value={account.serverSearch.server} placeholder="web-search"
            onChange={e => update(account.id, { serverSearch: { kind: 'lmstudio-mcp', server: e.target.value, tools: account.serverSearch?.kind === 'lmstudio-mcp' ? account.serverSearch.tools : [] } })} /></div>
        <div className="field-row"><label className="field-label" htmlFor={`lm-mcp-tools-${account.id}`}>Allowed search tools</label>
          <input className="input" id={`lm-mcp-tools-${account.id}`} defaultValue={account.serverSearch.tools.join(', ')} placeholder="searxng_web_search"
            onBlur={e => update(account.id, { serverSearch: { kind: 'lmstudio-mcp', server: account.serverSearch?.kind === 'lmstudio-mcp' ? account.serverSearch.server : '', tools: e.target.value.split(',').map(x => x.trim()).filter(Boolean) } })} /></div>
        <p className="field-help">Separate tool names with <strong>commas</strong>. Leave empty to use <strong>searxng_web_search</strong>.</p>
        <p className="field-help">Use the name from LM Studio’s <strong>mcp.json</strong>, without the mcp/ prefix. Enable <strong>Allow calling servers from mcp.json</strong> and use an authorized API token. Only allow read-only search tools. The server searches first; the model then answers using those results.</p>
      </div>}
      {account.serverSearch?.kind === 'responses-mcp' && <div key="mcp">
        <div className="field-row"><label className="field-label" htmlFor={`mcp-url-${account.id}`}>Search MCP URL</label>
          <input className="input" id={`mcp-url-${account.id}`} type="url" autoComplete="off" placeholder="https://search.example.com/mcp"
            value={account.serverSearch.url} onChange={e => update(account.id, { serverSearch: { kind: 'responses-mcp', tools: account.serverSearch?.kind === 'responses-mcp' ? account.serverSearch.tools : [], url: e.target.value } })} /></div>
        <div className="field-row"><label className="field-label" htmlFor={`mcp-tools-${account.id}`}>Allowed search tools</label>
          <input className="input" id={`mcp-tools-${account.id}`} defaultValue={account.serverSearch.tools.join(', ')} placeholder="web_search, web_fetch"
            onBlur={e => update(account.id, { serverSearch: { kind: 'responses-mcp', url: account.serverSearch?.kind === 'responses-mcp' ? account.serverSearch.url : '', tools: e.target.value.split(',').map(x => x.trim()).filter(Boolean) } })} /></div>
        <p className="field-help">Exact tool names, separated by commas. <strong>Only allow read-only search tools.</strong> Requires a Responses API with server-run MCP. LM Studio permits only public addresses here; use its dedicated MCP option for localhost tools. Plain Ollama does not support this API. Keep service credentials on your server, not in the URL.</p>
      </div>}
      {account.serverSearch?.kind === 'localai' && <div key="localai">
        <div className="field-row"><label className="field-label" htmlFor={`mcp-servers-${account.id}`}>Search server names</label>
          <input className="input" id={`mcp-servers-${account.id}`} defaultValue={account.serverSearch.servers.join(', ')} placeholder="web-search"
            onBlur={e => update(account.id, { serverSearch: { kind: 'localai', servers: e.target.value.split(',').map(x => x.trim()).filter(Boolean) } })} /></div>
        <p className="field-help">Names from your <strong>LocalAI model’s MCP configuration</strong>, separated by commas. Only these servers are requested. Search credentials and execution limits stay on the server. Requires LocalAI’s standard <strong>/v1/chat/completions</strong> endpoint, not its legacy /mcp endpoint.</p>
      </div>}
      {mode === 'searxng' && <>
      <div className="field-row">
        <label className="field-label" htmlFor={`provider-search-${account.id}`}>SearXNG URL</label>
        <input id={`provider-search-${account.id}`} className="input" type="url" value={endpoint}
          placeholder="https://search.example.com" autoComplete="off" spellCheck={false}
          onChange={(event) => update(account.id, { webSearchEndpoint: event.target.value || undefined })} />
      </div>
      <p className="field-help">
        Enable <strong>JSON results</strong> on the server.
        Allow the app’s address in <strong>CORS settings</strong> so the browser can connect.
        Only model-written search queries go to this service. Your <strong>provider API key is never sent</strong>.
        Search runs only when enabled for a request. Clear the URL to disconnect.
      </p>
      <button type="button" className="btn btn-secondary" disabled={testing || !validSearchEndpoint(endpoint)} onClick={() => void test()}>
        {testing && <LoaderCircle size={14} className="is-spinning" aria-hidden="true" />}
        {testing ? 'Testing search…' : 'Test search connection'}
      </button>
      {result && <p className={`field-help${result.ok ? '' : ' settings-search-error'}`} role="status">{result.text}</p>}
      </>}
    </div>
  );
}
