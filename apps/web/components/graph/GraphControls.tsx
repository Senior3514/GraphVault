'use client';

/**
 * The left-hand control rail for the graph: mode toggle (global/local), local
 * depth, and the filter controls (tags, folders, link types, updated range)
 * that drive `filterGraph`. Presentational — state lives in the page.
 */

import { colorForKey } from '../../lib/graph/model';
import type { FilterAction, GraphFilters, GraphMode } from '../../lib/graph/filters';

export interface GraphControlsProps {
  mode: GraphMode;
  onModeChange: (mode: GraphMode) => void;
  localDepth: number;
  onLocalDepthChange: (depth: number) => void;
  /** True when local mode is selectable (a node is selected). */
  canFocusLocal: boolean;

  filters: GraphFilters;
  dispatch: (action: FilterAction) => void;

  availableTags: string[];
  availableFolders: string[];
  availableLinkTypes: string[];
}

export function GraphControls({
  mode,
  onModeChange,
  localDepth,
  onLocalDepthChange,
  canFocusLocal,
  filters,
  dispatch,
  availableTags,
  availableFolders,
  availableLinkTypes,
}: GraphControlsProps) {
  return (
    <aside className="flex w-64 shrink-0 flex-col gap-4 overflow-y-auto border-r border-neutral-800 bg-neutral-950 px-4 py-4">
      <div>
        <Label>View</Label>
        <div className="mt-2 inline-flex rounded-md border border-neutral-800 p-0.5">
          <ModeButton active={mode === 'global'} onClick={() => onModeChange('global')}>
            Global
          </ModeButton>
          <ModeButton
            active={mode === 'local'}
            disabled={!canFocusLocal}
            onClick={() => onModeChange('local')}
          >
            Local
          </ModeButton>
        </div>
        {mode === 'local' && (
          <div className="mt-3">
            <label className="flex items-center justify-between text-xs text-neutral-400">
              <span>Depth</span>
              <span className="tabular-nums text-neutral-200">{localDepth}</span>
            </label>
            <input
              type="range"
              min={1}
              max={4}
              step={1}
              value={localDepth}
              onChange={(e) => onLocalDepthChange(Number(e.target.value))}
              className="mt-1 w-full accent-neutral-400"
            />
          </div>
        )}
      </div>

      <Divider />

      <FilterGroup
        label="Tags"
        empty="No tags in vault"
        items={availableTags}
        selected={filters.tags}
        onToggle={(tag) => dispatch({ type: 'toggleTag', tag })}
        swatch
      />

      <FilterGroup
        label="Folders"
        empty="No subfolders"
        items={availableFolders}
        selected={filters.folders}
        onToggle={(folder) => dispatch({ type: 'toggleFolder', folder })}
        renderLabel={(f) => (f === '' ? '(root)' : f)}
      />

      <FilterGroup
        label="Link types"
        empty="No links"
        items={availableLinkTypes}
        selected={filters.linkTypes}
        onToggle={(linkType) => dispatch({ type: 'toggleLinkType', linkType })}
      />

      <Divider />

      <div>
        <Label>Updated</Label>
        <div className="mt-2 space-y-2">
          <DateField
            label="From"
            value={filters.updatedFrom}
            onChange={(value) => dispatch({ type: 'setUpdatedFrom', value })}
          />
          <DateField
            label="To"
            value={filters.updatedTo}
            onChange={(value) => dispatch({ type: 'setUpdatedTo', value })}
          />
        </div>
      </div>

      <button
        type="button"
        onClick={() => dispatch({ type: 'reset' })}
        className="mt-1 rounded-md border border-neutral-800 px-3 py-1.5 text-xs text-neutral-400 transition-colors hover:bg-neutral-900 hover:text-neutral-200"
      >
        Reset filters
      </button>
    </aside>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
      {children}
    </span>
  );
}

function Divider() {
  return <hr className="border-neutral-800/80" />;
}

function ModeButton({
  active,
  disabled,
  onClick,
  children,
}: {
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={[
        'rounded px-3 py-1 text-xs font-medium transition-colors',
        active ? 'bg-neutral-800 text-neutral-100' : 'text-neutral-400 hover:text-neutral-200',
        disabled ? 'cursor-not-allowed opacity-40 hover:text-neutral-400' : '',
      ].join(' ')}
    >
      {children}
    </button>
  );
}

function FilterGroup({
  label,
  empty,
  items,
  selected,
  onToggle,
  renderLabel,
  swatch,
}: {
  label: string;
  empty: string;
  items: string[];
  selected: string[];
  onToggle: (item: string) => void;
  renderLabel?: (item: string) => string;
  swatch?: boolean;
}) {
  return (
    <div>
      <Label>{label}</Label>
      {items.length === 0 ? (
        <p className="mt-2 text-xs text-neutral-600">{empty}</p>
      ) : (
        <div className="mt-2 flex max-h-44 flex-wrap gap-1.5 overflow-y-auto">
          {items.map((item) => {
            const active = selected.includes(item);
            return (
              <button
                key={item}
                type="button"
                onClick={() => onToggle(item)}
                className={[
                  'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs transition-colors',
                  active
                    ? 'border-neutral-500 bg-neutral-800 text-neutral-100'
                    : 'border-neutral-800 text-neutral-400 hover:border-neutral-700 hover:text-neutral-200',
                ].join(' ')}
              >
                {swatch && (
                  <span
                    className="h-2 w-2 rounded-full"
                    style={{ backgroundColor: colorForKey(item) }}
                    aria-hidden
                  />
                )}
                {renderLabel ? renderLabel(item) : item}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function DateField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="flex items-center gap-2 text-xs text-neutral-400">
      <span className="w-10 shrink-0">{label}</span>
      <input
        type="date"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="min-w-0 flex-1 rounded border border-neutral-800 bg-neutral-900 px-2 py-1 text-neutral-200 [color-scheme:dark]"
      />
    </label>
  );
}
