'use client';

/**
 * The left-hand control rail for the graph: mode toggle (global/local), local
 * depth, colour mode (type/tag/cluster), the live physics sliders (link
 * distance, repel strength, centre gravity, label threshold), view buttons
 * (zoom-to-fit / reset), and the filter controls (tags, folders, link types,
 * updated range) that drive `filterGraph`. Presentational — state lives in the
 * page.
 *
 * v3 (Lumen) additions:
 * - "Colour by" now includes "Cluster" mode (connected-component colouring).
 * - New "Graphics" section with:
 *   - Context view toggle (isolates the selected neighbourhood).
 *   - Label density quick-preset (sparse / normal / dense).
 */

import { colorForKey } from '../../lib/graph/model';
import { PHYSICS_BOUNDS, type GraphPhysics } from '../../lib/graph/physics';
import type { ColorMode } from '../../lib/graph/model';
import type { FilterAction, GraphFilters, GraphMode } from '../../lib/graph/filters';
import { GraphTimeline } from './GraphTimeline';
import type { TimelineState } from '../../lib/graph/timeline';

/** Label density presets: maps to `physics.labelThreshold` values. */
export type LabelDensity = 'sparse' | 'normal' | 'dense';
const DENSITY_THRESHOLD: Record<LabelDensity, number> = {
  sparse: 3.0,
  normal: 1.6,
  dense: 0.5,
};

export interface GraphControlsProps {
  mode: GraphMode;
  onModeChange: (mode: GraphMode) => void;
  localDepth: number;
  onLocalDepthChange: (depth: number) => void;
  /** True when local mode is selectable (a node is selected). */
  canFocusLocal: boolean;

  colorMode: ColorMode;
  onColorModeChange: (mode: ColorMode) => void;

  physics: GraphPhysics;
  onPhysicsChange: (patch: Partial<GraphPhysics>) => void;
  onResetPhysics: () => void;
  onZoomToFit: () => void;
  onResetView: () => void;

  filters: GraphFilters;
  dispatch: (action: FilterAction) => void;

  availableTags: string[];
  availableFolders: string[];
  availableLinkTypes: string[];

  /** Timeline slider state. `null` = no timestamped nodes, hide the control. */
  timeline: TimelineState | null;
  onTimelineChange: (patch: Partial<TimelineState>) => void;

  /** v3: Context view toggle. */
  contextView: boolean;
  onContextViewChange: (on: boolean) => void;

  /** v3: Current label density preset. */
  labelDensity: LabelDensity;
  onLabelDensityChange: (density: LabelDensity) => void;
}

export function GraphControls({
  mode,
  onModeChange,
  localDepth,
  onLocalDepthChange,
  canFocusLocal,
  colorMode,
  onColorModeChange,
  physics,
  onPhysicsChange,
  onResetPhysics,
  onZoomToFit,
  onResetView,
  filters,
  dispatch,
  availableTags,
  availableFolders,
  availableLinkTypes,
  timeline,
  onTimelineChange,
  contextView,
  onContextViewChange,
  labelDensity,
  onLabelDensityChange,
}: GraphControlsProps) {
  const handleDensityChange = (density: LabelDensity) => {
    onLabelDensityChange(density);
    onPhysicsChange({ labelThreshold: DENSITY_THRESHOLD[density] });
  };

  return (
    // On mobile the aside is rendered inside a slide-up drawer by the page,
    // so we remove the fixed w-64 and border constraints and let it fill
    // the available width. On desktop (md+) the aside regains its rail styles.
    <aside className="flex w-full shrink-0 flex-col gap-4 overflow-y-auto bg-neutral-950 px-4 py-4 md:w-64 md:border-r md:border-neutral-800">
      <div>
        <Label>View</Label>
        <div className="mt-2 inline-flex rounded-md border border-neutral-800 p-0.5">
          <SegButton active={mode === 'global'} onClick={() => onModeChange('global')}>
            Global
          </SegButton>
          <SegButton
            active={mode === 'local'}
            disabled={!canFocusLocal}
            onClick={() => onModeChange('local')}
          >
            Local
          </SegButton>
        </div>
        {mode === 'local' && (
          <div className="mt-3">
            <SliderRow label="Depth" value={localDepth}>
              <input
                type="range"
                min={1}
                max={4}
                step={1}
                value={localDepth}
                onChange={(e) => onLocalDepthChange(Number(e.target.value))}
                className="mt-1 w-full accent-neutral-400"
              />
            </SliderRow>
          </div>
        )}
        <div className="mt-3 flex gap-2">
          <ActionButton onClick={onZoomToFit}>Zoom to fit</ActionButton>
          <ActionButton onClick={onResetView}>Reset view</ActionButton>
        </div>
      </div>

      <Divider />

      <div>
        <Label>Colour by</Label>
        <div className="mt-2 inline-flex rounded-md border border-neutral-800 p-0.5">
          <SegButton active={colorMode === 'type'} onClick={() => onColorModeChange('type')}>
            Type
          </SegButton>
          <SegButton active={colorMode === 'tag'} onClick={() => onColorModeChange('tag')}>
            Tag
          </SegButton>
          <SegButton active={colorMode === 'cluster'} onClick={() => onColorModeChange('cluster')}>
            Cluster
          </SegButton>
        </div>
        {colorMode === 'cluster' && (
          <p className="mt-1.5 text-[11px] leading-snug text-neutral-600">
            Colour by connected component — nodes that link to each other share a colour.
          </p>
        )}
      </div>

      <Divider />

      {/* ------------------------------------------------------------------ */}
      {/* v3 Graphics section                                                  */}
      {/* ------------------------------------------------------------------ */}
      <div>
        <Label>Graphics</Label>
        <div className="mt-2 space-y-3">
          {/* Context view toggle */}
          <div className="flex items-center justify-between">
            <span className="text-xs text-neutral-400">Context view</span>
            <button
              type="button"
              role="switch"
              aria-checked={contextView}
              onClick={() => onContextViewChange(!contextView)}
              title={
                contextView
                  ? 'Disable context view — show all nodes'
                  : 'Enable context view — highlight the selected neighbourhood'
              }
              className={[
                'relative inline-flex h-4 w-8 shrink-0 cursor-pointer rounded-full border-0 transition-colors duration-200',
                contextView ? 'bg-blue-500' : 'bg-neutral-700',
              ].join(' ')}
            >
              <span
                className={[
                  'mt-px inline-block h-3 w-3 rounded-full bg-white shadow transition-transform duration-200',
                  contextView ? 'translate-x-4' : 'translate-x-0.5',
                ].join(' ')}
              />
            </button>
          </div>
          {contextView && (
            <p className="text-[11px] leading-snug text-neutral-600">
              Select a node to isolate its neighbourhood.
            </p>
          )}

          {/* Label density */}
          <div>
            <span className="text-xs text-neutral-400">Label density</span>
            <div className="mt-1.5 inline-flex rounded-md border border-neutral-800 p-0.5">
              {(['sparse', 'normal', 'dense'] as LabelDensity[]).map((d) => (
                <SegButton
                  key={d}
                  active={labelDensity === d}
                  onClick={() => handleDensityChange(d)}
                >
                  {d.charAt(0).toUpperCase() + d.slice(1)}
                </SegButton>
              ))}
            </div>
          </div>
        </div>
      </div>

      <Divider />

      <div>
        <div className="flex items-center justify-between">
          <Label>Physics</Label>
          <button
            type="button"
            onClick={onResetPhysics}
            className="text-[10px] uppercase tracking-wide text-neutral-500 transition-colors hover:text-neutral-300"
          >
            Reset
          </button>
        </div>
        <div className="mt-2 space-y-3">
          <SliderRow label="Link distance" value={physics.linkDistance}>
            <input
              type="range"
              min={PHYSICS_BOUNDS.linkDistance.min}
              max={PHYSICS_BOUNDS.linkDistance.max}
              step={PHYSICS_BOUNDS.linkDistance.step}
              value={physics.linkDistance}
              onChange={(e) => onPhysicsChange({ linkDistance: Number(e.target.value) })}
              className="mt-1 w-full accent-neutral-400"
            />
          </SliderRow>
          <SliderRow label="Repel strength" value={-physics.chargeStrength}>
            {/* Slider runs over positive magnitude; negated back into charge. */}
            <input
              type="range"
              min={-PHYSICS_BOUNDS.chargeStrength.max}
              max={-PHYSICS_BOUNDS.chargeStrength.min}
              step={PHYSICS_BOUNDS.chargeStrength.step}
              value={-physics.chargeStrength}
              onChange={(e) => onPhysicsChange({ chargeStrength: -Number(e.target.value) })}
              className="mt-1 w-full accent-neutral-400"
            />
          </SliderRow>
          <SliderRow label="Centre gravity" value={physics.centerGravity.toFixed(2)}>
            <input
              type="range"
              min={PHYSICS_BOUNDS.centerGravity.min}
              max={PHYSICS_BOUNDS.centerGravity.max}
              step={PHYSICS_BOUNDS.centerGravity.step}
              value={physics.centerGravity}
              onChange={(e) => onPhysicsChange({ centerGravity: Number(e.target.value) })}
              className="mt-1 w-full accent-neutral-400"
            />
          </SliderRow>
          <SliderRow label="Label threshold" value={physics.labelThreshold.toFixed(1)}>
            <input
              type="range"
              min={PHYSICS_BOUNDS.labelThreshold.min}
              max={PHYSICS_BOUNDS.labelThreshold.max}
              step={PHYSICS_BOUNDS.labelThreshold.step}
              value={physics.labelThreshold}
              onChange={(e) => onPhysicsChange({ labelThreshold: Number(e.target.value) })}
              className="mt-1 w-full accent-neutral-400"
            />
          </SliderRow>
        </div>
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

      {timeline && (
        <>
          <Divider />
          <GraphTimeline state={timeline} onChange={onTimelineChange} />
        </>
      )}
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

function SliderRow({
  label,
  value,
  children,
}: {
  label: string;
  value: number | string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="flex items-center justify-between text-xs text-neutral-400">
        <span>{label}</span>
        <span className="tabular-nums text-neutral-200">{value}</span>
      </div>
      {children}
    </div>
  );
}

function SegButton({
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

function ActionButton({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex-1 rounded-md border border-neutral-800 px-2 py-1.5 text-xs text-neutral-300 transition-colors hover:bg-neutral-900 hover:text-neutral-100"
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

export { DENSITY_THRESHOLD };
