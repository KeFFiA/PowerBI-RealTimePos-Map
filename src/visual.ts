/**
 * Aircraft Map Visual — entry point.
 *
 * Rewritten from scratch to match the contract recovered from the original
 * AIXII_Aircraft.pbiviz bundle (Leaflet base map, custom SVG aircraft markers,
 * per-object colors, area selection, canvas tooltips, localization, landing page).
 */
import "./../style/visual.less";

import powerbi from "powerbi-visuals-api";
import * as L from "leaflet";
import { formattingSettings, FormattingSettingsService } from "powerbi-visuals-utils-formattingmodel";

import IVisual = powerbi.extensibility.visual.IVisual;
import VisualConstructorOptions = powerbi.extensibility.visual.VisualConstructorOptions;
import VisualUpdateOptions = powerbi.extensibility.visual.VisualUpdateOptions;
import IVisualHost = powerbi.extensibility.visual.IVisualHost;
import ISelectionManager = powerbi.extensibility.ISelectionManager;
import ISelectionId = powerbi.visuals.ISelectionId;
import ILocalizationManager = powerbi.extensibility.ILocalizationManager;
import FormattingModel = powerbi.visuals.FormattingModel;

import { VisualSettingsModel } from "./settings";
import { AircraftPoint, transform } from "./dataModel";
import { MapController, MapStyle } from "./map";
import { MarkerLayer, ClusterTooltipGroup } from "./markers";
import { AreaSelection } from "./selection";

export class Visual implements IVisual {
    private readonly host: IVisualHost;
    private readonly selectionManager: ISelectionManager;
    private readonly localization: ILocalizationManager;
    private readonly formattingService: FormattingSettingsService;

    private readonly mapElement: HTMLDivElement;
    private readonly landingElement: HTMLDivElement;
    private readonly tooltipElement: HTMLDivElement;
    private readonly mapController: MapController;
    private readonly markerLayer: MarkerLayer;
    private readonly areaSelection: AreaSelection;

    private settings: VisualSettingsModel = new VisualSettingsModel();
    private points: AircraftPoint[] = [];
    private pointsByIndex: Map<number, AircraftPoint> = new Map();

    constructor(options: VisualConstructorOptions) {
        this.host = options.host;
        this.selectionManager = this.host.createSelectionManager();
        this.localization = this.host.createLocalizationManager();
        this.formattingService = new FormattingSettingsService(this.localization);

        const root = options.element;
        root.classList.add("aircraft-map-root");

        this.mapElement = document.createElement("div");
        root.appendChild(this.mapElement);

        this.landingElement = this.buildLanding();
        root.appendChild(this.landingElement);

        this.tooltipElement = document.createElement("div");
        this.tooltipElement.className = "aircraft-custom-tooltip";
        root.appendChild(this.tooltipElement);

        this.mapController = new MapController(this.mapElement);
        this.markerLayer = new MarkerLayer(this.mapController.getMap());
        this.areaSelection = new AreaSelection(
            this.mapController.getMap(),
            root,
            {
                pan: this.localization.getDisplayName("Toolbar_Pan"),
                rectangle: this.localization.getDisplayName("Toolbar_Rectangle"),
                polygon: this.localization.getDisplayName("Toolbar_Polygon"),
                lasso: this.localization.getDisplayName("Toolbar_Lasso"),
                back: this.localization.getDisplayName("Toolbar_Back"),
                clear: this.localization.getDisplayName("Toolbar_Clear"),
            },
            {
                onSelect: (indices, additive) => this.selectByIndices(indices, additive),
                onClear: () => this.selectionManager.clear().then(() => this.applyHighlight()),
            }
        );

        this.mapController.buildStyleControl(
            root,
            {
                dark: this.localization.getDisplayName("DarkMap"),
                light: this.localization.getDisplayName("LightMap"),
                osm: this.localization.getDisplayName("OsmMap"),
                voyager: this.localization.getDisplayName("VoyagerMap"),
            },
            (style) => this.onStyleSwitch(style)
        );

        this.selectionManager.registerOnSelectCallback(() => this.applyHighlight());

        // Marker interaction lives on the map (the canvas layer has no DOM markers):
        // hit-test on click to select a plane / expand a cluster, or clear on empty.
        this.mapController.getMap().on("click", (e: L.LeafletMouseEvent) => this.onMapClick(e));
    }

    private onMapClick(e: L.LeafletMouseEvent): void {
        // Only act in pan mode; the area-selection tools own clicks while drawing.
        if (this.areaSelection.getMode() !== "pan") {
            return;
        }
        const hit = this.markerLayer.hitTest(e.layerPoint);
        if (hit?.kind === "cluster" && hit.cluster) {
            this.markerLayer.zoomIntoCluster(hit.cluster);
            return;
        }
        if (hit?.kind === "marker" && hit.point) {
            this.onPointClick(hit.point, e.originalEvent);
            return;
        }
        this.clearSelection();
    }

    /**
     * Clear the selection on an empty-space click. Our own selection clears directly.
     * A cross-filter set by ANOTHER visual can't be cleared by clear() alone, so we
     * briefly take ownership (select one point) and immediately release it, which
     * resets the page-level selection.
     */
    private clearSelection(): void {
        const ownSelection = (this.selectionManager.getSelectionIds() as ISelectionId[]).length > 0;
        const crossActive = this.points.some((p) => !p.highlighted);
        if (!ownSelection && crossActive && this.points.length) {
            this.selectionManager
                .select(this.points[0].selectionId, false)
                .then(() => this.selectionManager.clear())
                .then(() => this.applyHighlight());
            return;
        }
        this.selectionManager.clear().then(() => this.applyHighlight());
    }

    private buildLanding(): HTMLDivElement {
        const landing = document.createElement("div");
        landing.className = "aircraft-landing";
        const panel = document.createElement("div");
        panel.className = "aircraft-landing-panel";
        const title = document.createElement("div");
        title.className = "aircraft-landing-title";
        title.textContent = this.localization.getDisplayName("Visual_DisplayName");
        const text = document.createElement("div");
        text.className = "aircraft-landing-text";
        text.textContent = this.localization.getDisplayName("Landing_Text");
        panel.appendChild(title);
        panel.appendChild(text);
        landing.appendChild(panel);
        return landing;
    }

    /** On-map style switcher: apply immediately and persist so it survives refresh. */
    private onStyleSwitch(style: MapStyle): void {
        this.mapController.setStyle(style);
        this.host.persistProperties({
            merge: [
                {
                    objectName: "map",
                    selector: null,
                    properties: { style },
                },
            ],
        });
    }

    public update(options: VisualUpdateOptions): void {
        // Hide any open tooltip up front: on a data refresh the hovered marker is
        // recreated, so its mouseout never fires and the tooltip would otherwise
        // linger ("stick") until the next hover.
        this.hideTooltip();

        const viewport = options.viewport;
        this.mapElement.style.width = `${viewport.width}px`;
        this.mapElement.style.height = `${viewport.height}px`;
        this.mapController.resize();

        const dataView = options.dataViews && options.dataViews[0];
        this.settings = this.formattingService.populateFormattingSettingsModel(VisualSettingsModel, dataView);
        this.points = transform(dataView, this.host, this.settings);
        this.pointsByIndex = new Map(this.points.map((p) => [p.index, p]));

        const hasData = this.points.length > 0;
        this.landingElement.style.display = hasData ? "none" : "flex";
        this.mapElement.style.display = hasData ? "block" : "none";
        if (!hasData) {
            this.markerLayer.clear();
            return;
        }

        this.mapController.setStyle(this.settings.map.style.value.value as MapStyle);
        this.mapController.resize();

        this.markerLayer.render(this.points, this.settings, {
            onClick: (point, ev) => this.onPointClick(point, ev),
            onMouseOver: (point, position) => this.showTooltip(point, position),
            onClusterOver: (groups, position) => this.showClusterTooltip(groups, position),
            onMouseOut: () => this.hideTooltip(),
        });
        this.areaSelection.setPoints(this.points);

        if (this.settings.map.autoZoom.value) {
            this.mapController.fitToPoints(this.points);
        }

        this.applyHighlight();
    }

    public getFormattingModel(): FormattingModel {
        this.populateGroupColorSlices();
        this.populateObjectMarkerSlices();
        return this.formattingService.buildFormattingModel(this.settings);
    }

    /** One color picker per distinct color group (airline), carrying its selector. */
    private populateGroupColorSlices(): void {
        const card = this.settings.groupColor;
        card.slices = [];
        const seen = new Set<string>();
        for (const point of this.points) {
            if (point.group === undefined || !point.groupSelectionId || seen.has(point.group)) {
                continue;
            }
            seen.add(point.group);
            card.slices.push(
                new formattingSettings.ColorPicker({
                    name: "fill",
                    displayName: point.group || "(blank)",
                    value: { value: point.groupColor || this.settings.marker.color.value.value },
                    selector: (point.groupSelectionId as ISelectionId).getSelector(),
                })
            );
        }
    }

    /** One per-object color picker, carrying the object's selector for persistence. */
    private populateObjectMarkerSlices(): void {
        const card = this.settings.objectMarker;
        card.slices = [];
        const seen = new Set<string>();
        for (const point of this.points) {
            if (seen.has(point.id)) {
                continue;
            }
            seen.add(point.id);
            card.slices.push(
                new formattingSettings.ColorPicker({
                    name: "fill",
                    displayName: point.id,
                    value: { value: point.color },
                    selector: (point.selectionId as ISelectionId).getSelector(),
                })
            );
        }
    }

    private onPointClick(point: AircraftPoint, ev: MouseEvent): void {
        const multi = ev.ctrlKey || ev.metaKey || ev.shiftKey;
        this.selectionManager.select(point.selectionId, multi).then(() => this.applyHighlight());
    }

    private selectByIndices(indices: number[], additive: boolean): void {
        const ids = indices
            .map((i) => this.pointsByIndex.get(i))
            .filter((p): p is AircraftPoint => !!p)
            .map((p) => p.selectionId);
        if (!ids.length && !additive) {
            this.selectionManager.clear().then(() => this.applyHighlight());
            return;
        }
        this.selectionManager.select(ids, additive).then(() => this.applyHighlight());
    }

    private applyHighlight(): void {
        // Priority 1: this visual's own selection (clicking a marker / area select).
        const selected = this.selectionManager.getSelectionIds() as ISelectionId[];
        if (selected.length) {
            const set = new Set<number>();
            for (const point of this.points) {
                if (selected.some((id) => id.equals(point.selectionId as ISelectionId))) {
                    set.add(point.index);
                }
            }
            this.markerLayer.setSelection(set);
            return;
        }

        // Priority 2: incoming cross-highlight from other visuals (read from the
        // dataView's `highlights`, surfaced as point.highlighted). Active only when
        // some points are highlighted and others are not.
        const crossActive = this.points.some((p) => !p.highlighted);
        if (crossActive) {
            const set = new Set<number>();
            for (const point of this.points) {
                if (point.highlighted) {
                    set.add(point.index);
                }
            }
            this.markerLayer.setSelection(set);
            return;
        }

        // Nothing selected or highlighted: clear all dimming/filtering.
        this.markerLayer.setSelection(null);
    }

    private showTooltip(point: AircraftPoint, position: { x: number; y: number }): void {
        const rows = point.tooltips.length ? point.tooltips : [];
        this.renderTooltip(point.label || point.id || "", rows, position);
    }

    /** Cluster hover tooltip: one row per airline (count) listing its aircraft. */
    private showClusterTooltip(groups: ClusterTooltipGroup[], position: { x: number; y: number }): void {
        const MAX_ROWS = 20;
        const MAX_NAMES = 10;
        const total = groups.reduce((sum, g) => sum + g.total, 0);
        const rows: { displayName: string; value: string }[] = [];
        for (const g of groups.slice(0, MAX_ROWS)) {
            const names = g.aircraft.slice(0, MAX_NAMES);
            const extra = g.total - names.length;
            rows.push({
                displayName: `${g.airline} (${g.total})`,
                value: names.join(", ") + (extra > 0 ? `, +${extra}` : ""),
            });
        }
        if (groups.length > MAX_ROWS) {
            rows.push({ displayName: "…", value: `+${groups.length - MAX_ROWS} airlines` });
        }
        this.renderTooltip(`${total} aircraft`, rows, position);
    }

    /** Renders the custom DOM tooltip with a title and rows, positioned near the point. */
    private renderTooltip(
        title: string,
        rows: { displayName: string; value: string }[],
        position: { x: number; y: number }
    ): void {
        const el = this.tooltipElement;
        while (el.firstChild) {
            el.removeChild(el.firstChild);
        }
        if (title) {
            const t = document.createElement("div");
            t.className = "aircraft-custom-tooltip-title";
            t.textContent = title;
            el.appendChild(t);
        }
        for (const r of rows) {
            const row = document.createElement("div");
            row.className = "aircraft-custom-tooltip-row";
            const label = document.createElement("span");
            label.className = "aircraft-custom-tooltip-label";
            label.textContent = r.displayName;
            const value = document.createElement("span");
            value.className = "aircraft-custom-tooltip-value";
            value.textContent = r.value;
            row.appendChild(label);
            row.appendChild(value);
            el.appendChild(row);
        }
        el.classList.add("visible");

        const w = el.offsetWidth;
        const h = el.offsetHeight;
        const vw = this.mapElement.clientWidth;
        const vh = this.mapElement.clientHeight;
        let left = position.x + 14;
        let top = position.y - h - 10;
        if (top < 4) {
            top = position.y + 16;
        }
        if (left + w > vw - 4) {
            left = position.x - w - 14;
        }
        if (left < 4) {
            left = 4;
        }
        if (top + h > vh - 4) {
            top = Math.max(4, vh - h - 4);
        }
        el.style.left = `${left}px`;
        el.style.top = `${top}px`;
    }

    private hideTooltip(): void {
        this.tooltipElement.classList.remove("visible");
    }
}
