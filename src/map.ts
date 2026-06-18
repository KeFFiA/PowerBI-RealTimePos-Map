/**
 * Leaflet map wrapper: owns the map instance, the four base layers recovered from
 * the original visual (Carto dark/light/voyager + OpenStreetMap), and the on-map
 * style switcher (.aircraft-map-style-control).
 */
import * as L from "leaflet";

import { AircraftPoint } from "./dataModel";

export type MapStyle = "dark" | "light" | "osm" | "voyager";

export interface StyleSwitcherLabels {
    dark: string;
    light: string;
    osm: string;
    voyager: string;
}

/** Single-world extent — used to cap how far you can zoom out. */
const WORLD_BOUNDS = L.latLngBounds([
    [-85.05, -180],
    [85.05, 180],
]);

const CARTO_SUBDOMAINS = "abcd";
const CARTO_ATTRIBUTION =
    '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>';
const OSM_ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

const TILE_URLS: Record<MapStyle, string> = {
    light: "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png",
    voyager: "https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png",
    dark: "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
    osm: "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
};

export class MapController {
    private readonly map: L.Map;
    private readonly layers: Partial<Record<MapStyle, L.TileLayer>> = {};
    private currentStyle: MapStyle | null = null;
    private styleButtons: Map<MapStyle, HTMLButtonElement> = new Map();

    constructor(container: HTMLElement) {
        container.classList.add("aircraft-map");
        this.map = L.map(container, {
            center: [20, 0],
            zoom: 2,
            zoomControl: true,
            attributionControl: true,
            // Horizontal wrap stays on (infinite sideways scroll), but worldCopyJump
            // is off so markers don't teleport between copies — instead the marker
            // layer draws a copy of each plane in every visible world (see MarkerLayer).
            worldCopyJump: false,
            preferCanvas: false,
        });
        // Strip Leaflet's default attribution prefix (it carries the Ukrainian
        // flag since Leaflet 1.8). Tile attribution (OSM/CARTO) is kept as the
        // providers' licenses require it.
        this.map.attributionControl.setPrefix(false);
        this.setStyle("dark");
        this.applyMinZoom();
    }

    public getMap(): L.Map {
        return this.map;
    }

    public setStyle(style: MapStyle): void {
        if (this.currentStyle !== style) {
            if (this.currentStyle && this.layers[this.currentStyle]) {
                this.map.removeLayer(this.layers[this.currentStyle]!);
            }
            if (!this.layers[style]) {
                const isOsm = style === "osm";
                this.layers[style] = L.tileLayer(TILE_URLS[style], {
                    subdomains: isOsm ? "abc" : CARTO_SUBDOMAINS,
                    attribution: isOsm ? OSM_ATTRIBUTION : CARTO_ATTRIBUTION,
                    detectRetina: true,
                    maxZoom: 19,
                });
            }
            this.layers[style]!.addTo(this.map);
            this.currentStyle = style;
        }
        this.styleButtons.forEach((btn, key) => btn.classList.toggle("active", key === this.currentStyle));
    }

    /** Builds the on-map style switcher (Dark / Light only) inside the given root element. */
    public buildStyleControl(root: HTMLElement, labels: StyleSwitcherLabels, onChange: (style: MapStyle) => void): void {
        const control = L.DomUtil.create("div", "aircraft-map-style-control", root);
        L.DomEvent.disableClickPropagation(control);
        L.DomEvent.disableScrollPropagation(control);
        const defs: Array<[MapStyle, string]> = [
            ["dark", labels.dark],
            ["light", labels.light],
        ];
        for (const [style, label] of defs) {
            const btn = L.DomUtil.create("button", "", control) as HTMLButtonElement;
            btn.type = "button";
            btn.textContent = label;
            btn.classList.toggle("active", style === this.currentStyle);
            L.DomEvent.on(btn, "click", (e) => {
                L.DomEvent.stop(e);
                onChange(style);
            });
            this.styleButtons.set(style, btn);
        }
    }

    public fitToPoints(points: AircraftPoint[]): void {
        if (!points.length) {
            return;
        }
        const bounds = L.latLngBounds(points.map((p) => [p.latitude, p.longitude] as L.LatLngTuple));
        if (bounds.isValid()) {
            this.map.fitBounds(bounds, { padding: [40, 40], maxZoom: 12, animate: false });
        }
    }

    public resize(): void {
        this.map.invalidateSize(false);
        this.applyMinZoom();
    }

    /** Cap zoom-out so the world can't be zoomed smaller than the viewport. */
    private applyMinZoom(): void {
        const z = this.map.getBoundsZoom(WORLD_BOUNDS, false);
        if (Number.isFinite(z) && z > 0) {
            this.map.setMinZoom(Math.min(z, 19));
        }
    }
}
