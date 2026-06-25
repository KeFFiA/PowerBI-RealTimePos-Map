/**
 * Leaflet map wrapper. The basemap is no longer raster tiles: the ocean is transparent
 * and only the continents are painted (see LandLayer), in a theme colour. Dark/Light is
 * just the land fill tone. Vertical panning/zoom is bounded so no empty bands appear
 * above/below the world, while horizontal scrolling stays infinite.
 */
import * as L from "leaflet";

import { AircraftPoint } from "./dataModel";
import { LandLayer, LandColors } from "./landLayer";

export type MapStyle = "dark" | "light" | "osm" | "voyager";

export interface StyleSwitcherLabels {
    dark: string;
    light: string;
    osm: string;
    voyager: string;
}

const WORLD_LAT = 85.05;
// Latitude is bounded to the world; longitude is given a huge span so horizontal
// scrolling is effectively infinite while the map can never be dragged to reveal
// empty space above or below the continents.
const PAN_BOUNDS = L.latLngBounds([
    [-WORLD_LAT, -1e6],
    [WORLD_LAT, 1e6],
]);
// Single-world extent used to derive the minimum zoom (so the world always covers
// the viewport vertically — no empty bands at the most-zoomed-out level).
const FIT_BOUNDS = L.latLngBounds([
    [-WORLD_LAT, -180],
    [WORLD_LAT, 180],
]);

// Land tones: in light mode the land takes the colour the ocean used to have in the
// light basemap, in dark mode the dark-basemap ocean tone. The ocean is transparent.
// Borders and labels are picked to contrast against the land fill of each theme.
const LAND_PALETTE: Record<"dark" | "light", LandColors> = {
    dark: { land: "#2a2f37", border: "#525c6b", label: "#eef2f7" },
    light: { land: "#c9d2d8", border: "#7c8794", label: "#1b2531" },
};

export class MapController {
    private readonly map: L.Map;
    private readonly container: HTMLElement;
    private readonly land: LandLayer;
    private currentStyle: MapStyle | null = null;
    private styleButtons: Map<MapStyle, HTMLButtonElement> = new Map();
    private styleControl: HTMLElement | null = null;

    constructor(container: HTMLElement) {
        this.container = container;
        container.classList.add("aircraft-map");
        this.map = L.map(container, {
            center: [20, 0],
            zoom: 2,
            zoomControl: true,
            attributionControl: false,
            // Horizontal wrap stays on (infinite sideways scroll), but worldCopyJump
            // is off so markers don't teleport between copies — the marker and land
            // layers draw a copy of their content in every visible world instead.
            worldCopyJump: false,
            preferCanvas: false,
            maxBounds: PAN_BOUNDS,
            maxBoundsViscosity: 1.0,
        });
        this.land = new LandLayer(this.map, LAND_PALETTE.dark);
        this.setStyle("dark");
        this.applyMinZoom();
        this.map.on("resize", () => this.applyMinZoom());
    }

    public getMap(): L.Map {
        return this.map;
    }

    /** Ocean is transparent; the container only ever takes a transparent backdrop. */
    public applyBackground(color: string): void {
        this.container.style.background = color || "transparent";
    }

    /** Hide the on-map Dark/Light switcher when the theme drives the land colour. */
    public setStyleControlVisible(visible: boolean): void {
        if (this.styleControl) {
            this.styleControl.style.display = visible ? "" : "none";
        }
    }

    /** Dark/Light now only sets the land fill colour. */
    public setStyle(style: MapStyle): void {
        this.currentStyle = style;
        this.land.setColors(style === "dark" ? LAND_PALETTE.dark : LAND_PALETTE.light);
        this.styleButtons.forEach((btn, key) => btn.classList.toggle("active", key === this.currentStyle));
    }

    /** Builds the on-map style switcher (Dark / Light only) inside the given root element. */
    public buildStyleControl(root: HTMLElement, labels: StyleSwitcherLabels, onChange: (style: MapStyle) => void): void {
        const control = L.DomUtil.create("div", "aircraft-map-style-control", root);
        this.styleControl = control;
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

    /**
     * Cap zoom-out so the world always covers the viewport vertically (the view fits
     * *inside* the world bounds), which prevents empty bands above/below the continents.
     */
    private applyMinZoom(): void {
        const z = this.map.getBoundsZoom(FIT_BOUNDS, true);
        if (Number.isFinite(z) && z > 0) {
            this.map.setMinZoom(Math.min(z, 19));
        }
    }
}
