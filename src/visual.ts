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
import ITooltipService = powerbi.extensibility.ITooltipService;
import FormattingModel = powerbi.visuals.FormattingModel;

import { VisualSettingsModel } from "./settings";
import { AircraftPoint, transform } from "./dataModel";
import { MapController, MapStyle } from "./map";
import { MarkerLayer } from "./markers";
import { AreaSelection } from "./selection";

export class Visual implements IVisual {
    private readonly host: IVisualHost;
    private readonly selectionManager: ISelectionManager;
    private readonly tooltipService: ITooltipService;
    private readonly localization: ILocalizationManager;
    private readonly formattingService: FormattingSettingsService;

    private readonly mapElement: HTMLDivElement;
    private readonly landingElement: HTMLDivElement;
    private readonly mapController: MapController;
    private readonly markerLayer: MarkerLayer;
    private readonly areaSelection: AreaSelection;

    private settings: VisualSettingsModel = new VisualSettingsModel();
    private points: AircraftPoint[] = [];
    private pointsByIndex: Map<number, AircraftPoint> = new Map();

    constructor(options: VisualConstructorOptions) {
        this.host = options.host;
        this.selectionManager = this.host.createSelectionManager();
        this.tooltipService = this.host.tooltipService;
        this.localization = this.host.createLocalizationManager();
        this.formattingService = new FormattingSettingsService(this.localization);

        const root = options.element;
        root.classList.add("aircraft-map-root");

        this.mapElement = document.createElement("div");
        root.appendChild(this.mapElement);

        this.landingElement = this.buildLanding();
        root.appendChild(this.landingElement);

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
        this.tooltipService.hide({ immediately: true, isTouchEvent: false });

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
            onMouseOut: () => this.tooltipService.hide({ immediately: true, isTouchEvent: false }),
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
        const dataItems = point.tooltips.length ? point.tooltips : [{ displayName: point.id, value: "" }];
        this.tooltipService.show({
            coordinates: [position.x, position.y],
            dataItems,
            identities: [point.selectionId],
            isTouchEvent: false,
        });
    }
}
