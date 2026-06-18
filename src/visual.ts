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
    private readonly legendElement: HTMLDivElement;
    private legendListElement!: HTMLDivElement;
    /** true once the user has manually expanded/collapsed the legend this session. */
    private legendUserToggled = false;
    /** distinct airline groups in legend display order (for shift-range selection). */
    private legendGroupsOrder: string[] = [];
    /** anchor group for shift-range selection (last non-shift legend click). */
    private legendAnchorGroup: string | null = null;
    private readonly timelapseElement: HTMLDivElement;
    private timelapseSlider!: HTMLInputElement;
    private timelapseLabel!: HTMLDivElement;
    private timelapseTicks!: HTMLDataListElement;
    /** sorted distinct timestamps (epoch ms) across all aircraft flown samples. */
    private timelapseTimes: number[] = [];
    private timelapseTime: number | null = null;
    /** true when the slider is at the latest stop (live positions). */
    private timelapseLive = true;
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

        this.legendElement = this.buildLegend();
        root.appendChild(this.legendElement);

        this.timelapseElement = this.buildTimelapse();
        root.appendChild(this.timelapseElement);

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

    /**
     * Airline-colour legend (right edge). Collapsed to a "Legend" header by default;
     * clicking it slides the list down, and a "Hide" button at the bottom collapses it.
     */
    private buildLegend(): HTMLDivElement {
        const legend = document.createElement("div");
        legend.className = "aircraft-legend";

        const header = document.createElement("button");
        header.type = "button";
        header.className = "aircraft-legend-header";
        header.textContent = this.localization.getDisplayName("Legend");
        header.addEventListener("click", () => {
            this.legendUserToggled = true;
            legend.classList.toggle("expanded");
        });

        const body = document.createElement("div");
        body.className = "aircraft-legend-body";

        this.legendListElement = document.createElement("div");
        this.legendListElement.className = "aircraft-legend-list";

        const hide = document.createElement("button");
        hide.type = "button";
        hide.className = "aircraft-legend-hide";
        hide.textContent = this.localization.getDisplayName("Hide");
        hide.addEventListener("click", () => {
            this.legendUserToggled = true;
            legend.classList.remove("expanded");
        });

        body.appendChild(this.legendListElement);
        body.appendChild(hide);
        legend.appendChild(header);
        legend.appendChild(body);
        return legend;
    }

    /** Rebuilds the legend rows from the distinct airline groups; hides it if none. */
    private updateLegend(): void {
        const cfg = this.settings.legend;
        const legend = this.legendElement;
        const list = this.legendListElement;
        while (list.firstChild) {
            list.removeChild(list.firstChild);
        }
        const seen = new Set<string>();
        const order: string[] = [];
        let any = false;
        for (const point of this.points) {
            if (point.group === undefined || seen.has(point.group)) {
                continue;
            }
            seen.add(point.group);
            order.push(point.group);
            any = true;
            const group = point.group;
            const row = document.createElement("div");
            row.className = "aircraft-legend-row";
            row.setAttribute("data-group", group);
            row.addEventListener("click", (ev) => this.onLegendSelect(group, ev));
            const swatch = document.createElement("span");
            swatch.className = "aircraft-legend-swatch";
            swatch.style.background = point.groupColor || point.color;
            const name = document.createElement("span");
            name.className = "aircraft-legend-name";
            name.textContent = group || "(blank)";
            row.appendChild(swatch);
            row.appendChild(name);
            list.appendChild(row);
        }
        this.legendGroupsOrder = order;

        // Apply settings: visibility, position, orientation, width, default state.
        legend.style.display = cfg.show.value && any ? "" : "none";
        const position = cfg.position.value.value as string;
        for (const p of ["topRight", "topLeft", "bottomRight", "bottomLeft"]) {
            legend.classList.toggle(`pos-${p}`, p === position);
        }
        const horizontal = (cfg.orientation.value.value as string) === "horizontal";
        legend.classList.toggle("orient-horizontal", horizontal);
        const width = Math.max(90, Math.min(420, Number(cfg.width.value) || 130));
        legend.style.width = horizontal ? "" : `${width}px`;
        if (!this.legendUserToggled) {
            legend.classList.toggle("expanded", !!cfg.expanded.value);
        }
        this.refreshLegendSelection();
    }

    /** Groups (airlines) currently part of this visual's selection. */
    private selectedGroups(): Set<string> {
        const set = new Set<string>();
        const ids = this.selectionManager.getSelectionIds() as ISelectionId[];
        if (!ids.length) {
            return set;
        }
        for (const p of this.points) {
            if (p.group !== undefined && ids.some((id) => id.equals(p.selectionId as ISelectionId))) {
                set.add(p.group);
            }
        }
        return set;
    }

    /** Highlights the rows of currently-selected airlines. */
    private refreshLegendSelection(): void {
        const sel = this.selectedGroups();
        const rows = this.legendListElement.children;
        for (let i = 0; i < rows.length; i++) {
            const row = rows[i] as HTMLElement;
            const g = row.getAttribute("data-group");
            row.classList.toggle("selected", g !== null && sel.has(g));
        }
    }

    /**
     * Legend row click → cross-filter by the airline(s).
     *  - plain: select only that airline (re-click the sole selection clears it);
     *  - Ctrl/Cmd: toggle the airline in/out of the selection;
     *  - Shift: range from the anchor airline to the clicked one (in legend order).
     */
    private onLegendSelect(group: string, ev: MouseEvent): void {
        const order = this.legendGroupsOrder;
        let target = this.selectedGroups();

        if (ev.shiftKey && this.legendAnchorGroup !== null && order.indexOf(this.legendAnchorGroup) >= 0) {
            const a = order.indexOf(this.legendAnchorGroup);
            const b = order.indexOf(group);
            if (b >= 0) {
                const lo = Math.min(a, b);
                const hi = Math.max(a, b);
                target = new Set(order.slice(lo, hi + 1));
            }
        } else if (ev.ctrlKey || ev.metaKey) {
            if (target.has(group)) {
                target.delete(group);
            } else {
                target.add(group);
            }
            this.legendAnchorGroup = group;
        } else {
            if (target.size === 1 && target.has(group)) {
                target = new Set();
            } else {
                target = new Set([group]);
            }
            this.legendAnchorGroup = group;
        }

        const ids = this.points
            .filter((p) => p.group !== undefined && target.has(p.group))
            .map((p) => p.selectionId);
        const done = () => {
            this.applyHighlight();
            this.refreshLegendSelection();
        };
        if (!ids.length) {
            this.selectionManager.clear().then(done);
        } else {
            this.selectionManager.select(ids, false).then(done);
        }
    }

    /**
     * Timelapse control (bottom): collapsed to a "Timeline" header; expanding reveals
     * a slider whose stops are the distinct timestamps across all aircraft. The latest
     * stop is "Live" (current positions); earlier stops scrub the map back in time.
     */
    private buildTimelapse(): HTMLDivElement {
        const wrap = document.createElement("div");
        wrap.className = "aircraft-timelapse";

        const header = document.createElement("button");
        header.type = "button";
        header.className = "aircraft-timelapse-header";
        header.textContent = this.localization.getDisplayName("Timeline");
        header.addEventListener("click", () => wrap.classList.toggle("expanded"));

        const body = document.createElement("div");
        body.className = "aircraft-timelapse-body";

        this.timelapseLabel = document.createElement("div");
        this.timelapseLabel.className = "aircraft-timelapse-time";
        this.timelapseLabel.textContent = "Live";

        this.timelapseSlider = document.createElement("input");
        this.timelapseSlider.type = "range";
        this.timelapseSlider.className = "aircraft-timelapse-slider";
        this.timelapseSlider.min = "0";
        this.timelapseSlider.max = "0";
        this.timelapseSlider.step = "1";
        this.timelapseSlider.value = "0";
        this.timelapseTicks = document.createElement("datalist");
        this.timelapseTicks.id = "aircraft-timelapse-ticks";
        this.timelapseSlider.setAttribute("list", this.timelapseTicks.id);
        this.timelapseSlider.addEventListener("input", () => this.onTimelapseInput());

        const hide = document.createElement("button");
        hide.type = "button";
        hide.className = "aircraft-timelapse-hide";
        hide.textContent = this.localization.getDisplayName("Hide");
        hide.addEventListener("click", () => wrap.classList.remove("expanded"));

        body.appendChild(this.timelapseLabel);
        body.appendChild(this.timelapseSlider);
        body.appendChild(this.timelapseTicks);
        body.appendChild(hide);
        wrap.appendChild(header);
        wrap.appendChild(body);
        return wrap;
    }

    private onTimelapseInput(): void {
        const times = this.timelapseTimes;
        if (times.length < 2) {
            return;
        }
        const idx = Math.max(0, Math.min(times.length - 1, Number(this.timelapseSlider.value)));
        if (idx >= times.length - 1) {
            this.timelapseLive = true;
            this.timelapseTime = null;
            this.timelapseLabel.textContent = "Live";
        } else {
            this.timelapseLive = false;
            this.timelapseTime = times[idx];
            this.timelapseLabel.textContent = new Date(times[idx]).toLocaleString();
        }
        this.markerLayer.setTimelapse(this.timelapseTime);
    }

    /** Rebuilds the timeline stops from all flown timestamps; hides the control if <2. */
    private updateTimelapse(): void {
        const set = new Set<number>();
        for (const p of this.points) {
            if (!p.flown) {
                continue;
            }
            for (const f of p.flown) {
                if (f.t != null) {
                    set.add(f.t);
                }
            }
        }
        const times = Array.from(set).sort((a, b) => a - b);
        this.timelapseTimes = times;

        if (times.length < 2) {
            this.timelapseElement.style.display = "none";
            this.timelapseTime = null;
            this.timelapseLive = true;
            this.markerLayer.setTimelapse(null);
            return;
        }

        this.timelapseElement.style.display = "";
        const slider = this.timelapseSlider;
        slider.min = "0";
        slider.max = String(times.length - 1);
        slider.step = "1";

        while (this.timelapseTicks.firstChild) {
            this.timelapseTicks.removeChild(this.timelapseTicks.firstChild);
        }
        if (times.length <= 100) {
            for (let i = 0; i < times.length; i++) {
                const opt = document.createElement("option");
                opt.value = String(i);
                this.timelapseTicks.appendChild(opt);
            }
        }

        if (this.timelapseLive) {
            slider.value = String(times.length - 1);
            this.timelapseTime = null;
            this.timelapseLabel.textContent = "Live";
            this.markerLayer.setTimelapse(null);
        } else {
            const t = this.timelapseTime ?? times[times.length - 1];
            let idx = times.length - 1;
            let best = Infinity;
            for (let i = 0; i < times.length; i++) {
                const d = Math.abs(times[i] - t);
                if (d < best) {
                    best = d;
                    idx = i;
                }
            }
            slider.value = String(idx);
            this.timelapseTime = times[idx];
            this.timelapseLabel.textContent = new Date(times[idx]).toLocaleString();
            this.markerLayer.setTimelapse(this.timelapseTime);
        }
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
        this.updateLegend();
        this.updateTimelapse();

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
        this.refreshLegendSelection();
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
