/**
 * Land / country canvas layer.
 *
 * Replaces the raster basemap: the ocean is transparent and only the continents are
 * painted, as filled country polygons (Natural Earth 110m) with stroked borders and
 * contrasting country-name labels. Everything is drawn onto a single <canvas> in a
 * dedicated pane below the markers, repeated across every visible world copy so
 * horizontal scrolling stays infinite. Follows the same Leaflet renderer lifecycle as
 * the marker layer (redraw on moveend/zoomend/resize, transform during zoom animation).
 */
import * as L from "leaflet";

import { COUNTRIES } from "./worldCountries";

const CANVAS_PADDING = 0.1;

interface Bbox {
    w: number;
    e: number;
    s: number;
    n: number;
}

interface Rect {
    x0: number;
    y0: number;
    x1: number;
    y1: number;
}

export interface LandColors {
    land: string;
    border: string;
    label: string;
}

export class LandLayer {
    private readonly map: L.Map;
    private readonly canvas: HTMLCanvasElement;
    private readonly ctx: CanvasRenderingContext2D;
    private origin: L.Point = L.point(0, 0);
    private colors: LandColors;
    private readonly bboxes: Bbox[] = [];

    constructor(map: L.Map, colors: LandColors) {
        this.map = map;
        this.colors = colors;

        map.createPane("aircraftLand");
        const pane = map.getPane("aircraftLand")!;
        pane.style.zIndex = "200"; // below the overlay pane (markers/routes at 400)
        pane.style.pointerEvents = "none";

        this.canvas = L.DomUtil.create("canvas", "aircraft-land-layer leaflet-zoom-animated", pane);
        this.ctx = this.canvas.getContext("2d")!;

        // Precompute a lng/lat bounding box per country for view culling.
        for (const c of COUNTRIES) {
            let w = Infinity;
            let e = -Infinity;
            let s = Infinity;
            let n = -Infinity;
            for (const poly of c.p) {
                for (const ring of poly) {
                    for (const pt of ring) {
                        const lat = pt[0];
                        const lng = pt[1];
                        if (lng < w) w = lng;
                        if (lng > e) e = lng;
                        if (lat < s) s = lat;
                        if (lat > n) n = lat;
                    }
                }
            }
            this.bboxes.push({ w, e, s, n });
        }

        map.on("moveend zoomend resize", this.reset, this);
        map.on("zoomanim", this.animateZoom, this);
        this.reset();
    }

    public setColors(colors: LandColors): void {
        if (this.colors.land === colors.land && this.colors.border === colors.border && this.colors.label === colors.label) {
            return;
        }
        this.colors = colors;
        this.draw();
    }

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

    private draw(): void {
        this.clearCanvas();
        const dpr = window.devicePixelRatio || 1;
        this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

        const bounds = this.map.getBounds();
        if (!bounds.isValid()) {
            return;
        }
        const padded = bounds.pad(CANVAS_PADDING + 0.05);
        const west = padded.getWest();
        const east = padded.getEast();
        const south = padded.getSouth();
        const north = padded.getNorth();
        const zoom = this.map.getZoom();
        const centerLng = this.map.getCenter().lng;

        const ctx = this.ctx;
        const toXY = (lat: number, lng: number): [number, number] => {
            const lp = this.map.latLngToLayerPoint([lat, lng]);
            return [lp.x - this.origin.x, lp.y - this.origin.y];
        };

        // Pass 1: filled countries + stroked borders.
        ctx.fillStyle = this.colors.land;
        ctx.strokeStyle = this.colors.border;
        ctx.lineWidth = 0.8;
        ctx.lineJoin = "round";
        for (let ci = 0; ci < COUNTRIES.length; ci++) {
            const bb = this.bboxes[ci];
            if (bb.n < south || bb.s > north) {
                continue;
            }
            const kStart = Math.ceil((west - bb.e) / 360);
            const kEnd = Math.floor((east - bb.w) / 360);
            const country = COUNTRIES[ci];
            for (let k = kStart; k <= kEnd; k++) {
                const shift = 360 * k;
                ctx.beginPath();
                for (const poly of country.p) {
                    for (const ring of poly) {
                        for (let i = 0; i < ring.length; i++) {
                            const [x, y] = toXY(ring[i][0], ring[i][1] + shift);
                            if (i === 0) {
                                ctx.moveTo(x, y);
                            } else {
                                ctx.lineTo(x, y);
                            }
                        }
                        ctx.closePath();
                    }
                }
                ctx.fill("evenodd"); // holes (lakes) cut out
                ctx.stroke();
            }
        }

        // Pass 2: country-name labels, contrasting, deduped against overlap.
        this.drawLabels(zoom, centerLng, west, east, south, north, toXY);
    }

    private drawLabels(
        zoom: number,
        centerLng: number,
        west: number,
        east: number,
        south: number,
        north: number,
        toXY: (lat: number, lng: number) => [number, number]
    ): void {
        const ctx = this.ctx;
        ctx.font = `700 11px "Segoe UI", Arial, sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.lineJoin = "round";
        const placed: Rect[] = [];

        for (let ci = 0; ci < COUNTRIES.length; ci++) {
            const country = COUNTRIES[ci];
            const label = country.l;
            if (!label) {
                continue;
            }
            // Declutter by zoom: Natural Earth's MIN_LABEL hint, plus a minimum painted
            // country width so tiny shapes aren't labelled when zoomed out.
            if (zoom + 1.5 < country.z) {
                continue;
            }
            const bb = this.bboxes[ci];
            if (label[0] < south || label[0] > north) {
                continue;
            }
            // Choose the world copy nearest the view centre for this label.
            const k = Math.round((centerLng - label[1]) / 360);
            const shift = 360 * k;
            const lng = label[1] + shift;
            if (lng < west || lng > east) {
                continue;
            }
            // Skip if the country is painted too small to carry a label here.
            const [wx] = toXY(bb.s, bb.w + shift);
            const [ex] = toXY(bb.s, bb.e + shift);
            if (Math.abs(ex - wx) < 34) {
                continue;
            }

            const [x, y] = toXY(label[0], lng);
            const tw = ctx.measureText(country.n).width;
            const rect: Rect = { x0: x - tw / 2 - 2, y0: y - 8, x1: x + tw / 2 + 2, y1: y + 8 };
            if (placed.some((r) => rect.x0 < r.x1 && rect.x1 > r.x0 && rect.y0 < r.y1 && rect.y1 > r.y0)) {
                continue;
            }
            placed.push(rect);

            // Halo in the land colour so the text reads cleanly over borders.
            ctx.lineWidth = 3;
            ctx.strokeStyle = this.colors.land;
            ctx.strokeText(country.n, x, y);
            ctx.fillStyle = this.colors.label;
            ctx.fillText(country.n, x, y);
        }
    }
}
