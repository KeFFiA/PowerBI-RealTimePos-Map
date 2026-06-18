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

import { AircraftPoint, AirportInfo } from "./dataModel";
import { VisualSettingsModel, DEFAULT_AIRCRAFT_TYPE } from "./settings";
import { AIRCRAFT_ICONS, AircraftIcon } from "./aircraftIcons";
import { TEST_LOGO } from "./testLogo";

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
    /** display latitude (may differ from point.latitude during timelapse) */
    lat: number;
    /** display longitude shifted into the visible world copy */
    lng: number;
    /** display longitude without the world-copy shift */
    lon0: number;
    /** display heading in degrees */
    heading: number;
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
const LABEL_HEIGHT = 14;

/**
 * Side-view airliner (nose to the right / east) with landing gear, used for aircraft
 * that are on the ground. Same draw pipeline as the top-view icons: the first path is
 * the filled silhouette (fuselage + fin + tailplane + wing + wheels), the rest are
 * thin detail strokes (window line + gear struts). Drawn without heading rotation.
 */
// Wide viewBox with margins so the profile renders at roughly the same footprint
// as a normal (top-view) marker rather than oversized.
const SIDE_VIEW_VIEWBOX = "-66 -28 360 160";
// Body (filled + dark outline): fuselage, fin, tailplane, wing, engine pod.
const SIDE_BODY_D =
    "M24,51 L44,42 L182,42 C196,42 204,46 207,52 C204,58 196,62 182,62 L56,62 L24,53 Z " +
    "M44,42 L36,15 L50,15 L64,42 Z " +
    "M40,47 L20,42 L20,46 L40,50 Z " +
    "M120,60 L96,78 L110,78 L138,60 Z " +
    "M106,74 a12,7 0 1,0 24,0 a12,7 0 1,0 -24,0 Z";
// Landing gear (struts + wheels): filled in the body colour with NO outline.
const SIDE_GEAR_D =
    "M169,61 L173,61 L172.5,80 L169.5,80 Z " +
    "M111.5,72 L115.5,72 L114.5,84 L111.5,84 Z " +
    "M122,72 L126,72 L125.5,84 L122.5,84 Z " +
    "M166,82 a5,5 0 1,0 10,0 a5,5 0 1,0 -10,0 Z " +
    "M108,85 a5,5 0 1,0 10,0 a5,5 0 1,0 -10,0 Z " +
    "M120,85 a5,5 0 1,0 10,0 a5,5 0 1,0 -10,0 Z";
// Detail strokes: window line + cockpit window.
const SIDE_DETAIL_D = "M58,48.5 L176,48.5 M186,46.5 L196,47.5";

const SIDE_VIEW_ICON: AircraftIcon = {
    code: "_SIDEVIEW4",
    name: "Aircraft (side)",
    sourceFile: "",
    viewBox: SIDE_VIEW_VIEWBOX,
    body: "",
};

/** Side-view icon SVG with the gear filled (no outline), unlike the top-view builder. */
function buildSideViewSvg(width: number, height: number, color: string): string {
    const stroke = "stroke-linejoin:round;stroke-linecap:round;vector-effect:non-scaling-stroke";
    const bodyStyle = `fill:${color};stroke:#050608;stroke-width:1.2px;paint-order:fill;${stroke}`;
    const gearStyle = `fill:${color};stroke:none`;
    const detailStyle = `fill:none;stroke:rgba(5,6,8,0.76);stroke-width:0.9px;${stroke}`;
    const transform = centeredScaleTransform(SIDE_VIEW_VIEWBOX, 1.46);
    return (
        `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" ` +
        `viewBox="${SIDE_VIEW_VIEWBOX}" preserveAspectRatio="xMidYMid meet">` +
        `<g transform="${transform}" style="overflow:visible">` +
        `<path style="${bodyStyle}" d="${SIDE_BODY_D}" />` +
        `<path style="${gearStyle}" d="${SIDE_GEAR_D}" />` +
        `<path style="${detailStyle}" d="${SIDE_DETAIL_D}" />` +
        `</g></svg>`
    );
}

function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
}

/** Great-circle distance in kilometres between two lat/lon pairs. */
function haversineLL(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const R = 6371;
    const toRad = Math.PI / 180;
    const dLat = (lat2 - lat1) * toRad;
    const dLon = (lon2 - lon1) * toRad;
    const h =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

function haversineKm(a: AircraftPoint, b: AircraftPoint): number {
    return haversineLL(a.latitude, a.longitude, b.latitude, b.longitude);
}

/** Bearing in degrees clockwise from north, from point a to point b. */
function bearingDeg(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const toRad = Math.PI / 180;
    const phi1 = lat1 * toRad;
    const phi2 = lat2 * toRad;
    const dLon = (lon2 - lon1) * toRad;
    const y = Math.sin(dLon) * Math.cos(phi2);
    const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLon);
    return (Math.atan2(y, x) * (180 / Math.PI) + 360) % 360;
}

function parseHex(hex: string): [number, number, number] | null {
    let h = hex.trim().replace(/^#/, "");
    if (h.length === 3) {
        h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    }
    if (h.length !== 6 || /[^0-9a-fA-F]/.test(h)) {
        return null;
    }
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

/**
 * Tint a colour by `strength` (0..1): the colour mixed with white, where 1 is the
 * full colour and lower values blend in more white (e.g. 0.75 = 75% colour + 25%
 * white). Returns the original on parse failure.
 */
function tintColor(color: string, strength: number): string {
    if (strength >= 0.999) {
        return color;
    }
    const rgb = parseHex(color);
    if (!rgb) {
        return color;
    }
    const f = clamp(strength, 0, 1);
    const mix = (c: number) => Math.round(c * f + 255 * (1 - f));
    return `rgb(${mix(rgb[0])},${mix(rgb[1])},${mix(rgb[2])})`;
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
    /** Timelapse time (epoch ms); null = live (latest positions). */
    private timelapseTime: number | null = null;

    private origin: L.Point = L.point(0, 0);
    private hitItems: HitItem[] = [];
    /** Airport circle hit targets (layer points), for hover-to-reveal labels. */
    private airportHits: { key: string; x: number; y: number; r: number }[] = [];
    private hoveredAirport: string | null = null;
    /** Current hover zone: "none" | "m:<idx>" | "c:<x_y>" | "a:<key>". */
    private hoverZone = "none";
    /** Long-hover preview: index of the plane to treat as a temporary selection. */
    private hoverPreviewIndex: number | null = null;
    private hoverTimer: number | null = null;
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
        // A data refresh re-creates markers, so drop any in-flight hover preview.
        this.clearHoverTimer();
        this.hoverPreviewIndex = null;
        this.hoverZone = "none";
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
        // A real selection supersedes any hover preview.
        if (next) {
            this.clearHoverTimer();
            this.hoverPreviewIndex = null;
        }
        this.draw();
    }

    /** Set the timelapse time (epoch ms); null = live. Redraws. */
    public setTimelapse(time: number | null): void {
        if (this.timelapseTime === time) {
            return;
        }
        this.timelapseTime = time;
        this.draw();
    }

    /**
     * Display position/heading of a point at the current timelapse time. Returns null
     * to hide the point (timelapse is before its first sample). Live (or no timed
     * data) → the point's current position/heading.
     */
    private resolveDisplay(point: AircraftPoint): { lat: number; lon: number; heading: number } | null {
        const T = this.timelapseTime;
        if (T === null || !point.flown || !point.flown.length) {
            return { lat: point.latitude, lon: point.longitude, heading: point.heading };
        }
        const timed = point.flown.filter((f) => f.t != null);
        if (!timed.length) {
            return { lat: point.latitude, lon: point.longitude, heading: point.heading };
        }
        if (T >= (timed[timed.length - 1].t as number)) {
            return { lat: point.latitude, lon: point.longitude, heading: point.heading };
        }
        let idx = -1;
        for (let i = 0; i < timed.length; i++) {
            if ((timed[i].t as number) <= T) {
                idx = i;
            } else {
                break;
            }
        }
        if (idx < 0) {
            return null; // before this aircraft's first sample
        }
        const cur = timed[idx];
        let heading = point.heading;
        if (idx > 0) {
            heading = bearingDeg(timed[idx - 1].lat, timed[idx - 1].lon, cur.lat, cur.lon);
        } else if (timed.length > 1) {
            heading = bearingDeg(cur.lat, cur.lon, timed[1].lat, timed[1].lon);
        }
        return { lat: cur.lat, lon: cur.lon, heading };
    }

    public clear(): void {
        this.points = [];
        this.selectedIndices = null;
        this.hitItems = [];
        this.airportHits = [];
        this.clearHoverTimer();
        this.hoverPreviewIndex = null;
        this.hoverZone = "none";
        this.clearCanvas();
    }

    private clearHoverTimer(): void {
        if (this.hoverTimer !== null) {
            window.clearTimeout(this.hoverTimer);
            this.hoverTimer = null;
        }
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
        this.airportHits = [];

        const settings = this.settings;
        if (!settings || !this.callbacks || !this.points.length) {
            return;
        }

        const instances = this.instancesInView(this.points);

        // Effective filter: a real selection wins; otherwise a long-hover preview
        // temporarily acts like a selection (dim others, draw its route + airports).
        const filterSet =
            this.selectedIndices ||
            (this.hoverPreviewIndex !== null ? new Set<number>([this.hoverPreviewIndex]) : null);

        // Filtering active. Real selection: selected full, nearby dimmed, rest hidden.
        // Hover preview: the hovered plane full, ALL others dimmed (none hidden).
        if (filterSet) {
            const isPreview = !this.selectedIndices && this.hoverPreviewIndex !== null;
            const selected = filterSet;
            const selectedPoints = this.points.filter((p) => selected.has(p.index));
            const nearbyKm = clamp(Number(settings.behavior.nearbyDistance.value) || 0, 0, 20000);
            const dimmed: Instance[] = [];
            const chosenVisible: Instance[] = [];
            for (const inst of instances) {
                if (selected.has(inst.point.index)) {
                    chosenVisible.push(inst);
                } else if (
                    isPreview ||
                    (nearbyKm > 0 && selectedPoints.some((a) => haversineKm(inst.point, a) <= nearbyKm))
                ) {
                    dimmed.push(inst);
                }
            }
            for (const inst of dimmed) {
                this.drawAircraft(inst, settings, false, true);
            }
            // Routes/airports are drawn for EVERY selected plane — including ones whose
            // marker is off-screen — using the world copy nearest the current view, so
            // the route stays visible even when the plane itself is panned out of sight.
            const maxRoutes = Math.max(0, Math.round(Number(settings.routes.maxRoutes.value) || 0));
            const drawRoutes =
                settings.routes.show.value && (maxRoutes === 0 || selectedPoints.length <= maxRoutes);
            if (drawRoutes) {
                const centerLng = this.map.getCenter().lng;
                for (const p of selectedPoints) {
                    const d = this.resolveDisplay(p);
                    if (!d) {
                        continue;
                    }
                    const k = Math.round((centerLng - d.lon) / 360);
                    this.drawRoute(
                        { point: p, lat: d.lat, lng: d.lon + 360 * k, lon0: d.lon, heading: d.heading },
                        settings
                    );
                }
            }
            for (const inst of chosenVisible) {
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
        const valid = bounds.isValid();
        const padded = valid ? bounds.pad(CANVAS_PADDING + 0.05) : null;
        const west = padded ? padded.getWest() : -180;
        const east = padded ? padded.getEast() : 180;
        const south = padded ? padded.getSouth() : -90;
        const north = padded ? padded.getNorth() : 90;
        const instances: Instance[] = [];
        for (const p of points) {
            const d = this.resolveDisplay(p);
            if (!d) {
                continue; // hidden at the current timelapse time
            }
            if (d.lat < south || d.lat > north) {
                continue;
            }
            const kStart = Math.ceil((west - d.lon) / 360);
            const kEnd = Math.floor((east - d.lon) / 360);
            for (let k = kStart; k <= kEnd; k++) {
                instances.push({ point: p, lat: d.lat, lng: d.lon + 360 * k, lon0: d.lon, heading: d.heading });
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
                ? point.onGround
                    ? SIDE_VIEW_ICON
                    : resolveAircraftShape(point.aircraftType) || resolveAircraftShape(DEFAULT_AIRCRAFT_TYPE)
                : null;

        const ctx = this.ctx;
        ctx.save();
        if (dimmed) {
            ctx.globalAlpha = 0.28;
        }

        if (icon) {
            const img = this.getPlaneImage(icon, point.color, symW, size);
            if (img) {
                // Heading rotation for airborne (nose-up icons); on-ground uses the
                // side-view icon as-is (already nose-east), so no rotation.
                const rad = point.onGround ? 0 : ((inst.heading || 0) * Math.PI) / 180;
                ctx.save();
                ctx.translate(x, y);
                ctx.rotate(rad);
                if (selected) {
                    ctx.save();
                    ctx.shadowColor = "rgba(34,211,238,0.95)";
                    ctx.shadowBlur = 10;
                    ctx.drawImage(img, -symW / 2, -size / 2, symW, size);
                    ctx.restore();
                }
                ctx.drawImage(img, -symW / 2, -size / 2, symW, size);
                ctx.restore();
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

    /**
     * Route for a selected aircraft: a solid line in the plane's colour through the
     * traveled track (departure -> flown points -> current), and a thinner dashed
     * line straight on to the arrival airport. Drawn in the same world copy as the
     * plane instance via a longitude shift.
     */
    private drawRoute(inst: Instance, settings: VisualSettingsModel): void {
        const point = inst.point;
        const cfg = settings.routes;
        const lonShift = inst.lng - inst.lon0;
        const curLat = inst.lat;
        const curLon = inst.lon0;
        const ctx = this.ctx;
        const color = cfg.useAircraftColor.value ? point.color : cfg.color.value.value;
        const traveledW = clamp(Number(cfg.traveledWidth.value) || 3, 0.5, 12);
        const remainingW = clamp(Number(cfg.remainingWidth.value) || 1.5, 0.5, 12);
        const toXY = (lat: number, lon: number): [number, number] => {
            const lp = this.map.latLngToLayerPoint([lat, lon + lonShift]);
            return [lp.x - this.origin.x, lp.y - this.origin.y];
        };

        // On the ground: no route line, no origin — show only the airport the plane
        // is currently at (the nearer of departure/arrival to its position).
        if (point.onGround) {
            const [px, py] = toXY(curLat, curLon);
            let bestCoord: [number, number] | null = null;
            let bestInfo: AirportInfo | undefined;
            let bestD = Infinity;
            const consider = (coord: [number, number] | undefined, info: AirportInfo | undefined) => {
                if (!coord) {
                    return;
                }
                const d = (coord[0] - curLat) ** 2 + (coord[1] - curLon) ** 2;
                if (d < bestD) {
                    bestD = d;
                    bestCoord = coord;
                    bestInfo = info;
                }
            };
            consider(point.departure, point.departureInfo);
            consider(point.arrival, point.arrivalInfo);
            if (bestCoord) {
                const [ax, ay] = toXY(bestCoord[0], bestCoord[1]);
                const key = `${point.index}:gnd`;
                this.airportHits.push({ key, x: ax + this.origin.x, y: ay + this.origin.y, r: 9 });
                this.drawAirport(ax, ay, bestInfo, color, px, py, this.hoveredAirport === key);
            }
            return;
        }

        // Solid traveled track. With a flown path we draw exactly that polyline in
        // order (the recorded trail IS the route); during timelapse only samples up to
        // the current time are drawn. The current position is appended only when the
        // last sample is close to it (so a trail that doesn't quite reach the plane
        // still connects, without drawing a long stray segment). Without a trail we
        // fall back to a straight departure -> current leg.
        const T = this.timelapseTime;
        const track: [number, number][] = [];
        const samples =
            point.flown && point.flown.length
                ? T === null
                    ? point.flown
                    : point.flown.filter((f) => f.t != null && (f.t as number) <= T)
                : [];
        if (samples.length) {
            for (const f of samples) {
                track.push([f.lat, f.lon]);
            }
            const last = samples[samples.length - 1];
            if (haversineLL(last.lat, last.lon, curLat, curLon) <= 200) {
                track.push([curLat, curLon]);
            }
        } else if (!point.flown || !point.flown.length) {
            if (point.departure) {
                track.push(point.departure);
            }
            track.push([curLat, curLon]);
        }

        if (track.length >= 2) {
            ctx.save();
            ctx.beginPath();
            ctx.lineWidth = traveledW;
            ctx.strokeStyle = color;
            ctx.lineJoin = "round";
            ctx.lineCap = "round";
            const [x0, y0] = toXY(track[0][0], track[0][1]);
            ctx.moveTo(x0, y0);
            for (let i = 1; i < track.length; i++) {
                const [x, y] = toXY(track[i][0], track[i][1]);
                ctx.lineTo(x, y);
            }
            ctx.stroke();
            ctx.restore();
        }

        // Dashed remaining leg straight to the arrival airport (thinner).
        if (point.arrival) {
            ctx.save();
            ctx.beginPath();
            ctx.lineWidth = remainingW;
            ctx.strokeStyle = color;
            ctx.lineCap = "butt";
            ctx.setLineDash([Math.max(10, remainingW * 6), Math.max(8, remainingW * 5)]);
            const [cx, cy] = toXY(curLat, curLon);
            const [ax, ay] = toXY(point.arrival[0], point.arrival[1]);
            ctx.moveTo(cx, cy);
            ctx.lineTo(ax, ay);
            ctx.stroke();
            ctx.restore();
        }

        // Airport markers at both endpoints. Circle always; the name/city/country
        // plate is hidden until the circle is hovered, and placed on the side away
        // from the aircraft so the plane never covers it.
        const [planeX, planeY] = toXY(curLat, curLon);
        if (point.departure) {
            const [dx, dy] = toXY(point.departure[0], point.departure[1]);
            const key = `${point.index}:dep`;
            this.airportHits.push({ key, x: dx + this.origin.x, y: dy + this.origin.y, r: 9 });
            this.drawAirport(dx, dy, point.departureInfo, color, planeX, planeY, this.hoveredAirport === key);
        }
        if (point.arrival) {
            const [ax, ay] = toXY(point.arrival[0], point.arrival[1]);
            const key = `${point.index}:arr`;
            this.airportHits.push({ key, x: ax + this.origin.x, y: ay + this.origin.y, r: 9 });
            this.drawAirport(ax, ay, point.arrivalInfo, color, planeX, planeY, this.hoveredAirport === key);
        }
    }

    private drawAirport(
        x: number,
        y: number,
        info: AirportInfo | undefined,
        color: string,
        planeX: number,
        planeY: number,
        showPlate: boolean
    ): void {
        const ctx = this.ctx;
        ctx.save();
        ctx.beginPath();
        ctx.arc(x, y, 5, 0, Math.PI * 2);
        ctx.fillStyle = "#ffffff";
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = color;
        ctx.stroke();
        ctx.restore();

        if (!showPlate || !info) {
            return;
        }
        const lines: { text: string; bold: boolean }[] = [];
        if (info.name) {
            lines.push({ text: info.name, bold: true });
        }
        if (info.city) {
            lines.push({ text: info.city, bold: false });
        }
        if (info.country) {
            lines.push({ text: info.country, bold: false });
        }
        if (lines.length) {
            // Place the plate in the quadrant opposite the aircraft so neither the
            // plane nor its route line (which heads toward the plane) covers it.
            const hSide: "left" | "right" = planeX >= x ? "left" : "right";
            const vSide: "up" | "down" = planeY >= y ? "up" : "down";
            this.drawInfoBox(x, y, lines, hSide, vSide);
        }
    }

    /** White info plate beside an airport circle, in the requested corner. */
    private drawInfoBox(
        cx: number,
        cy: number,
        lines: { text: string; bold: boolean }[],
        hSide: "left" | "right",
        vSide: "up" | "down"
    ): void {
        const ctx = this.ctx;
        const padX = 6;
        const padY = 4;
        const lh = 12;
        const gap = 8;
        const fontFor = (bold: boolean) => `${bold ? 700 : 400} 10px "Segoe UI", Arial, sans-serif`;

        let maxW = 0;
        for (const l of lines) {
            ctx.font = fontFor(l.bold);
            maxW = Math.max(maxW, ctx.measureText(l.text).width);
        }
        const w = maxW + padX * 2;
        const h = lines.length * lh + padY * 2;
        const left = hSide === "right" ? cx + gap : cx - gap - w;
        const top = vSide === "down" ? cy + gap : cy - gap - h;

        ctx.save();
        this.roundRect(left, top, w, h, 4);
        ctx.fillStyle = "rgba(255,255,255,0.96)";
        ctx.fill();
        ctx.lineWidth = 1;
        ctx.strokeStyle = "rgba(15,23,42,0.22)";
        ctx.stroke();
        ctx.textBaseline = "middle";
        ctx.textAlign = "left";
        let ty = top + padY + lh / 2;
        for (const l of lines) {
            ctx.font = fontFor(l.bold);
            ctx.fillStyle = l.bold ? "#111827" : "#374151";
            ctx.fillText(l.text, left + padX, ty);
            ty += lh;
        }
        ctx.restore();
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
        const pad = 4;
        const gap = 3;
        const logoSize = clamp(Number(settings.marker.logoSize.value) || 18, 10, 36);
        // Per-aircraft logo URL (from data) when available, else the hardcoded test
        // logo for every aircraft during testing.
        const logoSrc = point.logoUrl || TEST_LOGO;
        const showLogo = settings.marker.showAirlineLogo.value && !!logoSrc;
        const logo = showLogo ? this.getLogoImage(logoSrc) : null;
        const logoW = showLogo ? logoSize + gap : 0;

        ctx.font = `700 8px "Segoe UI", Arial, sans-serif`;
        ctx.textBaseline = "middle";
        ctx.textAlign = "left";
        const textW = Math.min(100, ctx.measureText(text).width);
        const rectW = pad * 2 + textW + logoW;
        // Grow the plate so the (square) logo fits within it.
        const rectH = showLogo ? Math.max(LABEL_HEIGHT, logoSize + 2) : LABEL_HEIGHT;

        // Default: centred plate above the plane. On-ground uses the short side-view
        // icon, so the label sits lower (closer to it). For the routed plane (selected
        // / preview) offset it perpendicular to the heading so it clears the route line.
        let cx = x;
        let cy = y - size / 2 - rectH / 2;
        if (point.onGround) {
            cy = y - size * 0.26 - rectH / 2;
        } else if (selected) {
            const h = ((point.heading || 0) * Math.PI) / 180;
            const px = Math.cos(h);
            const py = Math.sin(h);
            const d = size / 2 + rectH / 2 + 6;
            cx = x + px * d;
            cy = y + py * d;
        }
        const left = cx - rectW / 2;
        const top = cy - rectH / 2;

        this.roundRect(left, top, rectW, rectH, 4);
        ctx.fillStyle = "rgba(255,255,255,0.96)";
        ctx.fill();
        ctx.lineWidth = 1;
        ctx.strokeStyle = selected ? "#22d3ee" : "rgba(15,23,42,0.22)";
        ctx.stroke();

        // Registration number first, then the logo to its right.
        const textX = left + pad;
        ctx.save();
        ctx.beginPath();
        ctx.rect(textX, top, textW, rectH);
        ctx.clip();
        ctx.fillStyle = "#111827";
        ctx.fillText(text, textX, cy + 0.5);
        ctx.restore();

        if (showLogo && logo) {
            ctx.drawImage(logo, textX + textW + gap, cy - logoSize / 2, logoSize, logoSize);
        }

        return { x0: left, y0: top, x1: left + rectW, y1: top + rectH };
    }

    private drawCluster(cluster: Cluster, settings: VisualSettingsModel): void {
        const lp = this.map.latLngToLayerPoint([cluster.latitude, cluster.longitude]);
        const x = lp.x - this.origin.x;
        const y = lp.y - this.origin.y;
        const count = cluster.instances.length;
        const radius = clusterDiameter(count) / 2;
        const rawStrength = Number(settings.behavior.clusterSaturation.value);
        const strength = clamp(Number.isFinite(rawStrength) ? rawStrength : 1, 0, 1);
        const auto = settings.behavior.clusterAutoColor.value;

        const ctx = this.ctx;
        ctx.save();
        ctx.globalAlpha = 0.94;

        if (auto) {
            // Pie chart: one wedge per airline, sized by its share of the cluster.
            const byAirline = new Map<string, { n: number; color: string }>();
            for (const inst of cluster.instances) {
                const p = inst.point;
                const airline = p.group && p.group.length ? p.group : "—";
                const entry = byAirline.get(airline);
                if (entry) {
                    entry.n++;
                } else {
                    byAirline.set(airline, { n: 1, color: tintColor(p.groupColor || p.color, strength) });
                }
            }
            const wedges = [...byAirline.values()].sort((a, b) => b.n - a.n);
            let start = -Math.PI / 2;
            for (const wedge of wedges) {
                const angle = (wedge.n / count) * Math.PI * 2;
                ctx.beginPath();
                ctx.moveTo(x, y);
                ctx.arc(x, y, radius, start, start + angle);
                ctx.closePath();
                ctx.fillStyle = wedge.color;
                ctx.fill();
                start += angle;
            }
        } else {
            ctx.beginPath();
            ctx.arc(x, y, radius, 0, Math.PI * 2);
            ctx.fillStyle = tintColor(settings.marker.color.value.value, strength);
            ctx.fill();
        }

        ctx.beginPath();
        ctx.arc(x, y, radius, 0, Math.PI * 2);
        ctx.lineWidth = 2;
        ctx.strokeStyle = "rgba(5,6,8,0.85)";
        ctx.stroke();
        ctx.globalAlpha = 1;

        // Count, legible on any wedge colour (white fill with dark outline).
        ctx.font = `800 12px "Segoe UI", Arial, sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.lineWidth = 3;
        ctx.strokeStyle = "rgba(5,6,8,0.85)";
        ctx.strokeText(String(count), x, y + 0.5);
        ctx.fillStyle = "#ffffff";
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
            const svg =
                icon.code === SIDE_VIEW_ICON.code
                    ? buildSideViewSvg(symW, size, color)
                    : buildStandalonePlaneSvg(icon, symW, size, color);
            img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
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

    private hitTestAirport(layerPoint: L.Point): string | null {
        for (let i = this.airportHits.length - 1; i >= 0; i--) {
            const a = this.airportHits[i];
            const dx = layerPoint.x - a.x;
            const dy = layerPoint.y - a.y;
            if (dx * dx + dy * dy <= a.r * a.r) {
                return a.key;
            }
        }
        return null;
    }

    private onMouseMove(e: L.LeafletMouseEvent): void {
        if (!this.callbacks) {
            return;
        }
        // Resolve the hover zone (airport circle wins as the smallest target).
        const apKey = this.hitTestAirport(e.layerPoint);
        let hit: MarkerHit | null = null;
        let zone = "none";
        if (apKey) {
            zone = `a:${apKey}`;
        } else {
            hit = this.hitTest(e.layerPoint);
            if (hit && hit.kind === "marker" && hit.point) {
                zone = `m:${hit.point.index}`;
            } else if (hit && hit.kind === "cluster") {
                zone = `c:${Math.round(hit.x)}_${Math.round(hit.y)}`;
            }
        }
        if (zone === this.hoverZone) {
            return;
        }
        this.hoverZone = zone;

        // Tooltip for the new zone.
        if (hit && hit.kind === "marker" && hit.point) {
            const cp = this.map.layerPointToContainerPoint(L.point(hit.x, hit.y));
            this.callbacks.onMouseOver(hit.point, { x: cp.x, y: cp.y });
        } else if (hit && hit.kind === "cluster" && hit.cluster) {
            const cp = this.map.layerPointToContainerPoint(L.point(hit.x, hit.y));
            this.callbacks.onClusterOver(this.buildClusterGroups(hit.cluster), { x: cp.x, y: cp.y });
        } else {
            this.callbacks.onMouseOut();
        }

        // Airport plate reveal (redraw to show/hide it).
        const newAirport = apKey;
        const airportChanged = newAirport !== this.hoveredAirport;
        this.hoveredAirport = newAirport;

        // Preview target: a plane arms it (after delay), empty/cluster clears it
        // (after the same delay), and hovering an airport freezes it as-is.
        if (apKey) {
            this.clearHoverTimer();
        } else if (hit && hit.kind === "marker" && hit.point) {
            this.setPreviewTarget(hit.point.index);
        } else {
            this.setPreviewTarget(null);
        }

        if (airportChanged) {
            this.draw();
        }
    }

    /**
     * Move the preview toward `target` after the configured delay (same delay for
     * showing and hiding). No-op if already there; suppressed while a real selection
     * is active or previews are disabled.
     */
    private setPreviewTarget(target: number | null): void {
        this.clearHoverTimer();
        if (this.hoverPreviewIndex === target) {
            return;
        }
        const cfg = this.settings?.routes;
        if (target !== null && (!cfg || !cfg.hoverPreview.value || this.selectedIndices)) {
            return;
        }
        const ms = clamp((Number(cfg?.hoverSeconds.value) || 0.5) * 1000, 0, 5000);
        this.hoverTimer = window.setTimeout(() => {
            this.hoverTimer = null;
            this.hoverPreviewIndex = target;
            this.draw();
        }, ms);
    }

    private onMapMouseOut(): void {
        this.hoverZone = "none";
        this.callbacks?.onMouseOut();
        const hadAirport = this.hoveredAirport !== null;
        this.hoveredAirport = null;
        this.setPreviewTarget(null);
        if (hadAirport) {
            this.draw();
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
