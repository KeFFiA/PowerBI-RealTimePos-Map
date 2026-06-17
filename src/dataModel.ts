/**
 * Transforms a Power BI categorical dataView into the flat AircraftPoint[] the
 * renderer consumes. Roles are matched by name (see capabilities.json dataRoles).
 */
import powerbi from "powerbi-visuals-api";

import DataView = powerbi.DataView;
import DataViewCategoryColumn = powerbi.DataViewCategoryColumn;
import DataViewValueColumn = powerbi.DataViewValueColumn;
import PrimitiveValue = powerbi.PrimitiveValue;
import ISelectionId = powerbi.visuals.ISelectionId;
import VisualTooltipDataItem = powerbi.extensibility.VisualTooltipDataItem;
import IVisualHost = powerbi.extensibility.visual.IVisualHost;
import Fill = powerbi.Fill;

import { VisualSettingsModel, DEFAULT_AIRCRAFT_TYPE } from "./settings";

export interface AircraftPoint {
    index: number;
    id: string;
    latitude: number;
    longitude: number;
    aircraftType?: string;
    label?: string;
    logoUrl?: string;
    /** resolved marker color (per-object override, else default) */
    color: string;
    /** true when the color came from a persisted per-object override */
    hasColorOverride: boolean;
    /** color-group (airline) value, when the Color group role is bound */
    group?: string;
    /** resolved group color (per-group override, else palette default); undefined without a group */
    groupColor?: string;
    /** selection id built from the group column, for per-group color persistence */
    groupSelectionId?: ISelectionId;
    /**
     * Cross-highlight state from other visuals. true when this row is part of the
     * active highlight (or when no highlight is active at all); false when other
     * rows are highlighted and this one is not (so it should be dimmed).
     */
    highlighted: boolean;
    tooltips: VisualTooltipDataItem[];
    selectionId: ISelectionId;
}

function hasRole(source: powerbi.DataViewMetadataColumn, role: string): boolean {
    return !!source && !!source.roles && !!source.roles[role];
}

function findCategory(categories: DataViewCategoryColumn[], role: string): DataViewCategoryColumn | undefined {
    return categories.find((c) => hasRole(c.source, role));
}

function findValue(values: DataViewValueColumn[], role: string): DataViewValueColumn | undefined {
    return values.find((v) => hasRole(v.source, role));
}

function toNumber(value: PrimitiveValue | undefined): number {
    const n = typeof value === "number" ? value : Number(value);
    return Number.isFinite(n) ? n : NaN;
}

function readObjectFill(category: DataViewCategoryColumn | undefined, index: number): string | undefined {
    const objects = category && category.objects ? category.objects[index] : undefined;
    const fill = objects && (objects.objectMarker as { fill?: Fill } | undefined)?.fill;
    return fill && fill.solid ? (fill.solid.color as string) : undefined;
}

function readGroupFill(category: DataViewCategoryColumn | undefined, index: number): string | undefined {
    const objects = category && category.objects ? category.objects[index] : undefined;
    const fill = objects && (objects.groupColor as { fill?: Fill } | undefined)?.fill;
    return fill && fill.solid ? (fill.solid.color as string) : undefined;
}

function readObjectPreset(category: DataViewCategoryColumn | undefined, index: number): string | undefined {
    const objects = category && category.objects ? category.objects[index] : undefined;
    const preset = objects && (objects.objectMarker as { aircraftTypePreset?: unknown } | undefined)?.aircraftTypePreset;
    if (preset == null) {
        return undefined;
    }
    if (typeof preset === "object" && "value" in (preset as Record<string, unknown>)) {
        return String((preset as { value: unknown }).value);
    }
    return String(preset);
}

export function transform(dataView: DataView | undefined, host: IVisualHost, settings: VisualSettingsModel): AircraftPoint[] {
    const categorical = dataView && dataView.categorical;
    if (!categorical) {
        return [];
    }
    const categories = categorical.categories || [];
    const values = categorical.values || [];

    const categoryCol = findCategory(categories, "category");
    const latCol = findValue(values, "latitude");
    const lonCol = findValue(values, "longitude");
    if (!categoryCol || !latCol || !lonCol) {
        return [];
    }

    const typeCol = findCategory(categories, "aircraftType");
    const labelCol = findCategory(categories, "label");
    const logoCol = findCategory(categories, "airlineLogoUrl");
    const groupCol = findCategory(categories, "colorGroup");
    const colorPalette = host.colorPalette;
    // One selection id per distinct group (reused across its rows) — building one per
    // row would be thousands of allocations on every real-time refresh.
    const groupSelectionById = new Map<string, ISelectionId>();

    // Tooltip columns can come from either categories or values (role "tooltips").
    const tooltipCols = [
        ...categories.filter((c) => hasRole(c.source, "tooltips")),
        ...values.filter((v) => hasRole(v.source, "tooltips")),
    ];

    const defaultColor = settings.marker.color.value.value;
    const count = categoryCol.values.length;
    const points: AircraftPoint[] = [];

    // When another visual cross-highlights, Power BI sends a `highlights` array on
    // the value columns: an entry is null for rows outside the highlight. If no
    // column carries highlights, nothing is highlighted and all points are active.
    const highlightCols = values.filter((v) => !!v.highlights);
    const highlightActive = highlightCols.length > 0;

    for (let i = 0; i < count; i++) {
        const lat = toNumber(latCol.values[i]);
        const lon = toNumber(lonCol.values[i]);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
            continue;
        }

        const overrideColor = readObjectFill(categoryCol, i);

        // Color group (airline): default color comes from Power BI's palette (auto
        // distinct per group), overridable per group in the formatting pane.
        let group: string | undefined;
        let groupColor: string | undefined;
        let groupSelectionId: ISelectionId | undefined;
        if (groupCol) {
            group = groupCol.values[i] == null ? "" : String(groupCol.values[i]);
            groupColor = readGroupFill(groupCol, i) || colorPalette.getColor(group).value;
            groupSelectionId = groupSelectionById.get(group);
            if (!groupSelectionId) {
                groupSelectionId = host.createSelectionIdBuilder().withCategory(groupCol, i).createSelectionId();
                groupSelectionById.set(group, groupSelectionId);
            }
        }

        const dataType = typeCol && typeCol.values[i] != null ? String(typeCol.values[i]) : undefined;
        const preset = readObjectPreset(categoryCol, i);
        const tooltips: VisualTooltipDataItem[] = tooltipCols.map((col) => ({
            displayName: col.source.displayName,
            value: col.values[i] == null ? "" : String(col.values[i]),
        }));

        const selectionId = host
            .createSelectionIdBuilder()
            .withCategory(categoryCol, i)
            .createSelectionId();

        points.push({
            index: i,
            id: categoryCol.values[i] == null ? `#${i}` : String(categoryCol.values[i]),
            latitude: lat,
            longitude: lon,
            aircraftType: dataType || preset || DEFAULT_AIRCRAFT_TYPE,
            label: labelCol && labelCol.values[i] != null ? String(labelCol.values[i]) : undefined,
            logoUrl: logoCol && logoCol.values[i] != null ? String(logoCol.values[i]) : undefined,
            color: overrideColor || groupColor || defaultColor,
            hasColorOverride: !!overrideColor,
            group,
            groupColor,
            groupSelectionId,
            highlighted: !highlightActive || highlightCols.some((v) => v.highlights![i] != null),
            tooltips,
            selectionId,
        });
    }

    return points;
}
