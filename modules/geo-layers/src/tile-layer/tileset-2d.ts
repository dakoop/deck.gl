import Tile2DHeader from './tile-2d-header';
import {getTileIndices, tileToBoundingBox} from './utils';
import {RequestScheduler} from '@loaders.gl/loader-utils';
import {Matrix4} from '@math.gl/core';
import {assert, Viewport} from '@deck.gl/core';
import {Bounds, TileIndex, ZRange} from './types';
import {TileLayerProps} from './tile-layer';

// bit masks
const TILE_STATE_VISITED = 1;
const TILE_STATE_VISIBLE = 2;
/*
   show cached parent tile if children are loading
   +-----------+       +-----+            +-----+-----+
   |           |       |     |            |     |     |
   |           |       |     |            |     |     |
   |           |  -->  +-----+-----+  ->  +-----+-----+
   |           |             |     |      |     |     |
   |           |             |     |      |     |     |
   +-----------+             +-----+      +-----+-----+

   show cached children tiles when parent is loading
   +-------+----       +------------
   |       |           |
   |       |           |
   |       |           |
   +-------+----  -->  |
   |       |           |
 */

export const STRATEGY_NEVER = 'never';
export const STRATEGY_REPLACE = 'no-overlap';
export const STRATEGY_DEFAULT = 'best-available';

export type RefinementStrategyFunction = (tiles: Tile2DHeader[]) => void;
export type RefinementStrategy =
  | typeof STRATEGY_NEVER
  | typeof STRATEGY_REPLACE
  | typeof STRATEGY_DEFAULT
  | RefinementStrategyFunction;

const DEFAULT_CACHE_SCALE = 5;

const STRATEGIES = {
  [STRATEGY_DEFAULT]: updateTileStateDefault,
  [STRATEGY_REPLACE]: updateTileStateReplace,
  [STRATEGY_NEVER]: () => {}
};

export type Tileset2DProps = Pick<
  TileLayerProps,
  | 'getTileData'
  | 'tileSize'
  | 'maxCacheSize'
  | 'maxCacheByteSize'
  | 'refinementStrategy'
  | 'extent'
  | 'maxZoom'
  | 'minZoom'
  | 'maxRequests'
  | 'zoomOffset'
> & {
  onTileLoad: (tile: Tile2DHeader) => void;
  onTileUnload: (tile: Tile2DHeader) => void;
  onTileError: (error: any, tile: Tile2DHeader) => void;
};

/**
 * Manages loading and purging of tiles data. This class caches recently visited tiles
 * and only create new tiles if they are present.
 */
export default class Tileset2D {
  private opts: Tileset2DProps;
  private _requestScheduler: RequestScheduler;
  private _cache: Map<string, Tile2DHeader>;
  private _dirty: boolean;
  private _tiles: Tile2DHeader[];

  private _cacheByteSize: number;
  private _viewport: Viewport | null;
  private _selectedTiles: Tile2DHeader[] | null;
  private _frameNumber: number;
  private _modelMatrix: Matrix4;
  private _modelMatrixInverse: Matrix4;

  private _maxZoom?: number;
  private _minZoom?: number;

  private onTileLoad: (tile: Tile2DHeader) => void;

  /**
   * Takes in a function that returns tile data, a cache size, and a max and a min zoom level.
   * Cache size defaults to 5 * number of tiles in the current viewport
   */
  constructor(opts: Tileset2DProps) {
    this.opts = opts;

    this.onTileLoad = tile => {
      this.opts.onTileLoad(tile);
      if (this.opts.maxCacheByteSize) {
        this._cacheByteSize += tile.byteLength;
        this._resizeCache();
      }
    };

    this._requestScheduler = new RequestScheduler({
      maxRequests: opts.maxRequests,
      throttleRequests: opts.maxRequests > 0
    });

    // Maps tile id in string {z}-{x}-{y} to a Tile object
    this._cache = new Map();
    this._tiles = [];
    this._dirty = false;
    this._cacheByteSize = 0;

    // Cache the last processed viewport
    this._viewport = null;
    this._selectedTiles = null;
    this._frameNumber = 0;

    this._modelMatrix = new Matrix4();
    this._modelMatrixInverse = new Matrix4();

    this.setOptions(opts);
  }

  /* Public API */
  get tiles() {
    return this._tiles;
  }

  get selectedTiles(): Tile2DHeader[] | null {
    return this._selectedTiles;
  }

  get isLoaded(): boolean {
    return this._selectedTiles !== null && this._selectedTiles.every(tile => tile.isLoaded);
  }

  get needsReload(): boolean {
    return this._selectedTiles !== null && this._selectedTiles.some(tile => tile.needsReload);
  }

  setOptions(opts: Tileset2DProps): void {
    Object.assign(this.opts, opts);
    if (Number.isFinite(opts.maxZoom)) {
      this._maxZoom = Math.floor(opts.maxZoom);
    }
    if (Number.isFinite(opts.minZoom)) {
      this._minZoom = Math.ceil(opts.minZoom);
    }
  }

  // Clean up any outstanding tile requests.
  finalize(): void {
    for (const tile of this._cache.values()) {
      if (tile.isLoading) {
        tile.abort();
      }
    }
    this._cache.clear();
    this._tiles = [];
    this._selectedTiles = null;
  }

  reloadAll(): void {
    for (const cacheKey of this._cache.keys()) {
      const tile = this._cache.get(cacheKey) as Tile2DHeader;
      if (!this._selectedTiles || !this._selectedTiles.includes(tile)) {
        this._cache.delete(cacheKey);
      } else {
        tile.setNeedsReload();
      }
    }
  }

  /**
   * Update the cache with the given viewport and model matrix and triggers callback onUpdate.
   */
  update(
    viewport: Viewport,
    {zRange, modelMatrix}: {zRange?: ZRange; modelMatrix?: Matrix4} = {}
  ): number {
    const modelMatrixAsMatrix4 = new Matrix4(modelMatrix);
    const isModelMatrixNew = !modelMatrixAsMatrix4.equals(this._modelMatrix);
    if (!this._viewport || !viewport.equals(this._viewport) || isModelMatrixNew) {
      if (isModelMatrixNew) {
        this._modelMatrixInverse = modelMatrixAsMatrix4.clone().invert();
        this._modelMatrix = modelMatrixAsMatrix4;
      }
      this._viewport = viewport;
      const tileIndices = this.getTileIndices({
        viewport,
        maxZoom: this._maxZoom,
        minZoom: this._minZoom,
        zRange,
        modelMatrix: this._modelMatrix,
        modelMatrixInverse: this._modelMatrixInverse
      });
      this._selectedTiles = tileIndices.map(index => this._getTile(index, true));

      if (this._dirty) {
        // Some new tiles are added
        this._rebuildTree();
      }
      // Check for needed reloads explicitly even if the view/matrix has not changed.
    } else if (this.needsReload) {
      this._selectedTiles = this._selectedTiles!.map(
        tile => this._getTile({index: tile.index}) as Tile2DHeader
      );
    }

    // Update tile states
    const changed = this.updateTileStates();
    this._pruneRequests();

    if (this._dirty) {
      // cache size is either the user defined maxSize or 5 * number of current tiles in the viewport.
      this._resizeCache();
    }

    if (changed) {
      this._frameNumber++;
    }

    return this._frameNumber;
  }

  /* Public interface for subclassing */

  // Returns array of {index}
  getTileIndices({
    viewport,
    maxZoom,
    minZoom,
    zRange,
    modelMatrix,
    modelMatrixInverse
  }: {
    viewport: Viewport;
    maxZoom?: number;
    minZoom?: number;
    zRange: ZRange | undefined;
    tileSize?: number;
    modelMatrix?: Matrix4;
    modelMatrixInverse?: Matrix4;
    zoomOffset?: number;
  }): TileIndex[] {
    const {tileSize, extent, zoomOffset} = this.opts;
    return getTileIndices({
      viewport,
      maxZoom,
      minZoom,
      zRange,
      tileSize,
      extent: extent as Bounds | undefined,
      modelMatrix,
      modelMatrixInverse,
      zoomOffset
    });
  }

  // Returns unique string key for a tile index
  getTileCacheKey(index: TileIndex) {
    return `${index.x}-${index.y}-${index.z}`;
  }

  getTileZoom(index: TileIndex) {
    return index.z;
  }

  // Add custom metadata to tiles
  getTileMetadata({index}) {
    assert(this._viewport);
    const {tileSize} = this.opts;
    return {bbox: tileToBoundingBox(this._viewport, index.x, index.y, index.z, tileSize)};
  }

  // Returns {x, y, z} of the parent tile
  getParentIndex(tileIndex) {
    // Perf: mutate the input object to avoid GC
    tileIndex.x = Math.floor(tileIndex.x / 2);
    tileIndex.y = Math.floor(tileIndex.y / 2);
    tileIndex.z -= 1;
    return tileIndex;
  }

  // Returns true if any tile's visibility changed
  updateTileStates() {
    assert(this._selectedTiles);
    const refinementStrategy = this.opts.refinementStrategy || STRATEGY_DEFAULT;

    const visibilities = new Array(this._cache.size);
    let i = 0;
    // Reset state
    for (const tile of this._cache.values()) {
      // save previous state
      visibilities[i++] = tile.isVisible;
      tile.isSelected = false;
      tile.isVisible = false;
    }
    for (const tile of this._selectedTiles) {
      tile.isSelected = true;
      tile.isVisible = true;
    }

    // Strategy-specific state logic
    (typeof refinementStrategy === 'function'
      ? refinementStrategy
      : STRATEGIES[refinementStrategy])(Array.from(this._cache.values()));

    i = 0;
    // Check if any visibility has changed
    for (const tile of this._cache.values()) {
      if (visibilities[i++] !== tile.isVisible) {
        return true;
      }
    }

    return false;
  }

  /* Private methods */

  _pruneRequests(): void {
    const {maxRequests} = this.opts;

    const abortCandidates: Tile2DHeader[] = [];
    let ongoingRequestCount = 0;
    for (const tile of this._cache.values()) {
      // Keep track of all the ongoing requests
      if (tile.isLoading) {
        ongoingRequestCount++;
        if (!tile.isSelected && !tile.isVisible) {
          abortCandidates.push(tile);
        }
      }
    }

    while (maxRequests > 0 && ongoingRequestCount > maxRequests && abortCandidates.length > 0) {
      // There are too many ongoing requests, so abort some that are unselected
      const tile = abortCandidates.shift()!;
      tile.abort();
      ongoingRequestCount--;
    }
  }

  // This needs to be called every time some tiles have been added/removed from cache
  _rebuildTree() {
    const {_cache} = this;

    // Reset states
    for (const tile of _cache.values()) {
      tile.parent = null;
      if (tile.children) {
        tile.children.length = 0;
      }
    }

    // Rebuild tree
    for (const tile of _cache.values()) {
      const parent = this._getNearestAncestor(tile);
      tile.parent = parent;
      if (parent?.children) {
        parent.children.push(tile);
      }
    }
  }

  /**
   * Clear tiles that are not visible when the cache is full
   */
  /* eslint-disable complexity */
  _resizeCache() {
    assert(this.selectedTiles);
    const {_cache, opts} = this;

    const maxCacheSize =
      opts.maxCacheSize ||
      (opts.maxCacheByteSize ? Infinity : DEFAULT_CACHE_SCALE * this.selectedTiles.length);
    const maxCacheByteSize = opts.maxCacheByteSize || Infinity;

    const overflown = _cache.size > maxCacheSize || this._cacheByteSize > maxCacheByteSize;

    if (overflown) {
      for (const [cacheKey, tile] of _cache) {
        if (!tile.isVisible) {
          // delete tile
          this._cacheByteSize -= opts.maxCacheByteSize ? tile.byteLength : 0;
          _cache.delete(cacheKey);
          this.opts.onTileUnload(tile);
        }
        if (_cache.size <= maxCacheSize && this._cacheByteSize <= maxCacheByteSize) {
          break;
        }
      }
      this._rebuildTree();
      this._dirty = true;
    }
    if (this._dirty) {
      // sort by zoom level so that smaller tiles are displayed on top
      this._tiles = Array.from(this._cache.values()).sort((t1, t2) => t1.zoom - t2.zoom);

      this._dirty = false;
    }
  }
  /* eslint-enable complexity */

  _getTile(index: TileIndex, create: true): Tile2DHeader;
  _getTile(index: TileIndex, create?: false): Tile2DHeader | undefined;
  _getTile(index: TileIndex, create?: boolean): Tile2DHeader | undefined {
    const cacheKey = this.getTileCacheKey(index);
    let tile = this._cache.get(cacheKey);
    let needsReload = false;

    if (!tile && create) {
      tile = new Tile2DHeader(index);
      Object.assign(tile, this.getTileMetadata(tile));
      Object.assign(tile, {zoom: this.getTileZoom(tile.index)});
      needsReload = true;
      this._cache.set(cacheKey, tile);
      this._dirty = true;
    } else if (tile && tile.needsReload) {
      needsReload = true;
    }
    if (tile && needsReload) {
      // eslint-disable-next-line @typescript-eslint/no-floating-promises
      tile.loadData({
        getData: this.opts.getTileData,
        requestScheduler: this._requestScheduler,
        onLoad: this.onTileLoad,
        onError: this.opts.onTileError
      });
    }

    return tile;
  }

  _getNearestAncestor(tile: Tile2DHeader): Tile2DHeader | null {
    const {_minZoom = 0} = this;

    // Make copy as getParentIndex mutates object
    let index = JSON.parse(JSON.stringify(tile.index));
    while (this.getTileZoom(index) > _minZoom) {
      index = this.getParentIndex(index);
      const parent = this._getTile(index);
      if (parent) {
        return parent;
      }
    }
    return null;
  }
}

/* -- Refinement strategies --*/
/* eslint-disable max-depth */

// For all the selected && pending tiles:
// - pick the closest ancestor as placeholder
// - if no ancestor is visible, pick the closest children as placeholder
function updateTileStateDefault(allTiles: Tile2DHeader[]) {
  for (const tile of allTiles) {
    tile.state = 0;
  }
  for (const tile of allTiles) {
    if (tile.isSelected && !getPlaceholderInAncestors(tile)) {
      getPlaceholderInChildren(tile);
    }
  }
  for (const tile of allTiles) {
    tile.isVisible = Boolean(tile.state! & TILE_STATE_VISIBLE);
  }
}

// Until a selected tile and all its selected siblings are loaded, use the closest ancestor as placeholder
function updateTileStateReplace(allTiles: Tile2DHeader[]) {
  for (const tile of allTiles) {
    tile.state = 0;
  }
  for (const tile of allTiles) {
    if (tile.isSelected) {
      getPlaceholderInAncestors(tile);
    }
  }
  // Always process parents first
  const sortedTiles = Array.from(allTiles).sort((t1, t2) => t1.zoom - t2.zoom);
  for (const tile of sortedTiles) {
    tile.isVisible = Boolean(tile.state! & TILE_STATE_VISIBLE);

    if (tile.children && (tile.isVisible || tile.state! & TILE_STATE_VISITED)) {
      // If the tile is rendered, or if the tile has been explicitly hidden, hide all of its children
      for (const child of tile.children) {
        child.state = TILE_STATE_VISITED;
      }
    } else if (tile.isSelected) {
      getPlaceholderInChildren(tile);
    }
  }
}

// Walk up the tree until we find one ancestor that is loaded. Returns true if successful.
function getPlaceholderInAncestors(startTile: Tile2DHeader) {
  let tile: Tile2DHeader | null = startTile;
  while (tile) {
    if (tile.isLoaded || tile.content) {
      tile.state! |= TILE_STATE_VISIBLE;
      return true;
    }
    tile = tile.parent;
  }
  return false;
}

// Recursively set children as placeholder
function getPlaceholderInChildren(tile) {
  for (const child of tile.children) {
    if (child.isLoaded || child.content) {
      child.state |= TILE_STATE_VISIBLE;
    } else {
      getPlaceholderInChildren(child);
    }
  }
}