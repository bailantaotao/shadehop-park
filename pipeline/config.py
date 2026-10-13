"""Region and modelling parameters.

Every assumption that affects a published number lives here so it can be
cited on the site and in llms.txt.
"""

REGIONS = {
    "linkou": {
        "id": "linkou",
        "id_prefix": "lk",
        "name": "林口區",
        "city": "新北市",
        "city_en": "New Taipei City",
        "name_en": "Linkou District",
        "label": "林口",
        # Overpass selector for the region's boundary relation; parks are
        # filtered by the real boundary polygon returned from OSM.
        "osm_boundary": 'area["name"="新北市"]["boundary"="administrative"]->.p;\nrel(area.p)["boundary"="administrative"]["name"="林口區"]',
        # Sub-districts used to label each park (None: the region is one district).
        "osm_districts": None,
        # Same selection for extract_pbf (Geofabrik file): boundary tags, district admin_level.
        "osm_boundary_tags": {"boundary": "administrative", "admin_level": "7", "name": "林口區"},
        "osm_district_level": None,
        "tdx_city": "NewTaipei",
        # Official registry: names/addresses only, matched by park name.
        "registry": "ntpc_parks",
        # OSM rarely maps play equipment here, so list parks as unconfirmed candidates.
        "park_candidates": True,
        "fetch_tiles": 1,
    },
    "taipei": {
        "id": "taipei",
        "id_prefix": "tp",
        "name": "臺北市",
        "city": "臺北市",
        "city_en": "Taipei City",
        "name_en": "Taipei City",
        "label": "台北市",
        "osm_boundary": 'rel["boundary"="administrative"]["admin_level"="4"]["name"="臺北市"]',
        "osm_districts": 'rel(area.r)["boundary"="administrative"]["admin_level"="7"]',
        "osm_boundary_tags": {"boundary": "administrative", "admin_level": "4", "name": "臺北市"},
        "osm_district_level": "7",
        "tdx_city": "Taipei",
        # Official registry of every children's playground, with coordinates.
        "registry": "taipei_playgrounds",
        # The registry is complete, so parks without a playground are not listed.
        "park_candidates": False,
        "fetch_tiles": 3,
    },
}
DEFAULT_REGION = "linkou"

# Extra margin around the region bbox for things that can serve a park
# near the edge (parking, chargers, buildings that cast shadows).
BBOX_MARGIN_M = 1500

# Reject OSM data older than this (stale Overpass mirrors).
MAX_OSM_AGE_DAYS = 3

# Search radii from a playground.
PARKING_RADIUS_M = 800
PARKING_MAX = 6
CHARGER_RADIUS_M = 500  # "nearby" chargers: a short walk from the playground
CHARGER_MAX = 8
# An OSM charger this close to an official (TDX) station is the same station.
CHARGER_MERGE_M = 40
AMENITY_RADIUS_M = 200
SHADOW_SEARCH_RADIUS_M = 400
# Shadow casters are published in tiles of this size (degrees, ~1 km) for the map.
CASTER_TILE_DEG = 0.01
# Max worker processes for the per-park shade computation.
BUILD_WORKERS = 8

# Geometry assumptions.
PLAYGROUND_NODE_RADIUS_M = 12  # playgrounds mapped as a single point
# ...minus building footprints, unless that leaves less than this (then keep the circle).
MIN_ESTIMATED_ZONE_M2 = 60
LEVEL_HEIGHT_M = 3.0  # per building:levels
DEFAULT_BUILDING_HEIGHT_M = 9.0  # building with no height/levels tag
# Untagged buildings of a type with >= this many tagged examples in the data
# use that type's lower-quartile height instead (e.g. apartments in Linkou).
TYPE_HEIGHT_MIN_SAMPLES = 20
# height > levels * MAX_LEVEL_HEIGHT_M + MAX_ROOF_EXTRA_M is treated as a typo.
MAX_LEVEL_HEIGHT_M = 6.0
MAX_ROOF_EXTRA_M = 15.0
VIADUCT_DECK_BOTTOM_M = 8.0
VIADUCT_DECK_TOP_M = 10.0
ROOF_HEIGHT_M = 3.0  # amenity=shelter / building=roof
SHELTER_NODE_RADIUS_M = 3.0
TREE_DEFAULT_CROWN_M = 6.0
TREE_DEFAULT_HEIGHT_M = 6.0

# Default deck widths (m) when a bridge has no width/lanes tag.
BRIDGE_WIDTH_BY_CLASS = {
    "motorway": 12.0,
    "trunk": 12.0,
    "primary": 10.0,
    "secondary": 9.0,
    "tertiary": 8.0,
    "motorway_link": 7.0,
    "trunk_link": 7.0,
    "primary_link": 7.0,
    "railway": 10.0,
}
BRIDGE_WIDTH_FALLBACK = 6.0
LANE_WIDTH_M = 3.5

# Shade timetable: month 1..12 (15th day), slots every 30 min from 06:00.
TIMETABLE_START_MIN = 6 * 60
TIMETABLE_SLOT_MIN = 30
TIMETABLE_SLOTS = 24  # 06:00 .. 17:30
MIN_SUN_ALTITUDE_DEG = 3.0  # below this the slot is "sun not up" (null)
TZ_OFFSET_H = 8  # Asia/Taipei, no DST

# Classification thresholds.
COVERED_FULL_RATIO = 0.5  # >= this share under a roof/viaduct -> level A
COVERED_PARTIAL_RATIO = 0.15
# An official playground point this close to (or inside) an OSM playground is the same place.
OFFICIAL_MATCH_M = 40
# Leftover official points with the same name this close together are one play area.
OFFICIAL_MERGE_M = 60
NESTED_DUPLICATE_RATIO = 0.8  # an area this much inside a larger one of the same kind is a duplicate
# A park with at least this much area under a viaduct (not pavilions) has a rain-proof play spot even if
# the share of the whole park is small.
COVERED_MIN_AREA_M2 = 150
SHADED_SLOT_RATIO = 0.6  # a slot counts as "shaded" at >= 60% coverage
LEVEL_C_MIN_DAYTIME_SHARE = 0.4  # share of 09-16 slots shaded, averaged over months

# A fact not re-verified within this many days is shown as stale.
STALE_AFTER_DAYS = 180
