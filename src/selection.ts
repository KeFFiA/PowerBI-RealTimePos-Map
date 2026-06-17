/**
 * Area selection toolbar (.aircraft-toolbar) + freehand drawing, reproducing the
 * original visual: pan / rectangle / polygon / lasso / clear / back. The drawn shape
 * is a Leaflet vector layer, and containment is tested in lat/lng space.
 */
import * as L from "leaflet";

import { AircraftPoint } from "./dataModel";

export type SelectionMode = "pan" | "rectangle" | "polygon" | "lasso";

export interface ToolbarLabels {
    pan: string;
    rectangle: string;
    polygon: string;
    lasso: string;
    back: string;
    clear: string;
}

export interface SelectionCallbacks {
    onSelect: (indices: number[], additive: boolean) => void;
    onClear: () => void;
}

const SVG_NS = "http://www.w3.org/2000/svg";

/** Toolbar icon paths recovered 1:1 from the original bundle. */
const ICON_PATHS: Record<string, string> = {
    pan:
        "M8 10V5.5a1.5 1.5 0 0 1 3 0V10m0-2.5a1.5 1.5 0 0 1 3 0V10m0-1.5a1.5 1.5 0 0 1 3 0V12m0-1.5a1.5 1.5 0 0 1 3 0V14c0 4-2.5 6-6.5 6H12c-2.5 0-4-1.1-5.2-3.2L4.2 12.4a1.6 1.6 0 0 1 2.6-1.8L8 12.2",
    polygon: "M5 17 8.5 6.5 17 8l2 8-7 3.5L5 17Z",
    lasso: "M6 13c0-4 3.6-7 8-7s8 3 8 7-3.6 6.5-8 6.5S6 17 6 13Zm7 6.5c-1.8 1.4-4.3 1.4-6.5.2",
    clear: "M6 6l12 12M18 6 6 18",
    back: "M9 7 5 11l4 4M5 11h9a5 5 0 0 1 0 10h-2",
};

const SHAPE_STYLE: L.PathOptions = {
    color: "#22d3ee",
    weight: 1.5,
    dashArray: "4 3",
    fillColor: "#22d3ee",
    fillOpacity: 0.12,
    interactive: false,
};

function pointInPolygon(point: L.LatLng, poly: L.LatLng[]): boolean {
    const x = point.lng;
    const y = point.lat;
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const xi = poly[i].lng;
        const yi = poly[i].lat;
        const xj = poly[j].lng;
        const yj = poly[j].lat;
        if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
            inside = !inside;
        }
    }
    return inside;
}

function buildIcon(mode: string): SVGSVGElement {
    const svg = document.createElementNS(SVG_NS, "svg") as SVGSVGElement;
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("width", "18");
    svg.setAttribute("height", "18");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    if (mode === "rectangle") {
        const rect = document.createElementNS(SVG_NS, "rect");
        rect.setAttribute("x", "5");
        rect.setAttribute("y", "6");
        rect.setAttribute("width", "14");
        rect.setAttribute("height", "12");
        rect.setAttribute("rx", "1.5");
        svg.appendChild(rect);
        return svg;
    }
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", ICON_PATHS[mode] || "");
    svg.appendChild(path);
    if (mode === "polygon") {
        const circle = document.createElementNS(SVG_NS, "circle");
        circle.setAttribute("cx", "8.5");
        circle.setAttribute("cy", "6.5");
        circle.setAttribute("r", "1");
        svg.appendChild(circle);
    }
    return svg;
}

export class AreaSelection {
    private readonly map: L.Map;
    private readonly callbacks: SelectionCallbacks;
    private readonly buttons: Map<string, HTMLButtonElement> = new Map();

    private points: AircraftPoint[] = [];
    private mode: SelectionMode = "pan";
    private dragging = false;
    private start: L.LatLng | null = null;
    private path: L.LatLng[] = [];
    private shapeLayer: L.Rectangle | L.Polygon | null = null;

    constructor(map: L.Map, root: HTMLElement, labels: ToolbarLabels, callbacks: SelectionCallbacks) {
        this.map = map;
        this.callbacks = callbacks;
        this.buildToolbar(root, labels);

        this.map.on("mousedown", this.onMouseDown, this);
        this.map.on("mousemove", this.onMouseMove, this);
        this.map.on("mouseup", this.onMouseUp, this);
        this.map.on("click", this.onClick, this);
        this.map.on("dblclick", this.onDblClick, this);
    }

    public setPoints(points: AircraftPoint[]): void {
        this.points = points;
    }

    private buildToolbar(root: HTMLElement, labels: ToolbarLabels): void {
        const bar = L.DomUtil.create("div", "aircraft-toolbar", root);
        L.DomEvent.disableClickPropagation(bar);
        L.DomEvent.disableScrollPropagation(bar);

        const make = (key: string, title: string, isMode: boolean) => {
            const btn = L.DomUtil.create("button", "aircraft-icon-button", bar) as HTMLButtonElement;
            btn.type = "button";
            btn.title = title;
            btn.setAttribute("aria-label", title);
            btn.appendChild(buildIcon(key));
            L.DomEvent.on(btn, "click", (e) => {
                L.DomEvent.stop(e);
                if (isMode) {
                    this.setMode(key as SelectionMode);
                } else if (key === "back") {
                    this.removeLastVertex();
                } else if (key === "clear") {
                    this.reset();
                    this.callbacks.onClear();
                }
            });
            this.buttons.set(key, btn);
        };

        make("pan", labels.pan, true);
        make("rectangle", labels.rectangle, true);
        make("polygon", labels.polygon, true);
        make("lasso", labels.lasso, true);
        make("clear", labels.clear, false);
        make("back", labels.back, false);

        this.setMode("pan");
    }

    private setMode(mode: SelectionMode): void {
        this.mode = mode;
        this.resetTransient();
        this.buttons.forEach((btn, key) => btn.classList.toggle("active", key === mode));

        const container = this.map.getContainer();
        if (mode === "pan") {
            this.map.dragging.enable();
            this.map.doubleClickZoom.enable();
            container.style.cursor = "";
        } else {
            this.map.dragging.disable();
            this.map.doubleClickZoom.disable();
            container.style.cursor = "crosshair";
        }
    }

    private onMouseDown(e: L.LeafletMouseEvent): void {
        if (this.mode === "rectangle" || this.mode === "lasso") {
            this.dragging = true;
            this.start = e.latlng;
            this.path = [e.latlng];
        }
    }

    private onMouseMove(e: L.LeafletMouseEvent): void {
        if (!this.dragging) {
            return;
        }
        if (this.mode === "rectangle" && this.start) {
            const bounds = L.latLngBounds(this.start, e.latlng);
            this.drawRectangle(bounds);
        } else if (this.mode === "lasso") {
            this.path.push(e.latlng);
            this.drawPolygon(this.path);
        }
    }

    private onMouseUp(e: L.LeafletMouseEvent): void {
        if (!this.dragging) {
            return;
        }
        this.dragging = false;
        if (this.mode === "rectangle" && this.start) {
            const bounds = L.latLngBounds(this.start, e.latlng);
            this.commitBounds(bounds);
        } else if (this.mode === "lasso" && this.path.length >= 3) {
            this.commitPolygon(this.path);
        }
        this.resetTransient();
    }

    private onClick(e: L.LeafletMouseEvent): void {
        // In pan mode a click on empty map space clears the selection. Marker clicks
        // do not bubble to the map (L.Marker.bubblingMouseEvents is false by default),
        // so this only fires for clicks on the background.
        if (this.mode === "pan") {
            this.callbacks.onClear();
            return;
        }
        if (this.mode !== "polygon") {
            return;
        }
        this.path.push(e.latlng);
        this.drawPolygon(this.path);
    }

    private onDblClick(e: L.LeafletMouseEvent): void {
        if (this.mode !== "polygon") {
            return;
        }
        L.DomEvent.stop(e.originalEvent);
        if (this.path.length >= 3) {
            this.commitPolygon(this.path);
        }
        this.resetTransient();
    }

    private removeLastVertex(): void {
        if (this.mode === "polygon" && this.path.length > 0) {
            this.path.pop();
            this.drawPolygon(this.path);
        }
    }

    private commitBounds(bounds: L.LatLngBounds): void {
        const indices = this.points
            .filter((p) => bounds.contains([p.latitude, p.longitude]))
            .map((p) => p.index);
        this.callbacks.onSelect(indices, false);
    }

    private commitPolygon(path: L.LatLng[]): void {
        const indices = this.points
            .filter((p) => pointInPolygon(L.latLng(p.latitude, p.longitude), path))
            .map((p) => p.index);
        this.callbacks.onSelect(indices, false);
    }

    private drawRectangle(bounds: L.LatLngBounds): void {
        this.clearShape();
        this.shapeLayer = L.rectangle(bounds, SHAPE_STYLE).addTo(this.map);
    }

    private drawPolygon(path: L.LatLng[]): void {
        this.clearShape();
        if (path.length >= 2) {
            this.shapeLayer = L.polygon(path, SHAPE_STYLE).addTo(this.map);
        }
    }

    private clearShape(): void {
        if (this.shapeLayer) {
            this.map.removeLayer(this.shapeLayer);
            this.shapeLayer = null;
        }
    }

    private resetTransient(): void {
        this.dragging = false;
        this.start = null;
        this.path = [];
        this.clearShape();
    }

    public reset(): void {
        this.resetTransient();
        this.setMode("pan");
    }
}
