/**
 * Plugin market root: the sidebar-foot trigger row plus the centered modal
 * panel (the settings-panel precedent). The panel manages the configured git
 * sources and lists the catalog with each plugin's install state and
 * install/uninstall controls; data arrives through the injected Remote face,
 * and the injected `revision` hook re-fetches whenever the host store or
 * sources change or the connection resets. Uninstall is a two-click confirm
 * (first click arms, second commits).
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import clsx from 'clsx'
import {
  IconCloseOutline16, IconCordisPluginOutline14, IconDownloadOutline16,
  IconRefreshOutline14, IconSearchOutline16, IconTrashOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  HostObservable, InjectFace, PropsLocale, PropsRuntime,
} from '@deepseek-ai/dsh-client-ui-slots'
import type {
  MarketCatalogSnapshot, MarketCatalogEntry, MarketPluginId,
  MarketSourcesSnapshot, MarketSourceUpdateResult,
} from '@deepseek-ai/dsh-api-remotes/client'
import type { MarketLocaleKey } from './locales.ts'
import css from './MarketRoot.module.css'

/** Registration-side injected face of the market surface. */
export interface MarketRootInjected {
  hooks: {
    /** Bumped on every store or source change and connection reset. */
    revision: HostObservable<number>
  }
  /** Read the current catalog. */
  list: () => Promise<MarketCatalogSnapshot>
  /** Install one catalog plugin. */
  install: (id: MarketPluginId) => Promise<{ ok: boolean; message?: string }>
  /** Uninstall one installed plugin. */
  uninstall: (id: MarketPluginId) => Promise<{ ok: boolean; message?: string }>
  /** Read the configured git sources with their fetch state. */
  sources: () => Promise<MarketSourcesSnapshot>
  /** Add and fetch one git source. */
  addSource: (url: string) => Promise<MarketSourceUpdateResult>
  /** Remove one user-configured git source. */
  removeSource: (url: string) => Promise<MarketSourceUpdateResult>
  /** Re-fetch every configured git source. */
  refreshSources: () => Promise<MarketSourcesSnapshot>
  /** Read the session's dynamic Cordis plugins for the Cordis tab. */
  cordisPlugins: () => Promise<CordisPluginSummary[]>
}

/** One dynamic Cordis plugin row shown in the market dialog's Cordis tab. */
export interface CordisPluginSummary {
  pluginId: string
  name: string
  running: boolean
  currentPackageId?: string
}

/** Full component props assembled by the footer-action slot renderer. */
export type MarketRootProps =
  PropsRuntime<'sidebar.footer.action'>
  & PropsLocale<'market'>
  & InjectFace<MarketRootInjected>

type ViewState =
  | { readonly status: 'loading' }
  | { readonly status: 'error' }
  | { readonly status: 'ready'; readonly snapshot: MarketCatalogSnapshot }

/** Whether a catalog row is installed or currently installing. */
function installedLabel(entry: MarketCatalogEntry, t: MarketRootProps['t']): string {
  if (!entry.installed) return t('notInstalledTag')
  if (entry.status === undefined) return t('statusMounting')
  return entry.status === 'mounted' ? t('statusMounted') : t('statusFailed')
}

/** The source-tag text for one catalog row's origin. */
function sourceLabel(entry: MarketCatalogEntry, t: MarketRootProps['t']): string {
  if (entry.source === 'builtin') return t('sourceBuiltin')
  if (entry.source === 'remote') return t('sourceRemote')
  return t('sourceStore')
}

/** The centered modal layer: mask, header, tabs, sources strip, and the scrollable catalog. */
function MarketPanel({
  state, sources, query, onQuery, sourceInput, onSourceInput, sourceBusy, onAddSource,
  onRemoveSource, onRefreshSources, busyId, confirmingId, onInstall, onUninstall, actionError, onClose, cordisPlugins, t,
}: {
  state: ViewState
  sources: MarketSourcesSnapshot | undefined
  query: string
  onQuery: (value: string) => void
  sourceInput: string
  onSourceInput: (value: string) => void
  sourceBusy: boolean
  onAddSource: () => void
  onRemoveSource: (url: string) => void
  onRefreshSources: () => void
  busyId: MarketPluginId | null
  confirmingId: MarketPluginId | null
  onInstall: (id: MarketPluginId) => void
  onUninstall: (id: MarketPluginId) => void
  actionError: string | undefined
  onClose: () => void
  cordisPlugins: () => Promise<CordisPluginSummary[]>
  t: MarketRootProps['t']
}) {
  const titleId = useId()
  const closeButton = useRef<HTMLButtonElement | null>(null)
  const [tab, setTab] = useState<'market' | 'cordis'>('market')

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => { document.removeEventListener('keydown', onKeyDown) }
  }, [onClose])

  useEffect(() => { closeButton.current?.focus() }, [])

  const normalizedQuery = query.trim().toLocaleLowerCase()
  const entries = useMemo(
    () => state.status === 'ready'
      ? state.snapshot.entries.filter(entry =>
        normalizedQuery.length === 0
        || [entry.name, entry.purpose, entry.id].some(value => value.toLocaleLowerCase().includes(normalizedQuery)))
      : [],
    [normalizedQuery, state],
  )

  return (
    <div className={css.overlay} role="presentation">
      <div className={css.mask} aria-hidden="true" onClick={onClose} />
      <div className={css.panel} role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className={css.header}>
          <h2 className={css.title} id={titleId}>{t('title')}</h2>
          <p className={css.intro}>{t('intro')}</p>
          <button ref={closeButton} type="button" className={css.close} onClick={onClose}>
            <IconCloseOutline16 size={14} />
            <span className={css.hiddenLabel}>{t('close')}</span>
          </button>
        </div>
        <div className={css.tabs}>
          <button
            type="button"
            className={clsx(css.tab, tab === 'market' && css.tabActive)}
            onClick={() => { setTab('market') }}
          >
            {t('tabMarket')}
          </button>
          <button
            type="button"
            className={clsx(css.tab, tab === 'cordis' && css.tabActive)}
            onClick={() => { setTab('cordis') }}
          >
            {t('tabCordis')}
          </button>
        </div>
        {tab === 'market' ? (
          <div className={css.body} aria-busy={state.status === 'loading'}>
            {state.status === 'loading' ? <p className={css.status}>{t('loading')}</p> : null}
            {state.status === 'error' ? <p className={css.status} role="alert">{t('error')}</p> : null}
            {state.status === 'ready' ? (
              <>
                <section className={css.sources}>
                  <div className={css.sourcesHeading}>
                    <h3>{t('sourcesTitle')}</h3>
                    <button
                      type="button"
                      className={css.refreshButton}
                      disabled={sourceBusy}
                      onClick={onRefreshSources}
                    >
                      <IconRefreshOutline14 size={14} aria-hidden="true" />
                      {sourceBusy ? t('refreshingSources') : t('refreshSources')}
                    </button>
                  </div>
                  <p className={css.sourcesIntro}>{t('sourcesIntro')}</p>
                  {sources === undefined || sources.sources.length === 0 ? (
                    <p className={css.sourcesEmpty}>{t('sourcesEmpty')}</p>
                  ) : (
                    <ul className={css.sourceList}>
                      {sources.sources.map(source => (
                        <li className={css.sourceRow} key={source.url} data-source-url={source.url}>
                          <code className={css.sourceUrl}>{source.url}</code>
                          <span
                            className={css.sourceState}
                            data-ok={source.ok ? 'true' : 'false'}
                            title={source.message}
                          >
                            {!source.ok
                              ? (source.message === undefined ? t('sourceNotFetched') : t('sourceError', { message: source.message }))
                              : t('sourceOk', { count: String(source.pluginCount) })}
                          </span>
                          <button
                            type="button"
                            className={css.removeSourceButton}
                            onClick={() => { onRemoveSource(source.url) }}
                          >
                            {t('removeSource')}
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                  <div className={css.addSourceRow}>
                    <input
                      type="text"
                      className={css.addSourceInput}
                      value={sourceInput}
                      placeholder={t('addSourcePlaceholder')}
                      aria-label={t('addSource')}
                      onChange={(event) => { onSourceInput(event.currentTarget.value) }}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') onAddSource()
                      }}
                    />
                    <button
                      type="button"
                      className={css.addSourceButton}
                      disabled={sourceBusy || sourceInput.trim().length === 0}
                      onClick={onAddSource}
                    >
                      {t('addSource')}
                    </button>
                  </div>
                </section>
                <label className={css.search}>
                  <IconSearchOutline16 aria-hidden="true" />
                  <span className={css.visuallyHidden}>{t('search')}</span>
                  <input
                    type="search"
                    value={query}
                    placeholder={t('search')}
                    aria-label={t('search')}
                    onChange={(event) => { onQuery(event.currentTarget.value) }}
                  />
                </label>
                {actionError !== undefined ? <p className={css.actionError} role="alert">{actionError}</p> : null}
                <div className={css.catalogHeading}>
                  <h3>{t('catalog')}</h3>
                  <span data-plugin-count={entries.length}>{entries.length}</span>
                </div>
                {state.snapshot.entries.length === 0 ? <p className={css.status}>{t('empty')}</p> : null}
                {state.snapshot.entries.length > 0 && entries.length === 0
                  ? <p className={css.status}>{t('emptySearch')}</p>
                  : null}
                {entries.length > 0 ? (
                  <ul className={css.cards}>
                    {entries.map((entry) => {
                      const busy = busyId === entry.id
                      const confirming = confirmingId === entry.id
                      const label = installedLabel(entry, t)
                      return (
                        <li className={css.card} key={entry.id} data-market-entry={entry.id}>
                          <div className={css.cardMain}>
                            <div className={css.cardTitleRow}>
                              <strong className={css.cardTitle}>{entry.name}</strong>
                              <span className={css.sourceTag} data-source={entry.source}>
                                {sourceLabel(entry, t)}
                              </span>
                              {entry.installed ? (
                                <span
                                  className={css.statusTag}
                                  data-status={entry.status ?? 'mounting'}
                                  data-error={entry.error !== undefined ? 'true' : undefined}
                                  title={entry.error}
                                >
                                  {label}
                                </span>
                              ) : null}
                            </div>
                            <p className={css.cardPurpose}>{entry.purpose}</p>
                            {entry.error !== undefined ? <p className={css.cardError}>{entry.error}</p> : null}
                          </div>
                          <div className={css.cardAction}>
                            {!entry.installed ? (
                              <button
                                type="button"
                                className={css.installButton}
                                disabled={busy}
                                onClick={() => { onInstall(entry.id) }}
                              >
                                <IconDownloadOutline16 size={14} aria-hidden="true" />
                                {busy ? t('statusMounting') : t('install')}
                              </button>
                            ) : (
                              <button
                                type="button"
                                className={clsx(css.uninstallButton, confirming && css.confirming)}
                                disabled={busy}
                                onClick={() => { onUninstall(entry.id) }}
                              >
                                <IconTrashOutline16 size={14} aria-hidden="true" />
                                {confirming ? t('uninstallConfirm', { name: entry.name }) : t('uninstall')}
                              </button>
                            )}
                          </div>
                        </li>
                      )
                    })}
                  </ul>
                ) : null}
              </>
            ) : null}
          </div>
        ) : (
          <CordisTab cordisPlugins={cordisPlugins} t={t} />
        )}
      </div>
    </div>
  )
}

/** The Cordis tab: a summary list of the session's dynamic Cordis plugins. */
function CordisTab({
  cordisPlugins, t,
}: {
  cordisPlugins: () => Promise<CordisPluginSummary[]>
  t: MarketRootProps['t']
}) {
  const [plugins, setPlugins] = useState<CordisPluginSummary[] | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let current = true
    void cordisPlugins().then(
      (rows) => { if (current) setPlugins(rows) },
      () => { if (current) setFailed(true) },
    )
    return () => { current = false }
  }, [cordisPlugins])

  if (failed) return <div className={css.body}><p className={css.status} role="alert">{t('cordisError')}</p></div>
  if (plugins === null) return <div className={css.body}><p className={css.status}>{t('cordisLoading')}</p></div>
  if (plugins.length === 0) return <div className={css.body}><p className={css.status}>{t('cordisEmpty')}</p></div>
  return (
    <div className={css.body}>
      <ul className={css.cordisList}>
        {plugins.map(plugin => (
          <li className={css.cordisRow} key={plugin.pluginId}>
            <span className={plugin.running ? css.cordisDot : `${css.cordisDot} ${css.cordisDotStopped}`} aria-hidden />
            <span className={css.cordisName} title={plugin.pluginId}>{plugin.name}</span>
            <code className={css.cordisId}>{plugin.pluginId}</code>
            <span className={plugin.running ? css.cordisRunning : css.cordisStopped}>
              {plugin.running ? t('cordisRunning') : t('cordisStopped')}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

/**
 * Render the market trigger and panel.
 * @param props - composed slot props.
 * @returns the market element tree.
 */
export function MarketRoot({
  wide, t, useRevision, list, install, uninstall, sources, addSource, removeSource, refreshSources, cordisPlugins,
}: MarketRootProps) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [sourceInput, setSourceInput] = useState('')
  const [sourceBusy, setSourceBusy] = useState(false)
  const [sourcesState, setSourcesState] = useState<MarketSourcesSnapshot | undefined>(undefined)
  const [state, setState] = useState<ViewState>({ status: 'loading' })
  const [busyId, setBusyId] = useState<MarketPluginId | null>(null)
  const [confirmingId, setConfirmingId] = useState<MarketPluginId | null>(null)
  const [actionError, setActionError] = useState<string | undefined>(undefined)
  const revision = useRevision(value => value)

  const close = useCallback(() => {
    setOpen(false)
    setQuery('')
    setSourceInput('')
    setConfirmingId(null)
    setActionError(undefined)
  }, [])

  // Fetch the catalog and the source list whenever the panel opens or the
  // store/source revision moves.
  useEffect(() => {
    if (!open) return
    let current = true
    setState(previous => previous.status === 'ready' ? previous : { status: 'loading' })
    void list().then(
      (snapshot) => { if (current) setState({ status: 'ready', snapshot }) },
      () => { if (current) setState({ status: 'error' }) },
    )
    void sources().then(
      (snapshot) => { if (current) setSourcesState(snapshot) },
      () => { /* source status is auxiliary; a failed read leaves the previous state */ },
    )
    return () => { current = false }
  }, [open, revision, list, sources])

  const runAction = useCallback(async (
    id: MarketPluginId,
    action: MarketRootInjected['install'],
    label: MarketLocaleKey,
  ): Promise<void> => {
    setBusyId(id)
    setActionError(undefined)
    try {
      const result = await action(id)
      if (!result.ok) setActionError(t(label, { message: result.message ?? '' }))
      setConfirmingId(null)
    } catch (error) {
      setActionError(t(label, { message: error instanceof Error ? error.message : String(error) }))
      setConfirmingId(null)
    } finally {
      setBusyId(null)
    }
  }, [t])

  const runSourceAction = useCallback(async (
    label: MarketLocaleKey,
    action: () => Promise<MarketSourceUpdateResult | MarketSourcesSnapshot>,
  ): Promise<void> => {
    setSourceBusy(true)
    setActionError(undefined)
    try {
      const result = await action()
      if ('ok' in result && !result.ok) {
        setActionError(t(label, { message: result.message ?? '' }))
      }
      setSourceInput('')
    } catch (error) {
      setActionError(t(label, { message: error instanceof Error ? error.message : String(error) }))
    } finally {
      setSourceBusy(false)
    }
  }, [t])

  return (
    <>
      <button
        type="button"
        className={clsx(css.trigger, !wide && css.rail)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={t('trigger')}
        onClick={() => { setOpen(true) }}
      >
        {wide ? <IconCordisPluginOutline14 size={16} /> : <IconCordisPluginOutline14 size={18} />}
        {wide && <span className={css.triggerLabel}>{t('trigger')}</span>}
      </button>
      {open && (
        <MarketPanel
          state={state}
          sources={sourcesState}
          query={query}
          onQuery={setQuery}
          sourceInput={sourceInput}
          onSourceInput={setSourceInput}
          sourceBusy={sourceBusy}
          onAddSource={() => {
            const url = sourceInput.trim()
            if (url.length === 0) return
            void runSourceAction('actionError', () => addSource(url))
          }}
          onRemoveSource={(url) => {
            void runSourceAction('actionError', () => removeSource(url))
          }}
          onRefreshSources={() => {
            void runSourceAction('actionError', () => refreshSources())
          }}
          busyId={busyId}
          confirmingId={confirmingId}
          onInstall={(id) => {
            setConfirmingId(null)
            void runAction(id, install, 'actionError')
          }}
          onUninstall={(id) => {
            if (confirmingId !== id) {
              setConfirmingId(id)
              return
            }
            void runAction(id, uninstall, 'actionError')
          }}
          actionError={actionError}
          onClose={close}
          cordisPlugins={cordisPlugins}
          t={t}
        />
      )}
    </>
  )
}
