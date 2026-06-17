/**
 * Renders aircraft points as Leaflet markers using the original visual's DOM
 * structure and class names (so the recovered style/visual.less applies verbatim):
 *
 *   .aircraft-marker-icon (divIcon)
 *     └ .aircraft-marker[.aircraft-marker-selected|.aircraft-marker-dimmed]
 *         ├ .aircraft-marker-label > (.aircraft-marker-label-logo? + .aircraft-marker-label-text)
 *         └ .aircraft-symbol  ( .aircraft-plane-icon svg | .aircraft-circle-symbol )
 *
 * Two extra behaviours layer on top of the plain marker rendering:
 *   - Clustering: when no selection is active, dense areas collapse into a single
 *     count circle (.aircraft-cluster) sized by member count; zooming in splits it.
 *   - Distance filtering: when a selection/highlight is active, only the selected
 *     points and their geographic neighbours (within a configurable km radius) are
 *     drawn — neighbours dimmed, everything else hidden.
 *
 * The layer is rebuilt fully on every data update, selection change and zoom, so
 * selection/dim state is baked into the markup instead of toggled afterwards.
 */
import * as L from "leaflet";

import { AircraftPoint } from "./dataModel";
import { VisualSettingsModel, DEFAULT_AIRCRAFT_TYPE } from "./settings";
import { AIRCRAFT_ICONS, AircraftIcon } from "./aircraftIcons";

export interface MarkerCallbacks {
    onClick: (point: AircraftPoint, event: MouseEvent) => void;
    /** position is the plane's location in container (viewport) pixels, for tooltip anchoring. */
    onMouseOver: (point: AircraftPoint, position: { x: number; y: number }) => void;
    onMouseOut: (point: AircraftPoint) => void;
}

/** A point as drawn at one world-copy longitude (so planes repeat across the wrapped map). */
interface Instance {
    point: AircraftPoint;
    lat: number;
    lng: number;
}

interface Cluster {
    instances: Instance[];
    latitude: number;
    longitude: number;
}

function escapeHtml(value: string): string {
    return value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
}

/** Great-circle distance in kilometres between two points. */
function haversineKm(a: AircraftPoint, b: AircraftPoint): number {
    const R = 6371;
    const toRad = Math.PI / 180;
    const dLat = (b.latitude - a.latitude) * toRad;
    const dLon = (b.longitude - a.longitude) * toRad;
    const la1 = a.latitude * toRad;
    const la2 = b.latitude * toRad;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Hard cap on individually-drawn aircraft. Past this many in view, clustering kicks
 * in regardless of zoom so the DOM never holds an unbounded number of heavy SVGs.
 */
const MAX_INDIVIDUAL_MARKERS = 300;

/** Cluster bubble diameter (px) bucketed by member count. */
function clusterDiameter(count: number): number {
    if (count < 10) {
        return 36;
    }
    if (count < 50) {
        return 44;
    }
    if (count < 200) {
        return 54;
    }
    return 64;
}

export function resolveAircraftShape(type: string | undefined): AircraftIcon | null {
    if (!type) {
        return null;
    }
    const key = String(type).trim().toUpperCase();
    return key && AIRCRAFT_ICONS[key] ? AIRCRAFT_ICONS[key] : null;
}

/** Centre the viewBox and scale (matches the original 1.46x marker zoom). */
function centeredScaleTransform(viewBox: string, scale: number): string {
    const v = viewBox.split(/[\s,]+/).map(Number);
    if (v.length !== 4 || v.some((n) => !isFinite(n))) {
        return `scale(${scale})`;
    }
    const cx = v[0] + v[2] / 2;
    const cy = v[1] + v[3] / 2;
    return `translate(${cx} ${cy}) scale(${scale}) translate(${-cx} ${-cy})`;
}

/** First <path> becomes the filled body, the rest are thin detail strokes. */
function prepareShapeBody(body: string): string {
    let first = true;
    return body.replace(/<path\b/g, () => {
        const cls = first ? "aircraft-shape-main" : "aircraft-shape-detail";
        first = false;
        return `<path class="${cls}"`;
    });
}

function buildPlaneSvg(icon: AircraftIcon, width: number, height: number, color: string): string {
    const transform = centeredScaleTransform(icon.viewBox, 1.46);
    return (
        `<svg class="aircraft-plane-icon aircraft-plane-shape" width="${width}" height="${height}" ` +
        `viewBox="${escapeHtml(icon.viewBox)}" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" ` +
        `preserveAspectRatio="xMidYMid meet" style="color:${color};">` +
        `<title>${escapeHtml(icon.name)}</title>` +
        `<g class="aircraft-shape-fit" transform="${escapeHtml(transform)}">${prepareShapeBody(icon.body)}</g>` +
        `</svg>`
    );
}

function buildLabel(point: AircraftPoint, settings: VisualSettingsModel): string {
    if (!settings.marker.showLabels.value) {
        return "";
    }
    const text = escapeHtml(point.label || point.id);
    let logo = "";
    if (settings.marker.showAirlineLogo.value && point.logoUrl) {
        const logoSize = clamp(Number(settings.marker.logoSize.value) || 18, 10, 42);
        logo =
            `<img class="aircraft-marker-label-logo" src="${escapeHtml(point.logoUrl)}" alt="" aria-hidden="true" ` +
            `style="width:${logoSize}px;height:${logoSize}px;">`;
    }
    return `<div class="aircraft-marker-label">${logo}<span class="aircraft-marker-label-text">${text}</span></div>`;
}

export class MarkerLayer {
    private readonly map: L.Map;
    private readonly group: L.LayerGroup;
    private points: AircraftPoint[] = [];
    private settings: VisualSettingsModel | null = null;
    private callbacks: MarkerCallbacks | null = null;
    /** Anchor points of the active selection/highlight; null when nothing is filtered. */
    private selectedIndices: Set<number> | null = null;

    /** Memoised plane SVG markup, keyed by type|width|height|color, to avoid rebuilding strings. */
    private planeSvgCache: Map<string, string> = new Map();

    constructor(map: L.Map) {
        this.map = map;
        this.group = L.layerGroup().addTo(map);
        // Rebuild on every pan/zoom: clustering is zoom-dependent and only markers
        // inside the current view are drawn (viewport culling), which keeps the DOM
        // node count low even with thousands of points. `moveend` covers both.
        this.map.on("moveend", () => this.rebuild());
    }

    /**
     * Points inside the current view, expanded to one Instance per visible world copy
     * so planes repeat as the map wraps horizontally. Latitude culling and a small
     * padding keep the rendered set small.
     */
    private instancesInView(points: AircraftPoint[]): Instance[] {
        const bounds = this.map.getBounds();
        if (!bounds.isValid()) {
            return points.map((p) => ({ point: p, lat: p.latitude, lng: p.longitude }));
        }
        const padded = bounds.pad(0.15);
        const west = padded.getWest();
        const east = padded.getEast();
        const south = padded.getSouth();
        const north = padded.getNorth();
        const instances: Instance[] = [];
        for (const p of points) {
            if (p.latitude < south || p.latitude > north) {
                continue;
            }
            // World copies whose shifted longitude falls inside the view.
            const kStart = Math.ceil((west - p.longitude) / 360);
            const kEnd = Math.floor((east - p.longitude) / 360);
            for (let k = kStart; k <= kEnd; k++) {
                instances.push({ point: p, lat: p.latitude, lng: p.longitude + 360 * k });
            }
        }
        return instances;
    }

    private planeSvg(icon: AircraftIcon, width: number, height: number, color: string): string {
        const key = `${icon.code}|${width}|${height}|${color}`;
        let svg = this.planeSvgCache.get(key);
        if (!svg) {
            svg = buildPlaneSvg(icon, width, height, color);
            this.planeSvgCache.set(key, svg);
        }
        return svg;
    }

    public render(points: AircraftPoint[], settings: VisualSettingsModel, callbacks: MarkerCallbacks): void {
        this.points = points;
        this.settings = settings;
        this.callbacks = callbacks;
        // Drop a stale selection that no longer matches the new data.
        if (this.selectedIndices) {
            const valid = new Set(points.map((p) => p.index));
            this.selectedIndices = new Set([...this.selectedIndices].filter((i) => valid.has(i)));
            if (!this.selectedIndices.size) {
                this.selectedIndices = null;
            }
        }
        this.rebuild();
    }

    /** Set the selection/highlight anchors. Pass null to clear. Rebuilds only on change. */
    public setSelection(selectedIndices: Set<number> | null): void {
        const next = selectedIndices && selectedIndices.size ? selectedIndices : null;
        if (this.selectionEquals(this.selectedIndices, next)) {
            return;
        }
        this.selectedIndices = next;
        this.rebuild();
    }

    public clear(): void {
        this.group.clearLayers();
        this.points = [];
        this.selectedIndices = null;
    }

    private selectionEquals(a: Set<number> | null, b: Set<number> | null): boolean {
        if (a === b) {
            return true;
        }
        if (!a || !b || a.size !== b.size) {
            return false;
        }
        for (const v of a) {
            if (!b.has(v)) {
                return false;
            }
        }
        return true;
    }

    private rebuild(): void {
        this.group.clearLayers();
        const settings = this.settings;
        if (!settings || !this.callbacks || !this.points.length) {
            return;
        }

        // Only points inside the current view are rendered, one copy per visible world.
        const instances = this.instancesInView(this.points);

        // Filtering active: show selected fully, nearby dimmed, hide the rest. No
        // clustering here so the spatial relationship around the selection is visible.
        // Anchors are taken from all points (a selected plane off-screen can still
        // pull an on-screen neighbour into the "nearby" set).
        if (this.selectedIndices) {
            const selected = this.selectedIndices;
            const anchors = this.points.filter((p) => selected.has(p.index));
            const nearbyKm = clamp(Number(settings.behavior.nearbyDistance.value) || 0, 0, 20000);
            for (const inst of instances) {
                if (selected.has(inst.point.index)) {
                    this.addAircraftMarker(inst, settings, true, false);
                } else if (nearbyKm > 0 && anchors.some((a) => haversineKm(inst.point, a) <= nearbyKm)) {
                    this.addAircraftMarker(inst, settings, false, true);
                }
            }
            return;
        }

        // No filtering: optional clustering of dense areas. Above the configured
        // zoom level clustering is switched off so a small zoom-in already splits
        // groups into individual aircraft instead of forcing a deep zoom — unless the
        // view still holds too many planes, in which case clustering stays on to keep
        // the DOM (and thus performance) bounded.
        const clusterMaxZoom = clamp(Number(settings.behavior.clusterMaxZoom.value) || 0, 0, 19);
        const tooMany = instances.length > MAX_INDIVIDUAL_MARKERS;
        if (settings.behavior.cluster.value && (this.map.getZoom() <= clusterMaxZoom || tooMany)) {
            const radius = clamp(Number(settings.behavior.clusterRadius.value) || 45, 20, 200);
            for (const cluster of this.clusterPoints(instances, radius)) {
                if (cluster.instances.length === 1) {
                    this.addAircraftMarker(cluster.instances[0], settings, false, false);
                } else {
                    this.addClusterMarker(cluster, settings);
                }
            }
            return;
        }

        for (const inst of instances) {
            this.addAircraftMarker(inst, settings, false, false);
        }
    }

    /** Grid clustering in projected pixel space at the current zoom (pan-independent). */
    private clusterPoints(instances: Instance[], radiusPx: number): Cluster[] {
        const zoom = this.map.getZoom();
        const cells = new Map<string, { instances: Instance[]; sx: number; sy: number }>();
        for (const inst of instances) {
            const pt = this.map.project([inst.lat, inst.lng], zoom);
            const key = `${Math.floor(pt.x / radiusPx)}_${Math.floor(pt.y / radiusPx)}`;
            let cell = cells.get(key);
            if (!cell) {
                cell = { instances: [], sx: 0, sy: 0 };
                cells.set(key, cell);
            }
            cell.instances.push(inst);
            cell.sx += pt.x;
            cell.sy += pt.y;
        }
        const clusters: Cluster[] = [];
        cells.forEach((cell) => {
            if (cell.instances.length === 1) {
                const inst = cell.instances[0];
                clusters.push({ instances: cell.instances, latitude: inst.lat, longitude: inst.lng });
            } else {
                const n = cell.instances.length;
                const center = this.map.unproject([cell.sx / n, cell.sy / n], zoom);
                clusters.push({ instances: cell.instances, latitude: center.lat, longitude: center.lng });
            }
        });
        return clusters;
    }

    private addAircraftMarker(
        inst: Instance,
        settings: VisualSettingsModel,
        selected: boolean,
        dimmed: boolean
    ): void {
        const point = inst.point;
        const size = clamp(Number(settings.marker.size.value) || 50, 18, 90);
        const symW = Math.round(1.32 * size);
        const boxW = Math.max(132, symW);
        const logoSize = clamp(Number(settings.marker.logoSize.value) || 18, 10, 42);
        const labelH = settings.marker.showLabels.value ? Math.max(22, logoSize + 6) : 0;
        const boxH = size + labelH;
        const shapeMode = settings.marker.shape.value.value as string;

        const label = buildLabel(point, settings);
        // In aircraft mode always render a plane: fall back to the default aircraft
        // icon when the point's type is unknown, so planes and circles never mix.
        const icon =
            shapeMode === "aircraft"
                ? resolveAircraftShape(point.aircraftType) || resolveAircraftShape(DEFAULT_AIRCRAFT_TYPE)
                : null;
        const symbol = icon
            ? `<div class="aircraft-symbol" style="width:${symW}px;height:${size}px;">${this.planeSvg(
                  icon,
                  symW,
                  size,
                  point.color
              )}</div>`
            : `<div class="aircraft-symbol aircraft-circle-symbol" style="width:${size}px;height:${size}px;background:${point.color};"></div>`;

        const stateClass = (selected ? " aircraft-marker-selected" : "") + (dimmed ? " aircraft-marker-dimmed" : "");
        const html = `<div class="aircraft-marker${stateClass}" style="width:${boxW}px;height:${boxH}px;">${label}${symbol}</div>`;

        const divIcon = L.divIcon({
            className: "aircraft-marker-icon",
            html,
            iconSize: [boxW, boxH],
            iconAnchor: [boxW / 2, boxH - size / 2],
        });
        const marker = L.marker([inst.lat, inst.lng], { icon: divIcon, keyboard: false });
        const callbacks = this.callbacks!;
        marker.on("click", (e: L.LeafletMouseEvent) => callbacks.onClick(point, e.originalEvent));
        // Anchor the tooltip to the plane's on-screen position, not the cursor.
        marker.on("mouseover", () => {
            const cp = this.map.latLngToContainerPoint([inst.lat, inst.lng]);
            callbacks.onMouseOver(point, { x: cp.x, y: cp.y });
        });
        marker.on("mouseout", () => callbacks.onMouseOut(point));
        marker.addTo(this.group);
    }

    private addClusterMarker(cluster: Cluster, settings: VisualSettingsModel): void {
        const count = cluster.instances.length;
        const size = clusterDiameter(count);
        const color = settings.marker.color.value.value;
        const html =
            `<div class="aircraft-cluster" style="width:${size}px;height:${size}px;background:${color};">` +
            `<span class="aircraft-cluster-count">${count}</span></div>`;
        const divIcon = L.divIcon({
            className: "aircraft-marker-icon",
            html,
            iconSize: [size, size],
            iconAnchor: [size / 2, size / 2],
        });
        const marker = L.marker([cluster.latitude, cluster.longitude], { icon: divIcon, keyboard: false });
        marker.on("click", () => this.zoomIntoCluster(cluster));
        marker.addTo(this.group);
    }

    /** Clicking a cluster zooms to fit its members (or steps in when co-located). */
    private zoomIntoCluster(cluster: Cluster): void {
        const bounds = L.latLngBounds(
            cluster.instances.map((i) => [i.lat, i.lng] as L.LatLngTuple)
        );
        const zoom = this.map.getZoom();
        if (bounds.isValid() && !bounds.getNorthEast().equals(bounds.getSouthWest())) {
            this.map.fitBounds(bounds, { padding: [60, 60], maxZoom: Math.min(zoom + 4, 18), animate: true });
        } else {
            this.map.setView([cluster.latitude, cluster.longitude], Math.min(zoom + 2, 18), { animate: true });
        }
    }
}
