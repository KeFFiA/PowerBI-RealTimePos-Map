/**
 * Formatting model for the Aircraft Map Visual.
 *
 * Static cards (Marker, Map) are declared with powerbi-visuals-utils-formattingmodel.
 * The per-object card (Object markers) is populated dynamically in the visual from the
 * data points (one color picker + aircraft-type dropdown per object), matching the
 * `objectMarker` object defined in capabilities.json.
 */
import powerbi from "powerbi-visuals-api";
import { formattingSettings } from "powerbi-visuals-utils-formattingmodel";

import IEnumMember = powerbi.IEnumMember;
import Card = formattingSettings.SimpleCard;
import Model = formattingSettings.Model;
import ColorPicker = formattingSettings.ColorPicker;
import ItemDropdown = formattingSettings.ItemDropdown;
import NumUpDown = formattingSettings.NumUpDown;
import ToggleSwitch = formattingSettings.ToggleSwitch;

export const DEFAULT_MARKER_COLOR = "#20d2c2";
export const DEFAULT_AIRCRAFT_TYPE = "B738";

export const SHAPE_ITEMS: IEnumMember[] = [
    { value: "circle", displayName: "Point" },
    { value: "aircraft", displayName: "Aircraft" },
];

export const MAP_STYLE_ITEMS: IEnumMember[] = [
    { value: "dark", displayName: "Dark" },
    { value: "light", displayName: "Light" },
    { value: "osm", displayName: "OSM" },
    { value: "voyager", displayName: "Color" },
];

/** "marker" object — global marker appearance. */
export class MarkerCard extends Card {
    name = "marker";
    displayName = "Marker";
    displayNameKey = "Marker";

    color = new ColorPicker({
        name: "color",
        displayName: "Default color",
        displayNameKey: "DefaultColor",
        value: { value: DEFAULT_MARKER_COLOR },
    });

    shape = new ItemDropdown({
        name: "shape",
        displayName: "Marker type",
        displayNameKey: "MarkerType",
        items: SHAPE_ITEMS,
        value: SHAPE_ITEMS[1], // aircraft
    });

    size = new NumUpDown({
        name: "size",
        displayName: "Size",
        displayNameKey: "Size",
        value: 50,
    });

    showLabels = new ToggleSwitch({
        name: "showLabels",
        displayName: "Show labels",
        displayNameKey: "ShowLabels",
        value: true,
    });

    showAirlineLogo = new ToggleSwitch({
        name: "showAirlineLogo",
        displayName: "Show airline logo",
        displayNameKey: "ShowAirlineLogo",
        value: true,
    });

    logoSize = new NumUpDown({
        name: "logoSize",
        displayName: "Logo size",
        displayNameKey: "LogoSize",
        value: 18,
    });

    slices = [this.color, this.shape, this.size, this.showLabels, this.showAirlineLogo, this.logoSize];
}

/** "map" object — base layer and behavior. */
export class MapCard extends Card {
    name = "map";
    displayName = "Map";
    displayNameKey = "Map";

    style = new ItemDropdown({
        name: "style",
        displayName: "Map style",
        displayNameKey: "MapStyle",
        items: MAP_STYLE_ITEMS,
        value: MAP_STYLE_ITEMS[0], // dark
    });

    autoZoom = new ToggleSwitch({
        name: "autoZoom",
        displayName: "Auto zoom to points",
        displayNameKey: "AutoZoom",
        value: true,
    });

    slices = [this.style, this.autoZoom];
}

/** "behavior" object — marker clustering and selection-distance filtering. */
export class BehaviorCard extends Card {
    name = "behavior";
    displayName = "Clustering & filtering";
    displayNameKey = "Behavior";

    cluster = new ToggleSwitch({
        name: "cluster",
        displayName: "Cluster dense areas",
        displayNameKey: "Cluster",
        value: true,
    });

    clusterRadius = new NumUpDown({
        name: "clusterRadius",
        displayName: "Cluster radius (px)",
        displayNameKey: "ClusterRadius",
        value: 45,
    });

    clusterMaxZoom = new NumUpDown({
        name: "clusterMaxZoom",
        displayName: "Stop clustering at zoom",
        displayNameKey: "ClusterMaxZoom",
        value: 7,
    });

    nearbyDistance = new NumUpDown({
        name: "nearbyDistance",
        displayName: "Nearby distance (km)",
        displayNameKey: "NearbyDistance",
        value: 250,
    });

    slices = [this.cluster, this.clusterRadius, this.clusterMaxZoom, this.nearbyDistance];
}

/** "routes" object — selected-aircraft route lines. */
export class RoutesCard extends Card {
    name = "routes";
    displayName = "Routes";
    displayNameKey = "Routes";

    show = new ToggleSwitch({
        name: "show",
        displayName: "Show routes (selected)",
        displayNameKey: "ShowRoutes",
        value: true,
    });

    maxRoutes = new NumUpDown({
        name: "maxRoutes",
        displayName: "Max selected for routes",
        displayNameKey: "MaxRoutes",
        value: 5,
    });

    traveledWidth = new NumUpDown({
        name: "traveledWidth",
        displayName: "Traveled line width",
        displayNameKey: "TraveledWidth",
        value: 3,
    });

    remainingWidth = new NumUpDown({
        name: "remainingWidth",
        displayName: "Remaining line width",
        displayNameKey: "RemainingWidth",
        value: 1.5,
    });

    useAircraftColor = new ToggleSwitch({
        name: "useAircraftColor",
        displayName: "Use aircraft color",
        displayNameKey: "UseAircraftColor",
        value: true,
    });

    color = new ColorPicker({
        name: "color",
        displayName: "Line color",
        displayNameKey: "Color",
        value: { value: "#22d3ee" },
    });

    slices = [
        this.show,
        this.maxRoutes,
        this.traveledWidth,
        this.remainingWidth,
        this.useAircraftColor,
        this.color,
    ];
}

/**
 * "objectMarker" object — per-object color (and optional aircraft-type preset).
 * Slices are added at runtime, one group of slices per data object, each carrying
 * the object's selector so Power BI persists the value against that object.
 */
export class ObjectMarkerCard extends Card {
    name = "objectMarker";
    displayName = "Object markers";
    displayNameKey = "DataPointMarkers";
    slices: formattingSettings.Slice[] = [];
}

/**
 * "groupColor" object — per-color-group (airline) color. Slices are added at
 * runtime, one color picker per distinct group, each carrying the group's selector
 * so Power BI persists the value against that group.
 */
export class GroupColorCard extends Card {
    name = "groupColor";
    displayName = "Airline colors";
    displayNameKey = "GroupColors";
    slices: formattingSettings.Slice[] = [];
}

export class VisualSettingsModel extends Model {
    marker = new MarkerCard();
    map = new MapCard();
    behavior = new BehaviorCard();
    routes = new RoutesCard();
    groupColor = new GroupColorCard();
    objectMarker = new ObjectMarkerCard();
    cards = [this.marker, this.map, this.behavior, this.routes, this.groupColor, this.objectMarker];
}
