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
    /** departure airport coordinates, when bound */
    departure?: [number, number];
    /** arrival airport coordinates, when bound */
    arrival?: [number, number];
    /** already-flown path as [lat, lon] pairs (parsed from the Flown path field) */
    flown?: [number, number][];
    /** heading in degrees clockwise from north; always computed (0 when unknown) */
    heading: number;
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

/** Bearing in degrees clockwise from north, from point a to point b. */
function bearing(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const toRad = Math.PI / 180;
    const phi1 = lat1 * toRad;
    const phi2 = lat2 * toRad;
    const dLon = (lon2 - lon1) * toRad;
    const y = Math.sin(dLon) * Math.cos(phi2);
    const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLon);
    return (Math.atan2(y, x) * (180 / Math.PI) + 360) % 360;
}

/**
 * Parse the Flown path field into [lat, lon] pairs. Accepts a JSON array
 * (`[[lat,lon],...]` or `[{lat,lng},...]`) or a delimited string where pairs are
 * separated by `;`/`|` and the two numbers by comma/space (e.g. "55.7,37.6;56,38").
 */
function parseFlownPath(value: PrimitiveValue | undefined): [number, number][] {
    if (value == null) {
        return [];
    }
    const s = String(value).trim();
    if (!s) {
        return [];
    }
    const out: [number, number][] = [];
    if (s[0] === "[" || s[0] === "{") {
        try {
            const arr = JSON.parse(s);
            if (Array.isArray(arr)) {
                for (const el of arr) {
                    if (Array.isArray(el) && el.length >= 2) {
                        const a = Number(el[0]);
                        const b = Number(el[1]);
                        if (Number.isFinite(a) && Number.isFinite(b)) {
                            out.push([a, b]);
                        }
                    } else if (el && typeof el === "object") {
                        const rec = el as Record<string, unknown>;
                        const a = Number(rec.lat ?? rec.latitude ?? rec.y);
                        const b = Number(rec.lon ?? rec.lng ?? rec.longitude ?? rec.x);
                        if (Number.isFinite(a) && Number.isFinite(b)) {
                            out.push([a, b]);
                        }
                    }
                }
                return out;
            }
        } catch {
            // fall through to delimited parsing
        }
    }
    for (const part of s.split(/[;|]/)) {
        const nums = part
            .trim()
            .split(/[\s,]+/)
            .map(Number)
            .filter((n) => Number.isFinite(n));
        if (nums.length >= 2) {
            out.push([nums[0], nums[1]]);
        }
    }
    return out;
}

/**
 * Heading from the latest travel vector: the last distinct segment of the flown
 * track (… → current position). Falls back to the bearing toward the arrival
 * airport when the path has too few points, else 0.
 */
function computeHeading(
    lat: number,
    lon: number,
    flown: [number, number][],
    arrival: [number, number] | undefined
): number {
    const track: [number, number][] = [...flown, [lat, lon]];
    for (let i = track.length - 1; i > 0; i--) {
        const [la2, lo2] = track[i];
        const [la1, lo1] = track[i - 1];
        if (la1 !== la2 || lo1 !== lo2) {
            return bearing(la1, lo1, la2, lo2);
        }
    }
    if (arrival) {
        return bearing(lat, lon, arrival[0], arrival[1]);
    }
    return 0;
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
    const depLatCol = findValue(values, "depLat");
    const depLonCol = findValue(values, "depLon");
    const arrLatCol = findValue(values, "arrLat");
    const arrLonCol = findValue(values, "arrLon");
    const flownCol = findCategory(categories, "flownPath");
    const colorPalette = host.colorPalette;
    // One selection id per distinct group (reused across its rows) — building one per
    // row would be thousands of allocations on every real-time refresh.
    const groupSelectionById = new Map<string, ISelectionId>();

    // Tooltip columns can come from either categories or values (role "tooltips").
    // The tooltips role is bound in both selects (to accept grouping and measure
    // fields), so the same field can surface twice — dedupe by query name so a
    // field added once (or also used as the color group) shows a single row.
    const seenTooltip = new Set<string>();
    const tooltipCols = [
        ...categories.filter((c) => hasRole(c.source, "tooltips")),
        ...values.filter((v) => hasRole(v.source, "tooltips")),
    ].filter((col) => {
        const key = col.source.queryName || col.source.displayName;
        if (seenTooltip.has(key)) {
            return false;
        }
        seenTooltip.add(key);
        return true;
    });

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

        // Route endpoints and flown track (for the selected-aircraft route + heading).
        const depLat = depLatCol ? toNumber(depLatCol.values[i]) : NaN;
        const depLon = depLonCol ? toNumber(depLonCol.values[i]) : NaN;
        const arrLat = arrLatCol ? toNumber(arrLatCol.values[i]) : NaN;
        const arrLon = arrLonCol ? toNumber(arrLonCol.values[i]) : NaN;
        const departure: [number, number] | undefined =
            Number.isFinite(depLat) && Number.isFinite(depLon) ? [depLat, depLon] : undefined;
        const arrival: [number, number] | undefined =
            Number.isFinite(arrLat) && Number.isFinite(arrLon) ? [arrLat, arrLon] : undefined;
        const flown = flownCol ? parseFlownPath(flownCol.values[i]) : [];
        const heading = computeHeading(lat, lon, flown, arrival);

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
            departure,
            arrival,
            flown,
            heading,
            highlighted: !highlightActive || highlightCols.some((v) => v.highlights![i] != null),
            tooltips,
            selectionId,
        });
    }

    return points;
}
