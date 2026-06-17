/**
 * Canvas marker layer.
 *
 * Instead of one Leaflet DOM marker per aircraft (which does not scale to thousands
 * of objects on a real-time feed), every plane / circle / cluster is painted onto a
 * single <canvas> overlay. Aircraft SVG icons are rasterised once per (type, color,
 * size) into cached images and blitted with drawImage; hit-testing for clicks and
 * tooltips is done in code against tight per-plane radii (so hovering only triggers
 * on the plane itself, not a big invisible box).
 *
 * The layer follows Leaflet's renderer lifecycle: it lives in the overlay pane,
 * redraws on moveend/zoomend/resize, and transforms with the map during zoom
 * animation. Drawing happens in layer-point space offset by the canvas origin, and
 * hit-testing uses Leaflet's event layerPoint so it stays correct while panning.
 */
import * as L from "leaflet";

import { AircraftPoint } from "./dataModel";
import { VisualSettingsModel, DEFAULT_AIRCRAFT_TYPE } from "./settings";
import { AIRCRAFT_ICONS, AircraftIcon } from "./aircraftIcons";

/** Aircraft of one airline inside a hovered cluster. */
export interface ClusterTooltipGroup {
    airline: string;
    aircraft: string[];
    total: number;
}

export interface MarkerCallbacks {
    onClick: (point: AircraftPoint, event: MouseEvent) => void;
    /** position is the plane's location in container (viewport) pixels, for tooltip anchoring. */
    onMouseOver: (point: AircraftPoint, position: { x: number; y: number }) => void;
    /** Hovering a cluster: aircraft grouped by airline, for a summary tooltip. */
    onClusterOver: (groups: ClusterTooltipGroup[], position: { x: number; y: number }) => void;
    onMouseOut: () => void;
}

export interface MarkerHit {
    kind: "marker" | "cluster";
    point?: AircraftPoint;
    cluster?: Cluster;
    /** plane centre in layer-point space (for tooltip anchoring) */
    x: number;
    y: number;
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

interface HitItem {
    kind: "marker" | "cluster";
    point?: AircraftPoint;
    cluster?: Cluster;
    /** centre in layer points */
    x: number;
    y: number;
    /** circular hit radius (px) */
    r: number;
    /** optional label rectangle in layer points */
    label?: { x0: number; y0: number; x1: number; y1: number };
}

interface ImageEntry {
    img: HTMLImageElement;
    ready: boolean;
}

const CANVAS_PADDING = 0.1;
const LABEL_HEIGHT = 16;

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

function resolveAircraftShape(type: string | undefined): AircraftIcon | null {
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

/**
 * Standalone SVG for rasterisation: the icon paths are line drawings (fill:none,
 * stroke:currentColor) styled by CSS in the DOM build; here we inline the same look
 * (first path = filled silhouette + dark outline, the rest = thin detail strokes) so
 * the image renders identically without external CSS.
 */
function buildStandalonePlaneSvg(icon: AircraftIcon, width: number, height: number, color: string): string {
    const mainStyle =
        `fill:${color};stroke:#050608;stroke-width:1.2px;stroke-linejoin:round;` +
        `stroke-linecap:round;paint-order:fill;vector-effect:non-scaling-stroke`;
    const detailStyle =
        `fill:none;stroke:rgba(5,6,8,0.76);stroke-width:0.9px;stroke-linejoin:round;` +
        `stroke-linecap:round;vector-effect:non-scaling-stroke`;
    let first = true;
    const body = icon.body.replace(/<path\b[^>]*>/g, (tag) => {
        const stripped = tag.replace(/\s(?:style|class)="[^"]*"/g, "");
        const style = first ? mainStyle : detailStyle;
        first = false;
        return stripped.replace(/<path/, `<path style="${style}"`);
    });
    const transform = centeredScaleTransform(icon.viewBox, 1.46);
    return (
        `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" ` +
        `viewBox="${icon.viewBox}" preserveAspectRatio="xMidYMid meet">` +
        `<g transform="${transform}" style="overflow:visible">${body}</g></svg>`
    );
}

export class MarkerLayer {
    private readonly map: L.Map;
    private readonly canvas: HTMLCanvasElement;
    private readonly ctx: CanvasRenderingContext2D;

    private points: AircraftPoint[] = [];
    private settings: VisualSettingsModel | null = null;
    private callbacks: MarkerCallbacks | null = null;
    private selectedIndices: Set<number> | null = null;

    private origin: L.Point = L.point(0, 0);
    private hitItems: HitItem[] = [];
    private hoveredKey: string | null = null;
    private drawScheduled = false;

    private readonly iconCache: Map<string, ImageEntry> = new Map();
    private readonly logoCache: Map<string, ImageEntry> = new Map();

    constructor(map: L.Map) {
        this.map = map;
        const pane = map.getPanes().overlayPane;
        this.canvas = L.DomUtil.create("canvas", "aircraft-canvas-layer leaflet-zoom-animated", pane);
        this.ctx = this.canvas.getContext("2d")!;

        this.map.on("moveend zoomend resize", this.reset, this);
        this.map.on("zoomanim", this.animateZoom, this);
        this.map.on("mousemove", this.onMouseMove, this);
        this.map.on("mouseout", this.onMapMouseOut, this);

        this.reset();
    }

    public render(points: AircraftPoint[], settings: VisualSettingsModel, callbacks: MarkerCallbacks): void {
        this.points = points;
        this.settings = settings;
        this.callbacks = callbacks;
        if (this.selectedIndices) {
            const valid = new Set(points.map((p) => p.index));
            this.selectedIndices = new Set([...this.selectedIndices].filter((i) => valid.has(i)));
            if (!this.selectedIndices.size) {
                this.selectedIndices = null;
            }
        }
        this.draw();
    }

    /** Set the selection/highlight anchors. Pass null to clear. Redraws only on change. */
    public setSelection(selectedIndices: Set<number> | null): void {
        const next = selectedIndices && selectedIndices.size ? selectedIndices : null;
        if (this.selectionEquals(this.selectedIndices, next)) {
            return;
        }
        this.selectedIndices = next;
        this.draw();
    }

    public clear(): void {
        this.points = [];
        this.selectedIndices = null;
        this.hitItems = [];
        this.clearCanvas();
    }

    /** Hit-test the given layer point against drawn markers/clusters (topmost first). */
    public hitTest(layerPoint: L.Point): MarkerHit | null {
        for (let i = this.hitItems.length - 1; i >= 0; i--) {
            const it = this.hitItems[i];
            const dx = layerPoint.x - it.x;
            const dy = layerPoint.y - it.y;
            const inCircle = dx * dx + dy * dy <= it.r * it.r;
            const inLabel =
                !!it.label &&
                layerPoint.x >= it.label.x0 &&
                layerPoint.x <= it.label.x1 &&
                layerPoint.y >= it.label.y0 &&
                layerPoint.y <= it.label.y1;
            if (inCircle || inLabel) {
                return { kind: it.kind, point: it.point, cluster: it.cluster, x: it.x, y: it.y };
            }
        }
        return null;
    }

    /** Clicking a cluster zooms to fit its members (or steps in when co-located). */
    public zoomIntoCluster(cluster: Cluster): void {
        const bounds = L.latLngBounds(cluster.instances.map((i) => [i.lat, i.lng] as L.LatLngTuple));
        const zoom = this.map.getZoom();
        if (bounds.isValid() && !bounds.getNorthEast().equals(bounds.getSouthWest())) {
            this.map.fitBounds(bounds, { padding: [60, 60], maxZoom: Math.min(zoom + 4, 18), animate: true });
        } else {
            this.map.setView([cluster.latitude, cluster.longitude], Math.min(zoom + 2, 18), { animate: true });
        }
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

    // --- Leaflet layer lifecycle -------------------------------------------------

    private reset(): void {
        const size = this.map.getSize();
        const min = this.map.containerPointToLayerPoint(size.multiplyBy(-CANVAS_PADDING)).round();
        const canvasSize = size.multiplyBy(1 + CANVAS_PADDING * 2).round();
        this.origin = min;

        const dpr = window.devicePixelRatio || 1;
        this.canvas.width = Math.max(1, Math.round(canvasSize.x * dpr));
        this.canvas.height = Math.max(1, Math.round(canvasSize.y * dpr));
        this.canvas.style.width = `${canvasSize.x}px`;
        this.canvas.style.height = `${canvasSize.y}px`;
        L.DomUtil.setPosition(this.canvas, min);

        this.draw();
    }

    private animateZoom(e: L.ZoomAnimEvent): void {
        const map = this.map as unknown as {
            getZoomScale: (z: number, from: number) => number;
            layerPointToLatLng: (p: L.Point) => L.LatLng;
            _latLngToNewLayerPoint: (ll: L.LatLng, zoom: number, center: L.LatLng) => L.Point;
        };
        const scale = map.getZoomScale(e.zoom, this.map.getZoom());
        const offset = map._latLngToNewLayerPoint(map.layerPointToLatLng(this.origin), e.zoom, e.center);
        L.DomUtil.setTransform(this.canvas, offset, scale);
    }

    private clearCanvas(): void {
        this.ctx.setTransform(1, 0, 0, 1, 0, 0);
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    }

    private scheduleDraw(): void {
        if (this.drawScheduled) {
            return;
        }
        this.drawScheduled = true;
        window.requestAnimationFrame(() => {
            this.drawScheduled = false;
            this.draw();
        });
    }

    // --- Drawing -----------------------------------------------------------------

    private draw(): void {
        this.clearCanvas();
        const dpr = window.devicePixelRatio || 1;
        this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        this.hitItems = [];

        const settings = this.settings;
        if (!settings || !this.callbacks || !this.points.length) {
            return;
        }

        const instances = this.instancesInView(this.points);

        // Filtering active: selected full, nearby dimmed, rest hidden. No clustering.
        if (this.selectedIndices) {
            const selected = this.selectedIndices;
            const anchors = this.points.filter((p) => selected.has(p.index));
            const nearbyKm = clamp(Number(settings.behavior.nearbyDistance.value) || 0, 0, 20000);
            const dimmed: Instance[] = [];
            const chosen: Instance[] = [];
            for (const inst of instances) {
                if (selected.has(inst.point.index)) {
                    chosen.push(inst);
                } else if (nearbyKm > 0 && anchors.some((a) => haversineKm(inst.point, a) <= nearbyKm)) {
                    dimmed.push(inst);
                }
            }
            for (const inst of dimmed) {
                this.drawAircraft(inst, settings, false, true);
            }
            for (const inst of chosen) {
                this.drawAircraft(inst, settings, true, false);
            }
            return;
        }

        // No filtering: cluster dense areas only up to the configured zoom. Above it
        // every aircraft is drawn individually, regardless of how many are in view.
        const clusterMaxZoom = clamp(Number(settings.behavior.clusterMaxZoom.value) || 0, 0, 19);
        if (settings.behavior.cluster.value && this.map.getZoom() <= clusterMaxZoom) {
            const radius = clamp(Number(settings.behavior.clusterRadius.value) || 45, 20, 200);
            for (const cluster of this.clusterPoints(instances, radius)) {
                if (cluster.instances.length === 1) {
                    this.drawAircraft(cluster.instances[0], settings, false, false);
                } else {
                    this.drawCluster(cluster, settings);
                }
            }
            return;
        }

        for (const inst of instances) {
            this.drawAircraft(inst, settings, false, false);
        }
    }

    /**
     * Points inside the current view, expanded to one Instance per visible world copy
     * so planes repeat as the map wraps horizontally.
     */
    private instancesInView(points: AircraftPoint[]): Instance[] {
        const bounds = this.map.getBounds();
        if (!bounds.isValid()) {
            return points.map((p) => ({ point: p, lat: p.latitude, lng: p.longitude }));
        }
        const padded = bounds.pad(CANVAS_PADDING + 0.05);
        const west = padded.getWest();
        const east = padded.getEast();
        const south = padded.getSouth();
        const north = padded.getNorth();
        const instances: Instance[] = [];
        for (const p of points) {
            if (p.latitude < south || p.latitude > north) {
                continue;
            }
            const kStart = Math.ceil((west - p.longitude) / 360);
            const kEnd = Math.floor((east - p.longitude) / 360);
            for (let k = kStart; k <= kEnd; k++) {
                instances.push({ point: p, lat: p.latitude, lng: p.longitude + 360 * k });
            }
        }
        return instances;
    }

    /** Grid clustering in layer-point space at the current zoom. */
    private clusterPoints(instances: Instance[], radiusPx: number): Cluster[] {
        const cells = new Map<string, { instances: Instance[]; sx: number; sy: number }>();
        for (const inst of instances) {
            const pt = this.map.latLngToLayerPoint([inst.lat, inst.lng]);
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
                const center = this.map.layerPointToLatLng(L.point(cell.sx / n, cell.sy / n));
                clusters.push({ instances: cell.instances, latitude: center.lat, longitude: center.lng });
            }
        });
        return clusters;
    }

    private drawAircraft(inst: Instance, settings: VisualSettingsModel, selected: boolean, dimmed: boolean): void {
        const point = inst.point;
        const lp = this.map.latLngToLayerPoint([inst.lat, inst.lng]);
        const x = lp.x - this.origin.x;
        const y = lp.y - this.origin.y;

        const size = clamp(Number(settings.marker.size.value) || 50, 18, 90);
        const symW = Math.round(1.32 * size);
        const shapeMode = settings.marker.shape.value.value as string;
        const icon =
            shapeMode === "aircraft"
                ? resolveAircraftShape(point.aircraftType) || resolveAircraftShape(DEFAULT_AIRCRAFT_TYPE)
                : null;

        const ctx = this.ctx;
        ctx.save();
        if (dimmed) {
            ctx.globalAlpha = 0.28;
        }

        if (icon) {
            const img = this.getPlaneImage(icon, point.color, symW, size);
            if (img) {
                if (selected) {
                    ctx.save();
                    ctx.shadowColor = "rgba(34,211,238,0.95)";
                    ctx.shadowBlur = 10;
                    ctx.drawImage(img, x - symW / 2, y - size / 2, symW, size);
                    ctx.restore();
                }
                ctx.drawImage(img, x - symW / 2, y - size / 2, symW, size);
            } else {
                this.drawDot(x, y, Math.max(8, size * 0.35), point.color, selected);
            }
        } else {
            this.drawDot(x, y, size / 2, point.color, selected);
        }

        const label = this.drawLabel(point, settings, x, y, size, selected);
        ctx.restore();

        const hitR = Math.max(10, (icon ? size * 0.45 : size / 2 + 2));
        this.hitItems.push({
            kind: "marker",
            point,
            x: lp.x,
            y: lp.y,
            r: hitR,
            label: label
                ? {
                      x0: lp.x + (label.x0 - x),
                      y0: lp.y + (label.y0 - y),
                      x1: lp.x + (label.x1 - x),
                      y1: lp.y + (label.y1 - y),
                  }
                : undefined,
        });
    }

    private drawDot(x: number, y: number, radius: number, color: string, selected: boolean): void {
        const ctx = this.ctx;
        if (selected) {
            ctx.save();
            ctx.shadowColor = "rgba(34,211,238,0.95)";
            ctx.shadowBlur = 10;
        }
        ctx.beginPath();
        ctx.arc(x, y, radius, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = "#050608";
        ctx.stroke();
        if (selected) {
            ctx.restore();
        }
    }

    /** Returns the drawn label rectangle (canvas-local coords) or null when labels are off. */
    private drawLabel(
        point: AircraftPoint,
        settings: VisualSettingsModel,
        x: number,
        y: number,
        size: number,
        selected: boolean
    ): { x0: number; y0: number; x1: number; y1: number } | null {
        if (!settings.marker.showLabels.value) {
            return null;
        }
        const ctx = this.ctx;
        const text = point.label || point.id || "";
        const pad = 5;
        const gap = 3;
        const logoSize = clamp(Number(settings.marker.logoSize.value) || 18, 10, 42);
        const showLogo = settings.marker.showAirlineLogo.value && !!point.logoUrl;
        const logo = showLogo ? this.getLogoImage(point.logoUrl!) : null;
        const logoW = showLogo ? logoSize + gap : 0;

        ctx.font = `700 9px "Segoe UI", Arial, sans-serif`;
        ctx.textBaseline = "middle";
        ctx.textAlign = "left";
        const textW = Math.min(110, ctx.measureText(text).width);
        const rectW = pad * 2 + logoW + textW;
        const rectH = LABEL_HEIGHT;
        const cx = x;
        const cy = y - size / 2 - rectH / 2;
        const left = cx - rectW / 2;
        const top = cy - rectH / 2;

        this.roundRect(left, top, rectW, rectH, 4);
        ctx.fillStyle = "rgba(255,255,255,0.96)";
        ctx.fill();
        ctx.lineWidth = 1;
        ctx.strokeStyle = selected ? "#22d3ee" : "rgba(15,23,42,0.22)";
        ctx.stroke();

        let textX = left + pad;
        if (showLogo && logo) {
            ctx.drawImage(logo, left + pad, cy - logoSize / 2, logoSize, logoSize);
            textX += logoSize + gap;
        } else if (showLogo) {
            textX += logoSize + gap;
        }

        ctx.save();
        ctx.beginPath();
        ctx.rect(textX, top, rectW - (textX - left) - pad, rectH);
        ctx.clip();
        ctx.fillStyle = "#111827";
        ctx.fillText(text, textX, cy + 0.5);
        ctx.restore();

        return { x0: left, y0: top, x1: left + rectW, y1: top + rectH };
    }

    private drawCluster(cluster: Cluster, settings: VisualSettingsModel): void {
        const lp = this.map.latLngToLayerPoint([cluster.latitude, cluster.longitude]);
        const x = lp.x - this.origin.x;
        const y = lp.y - this.origin.y;
        const count = cluster.instances.length;
        const diameter = clusterDiameter(count);
        const radius = diameter / 2;
        const color = settings.marker.color.value.value;

        const ctx = this.ctx;
        ctx.save();
        ctx.globalAlpha = 0.94;
        ctx.beginPath();
        ctx.arc(x, y, radius, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = "rgba(5,6,8,0.85)";
        ctx.stroke();
        ctx.globalAlpha = 1;
        ctx.fillStyle = "#04201d";
        ctx.font = `800 12px "Segoe UI", Arial, sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(String(count), x, y + 0.5);
        ctx.textAlign = "start";
        ctx.restore();

        this.hitItems.push({ kind: "cluster", cluster, x: lp.x, y: lp.y, r: radius });
    }

    private roundRect(x: number, y: number, w: number, h: number, r: number): void {
        const ctx = this.ctx;
        const rad = Math.min(r, w / 2, h / 2);
        ctx.beginPath();
        ctx.moveTo(x + rad, y);
        ctx.arcTo(x + w, y, x + w, y + h, rad);
        ctx.arcTo(x + w, y + h, x, y + h, rad);
        ctx.arcTo(x, y + h, x, y, rad);
        ctx.arcTo(x, y, x + w, y, rad);
        ctx.closePath();
    }

    // --- Image caches ------------------------------------------------------------

    private getPlaneImage(icon: AircraftIcon, color: string, symW: number, size: number): HTMLImageElement | null {
        const key = `${icon.code}|${color}|${symW}x${size}`;
        let entry = this.iconCache.get(key);
        if (!entry) {
            const img = new Image();
            entry = { img, ready: false };
            const captured = entry;
            img.onload = () => {
                captured.ready = true;
                this.scheduleDraw();
            };
            img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(buildStandalonePlaneSvg(icon, symW, size, color));
            this.iconCache.set(key, entry);
        }
        return entry.ready ? entry.img : null;
    }

    private getLogoImage(url: string): HTMLImageElement | null {
        let entry = this.logoCache.get(url);
        if (!entry) {
            const img = new Image();
            entry = { img, ready: false };
            const captured = entry;
            img.crossOrigin = "anonymous";
            img.onload = () => {
                captured.ready = true;
                this.scheduleDraw();
            };
            img.src = url;
            this.logoCache.set(url, entry);
        }
        return entry.ready ? entry.img : null;
    }

    // --- Hover -------------------------------------------------------------------

    private onMouseMove(e: L.LeafletMouseEvent): void {
        if (!this.callbacks) {
            return;
        }
        const hit = this.hitTest(e.layerPoint);
        if (hit && hit.kind === "marker" && hit.point) {
            const key = `m${hit.point.index}`;
            if (this.hoveredKey !== key) {
                this.hoveredKey = key;
                const cp = this.map.layerPointToContainerPoint(L.point(hit.x, hit.y));
                this.callbacks.onMouseOver(hit.point, { x: cp.x, y: cp.y });
            }
        } else if (hit && hit.kind === "cluster" && hit.cluster) {
            const key = `c${Math.round(hit.x)}_${Math.round(hit.y)}`;
            if (this.hoveredKey !== key) {
                this.hoveredKey = key;
                const cp = this.map.layerPointToContainerPoint(L.point(hit.x, hit.y));
                this.callbacks.onClusterOver(this.buildClusterGroups(hit.cluster), { x: cp.x, y: cp.y });
            }
        } else if (this.hoveredKey) {
            this.hoveredKey = null;
            this.callbacks.onMouseOut();
        }
    }

    private onMapMouseOut(): void {
        if (this.hoveredKey && this.callbacks) {
            this.hoveredKey = null;
            this.callbacks.onMouseOut();
        }
    }

    /** Aircraft of a cluster grouped by airline (point.group), busiest airline first. */
    private buildClusterGroups(cluster: Cluster): ClusterTooltipGroup[] {
        const byAirline = new Map<string, string[]>();
        const seen = new Set<number>();
        for (const inst of cluster.instances) {
            const p = inst.point;
            if (seen.has(p.index)) {
                continue;
            }
            seen.add(p.index);
            const airline = p.group && p.group.length ? p.group : "—";
            let list = byAirline.get(airline);
            if (!list) {
                list = [];
                byAirline.set(airline, list);
            }
            list.push(p.label || p.id);
        }
        const groups: ClusterTooltipGroup[] = [];
        byAirline.forEach((aircraft, airline) => groups.push({ airline, aircraft, total: aircraft.length }));
        groups.sort((a, b) => b.total - a.total);
        return groups;
    }
}
